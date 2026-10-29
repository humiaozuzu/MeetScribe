// 扩展内部消息类型。
// 命令：发给 Service Worker（target 'sw'）或 offscreen（target 'offscreen'）。
// 广播：offscreen / SW 发出，侧边栏、历史页等监听。

export const SW = {
  START: 'sw:start',             // { tabId }
  STOP: 'sw:stop',
  GET_STATE: 'sw:get-state',
  SET_LANGUAGES: 'sw:set-languages', // { languageHints }：会议中修改语言
  CANCEL_AUTO_STOP: 'sw:cancel-auto-stop', // 离开会议后的自动停止倒计时中，用户选择继续录制
};

export const OFFSCREEN = {
  START: 'offscreen:start',      // { meeting, streamId, settings }
  STOP: 'offscreen:stop',
  PING: 'offscreen:ping',
  GET_LIVE: 'offscreen:get-live', // 侧边栏打开时取当前状态
  SET_LANGUAGES: 'offscreen:set-languages', // { languageHints }
  SET_MIC_MUTED: 'offscreen:set-mic-muted', // { muted, signal }：会议里麦克风静音状态
};

export const EVT = {
  SEGMENT: 'rt:segment',               // { meetingId, segment }
  SEGMENT_UPDATE: 'rt:segment-update', // { meetingId, segment }
  PARTIAL: 'rt:partial',               // { meetingId, source, speaker, finalText, pendingText }
  STATUS: 'rt:status',                 // { meetingId, source, status, detail }
  LEVELS: 'rt:levels',                 // { meetingId, levels: { them, me } }
  TRACK_ENDED: 'rt:track-ended',       // { meetingId, source }（offscreen → SW）
  MEETING_STATE: 'meeting:state',      // { active }（SW → 页面）
  MEETING_ENDED: 'meeting:ended',      // { meetingId }
  LANGUAGES: 'rt:languages',           // { meetingId, languageHints }
  AUTO_STOP: 'meeting:auto-stop',      // { meetingId, pending, deadline }（SW → 页面）
  PRESENCE: 'cs:presence',             // { inCall, platform, signal, url }（内容脚本 → SW）
  MIC_STATE: 'cs:mic',                 // { muted: true|false|null, platform, signal }（内容脚本 → SW）
  MIC_MUTED: 'rt:mic-muted',           // { meetingId, muted }（offscreen → 页面）
};

// 转写状态
export const STATUS = {
  OFF: 'off',               // 没有 key / 未启用：仅录音
  CONNECTING: 'connecting',
  LIVE: 'live',
  RECONNECTING: 'reconnecting',
  PAUSED: 'paused',         // 会议里麦克风静音：暂停转写，录音继续
  FAILED: 'failed',         // 不可恢复（key 无效、欠费）：仅录音
  CLOSED: 'closed',
};

export function broadcast(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && p.catch) p.catch(() => { /* 没有页面在监听时忽略 */ });
  } catch { /* 上下文已失效 */ }
}
