import assert from "node:assert/strict";
import childProcess from "node:child_process";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import test from "node:test";

test("synthetic browser traces protect the raw trace", async (t) => {
  const traceFlag = "WASALX_SYNTHETIC_UI_TRACE";
  const previous = process.env[traceFlag];
  t.after(() => {
    if (previous === undefined) delete process.env[traceFlag];
    else process.env[traceFlag] = previous;
  });

  const output = await mkdtemp(join(tmpdir(), "synthetic-trace-output-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const execFile = childProcess.execFile;
  const sanitizer = t.mock.fn((_command, args, done) => {
    writeFile(args.at(-1), "sanitized trace").then(() => done(null), done);
  });
  // Replace the function before import so promisify uses the stub.
  childProcess.execFile = sanitizer;
  syncBuiltinESMExports();
  const { syntheticBrowserTrace } =
    await import("./helpers/synthetic-browser-trace.mjs").finally(() => {
      childProcess.execFile = execFile;
      syncBuiltinESMExports();
    });

  let rawPath;
  let filesBeforeSanitizing;
  const context = {
    tracing: {
      start: t.mock.fn(),
      async stop({ path }) {
        rawPath = path;
        await writeFile(rawPath, "raw trace");
        filesBeforeSanitizing = await readdir(output);
      },
    },
  };
  const browser = {
    newContext: t.mock.fn(async () => context),
    contexts: () => [context],
  };

  const externalUrl = "http://example.invalid:6227";
  process.env[traceFlag] = "0";
  const disabled = syntheticBrowserTrace(browser, externalUrl, output);
  assert.equal(await disabled.newContext(), context);
  await disabled.retainFailure();
  assert.equal(context.tracing.start.mock.callCount(), 0);
  assert.equal(rawPath, undefined);

  process.env[traceFlag] = "1";
  const external = syntheticBrowserTrace(browser, externalUrl, output);
  await assert.rejects(external.newContext(), /require a loopback/u);
  assert.equal(browser.newContext.mock.callCount(), 1);

  const trace = syntheticBrowserTrace(browser, "http://127.0.0.1:6227", output);
  assert.equal(await trace.newContext(), context);
  await trace.retainFailure();

  assert.ok(isAbsolute(rawPath));
  const tempPath = relative(tmpdir(), rawPath);
  assert.ok(
    tempPath && !isAbsolute(tempPath) && tempPath.split(sep)[0] !== "..",
  );
  await assert.rejects(stat(rawPath), { code: "ENOENT" });
  assert.deepEqual(filesBeforeSanitizing, []);
  assert.equal(sanitizer.mock.callCount(), 1);
  assert.equal(sanitizer.mock.calls[0].arguments[1].at(-2), rawPath);
  assert.deepEqual(await readdir(output), ["child-trace-1.zip"]);
  assert.equal(
    await readFile(join(output, "child-trace-1.zip"), "utf8"),
    "sanitized trace",
  );
});
