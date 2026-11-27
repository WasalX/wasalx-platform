import { appendFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const themes = ["light", "dark"];
const viewports = ["desktop", "mobile-390"];
const locales = ["en", "ar"];
const captures = {
  "workspace-access-ready": themes,
  "invitation-incomplete": ["light", "dark-preview"],
  "workflow-automation-list": themes,
  "workflow-automation-edit": themes,
  "client-routing-list": themes,
  "client-routing-edit": themes,
  "message-delivery-list": themes,
  "message-delivery-detail": themes,
};

export function journeyCapturePath(capture, viewport, theme, locale) {
  if (
    !Object.hasOwn(captures, capture) ||
    !captures[capture].includes(theme) ||
    !viewports.includes(viewport) ||
    !locales.includes(locale)
  ) {
    throw new Error(
      `Unknown journey capture: ${capture} / ${viewport} / ${theme} / ${locale}`,
    );
  }
  return `output/playwright/journey-captures/${capture}-${viewport}-${theme}-${locale}.png`;
}

export function journeyCapturePaths(locale) {
  return Object.entries(captures).flatMap(([capture, captureThemes]) =>
    viewports.flatMap((viewport) =>
      captureThemes.map((theme) =>
        journeyCapturePath(capture, viewport, theme, locale),
      ),
    ),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const paths = journeyCapturePaths(process.argv[2]);
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
