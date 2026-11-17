"""Public-source image builds and inspected, signed digest receipts (linux/amd64)."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = "WasalX/wasalx-platform"
SOURCE = "https://github.com/" + REPOSITORY
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
SHA = re.compile(r"[0-9a-f]{40}")
ADDON_IMAGES = {"zammad", "workspace-configurator"}
CREDENTIAL = re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n"
                        rb"[A-Za-z0-9+/=]{40,128}\r?\n[A-Za-z0-9+/=]{40,128}|\bgh[pousr]_[A-Za-z0-9]{36,}\b")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def run(*args, cwd=None):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def write(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def sha256(raw):
    return "sha256:" + hashlib.sha256(raw).hexdigest()


def catalog():
    rows = json.loads((ROOT / "scripts/release/product-images.json").read_text())
    require(len(rows) == 21 and len({r["image"] for r in rows}) == 21, "Invalid image catalog")
    for row in rows:
        require(re.fullmatch(r"[a-z]+(?:-[a-z]+)*", row["image"]), "Invalid image name")
        require(row["dockerfile"] == ("infra/docker/Dockerfile.zammad" if row["image"] == "zammad"
                                    else "Dockerfile." + row["image"]), "Invalid Dockerfile")
        require((ROOT / row["dockerfile"]).is_file(), "Missing Dockerfile")
    return rows


def public_addon_source(raw=None):
    raw = os.environ.get("PUBLIC_ADDON_SOURCE", "") if raw is None else raw
    source = json.loads(raw) if raw else None
    if source is None:
        return None
    require(isinstance(source, dict) and set(source) == {"repository", "commit"}, "Invalid public add-on source fields")
    require(isinstance(source["repository"], str) and
            re.fullmatch(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source["repository"]),
            "Public add-on source requires a GitHub HTTPS repository URL")
    require(isinstance(source["commit"], str) and SHA.fullmatch(source["commit"]), "Public add-on source requires a full commit")
    return {**source, "repository": source["repository"].removesuffix(".git")}


def matrix():
    source = public_addon_source()
    return {"include": [{**row, "pending": row["image"] in ADDON_IMAGES and source is None,
                          "addonSource": source if row["image"] in ADDON_IMAGES else None} for row in catalog()]}


def coordinates():
    commit = run("git", "rev-parse", "HEAD", cwd=ROOT)
    tree = run("git", "rev-parse", "HEAD^{tree}", cwd=ROOT)
    require(SHA.fullmatch(commit) and SHA.fullmatch(tree), "Invalid source identity")
    require(run("git", "status", "--porcelain", "--untracked-files=no", cwd=ROOT) == "", "Dirty source")
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY, "Wrong public repository")
    return commit, tree


def instructions(text):
    return re.sub(r"\\\n", " ", text).splitlines()


def expand(text, values):
    def replace(match):
        key = match[1] or match[2]
        require(key in values, "Unknown metadata substitution")
        return values[key]
    return re.sub(r"\$\{(\w+)\}|\$(\w+)", replace, text)


def metadata_contract(text, commit, tree):
    """Only literal public Dockerfile metadata and pinned base metadata may ship."""
    values = {"WASALX_CANDIDATE_SHA": commit, "COMMIT_SHA": commit, "WASALX_CANDIDATE_TREE": tree}
    labels, environment, base = {}, {}, None
    lines = instructions(text)
    final_stage = max(index for index, line in enumerate(lines) if line.startswith("FROM "))
    for index, line in enumerate(lines):
        if line.startswith("ARG "):
            key, _, value = line[4:].partition("=")
            if key not in values and value:
                values[key] = value
        elif line.startswith("FROM "):
            base = expand(shlex.split(line)[1], values)
            labels, environment = {}, {}
        elif index > final_stage and line.startswith(("LABEL ", "ENV ")):
            target = labels if line.startswith("LABEL ") else environment
            for item in shlex.split(line.split(" ", 1)[1]):
                key, separator, value = item.partition("=")
                require(separator, "Unsupported metadata syntax")
                target[key] = expand(value, {**values, **environment})
    require(base == "scratch" or re.fullmatch(r"[a-z0-9./:_-]+@sha256:[0-9a-f]{64}", base or ""),
            "Final base must be pinned")
    labels.update({"org.opencontainers.image.source": SOURCE, "org.opencontainers.image.revision": commit,
                   "io.wasalx.source.tree": tree})
    return base, labels, environment


def validate_metadata(config, base, labels, environment):
    require(config.get("Labels", {}) == {**(base.get("Labels") or {}), **labels}, "Unapproved image labels")
    expected_env = dict(item.split("=", 1) for item in base.get("Env") or [])
    expected_env.update(environment)
    require(dict(item.split("=", 1) for item in config.get("Env") or []) == expected_env, "Unapproved image environment")
    require(not config.get("OnBuild"), "Deferred image instructions are forbidden")


def inspect_layers(archive, layers, base_layers):
    """Inherited layers are admitted by pinned base; inspect all added layer members/content."""
    count = 0
    for index, layer in enumerate(layers):
        if index < base_layers:
            continue
        with archive.extractfile(layer) as raw, tarfile.open(fileobj=raw, mode="r|*") as members:
            for member in members:
                path = PurePosixPath(member.name)
                require(not path.is_absolute() and ".." not in path.parts, "Unsafe image layer path")
                require(not any(part in {".git", ".ssh", ".aws", ".kube"} or
                                part == ".env" or (part.startswith(".env.") and part != ".env.example")
                                for part in path.parts), "Unapproved image layer member")
                if member.isfile():
                    with members.extractfile(member) as contents:
                        previous = b""
                        while chunk := contents.read(1024 * 1024):
                            require(not CREDENTIAL.search(previous + chunk), "Credential material in image layer")
                            previous = chunk[-512:]
                count += 1
    return count


def inspect_image(reference, row, commit, tree, directory):
    text = (ROOT / row["dockerfile"]).read_text()
    base_ref, labels, environment = metadata_contract(text, commit, tree)
    base = {"Config": {}, "RootFS": {"Layers": []}}
    if base_ref != "scratch":
        run("docker", "pull", "--platform", "linux/amd64", base_ref)
        base = json.loads(run("docker", "image", "inspect", base_ref))[0]
    inspected = json.loads(run("docker", "image", "inspect", reference))[0]
    validate_metadata(inspected["Config"], base["Config"], labels, environment)
    history = run("docker", "history", "--no-trunc", "--format", "{{json .CreatedBy}}", reference)
    require(not CREDENTIAL.search(history.encode()),
            "Credential material in image history")
    exported = Path(directory) / "image.tar"
    subprocess.run(["docker", "save", "--output", str(exported), reference], check=True)
    try:
        with tarfile.open(exported) as archive:
            manifests = json.load(archive.extractfile("manifest.json"))
            require(len(manifests) == 1, "Expected one platform image")
            manifest = manifests[0]
            raw_config = archive.extractfile(manifest["Config"]).read()
            config = json.loads(raw_config)
            validate_metadata(config["config"], base["Config"], labels, environment)
            base_diffids = base["RootFS"]["Layers"]
            diffids = config["rootfs"]["diff_ids"]
            require(diffids[:len(base_diffids)] == base_diffids, "Image base layers changed")
            require(len(manifest["Layers"]) == len(diffids), "Image layer inventory mismatch")
            for layer, expected in zip(manifest["Layers"], diffids):
                with archive.extractfile(layer) as contents:
                    require("sha256:" + hashlib.file_digest(contents, "sha256").hexdigest() == expected,
                            "Image layer digest mismatch")
            members = inspect_layers(archive, manifest["Layers"], len(base_diffids))
            return {"configDigest": sha256(raw_config), "layers": diffids, "inspectedMembers": members,
                    "historySha256": sha256(history.encode())}
    finally:
        exported.unlink(missing_ok=True)


def build(image, output):
    row = next(r for r in catalog() if r["image"] == image)
    commit, tree = coordinates()
    reference = "ghcr.io/wasalx/" + image + ":" + commit
    addon = public_addon_source() if image in ADDON_IMAGES else None
    require(image not in ADDON_IMAGES or addon is not None, "pending add-on source")
    with tempfile.TemporaryDirectory() as directory:
        context = Path(directory) / "source"
        context.mkdir()
        archive_path = Path(directory) / "source.tar"
        subprocess.run(["git", "archive", "--format=tar", "--output=" + str(archive_path), commit], cwd=ROOT, check=True)
        archive_digest = sha256(archive_path.read_bytes())
        with tarfile.open(archive_path) as archive:
            archive.extractall(context, filter="data")
        if addon:
            subprocess.run(["node", "scripts/fetch-zammad-addon.mjs"], cwd=context, check=True)
        if image == "zammad":
            pin = json.loads((context / "zammad-addon.json").read_text())
            dockerfile = context / row["dockerfile"]
            original = "https://github.com/" + pin["repository"] + ".git#" + pin["commit"]
            text = dockerfile.read_text()
            require(text.count(original) == 1, "Zammad source pin differs from source contract")
            dockerfile.write_text(text.replace(original, addon["repository"] + ".git#" + addon["commit"]))
        dockerfile_digest = sha256((context / row["dockerfile"]).read_bytes())
        # No host context, cache imports, secret/SSH mounts, registry overrides or private build arguments.
        subprocess.run(["docker", "buildx", "build", "--platform", "linux/amd64", "--load",
                        "--provenance=false", "--sbom=false", "--file", str(context / row["dockerfile"]),
                        "--tag", reference, "--build-arg", "WASALX_CANDIDATE_SHA=" + commit,
                        "--build-arg", "COMMIT_SHA=" + commit, "--build-arg", "WASALX_CANDIDATE_TREE=" + tree,
                        "--label", "org.opencontainers.image.source=" + SOURCE,
                        "--label", "org.opencontainers.image.revision=" + commit,
                        "--label", "io.wasalx.source.tree=" + tree, str(context)], check=True)
        inspection = inspect_image(reference, row, commit, tree, directory)
    write(output, {"image": image, "reference": reference, "commit": commit, "tree": tree, "status": "built",
                   "platform": "linux/amd64", "sourceArchiveDigest": archive_digest, "addonSource": addon,
                   "dockerfileDigest": dockerfile_digest, "inspection": inspection})


def pending(image, output):
    require(image in ADDON_IMAGES and public_addon_source() is None, "Only unset add-on source may be skipped")
    commit, tree = coordinates()
    write(output, {"image": image, "commit": commit, "tree": tree, "platform": "linux/amd64",
                   "status": "pending add-on source"})
    print(image + ": pending add-on source (skipped)")


def verify_manifest(manifest, config_digest):
    require(manifest.get("mediaType") in {"application/vnd.oci.image.manifest.v1+json",
                                         "application/vnd.docker.distribution.manifest.v2+json"},
            "Expected single-platform manifest, not index")
    require(manifest.get("config", {}).get("digest") == config_digest, "Published config digest mismatch")


def publish(receipt_path):
    require(os.environ.get("GITHUB_EVENT_NAME") == "push" and os.environ.get("GITHUB_REF") == "refs/heads/main",
            "Publication is main-push only")
    commit, tree = coordinates()
    receipt = json.loads(Path(receipt_path).read_text())
    require((receipt["commit"], receipt["tree"]) == (commit, tree), "Stale inspection receipt")
    repository = "ghcr.io/wasalx/" + receipt["image"]
    require(receipt["reference"] == repository + ":" + commit, "Wrong publication reference")
    result = run("docker", "push", receipt["reference"])
    matches = re.findall(r"digest: (sha256:[0-9a-f]{64})", result)
    require(len(set(matches)) == 1, "Missing unique published digest")
    digest = matches[0]
    reference = repository + "@" + digest
    raw = run("docker", "buildx", "imagetools", "inspect", "--raw", reference)
    # The digest is checked over registry bytes by the client; never hash whitespace-normalized JSON.
    verify_manifest(json.loads(raw), receipt["inspection"]["configDigest"])
    receipt.update({"digest": digest, "configDigest": receipt["inspection"]["configDigest"],
                    "pullReference": reference, "workflow": SOURCE + "/.github/workflows/branch-image.yml@refs/heads/main",
                    "workflowSha": os.environ["GITHUB_WORKFLOW_SHA"], "runId": os.environ["GITHUB_RUN_ID"],
                    "runAttempt": os.environ["GITHUB_RUN_ATTEMPT"]})
    write(receipt_path, receipt)
    predicate = {"builder": {"id": receipt["workflow"]},
                 "buildType": SOURCE + "/image-build/v1",
                 "invocation": {"configSource": {"uri": "git+" + SOURCE,
                    "digest": {"sha1": commit}, "entryPoint": ".github/workflows/branch-image.yml"},
                    "parameters": {"image": receipt["image"], "tree": tree, "configDigest": receipt["configDigest"],
                                   "sourceArchiveDigest": receipt["sourceArchiveDigest"],
                                   "addonSource": receipt["addonSource"], "dockerfileDigest": receipt["dockerfileDigest"],
                                   "inspectionSha256": sha256(json.dumps(receipt["inspection"], sort_keys=True).encode()),
                                   "workflowSha": receipt["workflowSha"]}},
                 "metadata": {"buildInvocationId": SOURCE + "/actions/runs/" + receipt["runId"] +
                              "/attempts/" + receipt["runAttempt"]},
                 "materials": [{"uri": "git+" + SOURCE, "digest": {"sha1": commit, "gitTree": tree}}]}
    predicate_path = str(receipt_path) + ".predicate.json"
    write(predicate_path, predicate)
    run("cosign", "sign", "--yes", reference)
    run("cosign", "attest", "--yes", "--type", "slsaprovenance", "--predicate", predicate_path, reference)
    identity = receipt["workflow"]
    common = ["--certificate-identity", identity, "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com"]
    run("cosign", "verify", *common, reference)
    run("cosign", "verify-attestation", *common, "--type", "slsaprovenance", reference)
    run("docker", "pull", "--platform", "linux/amd64", reference)
    row = next(r for r in catalog() if r["image"] == receipt["image"])
    with tempfile.TemporaryDirectory() as directory:
        final = inspect_image(reference, row, commit, tree, directory)
    require(final == receipt["inspection"], "Published image differs from inspected image")
    # Advance the discovery alias only after signature and exact-digest reinspection.
    run("docker", "tag", reference, repository + ":main")
    alias_result = run("docker", "push", repository + ":main")
    require("digest: " + digest in alias_result, "Discovery alias digest mismatch")
    receipt["verified"] = True
    receipt["status"] = "published"
    write(receipt_path, receipt)


def assemble(records):
    require(len(records) == 21 and {r["image"] for r in records} == {r["image"] for r in catalog()},
            "Complete unique image receipts required")
    require(len({(r["commit"], r["tree"]) for r in records}) == 1, "Mixed source identities")
    published, pending_images = {}, {}
    for row in records:
        require(SHA.fullmatch(row["commit"]) and SHA.fullmatch(row["tree"]), "Invalid receipt source identity")
        if row.get("status") == "pending add-on source":
            require(row["image"] in ADDON_IMAGES and not any(key in row for key in ["digest", "configDigest", "verified"]),
                    "Only add-on-dependent images may be pending without digest claims")
            pending_images[row["image"]] = row
            continue
        require(row.get("verified") is True and DIGEST.fullmatch(row.get("digest", "")) and
                DIGEST.fullmatch(row.get("configDigest", "")), "Verified digest pair required")
        require(row["pullReference"] == "ghcr.io/wasalx/" + row["image"] + "@" + row["digest"], "Wrong digest reference")
        published[row["image"]] = row
    return {"schemaVersion": 1, "repository": REPOSITORY, "platform": "linux/amd64",
            "commit": records[0]["commit"], "tree": records[0]["tree"],
            "publicationComplete": not pending_images, "images": dict(sorted(published.items())),
            "pending": dict(sorted(pending_images.items()))}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["matrix", "build", "pending", "publish", "assemble"])
    parser.add_argument("--image")
    parser.add_argument("--output", default="images-manifest.json")
    parser.add_argument("--records", default="records")
    args = parser.parse_args()
    if args.command == "matrix":
        print(json.dumps(matrix(), separators=(",", ":")))
    elif args.command == "build":
        build(args.image, args.output)
    elif args.command == "publish":
        publish(args.output)
    elif args.command == "pending":
        pending(args.image, args.output)
    else:
        write(args.output, assemble([json.loads(p.read_text()) for p in Path(args.records).glob("*.json")]))
