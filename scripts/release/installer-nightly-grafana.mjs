import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const dataSource = "/api/datasources/uid/jaeger";

export async function checkGrafanaJaeger(compose, mask) {
  const grafana = compose?.services?.grafana;
  const port = grafana?.ports?.find(({ target, host_ip }) => target === 3000 && host_ip === "127.0.0.1")?.published;
  const { GF_SECURITY_ADMIN_USER: user, GF_SECURITY_ADMIN_PASSWORD: password } = grafana?.environment ?? {};
  if (!/^\d{1,5}$/u.test(port ?? "") || typeof user !== "string" || !user ||
    typeof password !== "string" || !password) {
    throw new Error("Grafana loopback port or admin credentials are missing");
  }

  const token = Buffer.from(`${user}:${password}`).toString("base64");
  for (const value of [user, password, token]) mask(value);
  const origin = `http://127.0.0.1:${port}`;
  const options = { headers: { Authorization: `Basic ${token}` }, redirect: "manual" };

  async function probe(path, valid) {
    const response = await fetch(`${origin}${path}`, { ...options, signal: AbortSignal.timeout(10_000) }).catch(() => null);
    if (!response) return `${path} was unreachable or timed out`;
    if (!response.ok) return `${path} returned HTTP ${response.status}`;
    const body = await response.json().catch(() => undefined);
    return valid(body) ? null : `${path} returned an unexpected body`;
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
    let compose;
    try {
      compose = JSON.parse(readFileSync(0, "utf8"));
    } catch {
      throw new Error("could not read the rendered Compose model");
    }
    await checkGrafanaJaeger(compose, (value) => {
      console.log(`::add-mask::${value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A")}`);
    });
    console.log("Grafana -> Jaeger smoke passed (data source health and services API)");
  } catch (error) {
    console.error(`::error::Grafana -> Jaeger smoke failed: ${error.message}`);
    process.exitCode = 1;
  }
}
