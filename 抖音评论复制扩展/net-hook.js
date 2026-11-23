(function () {
  'use strict';

  // 在页面主世界运行，劫持 fetch / XHR，捕获评论/回复/通知接口的响应体。
  // 通过 window.postMessage 把数据交给 content.js，再转发给后台 worker。

  const CHANNEL = '__dy_net_capture__';

  function isTargetApi(url) {
    try {
      const u = new URL(url, location.href);
      if (!/douyin\.com/.test(u.hostname)) return false;
      const p = u.pathname.toLowerCase();
      if (/comment|reply/.test(p)) return true;
      if (/notice|notification/.test(p)) return true;
      if (/imapi\.douyin\.com/.test(u.hostname) && /\/v1\/(message|stranger)\//.test(p)) return true;
      return false;
    } catch (_) {
      return false;
    }
  }

  function classify(url) {
    let u;
    try { u = new URL(url, location.href); } catch (_) {
      return { kind: 'unknown', phase: 'unknown', cursor: '', commentId: '', awemeId: '', notice: false, insertIds: '', maxTime: '', minTime: '', noticeGroup: '' };
    }
    const p = u.pathname.toLowerCase();
    const cursor = u.searchParams.get('cursor') || '';
    // comment_id = 主评论（楼层）ID；item_id / aweme_id = 视频 ID
    const commentId = u.searchParams.get('comment_id') || '';
    const awemeId = u.searchParams.get('aweme_id') || u.searchParams.get('item_id') || '';
    // 通知进入：comment/list 带 insert_ids，把指定评论置顶
    const insertIds = u.searchParams.get('insert_ids') || '';
    const notice = !!insertIds && /comment\/list/.test(p);
    // 通知列表翻页游标
    const maxTime = u.searchParams.get('max_time') || '';
    const minTime = u.searchParams.get('min_time') || '';
    const noticeGroup = u.searchParams.get('notice_group') || '';

    // 路径精确区分接口类型
    let kind;
    if (/comment\/list\/reply/.test(p) || /reply/.test(p)) kind = 'reply';
    else if (/comment\/list/.test(p)) kind = 'comment';
    else if (/comment/.test(p)) kind = 'comment';
    else if (/notice\/count/.test(p)) kind = 'notice-count';
    else if (/notice|notification/.test(p)) kind = 'notice-list';
    else if (/\/v1\/message\//.test(p)) kind = 'im-message';
    else if (/\/v1\/stranger\//.test(p)) kind = 'im-conversation';
    else kind = 'unknown';

    // 初始/翻页：评论用 cursor，通知用 max_time/min_time
    let phase;
    if (kind === 'notice-list') {
      phase = (maxTime && maxTime !== '0') || (minTime && minTime !== '0') ? 'more' : 'initial';
    } else {
      phase = (!cursor || cursor === '0') ? 'initial' : 'more';
    }

    return { kind, phase, cursor, commentId, awemeId, notice, insertIds, maxTime, minTime, noticeGroup };
  }

  function emit(url, method, status, body) {
    if (!isTargetApi(url)) return;
    const meta = classify(url);
    try {
      window.postMessage({
        __dyNetCapture: {
          url, method: method || 'GET', status: status || 0,
          body: typeof body === 'string' ? body : '',
          ...meta
        }
      }, '*');
    } catch (_) {}
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string'
        ? input
        : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const promise = origFetch.apply(this, arguments);
      try {
        promise.then(function (res) {
          if (!res || typeof res.clone !== 'function') return;
          res.clone().text().then(function (text) {
            emit(url, method, res.status, text);
          }).catch(function () {});
        }).catch(function () {});
      } catch (_) {}
      return promise;
    };
  }

  // ---- XMLHttpRequest ----
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dyUrl = url;
    this.__dyMethod = method;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const self = this;
    this.addEventListener('load', function () {
      try {
        emit(self.__dyUrl || '', self.__dyMethod || 'GET', self.status, self.responseText);
      } catch (_) {}
    });
    return origSend.apply(this, arguments);
  };

  // ---- 面板请求桥：在页面主世界代发接口请求，复用页面登录态/签名环境 ----
  // 请求同样会被上面的 XHR 钩子捕获并存到后台，面板刷新即可拿到新数据。
  window.addEventListener('message', function (event) {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || !d.__dyNetFetchReq || !d.__dyNetFetchReq.url) return;
    const id = d.__dyNetFetchReq.id;
    console.log('[dy-hook] REQ got', id, d.__dyNetFetchReq.url.slice(0, 220));
    try {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', d.__dyNetFetchReq.url, true);
      xhr.withCredentials = true;
      xhr.onload = function () {
        console.log('[dy-hook] RES', id, 'status=' + xhr.status, 'len=' + (xhr.responseText || '').length,
          'head=' + (xhr.responseText || '').slice(0, 200));
        window.postMessage({
          __dyNetFetchRes: { id: id, ok: true, status: xhr.status, text: xhr.responseText }
        }, '*');
      };
      xhr.onerror = function () {
        console.log('[dy-hook] network error', id);
        window.postMessage({ __dyNetFetchRes: { id: id, ok: false, error: 'network' } }, '*');
      };
      xhr.send();
    } catch (err) {
      console.log('[dy-hook] exception', id, String(err));
      window.postMessage({ __dyNetFetchRes: { id: id, ok: false, error: String(err) } }, '*');
    }
  });

  void CHANNEL;
})();
