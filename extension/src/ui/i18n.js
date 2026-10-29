// 页面多语言：按设置选定界面语言，并翻译 HTML 里带 data-i18n* 属性的元素。
// HTML 里保留中文原文作为兜底；<html data-i18n-pending> 在翻译完成前隐藏页面，避免闪一下中文。

import { getSettings } from '../lib/settings.js';
import { resolveUiLang, setUiLang, getUiLang, t, HTML_LANG } from '../lib/i18n.js';

export { t };

// data-i18n → textContent，data-i18n-placeholder → placeholder，data-i18n-title → title
export function applyI18n(root = document) {
  for (const n of root.querySelectorAll('[data-i18n]')) n.textContent = t(n.dataset.i18n);
  for (const n of root.querySelectorAll('[data-i18n-placeholder]')) n.placeholder = t(n.dataset.i18nPlaceholder);
  for (const n of root.querySelectorAll('[data-i18n-title]')) n.title = t(n.dataset.i18nTitle);
}

// 每个页面启动时先 await 这个，再渲染动态内容。
export async function initI18n(log) {
  try {
    const { uiLanguage } = await getSettings();
    setUiLang(resolveUiLang(uiLanguage, navigator.languages));
    applyI18n();
  } catch (e) {
    log?.error('i18n init failed', e);
  } finally {
    document.documentElement.lang = HTML_LANG[getUiLang()];
    document.documentElement.removeAttribute('data-i18n-pending');
  }
  return getUiLang();
}
