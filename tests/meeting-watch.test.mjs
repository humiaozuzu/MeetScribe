import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../extension/src/content/meeting-watch.js', import.meta.url), 'utf8');

// 用最小的假 DOM 运行内容脚本，手动推进轮询。
function run(hostname, dom) {
  const sent = [];
  let tick = null;
  const g = {
    window: {},
    location: { hostname, href: `https://${hostname}/abc` },
    document: {
      querySelector: (sel) => dom.query(sel),
      querySelectorAll: (sel) => dom.queryAll(sel),
    },
    chrome: { runtime: { sendMessage: (m) => { sent.push(m); return Promise.resolve(); } } },
    setInterval: (fn) => { tick = fn; return 1; },
    clearInterval: () => {},
  };
  new Function(...Object.keys(g), SRC)(...Object.values(g));
  return { sent, tick: () => tick() };
}

function meetDom() {
  const state = { inCall: false };
  const icon = { childElementCount: 0, textContent: ' call_end ' };
  return {
    state,
    query: () => null, // 不依赖 jsname，走图标文字
    queryAll: () => (state.inCall ? [{ childElementCount: 0, textContent: 'mic' }, icon] : []),
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
