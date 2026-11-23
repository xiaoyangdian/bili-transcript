(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const refreshBtn = document.getElementById('refresh');
  const netStatusEl = document.getElementById('netStatus');
  const urlListEl = document.getElementById('urlList');
  const captureListEl = document.getElementById('captureList');

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', !!isError);
  }
  function setNetStatus(msg, isError) {
    netStatusEl.textContent = msg || '';
    netStatusEl.classList.toggle('error', !!isError);
  }

  // ---------- 标签切换 ----------
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
      document.getElementById('panel-copy').hidden = tab.dataset.panel !== 'copy';
      document.getElementById('panel-net').hidden = tab.dataset.panel !== 'net';
      if (tab.dataset.panel === 'net') loadNet();
    });
  });

  // ---------- 复制按钮注入 ----------
  async function ensureContentScript(tabId) {
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'DY_PING' });
      if (res && res.ok) return;
    } catch (_) {}
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    await new Promise((r) => setTimeout(r, 150));
  }

  async function refresh() {
    setStatus('处理中…');
    refreshBtn.disabled = true;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) throw new Error('找不到当前标签页');
      if (!/^https:\/\/www\.douyin\.com\//.test(tab.url || '')) {
        throw new Error('请在 www.douyin.com 的视频页面使用');
      }
      await ensureContentScript(tab.id);
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'DY_REFRESH' });
      if (!res || !res.ok) throw new Error('注入失败');
      setStatus(`已为 ${res.count} 条评论添加复制按钮`);
    } catch (e) {
      setStatus(e && e.message || String(e), true);
    } finally {
      refreshBtn.disabled = false;
    }
  }
  refreshBtn.addEventListener('click', refresh);
  refresh();

  // ---------- 视频暂停开关 ----------
  const videoBtn = document.getElementById('videoToggle');

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id || !/^https:\/\/www\.douyin\.com\//.test(tab.url || '')) {
      throw new Error('请在 www.douyin.com 的视频页面使用');
    }
    return tab;
  }

  async function syncVideoBtn() {
    try {
      const tab = await activeTab();
      const res = await chrome.tabs.sendMessage(tab.id, { type: 'DY_VIDEO_GET' });
      videoBtn.textContent = res && res.pause ? '恢复播放' : '暂停视频';
    } catch (_) {
      videoBtn.textContent = '暂停视频';
    }
  }

  videoBtn.addEventListener('click', async () => {
    try {
      const tab = await activeTab();
      const cur = await chrome.tabs.sendMessage(tab.id, { type: 'DY_VIDEO_GET' });
      const next = !(cur && cur.pause);
      await chrome.tabs.sendMessage(tab.id, { type: 'DY_VIDEO_SET', pause: next });
      videoBtn.textContent = next ? '恢复播放' : '暂停视频';
    } catch (e) {
      setStatus(e && e.message || String(e), true);
    }
  });
  syncVideoBtn();

  // ---------- 打开独立面板 ----------
  const panelBtn = document.getElementById('openPanel');

  async function ensurePanelScript(tabId) {
    let ok = false;
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'DY_PANEL_PING' });
      ok = !!(res && res.ok);
    } catch (_) {}
    if (ok) return;
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['panel.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['panel.js'] });
    await new Promise((r) => setTimeout(r, 120));
  }

  panelBtn.addEventListener('click', async () => {
    try {
      const tab = await activeTab();
      await ensureContentScript(tab.id);
      await ensurePanelScript(tab.id);
      await chrome.tabs.sendMessage(tab.id, { type: 'DY_PANEL_OPEN' });
      setStatus('面板已打开，按 Esc 关闭');
    } catch (e) {
      setStatus(e && e.message || String(e), true);
    }
  });

  // ---------- 网络抓包 ----------
  function kindTag(kind) {
    if (kind === 'reply-list') return '<span class="tag reply">疑似回复列表</span>';
    if (kind === 'comment-list') return '<span class="tag comment">疑似评论列表</span>';
    if (kind === 'comment-publish') return '<span class="tag reply">发表评论</span>';
    if (kind === 'comment-delete') return '<span class="tag reply">删除评论</span>';
    if (/^captcha/.test(kind)) return '<span class="tag more">验证码</span>';
    if (kind === 'comment-other') return '<span class="tag">评论相关</span>';
    return '<span class="tag">其他</span>';
  }

  function shortSample(s) {
    try {
      const u = new URL(s);
      const params = [...u.searchParams.keys()].slice(0, 8).join(', ');
      return u.pathname + (params ? '  ?' + params : '');
    } catch (_) {
      return s;
    }
  }

  function renderUrls(data) {
    urlListEl.innerHTML = '';
    const active = data.active || [];
    const filtered = data.filtered || [];
    if (!active.length && !filtered.length) {
      urlListEl.innerHTML = '<div class="empty">暂无请求。刷新抖音页面并滚动评论区后再试。</div>';
      return;
    }
    const hit = (r) => r.kind === 'reply-list' || r.kind === 'comment-list';
    const rows = [...active.filter(hit), ...active.filter((r) => !hit(r)), ...filtered];
    rows.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'item' + (hit(r) && !r.excluded ? ' hit' : '') + (r.excluded ? ' filtered' : '');
      const sample = r.samples && r.samples[0] || (r.origin + r.path);
      div.innerHTML =
        '<span class="cnt">×' + r.count + '</span>' +
        kindTag(r.kind) +
        (r.excluded ? '<span class="tag">已过滤(>5)</span>' : '') +
        '<div class="path">' + escapeHtml(r.path) + '</div>' +
        '<div class="sample">' + escapeHtml(shortSample(sample)) + '</div>';
      urlListEl.appendChild(div);
    });
  }

  function renderCaptures(data) {
    captureListEl.innerHTML = '';
    const caps = (data.captures || []).slice().reverse();
    if (!caps.length) {
      captureListEl.innerHTML = '<div class="empty">暂无捕获。滚动评论或点「展开更多回复」后再看。</div>';
      return;
    }
    caps.forEach((c) => {
      const div = document.createElement('div');
      div.className = 'item' + (c.kind === 'reply' ? ' hit' : '');
      const KIND_LABELS = {
        reply: '回复', comment: '评论', 'comment-publish': '发表评论',
        'comment-delete': '删除评论', 'comment-other': '评论相关',
        'notice-list': '通知列表', 'notice-count': '未读数',
        'im-message': '私信消息', 'im-conversation': '会话列表',
        'captcha-decision': '验证码决策', 'captcha-send-code': '发送验证码',
        'captcha-validate': '校验验证码'
      };
      const kindLabel = KIND_LABELS[c.kind] || c.kind;
      const phaseLabel = c.phase === 'more' ? '翻页' : (c.phase === 'initial' ? '首页' : c.phase);
      const isNotice = /^notice|^im-/.test(c.kind);
      const preview = (c.body || '').slice(0, 160);
      div.innerHTML =
        '<span class="tag ' + (isNotice ? 'more' : (c.kind === 'reply' ? 'reply' : 'comment')) + '">' + kindLabel + '</span>' +
        '<span class="tag ' + (c.phase === 'more' ? 'more' : 'initial') + '">' + phaseLabel + '</span>' +
        (c.notice ? '<span class="tag reply">通知进入</span>' : '') +
        (c.insertIds ? '<span class="tag">置顶ID=' + escapeHtml(c.insertIds) + '</span>' : '') +
        (c.noticeGroup ? '<span class="tag">分组=' + escapeHtml(c.noticeGroup) + '</span>' : '') +
        (c.maxTime || c.minTime ? '<span class="tag">time=' + escapeHtml(c.minTime || '0') + '~' + escapeHtml(c.maxTime || '0') + '</span>' : '') +
        (c.commentId ? '<span class="tag">楼层=' + escapeHtml(c.commentId) + '</span>' : '') +
        (c.awemeId ? '<span class="tag">视频=' + escapeHtml(c.awemeId) + '</span>' : '') +
        '<div class="path">' + escapeHtml(c.url) + '</div>' +
        '<div class="sample">' + escapeHtml(preview) + '</div>' +
        '<details class="body"><summary>查看响应体（' + (c.body || '').length + ' 字符）</summary><pre>' + escapeHtml(c.body || '') + '</pre></details>';
      captureListEl.appendChild(div);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  async function loadNet() {
    try {
      const data = await chrome.runtime.sendMessage({ type: 'DY_NET_GET' });
      if (!data || !data.ok) throw new Error('读取失败，请重新加载扩展');
      document.getElementById('netToggle').textContent = data.enabled ? '暂停抓包' : '恢复抓包';
      setNetStatus('低频 ' + (data.active || []).length + ' 条 · 已过滤 ' + (data.filtered || []).length + ' 条 · 捕获 ' + (data.captures || []).length + ' 条');
      renderUrls(data);
      renderCaptures(data);
    } catch (e) {
      setNetStatus(e && e.message || String(e), true);
    }
  }

  document.getElementById('netRefresh').addEventListener('click', loadNet);
  document.getElementById('netToggle').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'DY_NET_TOGGLE' });
    loadNet();
  });
  document.getElementById('netClear').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'DY_NET_CLEAR' });
    loadNet();
  });
  document.getElementById('netExport').addEventListener('click', async () => {
    try {
      const data = await chrome.runtime.sendMessage({ type: 'DY_NET_GET' });
      const lines = [
        '# 低频 URL（高亮为疑似列表接口）',
        ...(data.active || []).map((r) =>
          [r.kind, r.path, 'count=' + r.count, ...(r.samples || [])].join('\t')),
        '',
        '# 已过滤（>5 次）',
        ...(data.filtered || []).map((r) =>
          [r.kind, r.path, 'count=' + r.count, ...(r.samples || [])].join('\t'))
      ];
      await navigator.clipboard.writeText(lines.join('\n'));
      setNetStatus('已复制 URL 列表到剪贴板');
    } catch (e) {
      setNetStatus('导出失败：' + (e && e.message || e), true);
    }
  });

  document.getElementById('netExportBody').addEventListener('click', async () => {
    try {
      const data = await chrome.runtime.sendMessage({ type: 'DY_NET_GET' });
      const caps = (data.captures || []).filter((c) =>
        ['comment', 'reply', 'comment-publish', 'comment-delete', 'comment-other',
         'notice-list', 'notice-count', 'im-message', 'im-conversation',
         'captcha-decision', 'captcha-send-code', 'captcha-validate',
         'nav-jump'].indexOf(c.kind) >= 0);
      if (!caps.length) {
        setNetStatus('暂无评论/回复响应可导出', true);
        return;
      }
      const payload = caps.map((c) => {
        let parsed = null;
        try { parsed = JSON.parse(c.body); } catch (_) { parsed = c.body; }
        return {
          ts: c.ts, kind: c.kind, phase: c.phase, cursor: c.cursor,
          method: c.method || 'GET', status: c.status || 0,
          reqBody: c.reqBody || '',
          notice: !!c.notice, insertIds: c.insertIds || '',
          noticeGroup: c.noticeGroup || '',
          maxTime: c.maxTime || '', minTime: c.minTime || '',
          commentId: c.commentId || '', awemeId: c.awemeId || '',
          url: c.url, data: parsed
        };
      });
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = '抖音评论回复抓包_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNetStatus('已导出 ' + caps.length + ' 条响应');
    } catch (e) {
      setNetStatus('导出失败：' + (e && e.message || e), true);
    }
  });
})();
