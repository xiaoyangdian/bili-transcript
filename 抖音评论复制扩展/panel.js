(function () {
  'use strict';

  // 独立评论/通知面板。数据来自后台已捕获的接口响应，不重复请求网络。

  let root = null;
  let currentTab = 'comment';
  let captures = [];
  let netStats = { active: [], filtered: [] };
  let itemById = new Map();
  let replyIndex = new Map();
  let activeDialogKey = '';
  let dialogFloorCid = '';
  let selfUser = null;
  let expanded = new Set();
  let fetchSeq = 0;
  const pendingFetch = new Map();
  let loadingFloors = new Set();
  const debugLogs = [];

  function log(tag, ...args) {
    const line = [tag, ...args.map((a) => {
      if (typeof a === 'string') return a;
      try { return JSON.stringify(a); } catch (_) { return String(a); }
    })].join(' ');
    debugLogs.push(line);
    if (debugLogs.length > 60) debugLogs.shift();
    console.log('[dy-panel]', line);
    const box = document.getElementById('dyDebug');
    if (box) {
      box.textContent = debugLogs.slice(-14).join('\n');
      box.scrollTop = box.scrollHeight;
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || !d.__dyNetFetchRes) return;
    const res = d.__dyNetFetchRes;
    log('RES', res.id, 'ok=' + res.ok, 'status=' + res.status, 'err=' + (res.error || ''),
      'textLen=' + ((res.text || '').length));
    const fn = pendingFetch.get(res.id);
    if (!fn) { log('RES no pending fn for id', res.id); return; }
    pendingFetch.delete(res.id);
    fn(res);
  });

  function mainFetch(url, options) {
    return new Promise((resolve) => {
      const id = ++fetchSeq;
      log('REQ', id, (options && options.method || 'GET'), url.slice(0, 220));
      const timer = setTimeout(() => {
        pendingFetch.delete(id);
        log('REQ timeout', id);
        resolve({ ok: false, error: 'timeout' });
      }, 12000);
      pendingFetch.set(id, (res) => { clearTimeout(timer); resolve(res); });
      window.postMessage({ __dyNetFetchReq: { id, url, options: options || null } }, '*');
    });
  }

  const PAGE_SIZE = { comment: 8, notice: 10, dialog: 20 };
  const pageState = { comment: 1, notice: 1 };
  let noticeSubTab = 'all';

  function pageKey() {
    if (currentTab === 'comment') return 'comment';
    if (currentTab === 'dialog') return 'dialog';
    return 'notice:' + noticeSubTab;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(Number(ts) * 1000);
    if (isNaN(d.getTime())) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + '分钟前';
    if (diff < 86400) return Math.floor(diff / 3600) + '小时前';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + '天前';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  // 把 text 里的 [表情] 占位符和抖音 emoji 图片 alt 还原成显示文本
  function fmtText(text) {
    let s = esc(text || '');
    s = s.replace(/\[([^\]]+)\]/g, (m, name) => '<span class="dy-emoji">[' + name + ']</span>');
    return s;
  }

  function avatarUrl(user) {
    const u = user || {};
    const a = u.avatar_thumb || u.avatar_larger || u.avatar_168x168 || {};
    const list = a.url_list || [];
    return list[0] || '';
  }

  function avatarHtml(user, cls) {
    const url = avatarUrl(user);
    const nick = (user && user.nickname) || '用户';
    if (!url) return '<div class="' + cls + '" style="display:flex;align-items:center;justify-content:center">' + esc(nick.slice(0, 1)) + '</div>';
    return '<img class="' + cls + '" src="' + esc(url) + '" alt="' + esc(nick) + '">';
  }

  // ---------- 数据聚合 ----------
  function getCommentCaptures() {
    return captures.filter((c) => (c.kind === 'comment' || c.kind === 'reply') && c.data && Array.isArray(c.data.comments));
  }

  function mergeComments() {
    const byCid = new Map();
    getCommentCaptures().forEach((c) => {
      c.data.comments.forEach((item) => {
        if (!item || !item.cid) return;
        const prev = byCid.get(item.cid);
        // 保留字段更全的一条（展开更多会带 reply_comment）
        if (!prev || (item.reply_comment || []).length > (prev.reply_comment || []).length) {
          byCid.set(item.cid, item);
        }
      });
    });
    return [...byCid.values()];
  }

  // 回复接口的 comment_id 是被回复的那条评论 id，把同层的翻页回复合并成「楼层 -> 回复列表」
  function buildReplyIndex() {
    const byKey = new Map();
    const put = (key, r) => {
      if (!key || !r || !r.cid) return;
      const k = String(key);
      if (!byKey.has(k)) byKey.set(k, new Map());
      byKey.get(k).set(String(r.cid), r);
    };
    captures.filter((c) => c.kind === 'reply' && c.data && Array.isArray(c.data.comments))
      .forEach((c) => {
        c.data.comments.forEach((r) => {
          put(c.commentId || r.reply_id, r);
          if (r.root_comment_id) put(r.root_comment_id, r);
        });
      });
    const out = new Map();
    byKey.forEach((m, k) => out.set(k, [...m.values()].sort((a, b) => (a.create_time || 0) - (b.create_time || 0))));
    return out;
  }

  function buildItemIndex() {
    const m = new Map();
    captures.forEach((c) => {
      if (!c.data || !Array.isArray(c.data.comments)) return;
      c.data.comments.forEach((item) => {
        if (item && item.cid) m.set(String(item.cid), item);
      });
    });
    replyIndex.forEach((list) => list.forEach((r) => {
      if (r && r.cid) m.set(String(r.cid), r);
    }));
    return m;
  }

  function nicknameOf(cid) {
    const item = itemById.get(String(cid));
    return (item && item.user && item.user.nickname) || '';
  }

  function uidOf(item) {
    const u = (item && item.user) || {};
    return String(u.uid || u.short_id || u.nickname || '?');
  }

  function isSelf(item) {
    if (!selfUser || !item) return false;
    const uid = uidOf(item);
    return !!(selfUser.uid && uid === String(selfUser.uid)) ||
      !!(selfUser.secUid && item.user && item.user.sec_uid && String(item.user.sec_uid) === String(selfUser.secUid));
  }

  // 把楼层回复按「谁和谁对话」抽成 1v1 分组。
  // 每条回复：发起方 = 自己 uid；对方 = reply_to_reply_id 指向的回复的 uid（0 则层主）。
  function buildConversations(floor, replies) {
    const byCid = new Map();
    replies.forEach((r) => byCid.set(String(r.cid), r));
    const floorUid = uidOf(floor);
    const groups = new Map();
    replies.forEach((r) => {
      const to = String(r.reply_to_reply_id || '0');
      const target = to !== '0' ? byCid.get(to) : null;
      const targetUid = target ? uidOf(target) : floorUid;
      const fromUid = uidOf(r);
      const key = [fromUid, targetUid].sort().join('|');
      if (!groups.has(key)) groups.set(key, { a: fromUid, b: targetUid, items: [] });
      const g = groups.get(key);
      g.items.push({ r, from: fromUid, to: targetUid });
    });
    const out = [...groups.values()];
    out.forEach((g) => {
      g.floorCid = String(floor.cid);
      g.key = [g.a, g.b].sort().join('|');
      g.items.sort((x, y) => (x.r.create_time || 0) - (y.r.create_time || 0));
    });
    out.sort((x, y) => {
      const xLast = x.items[x.items.length - 1].r.create_time || 0;
      const yLast = y.items[y.items.length - 1].r.create_time || 0;
      return yLast - xLast;
    });
    return out;
  }

  function nameByUid(uid, floor) {
    if (uid === uidOf(floor)) return (floor.user && floor.user.nickname) || '层主';
    for (const item of itemById.values()) {
      if (uidOf(item) === uid) return (item.user && item.user.nickname) || '用户';
    }
    return '用户';
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (_) { return false; }
  }

  function replyLine(r, targetName) {
    const u = r.user || {};
    const who = (u.nickname || '用户') + (targetName ? ' 回复 ' + targetName : '');
    return who + '：' + (r.text || '') + (r.create_time ? '（' + fmtTime(r.create_time) + '）' : '');
  }

  // 从页面 DOM 读取一个评论项的文本节点（和 content.js 的 read 逻辑一致）
  function domNodeText(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'img') return ' ' + (node.getAttribute('alt') || '[表情]') + ' ';
    let s = '';
    for (const child of node.childNodes) s += domNodeText(child);
    return s;
  }

  function cleanDomText(s) {
    return String(s || '').replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  function downloadTextFile(filename, content, mime) {
    try {
      const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      (document.body || document.documentElement).appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (_) { return false; }
  }

  function safeFileName(s) {
    return String(s || '').replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  // 从面板 DOM 读整楼，产出统一结构：floor + replies[{author, replyTo, time, text}]
  function readFloorData(card) {
    const authorEl = card.querySelector('.dy-author');
    const headTextEl = [...card.children].find((el) => el.classList.contains('dy-text'));
    const headMeta = card.querySelector('.dy-card-head .dy-meta');
    const floor = {
      author: authorEl ? cleanDomText(domNodeText(authorEl)) : '用户',
      time: headMeta ? cleanDomText(headMeta.textContent) : '',
      text: headTextEl ? cleanDomText(domNodeText(headTextEl)) : ''
    };
    const replies = [];
    [...card.querySelectorAll('.dy-reply')].forEach((rep) => {
      const nameEl = rep.querySelector('.dy-reply-author');
      const textEl = rep.querySelector('.dy-reply-text');
      if (!textEl) return;
      const badge = rep.querySelector('.dy-badge.reply');
      const metaEl = rep.querySelector('.dy-meta');
      replies.push({
        author: nameEl ? cleanDomText(domNodeText(nameEl)) : '用户',
        replyTo: badge ? cleanDomText(badge.textContent).replace(/^回复\s*@?/, '') : '',
        time: metaEl ? cleanDomText(metaEl.textContent) : '',
        text: cleanDomText(domNodeText(textEl))
      });
    });
    return { floor, replies };
  }

  function floorDataToText(data) {
    const f = data.floor;
    const blocks = ['【层主】' + f.author + (f.time ? '　' + f.time : '') + (f.text ? '\n' + f.text : '')];
    data.replies.forEach((r, i) => {
      blocks.push('【回复' + String(i + 1).padStart(2, '0') + '】' + r.author +
        (r.replyTo ? ' → ' + r.replyTo : '') + (r.time ? '　' + r.time : '') +
        (r.text ? '\n' + r.text : ''));
    });
    return blocks.join('\n\n');
  }

  // 导出整楼：人读 txt + AI 读 json，两个文件
  function exportFloor(cid, btn) {
    const card = btn && btn.closest('.dy-card');
    if (!card) { if (btn) btn.textContent = '导出失败'; return; }
    const data = readFloorData(card);
    const seed = safeFileName(data.floor.author + '_' + data.floor.text.slice(0, 24));
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const jsonPayload = {
      desc: {
        floor: '楼层主评论（层主）',
        'floor.author': '层主昵称',
        'floor.time': '评论时间与 IP 属地（页面展示文本）',
        'floor.text': '层主正文，多段落以换行分隔',
        replies: '该楼层下已展开的回复列表，按面板展示顺序',
        'replies[].author': '回复者昵称',
        'replies[].replyTo': '被回复者昵称；为空字符串表示直接回复 floor（层主）',
        'replies[].time': '回复时间与 IP 属地（页面展示文本）',
        'replies[].text': '回复正文，多段落以换行分隔'
      },
      floor: data.floor,
      replies: data.replies
    };
    const okTxt = downloadTextFile(seed + '_' + stamp + '.txt', floorDataToText(data), 'text/plain;charset=utf-8');
    const okJson = downloadTextFile(seed + '_' + stamp + '.json', JSON.stringify(jsonPayload, null, 2), 'application/json;charset=utf-8');
    if (btn) {
      const old = btn.textContent;
      btn.textContent = (okTxt && okJson) ? '已导出' : '导出失败';
      setTimeout(() => { btn.textContent = old; }, 1500);
    }
  }

  async function copyOne(kind, cid, btn) {
    const item = itemById.get(String(cid));
    if (!item) return;
    let text = '';
    if (kind === 'reply') {
      const to = String(item.reply_to_reply_id || '0');
      text = replyLine(item, (to !== '0') ? nicknameOf(to) : '');
    } else {
      const u = item.user || {};
      text = (u.nickname || '用户') + '：' + (item.text || '') +
        (item.create_time ? '（' + fmtTime(item.create_time) + '）' : '');
    }
    const ok = await copyText(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => { btn.textContent = old; }, 1200);
    }
  }

  function awemeIdOfCid(cid) {
    const hit = captures.find((x) =>
      (x.kind === 'comment' || x.kind === 'reply') && x.data && Array.isArray(x.data.comments) &&
      x.data.comments.some((i) => i && String(i.cid) === String(cid)));
    if (hit && hit.awemeId) return hit.awemeId;
    const any = captures.find((x) => x.awemeId);
    return any ? any.awemeId : '';
  }

  function replyUrlTemplate(cid) {
    let caps = captures.filter((c) => c.kind === 'reply' && String(c.commentId) === String(cid));
    if (caps.length) { log(' tpl source=reply(same floor)', cid); return caps[caps.length - 1].url; }
    caps = captures.filter((c) => c.kind === 'reply');
    if (caps.length) { log(' tpl source=reply(any floor)', cid); return caps[caps.length - 1].url; }
    caps = captures.filter((c) => c.kind === 'comment' && c.url && /comment\/list/.test(c.url));
    if (caps.length) { log(' tpl source=comment-list', cid); return caps[caps.length - 1].url; }
    // 最后兜底：webRequest 统计里的完整 URL（含签名）
    for (const kind of ['reply-list', 'comment-list']) {
      for (const rec of [...netStats.active, ...netStats.filtered]) {
        if (rec.kind !== kind || !rec.samples || !rec.samples.length) continue;
        for (const s of rec.samples) {
          if (/\/comment\/list/.test(s)) { log(' tpl source=netStats(' + kind + ')', cid); return s; }
        }
      }
    }
    log(' tpl source=NONE', cid, 'stats=' + (netStats.active.length + netStats.filtered.length));
    return '';
  }

  // 拉一页回复并合并进 replyIndex，返回本页新增条数（0 表示没有更多/失败）
  async function fetchReplyPage(cid) {
    const tpl = replyUrlTemplate(cid);
    if (!tpl) { log('fetchReplyPage no template', cid); return 0; }
    let u;
    try { u = new URL(tpl); } catch (e) { log('bad url', String(e)); return 0; }
    if (!/\/comment\/list\/reply/.test(u.pathname)) {
      u.pathname = '/aweme/v1/web/comment/list/reply/';
    }
    const awemeId = awemeIdOfCid(cid);
    if (awemeId) {
      u.searchParams.delete('aweme_id');
      u.searchParams.set('item_id', awemeId);
    }
    const prev = replyIndex.get(String(cid)) || [];
    const cursor = prev.reduce((m, r) => Math.max(m, Number(r.cursor) || 0), 0);
    u.searchParams.set('comment_id', String(cid));
    u.searchParams.set('cursor', String(cursor));
    u.searchParams.set('count', '50');
    log('fetchReplyPage', cid, 'cursor=' + cursor, 'awemeId=' + awemeId);

    const res = await mainFetch(u.toString());
    if (!res || !res.ok) { log('fetchReplyPage failed', cid, 'status=' + (res && res.status)); return 0; }
    let data = null;
    try { data = JSON.parse(res.text || ''); } catch (_) {}
    if (!data || !Array.isArray(data.comments) || !data.comments.length) return 0;
    const byCid = new Map(prev.map((r) => [String(r.cid), r]));
    data.comments.forEach((r) => { if (r && r.cid) byCid.set(String(r.cid), r); });
    replyIndex.set(String(cid), [...byCid.values()].sort((a, b) => (a.create_time || 0) - (b.create_time || 0)));
    expanded.add(String(cid));
    itemById = buildItemIndex();
    log('fetchReplyPage merged', cid, 'total=' + byCid.size);
    return data.comments.length;
  }

  async function loadReplies(cid) {
    log('CLICK loadReplies', cid, 'captures=' + captures.length);
    if (loadingFloors.has(String(cid))) { log('already loading', cid); return; }
    loadingFloors.add(String(cid));
    render();
    try { await fetchReplyPage(cid); } catch (e) { log('EXCEPTION', String(e)); }
    loadingFloors.delete(String(cid));
    render();
  }

  function replyOf(comment) {
    const preview = comment.reply_comment || [];
    const indexed = replyIndex.get(String(comment.cid)) || [];
    const byCid = new Map();
    preview.concat(indexed).forEach((r) => {
      if (r && r.cid) byCid.set(String(r.cid), r);
    });
    return [...byCid.values()];
  }

  function renderReply(r) {
    const u = r.user || {};
    const name = u.nickname || '用户';
    // reply_to_reply_id 指向被回复的那条回复；非 0 且命中的话显示「回复 @谁」
    const to = String(r.reply_to_reply_id || '0');
    const targetName = (to !== '0') ? nicknameOf(to) : '';
    const target = targetName
      ? '<span class="dy-badge reply">回复 @' + esc(targetName) + '</span>' : '';
    return '<div class="dy-reply">' +
      '<div class="dy-reply-head">' + avatarHtml(u, 'dy-reply-avatar') +
      '<span class="dy-reply-author">' + esc(name) + '</span>' + target +
      '<button type="button" class="dy-mini-copy" data-copy-one="reply" data-cid="' + esc(r.cid) + '">复制</button>' +
      '<button type="button" class="dy-mini-copy jump" data-jump-comment="' + esc(r.cid) + '">跳转 ↗</button>' +
      '<span class="dy-meta">' + fmtTime(r.create_time) + (r.ip_label ? ' · ' + esc(r.ip_label) : '') + '</span>' +
      '</div>' +
      '<div class="dy-reply-text dy-text">' + fmtText(r.text) + '</div>' +
      '</div>';
  }

  function allDialogGroups() {
    let floors = commentList();
    if (dialogFloorCid) floors = floors.filter((f) => String(f.cid) === String(dialogFloorCid));
    const out = [];
    floors.forEach((floor) => {
      const replies = replyOf(floor);
      buildConversations(floor, replies).forEach((g) => {
        g.floor = floor;
        g.aName = nameByUid(g.a, floor);
        g.bName = nameByUid(g.b, floor);
        out.push(g);
      });
    });
    // 同 key（同一对人在不同楼层）合并展示项
    const merged = new Map();
    out.forEach((g) => {
      const prev = merged.get(g.key);
      if (!prev) {
        merged.set(g.key, g);
      } else {
        g.items.forEach((it) => {
          if (!prev.items.some((p) => String(p.r.cid) === String(it.r.cid))) prev.items.push(it);
        });
      }
    });
    const list = [...merged.values()];
    list.forEach((g) => g.items.sort((x, y) => (x.r.create_time || 0) - (y.r.create_time || 0)));
    list.sort((x, y) => {
      const xl = x.items[x.items.length - 1].r.create_time || 0;
      const yl = y.items[y.items.length - 1].r.create_time || 0;
      return yl - xl;
    });
    return list;
  }

  function renderConversationGroup(g) {
    const rows = g.items.map((it) => {
      const r = it.r;
      const fromName = it.from === g.a ? g.aName : g.bName;
      const toName = it.to === g.a ? g.aName : g.bName;
      const mine = isSelf(r);
      const action = (mine
        ? '<button type="button" class="dy-mini-copy danger" data-dialog-delete="' + esc(r.cid) + '">删除</button>'
        : '<button type="button" class="dy-mini-copy" data-dialog-reply="' + esc(r.cid) +
          '" data-dialog-name="' + esc(fromName) + '">回复</button>') +
        '<button type="button" class="dy-mini-copy jump" data-jump-comment="' + esc(r.cid) + '">跳转 ↗</button>';
      return '<div class="dy-dlg-row' + (it.from === g.a ? ' from-a' : ' from-b') + (mine ? ' mine' : '') + '">' +
        '<div class="dy-dlg-meta"><b>' + esc(fromName) + '</b>' + (mine ? '<span class="dy-badge notice">我</span>' : '') +
        ' <span class="dy-dlg-arrow">→</span> ' +
        esc(toName) + ' <span class="dy-meta">' + fmtTime(r.create_time) + '</span>' + action + '</div>' +
        '<div class="dy-dlg-text dy-text">' + fmtText(r.text) + '</div>' +
        '</div>';
    });
    return '<div class="dy-dlg-list">' + rows.join('') + '</div>';
  }

  function renderDialogTab() {
    const groups = allDialogGroups();
    const allFloor = dialogFloorCid ? itemById.get(dialogFloorCid) : null;
    if (!groups.length && !allFloor) {
      return '<div class="dy-empty">还没有捕获到带回复的评论。<br>在评论 tab 点「跳转查看对话」或「加载并展开全部回复」后再来看。</div>';
    }
    if (!activeDialogKey || (activeDialogKey !== '__all__' && !groups.some((g) => g.key === activeDialogKey))) {
      activeDialogKey = '__all__';
    }
    const tabs = '<button type="button" class="dy-dialog-tab' + (activeDialogKey === '__all__' ? ' on' : '') +
      '" data-dialog-key="__all__">全部<span class="dy-dialog-tab-cnt">' +
      (allFloor ? replyOf(allFloor).length : '') + '</span></button>' +
      groups.map((g) =>
        '<button type="button" class="dy-dialog-tab' + (g.key === activeDialogKey ? ' on' : '') +
        '" data-dialog-key="' + esc(g.key) + '">' + esc(g.aName) + ' ↔ ' + esc(g.bName) +
        '<span class="dy-dialog-tab-cnt">' + g.items.length + '</span></button>').join('');
    const floor = allFloor || (groups.length ? groups[0].floor : null);
    const isLoading = floor ? loadingFloors.has(String(floor.cid)) : false;
    const floorReplies = floor ? replyOf(floor) : [];
    const total = floor ? (floor.reply_comment_total || floorReplies.length) : 0;
    const canLoadMore = floor && total > floorReplies.length;
    const floorTitle = (floor && floor.user && floor.user.nickname) || '用户';
    const scope = dialogFloorCid
      ? '<div class="dy-dialog-scope">楼层：' + esc(floorTitle) + ' <span>· ' + groups.length +
        ' 组对话</span><button type="button" class="dy-mini-copy" data-dialog-all>返回全部楼层</button></div>'
      : '';

    let bodyHtml;
    if (activeDialogKey === '__all__') {
      // 「全部」：显示这个楼层原本的样子（层主 + 全部回复按时间线）
      bodyHtml = '<div class="dy-dlg-head">楼层原貌 <span>· 层主与全部回复</span>' +
        '<span class="dy-dlg-count">' + floorReplies.length + ' 条回复</span></div>' +
        (floor
          ? '<div class="dy-all-floor">' +
            '<div class="dy-dlg-row floor-owner">' +
            '<div class="dy-dlg-meta"><b>' + esc(floorTitle) + '</b> <span class="dy-badge notice">层主</span>' +
            '<span class="dy-meta">' + fmtTime(floor.create_time) + '</span></div>' +
            '<div class="dy-dlg-text dy-text">' + fmtText(floor.text) + '</div></div>' +
            floorReplies.map((r) => {
              const mine = isSelf(r);
              const action = (mine
                ? '<button type="button" class="dy-mini-copy danger" data-dialog-delete="' + esc(r.cid) + '">删除</button>'
                : '<button type="button" class="dy-mini-copy" data-dialog-reply="' + esc(r.cid) +
                  '" data-dialog-name="' + esc((r.user && r.user.nickname) || '用户') + '">回复</button>') +
                '<button type="button" class="dy-mini-copy jump" data-jump-comment="' + esc(r.cid) + '">跳转 ↗</button>';
              return '<div class="dy-dlg-row">' +
                '<div class="dy-dlg-meta"><b>' + esc((r.user && r.user.nickname) || '用户') + '</b>' +
                (mine ? '<span class="dy-badge notice">我</span>' : '') +
                '<span class="dy-meta">' + fmtTime(r.create_time) + '</span>' + action + '</div>' +
                '<div class="dy-dlg-text dy-text">' + fmtText(r.text) + '</div></div>';
            }).join('') + '</div>'
          : '<div class="dy-empty">该楼层无回复</div>');
    } else {
      const active = groups.find((g) => g.key === activeDialogKey) || groups[0];
      bodyHtml = '<div class="dy-dlg-head"><b>' + esc(active.aName) + '</b> <span>↔</span> <b>' +
        esc(active.bName) + '</b><span class="dy-dlg-count">' + active.items.length + ' 条</span></div>' +
        renderConversationGroup(active);
    }
    return scope + '<div class="dy-dialog-tabs">' + tabs + '</div>' +
      '<section class="dy-dlg">' + bodyHtml +
      (canLoadMore
        ? '<button type="button" class="dy-toggle" data-dialog-load="' + esc(floor.cid) + '"' +
          (isLoading ? ' disabled' : '') + '>' +
          (isLoading ? '加载中…' : '加载该楼层更多回复（' + (total - floorReplies.length) + ' 条未加载）→') +
          '</button>'
        : '') +
      '</section>';
  }

  function renderCommentCard(c) {
    const u = c.user || {};
    const name = u.nickname || '用户';
    const replies = replyOf(c);
    const replyCount = c.reply_comment_total || replies.length || 0;
    const isOpen = expanded.has(String(c.cid));
    const shown = isOpen ? replies : replies.slice(0, 3);
    let repliesHtml = '';
    if (shown.length) {
      repliesHtml = '<div class="dy-replies">' + shown.map(renderReply).join('') + '</div>';
    }
    const hidden = replyCount - shown.length;
    const isLoading = loadingFloors.has(String(c.cid));
    let expandBtn = '';
    if (isLoading) {
      expandBtn = '<button type="button" class="dy-toggle" disabled>加载中…</button>';
    } else if (replies.length > 3) {
      expandBtn = '<button type="button" class="dy-toggle" data-comment="' + esc(c.cid) + '">' +
        (isOpen ? '收起回复' : '展开全部 ' + replies.length + ' 条回复') + '</button>';
    } else if (hidden > 0 || !replies.length) {
      expandBtn = '<button type="button" class="dy-toggle" data-load="' + esc(c.cid) + '">' +
        '加载并展开全部 ' + replyCount + ' 条回复 →</button>';
    }
    return '<article class="dy-card">' +
      '<div class="dy-card-head">' + avatarHtml(u, 'dy-avatar') +
      '<div><div class="dy-author">' + esc(name) + '</div>' +
      '<div class="dy-meta">' + fmtTime(c.create_time) + (c.ip_label ? ' · ' + esc(c.ip_label) : '') + '</div></div>' +
      '</div>' +
      '<div class="dy-text">' + fmtText(c.text) + '</div>' +
      '<div class="dy-card-foot">' +
      '<span>♥ ' + (c.digg_count || 0) + '</span><span>💬 ' + replyCount + '</span>' +
      '<button type="button" class="dy-mini-copy dialog" data-open-dialog="' + esc(c.cid) + '">跳转查看对话 →</button>' +
      '<button type="button" class="dy-mini-copy jump" data-jump-comment="' + esc(c.cid) + '">跳到评论 ↗</button>' +
      '<button type="button" class="dy-mini-copy floor" data-copy-floor="' + esc(c.cid) + '">导出整楼</button>' +
      '<button type="button" class="dy-mini-copy" data-copy-one="comment" data-cid="' + esc(c.cid) + '">复制本条</button>' +
      '</div>' +
      repliesHtml + expandBtn +
      '</article>';
  }

  function isFloor(c) {
    // 层主唯一判据：reply_id 为 0/空。
    // 注意不能用 root_comment_id === cid：首层回复的 root_comment_id 就等于自己的 cid，
    // 会把子回复误判成层主。
    const rid = c.reply_id;
    return rid === undefined || rid === null || rid === '' || String(rid) === '0';
  }

  function commentList() {
    const all = mergeComments();
    const list = all.filter(isFloor);
    return list.sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
  }

  // ---------- 通知 ----------
  function getNoticeItems() {
    const byNid = new Map();
    captures.filter((c) => c.kind === 'notice-list' && c.data && Array.isArray(c.data.notice_list_v2))
      .forEach((c) => {
        c.data.notice_list_v2.forEach((n) => {
          if (!n) return;
          const prev = byNid.get(n.nid_str);
          if (!prev || (n.has_read === false && prev.has_read === true)) byNid.set(n.nid_str, n);
        });
      });
    return [...byNid.values()].sort((a, b) => (b.create_time || 0) - (a.create_time || 0));
  }

  function noticeContent(n) {
    // 不同类型通知，内容放在不同专属字段里
    const digg = n.digg && n.digg.aweme;
    if (digg) {
      return {
        desc: digg.desc || '',
        user: digg.author || {},
        cover: (digg.video && digg.video.cover && digg.video.cover.url_list && digg.video.cover.url_list[0]) || '',
        awemeId: digg.aweme_id || n.aweme_id || ''
      };
    }
    const commentN = n.comment;
    if (commentN) {
      return {
        desc: commentN.text || (commentN.aweme && commentN.aweme.desc) || '',
        user: commentN.user || {},
        cover: '',
        awemeId: n.aweme_id || ''
      };
    }
    return { desc: '', user: {}, cover: '', awemeId: n.aweme_id || '' };
  }

  const NOTICE_TYPE = { 31: '评论/回复', 41: '点赞', 1: '新评论', 2: '新回复', 3: '新粉丝', 4: '新粉丝' };

  function noticeTypeName(t) {
    return NOTICE_TYPE[t] || ('通知 ' + t);
  }

  function renderNoticeCard(n) {
    const info = noticeContent(n);
    const typeLabel = noticeTypeName(n.type);
    const unread = n.has_read === false;
    let extra = '';
    try {
      if (n.general_notice && n.general_notice.message_extra) {
        const me = JSON.parse(n.general_notice.message_extra);
        if (me.item_id) extra += '<span class="dy-badge">视频 ' + esc(me.item_id) + '</span>';
      }
    } catch (_) {}
    return '<article class="dy-card dy-notice' + (unread ? ' unread' : '') + '" data-jump="' + esc(n.nid_str) + '">' +
      '<button type="button" class="dy-jump">跳转到该条 →</button>' +
      '<div class="dy-card-head">' + avatarHtml(info.user, 'dy-avatar') +
      '<div><div class="dy-author">' + esc((info.user && info.user.nickname) || '用户') + '</div>' +
      '<div class="dy-meta"><span class="dy-badge notice">' + esc(typeLabel) + '</span> ' + fmtTime(n.create_time) + '</div></div>' +
      '</div>' +
      '<div class="dy-notice-row">' +
      (info.cover ? '<img class="dy-notice-thumb" src="' + esc(info.cover) + '" alt="封面">' : '') +
      '<div class="dy-notice-main">' +
      (info.desc ? '<div class="dy-notice-desc">' + esc(info.desc) + '</div>' : '') +
      extra +
      '</div></div>' +
      '</article>';
  }

  function noticeList() {
    const all = getNoticeItems();
    if (noticeSubTab === 'all') return all;
    return all.filter((n) => String(n.type) === noticeSubTab);
  }

  function noticeCid(n) {
    const c = n.comment || {};
    const g = n.digg || {};
    return String(
      c.real_cid || c.cid || (c.comment && (c.comment.real_cid || c.comment.cid)) ||
      g.real_cid || g.cid || (g.comment && (g.comment.real_cid || g.comment.cid)) || ''
    );
  }

  // 同一接口可能抓到多次，取最新一条，避免用过期的签名模板
  function writeUrlTemplate(kind) {
    for (let i = captures.length - 1; i >= 0; i--) {
      const c = captures[i];
      if (c.kind === kind && c.url) return { url: c.url, reqBody: c.reqBody || '' };
    }
    return null;
  }

  // 抖音写接口失败时多返回 HTTP 200，成败要看 body 里的 status_code
  function writeOk(res) {
    if (!res || !res.ok) return false;
    try {
      const j = JSON.parse(res.text || '');
      if (j && typeof j.status_code === 'number') return j.status_code === 0;
    } catch (_) {}
    return res.status >= 200 && res.status < 300;
  }

  // ---------- DOM 驱动：让抖音页面自己发请求（复用页面签名，不再自造 XHR） ----------
  const DOM_ITEM = '[data-e2e="comment-item"]';

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function waitForEl(fn, timeout) {
    const start = Date.now();
    for (;;) {
      let v = null;
      try { v = fn(); } catch (_) {}
      if (v) return v;
      if (Date.now() - start > (timeout || 6000)) return null;
      await sleep(150);
    }
  }

  function fireDomClick(el) {
    if (!el) return;
    const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
    const send = (type, extra) => {
      const Ctor = (type.indexOf('pointer') === 0 && typeof PointerEvent !== 'undefined')
        ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new Ctor(type, Object.assign({}, base, extra))); } catch (_) {}
    };
    send('pointerover'); send('pointermove');
    send('pointerdown', { buttons: 1 }); send('mousedown', { buttons: 1 });
    send('pointerup', { buttons: 0 }); send('mouseup', { buttons: 0 });
    send('click', { buttons: 0 });
  }

  // cid -> 页面 DOM 评论项：more 按钮 id="tooltip_<cid>" 是精确锚点，文本+昵称兜底
  function findDomItem(cid) {
    const id = String(cid);
    const more = document.getElementById('tooltip_' + id);
    if (more) {
      const item = more.closest(DOM_ITEM);
      if (item) return item;
    }
    const c = itemById.get(id);
    if (!c) return null;
    const nick = String((c.user && c.user.nickname) || '').replace(/\s+/g, '');
    const txt = String(c.text || '').replace(/\s+/g, '').slice(0, 24);
    let best = null, bestScore = 0;
    document.querySelectorAll(DOM_ITEM).forEach((el) => {
      const t = (el.textContent || '').replace(/\s+/g, '');
      let score = 0;
      if (txt && t.indexOf(txt) >= 0) score += 10;
      if (nick && t.indexOf(nick) >= 0) score += 3;
      if (score > bestScore) { bestScore = score; best = el; }
    });
    return bestScore >= 10 ? best : null;
  }

  // 目标 cid 所属楼层 cid：replyIndex 的 key 就是 reply 接口的 comment_id（楼层 cid）
  function findFloorCid(cid) {
    const id = String(cid);
    for (const [floorCid, list] of replyIndex) {
      if ((list || []).some((r) => r && String(r.cid) === id)) return String(floorCid);
    }
    if (commentList().some((c) => String(c.cid) === id)) return id;
    const c = itemById.get(id);
    if (c) {
      if (c.root_comment_id && String(c.root_comment_id) !== '0' && String(c.root_comment_id) !== id) {
        return String(c.root_comment_id);
      }
      if (c.reply_id && String(c.reply_id) !== '0' && String(c.reply_id) !== id) return String(c.reply_id);
    }
    return '';
  }

  const EXPAND_RE = /(展开|查看|加载)(?:更多|全部|\d+)?\s*(条)?\s*(回复|评论)/;

  function findExpandBtn(item) {
    const scopes = [item];
    if (item.nextElementSibling) scopes.push(item.nextElementSibling);
    const box = item.querySelector('[class*="replyContainer"]')
      || (item.nextElementSibling && item.nextElementSibling.matches('[class*="replyContainer"]')
        ? item.nextElementSibling : null);
    if (box && scopes.indexOf(box) < 0) scopes.push(box);
    const all = [];
    scopes.forEach((s) => {
      s.querySelectorAll('button,[role="button"],div,span').forEach((el) => {
        const t = (el.textContent || '').trim();
        if (t && t.length < 40 && EXPAND_RE.test(t) && el.getClientRects().length) all.push(el);
      });
    });
    return all.find((el) => !all.some((o) => o !== el && el.contains(o))) || all[0] || null;
  }

  function floorScroller() {
    const item = document.querySelector(DOM_ITEM);
    if (!item) return null;
    let cur = item.parentElement;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      const st = getComputedStyle(cur);
      if (/(auto|scroll)/.test(st.overflowY) && cur.scrollHeight > cur.clientHeight + 40) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  // 滚动评论区触发页面自己的 comment/list 分页，把更多楼层加载进 DOM
  async function loadMoreFloors() {
    const sc = floorScroller();
    const before = document.querySelectorAll(DOM_ITEM).length;
    if (sc) sc.scrollTop = sc.scrollHeight;
    else window.scrollBy(0, Math.max(600, window.innerHeight));
    log('ensure scroll', sc ? 'container' : 'window', 'items=' + before);
    await sleep(1000);
    const after = document.querySelectorAll(DOM_ITEM).length;
    log('ensure scroll result', before, '->', after);
    return after > before;
  }

  // 让目标 cid 出现在页面 DOM：滚动加载楼层 -> 自动展开该楼层回复，全部由页面自己请求
  async function ensureDomItem(cid) {
    let item = findDomItem(cid);
    if (item) return item;
    const floorCid = findFloorCid(cid);
    log('ensureDomItem', cid, 'floor=' + floorCid);
    if (!floorCid) return null;

    let floorItem = findDomItem(floorCid);
    for (let round = 0; !floorItem && round < 15; round++) {
      if (!(await loadMoreFloors())) break;
      floorItem = findDomItem(floorCid);
    }
    if (!floorItem) { log('ensureDomItem floor not loaded', floorCid); return null; }

    for (let round = 0; round < 15; round++) {
      item = findDomItem(cid);
      if (item) return item;
      const btn = findExpandBtn(floorItem);
      if (!btn) { log('ensureDomItem no expand btn at round', round); break; }
      const before = document.querySelectorAll(DOM_ITEM).length;
      fireDomClick(btn);
      log('ensureDomItem click expand', (btn.textContent || '').trim(), 'round=' + round);
      let grown = false;
      for (let w = 0; w < 25; w++) {
        await sleep(200);
        item = findDomItem(cid);
        if (item) return item;
        if (document.querySelectorAll(DOM_ITEM).length > before) { grown = true; break; }
      }
      if (!grown) { log('ensureDomItem expand stalled'); break; }
    }
    return findDomItem(cid);
  }

  function findVisibleByText(root, re) {
    const nodes = root.querySelectorAll('button,[role="button"],div,span,[aria-label]');
    for (const el of nodes) {
      const t = ((el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
      if (t && t.length < 12 && re.test(t) && el.getClientRects().length) return el;
    }
    return null;
  }

  function fillInput(el, text) {
    try {
      if (el.isContentEditable) {
        el.focus();
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        sel.removeAllRanges(); sel.addRange(range);
        return document.execCommand('insertText', false, text);
      }
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && d.set) d.set.call(el, text); else el.value = text;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (_) { return false; }
  }

  function findSendButton(input) {
    const scope = input.closest(DOM_ITEM) || input.parentElement.parentElement || document;
    const byText = findVisibleByText(scope, /^(发送|发布)$/) || findVisibleByText(document, /^(发送|发布)$/);
    if (byText) return byText;
    const box = input.closest('[class*="reply"],[class*="input"],[class*="comment"]') || input.parentElement;
    const cands = [...box.querySelectorAll('[class*="send"],[class*="submit"],button,[role="button"]')]
      .filter((e) => e.getClientRects().length);
    return cands[cands.length - 1] || null;
  }

  async function domReply(cid, replyName, text) {
    const item = await ensureDomItem(cid);
    log('domReply item?', !!item, 'cid=' + cid, 'name=' + replyName);
    if (!item) {
      alert('已尝试滚动加载并自动展开楼层，仍未定位到这条评论。展开下方调试日志看卡在哪一步。');
      return false;
    }
    try { item.scrollIntoView({ block: 'center' }); } catch (_) {}
    const rBtn = findVisibleByText(item, /^回复$/);
    log('domReply replyBtn?', !!rBtn);
    if (!rBtn) { alert('这条评论项里没找到「回复」按钮，页面结构可能变了，请看调试日志。'); return false; }
    fireDomClick(rBtn);

    const input = await waitForEl(() => {
      const sels = '[contenteditable="true"],textarea,[data-e2e*="reply"],[class*="input"]';
      let list = [...item.querySelectorAll(sels)].filter((e) => e.getClientRects().length);
      if (!list.length) {
        list = [...document.querySelectorAll('[contenteditable="true"],textarea')]
          .filter((e) => e.getClientRects().length);
      }
      return list[list.length - 1] || null;
    }, 6000);
    if (!input) { alert('点回复后没找到输入框，请看调试日志。'); return false; }
    log('domReply input', input.tagName, 'cls=' + String(input.className || '').slice(0, 80));

    const okFill = fillInput(input, text);
    log('domReply fill', okFill, 'text=' + text.slice(0, 40));
    await sleep(250);

    const sendBtn = findSendButton(input);
    log('domReply sendBtn?', !!sendBtn);
    if (!sendBtn) { alert('没找到「发送」按钮，文字已填入输入框，请手动点发送。'); return false; }
    fireDomClick(sendBtn);
    log('domReply clicked send');
    return true;
  }

  async function domDelete(cid) {
    const item = await ensureDomItem(cid);
    log('domDelete item?', !!item, 'cid=' + cid);
    if (!item) {
      alert('已尝试滚动加载并自动展开楼层，仍未定位到这条评论。展开下方调试日志看卡在哪一步。');
      return false;
    }
    try { item.scrollIntoView({ block: 'center' }); } catch (_) {}
    const more = item.querySelector('[data-e2e="video-comment-more"]') || document.getElementById('tooltip_' + cid);
    if (!more) { alert('没找到「更多」按钮，请看调试日志。'); return false; }
    fireDomClick(more);

    const delBtn = await waitForEl(() => findVisibleByText(document, /^删除$/), 4000);
    log('domDelete delBtn?', !!delBtn);
    if (!delBtn) { alert('菜单里没找到「删除」，请看调试日志。'); return false; }
    fireDomClick(delBtn);
    await sleep(300);

    const confirmBtn = await waitForEl(() =>
      findVisibleByText(document, /^(确定|确认)$/), 3000);
    if (confirmBtn) { log('domDelete confirm', (confirmBtn.textContent || '').trim()); fireDomClick(confirmBtn); }
    log('domDelete done');
    return true;
  }

  // 回复/删除统一走 DOM 驱动（页面自己发请求）；保留 writeUrlTemplate/writeOk 供调试或回退
  async function doReply(cid, replyName, btn) {
    const text = window.prompt('回复 ' + (replyName || '该用户') + '：', '');
    if (!text || !text.trim()) return;
    if (btn) btn.textContent = '发送中…';
    let ok = false;
    try { ok = await domReply(cid, replyName, text.trim()); } catch (e) { log('domReply ERR', String(e)); }
    if (btn) btn.textContent = '回复';
    if (ok) alert('已通过页面发送，请核对评论是否出现。若未出现，展开下方调试日志看定位情况。');
  }

  async function doDelete(cid, btn) {
    if (!window.confirm('确定删除这条评论/回复？此操作不可撤销。')) return;
    if (btn) btn.textContent = '删除中…';
    let ok = false;
    try { ok = await domDelete(cid); } catch (e) { log('domDelete ERR', String(e)); }
    if (btn) btn.textContent = '删除';
    if (ok) alert('已通过页面提交删除，请核对评论是否消失。若未消失，展开下方调试日志看定位情况。');
  }

  function jumpToNotice(nid) {
    const n = getNoticeItems().find((x) => String(x.nid_str) === String(nid));
    if (!n) return;
    const awemeId = noticeContent(n).awemeId || n.aweme_id || '';
    const cid = noticeCid(n);
    close();
    if (!awemeId) { alert('这条通知没有关联视频，无法跳转'); return; }
    let url = 'https://www.douyin.com/video/' + awemeId;
    if (cid && cid !== '0') url += '?insert_ids=' + encodeURIComponent(cid);
    window.open(url, '_blank', 'noopener');
  }

  // 跳到具体评论/回复：视频页 + insert_ids=<cid>，让抖音把这条置顶加载
  function jumpToComment(cid) {
    if (!cid || cid === '0') { alert('这条评论没有可用的 cid，无法跳转'); return; }
    const awemeId = awemeIdOfCid(cid);
    if (!awemeId) { alert('找不到这条评论所属的视频ID，无法拼接跳转链接'); return; }
    const url = 'https://www.douyin.com/video/' + awemeId + '?insert_ids=' + encodeURIComponent(String(cid));
    log('jumpToComment', cid, url);
    window.open(url, '_blank', 'noopener');
  }

  // ---------- 分页 ----------
  function pageCount(total) {
    return Math.max(1, Math.ceil(total / PAGE_SIZE[currentTab]));
  }

  function pagerHtml(total) {
    const pages = pageCount(total);
    const cur = Math.min(pageState[pageKey()], pages);
    pageState[pageKey()] = cur;
    if (total <= PAGE_SIZE[currentTab]) return '';

    const nums = [];
    const win = 2;
    const start = Math.max(1, cur - win);
    const end = Math.min(pages, cur + win);
    if (start > 1) nums.push('<button type="button" data-page="1">1</button>');
    if (start > 2) nums.push('<span class="dy-pager-dots">…</span>');
    for (let i = start; i <= end; i++) {
      nums.push('<button type="button" data-page="' + i + '"' +
        (i === cur ? ' class="on"' : '') + '>' + i + '</button>');
    }
    if (end < pages - 1) nums.push('<span class="dy-pager-dots">…</span>');
    if (end < pages) nums.push('<button type="button" data-page="' + pages + '">' + pages + '</button>');

    return '<div class="dy-pager">' +
      '<button type="button" data-page="prev"' + (cur === 1 ? ' disabled' : '') + '>上一页</button>' +
      nums.join('') +
      '<button type="button" data-page="next"' + (cur === pages ? ' disabled' : '') + '>下一页</button>' +
      '<span class="dy-pager-info">共 ' + total + ' 条 · ' + pages + ' 页 · 第 ' + cur + ' 页</span>' +
      '</div>';
  }

  function goPage(v) {
    const list = currentTab === 'comment' ? commentList() : noticeList();
    const pages = pageCount(list.length);
    const cur = pageState[pageKey()];
    let next = cur;
    if (v === 'prev') next = Math.max(1, cur - 1);
    else if (v === 'next') next = Math.min(pages, cur + 1);
    else next = Math.max(1, Math.min(pages, Number(v) || 1));
    if (next === cur) return;
    pageState[pageKey()] = next;
    render();
    const body = root && root.querySelector('.dy-panel-body');
    if (body) body.scrollTop = 0;
  }

  function renderSubTabs() {
    const box = document.getElementById('dySubTabs');
    if (!box) return;
    if (currentTab !== 'notice') { box.style.display = 'none'; return; }
    box.style.display = 'flex';
    const all = getNoticeItems();
    const types = [...new Set(all.map((n) => String(n.type)))];
    if (noticeSubTab !== 'all' && types.indexOf(noticeSubTab) < 0) noticeSubTab = 'all';
    let html = '<button type="button" class="dy-subtab' + (noticeSubTab === 'all' ? ' on' : '') +
      '" data-subtab="all">全部 ' + all.length + '</button>';
    types.sort().forEach((t) => {
      const c = all.filter((n) => String(n.type) === t).length;
      html += '<button type="button" class="dy-subtab' + (noticeSubTab === t ? ' on' : '') +
        '" data-subtab="' + esc(t) + '">' + esc(noticeTypeName(t)) + ' ' + c + '</button>';
    });
    box.innerHTML = html;
  }

  // ---------- 面板 DOM ----------
  function build() {
    if (root) return;
    root = document.createElement('div');
    root.className = 'dy-panel';
    root.innerHTML =
      '<div class="dy-panel-header">' +
      '<div class="dy-panel-title">抖音评论面板</div>' +
      '<div class="dy-panel-tabs">' +
      '<button class="dy-panel-tab active" data-tab="comment">评论 / 回复</button>' +
      '<button class="dy-panel-tab" data-tab="dialog">对话</button>' +
      '<button class="dy-panel-tab" data-tab="notice">通知</button>' +
      '</div>' +
      '<div class="dy-panel-actions">' +
      '<button class="dy-panel-btn" data-act="refresh">刷新数据</button>' +
      '<button class="dy-panel-btn" data-act="video">暂停视频</button>' +
      '<button class="dy-panel-btn primary" data-act="close">关闭 (Esc)</button>' +
      '</div></div>' +
      '<div class="dy-panel-subtabs" id="dySubTabs"></div>' +
      '<div class="dy-panel-hint" id="dyHint"></div>' +
      '<details class="dy-debug"><summary>调试日志（点展开加载时看这里）</summary><pre id="dyDebug"></pre></details>' +
      '<div class="dy-panel-body"><div class="dy-panel-inner" id="dyContent"></div></div>';
    (document.body || document.documentElement).appendChild(root);

    root.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-tab]');
      if (tab) { switchTab(tab.dataset.tab); return; }
      const pg = e.target.closest('[data-page]');
      if (pg) {
        if (!pg.disabled) goPage(pg.dataset.page);
        return;
      }
      const sub = e.target.closest('[data-subtab]');
      if (sub) {
        noticeSubTab = sub.dataset.subtab;
        pageState[pageKey()] = 1;
        render();
        saveState();
        return;
      }
      const dlgReply = e.target.closest('[data-dialog-reply]');
      if (dlgReply) {
        doReply(dlgReply.dataset.dialogReply, dlgReply.dataset.dialogName, dlgReply);
        return;
      }
      const dlgDelete = e.target.closest('[data-dialog-delete]');
      if (dlgDelete) { doDelete(dlgDelete.dataset.dialogDelete, dlgDelete); return; }
      const dlgAll = e.target.closest('[data-dialog-all]');
      if (dlgAll) { dialogFloorCid = ''; activeDialogKey = ''; render(); return; }
      const dlgTab = e.target.closest('[data-dialog-key]');
      if (dlgTab) {
        const key = dlgTab.dataset.dialogKey;
        if (key !== activeDialogKey) {
          activeDialogKey = key;
          const g = allDialogGroups().find((x) => x.key === key);
          if (g && !loadingFloors.has(g.floorCid)) {
            const loaded = replyOf(g.floor).length;
            const total = g.floor.reply_comment_total || loaded;
            if (total > loaded) loadReplies(g.floorCid);
          }
        }
        render();
        return;
      }
      const dlgLoad = e.target.closest('[data-dialog-load]');
      if (dlgLoad) { loadReplies(dlgLoad.dataset.dialogLoad); return; }
      const openDlg = e.target.closest('[data-open-dialog]');
      if (openDlg) {
        dialogFloorCid = String(openDlg.dataset.openDialog);
        activeDialogKey = '';
        switchTab('dialog');
        const floor = itemById.get(dialogFloorCid);
        if (floor && !loadingFloors.has(dialogFloorCid)) {
          const loaded = replyOf(floor).length;
          const total = floor.reply_comment_total || loaded;
          if (total > loaded) loadReplies(dialogFloorCid);
        }
        return;
      }
      const jumpCmt = e.target.closest('[data-jump-comment]');
      if (jumpCmt) { jumpToComment(jumpCmt.dataset.jumpComment); return; }
      const copyFloorBtn = e.target.closest('[data-copy-floor]');
      if (copyFloorBtn) { exportFloor(copyFloorBtn.dataset.copyFloor, copyFloorBtn); return; }
      const copyOneBtn = e.target.closest('[data-copy-one]');
      if (copyOneBtn) {
        copyOne(copyOneBtn.dataset.copyOne, copyOneBtn.dataset.cid, copyOneBtn);
        return;
      }
      const jump = e.target.closest('[data-jump]');
      if (jump) { jumpToNotice(jump.dataset.jump); return; }
      const act = e.target.closest('[data-act]');
      if (act) {
        const a = act.dataset.act;
        if (a === 'close') close();
        else if (a === 'refresh') refresh();
        else if (a === 'video') toggleVideo(act);
        return;
      }
      const load = e.target.closest('[data-load]');
      if (load) { loadReplies(load.dataset.load); return; }
      const tog = e.target.closest('[data-comment]');
      if (tog) {
        const cid = String(tog.dataset.comment);
        if (expanded.has(cid)) expanded.delete(cid); else expanded.add(cid);
        render();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && root && root.classList.contains('dy-open')) close();
    });
  }

  function switchTab(tab) {
    currentTab = tab;
    root.querySelectorAll('.dy-panel-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    render();
    saveState();
    if (tab === 'dialog') autoLoadActiveDialog();
  }

  function autoLoadActiveDialog() {
    const g = allDialogGroups().find((x) => x.key === activeDialogKey);
    if (!g || loadingFloors.has(g.floorCid)) return;
    const loaded = replyOf(g.floor).length;
    const total = g.floor.reply_comment_total || loaded;
    if (total > loaded) loadReplies(g.floorCid);
  }

  function toggleVideo(btn) {
    chrome.runtime.sendMessage({ type: 'DY_VIDEO_GET' }, (res) => {
      const next = !(res && res.pause);
      chrome.runtime.sendMessage({ type: 'DY_VIDEO_SET', pause: next }, () => {
        btn.textContent = next ? '恢复视频' : '暂停视频';
      });
    });
  }

  async function refresh() {
    try {
      const data = await chrome.runtime.sendMessage({ type: 'DY_NET_GET' });
      netStats = { active: (data && data.active) || [], filtered: (data && data.filtered) || [] };
      selfUser = (data && data.self) || selfUser;
      captures = ((data && data.captures) || []).map((c) => {
        if (c && c.data) return c;
        let parsed = null;
        try { parsed = JSON.parse(c.body); } catch (_) {}
        return Object.assign({}, c, { data: parsed });
      });
      replyIndex = buildReplyIndex();
      itemById = buildItemIndex();
      // 兜底：从已捕获的发表评论响应里提取「自己」（兼容旧数据/未触发 profile/self）
      if (!selfUser) {
        const pub = captures.find((c) => c.kind === 'comment-publish' && c.data && c.data.comment && c.data.comment.user);
        if (pub) {
          const u = pub.data.comment.user;
          if (u.uid || u.sec_uid) {
            selfUser = {
              uid: String(u.uid || ''), secUid: String(u.sec_uid || ''),
              nickname: String(u.nickname || ''), avatar: ''
            };
            chrome.runtime.sendMessage({
              type: 'DY_SELF_SET',
              payload: { uid: selfUser.uid, sec_uid: selfUser.secUid, nickname: selfUser.nickname }
            }, () => {});
          }
        }
      }
      render();
    } catch (_) {}
  }

  function render() {
    if (!root) return;
    renderSubTabs();
    const content = document.getElementById('dyContent');
    const hint = document.getElementById('dyHint');
    const cc = getCommentCaptures().length;
    const nc = captures.filter((c) => c.kind === 'notice-list' && c.data && c.data.notice_list_v2).length;
    hint.innerHTML = '已捕获数据：评论接口 <b>' + cc + '</b> 组 · 通知接口 <b>' + nc + '</b> 组' +
      '　|　数据来自抓包，关闭面板在页面加载更多后重开即可更新';

    if (currentTab === 'dialog') {
      hint.innerHTML = '1v1 对话视图：顶部切换「谁 ↔ 谁」，下方显示这对人的完整对话；' +
        '从评论 tab 的「跳转查看对话」进入可聚焦到单个楼层';
      content.innerHTML = renderDialogTab();
      return;
    }

    const isComment = currentTab === 'comment';
    const list = isComment ? commentList() : noticeList();
    if (!list.length) {
      content.innerHTML = '<div class="dy-empty">' +
        (isComment
          ? '还没有捕获到评论数据。<br>关闭面板，在视频页滚动评论或点「展开更多回复」后，重新打开面板。'
          : '还没有捕获到通知数据。<br>关闭面板，打开抖音消息通知页浏览后，重新打开面板。') +
        '</div>';
      return;
    }
    const size = PAGE_SIZE[currentTab];
    const pages = pageCount(list.length);
    const cur = Math.min(pageState[pageKey()], pages);
    pageState[pageKey()] = cur;
    const start = (cur - 1) * size;
    const cards = list.slice(start, start + size).map(isComment ? renderCommentCard : renderNoticeCard);
    content.innerHTML = cards.join('') + pagerHtml(list.length);
  }

  const STORE_PANEL = 'dy_panel_state_v1';

  function saveState() {
    try {
      chrome.storage.local.set({
        [STORE_PANEL]: {
          open: !!(root && root.classList.contains('dy-open')),
          tab: currentTab,
          subTab: noticeSubTab,
          ts: Date.now()
        }
      });
    } catch (_) {}
  }

  async function restoreState() {
    let s = null;
    try {
      const data = await chrome.storage.local.get([STORE_PANEL]);
      s = data && data[STORE_PANEL];
    } catch (_) {}
    // 24 小时内且上次是打开状态，则自动恢复
    if (s && s.open && Date.now() - (s.ts || 0) < 86400000) {
      currentTab = s.tab === 'notice' ? 'notice' : 'comment';
      noticeSubTab = s.subTab || 'all';
      await open(true);
      log('state restored', currentTab, noticeSubTab);
    }
  }

  async function open(skipSave) {
    build();
    await refresh();
    root.classList.add('dy-open');
    root.querySelectorAll('.dy-panel-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === currentTab));
    render();
    chrome.runtime.sendMessage({ type: 'DY_VIDEO_SET', pause: true }, () => {});
    if (!skipSave) saveState();
  }

  function close() {
    if (root) root.classList.remove('dy-open');
    saveState();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg) return false;
    if (msg.type === 'DY_PANEL_PING') { sendResponse({ ok: true }); return false; }
    if (msg.type === 'DY_PANEL_OPEN') { open(); sendResponse({ ok: true }); return false; }
    if (msg.type === 'DY_PANEL_CLOSE') { close(); sendResponse({ ok: true }); return false; }
    if (msg.type === 'DY_PANEL_TOGGLE') {
      const opening = !(root && root.classList.contains('dy-open'));
      if (opening) open(); else close();
      sendResponse({ ok: true, open: opening });
      return false;
    }
    return false;
  });

  restoreState();
})();
