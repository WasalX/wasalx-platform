const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const adminUsername = required("KEYCLOAK_ADMIN");
const adminPassword = required("KEYCLOAK_ADMIN_PASSWORD");
const qualificationOwnerPassword = required("WASALX_QUALIFICATION_OWNER_PASSWORD");
const isolationOwnerPassword = required("WASALX_ISOLATION_OWNER_PASSWORD");
const platformPassword = required("WASALX_PLATFORM_OPERATOR_PASSWORD");
const qualificationOwnerEmail = (process.env.WASALX_QUALIFICATION_OWNER_EMAIL ?? "").trim();
const isolationOwnerEmail = (process.env.WASALX_ISOLATION_OWNER_EMAIL ?? "").trim();
const smtp = {
  host: (process.env.WASALX_KEYCLOAK_SMTP_HOST ?? "").trim(),
  port: (process.env.WASALX_KEYCLOAK_SMTP_PORT ?? "").trim(),
  from: (process.env.WASALX_KEYCLOAK_SMTP_FROM ?? "").trim(),
  user: (process.env.WASALX_KEYCLOAK_SMTP_USER ?? "").trim(),
  password: process.env.WASALX_KEYCLOAK_SMTP_PASSWORD ?? "",
};
const baseUrl = (process.env.KEYCLOAK_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/u, "");
if (!/^https?:\/\/[^/?#]+(?::\d+)?(?:\/identity)?$/u.test(baseUrl)) throw new Error("KEYCLOAK_BASE_URL is invalid");
const publicOrigin = (name, fallback) => {
  const value = (process.env[name] ?? fallback).replace(/\/$/u, "");
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash ||
      (url.protocol !== "https:" && url.hostname !== "127.0.0.1")) throw new Error(`${name} is invalid`);
  return value;
};
const portalOrigin = publicOrigin("WASALX_PORTAL_PUBLIC_ORIGIN", "http://127.0.0.1:3000");
// Local full shares the existing edge network; browser loopback is not the IdP host.
const portalBackchannelOrigin = new URL(portalOrigin).hostname === "127.0.0.1" ? "http://portal:3000" : portalOrigin;
const zammadOrigin = publicOrigin("WASALX_ZAMMAD_PUBLIC_ORIGIN", "http://127.0.0.1:8081");
// Browser loopback belongs to the host; logout originates in Keycloak's network.
const zammadBackchannelOrigin = new URL(zammadOrigin).hostname === "127.0.0.1"
  ? "http://zammad-nginx:8080" : zammadOrigin;
const maxResponseBytes = 64 * 1024;
const smtpConfigured = Object.values(smtp).every(Boolean);
const routableEmail = value => {
  const domain = value.slice(value.lastIndexOf("@") + 1).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
    && !/(?:^|\.)(?:invalid|local|localhost|example|test)$/u.test(domain)
    && !/(?:^|\.)example\.(?:com|net|org)$/u.test(domain);
};

if (Object.values(smtp).some(Boolean) && !smtpConfigured) {
  throw new Error("Keycloak SMTP configuration must be complete");
}
if (smtpConfigured && (!/^[1-9]\d{0,4}$/u.test(smtp.port) || Number(smtp.port) > 65_535 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(smtp.from))) {
  throw new Error("Keycloak SMTP configuration is invalid");
}
if (qualificationOwnerEmail && !routableEmail(qualificationOwnerEmail)) {
  throw new Error("WASALX_QUALIFICATION_OWNER_EMAIL must be a routable email address");
}
if (smtpConfigured && !qualificationOwnerEmail) {
  throw new Error("WASALX_QUALIFICATION_OWNER_EMAIL is required when password recovery is enabled");
}

if (new Set([adminPassword, qualificationOwnerPassword, isolationOwnerPassword, platformPassword]).size !== 4) {
  throw new Error("Keycloak qualification passwords must be distinct");
}
if (isolationOwnerEmail) {
  if (!routableEmail(isolationOwnerEmail)) {
    throw new Error("WASALX_ISOLATION_OWNER_EMAIL must be a routable email address");
  }
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function readJson(response) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxResponseBytes) throw new Error("Keycloak response exceeded the bounded size");
  const text = await response.text();
  if (Buffer.byteLength(text) > maxResponseBytes) throw new Error("Keycloak response exceeded the bounded size");
  return JSON.parse(text);
}

