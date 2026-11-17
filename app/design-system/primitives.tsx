import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "secondary" | "primary" | "danger";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean;
  variant?: ButtonVariant;
};

export function Button({
  children,
  className = "",
  disabled,
  loading = false,
  type = "button",
  variant = "secondary",
  ...props
}: ButtonProps) {
  const variantClass = variant === "secondary" ? "" : ` wx-button-${variant}`;
  return (
    <button
      {...props}
      aria-busy={loading || undefined}
      className={`wx-button${variantClass}${className ? ` ${className}` : ""}`}
      data-loading={loading || undefined}
      disabled={disabled || loading}
      type={type}
    >
      {loading ? <span aria-hidden="true" className="wx-spinner" /> : null}
      <span>{children}</span>
    </button>
  );
}

export type StatusTone = "neutral" | "success" | "warning" | "danger";

export function StatusBadge({ children, tone = "neutral" }: { children: ReactNode; tone?: StatusTone }) {
  return <span className={`wx-status wx-status-${tone}`}>{children}</span>;
}

export type OperationalStateKind = "loading" | "empty" | "partial" | "fatal" | "recovery";

const stateIcon: Record<OperationalStateKind, string> = {
  loading: "…",
  empty: "○",
  partial: "!",
  fatal: "×",
  recovery: "✓",
};

export function OperationalState({
  actionLabel,
  description,
  kind,
  onAction,
  title,
}: {
  actionLabel?: string;
  description: string;
  kind: OperationalStateKind;
  onAction?: () => void;
  title: string;
}) {
  return (
    <section
      aria-busy={kind === "loading" || undefined}
      aria-live={kind === "fatal" || kind === "partial" ? "assertive" : "polite"}
      className="wx-state-panel"
      data-kind={kind}
      role={kind === "fatal" ? "alert" : "status"}
    >
      <div className="wx-state-content">
        <span aria-hidden="true" className="wx-state-icon">{stateIcon[kind]}</span>
        <h3>{title}</h3>
        <p>{description}</p>
        {kind === "loading" ? (
          <span aria-hidden="true" className="wx-skeleton-stack">
            <span />
            <span />
            <span />
          </span>
        ) : null}
        {actionLabel && onAction ? <Button onClick={onAction}>{actionLabel}</Button> : null}
      </div>
    </section>
  );
}

export type DataRow = {
  reference: string;
  destination: string;
  state: "Working" | "Retrying" | "Action required";
};

function statusToneForRow(state: DataRow["state"]): StatusTone {
  if (state === "Working") return "success";
  if (state === "Retrying") return "warning";
  return "danger";
}

export function DataPanel({ density = "sparse", rows, title }: { density?: "sparse" | "dense"; rows: DataRow[]; title: string }) {
  return (
    <section className={`wx-data-panel wx-data-panel-${density}`}>
      <header>
        <h3>{title}</h3>
        <StatusBadge>{rows.length} records</StatusBadge>
      </header>
      <table>
        <caption className="wx-visually-hidden">{title}</caption>
        <thead>
          <tr>
            <th scope="col">Reference</th>
            <th scope="col">Destination</th>
            <th scope="col">State</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.reference}>
              <td><code>{row.reference}</code></td>
              <td>{row.destination}</td>
              <td><StatusBadge tone={statusToneForRow(row.state)}>{row.state}</StatusBadge></td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
