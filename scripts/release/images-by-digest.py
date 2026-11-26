"""Public-source image builds and inspected, signed digest receipts (linux/amd64)."""
import argparse
import base64
import hashlib
import json
import io
from fnmatch import fnmatchcase
import os
from pathlib import Path, PurePosixPath
import re
import shlex
import subprocess
import sys
import tarfile
import tempfile
import urllib.request

from image_registry_retry import registry_output


ROOT = Path(__file__).resolve().parents[2]
REPOSITORY = "WasalX/wasalx-platform"
SOURCE = "https://github.com/" + REPOSITORY
MAIN_PUBLISHER = SOURCE + "/.github/workflows/branch-image.yml@refs/heads/main"
CATALOG_PATH = "scripts/release/product-images.json"
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
SHA = re.compile(r"[0-9a-f]{40}")
ADDON_STAGED = ("zammad-package/", "build/zammad/", "build/addon-licenses/", "tests/fixtures/")
RERUN_ALL = {
    "scripts/release/images-by-digest.py",  # Selects, builds, and inspects images.
    "scripts/release/image_registry_retry.py",  # Shared by image builds and publishing.
    ".github/workflows/ci.yml",  # Configures the PR image build jobs and their inputs.
    CATALOG_PATH,  # Supplies the Dockerfile and image matrix.
    "zammad-addon.json",  # Pins the public add-on source passed to image builds.
}
CACHED_IMAGES = {
    "production-prometheus", "zammad", "production-otel", "control-api", "connector-worker", "portal",
    "tenant-provisioner", "tenant-workspace-controller", "workspace-provider", "identity-policy-activator",
    "invitation-mailer",
}
CREDENTIAL = re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n"
                        rb"[A-Za-z0-9+/=]{40,128}\r?\n[A-Za-z0-9+/=]{40,128}|\bgh[pousr]_[A-Za-z0-9]{36,}\b")
PEM = re.compile(rb"-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----\r?\n"
                 rb"(?:[A-Za-z0-9+/=]+\r?\n)+-----END \1-----")
# Public built-in hello-world TLS key: cloudflared 2026.9.1, tlsconfig/hello_ca.go.
CLOUDFLARED_SOURCE = "e75d9a314ae07ae42564c0d3115b9e33d8a7329d99771951ab7b67144461bd84"
PUBLIC_KEYS = {"production-cloudflared": {"usr/local/bin/cloudflared": {
    "17ac4c2ca3deb87202cd2c101d4da9d4f4c0ec3d51a0381729329102b28e61a4"}}}
ZAMMAD_PUBLIC_BASE = "ghcr.io/zammad/zammad@sha256:390705d0eefd8a473293c1f9130cb2f40a2484bd629dd3b33aa0e700ee86d13b"
_zammad_public_contract = None


class HashingReader:
    def __init__(self, stream):
        self.stream = stream
        self.digest = hashlib.sha256()

    def read(self, size=-1):
        raw = self.stream.read(size)
        self.digest.update(raw)
        return raw


def restricted_path(path):
    return any(part in {".git", ".ssh", ".aws", ".kube", ".env"} or
               (part.startswith(".env.") and part != ".env.example") for part in PurePosixPath(path).parts)


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


def catalog(*, commit=None):
    raw = (ROOT / CATALOG_PATH).read_text() if commit is None else run("git", "show", f"{commit}:{CATALOG_PATH}", cwd=ROOT)
    rows = json.loads(raw)
    require(rows and len({r["image"] for r in rows}) == len(rows), "Invalid image catalog")
    if commit is None:
        require(len(rows) == 21, "Invalid image catalog")
    for row in rows:
        require(re.fullmatch(r"[a-z]+(?:-[a-z]+)*", row["image"]), "Invalid image name")
        require(type(row.get("stagesAddon", False)) is bool, "Invalid add-on staging flag")
        if commit is None:
            require(row["dockerfile"] == ("infra/docker/Dockerfile.zammad" if row["image"] == "zammad"
                                        else "Dockerfile." + row["image"]), "Invalid Dockerfile")
            require((ROOT / row["dockerfile"]).is_file(), "Missing Dockerfile")
    return rows


