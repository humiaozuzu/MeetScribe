import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveUiLang, formatString, translate, setUiLang, getUiLang, t, UI_LANGS, FALLBACK_LANG } from '../extension/src/lib/i18n.js';
import { STRINGS } from '../extension/src/lib/strings.js';
import { DEFAULT_SETTINGS } from '../extension/src/lib/settings.js';

test('resolveUiLang: explicit setting wins', () => {
  assert.equal(resolveUiLang('ja', ['en-US']), 'ja');
  assert.equal(resolveUiLang('en', []), 'en');
});

test('resolveUiLang: empty or unknown setting follows browser languages in order', () => {
  assert.equal(resolveUiLang('', ['ja-JP', 'en-US']), 'ja');
  assert.equal(resolveUiLang('', ['fr-FR', 'en-GB', 'zh-CN']), 'en');
  assert.equal(resolveUiLang('', ['zh-TW']), 'zh');
  assert.equal(resolveUiLang('ko', ['EN_us']), 'en');
});

test('resolveUiLang: falls back to zh', () => {
  assert.equal(resolveUiLang('', ['fr', 'de']), 'zh');
  assert.equal(resolveUiLang(undefined, undefined), 'zh');
  assert.equal(FALLBACK_LANG, 'zh');
  assert.equal(DEFAULT_SETTINGS.uiLanguage, '', 'default follows the browser');
});

test('formatString: replaces params and keeps unknown ones', () => {
  assert.equal(formatString('{a} / {b}', { a: 1, b: 'x' }), '1 / x');
  assert.equal(formatString('{a} {missing}', { a: 0 }), '0 {missing}');
  assert.equal(formatString('no params'), 'no params');
});

test('translate: current lang → zh → key', () => {
  const tables = { zh: { a: '甲', b: '乙 {n}' }, en: { a: 'A' } };
  assert.equal(translate(tables, 'en', 'a'), 'A');
  assert.equal(translate(tables, 'en', 'b', { n: 2 }), '乙 2');
  assert.equal(translate(tables, 'ja', 'a'), '甲');
  assert.equal(translate(tables, 'en', 'nope'), 'nope');
});

test('t: uses the language set with setUiLang', () => {
  setUiLang('en');
  assert.equal(getUiLang(), 'en');
  assert.equal(t('common.stop'), 'Stop');
  assert.equal(t('hist.gapsChip', { n: 3 }), 'Gaps: 3');
  setUiLang('xx');
  assert.equal(getUiLang(), 'zh');
  assert.equal(t('common.stop'), '停止');
});

const params = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('strings: every language has the same keys and placeholders as zh', () => {
  const base = STRINGS.zh;
  for (const lang of UI_LANGS) {
    const table = STRINGS[lang];
    assert.ok(table, `missing table ${lang}`);
    assert.deepEqual(Object.keys(table).sort(), Object.keys(base).sort(), `${lang} keys differ from zh`);
    for (const [k, v] of Object.entries(table)) {
      assert.equal(typeof v, 'string', `${lang}.${k}`);
      assert.ok(v.length, `${lang}.${k} is empty`);
      assert.deepEqual(params(v), params(base[k]), `${lang}.${k} placeholders differ from zh`);
    }
  }
});

test('strings: every key used in pages exists in zh', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const root = new URL('../extension/src/', import.meta.url);
  const files = (await readdir(root, { recursive: true })).filter((f) => /\.(html|js)$/.test(f));
  const used = new Set();
  for (const f of files) {
    const src = await readFile(new URL(f, root), 'utf8');
    for (const m of src.matchAll(/data-i18n(?:-placeholder|-title)?="([\w.]+)"/g)) used.add(m[1]);
    for (const m of src.matchAll(/\bt\('(\w+\.[\w.]+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/\['(status\.\w+)'/g)) used.add(m[1]);
  }
  assert.ok(used.size > 50, `only found ${used.size} keys`);
  const missing = [...used].filter((k) => !(k in STRINGS.zh));
  assert.deepEqual(missing, []);
});

test('manifest _locales: every __MSG_ key exists in en / zh_CN / ja, description ≤ 132 chars', async () => {
  const { readFile } = await import('node:fs/promises');
  const ext = new URL('../extension/', import.meta.url);
  const manifestText = await readFile(new URL('manifest.json', ext), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest.default_locale, 'en');
  const keys = [...new Set([...manifestText.matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]))];
  assert.ok(keys.length >= 2);
  for (const locale of ['en', 'zh_CN', 'ja']) {
    const messages = JSON.parse(await readFile(new URL(`_locales/${locale}/messages.json`, ext), 'utf8'));
    for (const k of keys) assert.ok(messages[k]?.message, `${locale} missing ${k}`);
    assert.ok(messages.extDescription.message.length <= 132, `${locale} description too long`);
  }
});
