export const definitions=[
  {
    "id": "direct-automation/choices-location-and-plugin-actions::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/choices-location-and-plugin-actions::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/choices-location-and-plugin-actions::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/choices-location-and-plugin-actions::ui-quality::keyboard-focus",
    "expectedResults": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/choices-location-and-plugin-actions::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/choices-location-and-plugin-actions::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/choices-location-and-plugin-actions::ui-quality::empty",
    "expectedResults": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/choices-location-and-plugin-actions::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/flow-lifecycle-and-exactly-once-processing::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/flow-lifecycle-and-exactly-once-processing::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/flow-lifecycle-and-exactly-once-processing::ui-quality::keyboard-focus",
    "expectedResults": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/flow-lifecycle-and-exactly-once-processing::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/flow-lifecycle-and-exactly-once-processing::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/flow-lifecycle-and-exactly-once-processing::ui-quality::empty",
    "expectedResults": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/flow-lifecycle-and-exactly-once-processing::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/human-handoff-pause-resume-and-bot-return::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/human-handoff-pause-resume-and-bot-return::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/human-handoff-pause-resume-and-bot-return::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/human-handoff-pause-resume-and-bot-return::ui-quality::keyboard-focus",
    "expectedResults": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/human-handoff-pause-resume-and-bot-return::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/human-handoff-pause-resume-and-bot-return::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/human-handoff-pause-resume-and-bot-return::ui-quality::empty",
    "expectedResults": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/human-handoff-pause-resume-and-bot-return::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::keyboard-focus",
    "expectedResults": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::empty",
    "expectedResults": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "direct-automation/version-pinned-outbound-media-and-zammad-history::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  }
];