def addon_images(rows):
    return {row["image"] for row in rows if row.get("stagesAddon", False)}


def public_addon_source(raw=None):
    pin = json.loads((ROOT / "zammad-addon.json").read_text())
    expected = {"repository": "https://github.com/" + pin["repository"], "commit": pin["commit"]}
    raw = os.environ.get("PUBLIC_ADDON_SOURCE", "") if raw is None else raw
    source = json.loads(raw) if raw else expected
    require(isinstance(source, dict) and set(source) == {"repository", "commit"}, "Invalid public add-on source fields")
    require(isinstance(source["repository"], str) and
            re.fullmatch(r"https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", source["repository"]),
            "Public add-on source requires a GitHub HTTPS repository URL")
    require(isinstance(source["commit"], str) and SHA.fullmatch(source["commit"]), "Public add-on source requires a full commit")
    source = {**source, "repository": source["repository"].removesuffix(".git")}
    require(source == expected, "Public add-on source differs from the pin")
    return source


def matrix(changed_paths=None, *, pull_request=False):
    rows = catalog()
    if changed_paths is not None:
        rows = changed_images(rows, changed_paths, pull_request=pull_request)
    source = public_addon_source() if rows else None
    addons = addon_images(rows)
    return {"include": [{"image": row["image"], "dockerfile": row["dockerfile"],
                          "pending": row["image"] in addons and source is None,
                          "addonSource": source if row["image"] in addons else None} for row in rows]}


def coordinates():
    commit = run("git", "rev-parse", "HEAD", cwd=ROOT)
    tree = run("git", "rev-parse", "HEAD^{tree}", cwd=ROOT)
    require(SHA.fullmatch(commit) and SHA.fullmatch(tree), "Invalid source identity")
    require(run("git", "status", "--porcelain", "--untracked-files=no", cwd=ROOT) == "", "Dirty source")
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY, "Wrong public repository")
    return commit, tree


def instructions(text):
    return re.sub(r"\\\n", " ", text).splitlines()


def context_sources(text):
    # shortcut: map literal default-context sources, build all for other context syntax.
    if re.search(r"(?im)^\s*#\s*escape\s*=", text):
        return None
    paths = set()
    text = re.sub(r"(?m)^[ \t]*(?:#[^\n]*)?\n", "", text)
    for line in re.sub(r"\\[ \t]*\n", "", text).splitlines():
        fields = line.split(maxsplit=1)
        if len(fields) != 2:
            continue
        instruction, arguments = fields
        instruction = instruction.upper()
        if instruction == "ONBUILD" or (instruction == "RUN" and
                re.search(r"(?:^|\s)--mount(?:\s|=)(?!type=cache(?:,|\s|$))", arguments)):
            return None
        if instruction not in {"COPY", "ADD"}:
            continue
        fields = arguments.split()
        options = []
        while fields and fields[0].startswith("--"):
            options.append(fields.pop(0))
        if len(fields) < 2 or any(not re.fullmatch(r"--(?:from|chmod|chown|checksum)=[\w:./@+-]+", flag)
                                  for flag in options):
            return None
        if any(flag.startswith("--from=") for flag in options):
            continue
        for source in fields[:-1]:
            if instruction == "ADD" and source.startswith("https://"):
                continue
            path = PurePosixPath(source).as_posix().lstrip("/")
            if not re.fullmatch(r"[\w./+-]+", source) or not path or path == "." or ".." in path.split("/"):
                return None
            paths.add(path)
    return paths


