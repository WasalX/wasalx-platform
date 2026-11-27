"""Publish and verify the object-storage digests pinned in the full Compose inventory."""

import argparse
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

from image_registry_retry import registry_output

COMPOSE = Path("compose.full.yaml")
INVENTORY = "x-object-storage-mirrors"
REPOSITORY = r"[a-z0-9.-]+(?:/[a-z0-9._-]+)+"
IMAGE = re.compile(rf"({REPOSITORY})(?::[\w.-]+)?@(sha256:[0-9a-f]{{64}})")


def load_compose(raw):
    # Use the same YAML parser as the Compose pin checks in validate-infra.sh.
    data = subprocess.check_output(
        [
            "ruby",
            "-rjson",
            "-ryaml",
            "-e",
            "puts JSON.generate(YAML.safe_load(STDIN.read, aliases: true))",
        ],
        input=raw,
        timeout=5,
    )
    return json.loads(data)


def parse_reference(value, service):
    match = IMAGE.fullmatch(value) if isinstance(value, str) else None
    if not match:
        raise ValueError(f"{service}: expected an exact upstream image digest")
    return match.groups()


def inventory(compose):
    rows = compose.get(INVENTORY)
    if not isinstance(rows, dict) or not rows:
        raise ValueError(f"Missing {INVENTORY} in {COMPOSE}")
    for service, row in rows.items():
        if not isinstance(row, dict) or row.keys() != {"mirror", "fallback", "staged"}:
            raise ValueError(f"{service}: expected mirror, fallback and staged fields")
        active = compose["services"][service]["image"]
        upstream, digest = parse_reference(active, service)
        mirror = row["mirror"]
        fallback = row["fallback"]
        if not isinstance(mirror, str) or not re.fullmatch(
            r"ghcr\.io/wasalx/[a-z0-9._-]+", mirror
        ):
            raise ValueError(f"{service}: invalid mirror repository")
        if (
            not isinstance(fallback, str)
            or not re.fullmatch(REPOSITORY, fallback)
            or fallback == mirror
        ):
            raise ValueError(f"{service}: invalid fallback repository")
        staged = row["staged"]
        if staged is not None:
            staged_upstream, staged_digest = parse_reference(staged, service)
            if staged_upstream != upstream or staged_digest == digest:
                raise ValueError(
                    f"{service}: stage a different digest from the same upstream repository"
                )
        yield service, active, f"{upstream}@{digest}", f"{mirror}@{digest}", fallback, staged


def verify_manifest(reference, *, published=False):
    raw = registry_output(
        "docker",
        "buildx",
        "imagetools",
        "inspect",
        "--raw",
        reference,
        timeout=10,
        delays=(10, 20) if published else (),
        retry_missing_manifest=published,
    )
    actual = "sha256:" + hashlib.sha256(raw).hexdigest()
    if actual != reference.rsplit("@", 1)[1]:
        raise ValueError(f"Digest mismatch for {reference}: got {actual}")


def publish(source, mirrored, fallback):
    mirror, digest = mirrored.split("@", 1)
    tag = f"{mirror}:sha256-{digest.removeprefix('sha256:')}"
    for reference in (source, f"{fallback}@{digest}"):
        try:
            verify_manifest(reference)
            # Preserve both single-manifest and index bytes.
            subprocess.run(
                [
                    "docker",
                    "buildx",
                    "imagetools",
                    "create",
                    "--prefer-index=false",
                    "--tag",
                    tag,
                    reference,
                ],
                check=True,
                timeout=120,
            )
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            if reference != source:
                raise
            print(
                f"Copy from {source} failed. Trying the same digest from the fallback.",
                file=sys.stderr,
            )
        else:
            break
    verify_manifest(mirrored, published=True)
    print(f"Verified {mirrored}")


def verify_active(rows, base):
    base_rows = base.get(INVENTORY, {})
    if base_rows.keys() - {row[0] for row in rows}:
        raise ValueError("An object-storage mirror is missing from the candidate inventory")
    for service, active, source, mirrored, _, _ in rows:
        previous = base_rows.get(service, {})
        mirror = mirrored.split("@", 1)[0]
        upstream, digest = parse_reference(base["services"][service]["image"], service)
        if source != f"{upstream}@{digest}" or previous.get("mirror", mirror) != mirror:
            if previous.get("staged") != active or previous.get("mirror") != mirror:
                raise ValueError(
                    f"{service}: stage this exact reference on main before activation"
                )
    for _, _, _, mirrored, _, _ in rows:
        verify_manifest(mirrored)
        print(f"Verified {mirrored}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["publish", "verify", "references"])
    parser.add_argument("--base")
    args = parser.parse_args()
    if args.command == "verify" and not re.fullmatch("[0-9a-f]{40}", args.base or ""):
        parser.error("verify requires the exact protected base SHA")
    rows = list(inventory(load_compose(COMPOSE.read_bytes())))
    if args.command == "references":
        print(json.dumps({source: mirrored for _, _, source, mirrored, _, _ in rows}))
    elif args.command == "verify":
        base = subprocess.check_output(
            ["git", "show", f"{args.base}:{COMPOSE}"], timeout=5
        )
        verify_active(rows, load_compose(base))
    else:
        for service, _, source, mirrored, fallback, staged in rows:
            publish(source, mirrored, fallback)
            if staged is not None:
                upstream, digest = parse_reference(staged, service)
                publish(f"{upstream}@{digest}", f"{mirrored.split('@')[0]}@{digest}", fallback)


if __name__ == "__main__":
    try:
        main()
    except (KeyError, TypeError, ValueError, OSError, subprocess.SubprocessError) as error:
        sys.exit(f"Object-storage mirrors: {error}")
