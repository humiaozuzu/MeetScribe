// 界面多语言（纯逻辑，可单元测试）。字符串表在 strings.js。
// 用法：页面启动时 setUiLang(resolveUiLang(settings.uiLanguage, navigator.languages))，之后 t('key', { 参数 })。

import { STRINGS } from './strings.js';

export const UI_LANGS = ['zh', 'ja', 'en'];
export const FALLBACK_LANG = 'zh';

// 设置下拉框里显示的名称，用各语言自己的写法，不翻译。
export const UI_LANG_NAMES = { zh: '中文', ja: '日本語', en: 'English' };

// <html lang> 的取值
export const HTML_LANG = { zh: 'zh-CN', ja: 'ja', en: 'en' };

// pref：设置里的 uiLanguage（'' = 跟随浏览器）；browserLangs：navigator.languages。
// 依次取：支持的 pref → 浏览器语言列表里第一个支持的（只看主语言，zh-TW 也算 zh）→ zh。
export function resolveUiLang(pref, browserLangs = []) {
  if (UI_LANGS.includes(pref)) return pref;
  for (const l of browserLangs || []) {
    const base = String(l).toLowerCase().split(/[-_]/)[0];
    if (UI_LANGS.includes(base)) return base;
  }
  return FALLBACK_LANG;
}

// 把 {name} 换成 params.name；缺的参数保留原样，方便发现漏传。
export function formatString(template, params) {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k) => (params[k] != null ? String(params[k]) : m));
}

// 查找顺序：当前语言 → zh → key 本身。
export function translate(tables, lang, key, params) {
  const s = tables[lang]?.[key] ?? tables[FALLBACK_LANG]?.[key] ?? key;
  return formatString(s, params);
}

let current = FALLBACK_LANG;

export function setUiLang(lang) {
  current = UI_LANGS.includes(lang) ? lang : FALLBACK_LANG;
}

export function getUiLang() {
  return current;
}

export function t(key, params) {
  return translate(STRINGS, current, key, params);
}