def changed_images(rows, paths, *, pull_request=False):
    inputs = {}
    for row in rows:
        dockerfile = row["dockerfile"]
        sources = context_sources((ROOT / dockerfile).read_text())
        if sources is None:  # An unsupported Dockerfile context may depend on any path.
            return rows
        inputs[row["image"]] = sources | {dockerfile}

    ignored = ("README.md", "docs/*", ".github/workflows/deploy.yml", ".github/dependabot.yml",
               "scripts/hosted-ci*.mjs", "scripts/hosted-ci*.json", "scripts/test-unit.mjs", "tests/hosted-ci.test.mjs")
    addons = addon_images(rows)
    selected = set()
    for path in paths:
        name = PurePosixPath(path).name
        if pull_request and (path in RERUN_ALL or name == ".gitattributes" or name.endswith(".dockerignore")):
            return rows
        matches = {image for image, sources in inputs.items()
                   if any(path == source or path.startswith(source + "/") for source in sources)}
        # The staging helper checks these paths before Docker reads the context.
        if pull_request and (path == "scripts/fetch-zammad-addon.mjs" or path.startswith(ADDON_STAGED)
                             or re.fullmatch(r"tests/[^/]+\.rb", path)):
            matches |= addons
        if not pull_request and len(matches) != 1 and (
                matches or not any(fnmatchcase(path, pattern) for pattern in ignored)):
            return rows
        selected.update(matches)
    return [row for row in rows if row["image"] in selected]


def changed_paths(base):
    # Compare the checked-out test merge with its base, including both sides of renames.
    try:
        raw = subprocess.check_output(
            ["git", "diff", "--name-only", "-z", "--no-ext-diff", "--no-renames", base, "HEAD", "--"], cwd=ROOT)
    except subprocess.CalledProcessError:
        return None
    return [os.fsdecode(path) for path in raw.split(b"\0") if path]


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


def inspect_content(contents, public_keys=()):
    previous = b""
    while True:
        chunk = contents.read(1024 * 1024)
        data = previous + chunk
        boundary = max(0, len(data) - 65536) if chunk else len(data)
        for match in CREDENTIAL.finditer(data):
            if match.start() >= boundary:
                continue
            pem = PEM.match(data, match.start())
            require(pem is not None and hashlib.sha256(pem.group()).hexdigest() in public_keys,
                    "Credential material in image layer")
        previous = data[boundary:]
        if not chunk:
            return


def zammad_public_contract():
    """Bind copied public key content to verified public OCI bytes, without extracting files."""
    global _zammad_public_contract
    if _zammad_public_contract is not None:
        return _zammad_public_contract
    prefix = "https://ghcr.io/v2/zammad/zammad/"
    with urllib.request.urlopen("https://ghcr.io/token?service=ghcr.io&scope=repository:zammad/zammad:pull", timeout=30) as response:
        token = json.load(response)["token"]
    headers = {"Authorization": "Bearer " + token, "Accept": ", ".join([
        "application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json",
        "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json"])}

    def manifest(digest):
        with urllib.request.urlopen(urllib.request.Request(prefix + "manifests/" + digest, headers=headers), timeout=30) as response:
            raw = response.read()
        require(sha256(raw) == digest, "Public base manifest digest mismatch")
        return json.loads(raw)

    data = manifest(ZAMMAD_PUBLIC_BASE.split("@", 1)[1])
    if "manifests" in data:
        platforms = [m for m in data["manifests"] if m.get("platform", {}).get("os") == "linux" and
                     m.get("platform", {}).get("architecture") == "amd64"]
        require(len(platforms) == 1, "Unique public base platform required")
        data = manifest(platforms[0]["digest"])
    keys, members = {}, {}
    for layer in data["layers"]:
        require(layer["mediaType"] in {"application/vnd.oci.image.layer.v1.tar+gzip",
                                      "application/vnd.docker.image.rootfs.diff.tar.gzip",
                                      "application/vnd.oci.image.layer.v1.tar"}, "Unsupported public base layer")
        with urllib.request.urlopen(urllib.request.Request(prefix + "blobs/" + layer["digest"], headers=headers), timeout=30) as response:
            reader = HashingReader(response)
            with tarfile.open(fileobj=reader, mode="r|*") as archive:
                for member in archive:
                    path = str(PurePosixPath(member.name)).lstrip("/")
                    if not path.startswith(("usr/local/", "opt/zammad/")):
                        continue
                    if not member.isfile():
                        if restricted_path(path):
                            require(member.isdir() or member.issym() or member.islnk(), "Unsupported public copied member")
                            members[path] = {"type": "directory" if member.isdir() else "symlink" if member.issym() else "hardlink", "target": member.linkname}
                        continue
                    previous = b""
                    with archive.extractfile(member) as contents:
                        content = HashingReader(contents)
                        while chunk := content.read(1024 * 1024):
                            value = previous + chunk
                            for match in PEM.finditer(value):
                                keys.setdefault(path, set()).add(hashlib.sha256(match.group()).hexdigest())
                            previous = value[-65536:]
                        if restricted_path(path):
                            members[path] = {"type": "file", "sha256": "sha256:" + content.digest.hexdigest()}
            while reader.read(1024 * 1024):
                pass
            require("sha256:" + reader.digest.hexdigest() == layer["digest"], "Public base layer digest mismatch")
    _zammad_public_contract = {"keys": keys, "members": members}
    return _zammad_public_contract


