"""Capture kernel phases from the hosted preflight's process tree."""

import os
import re
import select
import subprocess
import sys

# A private instance keeps the observer scoped to this launch and its descendants.
TRACE = r"""
set -eu
root=/sys/kernel/tracing
group=wasalx_compose_$1
instance=$root/instances/$group
mkdir "$instance"
cleanup() {
  rmdir "$instance"
  printf -- '-:%s/connect\n' "$group" >> "$root/dynamic_events"
}
trap cleanup EXIT
printf '0\n' > "$instance/tracing_on"
printf 'mono\n' > "$instance/trace_clock"
printf '256\n' > "$instance/buffer_size_kb"
printf '1\n' > "$instance/options/event-fork"
printf '%s\n' "$1" > "$instance/set_event_pid"
printf 'e:%s/connect syscalls.sys_enter_connect family=+u0($uservaddr):u16 port=+u2($uservaddr):u16 address=+u4($uservaddr):u32 path=+u2($uservaddr):ustring\n' "$group" >> "$root/dynamic_events"
printf '%s\n' \
  sched:sched_process_fork sched:sched_process_exec sched:sched_process_exit \
  syscalls:sys_enter_write syscalls:sys_exit_write \
  syscalls:sys_enter_writev syscalls:sys_exit_writev "$group:connect" > "$instance/set_event"
for event in sys_enter_write sys_enter_writev; do
  printf 'fd == 1 || fd == 2\n' > "$instance/events/syscalls/$event/filter"
done
printf '1\n' > "$instance/tracing_on"
printf 'ready\n'
read -r action
if [ "$action" = dump ]; then
  printf '0\n' > "$instance/tracing_on"
  cat "$instance/trace"
fi
"""

EVENT = re.compile(
    r"^\s*.+-(\d+)\s+\[\d+\]\s+\S+\s+(\d+\.\d+): (\w+): (.*)$"
)


def report(trace):
    coverage = re.search(r"entries-in-buffer/entries-written:\s*(\d+)/(\d+)", trace)
    if not coverage or coverage[1] != coverage[2]:
        print("DEV Compose phase capture missing or lossy", flush=True)
        return

    print("DEV Compose phases (monotonic ns, 1=CLI 2=metadata 3=config)", flush=True)
    parents = {}
    phases = {}
    last_plugin = {}
    writes = {}
    first_output = set()
    for line in trace.splitlines():
        match = EVENT.match(line)
        if not match:
            continue
        tid, stamp, event, detail = match.groups()
        seconds, micros = stamp.split(".")
        nanos = int(seconds) * 1_000_000_000 + int(micros.ljust(9, "0"))

        if event == "sched_process_fork":
            child = re.search(r"\bchild_pid=(\d+)", detail)[1]
            parents[child] = tid
            if tid in phases:
                phases[child] = phases[tid]
        elif event == "sched_process_exec":
            binary = detail.split(" pid=", 1)[0].rsplit("/", 1)[-1]
            parent = phases.get(parents.get(tid))
            if binary == "docker":
                phases[tid] = (tid, 1)
                print(f"{nanos} Docker CLI exec")
            elif binary == "docker-compose" and parent and parent[1] == 1:
                cli, _ = parent
                # The Docker CLI runs plugin metadata before executing the config.
                phase = 3 if cli in last_plugin else 2
                last_plugin[cli] = tid
                phases[tid] = (tid, phase)
                name = "metadata" if phase == 2 else "config"
                print(f"{nanos} Compose {name} exec")
        elif tid in phases:
            leader, phase = phases[tid]
            if event in ("sys_enter_write", "sys_enter_writev"):
                fd = re.search(r"\bfd:\s*(\w+)", detail)
                if fd:
                    writes[tid] = int(fd[1], 0)
            elif event in ("sys_exit_write", "sys_exit_writev"):
                fd = writes.pop(tid, None)
                key = (leader, fd)
                if fd is not None and int(detail.rsplit(" ", 1)[-1], 16) > 0:
                    if key not in first_output:
                        first_output.add(key)
                        print(f"{nanos} phase {phase} first output fd {fd}")
            elif event == "connect":
                if "family=2 port=0 address=16777343 " in detail:
                    endpoint = "disconnected Engine endpoint"
                elif 'path="/var/run/docker.sock"' in detail or 'path="/run/docker.sock"' in detail:
                    endpoint = "Docker Unix socket"
                else:
                    endpoint = "other endpoint"
                print(f"{nanos} phase {phase} connect {endpoint}")
            elif event == "sched_process_exit":
                if leader == tid:
                    print(f"{nanos} phase {phase} exit")
                phases.pop(tid)
                parents.pop(tid, None)


def main(command):
    observer = subprocess.Popen(
        ["sudo", "-n", "bash", "-c", TRACE, "trace-dev-compose-preflight", str(os.getpid())],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    readable, _, _ = select.select([observer.stdout], [], [], 2)
    ready = bool(readable) and observer.stdout.readline() == b"ready\n"
    status = subprocess.call(command)
    trace, errors = observer.communicate(b"dump\n" if status else b"discard\n")

    if status:
        subprocess.call(
            ["git", "show", "--no-patch", "--format=Checkout %H, tree %T", "HEAD"]
        )
        if ready and not errors and observer.returncode == 0:
            report(trace.decode())
        else:
            print("DEV Compose phase capture unavailable or incomplete", flush=True)
    return status if status >= 0 else 128 - status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

