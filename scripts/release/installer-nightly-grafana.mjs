import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";

const dataSource = "/api/datasources/uid/jaeger";

function run(command, args, options) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function checkGrafanaJaeger(composeArgs, execute = run) {
  async function probe(path, valid) {
    // Grafana is on an internal network. Read the admin credentials inside its container.
    const stdout = await execute("docker", [...composeArgs, "exec", "-T", "grafana", "curl",
      "--disable", "--silent", "--max-time", "10",
      "--variable", "%GF_SECURITY_ADMIN_USER", "--variable", "%GF_SECURITY_ADMIN_PASSWORD",
      "--expand-user", "{{GF_SECURITY_ADMIN_USER}}:{{GF_SECURITY_ADMIN_PASSWORD}}",
      "--write-out", "\n%{http_code}", `http://127.0.0.1:3000${path}`,
    ], { timeout: 10_000, windowsHide: true }).catch(() => null);
    if (stdout === null) return `${path} was unreachable or timed out`;
    const status = stdout.slice(-3);
    if (stdout.at(-4) !== "\n" || !/^[1-5]\d\d$/u.test(status)) return `${path} returned no HTTP status`;
    if (!status.startsWith("2")) return `${path} returned HTTP ${status}`;
    try {
      if (valid(JSON.parse(stdout.slice(0, -4)))) return null;
    } catch {
      // Response text can contain sensitive details.
    }
    return `${path} returned an unexpected body`;
  }

  // The Jaeger UID, type and upstream URL come from Grafana's checked-in provisioning.
  const provisioned = await probe(dataSource, (body) => body?.type === "jaeger" && body?.url === "http://jaeger:16686");
  if (provisioned) throw new Error(provisioned);

  // Grafana's Jaeger resource handler calls Jaeger's HTTP /api/services by default.
  // https://github.com/grafana/grafana/blob/v13.1.0/pkg/tsdb/jaeger/callresource.go#L14-L45
  const failures = (await Promise.all([
    probe(`${dataSource}/health`, (body) => body?.status === "OK"),
    probe(`${dataSource}/resources/services`, (body) => Array.isArray(body) && body.every((name) => typeof name === "string" && name.trim())),
  ])).filter(Boolean);
  if (failures.length) throw new Error(failures.join(", "));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    await checkGrafanaJaeger(process.argv.slice(2));
    console.log("Grafana -> Jaeger smoke passed (data source health and services API)");
  } catch (error) {
    console.error(`::error::Grafana -> Jaeger smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}
