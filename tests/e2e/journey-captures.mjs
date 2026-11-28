import { appendFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const themes = ["light", "dark"];
const locales = ["en", "ar"];
const standardViewports = { desktop: "desktop", "mobile-390": "mobile-390" };
const standardCapture = { themes, viewports: standardViewports };
const captures = {
  "workspace-access-ready": standardCapture,
  "tenant-shell": standardCapture,
  "tenant-shell-menu-open": { themes, viewports: { desktop: "mobile-390" } },
  "tenant-shell-collapsed-rail": { themes, viewports: { desktop: "tablet-820" } },
  "tenant-inbox": standardCapture,
  "tenant-cases": standardCapture,
  "tenant-settings": standardCapture,
  "tenant-settings-privacy": standardCapture,
  "tenant-groups": standardCapture,
  "invitation-incomplete": {
    ...standardCapture,
    themes: ["light", "dark-preview"],
  },
  "workflow-automation-list": standardCapture,
  "workflow-automation-edit": standardCapture,
  "client-routing-list": standardCapture,
  "client-routing-edit": standardCapture,
  "message-delivery-list": standardCapture,
  "message-delivery-detail": standardCapture,
};

export function journeyCapturePath(capture, viewport, theme, locale) {
  const entry = Object.hasOwn(captures, capture) ? captures[capture] : undefined;
  if (
    !entry?.themes.includes(theme) ||
    !Object.values(entry.viewports).includes(viewport) ||
    !locales.includes(locale)
  ) {
    throw new Error(
      `Unknown journey capture: ${capture} / ${viewport} / ${theme} / ${locale}`,
    );
  }
  return `output/playwright/journey-captures/${capture}-${viewport}-${theme}-${locale}.png`;
}

export function journeyCapturePaths(locale, shard) {
  if (shard !== undefined && !Object.hasOwn(standardViewports, shard)) {
    throw new Error(`Unknown journey capture shard: ${shard}`);
  }
  return Object.entries(captures).flatMap(([capture, { themes, viewports }]) =>
    Object.entries(viewports).flatMap(([owner, viewport]) =>
      shard === undefined || shard === owner
        ? themes.map((theme) =>
            journeyCapturePath(capture, viewport, theme, locale),
          )
        : [],
    ),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const paths = journeyCapturePaths(process.argv[2], process.argv[3]);
  const missing = paths.filter((path) => {
    const file = lstatSync(path, { throwIfNoEntry: false });
    return !file?.isFile() || !file.size;
  });
  if (missing.length) {
    process.stderr.write(
      `Missing or empty journey captures:\n${missing.join("\n")}\n`,
    );
    process.exitCode = 1;
  } else {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `paths<<CAPTURES\n${paths.join("\n")}\nCAPTURES\n`,
    );
    process.stdout.write(`Verified ${paths.length} journey captures.\n`);
  }
}
