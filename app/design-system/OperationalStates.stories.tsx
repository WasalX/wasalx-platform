import type { Meta, StoryObj } from "@storybook/react-vite";
import { DataPanel, OperationalState, type DataRow } from "./primitives";

const sparseRows: DataRow[] = [
  { reference: "ABC0001245", destination: "Dammam operations", state: "Working" },
];

const denseRows: DataRow[] = [
  { reference: "ABC0001245", destination: "Dammam operations", state: "Working" },
  { reference: "ABC0001246", destination: "Riyadh dispatch", state: "Retrying" },
  { reference: "ABC0001247", destination: "Jeddah returns", state: "Action required" },
  { reference: "ABC0001248", destination: "Dammam operations", state: "Working" },
  { reference: "ABC0001249", destination: "Riyadh dispatch", state: "Working" },
  { reference: "ABC0001250", destination: "Jeddah returns", state: "Retrying" },
];

function EmptyState() {
  return <OperationalState actionLabel="Connect WhatsApp" description="Connect a number, then select the operational groups WasalX should manage." kind="empty" onAction={() => undefined} title="No connections yet" />;
}

function PartialFailureState() {
  return <OperationalState actionLabel="Retry failed records" description="12 deliveries completed and 2 need another attempt. Completed work is preserved." kind="partial" onAction={() => undefined} title="Some deliveries need attention" />;
}

function FatalErrorState() {
  return <OperationalState actionLabel="Reload health" description="WasalX could not verify this workspace. No messages were sent while health was unknown." kind="fatal" onAction={() => undefined} title="Workspace health unavailable" />;
}

function RecoveryState() {
  return <OperationalState actionLabel="View activity" description="The connection recovered automatically. Queued messages are moving again." kind="recovery" onAction={() => undefined} title="Connection restored" />;
}

function OperationalStateMatrix() {
  return (
    <main className="wx-story-section">
      <header>
        <small>OPERATIONAL STATES</small>
        <h1>No dead ends</h1>
        <p>Geometry stays stable while loading, data density scales cleanly, and every failure explains what happened and what to do next.</p>
      </header>
      <div className="wx-state-showcase">
        <OperationalState description="Checking provider and case service health without shifting the final layout." kind="loading" title="Loading workspace" />
        <EmptyState />
        <DataPanel rows={sparseRows} title="Sparse delivery queue" />
        <DataPanel density="dense" rows={denseRows} title="Dense delivery queue" />
        <PartialFailureState />
        <FatalErrorState />
        <RecoveryState />
      </div>
    </main>
  );
}

const meta = {
  title: "Design system/Operational states",
  component: OperationalState,
  tags: ["autodocs", "visual"],
  args: {
    description: "Checking the latest provider and case service health.",
    kind: "loading",
    title: "Loading workspace",
  },
  parameters: {
    docs: {
      description: {
        component: "Required loading, empty, sparse, dense, partial-failure, fatal-error, and recovery patterns.",
      },
    },
  },
} satisfies Meta<typeof OperationalState>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
};

export const Empty: Story = { render: () => <EmptyState /> };
export const Sparse: Story = { render: () => <DataPanel rows={sparseRows} title="Sparse delivery queue" /> };
export const Dense: Story = { render: () => <DataPanel density="dense" rows={denseRows} title="Dense delivery queue" /> };
export const PartialFailure: Story = { render: () => <PartialFailureState /> };
export const FatalError: Story = { render: () => <FatalErrorState /> };
export const Recovery: Story = { render: () => <RecoveryState /> };

export const StateMatrixLight: Story = {
  globals: { theme: "light" },
  render: () => <OperationalStateMatrix />,
};

export const StateMatrixDark: Story = {
  globals: { theme: "dark" },
  render: () => <OperationalStateMatrix />,
};
