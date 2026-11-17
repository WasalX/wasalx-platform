"""Check owned write filesystems after label routing and runner funding admission."""
import json
import math
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import time
from uuid import UUID


MEMORY_BUDGET_PATH = Path(__file__).resolve().parents[2] / "release" / "ci-memory-budget.json"


def memory_budget():
    try:
        value = json.loads(MEMORY_BUDGET_PATH.read_text())
        provenance = value["provenance"]
        runs = provenance["runs"]
        peaks = provenance["memoryPeakGiB"]
        oom_count = provenance["oomCount"]
        margin = value["margin"]
        budget_gib = value["budgetGiB"]
        observed_workers = value["observedWorkers"]
        baseline_allowance_gib = value["baselineAllowanceGiB"]
        status = value["status"]
        resize_after_runs = value["resizeAfterRuns"]
        ruby_cache = provenance["rubyCache"]
        build_jobs = provenance["buildJobs"]
        if (isinstance(value.get("schemaVersion"), bool) or value.get("schemaVersion") != 1 or status not in ("PROVISIONAL", "FINAL")
                or isinstance(resize_after_runs, bool) or not isinstance(resize_after_runs, int) or resize_after_runs <= 0
                or not isinstance(runs, list) or not runs
                or any(not isinstance(run, str) or not run.isdigit() or int(run) <= 0 for run in runs)
                or not isinstance(peaks, list) or not peaks
                or any(isinstance(peak, bool) or not isinstance(peak, (int, float)) or not math.isfinite(peak) or peak <= 0 for peak in peaks)
                or not isinstance(ruby_cache, list) or not isinstance(build_jobs, list)
                or len({len(runs), len(peaks), len(ruby_cache), len(build_jobs)}) != 1
                or isinstance(oom_count, bool) or not isinstance(oom_count, int) or oom_count != 0
                or isinstance(margin, bool) or not isinstance(margin, (int, float)) or not math.isfinite(margin) or margin <= 1
                or isinstance(budget_gib, bool) or not isinstance(budget_gib, int) or budget_gib <= 0
                or isinstance(observed_workers, bool) or not isinstance(observed_workers, int) or observed_workers <= 0
                or isinstance(baseline_allowance_gib, bool) or not isinstance(baseline_allowance_gib, (int, float))
                or not math.isfinite(baseline_allowance_gib) or baseline_allowance_gib <= 0 or baseline_allowance_gib >= budget_gib
                or budget_gib != math.ceil(max(peaks) * margin)):
            raise ValueError
        gib = 1024 ** 3
        return {"budget": budget_gib * gib, "observedWorkers": observed_workers,
                "peak": max(peaks) * gib, "margin": margin,
                "baselineAllowance": baseline_allowance_gib * gib}
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise RuntimeError("Managed memory budget is missing or invalid") from error


def managed_identity():
    ref = os.environ.get("GITHUB_REF", "")
    ci_only_ref = bool(re.fullmatch(r"refs/heads/wasalx/ci-only-[a-z0-9][a-z0-9._-]*", ref))
    expected = (f"WasalX/WasalX/{os.environ['WASALX_QUALITY_WORKFLOW_PATH']}@{ref}" if ci_only_ref
                else ('WasalX/WasalX/' + os.environ['WASALX_QUALITY_WORKFLOW_PATH'] + '@refs/heads/integration/wasalx'))
    requested = "managed" if os.environ.get("WASALX_CI_SCOPE") == "repository-only" else "native"
    owner_identity = (
        os.environ.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
        and os.environ.get("GITHUB_REPOSITORY") == "WasalX/WasalX"
        and os.environ.get("GITHUB_REF_PROTECTED") == "false"
        and os.environ.get("GITHUB_WORKFLOW_REF") == expected
        and (ci_only_ref or ref == "refs/heads/integration/wasalx")
    )
    if (os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("WASALX_CI_WORKFLOW_RUNTIME") != requested
            or not owner_identity
            or os.environ.get("RUNNER_ENVIRONMENT") != "self-hosted"
            or os.environ.get("WASALX_CI_RUNTIME_SHA") != os.environ.get("GITHUB_SHA")
            or len(os.environ.get("GITHUB_SHA", "")) != 40
            or any(c not in "0123456789abcdef" for c in os.environ.get("GITHUB_SHA", ""))
            or os.environ.get("WASALX_CI_CPU_TRIAL_LIVE") != "false"
            or os.environ.get("WASALX_CI_APPLICATION_CPUS")
            or (ci_only_ref and (
                os.environ.get("WASALX_CI_SCOPE") != "full"
                or os.environ.get("WASALX_CI_ROUTE") != "cloud"
                or os.environ.get("WASALX_CI_EVIDENCE_MODE") != "non-qualifying-ci-only"))):
        raise RuntimeError("Managed runtime requires the exact nonprotected owner dispatch with native qualification off")


