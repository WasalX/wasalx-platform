import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const requiredStories = [
  "design-system-foundation--light-tokens",
  "design-system-foundation--dark-tokens",
  "design-system-foundation--theme-parity",
  "design-system-controls--default",
  "design-system-controls--hover",
  "design-system-controls--focus",
  "design-system-controls--disabled",
  "design-system-controls--loading",
  "design-system-controls--control-states-light",
  "design-system-controls--control-states-dark",
  "design-system-operational-states--loading",
  "design-system-operational-states--empty",
  "design-system-operational-states--sparse",
  "design-system-operational-states--dense",
  "design-system-operational-states--partial-failure",
  "design-system-operational-states--fatal-error",
  "design-system-operational-states--recovery",
  "design-system-operational-states--state-matrix-light",
  "design-system-operational-states--state-matrix-dark",
  "product-platform-operations--dark",
  "product-platform-operations--light",
];

test("static Storybook publishes every required governance story", async () => {
  const index = JSON.parse(await readFile(new URL("../storybook-static/index.json", import.meta.url), "utf8"));
  const entries = index.entries ?? index.stories ?? {};
  for (const storyId of requiredStories) assert.ok(entries[storyId], `missing built story ${storyId}`);
  assert.ok(Object.values(entries).every((entry) => entry.type === "story" || entry.type === "docs"));
});
