(function () {
  'use strict';

  // 在页面主世界运行：拦截 video.play()，并持续暂停页面中的视频。
  // 通过 window.postMessage 接收 content.js 转发的开关指令。

  const MSG_SET = '__dyVideoSet';
  const STORE_KEY = '__dyVideoPaused';
  let paused = true; // 默认暂停

  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved !== null) paused = saved === '1';
  } catch (_) {}

  const origPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    if (paused) {
      try { this.pause(); } catch (_) {}
      return Promise.resolve();
    }
    return origPlay.apply(this, arguments);
  };

  function apply() {
    if (!paused) return;
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      try {
        v.autoplay = false;
        if (!v.paused) v.pause();
      } catch (_) {}
    }
  }

  const observer = new MutationObserver(apply);
  observer.observe(document, { childList: true, subtree: true });

  setInterval(apply, 300);

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!d || typeof d[MSG_SET] !== 'boolean') return;
    paused = d[MSG_SET];
    try { localStorage.setItem(STORE_KEY, paused ? '1' : '0'); } catch (_) {}
    apply();
  });

  document.addEventListener('DOMContentLoaded', apply);
  window.addEventListener('load', apply);
  apply();
})();
