const { startNodeObservability } = await import("@wasalx/observability/node");
startNodeObservability({ serviceName: "wasalx-invitation-mailer" });
await import("./main.js");

export {};
