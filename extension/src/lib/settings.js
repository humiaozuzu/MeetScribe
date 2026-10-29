// 设置存 chrome.storage.local（只有本扩展可读，未加密）。

export const DEFAULT_SETTINGS = {
  sonioxApiKey: '',
  languageHints: ['zh', 'ja', 'en'], // 整场会议共用；弹窗 / 侧边栏里改动会写回这里，作为下一场的默认
  contextTerms: [],
  enableDiarization: true,
  translationTarget: '',         // '' = 不翻译；否则如 'zh' / 'en'
  maxEndpointDelayMs: 1000,      // Soniox 允许 500–3000；越小越容易切碎句子、准确率略降
  micDeviceId: '',               // '' = 系统默认
  micNoiseSuppression: false,    // 浏览器降噪会损伤语音细节，默认关；回声消除始终开启
  recordMic: true,
  autoStopOnLeave: true,         // 检测到离开 Meet / Teams 通话后自动停止
  autoStopDelaySec: 10,
  autoExport: false,             // 会议结束后自动导出到 下载/meetscribe/
  logLevel: 'info',              // 'debug' | 'info' | 'warn' | 'error'
  settingsVersion: 2,
};

export const SETTINGS_VERSION = 2;

// 已保存设置的升级（纯函数，可单元测试）。
export function migrateSettings(saved) {
  const s = { ...saved };
  // v2：断句等待默认值 500 → 1000。只改仍是旧默认值的，用户自己调过的保留。
  if ((s.settingsVersion || 1) < 2 && s.maxEndpointDelayMs === 500) s.maxEndpointDelayMs = 1000;
  s.settingsVersion = SETTINGS_VERSION;
  return s;
}

export async function getSettings() {
  let { settings } = await chrome.storage.local.get('settings');
  if (settings && (settings.settingsVersion || 1) < SETTINGS_VERSION) {
    settings = migrateSettings(settings);
    await chrome.storage.local.set({ settings });
  }
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
