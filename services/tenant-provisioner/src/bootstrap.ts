const { startNodeObservability } = await import("@wasalx/observability/node");
startNodeObservability({ serviceName: "wasalx-tenant-provisioner" });
await import("./main.js");

export {};
