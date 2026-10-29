// 内容脚本（Meet / Teams 页面内）：判断"是否在通话中"，状态变化时报告给 Service Worker。
// 依据是挂断按钮是否存在——这类元素不随界面语言变化：
//   Meet：挂断按钮的图标文字 "call_end"，或按钮 jsname="CQylAd"
//   Teams：#hangup-button / data-tid 含 hangup 的按钮
// 页面改版导致检测失效时，最坏情况只是退回手动停止。
// 注意：内容脚本是普通脚本（不能 import），可能被重复注入，用全局标记防重。

(() => {
  if (window.__meetscribeWatch) return;
  window.__meetscribeWatch = true;

  const POLL_MS = 2000;
  const LEAVE_CONFIRM_POLLS = 2; // 连续 2 次（约 4 秒）检测不到才算离开，避免页面重绘时误判

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

  const timer = setInterval(tick, POLL_MS);
  tick();
})();
