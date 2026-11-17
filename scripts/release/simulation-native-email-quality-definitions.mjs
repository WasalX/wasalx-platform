export const definitions=[
  {
    "id": "native-email-ingress/agent-reply-delivery-and-bounce-handling::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/agent-reply-delivery-and-bounce-handling::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/agent-reply-delivery-and-bounce-handling::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/agent-reply-delivery-and-bounce-handling::ui-quality::keyboard-focus",
    "expectedResults": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/agent-reply-delivery-and-bounce-handling::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/agent-reply-delivery-and-bounce-handling::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/agent-reply-delivery-and-bounce-handling::ui-quality::empty",
    "expectedResults": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/agent-reply-delivery-and-bounce-handling::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/inbound-threading-attachments-and-client-routing::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/inbound-threading-attachments-and-client-routing::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/inbound-threading-attachments-and-client-routing::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/inbound-threading-attachments-and-client-routing::ui-quality::keyboard-focus",
    "expectedResults": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/inbound-threading-attachments-and-client-routing::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/inbound-threading-attachments-and-client-routing::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/inbound-threading-attachments-and-client-routing::ui-quality::empty",
    "expectedResults": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "native-email-ingress/inbound-threading-attachments-and-client-routing::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ],
    "requiredContextIds": [
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  }
];
