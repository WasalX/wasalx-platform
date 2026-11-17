import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
  stories: ["../app/design-system/**/*.stories.@(ts|tsx)"],
  addons: ["@storybook/addon-docs", "@storybook/addon-a11y"],
  framework: {
    name: "@storybook/react-vite",
    options: {},
  },
  staticDirs: ["../public"],
  docs: {
    autodocs: "tag",
  },
  core: {
    builder: {
      name: "@storybook/builder-vite",
      options: {
        // The product Vite config contains React Server Components and Sites
        // plugins. Storybook is intentionally a client-only component lab.
        viteConfigPath: ".storybook/vite.storybook-isolated.ts",
      },
    },
    disableTelemetry: true,
  },
  features: {
    developmentModeForBuild: true,
  },
};

export default config;
