// 内容脚本（Meet / Teams 页面内）：判断"是否在通话中"，状态变化时报告给 Service Worker。
// 依据是挂断按钮是否存在——这类元素不随界面语言变化：
//   Meet：挂断按钮的图标文字 "call_end"，或按钮 jsname="CQylAd"
//   Teams：#hangup-button / data-tid 含 hangup 的按钮
// 页面改版导致检测失效时，最坏情况只是退回手动停止。
// 另外检测会议里麦克风是否静音（静音时暂停"我"这一路的转写）：
//   Meet：带 data-is-muted 的麦克风按钮（图标文字 mic / mic_off，或 aria-label 含"麦克风"等）
//   Teams：#microphone-button 的 data-state（mic / mic-off）
// 检测不到时报告 null，按未静音处理，照常转写。
// 注意：内容脚本是普通脚本（不能 import），可能被重复注入，用全局标记防重。

(() => {
  if (window.__meetscribeWatch) return;
  window.__meetscribeWatch = true;

  const POLL_MS = 2000;
  const LEAVE_CONFIRM_POLLS = 2; // 连续 2 次（约 4 秒）检测不到才算离开，避免页面重绘时误判
  const MIC_POLL_MS = 500;       // 静音要尽快生效，单独快速轮询（只查少量元素）
  const MIC_UNKNOWN_CONFIRM_POLLS = 4; // 按钮连续约 2 秒找不到才报告"未知"，避免重绘时抖动

  const host = location.hostname;
  const platform = host === 'meet.google.com' ? 'meet' : /teams\./.test(host) ? 'teams' : 'other';

  function detectMeet() {
    if (document.querySelector('[jsname="CQylAd"]')) return 'jsname-CQylAd';
    for (const n of document.querySelectorAll('button i, button span, button div')) {
      if (n.childElementCount === 0 && n.textContent.trim() === 'call_end') return 'icon-call_end';
    }
    return null;
  }

  function detectTeams() {
    const el = document.querySelector('#hangup-button, [data-tid="hangup-main-btn"], [data-tid="call-hangup"], button[data-tid*="hangup"], button[id*="hangup"]');
    return el ? (el.id ? `#${el.id}` : `data-tid=${el.getAttribute('data-tid')}`) : null;
  }

  const detect = platform === 'meet' ? detectMeet : platform === 'teams' ? detectTeams : () => null;

  const MEET_MIC_ICONS = new Set(['mic', 'mic_off', 'mic_none']);
  const MIC_LABEL = /microphone|\bmic\b|麦克风|麥克風|マイク|마이크|micr[oó]fono|mikrofon/i;

  function isMeetMicButton(b) {
    for (const n of b.querySelectorAll('i, span, div')) {
      if (n.childElementCount === 0 && MEET_MIC_ICONS.has(n.textContent.trim())) return true;
    }
    return MIC_LABEL.test(b.getAttribute('aria-label') || '') || MIC_LABEL.test(b.getAttribute('data-tooltip') || '');
  }

  // 返回 { muted, signal }；找不到按钮返回 null。
  function micMeet() {
    for (const b of document.querySelectorAll('[data-is-muted]')) {
      if (!isMeetMicButton(b)) continue;
      return { muted: b.getAttribute('data-is-muted') === 'true', signal: 'data-is-muted' };
    }
    return null;
  }

  function micTeams() {
    const b = document.querySelector('#microphone-button, [data-tid="microphone-button"]');
    const state = b?.getAttribute('data-state');
    if (!state) return null;
    return { muted: /off/i.test(state), signal: `data-state=${state}` };
  }

  const detectMic = platform === 'meet' ? micMeet : platform === 'teams' ? micTeams : () => null;

  let reported = null; // 最近一次上报的 inCall
  let missCount = 0;

  function report(inCall, signal) {
    reported = inCall;
    try {
      chrome.runtime.sendMessage({ type: 'cs:presence', inCall, platform, signal, url: location.href })
        .catch(() => {});
    } catch {
      // 扩展被重新加载后旧脚本失效，停止轮询
      clearInterval(timer);
      clearInterval(micTimer);
    }
  }

  function tick() {
    const signal = detect();
    if (signal) {
      missCount = 0;
      if (reported !== true) report(true, signal);
    } else if (reported !== false) {
      missCount++;
      if (reported === null || missCount >= LEAVE_CONFIRM_POLLS) report(false, null);
    }
  }

  let micReported; // undefined = 还没报告过；之后为 true / false / null
  let micMissCount = 0;

  function reportMic(muted, signal) {
    micReported = muted;
    try {
      chrome.runtime.sendMessage({ type: 'cs:mic', muted, platform, signal })
        .catch(() => {});
    } catch {
      clearInterval(timer);
      clearInterval(micTimer);
    }
  }

  function micTick() {
    const r = detectMic();
    if (r) {
      micMissCount = 0;
      if (r.muted !== micReported) reportMic(r.muted, r.signal);
    } else if (micReported !== null) {
      micMissCount++;
      if (micReported === undefined || micMissCount >= MIC_UNKNOWN_CONFIRM_POLLS) reportMic(null, null);
    }
  }

  const timer = setInterval(tick, POLL_MS);
  const micTimer = setInterval(micTick, MIC_POLL_MS);
  tick();
  micTick();
})();