def inspect_layers(archive, layers, base_layers, public_keys=None, licenses=None, public_members=None):
    """Inherited layers are admitted by pinned base; inspect all added layer members/content."""
    count = 0
    seen_licenses = {}
    for index, layer in enumerate(layers):
        if index < base_layers:
            continue
        with archive.extractfile(layer) as raw, tarfile.open(fileobj=raw, mode="r|*") as members:
            for member in members:
                path = PurePosixPath(member.name)
                require(not path.is_absolute() and ".." not in path.parts, "Unsafe image layer path")
                known = (public_members or {}).get(str(path)) if restricted_path(path) else None
                if restricted_path(path):
                    kind = "file" if member.isfile() else "directory" if member.isdir() else "symlink" if member.issym() else "hardlink" if member.islnk() else "unsupported"
                    require(known and known["type"] == kind, "Unapproved image layer member")
                    if not member.isfile():
                        require(known["target"] == member.linkname, "Public copied link mismatch")
                if member.isfile():
                    with members.extractfile(member) as contents:
                        checked = HashingReader(contents)
                        if str(path) in (licenses or {}):
                            require(member.size <= 1024 * 1024, "Unexpected licence file size")
                            raw = checked.read()
                            seen_licenses[str(path)] = sha256(raw)
                            inspect_content(io.BytesIO(raw))
                        else:
                            inspect_content(checked, (public_keys or {}).get(str(path), ()))
                        if known:
                            require("sha256:" + checked.digest.hexdigest() == known["sha256"], "Public copied file mismatch")
                count += 1
    require(seen_licenses == (licenses or {}), "Add-on licence content mismatch")
    return count


def inspect_image(reference, row, commit, tree, directory, licenses=None):
    text = (ROOT / row["dockerfile"]).read_text()
    if row["image"] in PUBLIC_KEYS:
        require("ADD --checksum=sha256:" + CLOUDFLARED_SOURCE in text and
                "https://github.com/cloudflare/cloudflared/archive/refs/tags/2026.9.1.tar.gz" in text,
                "Public key-content allowance requires the reviewed source archive")
    public_keys = PUBLIC_KEYS.get(row["image"], {})
    public_members = {}
    if row["image"] == "zammad":
        require("ARG ZAMMAD_BASE_IMAGE=" + ZAMMAD_PUBLIC_BASE in text, "Reviewed Zammad public base required")
        contract = zammad_public_contract()
        public_keys, public_members = contract["keys"], contract["members"]
    base_ref, labels, environment = metadata_contract(text, commit, tree)
    base = {"Config": {}, "RootFS": {"Layers": []}}
    if base_ref != "scratch":
        pull(base_ref)
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
            members = inspect_layers(archive, manifest["Layers"], len(base_diffids), public_keys, licenses, public_members)
            return {"configDigest": sha256(raw_config), "layers": diffids, "inspectedMembers": members,
                    "addonLicenses": licenses or {},
                    "publicContentContractSha256": sha256(json.dumps({"keys": {p: sorted(v) for p, v in public_keys.items()},
                        "members": public_members}, sort_keys=True).encode()),
                    "historySha256": sha256(history.encode())}
    finally:
        exported.unlink(missing_ok=True)


def pull(reference):
    registry_output("docker", "pull", "--platform", "linux/amd64", reference, delays=(1, 2))


