import { relative, sep } from "node:path";

export default async function* reportTimings(events) {
  for await (const { type, data } of events) {
    if (type !== "test:summary" || !data.file) continue;
    const file = relative(process.cwd(), data.file).split(sep).join("/");
    if (file.startsWith("tests/")) yield `UNIT_TIMING ${JSON.stringify([file, Math.round(data.duration_ms)])}\n`;
  }
}
