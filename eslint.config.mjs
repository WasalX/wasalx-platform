import { defineConfig, globalIgnores } from "eslint/config";
import eslint from "@eslint/js";
import next from "@next/eslint-plugin-next";
import jsxA11y from "eslint-plugin-jsx-a11y";
import react from "eslint-plugin-react";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const eslintConfig = defineConfig([
  globalIgnores([
    ".next/**",
    "dist/**",
    "**/dist/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat["jsx-runtime"],
  reactHooks.configs.flat["recommended-latest"],
  jsxA11y.flatConfigs.recommended,
  {
    rules: {
      // Named scroll regions take focus so keyboard users can scroll them (ScrollRegion in app/tenant-ui.tsx).
      "jsx-a11y/no-noninteractive-tabindex": ["error", { tags: [], roles: ["tabpanel", "region"], allowExpressionValues: true }],
      // list-style:none can hide list semantics in Safari/VoiceOver, so styled lists keep role="list".
      "jsx-a11y/no-redundant-roles": ["error", { ul: ["list"], ol: ["list"] }],
    },
  },
  next.configs["core-web-vitals"],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.serviceworker,
      },
    },
    settings: {
      react: {
        version: "detect",
      },
    },
  },
  {
    files: ["{app,components,lib,packages,services}/**/*.{js,mjs,cjs,ts,tsx,jsx,mts,cts}"],
    // The shared logger uses the console as a structured sink outside Node.
    ignores: ["packages/observability/src/index.ts"],
    rules: { "no-console": "error" },
  },
  {
    files: ["zammad-package/app/frontend/**/*.ts"],
    rules: {
      // Zammad's Vue composables support calls inside event callbacks.
      "react-hooks/rules-of-hooks": "off",
    },
  },
]);

export default eslintConfig;
