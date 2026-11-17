import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { browserReportPath, browserShard } from "./browser-shards.mjs";

// A compact execution inventory; list-only discovery never writes a pass receipt.
export default class BrowserShardReporter {
  onBegin(config, suite) {
    this.selection = config.shard ? [`--shard=${config.shard.current}/${config.shard.total}`] : [];
    this.cases = suite.allTests().map(test => ({ test, results: [] }));
  }
  onTestEnd(test, result) {
    this.cases.find(row => row.test.id === test.id).results.push(result);
  }
  onEnd(result) {
    const selected = browserShard(process.env.WASALX_E2E_SHARD);
    if (this.cases.every(row => row.results.length === 0)
      || (selected === null && process.env.WASALX_E2E_BASELINE_COUNTS !== "true")) return;
    const shard = selected ?? 0;
    const locale = process.env.WASALX_E2E_LOCALE, role = process.env.WASALX_E2E_ROLE;
    const cases = this.cases.map(({ test, results }) => ({ id: `${locale}/${role}/${test.id}`,
      file: test.location.file.replaceAll("\\", "/").split("/tests/e2e/")[1],
      project: test.parent.project().name, title: test.title, expectedStatus: test.expectedStatus,
      status: results[0]?.status ?? "missing", outcome: test.outcome(), attempts: results.length,
      startedAt: results[0]?.startTime.toISOString(),
      durationMs: results.reduce((sum, value) => sum + value.duration, 0) }));
    assert(cases.length > 0, "empty browser shard");
    const path = browserReportPath(shard, locale, role);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ shard, locale, role, status: result.status,
      selection: this.selection,
      durationMs: result.duration, startedAt: result.startTime.toISOString(), cases }) + "\n", { flag: "wx" });
  }
}
