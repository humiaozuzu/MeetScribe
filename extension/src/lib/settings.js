// 设置存 chrome.storage.local（只有本扩展可读，未加密）。

export const DEFAULT_SETTINGS = {
  sonioxApiKey: '',
  languageHints: ['zh', 'ja', 'en'], // 整场会议共用；弹窗 / 侧边栏里改动会写回这里，作为下一场的默认
  contextTerms: [],
  enableDiarization: true,
  translationTarget: '',         // '' = 不翻译；否则如 'zh' / 'en'
  maxEndpointDelayMs: 500,
  micDeviceId: '',               // '' = 系统默认
  recordMic: true,
  autoStopOnLeave: true,         // 检测到离开 Meet / Teams 通话后自动停止
  autoStopDelaySec: 10,
  autoExport: false,             // 会议结束后自动导出到 下载/meetscribe/
  logLevel: 'info',              // 'debug' | 'info' | 'warn' | 'error'
};

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

// 用于日志：去掉敏感字段。
export function redactSettings(s) {
  return { ...s, sonioxApiKey: maskKey(s.sonioxApiKey) };
}

export function maskKey(key) {
  if (!key) return '(empty)';
  return key.length <= 8 ? '***' : `${key.slice(0, 4)}…${key.slice(-4)} (len ${key.length})`;
}
