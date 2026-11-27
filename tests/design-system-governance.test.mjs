import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

function relativeLuminance(hex) {
  const channels = hex.match(/[\da-f]{2}/giu).map((channel) => Number.parseInt(channel, 16) / 255);
  const linear = channels.map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first, second) {
  const luminances = [relativeLuminance(first), relativeLuminance(second)].sort((a, b) => b - a);
  return (luminances[0] + 0.05) / (luminances[1] + 0.05);
}

test("Storybook dependencies and scripts are exact and version-aligned", async () => {
  const packageJson = JSON.parse(await read("package.json"));
  const required = [
    "storybook",
    "@storybook/react-vite",
    "@storybook/addon-docs",
    "@storybook/addon-a11y",
  ];
  for (const dependency of required) {
    assert.equal(packageJson.devDependencies[dependency], "10.6.2", `${dependency} must stay pinned to the Storybook release`);
  }
  assert.equal(packageJson.devDependencies["@playwright/test"], "1.62.1");
  assert.equal(packageJson.devDependencies["@axe-core/playwright"], "4.12.1");
  assert.match(packageJson.scripts["build:storybook"], /storybook build/u);
  assert.match(packageJson.scripts["test:visual"], /storybook-visual-regression/u);
});

test("Dependabot skips standalone updates of the patched Storybook package", async () => {
  const dependabot = parse(await read(".github/dependabot.yml"));
  const npm = dependabot.updates.find(update => update["package-ecosystem"] === "npm");
  assert.deepEqual(npm.ignore.find(rule => rule["dependency-name"] === "storybook"), { "dependency-name": "storybook" });
});

test("Dependabot groups Docker, Docker Compose and GitHub Actions version updates by ecosystem", async () => {
  const dependabot = parse(await read(".github/dependabot.yml"));
  const docker = dependabot.updates.filter(update => update["package-ecosystem"] === "docker");
  const compose = dependabot.updates.filter(update => update["package-ecosystem"] === "docker-compose");
  const actions = dependabot.updates.filter(update => update["package-ecosystem"] === "github-actions");
  assert.deepEqual(docker.map(update => update.directories), [["/", "/infra/docker"]]);
  assert.deepEqual(compose, [{
    "package-ecosystem": "docker-compose",
    directory: "/",
    "exclude-paths": ["tests/fixtures/dev-live-compose/**"],
    "open-pull-requests-limit": docker[0]["open-pull-requests-limit"],
    schedule: docker[0].schedule,
    cooldown: docker[0].cooldown,
    ignore: [
      { "dependency-name": "node", "update-types": ["version-update:semver-major"] },
      { "dependency-name": "postgres", "update-types": ["version-update:semver-major"] },
      {
        "dependency-name": "elasticsearch",
        "update-types": ["version-update:semver-major", "version-update:semver-minor"],
      },
      { "dependency-name": "jaegertracing/jaeger", "versions": [">=2.21.0"] },
      { "dependency-name": "keycloak/keycloak" },
      { "dependency-name": "prom/prometheus" },
      { "dependency-name": "minio/minio" },
      { "dependency-name": "minio/mc" },
      { "dependency-name": "devlikeapro/waha" },
      { "dependency-name": "wasalx/*" },
    ],
    groups: { "docker-compose-version-updates": { patterns: ["*"] } },
  }]);
  assert.deepEqual(actions.map(update => update.directory), ["/"]);
  for (const [ecosystem, [update]] of [["docker", docker], ["github-actions", actions]]) {
    assert.deepEqual(update.groups, {
      [`${ecosystem}-version-updates`]: { patterns: ["*"] },
      [`${ecosystem}-security`]: { "applies-to": "security-updates", patterns: ["*"] },
    });
  }
});

test("production and Storybook share the pinned local Geist assets", async () => {
  const fonts = new Map([
    ["app/fonts/Geist-Variable.woff2", "a369fcf5628ea2aa4e1b9e2ec6a5b3624e365bda588e1f0f2f12b564f728fbb8"],
    ["app/fonts/GeistMono-Variable.woff2", "fba8f577f38a2bbcbe818efa6348dd58f36303a10b8737c42fefad275be563ab"],
  ]);
  for (const [path, expected] of fonts) {
    const contents = await readFile(new URL(path, root));
    assert.equal(createHash("sha256").update(contents).digest("hex"), expected, `${path} must remain pinned`);
  }
  assert.match(await read("app/fonts/LICENSE.txt"), /SIL OPEN FONT LICENSE/u);
});

