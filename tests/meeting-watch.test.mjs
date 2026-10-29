import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../extension/src/content/meeting-watch.js', import.meta.url), 'utf8');

// 用最小的假 DOM 运行内容脚本，手动推进轮询。
function run(hostname, dom) {
  const sent = [];
  const mic = [];
  const timers = new Map(); // 间隔 → 回调（在场轮询 2000ms，静音轮询 500ms）
  const g = {
    window: {},
    location: { hostname, href: `https://${hostname}/abc` },
    document: {
      querySelector: (sel) => dom.query(sel),
      querySelectorAll: (sel) => dom.queryAll(sel),
    },
    chrome: { runtime: { sendMessage: (m) => { (m.type === 'cs:mic' ? mic : sent).push(m); return Promise.resolve(); } } },
    setInterval: (fn, ms) => { timers.set(ms, fn); return ms; },
    clearInterval: () => {},
  };
  new Function(...Object.keys(g), SRC)(...Object.values(g));
  return {
    sent,
    mic,
    tick: () => timers.get(2000)(),
    micTick: () => timers.get(500)(),
  };
}

function meetDom() {
  const state = { inCall: false };
  const icon = { childElementCount: 0, textContent: ' call_end ' };
  return {
    state,
    query: () => null, // 不依赖 jsname，走图标文字
    queryAll: (sel) => (sel === '[data-is-muted]' ? [] : state.inCall ? [{ childElementCount: 0, textContent: 'mic' }, icon] : []),
  };
}

test('meet: reports in-call, then left only after two misses', () => {
  const dom = meetDom();
  const { sent, tick } = run('meet.google.com', dom);
  assert.deepEqual(sent.map((m) => m.inCall), [false], 'initial state reported immediately');
  dom.state.inCall = true;
  tick();
  assert.equal(sent.at(-1).inCall, true);
  assert.equal(sent.at(-1).signal, 'icon-call_end');
  dom.state.inCall = false;
  tick();
  assert.equal(sent.length, 2, 'one miss is not enough');
  tick();
  assert.equal(sent.length, 3);
  assert.equal(sent.at(-1).inCall, false);
  tick();
  assert.equal(sent.length, 3, 'no duplicate reports');
});

test('meet: brief flicker does not report leaving', () => {
  const dom = meetDom();
  dom.state.inCall = true;
  const { sent, tick } = run('meet.google.com', dom);
  dom.state.inCall = false;
  tick();
  dom.state.inCall = true;
  tick();
  assert.deepEqual(sent.map((m) => m.inCall), [true]);
});

test('teams: hangup button detected', () => {
  const dom = { query: (sel) => (sel.includes('#hangup-button') ? { id: 'hangup-button', getAttribute: () => null } : null), queryAll: () => [] };
  const { sent } = run('teams.microsoft.com', dom);
  assert.deepEqual(sent[0], { type: 'cs:presence', inCall: true, platform: 'teams', signal: '#hangup-button', url: 'https://teams.microsoft.com/abc' });
});

// Meet 工具栏里摄像头和麦克风按钮都有 data-is-muted，靠图标 / aria-label 区分。
function meetButton({ icon, label, muted }) {
  return {
    getAttribute: (k) => ({ 'data-is-muted': String(muted), 'aria-label': label || null }[k] ?? null),
    querySelectorAll: () => (icon ? [{ childElementCount: 0, textContent: icon }] : []),
  };
}

function meetMicDom(buttons) {
  return { query: () => null, queryAll: (sel) => (sel === '[data-is-muted]' ? buttons() : []) };
}

test('meet mic: mute state from data-is-muted on the mic button, camera ignored', () => {
  let muted = false;
  const cam = meetButton({ icon: 'videocam_off', muted: true });
  const { mic, micTick } = run('meet.google.com', meetMicDom(() => [cam, meetButton({ icon: muted ? 'mic_off' : 'mic', muted })]));
  assert.deepEqual(mic, [{ type: 'cs:mic', muted: false, platform: 'meet', signal: 'data-is-muted' }]);
  micTick();
  assert.equal(mic.length, 1, 'no duplicate reports');
  muted = true;
  micTick();
  assert.equal(mic.at(-1).muted, true);
});

test('meet mic: falls back to aria-label when no icon text', () => {
  const { mic } = run('meet.google.com', meetMicDom(() => [meetButton({ label: '关闭麦克风 (⌘ + d)', muted: false })]));
  assert.equal(mic[0].muted, false);
});

test('meet mic: button missing briefly is not reported, long absence reports unknown', () => {
  let present = true;
  const { mic, micTick } = run('meet.google.com', meetMicDom(() => (present ? [meetButton({ icon: 'mic_off', muted: true })] : [])));
  assert.equal(mic.at(-1).muted, true);
  present = false;
  micTick(); micTick(); micTick();
  assert.equal(mic.length, 1, 'redraw flicker ignored');
  micTick();
  assert.equal(mic.at(-1).muted, null);
});

test('teams mic: data-state on microphone button', () => {
  let state = 'mic-off';
  const dom = { query: (sel) => (sel.includes('#microphone-button') ? { getAttribute: (k) => (k === 'data-state' ? state : null) } : null), queryAll: () => [] };
  const { mic, micTick } = run('teams.microsoft.com', dom);
  assert.deepEqual(mic[0], { type: 'cs:mic', muted: true, platform: 'teams', signal: 'data-state=mic-off' });
  state = 'mic';
  micTick();
  assert.equal(mic.at(-1).muted, false);
});
