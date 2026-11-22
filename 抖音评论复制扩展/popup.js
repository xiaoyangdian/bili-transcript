(function () {
  'use strict';

  const statusEl = document.getElementById('status');
  const refreshBtn = document.getElementById('refresh');

  function setStatus(msg, isError) {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('error', !!isError);
  }

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
})();
