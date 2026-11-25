import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { test } from "@playwright/test";
import { axeLines, stackLine } from "./meta-cost-reporter.mjs";

const require = createRequire(import.meta.url);
const commonjsBuilder = require("@axe-core/playwright");
const requireAxe = createRequire(require.resolve("@axe-core/playwright"));
const ruleIds = new Set(requireAxe("axe-core").getRules().map(rule => rule.ruleId));

async function cropScreenshot(page, clip, filename) {
  const rendered = await page.screenshot({ scale: "css", timeout: 4000 });
  const crop = await page.evaluate(async ({ png, clip }) => {
    const bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(png), char => char.charCodeAt(0))], { type: "image/png" }));
    const x = Math.max(0, Math.floor(clip.x)), y = Math.max(0, Math.floor(clip.y));
    const right = Math.min(bitmap.width, Math.ceil(clip.x + clip.width));
    const bottom = Math.min(bitmap.height, Math.ceil(clip.y + clip.height));
    if (right <= x || bottom <= y) return null;
    const canvas = document.createElement("canvas");
    canvas.width = right - x;
    canvas.height = bottom - y;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, x, y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/png").split(",")[1];
  }, { png: rendered.toString("base64"), clip });
  if (!crop) throw new Error("Empty visible contrast crop");
  await writeFile(filename, Buffer.from(crop, "base64"), { flag: "wx" });
}

function revealText(element) {
  const scrollParents = [];
  for (let current = element.parentElement; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (/(auto|scroll)/u.test(style.overflowX + style.overflowY)) scrollParents.push(current);
  }
  const originalScroll = scrollParents.map(parent => [parent.scrollLeft, parent.scrollTop]);
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const text = document.createRange();
  while (walker.nextNode()) {
    if (!walker.currentNode.textContent.trim()) continue;
    text.selectNodeContents(walker.currentNode);
    if (text.getBoundingClientRect().width) break;
  }
  const textBox = () => text.getBoundingClientRect().width ? text.getBoundingClientRect() : element.getBoundingClientRect();
  for (const parent of scrollParents) {
    const rect = textBox(), frame = parent.getBoundingClientRect();
    parent.scrollBy({
      left: (rect.left + rect.right - frame.left - frame.right) / 2,
      top: (rect.top + rect.bottom - frame.top - frame.bottom) / 2,
      behavior: "instant",
    });
  }
  const rect = textBox();
  const viewport = visualViewport;
  const left = rect.left - (viewport?.offsetLeft ?? 0), top = rect.top - (viewport?.offsetTop ?? 0);
  const x = Math.max(0, left), y = Math.max(0, top);
  const width = Math.min(viewport?.width ?? innerWidth, left + rect.width) - x;
  const height = Math.min(viewport?.height ?? innerHeight, top + rect.height) - y;
  const property = "-webkit-text-fill-color";
  return {
    originalScroll, rootScroll: [scrollX, scrollY],
    inline: [element.style.getPropertyValue(property), element.style.getPropertyPriority(property)],
    visibleText: width > 0 && height > 0 ? { x, y, width, height } : null,
  };
}

function restoreText(element, capture) {
  const property = "-webkit-text-fill-color";
  if (capture.inline[0]) element.style.setProperty(property, ...capture.inline);
  else element.style.removeProperty(property);
  let offset = 0;
  for (let current = element.parentElement; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (!/(auto|scroll)/u.test(style.overflowX + style.overflowY)) continue;
    const [left, top] = capture.originalScroll[offset++];
    current.scrollTo({ left, top, behavior: "instant" });
  }
  scrollTo({ left: capture.rootScroll[0], top: capture.rootScroll[1], behavior: "instant" });
}

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
    if (!["unmatched-target", "unsupported-target"].includes(fact.status)) {
      const target = page.locator(selector);
      const prefix = ["contrast", locale, project, index + 1].join("-");
      let capture, stage = "reveal";
      try {
        capture = await target.evaluate(revealText, undefined, { timeout: 3000 });
        if (!capture.visibleText) {
          record.status = "text-outside-viewport";
        } else {
          stage = "rendered";
          await cropScreenshot(page, capture.visibleText, join(output, prefix + "-rendered.png"));
          stage = "backdrop";
          await target.evaluate(element => element.style.setProperty("-webkit-text-fill-color", "transparent", "important"));
          await cropScreenshot(page, capture.visibleText, join(output, prefix + "-backdrop.png"));
          record.captures = prefix;
          record.visibleText = capture.visibleText;
          record.status = "captured";
        }
      } catch (error) {
        record.captureFailure = { stage, type: error.name };
      } finally {
        if (capture) await target.evaluate(restoreText, capture, { timeout: 3000 });
      }
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