test("token source defines the complete WasalX foundation and theme aliases", async () => {
  const tokens = await read("app/design-system/tokens.css");
  for (const value of ["0.75rem", "0.8125rem", "0.875rem", "1rem", "1.25rem", "1.5rem", "2rem"]) {
    assert.match(tokens, new RegExp(value.replace(".", "\\."), "u"), `missing type size ${value}`);
  }
  for (const step of ["1", "2", "3", "4", "6", "8", "12", "16"]) {
    assert.match(tokens, new RegExp(`--wx-space-${step}:`, "u"), `missing spacing token ${step}`);
  }
  for (const token of [
    "--wx-radius-control",
    "--wx-radius-panel",
    "--wx-radius-dialog",
    "--wx-duration-fast",
    "--wx-duration-default",
    "--wx-duration-slow",
    "--wx-color-success",
    "--wx-color-warning",
    "--wx-color-danger",
  ]) assert.match(tokens, new RegExp(`${token}:`, "u"), `missing ${token}`);
  assert.match(tokens, /\.theme-light\s*\{/u);
  assert.match(tokens, /\.theme-dark\s*\{/u);
  assert.match(tokens, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("semantic text and solid-action pairs meet WCAG AA contrast", async () => {
  const tokens = await read("app/design-system/tokens.css");
  for (const theme of ["dark", "light"]) {
    const block = tokens.match(new RegExp(`\\.theme-${theme} \\{([\\s\\S]*?)\\n\\}`, "u"))?.[1] ?? "";
    const values = Object.fromEntries(
      [...block.matchAll(/(--wx-color-[\w-]+):\s*(#[\da-f]{6});/giu)].map((match) => [match[1], match[2]]),
    );
    const pairs = [
      ["--wx-color-text", "--wx-color-surface"],
      ["--wx-color-text-muted", "--wx-color-surface"],
      ["--wx-color-text-subtle", "--wx-color-surface"],
      ["--wx-color-text-subtle", "--wx-color-surface-raised"],
      ["--wx-color-success", "--wx-color-surface-raised"],
      ["--wx-color-warning", "--wx-color-surface-raised"],
      ["--wx-color-danger", "--wx-color-surface"],
      ["--wx-color-accent-solid", "--wx-color-on-solid"],
      ["--wx-color-accent-solid-hover", "--wx-color-on-solid"],
      ["--wx-color-danger-solid", "--wx-color-on-solid"],
    ];
    for (const [background, foreground] of pairs) {
      assert.ok(contrast(values[background], values[foreground]) >= 4.5, `${theme} ${background}/${foreground} must meet 4.5:1`);
    }
  }
});

test("every status badge's text meets 4.5:1 on its own tint over every surface in both themes", async () => {
  const tokens = await read("app/design-system/tokens.css");
  const globals = await read("app/globals.css");
  const badges = [...globals.matchAll(/\.status-([\w-]+)\{color:var\(--([\w-]+)\);background:color-mix\(in srgb,var\(--\2\) (\d+)%,transparent\)\}/gu)];
  assert.deepEqual(badges.map((match) => match[1]).sort(), ["danger", "success", "warning"], "every tinted .status-* variant follows the shared rule");
  for (const theme of ["dark", "light"]) {
    const block = tokens.match(new RegExp(`\\.theme-${theme} \\{([\\s\\S]*?)\\n\\}`, "u"))?.[1] ?? "";
    const values = Object.fromEntries([...block.matchAll(/(--wx-color-[\w-]+):\s*(#[\da-f]{6});/giu)].map((match) => [match[1], match[2]]));
    const alias = (name) => values[tokens.match(new RegExp(`--${name}: var\\((--wx-color-[\\w-]+)\\)`, "u"))?.[1]];
    const channels = (hex) => hex.match(/[\da-f]{2}/giu).map((channel) => Number.parseInt(channel, 16));
    for (const [, variant, color, percent] of badges) {
      const text = channels(alias(color));
      for (const surface of ["--wx-color-page", "--wx-color-surface", "--wx-color-surface-raised", "--wx-color-surface-selected"]) {
        const tint = channels(values[surface]).map((channel, index) => Math.round(text[index] * percent / 100 + channel * (1 - percent / 100)));
        const ratio = contrast(alias(color), tint.map((channel) => channel.toString(16).padStart(2, "0")).join(""));
        assert.ok(ratio >= 4.5, `${theme} .status-${variant} on ${surface} is ${ratio.toFixed(2)}:1, needs 4.5:1`);
      }
    }
  }
});

test("app source has no fullwidth plus, which has no glyph in the app fonts, and plus actions share one icon", async () => {
  const found = [];
  for (const file of await readdir(new URL("app/", root), { recursive: true })) {
    const path = `app/${file.replaceAll("\\", "/")}`;
    if (/\.(?:[cm]?[jt]sx?|css|json|md|html)$/u.test(path) && (await read(path)).includes("＋")) found.push(path);
  }
  assert.deepEqual(found, [], 'use <MarketingIcon name="plus" /> instead of U+FF0B');
  const [icon, app, rules, team, settings, globals] = await Promise.all(["app/MarketingIcon.tsx", "app/WasalXApp.tsx", "app/Rules.tsx", "app/TeamAccess.tsx", "app/TenantSettings.tsx", "app/globals.css"].map(read));
  assert.match(icon, /plus: "M12 5v14M5 12h14"/u);
  assert.match(icon, /aria-hidden="true"/u);
  for (const [name, source] of Object.entries({ app, rules, team, settings })) assert.match(source, /<MarketingIcon name="plus" ?\/>/u, `${name} uses the shared plus icon`);
  assert.match(globals, /:is\(\.connect-number-action,\.icon-action\)>\.marketing-icon\{inline-size:var\(--wx-icon-size-inline\);block-size:var\(--wx-icon-size-inline\)/u);
});

test("every app stylesheet uses color, type, radius, elevation and spacing tokens", async () => {
  const tokens = await read("app/design-system/tokens.css");
  const sideTabs = [];
  for (const file of await readdir(new URL("app/", root), { recursive: true })) {
    const path = `app/${file.replaceAll("\\", "/")}`;
    if (!path.endsWith(".css") || path === "app/design-system/tokens.css") continue;
    const css = (await read(path)).replace(/\/\*[\s\S]*?\*\//gu, "");
    const drift = (pattern) => [...css.matchAll(pattern)].map((match) => match[0]);
    assert.deepEqual(drift(/#[\da-f]{3,8}\b|(?:rgb|hsl)a?\(|[:,(]\s*(?:white|black)\b(?!-)/giu), [], `${path}: colors must come from tokens.css`);
    // Any raw length in a font size, also inside clamp(); fluid sizes run between tokens.
    assert.deepEqual(drift(/font-size\s*:[^;}]*?[\d.](?:px|r?em)\b[^;}]*|font\s*:\s*(?:\d{3}\s+)?[\d.]+(?:px|r?em)/giu), [], `${path}: font sizes must use --wx-font-size-*`);
    assert.deepEqual(drift(/radius\s*:(?!\s*(?:0\b|50%|inherit\b|revert\b|var\(--wx-radius-))[^;}]+/giu), [], `${path}: radii must use --wx-radius-*`);
    // Elevation is the control or dialog shadow; everything else is a flat, blur-free ring.
    const shadows = drift(/box-shadow\s*:\s*[^;}]+/giu).map((declaration) => declaration.replace(/^box-shadow\s*:\s*/u, "").trim());
    assert.deepEqual(shadows.filter((value) => !/^(?:none|var\(--(?:wx-shadow-dialog|shadow)\)|0 1px 1px var\(--wx-color-control-shadow\)|(?:inset )?0 0 0 [^\s,]+ (?:var\([^()]*\)|color-mix\([^()]*(?:\([^()]*\)[^()]*)*\)))$/u.test(value)), [], `${path}: off-token shadow`);
    assert.doesNotMatch(css, /@media([^{]+)\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}\s*@media\1\{/u, `${path}: adjacent blocks for one breakpoint must be merged`);
    // Spacing is a --wx-space-* step, 0 or a 1px hairline; width, height and min-* target sizes are not spacing.
    assert.deepEqual(drift(/(?<![\w-])(?:padding|margin|inset|gap|row-gap|column-gap)(?:-[a-z-]+)?\s*:[^;}]*?(?<![\w.-])-?(?!1px\b)(?:\d*\.)?\d+(?:px|r?em)\b[^;}]*/giu), [], `${path}: spacing must use --wx-space-*`);
    assert.deepEqual(drift(/--wx-space-\d+\b/gu).filter((token) => !tokens.includes(`${token}:`)), [], `${path}: undefined spacing step`);
    for (const [match] of css.matchAll(/border-(?:inline-start|inline-end|left|right)(?:-width)?\s*:\s*(?:[2-9]|\d{2,})|box-shadow\s*:\s*inset\s+(?!0\s)[^;}]+/gu)) sideTabs.push(`${path}: ${match}`);
  }
  assert.deepEqual(sideTabs, [], "no thick one-side accent borders");
});

test("working surfaces are flat: gradients stay on the brand mark, chart grid and skeletons", async () => {
  const allowed = new Set([".brand-mark", ".operatorMark", ".chart-grid", ".group-skeleton", ".review-loading span", ".skeleton span", ".wx-skeleton-stack span"]);
  const gradients = [];
  for (const path of await readdir(new URL("app/", root), { recursive: true })) {
    if (!path.endsWith(".css")) continue;
    const css = (await read(`app/${path.replaceAll("\\", "/")}`)).replace(/\/\*[\s\S]*?\*\//gu, "");
    for (const [, selector, body] of css.matchAll(/([^{}]*)\{([^{}]*)\}/gu)) {
      if (/(?:linear|radial|conic)-gradient\(/u.test(body) && !allowed.has(selector.trim())) gradients.push(`${path}: ${selector.trim()}`);
    }
  }
  assert.deepEqual(gradients, [], "use flat token surfaces on working surfaces");
});

test("form controls keep a visible keyboard focus ring, also in forced colors", async () => {
  const primitives = await read("app/design-system/primitives.css");
  assert.match(primitives, /:where\(button, input, select, textarea\):focus-visible\s*\{\s*outline:\s*2px solid var\(--wx-color-accent\)/u);
  assert.match(primitives, /@media \(forced-colors: active\)\s*\{[^}]*:focus-visible\s*\{\s*outline:[^;}]*Highlight/u);
  const removals = [];
  for (const path of await readdir(new URL("app/", root), { recursive: true })) {
    if (!path.endsWith(".css")) continue;
    const css = await read(`app/${path.replaceAll("\\", "/")}`);
    for (const [, selector] of css.matchAll(/([^{}]*)\{[^{}]*\boutline\s*:\s*(?:0(?:px)?|none)\b[^{}]*\}/gu)) {
      if (/\b(?:input|select|textarea|button)\b/u.test(selector)) removals.push(`${path}: ${selector.trim()}`);
    }
  }
  assert.deepEqual(removals, [], "form-control rules must not remove the shared focus outline");
});

test("toggle switches keep a 31 x 18 track with a 44 x 44 hit area on coarse pointers", async () => {
  const globals = await read("app/globals.css");
  const [, width, height] = globals.match(/\.switch\{[^}]*width:(\d+)px;height:(\d+)px/u);
  const coarse = globals.match(/@media\(any-pointer:coarse\)\{:is\(button[^{]*\{min-block-size:44px\}.*?\}\}/u)[0];
  assert.match(coarse, /^@media\(any-pointer:coarse\)\{:is\(button:not\(\.switch\),/u, "the 44 px button minimum must not stretch the switch track");
  assert.deepEqual([Number(width), Number(height)], [31, 18]);
  assert.match(coarse, /\.switch::after\{content:"";position:absolute;inset:50% auto auto 50%;width:44px;height:44px;translate:-50% -50%\}/u, "the hit area is a centred 44 x 44 box");
});

test("the production portal consumes governed tokens without duplicate theme values", async () => {
  const layout = await read("app/layout.tsx");
  const globals = await read("app/globals.css");
  const packageJson = JSON.parse(await read("package.json"));
  const dockerfile = await read("Dockerfile.portal");
  const authenticationError = await read("app/auth/error/page.tsx");
  const tokenImport = layout.indexOf('import "./design-system/tokens.css"');
  const primitiveImport = layout.indexOf('import "./design-system/primitives.css"');
  const legacyImport = layout.indexOf('import "./globals.css"');
  assert.ok(tokenImport >= 0 && tokenImport < primitiveImport && primitiveImport < legacyImport, "governed CSS must load before portal features");
  assert.match(layout, /localFont.*next\/font\/local/u);
  assert.match(layout, /src:\s*"\.\/fonts\/Geist-Variable\.woff2"/u);
  assert.match(layout, /src:\s*"\.\/fonts\/GeistMono-Variable\.woff2"/u);
  assert.doesNotMatch(layout, /next\/font\/google/u);
  assert.doesNotMatch(globals, /\.theme-(?:dark|light)\s*\{\s*--bg:/u);
  assert.doesNotMatch(globals, /\.theme-dark,\.theme-light\s*\{[^}]*transition:/u, "theme changes must not animate through inaccessible contrast states");
  assert.match(globals, /--sidebar-effective-width:var\(--wx-sidebar-width\)/u);
  assert.match(globals, /grid-template-columns:var\(--sidebar-effective-width\)/u);
  assert.match(globals, /max-width:var\(--wx-content-max\)/u);
  assert.doesNotMatch(globals, /tailwind/u);
  assert.equal(packageJson.devDependencies.tailwindcss, undefined);
  assert.equal(packageJson.devDependencies["@tailwindcss/postcss"], undefined);
  assert.doesNotMatch(dockerfile, /postcss\.config|tailwind/u);
  assert.doesNotMatch(authenticationError, /style=\{\{/u);
  assert.match(authenticationError, /wx-button wx-button-primary/u);
});

test("Storybook fails accessibility violations and exposes theme exploration", async () => {
  const preview = await read(".storybook/preview.tsx");
  const styles = await read(".storybook/storybook.css");
  const main = await read(".storybook/main.ts");
  const vite = await read(".storybook/vite.storybook-isolated.ts");
  assert.match(main, /@storybook\/react-vite/u);
  assert.match(main, /@storybook\/addon-a11y/u);
  assert.match(main, /@storybook\/addon-docs/u);
  assert.match(main, /viteConfigPath:\s*"\.storybook\/vite\.storybook-isolated\.ts"/u);
  assert.match(main, /developmentModeForBuild:\s*true/u);
  assert.match(preview, /a11y:\s*\{\s*test:\s*"error"/su);
  assert.match(preview, /initialGlobals:\s*\{\s*theme:\s*"light"/su);
  assert.match(preview, /value:\s*"dark"/u);
  assert.match(styles, /Geist-Variable\.woff2/u);
  assert.match(styles, /GeistMono-Variable\.woff2/u);
  assert.match(vite, /defineConfig\(\{\}\)/u);
  assert.doesNotMatch(vite, /plugins\s*:/u);
});

test("stories cover every governed interaction and operational state", async () => {
  const controls = await read("app/design-system/Controls.stories.tsx");
  const operations = await read("app/design-system/OperationalStates.stories.tsx");
  for (const state of ["default", "hover", "focus", "disabled", "loading"]) {
    assert.match(controls, new RegExp(`\\b${state}\\b`, "u"), `missing control state ${state}`);
  }
  for (const state of ["loading", "empty", "sparse", "dense", "partial", "fatal", "recovery"]) {
    assert.match(operations, new RegExp(`\\b${state}\\b`, "u"), `missing operational state ${state}`);
  }
  assert.match(controls, /ControlStatesLight/u);
  assert.match(controls, /ControlStatesDark/u);
  assert.match(operations, /StateMatrixLight/u);
  assert.match(operations, /StateMatrixDark/u);
});

test("visual gate reports browser absence truthfully and can fail closed", async () => {
  const runner = await read("scripts/storybook-visual-regression.mjs");
  const spec = await read("tests/visual/design-system.spec.ts");
  const config = await read("playwright.storybook.config.ts");
  assert.match(runner, /SKIP design-system visual regression/u);
  assert.match(runner, /WASALX_REQUIRE_VISUAL/u);
  assert.match(spec, /toHaveScreenshot/u);
  assert.match(spec, /AxeBuilder/u);
  assert.match(spec, /violations/u);
  assert.match(config, /timeout:\s*60_000/u);
  assert.match(config, /outputFolder:\s*resolve\("output",\s*"playwright",\s*"design-system"\)/u);
});


test("Arabic typography shares one font registration across explicit locale boundaries", async () => {
  const tokens = await read("app/design-system/tokens.css");
  assert.match(tokens, /@font-face\s*\{[^}]*font-family: "Noto Sans Arabic"/u);
  for (const locale of ["ar", "en"]) {
    const block = tokens.match(new RegExp(`\\[lang="${locale}"\\] \\{([^}]+)`, "u"))?.[1] ?? "";
    assert.match(block, /--wx-font-sans:/u);
    assert.match(block, /--font-sans: var\(--wx-font-sans\)/u);
    assert.match(block, /font-family: var\(--wx-font-sans\)/u);
  }
  assert.doesNotMatch(await read("app/marketing.css"), /@font-face/u);
  assert.ok((await readFile(new URL("public/fonts/NotoSansArabic-Variable.woff2", root))).length > 1000);
});

test("platform case-service labels keep backend identifiers out of visible copy", async () => {
  const console = await read("app/platform/PlatformConsole.tsx");
  assert.doesNotMatch(console, />Zammad</u);
  for (const locale of ["en", "ar"]) {
    const messages = await read(`lib/i18n/messages/${locale}/platform.ts`);
    assert.doesNotMatch(messages, /: "[^"\n]*Zammad/u);
    assert.match(messages, /"platform\.states\.zammad":/u);
  }
  assert.match(console, /zammadVersion: String\(data\.get\("zammadVersion"\)\)/u);
});

test("group selection checkboxes have 24 px targets and 44 px targets on coarse pointers", async () => {
  const app = await read("app/Groups.tsx");
  const globals = await read("app/globals.css");
  const cells = [...app.matchAll(/<t[hd] className="select-column">(.*?)<\/t[hd]>/gu)].map((match) => match[1]);
  assert.equal(cells.length, 2);
  for (const cell of cells) assert.match(cell, /^<label><input type="checkbox" .*aria-label=\{t\(.*"tenant\.group\.selection\.[\w.]+".*\/><\/label>$/u, "each checkbox sits in its label hit area and keeps its accessible name");
  const size = (css) => css.match(/\.select-column label\{[^}]*min-inline-size:(\d+)px;min-block-size:(\d+)px/u).slice(1).map(Number);
  assert.deepEqual(size(globals), [24, 24]);
  assert.deepEqual(size(globals.match(/@media\(any-pointer:coarse\)\{\.select-column\{[^}]*\}[^}]*\}\}/u)[0]), [44, 44]);
});


test("mobile header keeps one sidebar grid and a top bar that grows with its text", async () => {
  const globals = await read("app/globals.css");
  const rules = (selector) => [...globals.matchAll(/([^{}]+)\{([^{}]*)\}/gu)].filter(([, found]) => found.trim() === selector).map(([, , body]) => body);
  for (const selector of [".sidebar", ".workspace-switcher", ".mobile-navigation-toggle", ".sidebar-bottom", ".sidebar nav"]) {
    assert.ok(rules(selector).filter((body) => /grid-(?:row|column|template-columns)\s*:/u.test(body)).length <= 1, `${selector} has one mobile grid placement`);
  }
  for (const body of rules(".topbar")) assert.doesNotMatch(body, /(?:^|[;\s])height\s*:/u, "a fixed top bar height lets wrapped text overflow onto the menu toggle at 200% text");
  assert.match(rules(".topbar")[0], /min-height:57px/u);
});

test("tenant screens keep the URL, icon, name and mailbox fixes from issue 565", async () => {
  const [app, settings, mailbox] = await Promise.all(["app/WasalXApp.tsx", "app/TenantSettings.tsx", "app/MailboxSettings.tsx"].map(read));
  assert.doesNotMatch(app, /\uff0b/u, "the fullwidth plus has no glyph in the app fonts");
  assert.match(app, /<MarketingIcon name="plus" \/>\s*<span className="connect-number-action-label">/u);
  assert.match(app, /<b dir="auto">\{user\.displayName\}<\/b>/u, "the truncating name element takes its own direction");
  assert.match(settings, /<div className="input-prefix" dir="ltr">/u, "the slug URL reads left to right in Arabic too");
  for (const key of ["setupRequired", "templateReview", "loading", "empty"]) {
    assert.match(mailbox, new RegExp(String.raw`<p className="workspace-access-state"[^>]*>\{t\("mailboxes\.${key}"\)\}`, "u"), `mailboxes.${key} sits in the padded muted body`);
  }
});

test("workspace settings keep the mailbox spacing fixes from issue 571", async () => {
  const [mailbox, globals] = await Promise.all(["app/MailboxSettings.tsx", "app/globals.css"].map(read));
  assert.match(mailbox, /\{rows\.length \? <ul className="mailbox-list"/u, "an empty padded list leaves a blank band above the empty state");
  assert.match(globals, /\.settings-grid\+\.settings-grid\{margin-block-start:var\(--wx-space-4\)\}/u, "the settings and mailbox grids are siblings in a block container, so the grid gap does not separate them");
  for (const columns of ["210px minmax(0,1fr)", "11.25rem minmax(0,1fr)", "minmax(0,1fr)"]) {
    assert.ok(globals.includes(`.settings-grid.settings-grid-privacy,.settings-grid-privacy+.settings-grid{grid-template-columns:${columns}`), `the mailbox card follows the Privacy columns ${columns}`);
  }
});

test("ticket routing sync keeps its body on the card inset at body size (issue 596)", async () => {
  const [panel, css] = await Promise.all(["app/NativeRoutingSync.tsx", "app/NativeRoutingSync.module.css"].map(read));
  const body = panel.slice(panel.indexOf("<div className={styles.body}>"), panel.lastIndexOf("</section>"));
  assert.match(panel, /<\/div>\s*<div className=\{styles\.body\}>\s*<div role="status">/u, "the status, actions, policy text and editor sit in the padded body right after the heading");
  for (const part of ['role="status"', "styles.actions", "nativeRouting.defaults.description", "nativeRouting.defaults.count", "styles.editor"]) assert.ok(body.includes(part), `${part} is inside the padded body`);
  assert.match(css, /\.body \{[^}]*padding: var\(--wx-space-4\);[^}]*font-size: var\(--wx-font-size-2\);/u, "the body uses the card inset and the card text size");
});

test("Workflows and Client routing fields share one field style at body size (issue 597)", async () => {
  const [globals, routing, bot] = await Promise.all(["app/globals.css", "app/ClientRouting.tsx", "app/BotAutomation.tsx"].map(read));
  const shared = globals.match(/\.bot-automation :where\(input,select,textarea\),\.routing-workspace :where\(input,select,textarea\)\{([^}]*)\}/u);
  assert.ok(shared, "Client routing fields join the Workflows field rule");
  assert.match(shared[1], /border:1px solid var\(--border-strong\);[^}]*background:var\(--surface-2\);[^}]*padding:var\(--wx-space-2\) var\(--wx-space-3\);font-size:var\(--wx-font-size-3\)$/u);
  for (const state of ["focus-visible", "user-invalid", "disabled"]) assert.ok(globals.includes(`.routing-workspace :where(input,select,textarea):${state}{`), `Client routing fields share the ${state} state`);
  assert.doesNotMatch(globals, /:where\(input,select(?:,textarea)?\)\{[^}]*font-size:var\(--wx-font-size-4\)/u, "no shared field rule uses the 16 px size");
  assert.ok(routing.indexOf('<div className="routing-workspace"') < routing.indexOf("<RoutingSimulator"), "the simulator renders inside the routing workspace");
  assert.match(bot, /<div className="bot-automation" dir=\{direction\}>/u);
});
