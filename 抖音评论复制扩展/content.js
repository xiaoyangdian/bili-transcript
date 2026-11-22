(function () {
  'use strict';

  const ITEM = '[data-e2e="comment-item"]';
  const REPLY_BOX = '[class*="replyContainer"]';
  const NAME_LINK = '[data-click-from="title"]';
  const BTN_ATTR = 'data-dy-copy-btn';
  const EXPAND_RE = /(展开|查看|加载)(?:更多|全部|\d+)?\s*(条)?\s*(回复|评论)/;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const log = (...args) => console.log('[抖音评论复制]', ...args.map(
    (a) => (a && typeof a === 'object') ? JSON.stringify(a) : a
  ));

  function waitFor(fn, timeout, interval) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function tick() {
        if (fn()) resolve(true);
        else if (Date.now() - start > timeout) resolve(false);
        else setTimeout(tick, interval);
      })();
    });
  }

  function nodeText(node) {
    if (!node) return '';
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'img') {
      const alt = node.getAttribute('alt') || '[表情]';
      return ` ${alt} `;
    }
    let s = '';
    for (const child of node.childNodes) s += nodeText(child);
    if (/^(div|p|li)$/.test(tag) && s && !s.endsWith('\n')) s += '\n';
    return s;
  }

  function cleanText(s) {
    return s
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function findContentEl(item) {
    const known = item.querySelector('.FduGc_lz');
    if (known) return known;

    const timeEl = [...item.querySelectorAll('span,div')].find((el) => {
      if (el.querySelector(ITEM)) return false;
      const t = (el.textContent || '').trim();
      return /\d+\s*(分钟|小时|天|周|个月|年)前|刚刚|昨天|今天/.test(t) && t.length < 40;
    });
    if (timeEl && timeEl.previousElementSibling) return timeEl.previousElementSibling;

    const wrap = item.querySelector('.JPoP3Ezg') || item;
    let best = null;
    let bestLen = 0;
    for (const el of wrap.children) {
      if (el.matches('[class*="stats"]') || el.querySelector('[class*="stats"]')) continue;
      const len = cleanText(nodeText(el)).length;
      if (len > bestLen) { best = el; bestLen = len; }
    }
    return best || item;
  }

  function findTimeText(item) {
    const known = item.querySelector('.VAQA49VP');
    if (known) return cleanText(known.textContent);
    for (const el of item.querySelectorAll('span,div')) {
      if (el.querySelector(ITEM)) continue;
      const t = cleanText(el.textContent);
      if (t.length < 40 && /\d+\s*(分钟|小时|天|周|个月|年)前|刚刚|昨天|今天/.test(t)) return t;
    }
    return '';
  }

  function parseItem(item) {
    const nameEls = [...item.querySelectorAll(NAME_LINK)];
    const names = nameEls.map((el) => cleanText(nodeText(el)).replace(/\s+/g, '')).filter(Boolean);
    const author = names[0] || '未知用户';
    const target = names.length > 1 ? names[names.length - 1] : '';
    const content = cleanText(nodeText(findContentEl(item)));
    const time = findTimeText(item);
    return { author, target, content, time, isReply: !!item.closest(REPLY_BOX) };
  }

  function formatItem(info) {
    if (!info.content) return '';
    const who = info.isReply
      ? (info.target ? `↳ ${info.author} 回复 @${info.target}` : `↳ ${info.author}`)
      : info.author;
    const suffix = info.time ? `（${info.time}）` : '';
    return `${who}：${info.content}${suffix}`;
  }

  function collectGroups() {
    const groups = [];
    for (const item of document.querySelectorAll(ITEM)) {
      const box = item.closest(REPLY_BOX);
      if (box) {
        const g = groups[groups.length - 1];
        if (g) {
          g.replies.push(item);
          if (!g.box) g.box = box;
        }
      } else {
        groups.push({ top: item, replies: [] });
      }
    }
    return groups;
  }

  function isExpandCandidate(el) {
    if (el.querySelector('button,[role="button"]')) return false;
    const t = (el.textContent || '').trim();
    return EXPAND_RE.test(t) && t.length < 40;
  }

  function floorReplyBox(item) {
    const own = item.closest(REPLY_BOX);
    if (own) return own;
    const inner = item.querySelector(REPLY_BOX);
    if (inner) return inner;
    let sib = item.nextElementSibling;
    while (sib) {
      if (sib.matches(REPLY_BOX)) return sib;
      if (sib.matches(ITEM) && !sib.closest(REPLY_BOX)) break;
      sib = sib.nextElementSibling;
    }
    return null;
  }

  function findExpandButtonFor(item) {
    const box = floorReplyBox(item);
    if (box) {
      return [...box.querySelectorAll('button,[role="button"],div')].find(isExpandCandidate) || null;
    }

    const allItems = [...document.querySelectorAll(ITEM)];
    const idx = allItems.indexOf(item);
    if (idx < 0) return null;
    let end = null;
    for (let i = idx + 1; i < allItems.length; i++) {
      if (!allItems[i].closest(REPLY_BOX)) { end = allItems[i]; break; }
    }
    const candidates = [...document.querySelectorAll('button,[role="button"],div')]
      .filter(isExpandCandidate);
    return candidates.find((btn) => {
      const afterItem = item.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING;
      const beforeEnd = !end || (end.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_PRECEDING);
      return afterItem && beforeEnd;
    }) || null;
  }

  function floorListScope(btn, item) {
    let cur = btn.parentElement;
    while (cur && cur !== document.body && cur.querySelectorAll(ITEM).length === 0) {
      cur = cur.parentElement;
    }
    return cur || item.parentElement || item;
  }

  function fireClick(el) {
    let target = el;
    while (target.children.length === 1 && target.firstElementChild) {
      target = target.firstElementChild;
    }
    const base = { bubbles: true, cancelable: true, composed: true, view: window, button: 0 };
    const send = (type, extra) => {
      const Ctor = (/pointer/.test(type) && typeof PointerEvent !== 'undefined')
        ? PointerEvent : MouseEvent;
      try { target.dispatchEvent(new Ctor(type, { ...base, ...extra })); } catch (_) {}
    };
    send('pointerover');
    send('pointermove');
    send('pointerdown', { buttons: 1 });
    send('mousedown', { buttons: 1 });
    send('pointerup', { buttons: 0 });
    send('mouseup', { buttons: 0 });
    send('click', { buttons: 0 });
    return target;
  }

  async function expandFloor(item) {
    let clicks = 0;
    const start = Date.now();
    while (clicks < 8 && Date.now() - start < 30000) {
      const btn = findExpandButtonFor(item);
      if (!btn) {
        log('未找到展开按钮，停止', { total: document.querySelectorAll(ITEM).length });
        break;
      }
      const listScope = floorListScope(btn, item);
      const beforeTotal = document.querySelectorAll(ITEM).length;
      const beforeList = listScope.querySelectorAll(ITEM).length;
      log('准备点击展开', {
        buttonText: (btn.textContent || '').trim(),
        buttonTag: btn.tagName,
        buttonClass: btn.className || '',
        scopeClass: listScope.className || listScope.tagName,
        beforeTotal,
        beforeList
      });
      try { btn.scrollIntoView({ block: 'center' }); } catch (_) {}
      const target = fireClick(btn);
      clicks++;
      log('已派发展开点击', {
        clicks,
        targetTag: target.tagName,
        targetClass: target.className || ''
      });
      let progressed = false;
      for (let waited = 0; waited < 10000; waited += 500) {
        await sleep(500);
        const afterTotal = document.querySelectorAll(ITEM).length;
        const afterList = listScope.querySelectorAll(ITEM).length;
        const gone = !btn.isConnected || btn.getClientRects().length === 0
          || !isExpandCandidate(btn);
        const grown = afterTotal > beforeTotal || afterList > beforeList;
        if ((waited + 500) % 1000 === 0) {
          log('展开等待中', {
            waitedMs: waited + 500,
            afterTotal,
            afterList,
            gone,
            grown
          });
        }
        if (gone || grown) { progressed = true; break; }
      }
      const afterTotal = document.querySelectorAll(ITEM).length;
      const afterList = listScope.querySelectorAll(ITEM).length;
      log('展开等待结果', {
        progressed,
        afterTotal,
        afterList,
        deltaTotal: afterTotal - beforeTotal,
        deltaList: afterList - beforeList,
        buttonStillConnected: btn.isConnected,
        buttonTextNow: (btn.textContent || '').trim()
      });
      if (!progressed) break;
      await sleep(200);
    }
    return clicks;
  }

  function textForItem(item) {
    const groups = collectGroups();
    for (const g of groups) {
      if (g.top === item) {
        return [
          formatItem(parseItem(item)),
          ...g.replies.map((r) => formatItem(parseItem(r)))
        ].filter(Boolean).join('\n');
      }
    }
    return formatItem(parseItem(item));
  }

  function copyViaDom(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
    return ok;
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      try {
        const p = navigator.clipboard.writeText(text).then(() => true).catch(() => false);
        const ok = await Promise.race([p, sleep(1500).then(() => false)]);
        if (ok) return true;
      } catch (_) {}
    }
    return copyViaDom(text);
  }

  function flash(btn, ok) {
    const original = btn.dataset.originalText || btn.textContent;
    btn.dataset.originalText = original;
    btn.textContent = ok ? '已复制' : '失败';
    btn.style.color = ok ? '#3a8a54' : '#d83b4b';
    clearTimeout(btn._dyFlashTimer);
    btn._dyFlashTimer = setTimeout(() => {
      btn.textContent = original;
      btn.style.color = '';
      delete btn.dataset.originalText;
    }, 1200);
  }

  function injectButton(item) {
    if (item.querySelector(`[${BTN_ATTR}]`)) return;
    const header = item.querySelector('[class*="comment-item-info-wrap"]')
      || item.querySelector('.xRxUIIMP')
      || item;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(BTN_ATTR, '1');
    btn.textContent = '复制';
    btn.title = item.closest(REPLY_BOX)
      ? '复制这条回复'
      : '自动展开该楼全部回复后，复制整楼';
    btn.style.cssText = [
      'margin-left:8px',
      'padding:2px 8px',
      'border:1px solid rgba(254,44,85,.5)',
      'border-radius:10px',
      'background:rgba(254,44,85,.08)',
      'color:#fe2c55',
      'font-size:11px',
      'line-height:16px',
      'white-space:nowrap',
      'cursor:pointer',
      'vertical-align:middle'
    ].join(';');
    btn.addEventListener('mouseenter', () => {
      if (!btn.dataset.originalText) btn.style.background = 'rgba(254,44,85,.18)';
    });
    btn.addEventListener('mouseleave', () => {
      if (!btn.dataset.originalText) btn.style.background = 'rgba(254,44,85,.08)';
    });
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      log('点击复制按钮', {
        isReply: !!item.closest(REPLY_BOX),
        totalItems: document.querySelectorAll(ITEM).length
      });
      btn.dataset.originalText = '复制';
      if (!item.closest(REPLY_BOX)) {
        btn.textContent = '加载中…';
        try { await expandFloor(item); } catch (_) {}
      }
      btn.textContent = '复制中…';
      const text = textForItem(item);
      let ok = false;
      try { ok = text ? await copyText(text) : false; } catch (_) {}
      flash(btn, ok);
    });
    header.appendChild(btn);
  }

  function injectAll() {
    const items = document.querySelectorAll(ITEM);
    items.forEach(injectButton);
    return items.length;
  }

  let scheduled = false;
  function scheduleInject() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      injectAll();
    });
  }

  injectAll();
  const observer = new MutationObserver(scheduleInject);
  observer.observe(document.body || document.documentElement, {
    childList: true,
    subtree: true
  });

  chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
    if (!request) return false;
    if (request.type === 'DY_PING') {
      sendResponse({ ok: true });
      return false;
    }
    if (request.type === 'DY_REFRESH') {
      sendResponse({ ok: true, count: injectAll() });
      return false;
    }
    return false;
  });
})();