def native_identity():
    ref = os.environ.get("GITHUB_REF", "")
    if not re.fullmatch(r"refs/heads/wasalx/ci-only-[a-z0-9][a-z0-9._-]*", ref):
        return
    if (os.environ.get("GITHUB_EVENT_NAME") != "workflow_dispatch"
            or os.environ.get("GITHUB_REPOSITORY") != "WasalX/WasalX"
            or os.environ.get("GITHUB_REF_PROTECTED") != "false"
            or os.environ.get("GITHUB_WORKFLOW_REF") != f"WasalX/WasalX/{os.environ['WASALX_QUALITY_WORKFLOW_PATH']}@{ref}"
            or os.environ.get("WASALX_CI_SCOPE") != "full"
            or os.environ.get("WASALX_CI_EVIDENCE_MODE") != "non-qualifying-ci-only"
            or os.environ.get("WASALX_CI_RUN_BROWSER") != "false"
            or os.environ.get("WASALX_CI_RUN_DOCKER_SMOKE") not in ("true", "false")):
        raise RuntimeError("Native runtime refuses an unqualified CI-only route")
    if os.environ.get("GITHUB_JOB") == "docker-smoke":
        if (os.environ.get("WASALX_CI_RUN_DOCKER_SMOKE") != "true"
                or os.environ.get("WASALX_CI_ROUTE") != "fullruntime"):
            raise RuntimeError("CI-only docker-smoke requires the fullruntime route and enabled input")
    elif os.environ.get("WASALX_CI_ROUTE") != "cloud":
        raise RuntimeError("Native CI-only non-smoke jobs require cloud")


