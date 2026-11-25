import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test } from "@playwright/test";
import { axeLines, stackLine } from "./meta-cost-reporter.mjs";

const require = createRequire(import.meta.url);
const commonjsBuilder = require("@axe-core/playwright");
const requireAxe = createRequire(require.resolve("@axe-core/playwright"));
const ruleIds = new Set(requireAxe("axe-core").getRules().map(rule => rule.ruleId));

async function captureContrast(page, nodes) {
  const output = dirname(process.env.QA_META_COST_EVIDENCE);
  const locale = process.env.WASALX_E2E_LOCALE;
  const project = test.info().project.name;
  if (!["en", "ar"].includes(locale) || !["desktop", "mobile-390"].includes(project) || nodes.length > 6) {
    throw new Error("Unexpected contrast evidence scope");
  }
  const records = [];
  for (const [index, node] of nodes.entries()) {
    const checkKeys = node.any.map(check => check.data?.messageKey).filter(value => typeof value === "string" && /^[a-z-]+$/iu.test(value));
    const selector = node.target.length === 1 && typeof node.target[0] === "string" ? node.target[0] : null;
    const fact = await page.evaluate(selector => {
      if (!selector) return { status: "unsupported-target" };
      const found = document.querySelectorAll(selector);
      if (found.length !== 1 || !found[0].closest("dialog[open]")) return { status: "unmatched-target" };
      const element = found[0], rect = element.getBoundingClientRect();
      const viewport = { width: innerWidth, height: innerHeight };
      const left = Math.max(0, Math.floor(rect.left));
      const top = Math.max(0, Math.floor(rect.top));
      const right = Math.min(viewport.width, Math.ceil(rect.right));
      const bottom = Math.min(viewport.height, Math.ceil(rect.bottom));
      const style = getComputedStyle(element);
      const layers = [];
      for (let current = element; current && layers.length < 20; current = current.parentElement) {
        const painted = getComputedStyle(current);
        layers.push({
          tag: current.tagName.toLowerCase(), background: painted.backgroundColor, opacity: painted.opacity,
          image: painted.backgroundImage !== "none", blend: painted.mixBlendMode,
          filter: painted.filter !== "none" || painted.backdropFilter !== "none",
        });
      }
      return {
        status: right > left && bottom > top ? "visible" : "outside-viewport",
        theme: document.documentElement.className.includes("theme-dark") || getComputedStyle(element).colorScheme === "dark" ? "dark" : "light",
        tag: element.tagName.toLowerCase(), disabled: element.matches(":disabled") || Boolean(element.closest('[aria-disabled="true"]')),
        foreground: style.color, fill: style.webkitTextFillColor, fontSize: style.fontSize, fontWeight: style.fontWeight, layers,
        clip: right > left && bottom > top ? { x: left + scrollX, y: top + scrollY, width: right - left, height: bottom - top } : null,
      };
    }, selector);
    const record = { index: index + 1, selector, checkKeys, ...fact };
    if (fact.clip) {
      const target = page.locator(selector);
      const prefix = ["contrast", locale, project, index + 1].join("-");
      const screenshot = suffix => page.screenshot({ path: join(output, prefix + "-" + suffix + ".png"), clip: fact.clip, scale: "css", timeout: 4000 });
      await screenshot("rendered");
      const prior = await target.evaluate(element => {
        const property = "-webkit-text-fill-color";
        const before = [element.style.getPropertyValue(property), element.style.getPropertyPriority(property)];
        element.style.setProperty(property, "transparent", "important");
        return before;
      });
      try {
        await screenshot("backdrop");
      } finally {
        await target.evaluate((element, [value, priority]) => {
          if (value) element.style.setProperty("-webkit-text-fill-color", value, priority);
          else element.style.removeProperty("-webkit-text-fill-color");
        }, prior);
      }
      record.captures = prefix;
    }
    records.push(record);
  }
  return records;
}

for (const Builder of new Set([AxeBuilder, commonjsBuilder])) {
  const analyze = Builder.prototype.analyze;
  Builder.prototype.analyze = async function (...args) {
    const line = stackLine(new Error().stack);
    const results = await analyze.apply(this, args);
    if (axeLines.includes(line)) {
      const incomplete = results.incomplete.filter(rule => ruleIds.has(rule.id))
        .map(rule => ({ rule: rule.id, nodes: rule.nodes.length }));
      const nodes = line === axeLines[0] ? results.incomplete.find(rule => rule.id === "color-contrast")?.nodes ?? [] : [];
      const contrast = nodes.length ? await captureContrast(this.page, nodes) : [];
      await test.info().attach("qa-axe-incomplete", {
        contentType: "application/json",
        body: JSON.stringify({ line, incomplete, incompleteCount: results.incomplete.length, contrast }),
      });
    }
    return results;
  };
}
