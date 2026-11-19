import { randomBytes } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { adminBaseUrl, adminRequest, findUsers, login, readJson, required } from "./admin-rest.mjs";

const realm = "wasalx";
const requiredActions = ["UPDATE_PASSWORD", "CONFIGURE_TOTP"];
let stage = "input";
let sent = false;
let outputPath;
let output;

try {
  outputPath = required("WASALX_INVITEE_OUTPUT_FILE");
  if (process.argv.length !== 2) throw new Error();
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 1024) throw new Error();
    chunks.push(chunk);
  }
  const email = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
    .replace(/\r?\n$/u, "").toLowerCase();
  if (email.length > 320 || !/^[^\s@\p{Cc}]+@[^\s@\p{Cc}]+\.[^\s@\p{Cc}]+$/u.test(email)) throw new Error();

  stage = "administrator authentication";
  const baseUrl = adminBaseUrl();
  const token = await login(baseUrl, {
    username: required("KEYCLOAK_ADMIN"),
    password: required("KEYCLOAK_ADMIN_PASSWORD"),
  });
  const request = (path, method, body) => adminRequest(baseUrl, token, realm, path, method, body);
  const get = async path => {
    const response = await request(path);
    if (!response.ok) throw new Error();
    return readJson(response);
  };

  stage = "user lookup";
  for (const field of ["email", "username"]) {
    const matches = await findUsers(baseUrl, token, realm, { [field]: email });
    if (!Array.isArray(matches)) throw new Error();
    if (matches.length) {
      stage = "user already exists";
      throw new Error();
    }
  }

  stage = "output file";
  output = await open(outputPath, "wx", 0o600);
  await output.chmod(0o600);

  stage = "user creation";
  const password = `Aa1!${randomBytes(24).toString("base64url")}`;
  sent = true;
  const created = await request("/users", "POST", {
    username: email, email, emailVerified: true, enabled: true, requiredActions, groups: [],
    credentials: [{ type: "password", value: password, temporary: true }],
  });
  if (created.status !== 201) throw new Error();
  const location = created.headers.get("location");
  const id = location && new URL(location, baseUrl).pathname
    .match(/\/admin\/realms\/wasalx\/users\/([a-f0-9-]{36})$/u)?.[1];
  if (!id) throw new Error();

  stage = "user verification";
  const userPath = `/users/${id}`;
  const [user, credentials, groups] = await Promise.all([
    get(userPath), get(`${userPath}/credentials`), get(`${userPath}/groups?max=1`),
  ]);
  if (user?.id !== id || user.username !== email || user.email !== email ||
      user.enabled !== true || user.emailVerified !== true ||
      !Array.isArray(user.requiredActions) || user.requiredActions.length !== requiredActions.length ||
      !requiredActions.every(action => user.requiredActions.includes(action)) ||
      !Array.isArray(credentials) || credentials.length !== 1 || credentials[0]?.type !== "password" ||
      !Array.isArray(groups) || groups.length !== 0) throw new Error();

  stage = "role verification";
  const rolePath = `${userPath}/role-mappings`;
  let mappings = await get(rolePath);
  // Keycloak grants the realm's built-in default role even when the create request omits roles.
  if (mappings?.realmMappings?.length === 1 && mappings.realmMappings[0]?.name === "default-roles-wasalx") {
    const removed = await request(`${rolePath}/realm`, "DELETE", mappings.realmMappings);
    if (removed.status !== 204) throw new Error();
    mappings = await get(rolePath);
  }
  if (!mappings || typeof mappings !== "object" || Array.isArray(mappings) ||
      Object.keys(mappings).length !== 0) throw new Error();

  stage = "output write";
  await output.writeFile(JSON.stringify({ username: email, password }) + "\n");
  await output.close();
  console.log("PASS");
} catch {
  let cleanup = "";
  if (output) {
    await output.close().catch(() => {});
    await unlink(outputPath).catch(() => { cleanup = "; output cleanup failed"; });
  }
  // After the create request the account may exist with a password nobody holds.
  console.error(`FAIL: ${stage}${sent ? "; account may exist, inspect before retry" : ""}${cleanup}`);
  process.exitCode = 1;
}
