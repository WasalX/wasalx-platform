"use client";

import { useLayoutEffect, useRef } from "react";

type Props = Omit<React.ComponentPropsWithoutRef<"dialog">, "open"> & {
  close: () => void;
  focusVersion?: unknown;
};

const closeRequestAttributes = { closedby: "closerequest" } as const;

const focusableControlSelector = [
  "a[href]",
  "summary",
  "button:not(:disabled)",
  "input:not(:disabled)",
  "select:not(:disabled)",
  "textarea:not(:disabled)",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableControls(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLElement>(focusableControlSelector)]
    .filter((control) => !control.closest("[inert],[aria-hidden='true']") && control.getClientRects().length > 0);
}

function isolateSiblings(target: HTMLElement, boundary: HTMLElement) {
  const states: Array<{ element: HTMLElement; inert: boolean }> = [];
  let current = target;
  while (current !== boundary) {
    const parent = current.parentElement;
    if (!parent) break;
    for (const sibling of parent.children) {
      if (sibling === current || !(sibling instanceof HTMLElement)) continue;
      states.push({ element: sibling, inert: sibling.inert });
      sibling.inert = true;
    }
    current = parent;
  }
  return () => {
    for (const { element, inert } of states.reverse()) element.inert = inert;
  };
}

export function ModalDialog({
  close,
  focusVersion,
  children,
  onCancel,
  onClose,
  ...props
}: Props) {
  const modalRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(close);

  useLayoutEffect(() => {
    closeRef.current = close;
  }, [close]);

  useLayoutEffect(() => {
    const modal = modalRef.current;
    if (!modal) return;

    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let restoreIsolation: () => void = () => undefined;
    if (typeof modal.showModal === "function") modal.showModal();
    else {
      modal.setAttribute("open", "");
      restoreIsolation = isolateSiblings(modal, document.body);
    }

    const initialFocus =
      modal.querySelector<HTMLElement>("[data-modal-initial-focus]") ??
      modal.querySelector<HTMLElement>("[data-modal-cancel]") ??
      modal.querySelector<HTMLElement>(".modal-actions .secondary:not(:disabled)") ??
      modal.querySelector<HTMLElement>(".modal-head > button:not(:disabled)") ??
      modal.querySelector<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]");
    initialFocus?.focus({ preventScroll: true });

    const retainFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusableControls(modal);
      if (!controls.length) {
        event.preventDefault();
        modal.focus({ preventScroll: true });
        return;
      }
      const first = controls[0]!;
      const last = controls.at(-1)!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !controls.includes(active as HTMLElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !controls.includes(active as HTMLElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    modal.addEventListener("keydown", retainFocus);

    const restoreFocus = () => {
      const target = previousFocus?.isConnected
        ? previousFocus
        : document.querySelector<HTMLElement>("main h1");
      if (target?.isConnected) target.focus({ preventScroll: true });
    };
    return () => {
      // Avoid dispatching a close event during React Strict Mode's effect rehearsal.
      if (modal.open) modal.removeAttribute("open");
      modal.removeEventListener("keydown", retainFocus);
      restoreIsolation();
      restoreFocus();
      queueMicrotask(() => {
        if (!modal.isConnected) restoreFocus();
      });
    };
  }, []);

  useLayoutEffect(() => {
    if (focusVersion === undefined) return;
    modalRef.current?.querySelector<HTMLElement>("[data-modal-initial-focus]")?.focus({ preventScroll: true });
  }, [focusVersion]);

  return (
    <dialog
      {...props}
      {...closeRequestAttributes}
      ref={modalRef}
      aria-modal="true"
      onCancel={(event) => {
        onCancel?.(event);
        if (event.defaultPrevented) return;
        event.preventDefault();
        close();
      }}
      onClose={(event) => {
        onClose?.(event);
      }}
    >
      {children}
    </dialog>
  );
}

type InlineConfirmationProps = Omit<React.ComponentPropsWithoutRef<"div">, "onKeyDown"> & {
  cancel: () => void;
  busy?: boolean;
};

export function InlineConfirmation({
  cancel,
  busy = false,
  children,
  ...props
}: InlineConfirmationProps) {
  const confirmationRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef(cancel);
  const busyRef = useRef(busy);

  useLayoutEffect(() => {
    cancelRef.current = cancel;
    busyRef.current = busy;
  }, [busy, cancel]);

  useLayoutEffect(() => {
    const confirmation = confirmationRef.current;
    if (busy && confirmation?.contains(document.activeElement) && document.activeElement instanceof HTMLButtonElement && document.activeElement.disabled) {
      confirmation.focus({ preventScroll: true });
    }
  }, [busy]);

  useLayoutEffect(() => {
    const confirmation = confirmationRef.current;
    if (!confirmation) return;
    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const enclosingDialog = confirmation.closest("dialog");
    const restoreIsolation = isolateSiblings(
      confirmation,
      confirmation.closest("dialog") ?? document.body,
    );
    const initialFocus =
      confirmation.querySelector<HTMLElement>("[data-inline-confirm-initial-focus]") ??
      focusableControls(confirmation)[0];
    (initialFocus ?? confirmation).focus({ preventScroll: true });
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (!busyRef.current) cancelRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusableControls(confirmation);
      if (!controls.length) {
        event.preventDefault();
        confirmation.focus({ preventScroll: true });
        return;
      }
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && (document.activeElement === first || !confirmation.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !confirmation.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    confirmation.addEventListener("keydown", handleEscape);
    return () => {
      confirmation.removeEventListener("keydown", handleEscape);
      restoreIsolation();
      queueMicrotask(() => {
        if (enclosingDialog && !enclosingDialog.isConnected) return;
        const target = previousFocus?.isConnected
          ? previousFocus
          : document.querySelector<HTMLElement>("main h1");
        target?.focus({ preventScroll: true });
      });
    };
  }, []);

  return (
    <div
      {...props}
      ref={confirmationRef}
      aria-modal="true"
      aria-busy={busy || undefined}
      role="alertdialog"
      tabIndex={props.tabIndex ?? -1}
    >
      {children}
    </div>
  );
}