async function login() {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "admin-cli",
    username: adminUsername,
    password: adminPassword,
  });
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const payload = await readJson(response);
        if (typeof payload.access_token === "string" && payload.access_token.length > 32) {
          return payload.access_token;
        }
      }
    } catch {
      // Keycloak can report healthy just before the admin token endpoint is
      // ready after an initial realm import. Retry without logging credentials.
    }
    if (attempt < 12) await sleep(5_000);
  }
  throw new Error("Keycloak administrator authentication was not ready after bounded retries");
}

async function findUser(token, realm, username) {
  stage = `${realm} user lookup`;
  const query = new URLSearchParams({ username, exact: "true", max: "2" });
  const usersResponse = await fetch(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}/users?${query}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!usersResponse.ok) throw new Error(`Keycloak user lookup failed for ${realm}`);
  const users = await readJson(usersResponse);
  if (!Array.isArray(users) || users.length !== 1 || typeof users[0]?.id !== "string") {
    throw new Error(`Keycloak user lookup was not unique for ${realm}`);
  }
  return users[0];
}

async function reconcileUser(token, realm, desired) {
  stage = `${realm} user reconciliation`;
  let existingId;
  if (desired.id) {
    const lookup = await fetch(
      `${baseUrl}/admin/realms/${encodeURIComponent(realm)}/users/${encodeURIComponent(desired.id)}`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) },
    );
    if (!lookup.ok && lookup.status !== 404) throw new Error(`Keycloak user lookup failed for ${realm}`);
    if (lookup.status === 404) throw new Error(`Keycloak seeded user is missing for ${realm}`);
    if (lookup.ok) existingId = desired.id;
  } else {
    const query = new URLSearchParams({ username: desired.username, exact: "true", max: "2" });
    const lookup = await fetch(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}/users?${query}`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
    });
    if (!lookup.ok) throw new Error(`Keycloak user lookup failed for ${realm}`);
    const matches = await readJson(lookup);
    if (!Array.isArray(matches) || matches.length > 1) throw new Error(`Keycloak user lookup was ambiguous for ${realm}`);
    existingId = matches[0]?.id;
  }
  const exists = typeof existingId === "string";
  const payload = { ...desired };
  if (exists) delete payload.requiredActions;
  const response = await fetch(
    exists
      ? `${baseUrl}/admin/realms/${encodeURIComponent(realm)}/users/${encodeURIComponent(existingId)}`
      : `${baseUrl}/admin/realms/${encodeURIComponent(realm)}/users`,
    {
      method: exists ? "PUT" : "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.status !== (exists ? 204 : 201)) throw new Error(`Keycloak user reconciliation failed for ${realm}`);
}

async function resetPassword(token, realm, username, password) {
  const user = await findUser(token, realm, username);
  stage = `${realm} password reconciliation`;
  const response = await fetch(
    `${baseUrl}/admin/realms/${encodeURIComponent(realm)}/users/${encodeURIComponent(user.id)}/reset-password`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ type: "password", value: password, temporary: false }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.status !== 204) throw new Error(`Keycloak password reconciliation failed for ${realm}`);
}

async function reconcileTotpEnrollment(token, realm, username) {
  const user = await findUser(token, realm, username);
  stage = `${realm} OTP credential lookup`;
  const credentialsResponse = await fetch(
    `${baseUrl}/admin/realms/${encodeURIComponent(realm)}/users/${encodeURIComponent(user.id)}/credentials`,
    {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!credentialsResponse.ok) throw new Error(`Keycloak OTP credential lookup failed for ${realm}`);
  const credentials = await readJson(credentialsResponse);
  if (!Array.isArray(credentials)) throw new Error(`Keycloak OTP credential lookup was invalid for ${realm}`);

  const hasOtp = credentials.some(credential => credential?.type === "otp");
  const requiredActions = new Set(
    Array.isArray(user.requiredActions)
      ? user.requiredActions.filter(action => typeof action === "string")
      : [],
  );
  if (hasOtp) requiredActions.delete("CONFIGURE_TOTP");
  else requiredActions.add("CONFIGURE_TOTP");
  const desired = [...requiredActions];
  if (JSON.stringify(desired) === JSON.stringify(user.requiredActions ?? [])) return;

  stage = `${realm} OTP enrollment reconciliation`;
  const updateResponse = await fetch(
    `${baseUrl}/admin/realms/${encodeURIComponent(realm)}/users/${encodeURIComponent(user.id)}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ requiredActions: desired }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (updateResponse.status !== 204) throw new Error(`Keycloak OTP enrollment reconciliation failed for ${realm}`);
}

