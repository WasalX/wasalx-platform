// Test fixture settlement only; command is the existing Docker CLI, never a broad prefix delete.
export async function settleNativeCompatibility({ project, directory, runnerContainer, runnerConnected,
  closeBrowser, closeFixture, command, removeWorkspace, writeDiagnostics, primaryError }) {
  const failures = [], steps = [], resources = {};
  const attempt = async (name, action) => {
    try { await action(); steps.push({ name, passed: true }); }
    catch (error) { failures.push(error); steps.push({ name, passed: false,
      code: typeof error?.code === "string" ? error.code.slice(0, 80) : null,
      status: Number.isInteger(error?.status) ? error.status : null }); }
  };
  await attempt("browser-close", closeBrowser);
  await attempt("fixture-close", closeFixture);
  if (runnerConnected) await attempt("runner-disconnect", () => command([
    "network", "disconnect", "--force", `${project}_default`, runnerContainer]));
  await attempt("compose-down", () => command(["compose", "--project-directory", directory,
    "--project-name", project, "--file", `${directory}/compose.yaml`, "down", "--volumes", "--remove-orphans"]));
  for (const kind of ["container", "network", "volume"]) await attempt(`${kind}-absence`, async () => {
    const ids = (await command([kind, "ls", ...(kind === "container" ? ["--all"] : []),
      "--quiet", "--filter", `label=com.docker.compose.project=${project}`])).trim().split(/\s+/u).filter(Boolean);
    resources[kind] = { count: ids.length, ids: ids.slice(0, 128) };
    if (ids.length) throw new Error(`Owned ${kind} residue remains`);
  });
  if (primaryError || failures.length) {
    await attempt("write-diagnostics", () => writeDiagnostics({ project, workspace: directory,
      primaryFailure: Boolean(primaryError), steps: [...steps], resources, workspaceRetained: true }));
    throw new AggregateError([...(primaryError ? [primaryError] : []), ...failures],
      `Native compatibility failed; workspace retained: ${directory}`);
  }
  await removeWorkspace();
}

export function assertNativeCompatibilityProjectEmpty({ project, command }) {
  if (typeof project !== "string" || project.length !== 50 ||
      !/^wasalx-zammad-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(project)) {
    throw new TypeError("Native compatibility project must use a UUIDv4");
  }
  const read = (args) => {
    const value = command(args);
    if (typeof value !== "string") throw new TypeError("Unknown native project census result");
    const rows = value.split(/\r?\n/u).filter(Boolean);
    if (rows.some(row => row.trim() !== row || /\p{Cc}/u.test(row))) {
      throw new TypeError("Unknown native project census result");
    }
    return rows;
  };
  for (const kind of ["container", "network", "volume"]) {
    if (read([kind, "ls", ...(kind === "container" ? ["--all"] : []),
      "--quiet", "--filter", `label=com.docker.compose.project=${project}`]).length) {
      throw new Error(`Native project ${kind} scope is not empty`);
    }
  }
  // Names also fence resources whose Compose label is absent or incorrect.
  const containers = read(["container", "ls", "--all", "--format", "{{.Names}}"])
    .flatMap(row => row.split(",").map(name => name.trim()));
  if (containers.some(name => !name)) throw new TypeError("Unknown native project census result");
  if (containers.some(name => name === project || name.startsWith(`${project}-`) || name.startsWith(`${project}_`))) {
    throw new Error("Native project container name scope is not empty");
  }
  for (const [kind, names] of [["network", [`${project}_default`]],
    ["volume", [`${project}_zammad-storage`, `${project}_zammad-backup`]]]) {
    if (read([kind, "ls", "--format", "{{.Name}}"]).some(name => names.includes(name))) {
      throw new Error(`Native project ${kind} name scope is not empty`);
    }
  }
  return { project, resources: { container: 0, network: 0, volume: 0 },
    namedResources: { container: 0, network: 0, volume: 0 } };
}
