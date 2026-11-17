import { defineConfig } from "vite";

// Storybook renders browser-only primitives and must not inherit the product's
// React Server Components, Cloudflare, Vinext, or Sites runtime plugins.
export default defineConfig({});
