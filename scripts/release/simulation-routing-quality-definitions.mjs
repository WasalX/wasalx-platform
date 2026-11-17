export const definitions=[
  {
    "id": "client-routing/domains-addresses-identifiers-groups-and-manager-mapping::ui-quality::loading",
    "expectedResults": [
      "Loading is distinguishable from empty/error and finishes in the actual success or safe error state.",
      "Dependent actions cannot submit against unresolved data."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  },
  {
    "id": "client-routing/domains-addresses-identifiers-groups-and-manager-mapping::ui-quality::safe-error-recovery",
    "expectedResults": [
      "Feedback is understandable, localized and excludes raw errors or secrets.",
      "Recovery does not silently repeat an uncertain operation or claim success without durable proof."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  },
  {
    "id": "client-routing/domains-addresses-identifiers-groups-and-manager-mapping::ui-quality::reload",
    "expectedResults": [
      "Record identity and durable state remain consistent after reload; no duplicate external effect is created."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  },
  {
    "id": "client-routing/domains-addresses-identifiers-groups-and-manager-mapping::ui-quality::keyboard-focus",
    "expectedResults": [
      "Visible focus follows logical order; controls are keyboard reachable.",
      "Dismissal returns focus to the invoking control and no focus trap remains."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  },
  {
    "id": "client-routing/domains-addresses-identifiers-groups-and-manager-mapping::ui-quality::console",
    "expectedResults": [
      "No unclassified product console/page failure remains; capture errors and tooling failures are separately identified.",
      "No raw private content or credentials enter ordinary logs."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  },
  {
    "id": "client-routing/domains-addresses-identifiers-groups-and-manager-mapping::ui-quality::network",
    "expectedResults": [
      "Each failed request is classified with safe route/status/timing evidence; no failure is silently counted as success.",
      "HTTP200 alone does not substitute for application/durable success; uncertain sends are not retried."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  },
  {
    "id": "client-routing/domains-addresses-identifiers-groups-and-manager-mapping::ui-quality::empty",
    "expectedResults": [
      "No matching records are shown as an empty result, not indefinite loading or a system failure.",
      "The operator can clear the filter or navigate away; no external mutation is needed."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  },
  {
    "id": "client-routing/domains-addresses-identifiers-groups-and-manager-mapping::ui-quality::degraded",
    "expectedResults": [
      "The UI identifies the unavailable capability truthfully without exposing raw errors or secrets.",
      "Actions requiring the unavailable prerequisite remain protected; recovery becomes visible after the prerequisite is restored."
    ],
    "requiredContextIds": [
      "tenant_owner-en-desktop"
    ]
  }
];
