import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

// Run against an isolated Keycloak realm, using synthetic credentials supplied privately.
const base = process.env.WASALX_AUTH_TEST_ORIGIN;
if (base && !['127.0.0.1', 'localhost'].includes(new URL(base).hostname)) throw new Error('Use an isolated local identity runtime.');
test.use({ trace: 'off', video: 'off', screenshot: 'off' });
test.skip(!base || !process.env.WASALX_AUTH_TEST_FIXTURES, 'An isolated native identity runtime is required.');

for (const locale of ['en', 'ar']) {
  test(`native ${locale} sign-in supports themes, autofill, recovery and MFA`, async ({ page }, info) => {
    const fixtures = JSON.parse(await readFile(process.env.WASALX_AUTH_TEST_FIXTURES!, 'utf8'));
    const actor = fixtures[locale];
    const problems: string[] = [];
    page.on('pageerror', error => problems.push(error.message));
    page.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) problems.push(message.text()); });
    const challenge = createHash('sha256').update(randomBytes(32)).digest('base64url');
    const query = new URLSearchParams({ client_id: 'wasalx-portal', redirect_uri: 'http://127.0.0.1:4173/', response_type: 'code', scope: 'openid', ui_locales: locale, code_challenge: challenge, code_challenge_method: 'S256', acr_values: 'urn:wasalx:loa:2', prompt: 'login' });
    const url = `${base}/realms/signin-review/protocol/openid-connect/auth?${query}`;
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(url);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    const iconUrl = await page.locator('link[rel="icon"]').getAttribute('href');
    expect(iconUrl).toContain('/shared/favicon.svg');
    const icon = await page.request.get(new URL(iconUrl!, page.url()).href);
    expect(icon.status()).toBe(200);
    expect(await icon.text()).toContain('aria-label="X"');
    await expect(page.locator('html')).toHaveClass(/pf-v5-theme-dark/);
    const appearance = page.locator('#wasalx-auth-theme');
    const appearanceMenu = page.locator('#wasalx-auth-theme-menu');
    const languageMenu = page.locator('#login-select-toggle-menu');
    const appearanceToggle = appearanceMenu.locator('summary');
    const languageToggle = languageMenu.locator('summary');
    const setTheme = async (theme: string) => {
      const label = await appearance.locator(`option[value="${theme}"]`).textContent();
      await appearanceToggle.click();
      await appearanceMenu.getByRole('button', { name: label!, exact: true }).click();
      await expect(appearanceMenu).not.toHaveAttribute('open');
      await expect(appearanceToggle).toBeFocused();
      await expect(appearance).toHaveValue(theme);
    };
    await expect(appearance).toHaveValue('system');
    await expect(appearanceToggle.locator('[data-theme-icon="appearance"]')).toBeVisible();
    await expect(languageToggle).toHaveText(locale === 'ar' ? 'Ar' : 'En');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).not.toHaveClass(/pf-v5-theme-dark/);
    await languageToggle.focus();
    await page.keyboard.press('Tab');
    await expect(appearanceToggle).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.locator('#username')).toBeFocused();
    await setTheme('dark');
    await page.reload();
    await expect(appearance).toHaveValue('dark');
    await expect(page.locator('html')).toHaveClass(/pf-v5-theme-dark/);
    const switchLocale = async (target: string) => {
      await languageToggle.click();
      await languageMenu.getByRole('button', { name: target === 'ar' ? 'العربية' : 'English', exact: true }).click();
    };
    await switchLocale(locale === 'en' ? 'ar' : 'en');
    await expect(page.locator('html')).toHaveAttribute('lang', locale === 'en' ? 'ar' : 'en');
    await expect(appearance).toHaveValue('dark');
    await switchLocale(locale);
    await expect(page.locator('html')).toHaveAttribute('lang', locale);
    await expect(appearanceToggle).toBeVisible();
    await expect(appearance).toHaveValue('dark');
    // Native disclosure keyboard navigation, dismissal and exclusive opening.
    await appearanceToggle.focus();
    await page.keyboard.press('Enter');
    await expect(appearanceMenu).toHaveAttribute('open');
    await page.keyboard.press('Tab');
    await expect(appearanceMenu.getByRole('button').nth(0)).toBeFocused();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await expect(appearance).toHaveValue('light');
    await expect(appearanceToggle).toBeFocused();
    await expect(page.locator('html')).not.toHaveClass(/pf-v5-theme-dark/);
    await appearanceToggle.press('Space');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await expect(appearanceMenu).not.toHaveAttribute('open');
    await expect(appearanceToggle).toBeFocused();
    await appearanceToggle.click();
    await languageToggle.click();
    await expect(appearanceMenu).not.toHaveAttribute('open');
    await expect(languageMenu).toHaveAttribute('open');
    await page.locator('#kc-page-title').click();
    await expect(languageMenu).not.toHaveAttribute('open');
    await languageToggle.click();
    await languageMenu.getByRole('button').last().focus();
    await page.keyboard.press('Tab');
    await expect(languageMenu).not.toHaveAttribute('open');

    await expect(page.locator('#username')).toHaveAttribute('autocomplete', /\busername\b/);
    await expect(page.locator('#username')).toHaveAttribute('autocapitalize', 'none');
    await expect(page.locator('#password')).toHaveAttribute('autocomplete', 'current-password');
    await expect(page.locator('#kc-form-login')).toHaveAttribute('method', 'post');
    await page.locator('#password').fill('Synthetic visibility check');
    await page.locator('#password-show-password').click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'text');
    await page.locator('#password-show-password').click();
    await expect(page.locator('#password')).toHaveAttribute('type', 'password');
    await page.locator('#password').fill('');

    for (const state of ['signin', 'error', 'recovery', 'otp']) {
      if (state === 'error') {
        await page.locator('#kc-login').click();
        await expect(page.locator('[role="alert"]')).toBeVisible();
      }
      if (state === 'recovery') await page.getByRole('link', { name: locale === 'en' ? 'Forgot password?' : 'نسيت كلمة المرور؟', exact: true }).click();
      if (state === 'otp') {
        await page.goto(url);
        await page.locator('#username').fill(actor.username);
        await page.locator('#password').fill(actor.password);
        await page.locator('#kc-login').click();
        await expect(page.locator('#otp')).toBeVisible();
        await expect(page.locator('#kc-attempted-username')).toHaveAttribute('readonly', '');
      }
      for (const theme of ['light', 'dark']) {
        await setTheme(theme);
        await page.evaluate(() => document.fonts.ready);
        for (const width of [320, 390, 820, 1440]) {
          await page.setViewportSize({ width, height: 900 });
          await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
          await expect(appearanceToggle.locator('[data-theme-icon="appearance"]')).toBeVisible();
          expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
          const expectedFont = locale === 'ar' ? 'Noto Sans Arabic' : 'Geist Sans';
          expect(await page.locator('#kc-page-title').evaluate(el => getComputedStyle(el).fontFamily)).toContain(expectedFont);
          expect(await page.evaluate(font => document.fonts.check(`16px "${font}"`), expectedFont)).toBe(true);
          for (const control of [appearanceToggle, languageToggle]) {
            const size = await control.boundingBox();
            expect(size!.width).toBeGreaterThanOrEqual(44);
            expect(size!.height).toBeGreaterThanOrEqual(44);
          }
          const centered = await appearanceToggle.evaluate(label => {
            const outer = label.getBoundingClientRect(), icon = label.querySelector('svg')!.getBoundingClientRect();
            return Math.max(Math.abs(outer.x + outer.width / 2 - icon.x - icon.width / 2), Math.abs(outer.y + outer.height / 2 - icon.y - icon.height / 2));
          });
          expect(centered).toBeLessThanOrEqual(1);
          if (state === 'signin' || state === 'error') {
            await expect(page.locator('#kc-page-title .wasalx-brand-accent')).toHaveText('X');
            const layout = await page.locator('.pf-v5-c-form__group:has([data-password-toggle])').evaluate(group => {
              const label = group.querySelector('label')!.getBoundingClientRect();
              const recovery = group.querySelector('a')!.getBoundingClientRect();
              const field = group.querySelector('input')!.getBoundingClientRect();
              return { labelY: label.y + label.height / 2, recoveryY: recovery.y + recovery.height / 2, recoveryBottom: recovery.bottom, fieldTop: field.top, fieldWidth: group.getBoundingClientRect().width };
            });
            expect(Math.abs(layout.labelY - layout.recoveryY)).toBeLessThanOrEqual(3);
            expect(layout.recoveryBottom).toBeLessThanOrEqual(layout.fieldTop);
            if (width < 576) {
              expect(layout.fieldWidth).toBeGreaterThanOrEqual(width - 50);
              const gutter = await page.locator('#kc-header-wrapper').evaluate(el => {
                const brand = el.getBoundingClientRect(), form = document.querySelector('#kc-form-login')!.getBoundingClientRect();
                return document.documentElement.dir === 'rtl' ? Math.abs(brand.right - form.right) : Math.abs(brand.left - form.left);
              });
              expect(gutter).toBeLessThanOrEqual(1);
            }
          }
          const cdp = await page.context().newCDPSession(page);
          await cdp.send('DOM.enable');
          await cdp.send('CSS.enable');
          const dom = await cdp.send('DOM.getDocument');
          const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: dom.root.nodeId, selector: '#kc-page-title' });
          const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId });
          expect(fonts.some(font => font.isCustomFont && font.familyName.includes(locale === 'ar' ? 'Noto Sans Arabic' : 'Geist') && font.glyphCount > 0)).toBe(true);
          await cdp.detach();
          for (const control of await page.locator('[data-password-toggle]').all()) {
            const offset = await control.evaluate(button => {
              const b = button.getBoundingClientRect(), icon = button.querySelector('i')!.getBoundingClientRect();
              return { x: Math.abs(b.x + b.width / 2 - icon.x - icon.width / 2), y: Math.abs(b.y + b.height / 2 - icon.y - icon.height / 2) };
            });
            expect(offset.x).toBeLessThanOrEqual(1); expect(offset.y).toBeLessThanOrEqual(1);
          }
          const violations = (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations;
          expect(violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) }))).toEqual([]);
          await page.screenshot({ path: info.outputPath(`${state}-${theme}-${width}.png`), fullPage: true });
          if (state === 'signin') {
            for (const [name, menu] of [['appearance', appearanceMenu], ['language', languageMenu]] as const) {
              await menu.locator('summary').click();
              const panel = menu.locator('.wasalx-preference-panel');
              await expect(panel).toBeVisible();
              const box = await panel.boundingBox();
              expect(box!.x).toBeGreaterThanOrEqual(0);
              expect(box!.x + box!.width).toBeLessThanOrEqual(width);
              expect(box!.y + box!.height).toBeLessThanOrEqual(900);
              await expect(menu.locator('button[aria-pressed="true"]')).toHaveCount(1);
              if (name === 'appearance') await expect(menu.locator('button[aria-pressed="true"]')).toContainText(await appearance.locator(`option[value="${theme}"]`).textContent() || '');
              for (const button of await menu.getByRole('button').all()) {
                expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
                expect(await button.evaluate(el => getComputedStyle(el).fontFamily)).toContain(expectedFont);
              }
              expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations.map(v => v.id)).toEqual([]);
              await page.screenshot({ path: info.outputPath(`${name}-${theme}-${width}.png`), fullPage: true });
              await menu.locator('summary').press('Escape');
            }
          }
        }
      }
    }
    // Submit the synthetic enrolled factor directly in memory. Never record credentials or traces.
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
    const mac = createHmac('sha256', actor.secret).update(counter).digest();
    const offset = mac.at(-1)! & 15;
    const binary = new DataView(mac.buffer, mac.byteOffset, mac.byteLength).getUint32(offset);
    await page.locator('#otp').fill(String((binary & 0x7fffffff) % 1_000_000).padStart(6, '0'));
    await page.locator('#kc-login').click();
    await page.waitForURL(u => u.origin === 'http://127.0.0.1:4173' && u.searchParams.has('code'));
    expect(problems).toEqual([]);
  });
}

test('native sign-in remains usable without appearance JavaScript', async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    const challenge = createHash('sha256').update(randomBytes(32)).digest('base64url');
    const query = new URLSearchParams({ client_id: 'wasalx-portal', redirect_uri: 'http://127.0.0.1:4173/', response_type: 'code', scope: 'openid', code_challenge: challenge, code_challenge_method: 'S256' });
    await page.goto(`${base}/realms/signin-review/protocol/openid-connect/auth?${query}`);
    await expect(page.locator('#username')).toBeVisible();
    await expect(page.locator('#password')).toBeVisible();
    await expect(page.locator('#wasalx-auth-theme')).toBeHidden();
    await page.locator('#kc-login').click();
    await expect(page.locator('[role="alert"]')).toBeVisible();
  } finally { await context.close(); }
});
