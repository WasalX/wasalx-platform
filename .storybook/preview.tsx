import type { Preview } from "@storybook/react-vite";
import type { ReactNode } from "react";
import "../app/design-system/tokens.css";
import "../app/design-system/primitives.css";
import "./storybook.css";

const preview: Preview = {
  decorators: [
    (Story, context) => {
      const theme = context.globals.theme === "dark" ? "theme-dark" : "theme-light";
      return (
        <div className={`${theme} wx-design-system wx-story-canvas`}>
          <Story />
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
