import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../infra/docker/full/keycloak/provision-invitee.mjs", import.meta.url));
const email = "invitee@example.com";
const id = "12345678-1234-1234-1234-123456789abc";
const users = "/admin/realms/wasalx/users";
const userPath = `${users}/${id}`;
const rolePath = `${userPath}/role-mappings`;
const defaultRole = { id: "default-role", name: "default-roles-wasalx" };
const tokenPath = "/realms/master/protocol/openid-connect/token";
const token = "t".repeat(40);

for (const scenario of ["success", "email", "username", "output exists", "bad readback", "invalid input"]) {
  test(`provision invitee: ${scenario}`, async t => {
    const directory = await mkdtemp(join(tmpdir(), "invitee-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const outputPath = join(directory, "invitee.json");
    if (scenario === "output exists") await writeFile(outputPath, "keep");
    const requests = [];
    let created;
    let realmMappings = [defaultRole];
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body });
      const json = value => res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(value));
      if (req.url === tokenPath) return json({ access_token: token });
      if (req.url.startsWith(`${users}?`)) {
        const query = new URL(req.url, "http://localhost").searchParams;
        return json(query.has(scenario) ? [{ id }] : []);
      }
      if (req.url === users && req.method === "POST") {
        created = JSON.parse(body);
        return res.writeHead(201, { Location: userPath }).end();
      }
      if (req.url === userPath) {
        const { username, email, enabled, emailVerified, requiredActions } = created;
        return json({ id, username, email, enabled, emailVerified, requiredActions });
      }
      if (req.url === `${userPath}/credentials`) {
        if (scenario === "bad readback") return res.writeHead(500).end(JSON.stringify(created));
        return json([{ type: "password" }]);
      }
      if (req.url === `${userPath}/groups?max=1`) return json([]);
      if (req.url === rolePath) return json(realmMappings.length ? { realmMappings } : {});
      if (req.url === `${rolePath}/realm` && req.method === "DELETE") {
        realmMappings = [];
        return res.writeHead(204).end();
      }
      res.writeHead(404).end();
    }).listen(0, "127.0.0.1");
    t.after(() => server.close());
    await once(server, "listening");

    const child = spawn(process.execPath, [script], {
      env: {
        ...process.env,
        KEYCLOAK_BASE_URL: `http://127.0.0.1:${server.address().port}`,
        KEYCLOAK_ADMIN: "test-admin",
        KEYCLOAK_ADMIN_PASSWORD: "test-admin-password",
        WASALX_INVITEE_OUTPUT_FILE: outputPath,
      },
      timeout: 15_000,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    child.stdin.end(scenario === "invalid input" ? `${email}\n${email}\n` : `${email}\n`);
    const [exit] = await once(child, "close");
    const success = scenario === "success";
    assert.equal(exit, success ? 0 : 1);
    assert.equal(stdout, success ? "PASS\n" : "");
    const failedStage = {
      email: "user already exists", username: "user already exists", "output exists": "output file",
      "bad readback": "user verification", "invalid input": "input",
    }[scenario];
    assert.equal(stderr, success ? "" : `FAIL: ${failedStage}\n`);

    const lookups = scenario === "invalid input" ? [] : scenario === "email" ? ["email"] : ["email", "username"];
    assert.deepEqual(requests.filter(request => request.method === "GET" && request.url.startsWith(`${users}?`))
      .map(request => request.url), lookups.map(field => `${users}?${new URLSearchParams({ [field]: email, exact: "true", max: "2" })}`));
    assert.ok(requests.filter(request => request.url !== tokenPath).every(request => request.authorization === `Bearer ${token}`));
    assert.deepEqual(requests.filter(request => request.method !== "GET").map(request => [request.method, request.url]), [
      ...(lookups.length ? [["POST", tokenPath]] : []),
      ...(success || scenario === "bad readback" ? [["POST", users]] : []),
      ...(success ? [["DELETE", `${rolePath}/realm`]] : []),
    ]);

    if (success) {
      const { username, password, ...other } = JSON.parse(await readFile(outputPath, "utf8"));
      assert.equal(username, email);
      assert.deepEqual(other, {});
      assert.match(password, /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[!])[\x21-\x7e]{20,}$/u);
      assert.deepEqual(created, {
        username: email, email, emailVerified: true, enabled: true,
        requiredActions: ["UPDATE_PASSWORD", "CONFIGURE_TOTP"], groups: [],
        credentials: [{ type: "password", value: password, temporary: true }],
      });
      assert.deepEqual(JSON.parse(requests.find(request => request.method === "DELETE").body), [defaultRole]);
      if (process.platform !== "win32") assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
    } else if (scenario === "output exists") {
      assert.equal(await readFile(outputPath, "utf8"), "keep");
    } else {
      await assert.rejects(stat(outputPath), { code: "ENOENT" });
    }
  });
}