def managed_resources():
    # Flush dirty pages first so freshly written files (e.g. a cold pnpm install) become creditable clean cache.
    os.sync()
    root = Path("/sys/fs/cgroup")
    membership = Path("/proc/self/cgroup").read_text().strip().splitlines()
    if len(membership) != 1 or not membership[0].startswith("0::/"):
        raise RuntimeError("Managed repository requires visible cgroup-v2 bounds")
    relative = membership[0][3:]
    if ".." in Path(relative).parts:
        raise RuntimeError("Invalid managed cgroup membership")
    group = root / relative.lstrip("/")
    # A cgroup namespace can expose its own group at the mounted root.
    if not (group / "cpu.max").is_file():
        group = root
    quotas, limits, available, memory_observations = [], [], [], []
    budget = memory_budget()
    try:
        job_current = int((group / "memory.current").read_text().strip())
    except (OSError, AttributeError, TypeError, ValueError) as error:
        raise RuntimeError("Managed job cgroup memory.current is missing or invalid") from error
    if job_current < 0:
        raise RuntimeError("Managed job cgroup memory.current is invalid")
    folder = group
    while True:
        quota, period = (folder / "cpu.max").read_text().split()
        memory = (folder / "memory.max").read_text().strip()
        if quota != "max":
            if not quota.isdigit() or not period.isdigit() or min(int(quota), int(period)) <= 0:
                raise RuntimeError("Managed CPU bound is invalid")
            quotas.append(int(quota) / int(period))
        if memory != "max":
            if not memory.isdigit() or int(memory) <= 0:
                raise RuntimeError("Managed memory bound is invalid")
            limits.append(int(memory))
            current = int((folder / "memory.current").read_text().strip())
            if current < 0:
                raise RuntimeError("Managed memory usage is invalid")
            stat_path = folder / "memory.stat"
            inactive_file = None
            anon = None
            shmem = None
            kernel_components = {}
            file_dirty = 0
            file_writeback = 0
            if stat_path.is_file():
                for line in stat_path.read_text().splitlines():
                    fields = line.split()
                    if len(fields) != 2 or fields[0] not in ("anon", "shmem", "inactive_file", "file_dirty", "file_writeback",
                                                               "kernel", "kernel_stack", "pagetables", "percpu", "sock", "vmalloc",
                                                               "slab_unreclaimable"):
                        continue
                    if not fields[1].isdigit():
                        raise RuntimeError("Managed memory statistic is invalid")
                    value = int(fields[1])
                    if fields[0] == "anon":
                        anon = value
                    elif fields[0] == "shmem":
                        shmem = value
                    elif fields[0] == "inactive_file":
                        inactive_file = value
                    elif fields[0] == "file_dirty":
                        file_dirty = value
                    elif fields[0] == "file_writeback":
                        file_writeback = value
                    else:
                        kernel_components[fields[0]] = value
            kernel = kernel_components.get("kernel")
            if kernel is None:
                components = [kernel_components.get(name) for name in ("kernel_stack", "pagetables", "percpu", "sock", "vmalloc", "slab_unreclaimable")]
                kernel = sum(value for value in components if value is not None) if any(value is not None for value in components) else None
            peak_path = folder / "memory.peak"
            peak = peak_path.read_text().strip() if peak_path.is_file() else "UNAVAILABLE"
            peak = f"{int(peak)}B/{int(peak) / 1024 ** 3:.3f}GiB" if peak.isdigit() else peak
            memory_observations.append({"path": str(folder), "maximum": int(memory),
                                        "current": current, "peak": peak, "inactive_file": inactive_file,
                                        "file_dirty": file_dirty, "file_writeback": file_writeback,
                                        "anon": anon, "shmem": shmem, "kernel": kernel})
            if inactive_file is not None:
                if inactive_file > current:
                    raise RuntimeError("Managed inactive_file memory statistic is invalid")
                inactive_credit = max(0, inactive_file - file_dirty - file_writeback)
                available.append(int(memory) - (current - inactive_credit))
        if folder == root:
            break
        folder = folder.parent
    if not quotas or not limits:
        raise RuntimeError("Managed repository requires finite CPU and memory bounds")
    memory = min(limits)
    if memory < budget["budget"]:
        raise RuntimeError("Managed repository cgroup memory envelope is below its budget")
    cpus = min(*quotas, len(os.sched_getaffinity(0)))
    gib = 1024 ** 3
    if cpus < 1 or memory < 12 * gib:
        raise RuntimeError("Managed repository is below the existing platform worker policy")
    # Consume the existing core-v2 hint, independently checked against live bounds.
    per_worker_budget = budget["budget"] / budget["observedWorkers"]
    memory_workers = math.floor(memory / per_worker_budget)
    policy = max(1, min(math.floor(cpus), memory_workers))
    if memory < 24 * gib:
        policy = min(policy, 3)
    hint = os.environ.get("CI_UNIT_WORKERS_CLOUD", "")
    if not hint.isdigit() or int(hint) != policy:
        raise RuntimeError("Managed repository worker hint differs from visible resource policy")
    workers = min(4, policy)
    worker_budget = math.ceil(per_worker_budget * workers)
    details = "synced=true; " + "; ".join(
        f"{row['path']}: max={row['maximum'] / gib:.3f}GiB "
        f"current={row['current'] / gib:.3f}GiB "
        f"peak={row['peak']} "
        f"inactive_file={(row['inactive_file'] / gib if row['inactive_file'] is not None else 'UNKNOWN')}GiB "
        f"file_dirty={row['file_dirty'] / gib:.3f}GiB "
        f"file_writeback={row['file_writeback'] / gib:.3f}GiB "
        f"anon={(row['anon'] / gib if row['anon'] is not None else 'UNKNOWN')}GiB "
        f"shmem={(row['shmem'] / gib if row['shmem'] is not None else 'UNKNOWN')}GiB "
        f"kernel_unreclaimable={(row['kernel'] / gib if row['kernel'] is not None else 'UNKNOWN')}GiB "
        f"budget={worker_budget / gib:.3f}GiB"
        for row in memory_observations
    )
    if len(available) != len(memory_observations):
        raise RuntimeError("Managed memory.stat inactive_file is missing: " + details)
    required = max(0, budget["budget"] - min(job_current, budget["baselineAllowance"]))
    for headroom in available:
        if headroom < required:
            raise RuntimeError(
                f"Managed repository process-group memory headroom is below its remaining budget "
                f"(job_current={job_current}B required={required}B): " + details
            )
    return {"cpuUpperBound": cpus, "memoryUpperBound": memory, "visibleMemoryHeadroom": min(available),
            "unitWorkers": workers, "workerPolicyBudgetBytes": worker_budget,
            "memoryBudget": {"measuredPeakBytes": budget["peak"], "margin": budget["margin"],
                              "budgetBytes": budget["budget"], "observedWorkers": budget["observedWorkers"],
                              "baselineAllowanceBytes": budget["baselineAllowance"]},
            "memoryObservations": memory_observations,
            "hiddenAncestors": "UNKNOWN", "capacityGrant": "NOT_ASSERTED"}


