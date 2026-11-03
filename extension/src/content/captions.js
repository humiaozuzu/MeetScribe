// 内容脚本（录制中的会议标签页，开了悬浮字幕时由 SW 注入）：页面底部的悬浮字幕条。
// 数据来自 offscreen → SW → chrome.tabs.sendMessage，和侧边栏开没开无关。
// - 有人说话才出现，没动静几秒后自动收起（由 offscreen 决定显示哪些行，见 lib/captions.js）。
// - 文字区域不拦截鼠标，下面的会议按钮照常能点；只有左侧把手和右侧按钮可点。
// - 拖把手移动位置，A− / A+ 调字号，× 关闭（等于在侧边栏关掉悬浮字幕）。位置和字号存在 chrome.storage.local。
// - 每路最多两行，超长时只保留结尾（最新的字）。
// 注意：内容脚本是普通脚本（不能 import），消息类型写字面量（对应 lib/messages.js 的 CAPTION / SW.SET_CAPTIONS）；
// 可能被重复注入，用全局标记防重。界面文字由 SW 按界面语言翻译好后随 cap:show 发来。

(() => {
  if (window.__meetscribeCaptions) return;
  window.__meetscribeCaptions = true;

  const STORE_KEY = 'captionBox';
  const FONT_MIN = 14;
  const FONT_MAX = 36;
  const FONT_DEFAULT = 20;

  let host = null;
  let root = null;
  let box = { x: 0.5, bottom: 96, fontSize: FONT_DEFAULT }; // x：中心点占视口宽度的比例；bottom：离底部的像素
  let labels = { drag: '', smaller: '', bigger: '', close: '' };
  let names = { me: 'Me', them: 'Others' };
  let lastRows = [];

  const CSS = `
    :host { all: initial; }
    .bar { position: fixed; z-index: 2147483647; transform: translateX(-50%); width: min(760px, calc(100vw - 32px));
      display: none; gap: 8px; align-items: stretch; pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans", "Segoe UI", "Microsoft YaHei", sans-serif; }
    .bar.show { display: flex; }
    .body { flex: 1; min-width: 0; background: rgb(20 22 26 / .82); color: #fff; border-radius: 10px; padding: 8px 14px;
      box-shadow: 0 4px 16px rgb(0 0 0 / .25); display: grid; gap: 4px; }
    .row { border-left: 3px solid #a5b4fc; padding-left: 8px; }
    .row.me { border-color: #5eead4; }
    .clip { display: flex; flex-direction: column; justify-content: flex-end; overflow: hidden; line-height: 1.35; }
    .text { max-height: calc(2 * 1.35em); }
    .tr { max-height: calc(2 * 1.35em); font-size: .8em; color: rgb(255 255 255 / .75); }
    .who { font-size: .65em; color: rgb(255 255 255 / .6); margin-right: 6px; }
    .pending { color: rgb(255 255 255 / .7); }
    .tools { display: flex; flex-direction: column; gap: 4px; pointer-events: auto; opacity: .35; transition: opacity .15s; }
    .tools:hover, .bar.dragging .tools { opacity: 1; }
    button { all: unset; cursor: pointer; width: 26px; height: 22px; border-radius: 6px; background: rgb(20 22 26 / .82); color: #fff;
      font: 12px/22px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-align: center; }
    button:hover { background: rgb(60 64 72 / .95); }
    .grip { cursor: grab; touch-action: none; }
    .bar.dragging .grip { cursor: grabbing; }
  `;

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function mount() {
    if (host?.isConnected) return;
    host = document.createElement('meetscribe-captions');
    root = host.attachShadow({ mode: 'closed' });
    const style = el('style');
    style.textContent = CSS;
    const bar = el('div', 'bar');
    const body = el('div', 'body');
    const tools = el('div', 'tools');
    const grip = el('button', 'grip', '⠿');
    const smaller = el('button', 'smaller', 'A−');
    const bigger = el('button', 'bigger', 'A+');
    const close = el('button', 'close', '×');
    tools.append(grip, smaller, bigger, close);
    bar.append(body, tools);
    root.append(style, bar);
    (document.body || document.documentElement).append(host);

    smaller.addEventListener('click', () => setFont(box.fontSize - 2));
    bigger.addEventListener('click', () => setFont(box.fontSize + 2));
    close.addEventListener('click', () => {
      unmount();
      try {
        chrome.runtime.sendMessage({ target: 'sw', type: 'sw:set-captions', enabled: false }).catch(() => {});
      } catch { /* 扩展已重新加载 */ }
    });
    grip.addEventListener('pointerdown', startDrag);
    applyLabels();
    applyBox();
    render(lastRows);
  }

  function unmount() {
    host?.remove();
    host = null;
    root = null;
  }

  function $(sel) {
    return root?.querySelector(sel);
  }

  function applyLabels() {
    if (!root) return;
    for (const [cls, key] of [['grip', 'drag'], ['smaller', 'smaller'], ['bigger', 'bigger'], ['close', 'close']]) {
      const b = $(`.${cls}`);
      if (b) { b.title = labels[key] || ''; b.setAttribute('aria-label', labels[key] || cls); }
    }
  }

  function applyBox() {
    const bar = $('.bar');
    if (!bar) return;
    // 整条都留在窗口里：中心点离左右边至少半个条宽（宽度和 CSS 的 min(760px, 100vw - 32px) 一致）
    const vw = document.documentElement.clientWidth || window.innerWidth;
    const half = Math.min(760, vw - 32) / 2;
    const center = Math.min(vw - half - 8, Math.max(half + 8, box.x * vw));
    const bottom = Math.min(window.innerHeight - 60, Math.max(0, box.bottom));
    bar.style.left = `${center}px`;
    bar.style.bottom = `${bottom}px`;
    bar.style.fontSize = `${box.fontSize}px`;
  }

  function saveBox() {
    try {
      chrome.storage.local.set({ [STORE_KEY]: box }).catch(() => {});
    } catch { /* 扩展已重新加载 */ }
  }

  function setFont(size) {
    box.fontSize = Math.min(FONT_MAX, Math.max(FONT_MIN, size));
    applyBox();
    saveBox();
  }

  function startDrag(ev) {
    const bar = $('.bar');
    if (!bar) return;
    ev.preventDefault();
    const grip = ev.currentTarget;
    grip.setPointerCapture(ev.pointerId);
    bar.classList.add('dragging');
    const start = { px: ev.clientX, py: ev.clientY, x: box.x, bottom: box.bottom };
    const move = (e) => {
      box.x = start.x + (e.clientX - start.px) / window.innerWidth;
      box.bottom = start.bottom - (e.clientY - start.py);
      applyBox();
    };
    const up = () => {
      bar.classList.remove('dragging');
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
      saveBox();
    };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up);
    grip.addEventListener('pointercancel', up);
  }

  function render(rows) {
    lastRows = rows || [];
    const bar = $('.bar');
    const body = $('.body');
    if (!bar || !body) return;
    body.replaceChildren(...lastRows.map((r) => {
      const row = el('div', `row ${r.source === 'me' ? 'me' : 'them'}`);
      const text = el('div', 'clip text');
      const line = el('div');
      line.append(el('span', 'who', r.source === 'me' ? names.me : names.them), r.text || '');
      if (r.pending) line.append(el('span', 'pending', `${r.text ? ' ' : ''}${r.pending}`));
      text.append(line);
      row.append(text);
      if (r.translation) {
        const tr = el('div', 'clip tr');
        tr.append(el('div', null, r.translation));
        row.append(tr);
      }
      return row;
    }));
    bar.classList.toggle('show', lastRows.length > 0);
  }

  try {
    chrome.storage.local.get(STORE_KEY).then((v) => {
      if (v?.[STORE_KEY]) box = { ...box, ...v[STORE_KEY] };
      applyBox();
    }).catch(() => {});
  } catch { /* 扩展已重新加载 */ }

  window.addEventListener('resize', applyBox);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'cap:show') {
      labels = { ...labels, ...(msg.labels || {}) };
      names = { me: msg.me || names.me, them: msg.them || names.them };
      mount();
      applyLabels();
    } else if (msg?.type === 'cap:rows') {
      // 点了 × 之后、offscreen 停发之前还会到几条，不要因此重新显示
      if (host) render(msg.rows);
    } else if (msg?.type === 'cap:hide') {
      lastRows = [];
      unmount();
    }
    return false;
  });
})();
