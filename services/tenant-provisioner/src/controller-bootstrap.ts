const { startNodeObservability } = await import("@wasalx/observability/node");
startNodeObservability({ serviceName: "wasalx-tenant-workspace-controller" });
await import("./controller-main.js");

export {};