def managed_check(uid, payload, docker_phase=False):
    managed_identity()
    if uid != 1000:
        raise RuntimeError("Managed route requires its observed UID1000 mapping")
    job = os.environ.get("GITHUB_JOB")
    dockerless_infra = (job == "infrastructure" and os.environ.get("WASALX_CI_SCOPE") == "full"
                        and os.environ.get("WASALX_CI_ROUTE") == "cloud")
    if docker_phase or job in ("postgres", "browser-shards", "browser", "docker-smoke") or (job == "infrastructure" and not dockerless_infra):
        raise RuntimeError(f"MANAGED_DOCKER_STORE_AND_AGGREGATE_UNBOUND: {job}; refuse before pull/build/container")
    if job != "repository" and not dockerless_infra:
        raise RuntimeError("Managed runtime does not admit this native or optional job")
    owned = []
    for key in ("GITHUB_WORKSPACE", "RUNNER_TEMP"):
        path = Path(os.environ[key])
        if not path.is_absolute() or Path("/workspace") not in path.parents or path.resolve(strict=True) != path:
            raise RuntimeError("Managed job paths must be canonical children of /workspace")
        metadata = path.stat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != uid:
            raise RuntimeError("Managed job paths must be owned by the runner")
        space = os.statvfs(path)
        if space.f_blocks <= 0 or space.f_bavail * 100 < space.f_blocks * 15:
            raise RuntimeError("Managed workspace reserve is below the existing platform 15% floor")
        owned.append(path)
    resources = managed_resources()
    sha = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    if sha != os.environ["GITHUB_SHA"]:
        raise RuntimeError("Managed checkout differs from the dispatched source")
    dotgit = owned[0] / ".git"
    if not dotgit.is_dir() or dotgit.resolve(strict=True) != dotgit or dotgit.stat().st_uid != uid:
        raise RuntimeError("Managed checkout requires its own in-workspace Git directory")
    if payload:
        dependencies = owned[0] / "node_modules"
        if not dependencies.is_dir() or dependencies.resolve(strict=True) != dependencies or dependencies.stat().st_uid != uid:
            raise RuntimeError("Managed dependencies must be inside the owned checkout")
        for key in ("WASALX_NODE_BIN", "PNPM_HOME"):
            path = Path(os.environ[key]).resolve(strict=True)
            if owned[1] not in path.parents or path.stat().st_uid != uid:
                raise RuntimeError("Managed tools must remain in the owned job temp root")
        node = os.environ["WASALX_NODE_BIN"]
        pnpm = str(Path(os.environ["PNPM_HOME"]) / "pnpm")
        if (subprocess.check_output([node, "--version"], text=True).strip() != "v22.23.4"
                or subprocess.check_output([pnpm, "--version"], text=True).strip() != "11.16.0"):
            raise RuntimeError("Managed payload requires the exact product Node and pnpm")
    return {"runtime": "managed", "job": job, "isolation": "same-uid-degraded", "resources": resources}


def docker_info(endpoint, environment):
    # A recovering owned daemon may briefly time out; unsafe metadata never retries.
    for attempt in range(3):
        try:
            output = subprocess.check_output(
                ["/usr/bin/docker", "--host", endpoint, "info", "--format", "{{json .}}"],
                text=True, timeout=10, env=environment,
            )
        except (subprocess.TimeoutExpired, subprocess.CalledProcessError):
            if attempt == 2:
                raise
            time.sleep(2)
            continue
        return json.loads(output)