def cache_options(image, mode):
    if mode == "off":
        return []
    event = os.environ.get("GITHUB_EVENT_NAME")
    publishing = (event == "push" and os.environ.get("GITHUB_REF") == "refs/heads/main"
                  and os.environ.get("GITHUB_REPOSITORY") == REPOSITORY)
    require(mode == "read" and event in {"pull_request", "merge_group"} or mode == "write" and publishing,
            "Cache imports are checks-only and cache exports are main-publish only")
    if image not in CACHED_IMAGES:
        return []
    cache_ref = "type=registry,ref=ghcr.io/wasalx/buildcache:" + image
    return ["--cache-from", cache_ref] if mode == "read" else ["--cache-to", cache_ref + ",mode=max,ignore-error=true"]


def build(image, output, cache="off"):
    row = next(r for r in catalog() if r["image"] == image)
    cache_args = cache_options(image, cache)
    portal_args = ["--build-arg", "PUBLIC_CONTACT_EMAIL"] if image == "portal" else []
    commit, tree = coordinates()
    epoch = run("git", "log", "-1", "--format=%ct", commit, cwd=ROOT)
    reference = "ghcr.io/wasalx/" + image + ":" + commit
    stages_addon = row.get("stagesAddon", False)
    addon = public_addon_source() if stages_addon else None
    require(not stages_addon or addon is not None, "pending add-on source")
    with tempfile.TemporaryDirectory() as directory:
        context = Path(directory) / "source"
        context.mkdir()
        archive_path = Path(directory) / "source.tar"
        subprocess.run(
            ["git", "-c", "core.autocrlf=false", "archive", "--format=tar", "--output=" + str(archive_path), commit],
            cwd=ROOT, check=True,
        )
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
        if addon:
            dockerfile = context / row["dockerfile"]
            dockerfile.write_text(dockerfile.read_text() +
                "\nCOPY --chown=0:0 build/addon-licenses/ /usr/share/licenses/wasalx-zammad-addon/\n")
        licenses = {"usr/share/licenses/wasalx-zammad-addon/" + name:
                    sha256((context / "build/addon-licenses" / name).read_bytes())
                    for name in ["LICENSE", "COPYING", "THIRD-PARTY-NOTICES"]} if addon else {}
        dockerfile_digest = sha256((context / row["dockerfile"]).read_bytes())
        # Publication exports a cache but never imports one. No host context or secret/SSH mounts.
        registry_output("docker", "buildx", "build", "--platform", "linux/amd64",
                        "--output", "type=docker,rewrite-timestamp=true",
                        "--provenance=false", "--sbom=false", *cache_args, "--file", str(context / row["dockerfile"]),
                        "--tag", reference, "--build-arg", "WASALX_CANDIDATE_SHA=" + commit,
                        "--build-arg", "SOURCE_DATE_EPOCH=" + epoch,
                        "--build-arg", "COMMIT_SHA=" + commit, "--build-arg", "WASALX_CANDIDATE_TREE=" + tree,
                        *portal_args,
                        "--label", "org.opencontainers.image.source=" + SOURCE,
                        "--label", "org.opencontainers.image.revision=" + commit,
                        "--label", "io.wasalx.source.tree=" + tree, str(context), capture_stdout=False)
        inspection = inspect_image(reference, row, commit, tree, directory, licenses)
    receipt = {"image": image, "reference": reference, "commit": commit, "tree": tree, "status": "built",
               "platform": "linux/amd64", "sourceArchiveDigest": archive_digest, "addonSource": addon,
               "dockerfileDigest": dockerfile_digest, "inspection": inspection}
    if image == "portal":
        receipt["contactEmailSha256"] = sha256(os.environ.get("PUBLIC_CONTACT_EMAIL", "").encode())
    write(output, receipt)


def pending(image, output):
    require(image in addon_images(catalog()) and public_addon_source() is None, "Only unset add-on source may be skipped")
    commit, tree = coordinates()
    write(output, {"image": image, "commit": commit, "tree": tree, "platform": "linux/amd64",
                   "status": "pending add-on source"})
    print(image + ": pending add-on source (skipped)")


