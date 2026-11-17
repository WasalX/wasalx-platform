export const definitions=[
  {
    "id": "cases-deliveries/case-filter-generation-and-detach::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "cases-deliveries/case-filter-generation-and-detach::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "cases-deliveries/delivery-state-retry-and-unknown-outcome-recovery::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "cases-deliveries/delivery-state-retry-and-unknown-outcome-recovery::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "cases-deliveries/exact-case-lookup-and-direct-agent-navigation::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "cases-deliveries/exact-case-lookup-and-direct-agent-navigation::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "cases-deliveries/exact-case-lookup-and-direct-agent-navigation::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop",
      "zammad_agent-en-desktop",
      "zammad_agent-en-mobile",
      "zammad_agent-en-tablet"
    ]
  },
  {
    "id": "workflow-studio/canvas-form-and-restricted-raw-inspection::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  },
  {
    "id": "workflow-studio/canvas-form-and-restricted-raw-inspection::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  },
  {
    "id": "workflow-studio/canvas-form-and-restricted-raw-inspection::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  },
  {
    "id": "workflow-studio/immutable-activation-rollback-and-execution-inspection::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  },
  {
    "id": "workflow-studio/immutable-activation-rollback-and-execution-inspection::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  },
  {
    "id": "workflow-studio/immutable-activation-rollback-and-execution-inspection::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  }
];
