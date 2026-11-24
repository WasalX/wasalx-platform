#!/usr/bin/env node
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isIP } from "node:net";

const credentialNames = [
  "WASALX_ADMIN_PASSWORD",
  "WASALX_APP_PASSWORD",
  "WASALX_CONNECTOR_WORKER_DB_PASSWORD",
  "WASALX_SECRET_CLEANUP_DB_PASSWORD",
  "WASALX_PROVISIONING_DB_PASSWORD",
  "WASALX_SUPPORT_DB_PASSWORD",
  "WASALX_WAHA_REGISTRY_DB_PASSWORD",
  "WASALX_WAHA_OPERATOR_DB_PASSWORD",
  "WASALX_WAHA_ROLLOUT_GATE_DB_PASSWORD",
  "WASALX_INVITATION_MAILER_DB_PASSWORD",
  "WASALX_IDENTITY_POLICY_DB_PASSWORD",
  "WASALX_METERING_INGEST_DB_PASSWORD",
  "WASALX_PLATFORM_OPERATIONS_DB_PASSWORD",
  "WASALX_FULL_KEYCLOAK_DB_PASSWORD",
  "WASALX_FULL_ZAMMAD_DB_PASSWORD",
  "WORKER_JOB_JWT_SECRET",
  "METERING_SERVICE_JWT_SECRET",
  "META_VERIFY_TOKEN",
  "SECRET_SIDECAR_TOKEN",
  "SECRET_SIDECAR_WRITE_TOKEN",
  "WASALX_FULL_PORTAL_SESSION_SECRET",
  "WASALX_FULL_PLATFORM_PORTAL_SESSION_SECRET",
  "WASALX_FULL_ZAMMAD_API_TOKEN",
  "WASALX_FULL_ZAMMAD_PRIVACY_TOKEN",
  "WASALX_FULL_ZAMMAD_SERVICE_JWT_SECRET",
  "WASALX_FULL_ZAMMAD_BOOTSTRAP_ADMIN_PASSWORD",
  "WASALX_FULL_ZAMMAD_AGENT_PASSWORD",
  "WASALX_FULL_KEYCLOAK_ADMIN_PASSWORD",
  "WASALX_FULL_KEYCLOAK_SMTP_PASSWORD",
  "WASALX_FULL_QUALIFICATION_OWNER_PASSWORD",
  "WASALX_FULL_ISOLATION_OWNER_PASSWORD",
  "WASALX_FULL_PLATFORM_OPERATOR_PASSWORD",
  "WASALX_FULL_META_APP_SECRET",
  "WASALX_FULL_INVITATION_PRIVATE_KEY_PEM_JSON",
  "WASALX_FULL_INVITATION_EMAIL_PROVIDER_API_KEY",
  "WASALX_FULL_MINIO_ROOT_PASSWORD",
  "WASALX_FULL_WAHA_API_KEY",
  "WASALX_FULL_WAHA_DASHBOARD_PASSWORD",
  "WASALX_FULL_WAHA_SWAGGER_PASSWORD",
  "WASALX_FULL_GRAFANA_ADMIN_PASSWORD",
];
const requiredConfigurationNames = [
  "PUBLIC_WEBHOOK_BASE_URL",
  "WASALX_FULL_INVITATION_EMAIL_PROVIDER_URL",
  "WASALX_FULL_INVITATION_EMAIL_FROM",
  "WASALX_FULL_INVITATION_EMAIL_TEMPLATE_ID",
  "WASALX_FULL_KEYCLOAK_SMTP_HOST",
  "WASALX_FULL_KEYCLOAK_SMTP_PORT",
  "WASALX_FULL_KEYCLOAK_SMTP_FROM",
  "WASALX_FULL_KEYCLOAK_SMTP_USER",
  "WASALX_FULL_QUALIFICATION_OWNER_EMAIL",
  "WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST",
  "WASALX_KEYCLOAK_PASSWORD_RESET_ENABLED",
];
export const fullEnvironmentCredentialNames = [
  ...new Set([...credentialNames, ...requiredConfigurationNames, "DEV_SECRET_STORE_ENCRYPTION_KEY"]),
].sort();

export class FullEnvironmentPreflightError extends Error {
  constructor(variables) {
    super(`Full environment credentials are missing, invalid, or not distinct: ${variables.join(", ")}`);
    this.name = "FullEnvironmentPreflightError";
    this.variables = variables;
  }
}

function collectStrings(environment, names, invalid) {
  return names.flatMap((name) => {
    const value = environment[name];
    if (typeof value !== "string" || value.length === 0) {
      invalid.add(name);
      return [];
    }
    return [[name, Buffer.from(value, "utf8")]];
  });
}

function collectDuplicates(entries, invalid) {
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      if (entries[left][1].equals(entries[right][1])) {
        invalid.add(entries[left][0]);
        invalid.add(entries[right][0]);
      }
    }
  }
}

function validEmailAddress(email) {
  return email.length <= 320 && /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(email);
}

