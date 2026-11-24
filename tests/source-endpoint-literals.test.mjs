import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowlist = JSON.parse(readFileSync(new URL("./source-endpoint-allowlist.json", import.meta.url), "utf8"));
const sourceFile = /\.(?:[cm]?[jt]s|[jt]sx|py|rb|sh|bash|sql|css|scss|sass|less|html?|vue|svg|ftl)$/iu;
const testFile = /(?:^|\/)(?:tests?|__tests__|__fixtures__)\/|\.(?:test|spec)\.[^/]+$|(?:^|\/)(?:test[-_][^/]+|[^/]+[-_]test)\.[^/]+$/iu;
const configFile = /(?:^|\/)[^/]+\.config\.[^/]+$|^\.storybook\//iu;
const networkScheme = /^(?:https?|wss?|ftps?|sftp|ssh|git|rsync|smb|nfs|telnet|gopher|ldaps?|grpc[cs]?|postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|rediss?|amqps?|mqtts?|nats|smtps?|imaps?|pop3s?|rtmps?|rtsps?|tcp|udp)$/iu;
const reservedHost = /(?:^|\.)(?:localhost|test|example|invalid|example\.(?:com|net|org))\.?$/iu;
const reservedIpv4 = /^(?:127\.|0\.0\.0\.0$|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)/u;
const namespace = /^(?:https?:\/\/www\.w3\.org\/(?:2000\/svg|1999\/(?:xhtml|xlink)|XML\/1998\/namespace|2000\/xmlns\/|2001\/XMLSchema(?:-instance)?)|https?:\/\/json-schema\.org\/(?:draft(?:-\d+|\/\d{4}-\d{2})\/schema)#?|https:\/\/(?:slsa\.dev\/provenance\/(?:v0\.2|v1)|sigstore\.dev\/cosign\/sign\/v1)|http:\/\/schemas\.openid\.net\/event\/backchannel-logout)$/u;

const endpoint = /(?:(?<![\w+.-])(?<scheme>[a-z][\w+.-]*):|(?<![\w+.:/-]))\/\/(?<authority>(?:[^\s"'\x60<>(){},;|\\/$?#]+@)?(?:\[[\da-f:.]+\]|[\p{L}\p{N}_%][\p{L}\p{N}_.%\-]*)(?::\d*)?)(?:[/?#][^\s"'\x60<>(){},;|\\$]*)?|(?<![\w.])(?<ipv4>(?:\d{1,3}\.){3}\d{1,3})(?!\w|\.\w)|(?<![\w.:])(?<ipv6>[\da-f]*:[\da-f:.]*:[\da-f:.]*)(?![\w.:])/giu;
const quoted = /"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'|`(?:\\[^]|[^`\\])*`/u;

function omitComments(path, source) {
  const extension = extname(path).toLowerCase();
  const comments = {
    js: /\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/u,
    hash: /(?<![^\s;])#[^\r\n]*/u,
    sql: /\/\*[\s\S]*?\*\/|--[^\r\n]*/u,
    markup: /<!--[\s\S]*?-->|<#--[\s\S]*?-->/u,
    styles: /\/\*[\s\S]*?\*\//u,
  };
  const comment = /\.[cm]?[jt]sx?$/u.test(extension) ? comments.js
    : [".py", ".rb", ".sh", ".bash"].includes(extension) ? comments.hash
      : extension === ".sql" ? comments.sql
        : [".css", ".scss", ".sass", ".less"].includes(extension) ? comments.styles
          : comments.markup;
  const tokens = new RegExp(`(?<comment>${comment.source})|${quoted.source}`, "gu");
  return source.replace(tokens, (token, _comment, _index, _source, groups) =>
    groups.comment === undefined ? token : token.replace(/[^\r\n]/gu, " "));
}

function isReservedAddress(address) {
  if (isIP(address) === 4) return reservedIpv4.test(address);
  if (isIP(address) !== 6) return false;
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/u.exec(canonical);
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16);
    const low = Number.parseInt(mapped[2], 16);
    return reservedIpv4.test([high >> 8, high & 255, low >> 8, low & 255].join("."));
  }
  return canonical === "::" || canonical === "::1" || canonical.startsWith("2001:db8:");
}

function* literals(path, source) {
  const lines = omitComments(path, source).split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    for (const { 0: literal, index: offset, groups: { scheme, authority, ipv4, ipv6 } } of line.matchAll(endpoint)) {
      if (authority) {
        const next = line[offset + literal.length];
        const dynamicHost = next === "$" && literal.endsWith(authority) && !authority.endsWith(":");
        if (dynamicHost || (scheme && !networkScheme.test(scheme)) || next === "\\" || next === "@") continue;
        // A scheme identifies the transport. HTTP parsing also normalizes alternate IP spellings.
        const host = URL.parse(`http://${authority}`)?.hostname?.replace(/^\[|\]$/gu, "");
        if (reservedHost.test(host) || isReservedAddress(host ?? "") || namespace.test(literal)
          || literal === "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md") continue;
        const prefix = lines.slice(Math.max(0, index - 1), index).join("") + line.slice(0, offset);
        if (/(?:^|[^\w$])(?:["']?\$(?:id|schema|ref)["']?\s*:\s*["'`]|xmlns(?::[\w.-]+)?\s*=\s*["'])$/u.test(prefix)) continue;
      } else {
        const address = (ipv4 ?? ipv6).replace(/\.$/u, "");
        if (!isIP(address) || isReservedAddress(address)) continue;
      }
      yield { path, line: index + 1, column: offset + 1, literal };
    }
  }
}

function git(cwd, args, input) {
  return execFileSync("git", args, { cwd, input, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
}

function checkSource(cwd, rows) {
  const allowed = new Map();
  for (const { path, literal, reason } of rows) {
    assert(typeof path === "string" && path.trim() && typeof literal === "string" && literal.trim()
      && typeof reason === "string" && reason.trim(), "Source endpoint allowlist entries require a path, literal and reason");
    const key = JSON.stringify([path, literal]);
    assert(!allowed.has(key), "Duplicate source endpoint allowlist entry");
    allowed.set(key, false);
  }
  const paths = git(cwd, ["ls-files", "--stage", "-z", "--"]).split("\0")
    .filter(entry => /^100(?:644|755) /u.test(entry)).map(entry => entry.slice(entry.indexOf("\t") + 1))
    .filter(path => sourceFile.test(path) && !testFile.test(path) && !configFile.test(path));
  const attributes = git(cwd, ["check-attr", "--stdin", "-z", "linguist-generated"], paths.map(path => path + "\0").join("")).split("\0");
  const failures = [];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    assert.equal(attributes[i * 3], path, "Git attributes must cover each source path");
    const generated = attributes[i * 3 + 2].toLowerCase();
    if (generated === "set" || generated === "true") continue;
    for (const { line, column, literal } of literals(path, readFileSync(join(cwd, path), "utf8"))) {
      const key = JSON.stringify([path, literal]);
      if (allowed.has(key)) allowed.set(key, true);
      else failures.push(`${path}:${line}:${column}`);
    }
  }
  const stale = [...allowed].filter(([, used]) => !used).map(([key]) => JSON.parse(key)[0]);
  assert(!failures.length && !stale.length, [
    ...failures.map(location => `${location} has a URL or IP literal. Use configuration or add a reasoned exception.`),
    ...stale.map(path => `${path} has an unused source endpoint exception.`),
  ].join("\n"));
}

test("tracked source has no unlisted URL or IP literals", () => checkSource(root, allowlist));

test("source endpoint guard accepts documented address, URI and path exceptions and rejects seeded literals", t => {
  const { path: fixture, remove } = mkdtempDisposableSync(join(tmpdir(), "source-endpoints-"));
  t.after(remove);
  git(fixture, ["init", "-q"]);
  const url = "https://unlisted-endpoint.internal/api";
  const ipv4 = "198.18.0.8";
  const ipv6 = "fd00::8";
  const relativeUrl = "//unlisted-endpoint.internal/api";
  const ftpUrl = "sftp://user@unlisted-endpoint.internal:22/api";
  const exempt = [
    "'http://127.3.2.1:3000'", "'https://app.localhost.'", "'http://[0:0:0:0:0:0:0:1]'",
    "'0.0.0.0'", "'http://[::]'", "'::ffff:127.1.2.3'",
    "'http://example'", "'https://api.example.com'", "'https://example.net'", "'https://docs.example.org'",
    "'http://demo.test'", "'https://server.invalid'", "'192.0.2.8'", "'198.51.100.8'", "'203.0.113.8'",
    "'https://[2001:0DB8:1::3]'", "'2001:db8::'", "'https://'", "'/relative'", "'file:///tmp/example'",
    "'secret://tenant/key'", "'http://www.w3.org/2000/svg'", "'https://json-schema.org/draft/2020-12/schema'",
    "'0:0:0:0:0:0:0:1'", "'http://127.0.0.1'", "'https://api.example.com/path#anchor'",
    `({ $id: "${url}" })`, `// ${url}`, `/* ${url} */`,
  ].join("\n");
  for (const [path, contents] of Object.entries({
    ".gitattributes": "generated.js linguist-generated\nother-generated.js linguist-generated=true\n",
    "source.ts": exempt,
    "app.config.ts": `'${url}'`,
    "app.json": `{"url":"${url}"}`,
    "source.test.ts": `'${url}'`,
    "source.spec.ts": `'${ipv4}'`,
    "test_fixture.py": `'${ipv6}'`,
    "generated.js": `'${url}'`,
    "other-generated.js": `'${url}'`,
  })) writeFileSync(join(fixture, path), contents);
  git(fixture, ["add", "."]);
  checkSource(fixture, []);

  const path = "source.ts";
  writeFileSync(join(fixture, path), `'${url}' // comment\n'${ipv4}'\n'${ipv6}'\n`);
  assert.throws(() => checkSource(fixture, []), /source\.ts:1:2[\s\S]+source\.ts:2:2[\s\S]+source\.ts:3:2/u);
  const rows = [url, ipv4, ipv6].map(literal => ({ path, literal, reason: "Synthetic test fixture" }));
  checkSource(fixture, rows);
  assert.throws(() => checkSource(fixture, [{ ...rows[0], reason: " " }]), /require a path, literal and reason/u);
  assert.throws(() => checkSource(fixture, [{ ...rows[0], path: "different.ts" }, ...rows.slice(1)]), /source\.ts:1:2/u);
  writeFileSync(join(fixture, path), `'${url}/other'\n'${ipv4}'\n'${ipv6}'\n`);
  assert.throws(() => checkSource(fixture, rows), /source\.ts:1:2/u);
  writeFileSync(join(fixture, path), `'${relativeUrl}'\n'${ftpUrl}'\n`);
  assert.throws(() => checkSource(fixture, []), /source\.ts:1:2[\s\S]+source\.ts:2:2/u);
});