def check(payload=False, docker_phase=False):
    # Label routing and the root-managed job hook admit the runner, not a host list.
    uid = os.getuid() if sys.platform == "linux" else 0
    if uid <= 0 or os.geteuid() != uid:
        raise RuntimeError("CI phase requires a nonroot Linux runner")
    mode = os.environ.get("WASALX_CI_RUNTIME", "native")
    scope = os.environ.get("WASALX_CI_SCOPE", "full")
    if scope not in ("full", "repository-only"):
        raise RuntimeError("Unknown CI qualification scope")
    if scope == "repository-only" and (mode != "managed"
            or os.environ.get("GITHUB_JOB") != "repository"):
        raise RuntimeError("Repository-only qualification requires managed repository")
    if mode == "managed":
        return managed_check(uid, payload, docker_phase)
    if mode != "native":
        raise RuntimeError("Unknown CI runtime")
    native_identity()
    socket = Path(f"/run/user/{uid}/docker.sock")
    metadata = socket.lstat()
    if not stat.S_ISSOCK(metadata.st_mode) or metadata.st_uid != uid:
        raise RuntimeError("CI phase requires the current runner's Docker socket")
    endpoint = f"unix://{socket}"
    if os.environ.get("DOCKER_CONTEXT") or not os.environ.get("DOCKER_HOST"):
        selected = subprocess.check_output(
            ["/usr/bin/docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"],
            text=True, timeout=10,
        ).strip()
    else:
        selected = os.environ["DOCKER_HOST"]
    if selected != endpoint or os.environ.get("DOCKER_TLS_VERIFY") or os.environ.get("DOCKER_CERT_PATH"):
        raise RuntimeError("CI Docker commands must use the current runner's local socket")
    environment = {key: value for key, value in os.environ.items()
                   if key not in ("DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH")}
    info = docker_info(endpoint, environment)
    options = info.get("SecurityOptions") if isinstance(info, dict) else None
    if not isinstance(options, list) or any(not isinstance(value, str) for value in options) or "name=rootless" not in options:
        raise RuntimeError("CI phase requires rootless Docker")
    paths = (Path(os.environ["GITHUB_WORKSPACE"]), Path(info.get("DockerRootDir", "")))
    for path in paths:
        if not path.is_absolute():
            raise RuntimeError("CI write paths must be absolute")
        path = path.resolve(strict=True)
        metadata = path.stat()
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != uid:
            raise RuntimeError("CI write paths must be directories owned by the runner")
        mounts = json.loads(subprocess.check_output(
            ["/usr/bin/findmnt", "-J", "-T", str(path), "-o", "TARGET,UUID"],
            text=True, timeout=10,
        )).get("filesystems", [])
        if len(mounts) != 1:
            raise RuntimeError("CI write filesystem is ambiguous")
        target, value = mounts[0].get("target", ""), mounts[0].get("uuid", "")
        if not Path(target).is_absolute() or str(UUID(value)) != value.lower():
            raise RuntimeError("CI write filesystem has no exact mount UUID")
        mount = Path(target)
        block = (Path("/dev/disk/by-uuid") / value).stat()
        if not stat.S_ISBLK(block.st_mode) or not os.path.ismount(mount) or mount.stat().st_dev != block.st_rdev:
            raise RuntimeError(f"CI filesystem identity changed: {mount}")
        if metadata.st_dev != block.st_rdev:
            raise RuntimeError("CI writes use an unadmitted filesystem")
        space = os.statvfs(mount)
        if space.f_blocks <= 0 or space.f_bavail * 100 < space.f_blocks * 5:
            raise RuntimeError(f"CI phase filesystem reserve unavailable: {mount}")
        if path.stat().st_dev != block.st_rdev:
            raise RuntimeError("CI write filesystem changed during admission")


if __name__ == "__main__":
    if sys.argv[1:] not in ([], ["--payload"], ["--payload", "--docker-phase"]):
        raise SystemExit("Unknown phase admission arguments")
    result = check(payload="--payload" in sys.argv, docker_phase="--docker-phase" in sys.argv)
    print(json.dumps(result) if result else "CI phase admitted: owned runner filesystems retain at least 5% available space")
