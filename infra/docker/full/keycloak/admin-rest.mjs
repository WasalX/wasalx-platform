export const required = name => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

export function adminBaseUrl() {
  const baseUrl = (process.env.KEYCLOAK_BASE_URL ?? "http://127.0.0.1:8080").replace(/\/$/u, "");
  if (!/^https?:\/\/[^/?#@]+(?::\d+)?(?:\/identity)?$/u.test(baseUrl)) throw new Error("KEYCLOAK_BASE_URL is invalid");
  return baseUrl;
}

const maxResponseBytes = 64 * 1024;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

export async function readJson(response) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxResponseBytes) throw new Error("Keycloak response exceeded the bounded size");
  const text = await response.text();
  if (Buffer.byteLength(text) > maxResponseBytes) throw new Error("Keycloak response exceeded the bounded size");
  return JSON.parse(text);
}

export async function login(baseUrl, { username, password }, attempts = 1) {
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: "admin-cli",
    username,
    password,
  });
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
        redirect: "error",
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
    if (attempt < attempts) await sleep(5_000);
  }
  throw new Error("Keycloak administrator authentication was not ready after bounded retries");
}

export function adminRequest(baseUrl, token, realm, path, method = "GET", body) {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  return fetch(`${baseUrl}/admin/realms/${encodeURIComponent(realm)}${path}`, {
    method, headers, body: JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(10_000),
  });
}

export async function findUsers(baseUrl, token, realm, filter) {
  const query = new URLSearchParams({ ...filter, exact: "true", max: "2" });
  const response = await adminRequest(baseUrl, token, realm, `/users?${query}`);
  if (!response.ok) throw new Error(`Keycloak user lookup failed for ${realm}`);
  return readJson(response);
}
