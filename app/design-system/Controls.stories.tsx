import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button, StatusBadge } from "./primitives";

type ControlState = "default" | "hover" | "focus" | "disabled" | "loading";

function ControlExample({ state }: { state: ControlState }) {
  return (
    <article className="wx-story-card">
      <small>{state.toUpperCase()}</small>
      <div className="wx-control-preview" data-preview-state={state}>
        <Button disabled={state === "disabled"} loading={state === "loading"} variant="primary">
          {state === "loading" ? "Saving" : "Save rule"}
        </Button>
      </div>
    </article>
  );
}

function ControlStates() {
  const states: ControlState[] = ["default", "hover", "focus", "disabled", "loading"];
  return (
    <main className="wx-story-section">
      <header>
        <small>CONTROLS</small>
        <h1>Complete interaction states</h1>
        <p>Every control ships with visible hover, keyboard focus, disabled, and in-progress behavior.</p>
      </header>
      <div className="wx-story-grid">
        {states.map((state) => <ControlExample key={state} state={state} />)}
        <article className="wx-story-card">
          <small>FIELD FOCUS</small>
          <div className="wx-control-preview" data-preview-state="focus">
            <label className="wx-field">
              <span>Reference prefix</span>
              <input defaultValue="ABC" />
            </label>
          </div>
        </article>
      </div>
      <section className="wx-story-card">
        <small>REDUNDANT STATUS CUES</small>
        <div className="wx-story-grid">
          <StatusBadge tone="success">Working</StatusBadge>
          <StatusBadge tone="warning">Retry scheduled</StatusBadge>
          <StatusBadge tone="danger">Action required</StatusBadge>
          <StatusBadge>Not configured</StatusBadge>
        </div>
      </section>
    </main>
  );
}

const meta = {
  title: "Design system/Controls",
  component: Button,
  tags: ["autodocs", "visual"],
  args: {
    children: "Save rule",
  },
  parameters: {
    docs: {
      description: {
        component: "Token-driven controls with keyboard-visible focus and truthful loading/disabled behavior.",
      },
    },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
export const Hover: Story = { decorators: [(Story) => <div data-preview-state="hover"><Story /></div>] };
export const Focus: Story = { decorators: [(Story) => <div data-preview-state="focus"><Story /></div>] };
export const Disabled: Story = { args: { disabled: true } };
export const Loading: Story = { args: { children: "Saving", loading: true } };
export const Primary: Story = { args: { variant: "primary" } };
export const Danger: Story = { args: { children: "Disconnect", variant: "danger" } };

export const ControlStatesLight: Story = {
  globals: { theme: "light" },
  render: () => <ControlStates />,
};

export const ControlStatesDark: Story = {
  globals: { theme: "dark" },
  render: () => <ControlStates />,
};
