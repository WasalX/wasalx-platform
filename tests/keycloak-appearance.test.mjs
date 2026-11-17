import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const root = new URL('../infra/docker/full/keycloak/themes/wasalx/login/', import.meta.url);
const properties = await readFile(new URL('theme.properties', root), 'utf8');
const script = await readFile(new URL(`resources/${properties.match(/^scripts=(.+)$/m)[1]}`, root), 'utf8');

test('sign-in cache versions match the exact deployed asset bytes', async () => {
  for (const path of properties.match(/(?:css\/wasalx|js\/appearance)\.[0-9a-f]{8}\.(?:css|js)/g)) {
    const bytes = await readFile(new URL(`resources/${path}`, root));
    assert.equal(path.split('.')[1], createHash('sha256').update(bytes).digest('hex').slice(0, 8));
  }
});

function page({ stored = {}, dark = false, denied = false, platform = false } = {}) {
  const events = {};
  const writes = [];
  const documentElement = { dataset: {}, classList: { toggle(name, on) { this[name] = on; } } };
  const label = { hidden: true };
  const select = { value: '', closest: () => label, addEventListener: (name, callback) => { events[name] = callback; } };
  const media = { matches: dark, addEventListener: (_, callback) => { events.media = callback; } };
  runInNewContext(script, {
    document: { documentElement, querySelectorAll: () => [], getElementById: id => id === 'wasalx-auth-theme' ? select : null, addEventListener: (name, callback) => { events[name] = callback; } },
    location: { pathname: `/identity/realms/${platform ? 'wasalx-platform' : 'wasalx'}/login-actions/authenticate` },
    matchMedia: () => media,
    localStorage: {
      getItem(key) { if (denied) throw Error('Unavailable'); return stored[key] ?? null; },
      setItem(key, value) { if (denied) throw Error('Unavailable'); writes.push([key, value]); stored[key] = value; },
    },
  });
  events.DOMContentLoaded();
  return { root: documentElement, label, select, media, events, writes, stored };
}

test('native sign-in appearance follows the system until explicitly changed, and persists only the choice', () => {
  const view = page({ dark: true });
  assert.equal(view.root.classList['pf-v5-theme-dark'], true);
  assert.equal(view.select.value, 'system');
  assert.equal(view.label.hidden, false);
  view.media.matches = false; view.events.media();
  assert.equal(view.root.classList['pf-v5-theme-dark'], false);
  view.select.value = 'dark'; view.events.change();
  assert.equal(view.root.classList['pf-v5-theme-dark'], true);
  view.events.media();
  assert.equal(view.root.classList['pf-v5-theme-dark'], true);
  assert.deepEqual(view.writes, [['wasalx.auth.theme', 'dark']]);
  assert.equal(page({ stored: view.stored }).select.value, 'dark');
  view.select.value = 'system'; view.events.change();
  assert.equal(view.root.classList['pf-v5-theme-dark'], false);
  view.select.value = 'light'; view.events.change();
  view.media.matches = true; view.events.media();
  assert.equal(view.root.classList['pf-v5-theme-dark'], false);
});

test('native sign-in appearance handles storage denial and invalid values without touching auth storage', () => {
  for (const options of [{ denied: true }, { stored: { 'wasalx.auth.theme': '<script>' } }]) {
    const view = page(options);
    assert.equal(view.select.value, 'system');
    view.select.value = 'dark'; view.events.change();
    assert.equal(view.root.classList['pf-v5-theme-dark'], true);
    view.select.value = 'invalid'; view.events.change();
    assert.equal(view.root.dataset.appearance, 'dark');
  }
  assert.equal(page({ stored: { 'wasalx.theme': 'light' }, dark: true }).select.value, 'light');
  const operator = page({ platform: true, stored: { 'wasalx.auth.theme': 'dark', 'wasalx-platform-theme': 'light' } });
  assert.equal(operator.select.value, 'light');
  operator.select.value = 'system'; operator.events.change();
  assert.deepEqual(operator.writes, [['wasalx-platform-auth-theme', 'system']]);
});

test('presentation changes preserve inherited login forms, autofill and session policy', async () => {
  const fields = await readFile(new URL('field.ftl', root), 'utf8');
  assert.match(fields, /name="\$\{name\}"[^\n]*type="text" autocomplete="\$\{autocomplete\}"/u);
  assert.match(fields, /name="\$\{name\}"[^\n]*type="password" autocomplete="\$\{autocomplete\}"/u);
  assert.match(fields, /autocapitalize="none" spellcheck="false"/u);
  assert.doesNotMatch(script, /password|credential|cookie|fetch\(|XMLHttpRequest/u);
  for (const [name, idle, max] of [['wasalx', 1800, 28800], ['wasalx-platform', 900, 3600]]) {
    const realm = JSON.parse(await readFile(new URL(`../../../${name}-realm.json`, root), 'utf8'));
    assert.equal(realm.rememberMe, false);
    assert.equal(realm.ssoSessionIdleTimeout, idle);
    assert.equal(realm.ssoSessionMaxLifespan, max);
  }
});
