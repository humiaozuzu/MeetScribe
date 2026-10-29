import { $, el, sendToSw, permissionState } from '../ui/common.js';
import { SW, EVT } from '../lib/messages.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { langPicker } from '../ui/langs.js';
import { formatClock } from '../lib/format.js';
import { createLogger, installGlobalErrorHandlers } from '../lib/log.js';

const log = createLogger('popup');
installGlobalErrorHandlers(log);

const MEETING_HOSTS = /^(meet\.google\.com|teams\.microsoft\.com|teams\.live\.com|teams\.cloud\.microsoft)$/;
let timer = null;
let currentTab = null;
let selectedLangs = null; // 直接随开始命令发出，避免设置尚未写完就开始

function showError(msg) {
  const box = $('#error');
  box.textContent = msg;
  box.classList.toggle('hidden', !msg);
}

async function render() {
  const [{ active }, settings, [tab]] = await Promise.all([
    sendToSw(SW.GET_STATE),
    getSettings(),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  currentTab = tab;
  clearInterval(timer);
  $('#idle').classList.toggle('hidden', !!active);
  $('#recording').classList.toggle('hidden', !active);

  if (active) {
    $('#recTitle').textContent = active.title;
    const tick = () => { $('#timer').textContent = formatClock(Date.now() - active.startedAt); };
    tick();
    timer = setInterval(tick, 1000);
    const w = $('#recWarnings');
    w.replaceChildren();
    if (active.micError) w.append(el('div', { class: 'notice warn', text: `麦克风不可用，只录对方：${active.micError}` }));
    if (tab?.id !== active.tabId) w.append(el('div', { class: 'faint', text: '正在录制的是另一个标签页' }));
    return;
  }

  selectedLangs = settings.languageHints;
  $('#langs').replaceChildren(langPicker(settings.languageHints, (next) => {
    selectedLangs = next;
    saveSettings({ languageHints: next })
      .then(() => log.info('language hints changed before start', { languageHints: next }))
      .catch((e) => log.error('save language hints failed', e));
  }));

  $('#tabTitle').textContent = tab?.title || '';
  let host = '';
  try { host = new URL(tab?.url || '').hostname; } catch {}
  $('#tabUrl').textContent = host;

  const warnings = $('#warnings');
  warnings.replaceChildren();
  if (!MEETING_HOSTS.test(host)) {
    warnings.append(el('div', { class: 'notice info', text: '当前不是 Google Meet / Teams 页面，也可以录制，但请确认标签页正确。' }));
  }
  if (!settings.sonioxApiKey) {
    warnings.append(el('div', { class: 'notice warn' }, '未填写 Soniox key，将只录音不转写。',
      el('button', { class: 'link', text: '去设置', onclick: () => chrome.runtime.openOptionsPage() })));
  }
  if (settings.recordMic && (await permissionState('microphone')) !== 'granted') {
    warnings.append(el('div', { class: 'notice warn' }, '麦克风未授权，只能录到对方。',
      el('button', { class: 'link', text: '去授权', onclick: () => chrome.runtime.openOptionsPage() })));
  }
  const canCapture = tab?.url && !/^(chrome|edge|about|chrome-extension):/.test(tab.url);
  $('#start').disabled = !canCapture;
  if (!canCapture) warnings.append(el('div', { class: 'notice err', text: '浏览器内置页面无法录制。' }));
}

$('#start').addEventListener('click', async () => {
  showError('');
  const tab = currentTab;
  if (!tab) return;
  // sidePanel.open 必须在用户手势内同步调用，不能放在任何 await 之后
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => log.warn('sidePanel.open failed', e));
  $('#start').disabled = true;
  $('#start').textContent = '正在开始…';
  try {
    const res = await sendToSw(SW.START, { tabId: tab.id, languageHints: selectedLangs });
    if (!res?.ok) throw new Error(res?.error || '开始失败');
    log.info('started from popup', { meetingId: res.meetingId });
    await render();
  } catch (e) {
    log.error('start from popup failed', e);
    showError(`开始失败：${e.message}`);
    $('#start').disabled = false;
  } finally {
    $('#start').textContent = '开始录音转写';
  }
});

$('#stop').addEventListener('click', async () => {
  $('#stop').disabled = true;
  $('#stop').textContent = '正在停止…';
  try {
    const res = await sendToSw(SW.STOP);
    if (!res?.ok) throw new Error(res?.error || '停止失败');
    await render();
  } catch (e) {
    log.error('stop from popup failed', e);
    showError(`停止失败：${e.message}`);
  } finally {
    $('#stop').disabled = false;
    $('#stop').textContent = '停止';
  }
});

$('#openPanel').addEventListener('click', () => {
  if (currentTab) chrome.sidePanel.open({ windowId: currentTab.windowId }).catch((e) => showError(e.message));
});

$('#history').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('src/history/history.html') }));
$('#options').addEventListener('click', () => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === EVT.MEETING_STATE) render();
  return false;
});

render().catch((e) => { log.error('popup render failed', e); showError(e.message); });
