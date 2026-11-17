"""Validate a signed assisted release; never mutate the creation snapshot."""
import copy
import hashlib
import json
import os
from pathlib import Path
import re
import sys


IMAGE_FIELDS = ("image", "configuratorImage", "nginxImage", "redisImage", "memcachedImage")
PACKAGE_FIELDS = {"packageVersion": r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?",
                  "packageSha256": r"[0-9a-f]{64}"}
DIGEST = r"ghcr\.io/wasalx/wasalx/[a-z0-9-]+@sha256:[0-9a-f]{64}"
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate(desired, existing, workloads, manifest, controller):
    for item in workloads["items"]:
        metadata = item.get("metadata", {})
        labels = metadata.get("labels", {})
        identity = " ".join((metadata.get("name", ""), labels.get("app.kubernetes.io/name", "")))
        require(not re.search(r"(?:tenant-provisioner|workspace-controller|workspace-provider)", identity)
                and labels.get("wasalx.io/plane") != "provisioning",
                "Commercial lifecycle workloads must be absent for assisted deployment")
    release = manifest["release"]
    require(all(re.fullmatch(r"[0-9a-f]{40}", release[key]) for key in ("sourceRevision", "sourceTree")),
            "Invalid release source identity")
    require(release["sourceRepository"] == "WasalX/WasalX", "Invalid release repository")
    images = [item["reference"] for item in manifest["images"] if item["id"] == "tenant-workspace-controller"]
    require(images == [controller] and re.fullmatch(DIGEST, controller), "Controller release mismatch")
    tenant = manifest["tenantProvisioning"]
    expected = dict(zip(IMAGE_FIELDS, (tenant["zammadImages"]["7.1.3"], tenant["configuratorImage"],
                                     tenant["nginxImage"], tenant["redisImage"], tenant["memcachedImage"])))
    for field, reference in expected.items():
        require(re.fullmatch(DIGEST, reference) and desired["spec"]["zammad"][field] == reference,
                "Workspace image does not match the verified release")
    for field, pattern in PACKAGE_FIELDS.items():
        require(re.fullmatch(pattern, tenant[field])
                and desired["spec"]["zammad"][field] == tenant[field], "Package release mismatch")
    if existing is not None:
        require(re.fullmatch(UUID, existing["metadata"]["uid"]), "Invalid workspace UID")
        require(all(existing["metadata"].get("labels", {}).get(key) == desired["metadata"]["labels"][key]
                    for key in ("wasalx.io/tenant", "app.kubernetes.io/part-of")), "Workspace ownership labels mismatch")
        require(existing["apiVersion"] == desired["apiVersion"] and existing["kind"] == desired["kind"]
                and all(existing["metadata"][key] == desired["metadata"][key] for key in ("name", "namespace")),
                "Workspace identity mismatch")
        current, target = copy.deepcopy(existing["spec"]), copy.deepcopy(desired["spec"])
        for field in IMAGE_FIELDS:
            require(re.fullmatch(DIGEST, current["zammad"][field]), "Invalid creation image")
            del current["zammad"][field]
            del target["zammad"][field]
        for field, pattern in PACKAGE_FIELDS.items():
            require(re.fullmatch(pattern, current["zammad"][field]), "Invalid creation package")
            del current["zammad"][field]
            del target["zammad"][field]
        require(current == target, "Assisted updates permit only signed images and package; tenant configuration drift")


def binding(workspace, manifest_bytes, controller):
    manifest = json.loads(manifest_bytes)
    uid = workspace["metadata"]["uid"]
    require(re.fullmatch(UUID, uid), "Invalid workspace UID")
    tuple_json = json.dumps(manifest["tenantProvisioning"], sort_keys=True, separators=(",", ":"))
    return {
        "apiVersion": "v1", "kind": "ConfigMap",
        "metadata": {
            "name": workspace["metadata"]["name"] + "-runtime-release", "namespace": workspace["metadata"]["namespace"],
            "labels": {"app.kubernetes.io/part-of": "wasalx", "wasalx.io/tenant": workspace["spec"]["tenantId"]},
            "ownerReferences": [{"apiVersion": workspace["apiVersion"], "kind": workspace["kind"],
                                 "name": workspace["metadata"]["name"], "uid": uid}],
        },
        "data": {
            "release.json": json.dumps(manifest["release"], sort_keys=True),
            "manifestSha256": hashlib.sha256(manifest_bytes).hexdigest(),
            "controllerImage": controller,
            "tenantProvisioning.json": tuple_json,
            "tenantProvisioningSha256": hashlib.sha256(tuple_json.encode()).hexdigest(),
        },
    }


if __name__ == "__main__":
    try:
        directory = Path(sys.argv[1])
        manifest_bytes = Path(os.environ["WASALX_RELEASE_MANIFEST"]).read_bytes()
        manifest = json.loads(manifest_bytes)
        controller = os.environ["WASALX_TENANT_CONTROLLER_IMAGE"]
        require(json.loads(os.environ["WASALX_TENANT_PROVISIONING_JSON"]) == manifest["tenantProvisioning"],
                "Tenant tuple differs from verified release")
        desired = json.loads((directory / "workspace.json").read_text())["items"][0]
        current_bytes = (directory / "existing-workspace.json").read_text()
        current = json.loads(current_bytes) if current_bytes.strip() else None
        workloads = json.loads((directory / "lifecycle-workloads.json").read_text())
        validate(desired, current, workloads, manifest, controller)
        if len(sys.argv) == 3 and sys.argv[2] == "binding":
            require(current is not None, "Workspace must exist before release binding")
            print(json.dumps(binding(current, manifest_bytes, controller)))
    except (ValueError, KeyError, TypeError, OSError, IndexError):
        sys.exit("Assisted release admission failed: inspect workspace identity, image tuple and lifecycle isolation")
