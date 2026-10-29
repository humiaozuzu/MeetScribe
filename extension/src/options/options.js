import { $, el, permissionState } from '../ui/common.js';
import { getSettings, saveSettings, redactSettings } from '../lib/settings.js';
import { validateKey } from '../lib/soniox-async.js';
import { createLogger, installGlobalErrorHandlers } from '../lib/log.js';
import { exportLogs } from '../lib/exporter.js';
import { clearLogs } from '../lib/db.js';
import { formatBytes } from '../lib/format.js';

const log = createLogger('options');
installGlobalErrorHandlers(log);

let toastTimer;
function toast(text, cls = 'info') {
  const t = $('#toast');
  t.className = `notice ${cls}`;
  t.textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2500);
}

const splitList = (s, sep) => s.split(sep).map((x) => x.trim()).filter(Boolean);

async function load() {
  const s = await getSettings();
  $('#key').value = s.sonioxApiKey;
  $('#langs').value = s.languageHints.join(', ');
  $('#terms').value = s.contextTerms.join('\n');
  $('#diar').checked = s.enableDiarization;
  $('#tr').value = s.translationTarget;
  $('#endpoint').value = s.maxEndpointDelayMs;
  $('#recMic').checked = s.recordMic;
  $('#micNs').checked = s.micNoiseSuppression;
  $('#autoExport').checked = s.autoExport;
  $('#autoStop').checked = s.autoStopOnLeave;
  $('#autoStopDelay').value = s.autoStopDelaySec;
  $('#logLevel').value = s.logLevel;
  await refreshMic(s.micDeviceId);
  const est = await navigator.storage.estimate().catch(() => null);
  if (est) $('#storage').textContent = `本地占用 ${formatBytes(est.usage)}`;
}

async function save(patch, label = '已保存') {
  const next = await saveSettings(patch);
  log.info('settings saved', { changed: Object.keys(patch), settings: redactSettings(next) });
  toast(label);
}

$('#key').addEventListener('change', () => save({ sonioxApiKey: $('#key').value.trim() }));
$('#langs').addEventListener('change', () => save({ languageHints: splitList($('#langs').value, /[,，\s]+/) }));
$('#terms').addEventListener('change', () => save({ contextTerms: splitList($('#terms').value, /\n/) }));
$('#diar').addEventListener('change', () => save({ enableDiarization: $('#diar').checked }));
$('#tr').addEventListener('change', () => save({ translationTarget: $('#tr').value }));
$('#endpoint').addEventListener('change', () => {
  const v = Math.min(3000, Math.max(500, Number($('#endpoint').value) || 1000));
  $('#endpoint').value = v;
  save({ maxEndpointDelayMs: v });
});
$('#recMic').addEventListener('change', () => save({ recordMic: $('#recMic').checked }));
$('#micNs').addEventListener('change', () => save({ micNoiseSuppression: $('#micNs').checked }));
$('#micDevice').addEventListener('change', () => save({ micDeviceId: $('#micDevice').value }));
$('#autoStop').addEventListener('change', () => save({ autoStopOnLeave: $('#autoStop').checked }));
$('#autoStopDelay').addEventListener('change', () => {
  const v = Math.min(120, Math.max(3, Number($('#autoStopDelay').value) || 10));
  $('#autoStopDelay').value = v;
  save({ autoStopDelaySec: v });
});
$('#autoExport').addEventListener('change', () => save({ autoExport: $('#autoExport').checked }));
$('#logLevel').addEventListener('change', () => save({ logLevel: $('#logLevel').value }));

$('#toggleKey').addEventListener('click', () => {
  const k = $('#key');
  k.type = k.type === 'password' ? 'text' : 'password';
  $('#toggleKey').textContent = k.type === 'password' ? '显示' : '隐藏';
});

$('#testKey').addEventListener('click', async () => {
  const key = $('#key').value.trim();
  const out = $('#keyResult');
  if (!key) { out.textContent = '请先填写 key'; return; }
  await save({ sonioxApiKey: key });
  out.textContent = '测试中…';
  try {
    await validateKey(key);
    out.textContent = '✓ key 有效';
    out.style.color = 'var(--ok)';
    log.info('api key test ok');
  } catch (e) {
    out.textContent = `✗ ${e.status === 401 ? 'key 无效' : e.message}`;
    out.style.color = 'var(--danger)';
    log.warn('api key test failed', { status: e.status, message: e.message });
  }
});

// ---------- 麦克风 ----------

async function refreshMic(selectedId) {
  const state = await permissionState('microphone');
  const chip = $('#micState');
  chip.className = `chip ${state === 'granted' ? 'ok' : 'warn'}`;
  chip.textContent = { granted: '已授权', denied: '已拒绝（请在浏览器设置里允许）', prompt: '未授权' }[state] || state;
  $('#grantMic').classList.toggle('hidden', state === 'granted');
  if (state !== 'granted') return;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const sel = $('#micDevice');
  const cur = selectedId ?? sel.value;
  sel.replaceChildren(el('option', { value: '', text: '系统默认' }),
    ...devices.filter((d) => d.deviceId !== 'default').map((d) => el('option', { value: d.deviceId, text: d.label || d.deviceId })));
  sel.value = devices.some((d) => d.deviceId === cur) ? cur : '';
}

$('#grantMic').addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    log.info('microphone permission granted');
    toast('麦克风已授权');
  } catch (e) {
    log.warn('microphone permission failed', { name: e.name, message: e.message });
    toast(`授权失败：${e.name}`, 'err');
  }
  refreshMic();
});

// ---------- 其它 ----------

$('#openHistory').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/history/history.html') }));

async function doExportLogs(fromTs, label) {
  try {
    const settings = await getSettings();
    await exportLogs({ fromTs, label, meta: { settings: redactSettings(settings) } });
    toast('日志已导出到 下载/meetscribe/logs/');
  } catch (e) {
    toast(`导出失败：${e.message}`, 'err');
  }
}
$('#logs24h').addEventListener('click', () => doExportLogs(Date.now() - 86400e3, '24h'));
$('#logsAll').addEventListener('click', () => doExportLogs(0, 'all'));
$('#logsClear').addEventListener('click', async () => {
  if (!confirm('清空所有日志？')) return;
  await clearLogs();
  toast('日志已清空');
});

load().catch((e) => log.error('options load failed', e));
