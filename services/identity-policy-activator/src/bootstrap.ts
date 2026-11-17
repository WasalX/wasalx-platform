const { startNodeObservability } = await import("@wasalx/observability/node");
startNodeObservability({ serviceName: "wasalx-identity-policy-activator" });
await import("./main.js");

export {};