def verify_manifest(manifest, config_digest):
    require(manifest.get("mediaType") in {"application/vnd.oci.image.manifest.v1+json",
                                         "application/vnd.docker.distribution.manifest.v2+json"},
            "Expected single-platform manifest, not index")
    require(manifest.get("config", {}).get("digest") == config_digest, "Published config digest mismatch")


def loaded_config(stream, config_digest):
    require(DIGEST.fullmatch(config_digest or ""), "Exact loaded config digest required")
    config_names = {config_digest[7:] + ".json", "blobs/sha256/" + config_digest[7:]}
    manifest, config, config_name = None, None, None
    with tarfile.open(fileobj=stream, mode="r|") as archive:
        for member in archive:
            if member.name != "manifest.json" and member.name not in config_names:
                continue
            require(member.isfile() and member.size <= 4 * 1024 * 1024, "Invalid loaded config member")
            raw = archive.extractfile(member).read()
            if member.name == "manifest.json":
                require(manifest is None, "Duplicate loaded manifest")
                manifest = json.loads(raw)
            else:
                require(config is None, "Duplicate loaded config")
                require(sha256(raw) == config_digest, "Loaded config bytes mismatch")
                config, config_name = json.loads(raw), member.name
    require(isinstance(manifest, list) and len(manifest) == 1 and config is not None,
            "Expected one loaded image and its exact config bytes")
    require(manifest[0].get("Config") == config_name, "Loaded manifest config mismatch")
    return {"configDigest": config_digest, "config": config}


def inspect_loaded_config(reference, config_digest):
    # Stream the actual Engine export; .Id may identify a manifest on containerd stores.
    with subprocess.Popen(["docker", "image", "save", reference], stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL) as child:
        try:
            result = loaded_config(child.stdout, config_digest)
            while child.stdout.read(1024 * 1024):
                pass
            require(child.wait() == 0, "Loaded image export failed")
            return result
        except Exception:
            child.kill()
            raise


def verify_signatures(reference, *, commit=None):
    common = ["--certificate-identity", MAIN_PUBLISHER,
              "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com"]
    if commit is not None:
        common += ["--certificate-github-workflow-sha", commit]
    registry_output("cosign", "verify", *common, reference)
    registry_output("cosign", "verify-attestation", *common, "--type", "slsaprovenance", reference)


def publish(receipt_path):
    ref = os.environ.get("GITHUB_REF")
    require(os.environ.get("GITHUB_EVENT_NAME") == "push" and ref == "refs/heads/main",
            "Publication requires a main push")
    commit, tree = coordinates()
    receipt = json.loads(Path(receipt_path).read_text())
    require((receipt["commit"], receipt["tree"]) == (commit, tree), "Stale inspection receipt")
    repository = "ghcr.io/wasalx/" + receipt["image"]
    require(receipt["reference"] == repository + ":" + commit, "Wrong publication reference")
    contact_input = {}
    if receipt["image"] == "portal":
        contact_digest = receipt.get("contactEmailSha256")
        require(isinstance(contact_digest, str) and DIGEST.fullmatch(contact_digest), "Invalid portal contact email digest")
        contact_input["contactEmailSha256"] = contact_digest
    result = registry_output("docker", "push", receipt["reference"], retry_unknown_blob=True).decode("utf-8")
    matches = re.findall(r"digest: (sha256:[0-9a-f]{64})", result)
    require(len(set(matches)) == 1, "Missing unique published digest")
    digest = matches[0]
    reference = repository + "@" + digest
    raw = registry_output("docker", "buildx", "imagetools", "inspect", "--raw", reference)
    # The digest is checked over registry bytes by the client; never hash whitespace-normalized JSON.
    verify_manifest(json.loads(raw), receipt["inspection"]["configDigest"])
    receipt.update({"digest": digest, "configDigest": receipt["inspection"]["configDigest"],
                    "pullReference": reference, "workflow": MAIN_PUBLISHER,
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
                                   "workflowSha": receipt["workflowSha"], **contact_input}},
                 "metadata": {"buildInvocationId": SOURCE + "/actions/runs/" + receipt["runId"] +
                              "/attempts/" + receipt["runAttempt"]},
                 "materials": [{"uri": "git+" + SOURCE, "digest": {"sha1": commit, "gitTree": tree}}]}
    predicate_path = str(receipt_path) + ".predicate.json"
    write(predicate_path, predicate)
    registry_output("cosign", "sign", "--yes", reference)
    registry_output("cosign", "attest", "--yes", "--type", "slsaprovenance", "--predicate", predicate_path, reference)
    verify_signatures(reference)
    pull(reference)
    row = next(r for r in catalog() if r["image"] == receipt["image"])
    with tempfile.TemporaryDirectory() as directory:
        final = inspect_image(reference, row, commit, tree, directory, receipt["inspection"]["addonLicenses"])
    require(final == receipt["inspection"], "Published image differs from inspected image")
    receipt["verified"] = True
    receipt["status"] = "published"
    write(receipt_path, receipt)