async function reconcileRealmPresentation(token, realm) {
  stage = `${realm} presentation reconciliation`;
  const recoveryEnabled = realm === "wasalx" && smtpConfigured;
  const response = await fetch(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      realm,
      loginTheme: "wasalx",
      internationalizationEnabled: true,
      supportedLocales: ["en", "ar"],
      defaultLocale: "en",
      resetPasswordAllowed: recoveryEnabled,
      eventsEnabled: true,
      enabledEventTypes: [
        "LOGIN", "LOGIN_ERROR", "LOGOUT", "LOGOUT_ERROR", "RESET_PASSWORD", "RESET_PASSWORD_ERROR",
        "SEND_RESET_PASSWORD", "SEND_RESET_PASSWORD_ERROR", "UPDATE_PASSWORD", "UPDATE_PASSWORD_ERROR",
        "CODE_TO_TOKEN", "CODE_TO_TOKEN_ERROR", "REFRESH_TOKEN", "REFRESH_TOKEN_ERROR",
        "UPDATE_TOTP", "UPDATE_TOTP_ERROR", "REMOVE_TOTP", "REMOVE_TOTP_ERROR",
      ],
      eventsExpiration: 2_592_000,
      smtpServer: recoveryEnabled ? { ...smtp, auth: "true", starttls: "true", ssl: "false" } : {},
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status !== 204) throw new Error(`Keycloak presentation reconciliation failed for ${realm}`);
}

