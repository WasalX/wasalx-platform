export const definitions=[
  {
    "id": "connections/create-bind-test-and-health::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ]
  },
  {
    "id": "connections/create-bind-test-and-health::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ]
  },
  {
    "id": "connections/create-bind-test-and-health::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ]
  },
  {
    "id": "connections/create-bind-test-and-health::ui-quality::keyboard-focus",
    "expectedResults": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ]
  },
  {
    "id": "connections/create-bind-test-and-health::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ]
  },
  {
    "id": "connections/create-bind-test-and-health::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ]
  },
  {
    "id": "connections/create-bind-test-and-health::ui-quality::empty",
    "expectedResults": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ]
  },
  {
    "id": "connections/create-bind-test-and-health::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ]
  },
  {
    "id": "connections/disconnect-reconnect-and-secret-retirement::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ]
  },
  {
    "id": "connections/disconnect-reconnect-and-secret-retirement::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ]
  },
  {
    "id": "connections/disconnect-reconnect-and-secret-retirement::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ]
  },
  {
    "id": "connections/disconnect-reconnect-and-secret-retirement::ui-quality::keyboard-focus",
    "expectedResults": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ]
  },
  {
    "id": "connections/disconnect-reconnect-and-secret-retirement::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ]
  },
  {
    "id": "connections/disconnect-reconnect-and-secret-retirement::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ]
  },
  {
    "id": "connections/disconnect-reconnect-and-secret-retirement::ui-quality::empty",
    "expectedResults": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ]
  },
  {
    "id": "connections/disconnect-reconnect-and-secret-retirement::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ]
  },
  {
    "id": "provider-live-contracts/gows-group-direct-pairing-reconnect-and-delivery::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ]
  },
  {
    "id": "provider-live-contracts/gows-group-direct-pairing-reconnect-and-delivery::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ]
  },
  {
    "id": "provider-live-contracts/gows-group-direct-pairing-reconnect-and-delivery::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ]
  },
  {
    "id": "provider-live-contracts/gows-group-direct-pairing-reconnect-and-delivery::ui-quality::keyboard-focus",
    "expectedResults": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ]
  },
  {
    "id": "provider-live-contracts/gows-group-direct-pairing-reconnect-and-delivery::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ]
  },
  {
    "id": "provider-live-contracts/gows-group-direct-pairing-reconnect-and-delivery::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ]
  },
  {
    "id": "provider-live-contracts/gows-group-direct-pairing-reconnect-and-delivery::ui-quality::empty",
    "expectedResults": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ]
  },
  {
    "id": "provider-live-contracts/gows-group-direct-pairing-reconnect-and-delivery::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ]
  },
  {
    "id": "provider-live-contracts/meta-direct-webhook-template-window-and-delivery::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ]
  },
  {
    "id": "provider-live-contracts/meta-direct-webhook-template-window-and-delivery::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ]
  },
  {
    "id": "provider-live-contracts/meta-direct-webhook-template-window-and-delivery::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ]
  },
  {
    "id": "provider-live-contracts/meta-direct-webhook-template-window-and-delivery::ui-quality::keyboard-focus",
    "expectedResults": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ]
  },
  {
    "id": "provider-live-contracts/meta-direct-webhook-template-window-and-delivery::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ]
  },
  {
    "id": "provider-live-contracts/meta-direct-webhook-template-window-and-delivery::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ]
  },
  {
    "id": "provider-live-contracts/meta-direct-webhook-template-window-and-delivery::ui-quality::empty",
    "expectedResults": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ]
  },
  {
    "id": "provider-live-contracts/meta-direct-webhook-template-window-and-delivery::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ]
  }
];
