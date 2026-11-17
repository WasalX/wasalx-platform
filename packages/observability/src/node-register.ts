import { startNodeObservability } from "./node.js";

startNodeObservability({
  serviceName: process.env.OTEL_SERVICE_NAME ?? "wasalx-node-service",
});
