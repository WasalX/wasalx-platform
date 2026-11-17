export const definitions=[
  {
    "id": "tenant-navigation/responsive-collapse-pin-and-workspace-switch::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ]
  },
  {
    "id": "tenant-navigation/responsive-collapse-pin-and-workspace-switch::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ]
  },
  {
    "id": "tenant-navigation/responsive-collapse-pin-and-workspace-switch::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ]
  },
  {
    "id": "tenant-navigation/responsive-collapse-pin-and-workspace-switch::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ]
  },
  {
    "id": "tenant-navigation/responsive-collapse-pin-and-workspace-switch::ui-quality::empty",
    "expectedResults": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ]
  },
  {
    "id": "tenant-navigation/responsive-collapse-pin-and-workspace-switch::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ]
  },
  {
    "id": "tenant-navigation/routes-deep-links-and-history::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ]
  },
  {
    "id": "tenant-navigation/routes-deep-links-and-history::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ]
  },
  {
    "id": "tenant-navigation/routes-deep-links-and-history::ui-quality::keyboard-focus",
    "expectedResults": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ]
  },
  {
    "id": "tenant-navigation/routes-deep-links-and-history::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ]
  },
  {
    "id": "tenant-navigation/routes-deep-links-and-history::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ]
  },
  {
    "id": "tenant-navigation/routes-deep-links-and-history::ui-quality::empty",
    "expectedResults": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ]
  },
  {
    "id": "tenant-navigation/routes-deep-links-and-history::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ]
  }
];
