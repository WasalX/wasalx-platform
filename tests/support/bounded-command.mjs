import { execFile } from "node:child_process";

const nodeProtocolWarning = /^\(node:\d+\) \[UNDICI-EHPA\] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time\.\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n?/u;

// Preserve the exact observed runtime warning as test diagnostics, outside fixture protocols.
export function fixtureStderr(value) {
  let warning;
  while ((warning = nodeProtocolWarning.exec(value))) {
    process.stderr.write(warning[0]);
    value = value.slice(warning[0].length);
  }
  return value;
}

export function boundedCommand(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: 60_000, killSignal: "SIGKILL", maxBuffer: 1_048_576, ...options }, (error, stdout, stderr) => {
      if (error && (error.killed || error.signal || typeof error.code !== "number")) return reject(Object.assign(error, { stdout, stderr }));
      resolve({ code: error?.code ?? 0, output: `${stdout}${stderr}`, stdout, stderr });
    });
  });
}