function validMailRecipients(raw) {
  if (raw === "*") return true;
  if (typeof raw !== "string") return false;
  try {
    const recipients = JSON.parse(raw);
    return Array.isArray(recipients) && recipients.every(email =>
      typeof email === "string" && validEmailAddress(email.trim().toLowerCase()));
  } catch {
    return false;
  }
}

export function validateFullEnvironment(environment) {
  const invalid = new Set();
  if (environment.META_APP_ID && !/^\d{5,32}$/u.test(environment.META_APP_ID)) invalid.add("META_APP_ID");
  const entries = collectStrings(environment, credentialNames, invalid);
  collectStrings(environment, requiredConfigurationNames, invalid);
  if (!validMailRecipients(environment.WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST)) {
    invalid.add("WASALX_TEST_EMAIL_RECIPIENT_ALLOWLIST");
  }
  if (!["true", "false"].includes(environment.WASALX_KEYCLOAK_PASSWORD_RESET_ENABLED)) {
    invalid.add("WASALX_KEYCLOAK_PASSWORD_RESET_ENABLED");
  }
  try {
    const webhook = new URL(environment.PUBLIC_WEBHOOK_BASE_URL ?? "");
    if (webhook.protocol !== "https:" || webhook.username || webhook.password || webhook.search || webhook.hash
      || webhook.pathname !== "/" || !webhook.hostname.includes(".")
      || isIP(webhook.hostname.replace(/^\[|\]$/gu, ""))
      || /(?:^|\.)(?:example|invalid|local|localhost|test)$/u.test(webhook.hostname)
      || /(?:^|\.)example\.(?:com|net|org)$/u.test(webhook.hostname)) invalid.add("PUBLIC_WEBHOOK_BASE_URL");
  } catch { invalid.add("PUBLIC_WEBHOOK_BASE_URL"); }
  try {
    const provider = new URL(environment.WASALX_FULL_INVITATION_EMAIL_PROVIDER_URL ?? "");
    const reservedHost = /(?:^|\.)(?:example|invalid|local|localhost|test)$/u.test(provider.hostname)
      || /(?:^|\.)example\.(?:com|net|org)$/u.test(provider.hostname)
      || ["127.0.0.1", "[::1]"].includes(provider.hostname);
    const https = provider.protocol === "https:" && !provider.username && !provider.password && !provider.hash;
    const smtp = ["smtp:", "smtps:"].includes(provider.protocol)
      && !provider.username && !provider.password && !provider.search && !provider.hash
      && (provider.pathname === "" || provider.pathname === "/")
      && ((provider.protocol === "smtp:" && provider.port === "587")
        || (provider.protocol === "smtps:" && provider.port === "465"));
    if (reservedHost || (!https && !smtp)) invalid.add("WASALX_FULL_INVITATION_EMAIL_PROVIDER_URL");
  } catch { invalid.add("WASALX_FULL_INVITATION_EMAIL_PROVIDER_URL"); }
  for (const name of ["WASALX_FULL_INVITATION_EMAIL_FROM", "WASALX_FULL_KEYCLOAK_SMTP_FROM", "WASALX_FULL_QUALIFICATION_OWNER_EMAIL"]) {
    const email = (environment[name] ?? "").trim().toLowerCase();
    const domain = email.slice(email.lastIndexOf("@") + 1);
    if (!validEmailAddress(email)
      || /(?:^|\.)(?:invalid|local|localhost|example|test)$/u.test(domain)
      || /(?:^|\.)example\.(?:com|net|org)$/u.test(domain)) invalid.add(name);
  }
  const smtpPort = environment.WASALX_FULL_KEYCLOAK_SMTP_PORT ?? "";
  if (!/^[1-9]\d{0,4}$/u.test(smtpPort) || Number(smtpPort) > 65_535) invalid.add("WASALX_FULL_KEYCLOAK_SMTP_PORT");
  const encodedKey = environment.DEV_SECRET_STORE_ENCRYPTION_KEY;
  if (typeof encodedKey !== "string" || !/^[A-Za-z0-9+/]{43}=$/u.test(encodedKey)) {
    invalid.add("DEV_SECRET_STORE_ENCRYPTION_KEY");
  } else {
    const decoded = Buffer.from(encodedKey, "base64");
    if (decoded.length !== 32 || decoded.toString("base64") !== encodedKey) invalid.add("DEV_SECRET_STORE_ENCRYPTION_KEY");
    else entries.push(["DEV_SECRET_STORE_ENCRYPTION_KEY", decoded]);
  }
  collectDuplicates(entries, invalid);

  const variables = [...invalid].sort();
  if (variables.length > 0) throw new FullEnvironmentPreflightError(variables);
  return true;
}

async function main() {
  let variables = ["ENV_FILE"];
  try {
    const [flag, path, ...rest] = process.argv.slice(2);
    if (flag !== "--env-file" || !path || rest.length > 0 || !isAbsolute(path)) throw new Error("invalid arguments");
    process.loadEnvFile(path);
    validateFullEnvironment(process.env);
    process.stdout.write("full environment preflight passed\n");
    return;
  } catch (error) {
    if (error instanceof FullEnvironmentPreflightError) variables = error.variables;
  }
  process.stderr.write(`full environment preflight failed: ${variables.join(", ")}\n`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
