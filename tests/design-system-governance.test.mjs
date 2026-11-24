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

test("new primitives consume tokens instead of feature-local color and spacing literals", async () => {
  const primitives = await read("app/design-system/primitives.css");
  assert.doesNotMatch(primitives, /#[\da-f]{3,8}\b/iu);
  assert.doesNotMatch(primitives, /rgba?\(/iu);
  for (const declaration of primitives.matchAll(/(?:gap|margin|padding)(?:-[a-z]+)?\s*:\s*([^;]+)/giu)) {
    const value = declaration[1].trim();
    assert.ok(value === "0" || value.includes("var(--wx-space-"), `spacing declaration must use a token: ${declaration[0]}`);
  }
});

test("portal and public styles use color, type, radius and elevation tokens", async () => {
  for (const path of ["app/globals.css", "app/marketing.css"]) {
    const css = await read(path);
    const drift = (pattern) => [...css.matchAll(pattern)].map((match) => match[0]);
    assert.deepEqual(drift(/#[\da-f]{3,8}\b|(?:rgb|hsl)a?\(|[:,(]\s*(?:white|black)\b(?!-)/giu), [], `${path}: colors must come from tokens.css`);
    // Any raw length in a font size, also inside clamp(); fluid sizes run between tokens.
    assert.deepEqual(drift(/font-size\s*:[^;}]*?[\d.](?:px|r?em)\b[^;}]*|font\s*:\s*(?:\d{3}\s+)?[\d.]+(?:px|r?em)/giu), [], `${path}: font sizes must use --wx-font-size-*`);
    assert.deepEqual(drift(/radius\s*:(?!\s*(?:0\b|50%|revert\b|var\(--wx-radius-))[^;}]+/giu), [], `${path}: radii must use --wx-radius-*`);
    // Elevation is the control or dialog shadow; everything else is a flat, blur-free ring.
    const shadows = drift(/box-shadow\s*:\s*[^;}]+/giu).map((declaration) => declaration.replace(/^box-shadow\s*:\s*/u, "").trim());
    assert.deepEqual(shadows.filter((value) => !/^(?:none|var\(--shadow\)|0 1px 1px var\(--wx-color-control-shadow\)|(?:inset )?0 0 0 [^\s,]+ (?:var\([^()]*\)|color-mix\([^()]*(?:\([^()]*\)[^()]*)*\)))$/u.test(value)), [], `${path}: off-token shadow`);
    assert.doesNotMatch(css, /@media([^{]+)\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}\s*@media\1\{/u, `${path}: adjacent blocks for one breakpoint must be merged`);
  }
  const sideTabs = [];
  for (const path of await readdir(new URL("app/", root), { recursive: true })) {
    if (!path.endsWith(".css")) continue;
    const css = await read(`app/${path.replaceAll("\\", "/")}`);
    for (const [match] of css.matchAll(/border-(?:inline-start|inline-end|left|right)(?:-width)?\s*:\s*(?:[2-9]|\d{2,})|box-shadow\s*:\s*inset\s+(?!0\s)[^;}]+/gu)) sideTabs.push(`${path}: ${match}`);
  }
  assert.deepEqual(sideTabs, [], "no thick one-side accent borders");
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
  const [, block, inline] = coarse.match(/\.switch::after\{content:"";position:absolute;inset:-([\d.]+)px -([\d.]+)px\}/u);
  assert.deepEqual([Number(width) + 2 * Number(inline), Number(height) + 2 * Number(block)], [44, 44]);
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
  const app = await read("app/WasalXApp.tsx");
  const globals = await read("app/globals.css");
  const cells = [...app.matchAll(/<t[hd] className="select-column">(.*?)<\/t[hd]>/gu)].map((match) => match[1]);
  assert.equal(cells.length, 2);
  for (const cell of cells) assert.match(cell, /^<label><input type="checkbox" .*aria-label=\{t\(.*"tenant\.group\.selection\.[\w.]+".*\/><\/label>$/u, "each checkbox sits in its label hit area and keeps its accessible name");
  const size = (css) => css.match(/\.select-column label\{[^}]*min-inline-size:(\d+)px;min-block-size:(\d+)px/u).slice(1).map(Number);
  assert.deepEqual(size(globals), [24, 24]);
  assert.deepEqual(size(globals.match(/@media\(any-pointer:coarse\)\{\.select-column\{[^}]*\}[^}]*\}\}/u)[0]), [44, 44]);
});

