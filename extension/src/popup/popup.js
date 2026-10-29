import { $, el, sendToSw, permissionState } from '../ui/common.js';
import { SW, EVT } from '../lib/messages.js';
import { getSettings, saveSettings } from '../lib/settings.js';
import { langPicker } from '../ui/langs.js';
import { formatClock } from '../lib/format.js';
import { createLogger, installGlobalErrorHandlers } from '../lib/log.js';
import { initI18n, t } from '../ui/i18n.js';

const log = createLogger('popup');
installGlobalErrorHandlers(log);
await initI18n(log);

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
    if (active.micError) w.append(el('div', { class: 'notice warn', text: t('common.micUnavailableThemOnly', { err: active.micError }) }));
    if (tab?.id !== active.tabId) w.append(el('div', { class: 'faint', text: t('popup.otherTab') }));
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
    warnings.append(el('div', { class: 'notice info', text: t('popup.notMeeting') }));
  }
  if (!settings.sonioxApiKey) {
    warnings.append(el('div', { class: 'notice warn' }, t('popup.noKey'),
      el('button', { class: 'link', text: t('popup.goSettings'), onclick: () => chrome.runtime.openOptionsPage() })));
  }
  if (settings.recordMic && (await permissionState('microphone')) !== 'granted') {
    warnings.append(el('div', { class: 'notice warn' }, t('popup.micNotGranted'),
      el('button', { class: 'link', text: t('popup.goGrant'), onclick: () => chrome.runtime.openOptionsPage() })));
  }
  const canCapture = tab?.url && !/^(chrome|edge|about|chrome-extension):/.test(tab.url);
  $('#start').disabled = !canCapture;
  if (!canCapture) warnings.append(el('div', { class: 'notice err', text: t('popup.cannotCapture') }));
}

$('#start').addEventListener('click', async () => {
  showError('');
  const tab = currentTab;
  if (!tab) return;
  // sidePanel.open 必须在用户手势内同步调用，不能放在任何 await 之后
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((e) => log.warn('sidePanel.open failed', e));
  $('#start').disabled = true;
  $('#start').textContent = t('popup.starting');
  try {
    const res = await sendToSw(SW.START, { tabId: tab.id, languageHints: selectedLangs });
    if (!res?.ok) throw new Error(res?.error || t('common.unknownError'));
    log.info('started from popup', { meetingId: res.meetingId });
    await render();
  } catch (e) {
    log.error('start from popup failed', e);
    showError(t('popup.startFailed', { msg: e.message }));
    $('#start').disabled = false;
  } finally {
    $('#start').textContent = t('popup.start');
  }
});

$('#stop').addEventListener('click', async () => {
  $('#stop').disabled = true;
  $('#stop').textContent = t('common.stopping');
  try {
    const res = await sendToSw(SW.STOP);
    if (!res?.ok) throw new Error(res?.error || t('common.unknownError'));
    await render();
  } catch (e) {
    log.error('stop from popup failed', e);
    showError(t('common.stopFailed', { msg: e.message }));
  } finally {
    $('#stop').disabled = false;
    $('#stop').textContent = t('common.stop');
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
