import type { Preview } from "@storybook/react-vite";
import type { ReactNode } from "react";
import { defaultLocale, isLocale, textDirection } from "../lib/i18n/locales";
import "../app/design-system/tokens.css";
import "../app/design-system/primitives.css";
import "./storybook.css";

const preview: Preview = {
  decorators: [
    (Story, context) => {
      const { auditLocale, auditTheme } = context.globals;
      const args = { ...context.args };
      if (isLocale(args.locale) && isLocale(auditLocale)) args.locale = auditLocale;
      const locale = isLocale(args.locale) ? args.locale : defaultLocale;
      const direction = textDirection(isLocale(auditLocale) ? auditLocale : locale);
      const forcedTheme = auditTheme === "light" || auditTheme === "dark";
      const theme = forcedTheme ? auditTheme : context.globals.theme;
      if (forcedTheme && (args.initialTheme === "light" || args.initialTheme === "dark")) {
        args.initialTheme = theme;
      }
      return (
        <div className={`${theme === "dark" ? "theme-dark" : "theme-light"} wx-design-system wx-story-canvas`} lang={locale} dir={direction}>
          {Story({ args })}
        </div>
      );
    },
  ],
  globalTypes: {
    theme: {
      description: "WasalX semantic color theme",
      toolbar: {
        dynamicTitle: true,
        icon: "contrast",
        items: [
          { title: "Light", value: "light" },
          { title: "Dark", value: "dark" },
        ],
      },
    },
  },
  initialGlobals: {
    theme: "light",
    // The hosted audit can exercise pinned stories without changing their defaults.
    auditLocale: "story",
    auditTheme: "story",
  },
  parameters: {
    a11y: {
      test: "error",
    },
    controls: {
      expanded: true,
      sort: "requiredFirst",
    },
    docs: {
      source: { state: "open" },
    },
    layout: "fullscreen",
    options: {
      storySort: {
        order: ["Design system", ["Foundation", "Controls", "Operational states"]],
      },
    },
  },
};

export default preview;

export function ThemeFrame({ children, theme }: { children: ReactNode; theme: "light" | "dark" }) {
  return <div className={`theme-${theme} wx-design-system wx-story-inline-theme`}>{children}</div>;
}
