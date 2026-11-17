import { addons } from "storybook/manager-api";
import { create } from "storybook/theming";

addons.setConfig({
  theme: create({
    base: "dark",
    brandTitle: "WasalX design system",
    brandUrl: "/",
    colorPrimary: "#8c7cf4",
    colorSecondary: "#8c7cf4",
    appBg: "#09090b",
    appContentBg: "#111113",
    appPreviewBg: "#09090b",
    appBorderColor: "#29292e",
    appBorderRadius: 8,
    textColor: "#f3f3f5",
    textInverseColor: "#18181b",
    barTextColor: "#92929d",
    barSelectedColor: "#8c7cf4",
    barHoverColor: "#f3f3f5",
    barBg: "#111113",
    inputBg: "#161619",
    inputBorder: "#3a3a42",
    inputTextColor: "#f3f3f5",
    inputBorderRadius: 6,
    fontBase: '"Geist Sans", ui-sans-serif, system-ui, sans-serif',
    fontCode: '"Geist Mono", ui-monospace, monospace',
  }),
});
