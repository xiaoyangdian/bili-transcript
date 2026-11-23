#!/usr/bin/env python3
"""生成一个单文件 HTML 可视化，内嵌楼层导出 JSON 数据。

用法：
    python scripts/build_visualizer.py [导出.json] [输出.html]

不传参数时，自动取工作区最新的楼层导出 JSON，输出到 抖音楼层对话可视化.html。
生成的 HTML 双击即可打开，也可在页面里选择其他 JSON 文件加载。
"""

import json
import sys
from pathlib import Path

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:
    pass


def find_latest_export(root: Path):
    cands = []
    for p in root.glob("*.json"):
        try:
            head = p.read_text(encoding="utf-8", errors="ignore")[:2000]
        except Exception:
            continue
        if '"floor"' in head and '"replies"' in head:
            cands.append(p)
    return max(cands, key=lambda p: p.stat().st_mtime) if cands else None


HTML = r'''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>抖音楼层对话可视化</title>
<style>
  :root {
    --bg: #f3f4f6; --card: #fff; --ink: #1f2937; --muted: #6b7280;
    --line: #e5e7eb; --me: #2563eb; --me-bg: #eff6ff;
    --host: #dc2626; --host-bg: #fef2f2; --other-bg: #f9fafb;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .app { max-width: 980px; margin: 0 auto; padding: 20px; }
  header h1 { font-size: 20px; margin: 0 0 8px; }
  .stats { color: var(--muted); font-size: 13px; margin-bottom: 14px; }
  .stats b { color: var(--ink); }
  .toolbar { display: flex; gap: 10px; flex-wrap: wrap; align-items: center;
    background: var(--card); border: 1px solid var(--line); border-radius: 10px;
    padding: 12px; margin-bottom: 16px; position: sticky; top: 0; z-index: 5; }
  .toolbar input[type=text] { flex: 1; min-width: 220px; padding: 8px 10px;
    border: 1px solid var(--line); border-radius: 6px; font-size: 14px; }
  .toolbar input[type=file] { font-size: 12px; max-width: 260px; }
  button { padding: 8px 12px; border: 1px solid var(--line); background: #fff;
    border-radius: 6px; cursor: pointer; font-size: 13px; }
  button:hover { background: #f3f4f6; }
  .hint { font-size: 12px; color: var(--muted); width: 100%; }
  .hidden-note { font-size: 12px; color: var(--host); }
  .picker { position: relative; }
  .picker-panel { display: none; position: absolute; top: 40px; left: 0; z-index: 10;
    background: #fff; border: 1px solid var(--line); border-radius: 8px;
    box-shadow: 0 6px 20px rgba(0,0,0,.12); min-width: 220px; max-height: 340px; overflow: auto; padding: 6px; }
  .picker-panel.open { display: block; }
  .picker-panel label { display: flex; align-items: center; gap: 6px; padding: 5px 8px;
    border-radius: 5px; cursor: pointer; font-size: 13px; white-space: nowrap; }
  .picker-panel label:hover { background: #f3f4f6; }
  .picker-panel .cnt { margin-left: auto; color: var(--muted); font-size: 11px; }
  .picker-legend { font-size: 10px; color: var(--muted); padding: 2px 8px 5px; }
  .picker-panel .opt-line { border-bottom: 1px solid var(--line); margin-bottom: 4px; font-size: 12px; }
  .picker-panel .last { font-size: 10px; padding: 0 4px; border-radius: 3px; }
  .picker-panel .last.ta { background: #fef2f2; color: var(--host); }
  .picker-panel .last.me { background: #eff6ff; color: var(--me); }
  .picker-head { display: flex; justify-content: space-between; align-items: center;
    padding: 4px 8px 6px; border-bottom: 1px solid var(--line); margin-bottom: 4px; font-size: 12px; }
  .picker-head button { padding: 2px 8px; font-size: 11px; }
  .msg { background: var(--card); border: 1px solid var(--line); border-left: 4px solid var(--line);
    border-radius: 8px; padding: 12px 14px; margin-bottom: 10px; }
  .msg.floor { border-left-color: var(--host); background: var(--host-bg); }
  .msg.mine { border-left-color: var(--me); background: var(--me-bg); }
  .msg-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; margin-bottom: 6px; }
  .who { font-weight: 700; }
  .floor .who { color: var(--host); }
  .mine .who { color: var(--me); }
  .tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #eef2ff; color: #4338ca; }
  .tag.to-me { background: #dbeafe; color: #1e40af; }
  .time { color: var(--muted); font-size: 12px; }
  .ip { color: var(--muted); font-size: 11px; background: #f3f4f6; padding: 1px 6px; border-radius: 4px; }
  .idx { color: var(--muted); font-size: 11px; margin-left: auto; }
  .text { white-space: pre-wrap; line-height: 1.7; font-size: 14px; }
  .empty { text-align: center; color: var(--muted); padding: 40px; }
</style>
</head>
<body>
<div class="app">
  <header>
    <h1>抖音楼层对话可视化</h1>
    <div class="stats" id="stats"></div>
  </header>
  <div class="toolbar">
    <div class="picker">
      <button type="button" id="pickerBtn">隐藏的人（0）▾</button>
      <div class="picker-panel" id="pickerPanel"></div>
    </div>
    <button id="clear">清空</button>
    <button id="hideMe">隐藏 [me] 的人</button>
    <button id="export">导出当前显示</button>
    <input type="file" id="file" accept=".json">
    <div class="hint">点「隐藏的人」下拉勾选人名：选中某人 = 同时隐藏「我发给TA」和「TA发给我」的消息。默认内嵌最新导出数据；可点右侧按钮换其他 JSON。</div>
    <div class="hidden-note" id="hiddenNote"></div>
  </div>
  <main id="list"></main>
</div>

<script id="embedded" type="application/json">__DATA__</script>
<script>
var DATA = JSON.parse(document.getElementById('embedded').textContent);
var me = (DATA.floor && DATA.floor.author || '').trim();
var hideSelfEmpty = true; // 过滤「我发给自己楼层、replyTo 为空」的空回复

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,function(c){
  return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); }

// 把页面展示文本「23小时前 · 广东」拆成 time 与 ip 两个字段
function splitTimeIp(s){
  var raw = String(s==null?'':'').trim();
  var m = raw.match(/^(.*?)\s*[·•]\s*(.+)$/);
  if (m) return { time: m[1].trim(), ip: m[2].trim() };
  return { time: raw, ip: '' };
}

function getHide(){
  return Array.prototype.slice.call(document.querySelectorAll('#pickerPanel input[data-name]:checked'))
    .map(function(cb){ return cb.getAttribute('data-name'); });
}

// 每个人最后一次互动是谁发的：me / ta
function computeLast(){
  var last = {};
  (DATA.replies || []).forEach(function(r){
    var a = (r.author||'').trim(), t = (r.replyTo||'').trim();
    if (a && a !== me) last[a] = 'ta';
    if (t && t !== me) last[t] = 'me';
  });
  return last;
}

function buildPicker(){
  var counts = {};
  (DATA.replies || []).forEach(function(r){
    var a = (r.author||'').trim(), t = (r.replyTo||'').trim();
    if (a && a !== me) counts[a] = (counts[a]||0) + 1;
    if (t && t !== me) counts[t] = (counts[t]||0) + 1;
  });
  var last = computeLast();
  var names = Object.keys(counts).sort();
  var html = '<div class="picker-head"><label><input type="checkbox" id="pickAll"> 全选/全不选</label>' +
    '<span>' + names.length + ' 人</span></div>';
  html += '<div class="picker-legend">[ta] 对方最后发言 · [me] 我最后回复</div>';
  html += '<label class="opt-line"><input type="checkbox" id="optSelfEmpty"' +
    (hideSelfEmpty ? ' checked' : '') + '> 过滤我给自己的空回复（replyTo 为空且是我发的）</label>';
  names.forEach(function(n){
    var mark = last[n] === 'me'
      ? '<span class="last me">[me]</span>'
      : '<span class="last ta">[ta]</span>';
    html += '<label><input type="checkbox" data-name="' + esc(n) + '"> ' + esc(n) +
      ' ' + mark + ' <span class="cnt">' + counts[n] + '</span></label>';
  });
  document.getElementById('pickerPanel').innerHTML = html;
  document.getElementById('pickerBtn').textContent = '隐藏的人（' + getHide().length + '）▾';
}

function togglePanel(force){
  var p = document.getElementById('pickerPanel');
  if (typeof force === 'boolean') p.classList.toggle('open', force);
  else p.classList.toggle('open');
}

function render(){
  var hide = getHide();
  var all = DATA.replies || [];
  var kept = all.filter(function(r){
    var a = (r.author||'').trim(), t = (r.replyTo||'').trim();
    if (hideSelfEmpty && a === me && t === '') return false; // 我发给自己楼层、无指向的空回复
    return hide.indexOf(a) < 0 && hide.indexOf(t) < 0;
  });
  var hiddenCount = all.length - kept.length;

  document.getElementById('stats').innerHTML =
    '我：<b>' + esc(me) + '</b>　·　回复总数 <b>' + all.length + '</b>　·　显示 <b>' + kept.length +
    '</b>　·　已隐藏 <b>' + hiddenCount + '</b>';
  document.getElementById('hiddenNote').textContent = hide.length
    ? '当前隐藏：' + hide.join('、') : '';
  document.getElementById('pickerBtn').textContent = '隐藏的人（' + hide.length + '）▾';

  var floor = DATA.floor || {};
  var fi = splitTimeIp(floor.time);
  var html = '<div class="msg floor" data-role="floor" data-author="' + esc(floor.author||'') +
    '" data-time="' + esc(fi.time) + '" data-ip="' + esc(fi.ip) + '">' +
    '<div class="msg-head">' +
    '<span class="who">' + esc(floor.author||'') + '</span>' +
    '<span class="tag">层主 / 我</span>' +
    '<span class="time">' + esc(fi.time) + '</span>' +
    (fi.ip ? '<span class="ip">' + esc(fi.ip) + '</span>' : '') + '</div>' +
    '<div class="text">' + esc(floor.text||'') + '</div></div>';

  if (!kept.length){
    html += '<div class="empty">没有可显示的回复</div>';
  } else {
    kept.forEach(function(r, i){
      var isMine = (r.author||'').trim() === me;
      var to = (r.replyTo||'').trim();
      var toMe = (to === '' || to === me);
      var ri = splitTimeIp(r.time);
      html += '<div class="msg' + (isMine?' mine':'') + '" data-role="reply" data-author="' + esc(r.author||'') +
        '" data-replyto="' + esc(to) + '" data-time="' + esc(ri.time) + '" data-ip="' + esc(ri.ip) + '">' +
        '<div class="msg-head">' +
        '<span class="who">' + esc(r.author||'') + '</span>' +
        (isMine ? '<span class="tag">我</span>' : '') +
        '<span class="tag' + (toMe?' to-me':'') + '">' + (toMe ? '→ 层主/我' : '→ ' + esc(to)) + '</span>' +
        '<span class="time">' + esc(ri.time) + '</span>' +
        (ri.ip ? '<span class="ip">' + esc(ri.ip) + '</span>' : '') +
        '<span class="idx">#' + String(i+1).padStart(2,'0') + '</span></div>' +
        '<div class="text">' + esc(r.text||'') + '</div></div>';
    });
  }
  document.getElementById('list').innerHTML = html;
}

// 从当前显示的 DOM 读出结构（过滤后的所见即所得）
function readFromDom(){
  var floorEl = document.querySelector('#list .msg[data-role="floor"]');
  var floor = floorEl ? {
    author: floorEl.getAttribute('data-author') || '',
    time: floorEl.getAttribute('data-time') || '',
    ip: floorEl.getAttribute('data-ip') || '',
    text: floorEl.querySelector('.text') ? floorEl.querySelector('.text').textContent : ''
  } : { author:'', time:'', ip:'', text:'' };
  var replies = [];
  Array.prototype.slice.call(document.querySelectorAll('#list .msg[data-role="reply"]')).forEach(function(el){
    replies.push({
      author: el.getAttribute('data-author') || '',
      replyTo: el.getAttribute('data-replyto') || '',
      time: el.getAttribute('data-time') || '',
      ip: el.getAttribute('data-ip') || '',
      text: el.querySelector('.text') ? el.querySelector('.text').textContent : ''
    });
  });
  return { floor: floor, replies: replies };
}

function downloadFile(name, content, mime){
  try {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
    return true;
  } catch(err){ return false; }
}

function doExport(){
  var d = readFromDom();
  var seed = (d.floor.author || '导出').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40);
  var stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g, '-');
  var mi = d.floor.ip ? (d.floor.time + ' · ' + d.floor.ip) : d.floor.time;
  var lines = ['【层主】' + d.floor.author + (mi ? '　' + mi : '') + (d.floor.text ? '\n' + d.floor.text : '')];
  d.replies.forEach(function(r, i){
    var rt = r.ip ? (r.time + ' · ' + r.ip) : r.time;
    lines.push('【回复' + String(i+1).padStart(2,'0') + '】' + r.author +
      (r.replyTo ? ' → ' + r.replyTo : '') + (rt ? '　' + rt : '') + (r.text ? '\n' + r.text : ''));
  });
  var payload = {
    desc: {
      floor: '楼层主评论（层主）',
      'floor.author': '层主昵称',
      'floor.time': '评论时间（已从展示文本拆出，不含 IP）',
      'floor.ip': '评论 IP 属地',
      'floor.text': '层主正文，多段落以换行分隔',
      replies: '该楼层下当前显示的回复列表，按展示顺序',
      'replies[].author': '回复者昵称',
      'replies[].replyTo': '被回复者昵称；为空字符串表示直接回复 floor（层主）',
      'replies[].time': '回复时间（已从展示文本拆出，不含 IP）',
      'replies[].ip': '回复 IP 属地',
      'replies[].text': '回复正文，多段落以换行分隔'
    },
    floor: d.floor,
    replies: d.replies
  };
  var ok1 = downloadFile(seed + '_' + stamp + '.txt', lines.join('\n\n'), 'text/plain;charset=utf-8');
  var ok2 = downloadFile(seed + '_' + stamp + '.json', JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
  alert(ok1 && ok2 ? '已导出当前显示的 ' + d.replies.length + ' 条回复（txt + json）' : '导出失败');
}

document.getElementById('export').addEventListener('click', doExport);
document.getElementById('pickerBtn').addEventListener('click', function(e){
  e.stopPropagation(); togglePanel();
});
document.getElementById('pickerPanel').addEventListener('click', function(e){ e.stopPropagation(); });
document.addEventListener('click', function(){ togglePanel(false); });
document.getElementById('pickerPanel').addEventListener('change', function(e){
  if (e.target.id === 'optSelfEmpty') {
    hideSelfEmpty = e.target.checked;
    render();
    return;
  }
  if (e.target.id === 'pickAll') {
    var on = e.target.checked;
    Array.prototype.slice.call(document.querySelectorAll('#pickerPanel input[data-name]'))
      .forEach(function(cb){ cb.checked = on; });
  }
  render();
});
document.getElementById('clear').addEventListener('click', function(){
  Array.prototype.slice.call(document.querySelectorAll('#pickerPanel input[data-name], #pickAll'))
    .forEach(function(cb){ cb.checked = false; });
  render();
});
document.getElementById('hideMe').addEventListener('click', function(){
  var last = computeLast();
  Array.prototype.slice.call(document.querySelectorAll('#pickerPanel input[data-name]')).forEach(function(cb){
    cb.checked = (last[cb.getAttribute('data-name')] === 'me');
  });
  var all = document.getElementById('pickAll');
  if (all) all.checked = false;
  render();
});
document.getElementById('file').addEventListener('change', function(e){
  var f = e.target.files[0]; if (!f) return;
  var rd = new FileReader();
  rd.onload = function(){
    try {
      DATA = JSON.parse(rd.result); me = (DATA.floor && DATA.floor.author || '').trim();
      buildPicker(); render();
    }
    catch(err){ alert('JSON 解析失败：' + err.message); }
  };
  rd.readAsText(f, 'utf-8');
});
buildPicker();
render();
</script>
</body>
</html>
'''


def main():
    root = Path(__file__).resolve().parent.parent
    src = Path(sys.argv[1]).expanduser().resolve() if len(sys.argv) > 1 else find_latest_export(root)
    if not src:
        print("没找到楼层导出 JSON，请传文件路径。")
        return
    out = Path(sys.argv[2]).expanduser().resolve() if len(sys.argv) > 2 else root / "抖音楼层对话可视化.html"
    data = json.loads(src.read_text(encoding="utf-8"))
    if "floor" not in data or "replies" not in data:
        raise ValueError("不是楼层导出 JSON（缺 floor / replies）")
    # 内嵌时转义 </script，避免破坏 HTML
    payload = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    out.write_text(HTML.replace("__DATA__", payload), encoding="utf-8")
    print(f"已生成：{out}")
    print(f"数据源：{src}（回复 {len(data.get('replies') or [])} 条）")


if __name__ == "__main__":
    main()
