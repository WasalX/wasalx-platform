export const portalPinnedQualityDefinitions=[
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::loading::portal",
    "historicalTestId": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::loading",
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet"
    ],
    "requirements": [
      "pinned-version-media-and-history-render"
    ],
    "expected": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::safe-error-recovery::portal",
    "historicalTestId": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::safe-error-recovery",
    "requiredContextIds": [
      "agent-en-mobile"
    ],
    "requirements": [
      "pinned-version-media-and-history-render"
    ],
    "expected": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::reload::portal",
    "historicalTestId": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::reload",
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet"
    ],
    "requirements": [
      "pinned-version-media-and-history-render"
    ],
    "expected": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::keyboard-focus::portal",
    "historicalTestId": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::keyboard-focus",
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet"
    ],
    "requirements": [
      "pinned-version-media-and-history-render"
    ],
    "expected": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::console::portal",
    "historicalTestId": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::console",
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet"
    ],
    "requirements": [
      "pinned-version-media-and-history-render"
    ],
    "expected": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::network::portal",
    "historicalTestId": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::network",
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet"
    ],
    "requirements": [
      "pinned-version-media-and-history-render"
    ],
    "expected": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::empty::portal",
    "historicalTestId": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::empty",
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet"
    ],
    "requirements": [
      "pinned-version-media-and-history-render"
    ],
    "expected": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::degraded::portal",
    "historicalTestId": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::degraded",
    "requiredContextIds": [
      "agent-en-mobile"
    ],
    "requirements": [
      "pinned-version-media-and-history-render"
    ],
    "expected": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ]
  }
];
export const portalPinnedQualityIds=portalPinnedQualityDefinitions.map(row=>row.id);
export const portalPinnedQualityChecks=portalPinnedQualityDefinitions.flatMap(row=>row.requiredContextIds.map(contextId=>({testId:row.id,contextId})));
