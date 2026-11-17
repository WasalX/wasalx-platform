export const definitions=[
  {
    "id": "identity-access/sign-in-session-rotation::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "anonymous-en-desktop",
      "anonymous-en-mobile",
      "anonymous-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "platform_operator-en-desktop",
      "platform_operator-en-mobile",
      "platform_operator-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet"
    ]
  },
  {
    "id": "identity-access/sign-in-session-rotation::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "anonymous-en-desktop",
      "anonymous-en-mobile",
      "anonymous-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "platform_operator-en-desktop",
      "platform_operator-en-mobile",
      "platform_operator-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet"
    ]
  },
  {
    "id": "identity-access/sign-in-session-rotation::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "anonymous-en-desktop",
      "anonymous-en-mobile",
      "anonymous-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "platform_operator-en-desktop",
      "platform_operator-en-mobile",
      "platform_operator-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet"
    ]
  },
  {
    "id": "identity-access/sign-in-session-rotation::ui-quality::keyboard-focus",
    "expectedResults": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "anonymous-en-desktop",
      "anonymous-en-mobile",
      "anonymous-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "platform_operator-en-desktop",
      "platform_operator-en-mobile",
      "platform_operator-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet"
    ]
  },
  {
    "id": "identity-access/sign-in-session-rotation::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "anonymous-en-desktop",
      "anonymous-en-mobile",
      "anonymous-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "platform_operator-en-desktop",
      "platform_operator-en-mobile",
      "platform_operator-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet"
    ]
  },
  {
    "id": "identity-access/sign-in-session-rotation::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "anonymous-en-desktop",
      "anonymous-en-mobile",
      "anonymous-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "platform_operator-en-desktop",
      "platform_operator-en-mobile",
      "platform_operator-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet"
    ]
  },
  {
    "id": "identity-access/sign-in-session-rotation::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ],
    "requiredContextIds": [
      "agent-en-desktop",
      "agent-en-mobile",
      "agent-en-tablet",
      "anonymous-en-desktop",
      "anonymous-en-mobile",
      "anonymous-en-tablet",
      "auditor-en-desktop",
      "auditor-en-mobile",
      "auditor-en-tablet",
      "platform_operator-en-desktop",
      "platform_operator-en-mobile",
      "platform_operator-en-tablet",
      "supervisor-en-desktop",
      "supervisor-en-mobile",
      "supervisor-en-tablet",
      "tenant_admin-en-desktop",
      "tenant_admin-en-mobile",
      "tenant_admin-en-tablet",
      "tenant_owner-en-desktop",
      "tenant_owner-en-mobile",
      "tenant_owner-en-tablet"
    ]
  }
];
