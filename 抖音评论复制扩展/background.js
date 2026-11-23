(function () {
  'use strict';

  const MAX_COUNT = 5;
  const STORE_STATS = 'dy_net_stats_v1';
  const STORE_CAPTURES = 'dy_net_captures_v1';
  const CAPTURE_LIMIT = 300;

  const stats = new Map();
  const captures = [];
  let enabled = true;
  let saveTimer = null;

  function normKey(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname;
    } catch (_) {
      return String(url).split('?')[0];
    }
  }

  function guessKind(url) {
    const p = String(url).toLowerCase();
    if (/\/comment\/list\/reply|reply\/list|comment\/reply|getreply/.test(p)) return 'reply-list';
    if (/\/comment\/list/.test(p)) return 'comment-list';
    if (/comment/.test(p)) return 'comment-other';
    return 'other';
  }

  async function load() {
    try {
      const data = await chrome.storage.local.get([STORE_STATS, STORE_CAPTURES]);
      if (Array.isArray(data[STORE_STATS])) {
        for (const rec of data[STORE_STATS]) stats.set(rec.key, rec);
      }
      if (Array.isArray(data[STORE_CAPTURES])) {
        captures.push(...data[STORE_CAPTURES].slice(-CAPTURE_LIMIT));
      }
    } catch (_) {}
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      try {
        await chrome.storage.local.set({
          [STORE_STATS]: [...stats.values()],
          [STORE_CAPTURES]: captures.slice(-CAPTURE_LIMIT)
        });
      } catch (_) {}
    }, 1500);
  }

  chrome.webRequest.onBeforeRequest.addListener(function (details) {
    if (!enabled) return;
    if (details.tabId < 0) return;
    if (details.type !== 'xmlhttprequest') return;
    const url = details.url || '';
    if (!/douyin\.com/.test(url)) return;

    const key = normKey(url);
    let rec = stats.get(key);
    if (!rec) {
      let origin = '', path = key;
      try {
        const u = new URL(url);
        origin = u.origin;
        path = u.pathname;
      } catch (_) {}
      rec = {
        key, origin, path, kind: guessKind(url),
        count: 0, samples: [], excluded: false, last: 0
      };
      stats.set(key, rec);
    }
    rec.count += 1;
    rec.last = Date.now();
    if (rec.count > MAX_COUNT) {
      rec.excluded = true;
      rec.samples = [];
    } else if (rec.samples.length < 3) {
      rec.samples.push(url);
    }
    scheduleSave();
  }, { urls: ['<all_urls>'] });

  function listView() {
    const rows = [...stats.values()].sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
    return {
      ok: true,
      enabled,
      maxCount: MAX_COUNT,
      active: rows.filter((r) => !r.excluded),
      filtered: rows.filter((r) => r.excluded),
      captures: captures.slice(-CAPTURE_LIMIT)
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;

    if (msg.type === 'DY_NET_GET') {
      sendResponse(listView());
      return false;
    }
    if (msg.type === 'DY_NET_CLEAR') {
      stats.clear();
      captures.length = 0;
      chrome.storage.local.remove([STORE_STATS, STORE_CAPTURES]);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'DY_NET_TOGGLE') {
      enabled = typeof msg.enabled === 'boolean' ? msg.enabled : !enabled;
      sendResponse({ ok: true, enabled });
      return false;
    }
    if (msg.type === 'DY_NET_CAPTURE') {
      const p = msg.payload || {};
      if (p.url) {
        captures.push({
          ts: Date.now(),
          url: p.url,
          method: p.method || 'GET',
          status: p.status || 0,
          kind: p.kind || 'comment',
          phase: p.phase || 'initial',
          cursor: p.cursor || '0',
          commentId: p.commentId || '',
          awemeId: p.awemeId || '',
          notice: !!p.notice,
          insertIds: p.insertIds || '',
          maxTime: p.maxTime || '',
          minTime: p.minTime || '',
          noticeGroup: p.noticeGroup || '',
          body: typeof p.body === 'string' ? p.body.slice(0, 200000) : ''
        });
        if (captures.length > CAPTURE_LIMIT) captures.splice(0, captures.length - CAPTURE_LIMIT);
        scheduleSave();
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  load();
})();