def assemble(records, *, rows=None):
    rows = catalog() if rows is None else rows
    expected = {row["image"] for row in rows}
    addons = addon_images(rows)
    require(expected and len(records) == len(rows) == len(expected) and {r["image"] for r in records} == expected,
            "Complete unique image receipts required")
    require(len({(r["commit"], r["tree"]) for r in records}) == 1, "Mixed source identities")
    published, pending_images = {}, {}
    for row in records:
        require(SHA.fullmatch(row["commit"]) and SHA.fullmatch(row["tree"]), "Invalid receipt source identity")
        if row.get("status") == "pending add-on source":
            require(row["image"] in addons and not any(key in row for key in ["digest", "configDigest", "verified"]),
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


def require_main_published_rows(rows):
    require(all(row.get("status") == "published" and row.get("workflow") == MAIN_PUBLISHER for row in rows),
            "Main workflow publication required for every image")


def verify_publication(manifest_path):
    commit, tree = coordinates()
    raw = Path(manifest_path).read_bytes()
    manifest = json.loads(raw)
    rows = list(manifest["images"].values())
    assembled = assemble(rows)
    require(assembled["publicationComplete"] and raw == (json.dumps(assembled, indent=2) + "\n").encode(),
            "Complete, unmodified publication manifest required")
    require((manifest["commit"], manifest["tree"]) == (commit, tree), "Publication source differs from tagged source")
    require_main_published_rows(rows)
    for row in rows:
        reference = row["pullReference"]
        registry_manifest = subprocess.check_output(["docker", "buildx", "imagetools", "inspect", "--raw", reference])
        require(sha256(registry_manifest) == row["digest"], "Published manifest digest mismatch")
        verify_manifest(json.loads(registry_manifest), row["configDigest"])
        verify_signatures(reference, commit=commit)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["matrix", "build", "pending", "publish", "assemble", "verify-publication", "loaded-config"])
    parser.add_argument("--image")
    diff = parser.add_mutually_exclusive_group()
    diff.add_argument("--pull-request", action="store_true")
    diff.add_argument("--base-sha")
    parser.add_argument("--cache", choices=["off", "read", "write"], default="off")
    parser.add_argument("--config-digest")
    parser.add_argument("--output", default="images-manifest.json")
    parser.add_argument("--records", default="records")
    parser.add_argument("--manifest", default="images-manifest.json")
    args = parser.parse_args()
    if args.command == "loaded-config":
        try:
            print(json.dumps(inspect_loaded_config(args.image, args.config_digest)))
        except Exception:
            sys.exit("Loaded image config verification failed")
    elif args.command == "matrix":
        base = "HEAD^1" if args.pull_request else args.base_sha
        paths = changed_paths(base) if base is not None else None
        print(json.dumps(matrix(paths, pull_request=args.pull_request), separators=(",", ":")))
    elif args.command == "build":
        build(args.image, args.output, args.cache)
    elif args.command == "publish":
        publish(args.output)
    elif args.command == "verify-publication":
        verify_publication(args.manifest)
    elif args.command == "pending":
        pending(args.image, args.output)
    else:
        write(args.output, assemble([json.loads(p.read_text()) for p in Path(args.records).glob("*.json")]))
