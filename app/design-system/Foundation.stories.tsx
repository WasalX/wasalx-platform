import type { Meta, StoryObj } from "@storybook/react-vite";
import { semanticColorTokens, spacingTokens, typographyTokens } from "./catalog";

function TokenReference() {
  return (
    <main className="wx-story-section">
      <header>
        <small>FOUNDATION</small>
        <h1>WasalX design tokens</h1>
        <p>
          Semantic tokens keep the portal quiet, precise, and consistent. Feature code consumes intent such as
          surface, warning, or spacing step; theme-specific values stay here.
        </p>
      </header>
      <div className="wx-story-grid">
        <section className="wx-token-card">
          <h2>Semantic colors</h2>
          <p>Every operational status also carries text or an icon; color is never the only signal.</p>
          <div className="wx-token-list">
            {semanticColorTokens.map(([label, token]) => (
              <div className="wx-token-row" key={token}>
                <span className="wx-color-swatch" style={{ "--swatch": `var(${token})` } as React.CSSProperties}>{label}</span>
                <code>{token}</code>
              </div>
            ))}
          </div>
        </section>
        <section className="wx-token-card">
          <h2>Spacing</h2>
          <p>The constrained 4, 8, 12, 16, 24, 32, 48, and 64 pixel scale is the only spacing source for new UI.</p>
          <div className="wx-token-list">
            {spacingTokens.map((step) => (
              <div className="wx-token-row" key={step}>
                <span className="wx-space-demo" style={{ width: `var(--wx-space-${step})` }} />
                <code>{`--wx-space-${step}`}</code>
              </div>
            ))}
          </div>
        </section>
        <section className="wx-token-card">
          <h2>Typography</h2>
          <p>Geist Sans carries the interface; Geist Mono is reserved for identifiers, times, logs, and technical values.</p>
          <div className="wx-token-list">
            {typographyTokens.map(([label, token]) => (
              <div className="wx-token-row" key={token}>
                <span style={{ fontSize: `var(${token})` }}>{label}</span>
                <code>{token}</code>
              </div>
            ))}
          </div>
        </section>
        <section className="wx-token-card">
          <h2>Shape and motion</h2>
          <p>Controls use 6 px, panels use 8 px, and dialogs use 12 px radii. Motion remains functional and honors reduced motion.</p>
          <div className="wx-token-list">
            <div className="wx-token-row"><span>Control radius</span><code>--wx-radius-control</code></div>
            <div className="wx-token-row"><span>Panel radius</span><code>--wx-radius-panel</code></div>
            <div className="wx-token-row"><span>Dialog radius</span><code>--wx-radius-dialog</code></div>
            <div className="wx-token-row"><span>Transition</span><code>120–200ms</code></div>
          </div>
        </section>
      </div>
    </main>
  );
}

function ThemeParityReference() {
  return (
    <main className="wx-story-section">
      <header style={{ paddingInlineStart: "var(--wx-space-4)" }}>
        <small>THEME CONTRACT</small>
        <h1>Light and dark are peers</h1>
        <p>The same semantic surfaces and statuses are reviewed in both themes before a component is accepted.</p>
      </header>
      <div className="wx-story-grid">
        {(["light", "dark"] as const).map((theme) => (
          <section className={`theme-${theme} wx-design-system wx-story-inline-theme`} key={theme}>
            <div className="wx-token-card">
              <small>{theme.toUpperCase()}</small>
              <h2>Operational surface</h2>
              <p>Primary text, secondary text, borders, selection, and recovery cues remain legible.</p>
              <div className="wx-token-list">
                {semanticColorTokens.slice(0, 8).map(([label, token]) => (
                  <span className="wx-color-swatch" key={token} style={{ "--swatch": `var(${token})` } as React.CSSProperties}>{label}</span>
                ))}
              </div>
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}

const meta = {
  title: "Design system/Foundation",
  component: TokenReference,
  tags: ["autodocs", "visual"],
  parameters: {
    docs: {
      description: {
        component: "Canonical WasalX typography, spacing, radius, motion, and semantic color tokens.",
      },
    },
  },
} satisfies Meta<typeof TokenReference>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LightTokens: Story = {
  globals: { theme: "light" },
};

export const DarkTokens: Story = {
  globals: { theme: "dark" },
};

export const ThemeParity: Story = {
  render: () => <ThemeParityReference />,
};