async function reconcilePublicClient(token, realm, desired) {
  stage = `${realm} client lookup`;
  const query = new URLSearchParams({ clientId: desired.clientId, max: "2" });
  const lookup = await fetch(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}/clients?${query}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!lookup.ok) throw new Error(`Keycloak client lookup failed for ${realm}`);
  const matches = await readJson(lookup);
  if (!Array.isArray(matches) || matches.length > 1) throw new Error(`Keycloak client lookup was ambiguous for ${realm}`);

  stage = `${realm} client reconciliation`;
  const existingId = matches[0]?.id;
  const response = await fetch(
    existingId
      ? `${baseUrl}/admin/realms/${encodeURIComponent(realm)}/clients/${encodeURIComponent(existingId)}`
      : `${baseUrl}/admin/realms/${encodeURIComponent(realm)}/clients`,
    {
      method: existingId ? "PUT" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(existingId ? { ...desired, id: existingId } : desired),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (response.status !== (existingId ? 204 : 201)) throw new Error(`Keycloak client reconciliation failed for ${realm}`);
}

let stage = "administrator authentication";
try {
  const token = await login();
  await reconcileRealmPresentation(token, "wasalx");
  await reconcileRealmPresentation(token, "wasalx-platform");
  await reconcileUser(token, "wasalx", {
    id: "10000000-0000-4000-8000-000000000001",
    username: "example.owner",
    email: qualificationOwnerEmail || "fixture-0006@example.test",
    emailVerified: true,
    enabled: true,
    firstName: "Qualification",
    lastName: "Owner",
    requiredActions: ["CONFIGURE_TOTP"],
  });
  if (isolationOwnerEmail) {
    await reconcileUser(token, "wasalx", {
      username: "example.isolation",
      email: isolationOwnerEmail,
      emailVerified: true,
      enabled: true,
      firstName: "Isolation",
      lastName: "Owner",
      requiredActions: ["CONFIGURE_TOTP"],
    });
  }
  stage = "qualification owner password reset";
  await resetPassword(token, "wasalx", "example.owner", qualificationOwnerPassword);
  await reconcileTotpEnrollment(token, "wasalx", "example.owner");
  if (isolationOwnerEmail) {
    stage = "isolation owner password reset";
    await resetPassword(token, "wasalx", "example.isolation", isolationOwnerPassword);
    await reconcileTotpEnrollment(token, "wasalx", "example.isolation");
  }
  await reconcilePublicClient(token, "wasalx", {
    clientId: "wasalx-portal",
    name: "WasalX Portal",
    enabled: true,
    publicClient: true,
    bearerOnly: false,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    frontchannelLogout: false,
    protocol: "openid-connect",
    redirectUris: [`${portalOrigin}/auth/callback`, `${portalOrigin}/invitations/callback`],
    webOrigins: [portalOrigin],
    attributes: {
      "pkce.code.challenge.method": "S256",
      "post.logout.redirect.uris": `${portalOrigin}/*`,
      "backchannel.logout.url": `${portalBackchannelOrigin}/auth/backchannel-logout`,
      "backchannel.logout.session.required": "true",
    },
    protocolMappers: [{
      name: "wasalx-control-api-audience",
      protocol: "openid-connect",
      protocolMapper: "oidc-audience-mapper",
      consentRequired: false,
      config: {
        "included.client.audience": "wasalx-control-api",
        "id.token.claim": "false",
        "access.token.claim": "true",
        "introspection.token.claim": "true",
      },
    }],
    defaultClientScopes: ["basic", "web-origins", "acr", "roles", "profile", "email"],
    optionalClientScopes: ["address", "phone", "offline_access", "microprofile-jwt"],
  });
  await reconcilePublicClient(token, "wasalx", {
    clientId: "wasalx-00000000000040008000000000000001",
    name: "WasalX Qualification Zammad",
    enabled: false,
    publicClient: true,
    bearerOnly: false,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    // Native Zammad receives server-to-server logout through its configured endpoint.
    frontchannelLogout: false,
    protocol: "openid-connect",
    redirectUris: [],
    webOrigins: [],
    attributes: {
      "pkce.code.challenge.method": "S256",
      "post.logout.redirect.uris": "",
      "backchannel.logout.url": `${zammadBackchannelOrigin}/auth/openid_connect/backchannel_logout`,
      "backchannel.logout.session.required": "true",
    },
    defaultClientScopes: ["basic", "web-origins", "acr", "roles", "profile", "email"],
  });
  await reconcilePublicClient(token, "wasalx-platform", {
    "clientId": "wasalx-platform-portal",
    "name": "WasalX Platform Operations Portal",
    "enabled": true,
    "publicClient": true,
    "bearerOnly": false,
    "standardFlowEnabled": true,
    "implicitFlowEnabled": false,
    "directAccessGrantsEnabled": false,
    "serviceAccountsEnabled": false,
    "frontchannelLogout": true,
    "protocol": "openid-connect",
    "redirectUris": [
      `${portalOrigin}/platform/auth/callback`
    ],
    "webOrigins": [
      portalOrigin
    ],
    "attributes": {
      "pkce.code.challenge.method": "S256",
      "post.logout.redirect.uris": `${portalOrigin}/*`
    },
    "protocolMappers": [
      {
        "name": "wasalx-platform-api-audience",
        "protocol": "openid-connect",
        "protocolMapper": "oidc-audience-mapper",
        "consentRequired": false,
        "config": {
          "included.client.audience": "wasalx-platform-api",
          "id.token.claim": "false",
          "access.token.claim": "true",
          "introspection.token.claim": "true"
        }
      },
      {
        "name": "authentication-method-reference",
        "protocol": "openid-connect",
        "protocolMapper": "oidc-amr-mapper",
        "consentRequired": false,
        "config": {
          "id.token.claim": "true",
          "access.token.claim": "true",
          "lightweight.claim": "false"
        }
      }
    ],
    "defaultClientScopes": [
      "basic",
      "web-origins",
      "acr",
      "roles",
      "profile",
      "email"
    ],
    "optionalClientScopes": []
  });
  stage = "platform password reset";
  await resetPassword(token, "wasalx-platform", "example.platform", platformPassword);
  await reconcileTotpEnrollment(token, "wasalx-platform", "example.platform");
  process.stdout.write("Keycloak local users initialized.\n");
} catch {
  process.stderr.write(`Keycloak local-user bootstrap failed during ${stage}.\n`);
  process.exitCode = 1;
}
