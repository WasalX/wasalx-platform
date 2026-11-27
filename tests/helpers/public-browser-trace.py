"""Keep only Playwright action metadata in a public browser trace."""

import json
import sys
from pathlib import PurePosixPath
from zipfile import ZIP_DEFLATED, ZipFile


def public_trace(raw, output):
    fields = {
        "context-options": (
            "version",
            "origin",
            "browserName",
            "playwrightVersion",
            "platform",
            "wallTime",
            "monotonicTime",
            "sdkLanguage",
            "contextId",
        ),
        "before": ("callId", "startTime", "class", "method", "pageId"),
        "after": ("callId", "endTime"),
    }
    with ZipFile(raw) as archive:
        events = []
        for line in archive.read("trace.trace").splitlines():
            event = json.loads(line)
            kind = event["type"]
            if kind not in fields:
                continue
            public = {
                "type": kind,
                **{key: event[key] for key in fields[kind] if key in event},
            }
            if kind == "context-options":
                public["options"] = {}
            if kind == "before":
                public["params"] = {}
            if kind == "after" and event.get("error"):
                public["error"] = {
                    "name": "Error",
                    "message": "Action failed. See the CI job log.",
                }
            events.append(public)

        stacks = {"files": [], "stacks": []}
        if "trace.stacks" in archive.namelist():
            original = json.loads(archive.read("trace.stacks"))
            for file in original["files"]:
                path = PurePosixPath(file)
                stacks["files"].append(
                    f"tests/{path.name}"
                    if path.parent.name == "tests" and path.name.endswith("-browser.mjs")
                    else ""
                )
            for call, frames in original["stacks"]:
                safe_frames = [
                    [index, line, column, ""]
                    for index, line, column, _ in frames
                    if stacks["files"][index]
                ]
                if safe_frames:
                    stacks["stacks"].append([call, safe_frames])

    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        archive.writestr("trace.trace", "".join(json.dumps(event) + "\n" for event in events))
        archive.writestr("trace.stacks", json.dumps(stacks))


if __name__ == "__main__":
    public_trace(*sys.argv[1:])
