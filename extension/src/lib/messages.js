// 扩展内部消息类型。
// 命令：发给 Service Worker（target 'sw'）或 offscreen（target 'offscreen'）。
// 广播：offscreen / SW 发出，侧边栏、历史页等监听。

export const SW = {
  START: 'sw:start',             // { tabId }
  STOP: 'sw:stop',
  GET_STATE: 'sw:get-state',
  SET_LANGUAGES: 'sw:set-languages', // { languageHints }：会议中修改语言
  CANCEL_AUTO_STOP: 'sw:cancel-auto-stop', // 离开会议后的自动停止倒计时中，用户选择继续录制
  SET_CAPTIONS: 'sw:set-captions', // { enabled }：开 / 关悬浮字幕（侧边栏、或字幕条上的 ×）；content/captions.js 里写的是字面量
};

export const OFFSCREEN = {
  START: 'offscreen:start',      // { meeting, streamId, settings }
  STOP: 'offscreen:stop',
  PING: 'offscreen:ping',
  GET_LIVE: 'offscreen:get-live', // 侧边栏打开时取当前状态
  SET_LANGUAGES: 'offscreen:set-languages', // { languageHints }
  SET_MIC_MUTED: 'offscreen:set-mic-muted', // { muted, signal }：会议里麦克风静音状态
  SET_CAPTIONS: 'offscreen:set-captions', // { enabled }：是否发出悬浮字幕
  NOTES_NOW: 'offscreen:notes-now',       // 立即更新一次纪要
  FINISH_NOTES: 'offscreen:finish-notes', // { meetingId }：会议结束后整理完整纪要（SW 等它做完再关 offscreen）
};

export const EVT = {
  SEGMENT: 'rt:segment',               // { meetingId, segment }
  SEGMENT_UPDATE: 'rt:segment-update', // { meetingId, segment }
  PARTIAL: 'rt:partial',               // { meetingId, source, speaker, speakerKey, finalText, pendingText }
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
  SPEAKERS: 'meeting:speakers',        // { meetingId }：说话人改名 / 合并了（页面 → 页面）
  NOTES: 'meeting:notes',              // { meetingId, state, error?, notes? }：AI 纪要更新 / 状态变化
  CAPTION: 'rt:caption',               // { meetingId, rows }：悬浮字幕内容（offscreen → SW，SW 转发给会议标签页）
  CAPTIONS_STATE: 'meeting:captions',  // { enabled }：悬浮字幕开关变了（SW → 页面）
};

// SW → 会议标签页里的 content/captions.js（chrome.tabs.sendMessage）。内容脚本不能 import，那边写的是字面量。
export const CAPTION = {
  SHOW: 'cap:show',  // { labels, me, them }
  ROWS: 'cap:rows',  // { rows: [{ source, text, pending, translation }] }
  HIDE: 'cap:hide',
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
