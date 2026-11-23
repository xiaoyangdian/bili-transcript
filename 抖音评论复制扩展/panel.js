(function () {
  'use strict';

  // 独立评论/通知面板。数据来自后台已捕获的接口响应，不重复请求网络。

  let root = null;
  let currentTab = 'comment';
  let captures = [];
  let netStats = { active: [], filtered: [] };
  let itemById = new Map();
  let replyIndex = new Map();
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

  function mainFetch(url) {
    return new Promise((resolve) => {
      const id = ++fetchSeq;
      log('REQ', id, url.slice(0, 220));
      const timer = setTimeout(() => {
        pendingFetch.delete(id);
        log('REQ timeout', id);
        resolve({ ok: false, error: 'timeout' });
      }, 12000);
      pendingFetch.set(id, (res) => { clearTimeout(timer); resolve(res); });
      window.postMessage({ __dyNetFetchReq: { id, url } }, '*');
    });
  }

  const PAGE_SIZE = { comment: 8, notice: 10 };
  const pageState = { comment: 1, notice: 1 };
  let noticeSubTab = 'all';

  function pageKey() {
    return currentTab === 'comment' ? 'comment' : 'notice:' + noticeSubTab;
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

  async function copyFloor(cid, btn) {
    const c = itemById.get(String(cid));
    if (!c) return;
    const u = c.user || {};
    const head = (u.nickname || '用户') + '：' + (c.text || '') +
      (c.create_time ? '（' + fmtTime(c.create_time) + '）' : '');
    const lines = [head];
    replyOf(c).forEach((r) => {
      const to = String(r.reply_to_reply_id || '0');
      const targetName = (to !== '0') ? nicknameOf(to) : '';
      lines.push(replyLine(r, targetName));
    });
    const ok = await copyText(lines.join('\n'));
    if (btn) {
      const old = btn.textContent;
      btn.textContent = ok ? '已复制' : '复制失败';
      setTimeout(() => { btn.textContent = old; }, 1200);
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

  async function loadReplies(cid) {
    log('CLICK loadReplies', cid, 'captures=' + captures.length);
    if (loadingFloors.has(String(cid))) { log('already loading', cid); return; }
    const tpl = replyUrlTemplate(cid);
    log('template', tpl ? tpl.slice(0, 160) : '(none)');
    if (!tpl) { log('no template, abort'); return; }
    let u;
    try { u = new URL(tpl); } catch (e) { log('bad url', String(e)); return; }
    // 评论列表模板需要改成回复接口路径
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
    log('final url', u.toString().slice(0, 260), 'awemeId=' + awemeId);

    loadingFloors.add(String(cid));
    render();
    try {
      const res = await mainFetch(u.toString());
      log('fetch done', cid, 'ok=' + (res && res.ok), 'status=' + (res && res.status));
      let data = null;
      if (res && res.ok) {
        log('response head', (res.text || '').slice(0, 300));
        try { data = JSON.parse(res.text); } catch (e) { log('json parse error', String(e)); }
      }
      log('parsed', 'status_code=' + (data && data.status_code), 'comments=' + (data && data.comments && data.comments.length));
      if (data && Array.isArray(data.comments) && data.comments.length) {
        const cur = replyIndex.get(String(cid)) || [];
        const byCid = new Map(cur.map((r) => [String(r.cid), r]));
        data.comments.forEach((r) => { if (r && r.cid) byCid.set(String(r.cid), r); });
        replyIndex.set(String(cid), [...byCid.values()].sort((a, b) => (a.create_time || 0) - (b.create_time || 0)));
        expanded.add(String(cid));
        itemById = buildItemIndex();
        log('merged', cid, 'total=' + byCid.size);
      } else {
        log('no comments, keep collapsed', cid);
      }
    } catch (e) {
      log('EXCEPTION', String(e));
    }
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
      '<span class="dy-meta">' + fmtTime(r.create_time) + (r.ip_label ? ' · ' + esc(r.ip_label) : '') + '</span>' +
      '</div>' +
      '<div class="dy-reply-text dy-text">' + fmtText(r.text) + '</div>' +
      '</div>';
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
      '<button type="button" class="dy-mini-copy floor" data-copy-floor="' + esc(c.cid) + '">复制整楼</button>' +
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
      const copyFloorBtn = e.target.closest('[data-copy-floor]');
      if (copyFloorBtn) { copyFloor(copyFloorBtn.dataset.copyFloor, copyFloorBtn); return; }
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
      captures = ((data && data.captures) || []).map((c) => {
        if (c && c.data) return c;
        let parsed = null;
        try { parsed = JSON.parse(c.body); } catch (_) {}
        return Object.assign({}, c, { data: parsed });
      });
      replyIndex = buildReplyIndex();
      itemById = buildItemIndex();
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
