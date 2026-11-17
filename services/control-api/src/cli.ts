const [command = "serve", ...arguments_] = process.argv.slice(2);

if (command === "serve") {
  const { startNodeObservability } = await import("@wasalx/observability/node");
  startNodeObservability({ serviceName: "wasalx-control-api" });
  await import("./main.js");
} else if (command === "migrate") {
  const pathIndex = arguments_.indexOf("--path");
  const migrationsPath = pathIndex >= 0 ? arguments_[pathIndex + 1] : undefined;
  if (!migrationsPath) throw new Error("migrate requires --path <directory>");
  const { migrate } = await import("./migrate.js");
  await migrate(migrationsPath);
} else if (command === "admit-commercial-go") {
  const { runCommercialGoAdmission } = await import("./commercial-go-admission.js");
  await runCommercialGoAdmission();
} else {
  throw new Error(`Unknown control API command: ${command}`);
}
