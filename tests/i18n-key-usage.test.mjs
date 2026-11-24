import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { tenantPortalFiles } from "./helpers/tenant-portal-source.mjs";

import { arabicMessages } from "../lib/i18n/messages/ar/index.ts";
import { englishMessages } from "../lib/i18n/messages/en/index.ts";

const clientSurfaces = [
  "../app/MarketingInbox.tsx",
  "../app/page.tsx",
  ...tenantPortalFiles.map((path) => `../${path}`),
  "../app/BotAutomation.tsx",
  "../app/ClientRouting.tsx",
  "../app/CaseLifecycle.tsx",
  "../app/platform/PlatformConsole.tsx",
];

const placeholders = (message) =>
  [...message.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/gu)]
    .map((match) => match[1])
    .sort();

async function literalTranslationUsage() {
  const usage = new Map();
  for (const relativePath of clientSurfaces) {
    const url = new URL(relativePath, import.meta.url);
    const source = await readFile(url, "utf8");
    const file = ts.createSourceFile(
      relativePath,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "t" &&
        node.arguments[0] &&
        (ts.isStringLiteral(node.arguments[0]) ||
          ts.isNoSubstitutionTemplateLiteral(node.arguments[0]))
      ) {
        const key = node.arguments[0].text;
        const line = file.getLineAndCharacterOfPosition(node.arguments[0].getStart(file)).line + 1;
        const locations = usage.get(key) ?? [];
        locations.push(`${relativePath}:${line}`);
        usage.set(key, locations);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return usage;
}

test("every literal client translation key exists in both aggregate catalogs", async () => {
  const usage = await literalTranslationUsage();
  const missingEnglish = [...usage.keys()].filter((key) => !(key in englishMessages)).sort();
  const missingArabic = [...usage.keys()].filter((key) => !(key in arabicMessages)).sort();
  assert.deepEqual(
    missingEnglish,
    [],
    `Missing English keys:\n${missingEnglish.map((key) => `${key}: ${usage.get(key).join(", ")}`).join("\n")}`,
  );
  assert.deepEqual(
    missingArabic,
    [],
    `Missing Arabic keys:\n${missingArabic.map((key) => `${key}: ${usage.get(key).join(", ")}`).join("\n")}`,
  );
});

test("used translations preserve interpolation placeholders across locales", async () => {
  const usage = await literalTranslationUsage();
  const mismatches = [];
  for (const key of usage.keys()) {
    if (!(key in englishMessages) || !(key in arabicMessages)) continue;
    const englishPlaceholders = placeholders(englishMessages[key]);
    const arabicPlaceholders = placeholders(arabicMessages[key]);
    if (englishPlaceholders.join("\0") !== arabicPlaceholders.join("\0")) {
      mismatches.push(`${key}: en=${englishPlaceholders.join(",")} ar=${arabicPlaceholders.join(",")}`);
    }
  }
  assert.deepEqual(mismatches, [], `Placeholder mismatches:\n${mismatches.join("\n")}`);
});

test("tenant-facing translations do not expose internal provider vocabulary", async () => {
  const usage = await literalTranslationUsage();
  const forbidden = /\b(?:zammad|waha|gows|noweb|control plane|worker|outbox|idempotency|fixture|pilot)\b/iu;
  const findings = [...usage.keys()]
    .filter((key) => !key.startsWith("platform."))
    .filter((key) => key in englishMessages && forbidden.test(englishMessages[key]))
    .map((key) => `${key}: ${englishMessages[key]}`)
    .sort();
  assert.deepEqual(findings, [], `Internal vocabulary in tenant copy:\n${findings.join("\n")}`);
});

test("catalogues spell Arabic \"again\" one way and never name the control plane (#327)", () => {
  const findings = [
    ...Object.entries(arabicMessages).filter(([, message]) => /مجددا(?!\p{Script=Arabic})|مجدداً/u.test(message)).map(([key]) => `ar ${key}: write مجددًا`),
    ...Object.entries(englishMessages).filter(([, message]) => /control plane/iu.test(message)).map(([key]) => `en ${key}: control plane`),
    ...Object.entries(arabicMessages).filter(([, message]) => /مستوى (?:ال)?تحكم/u.test(message)).map(([key]) => `ar ${key}: control plane`),
  ];
  assert.deepEqual(findings, []);
});
