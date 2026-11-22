#!/usr/bin/env python3
"""D1 anonymous, resumable OCI staging for a locally verified publication."""

import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tarfile
import time
from http.client import HTTPException
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


REGISTRY = "https://ghcr.io"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
MANIFEST_TYPES = ("application/vnd.oci.image.manifest.v1+json",
                  "application/vnd.docker.distribution.manifest.v2+json")
ARCHIVES = ("images.tar", "hosted-evidence.tar")
CHUNK = 1024 * 1024
RANGE_STEP = 32 * 1024 * 1024
RANGE_TRIES = 5
STAGING_DEADLINE = time.monotonic() + 8400


class Hold(Exception):
    def __init__(self, image, step, detail):
        super().__init__(f"HOST_STAGING_HOLD image={image} step={step} {detail}")


def require(ok, image, step, reason, http=None):
    if not ok:
        status = f" http={http}" if http is not None else ""
        raise Hold(image, step, f"reason={reason}{status}")


def file_sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify_bytes(data, pin, image, step, size=None, http=None):
    require("sha256:" + hashlib.sha256(data).hexdigest() == pin, image, step, "DIGEST_MISMATCH", http)
    require(size is None or len(data) == size, image, step, "SIZE_MISMATCH", http)


def read_descriptor(descriptor, image, step):
    pin, size = descriptor["digest"], descriptor["size"]
    require(re.fullmatch(r"sha256:[a-f0-9]{64}", pin) and type(size) is int and size >= 0,
            image, step, "INVALID_DESCRIPTOR")
    return pin, size


class RegistryRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, new_url):
        target = urlsplit(new_url)
        if (req.get_header("Accept") == "application/octet-stream" and
                urlsplit(req.full_url).netloc == "ghcr.io" and code in (302, 307, 308) and
                target.scheme == "https" and target.netloc == "pkg-containers.githubusercontent.com"):
            return Request(new_url, headers={"Accept-Encoding": "identity",
                                             **({"Range": req.get_header("Range")} if req.has_header("Range") else {})})
        return None


def request(open_url, image, step, url, headers, allow_404=False):
    try:
        response = open_url(Request(url, headers=headers), timeout=60)
    except HTTPError as error:
        code = error.code
        error.close()
        if allow_404 and code == 404:
            return None
        raise Hold(image, step, f"http={code}") from None
    if not 200 <= response.status < 300:
        code = response.status
        response.close()
        raise Hold(image, step, f"http={code}")
    return response


def fetch(open_url, image, step, url, headers):
    with request(open_url, image, step, url, headers) as response:
        return response.read(), response.status


def store_blob(open_url, image, prefix, headers, descriptor, step, directory, sizes, mount):
    pin, size = read_descriptor(descriptor, image, step)
    name = pin[7:]
    if name in sizes:
        require(sizes[name] == size, image, step, "SIZE_MISMATCH")
        return f"blobs/sha256/{name}"
    target = directory / name
    digest, total = hashlib.sha256(), 0
    blob_http = None
    failures = refreshed = 0
    with target.open("a+b") as stream:
        stream.seek(0)
        while chunk := stream.read(CHUNK):
            digest.update(chunk)
            total += len(chunk)
        if total == size and digest.hexdigest() == name:
            sizes[name] = size
            return f"blobs/sha256/{name}"
        if total >= size:
            stream.seek(0)
            stream.truncate()
            digest, total = hashlib.sha256(), 0
        while total < size or blob_http is None:
            require(time.monotonic() < STAGING_DEADLINE, image, step, "STAGING_DEADLINE", blob_http)
            end = min(total + RANGE_STEP, size) - 1
            want = {**headers, "Accept": "application/octet-stream"}
            if size:
                want["Range"] = f"bytes={total}-{end}"
            before = total
            try:
                with request(open_url, image, step, f"{prefix}/blobs/{pin}", want) as response:
                    blob_http = response.status
                    meta = getattr(response, "headers", None)
                    length = meta.get("Content-Length") if meta is not None else None
                    if blob_http == 206:
                        require(meta is not None and meta.get("Content-Range") == f"bytes {total}-{end}/{size}",
                                image, step, "CONTENT_RANGE", blob_http)
                        require(length is None or int(length) == end - total + 1, image, step, "SIZE_MISMATCH", blob_http)
                        limit = end + 1
                    else:
                        # A server that ignores Range sends the whole body: restart this blob from byte 0.
                        require(blob_http == 200, image, step, "RANGE_STATUS", blob_http)
                        require(length is None or int(length) == size, image, step, "SIZE_MISMATCH", blob_http)
                        stream.seek(0)
                        stream.truncate()
                        digest, total, before, limit = hashlib.sha256(), 0, 0, size
                    while total < limit and (chunk := response.read(min(CHUNK, limit - total))):
                        capacity(mount)
                        total += len(chunk)
                        digest.update(chunk)
                        stream.write(chunk)
                    require(response.read(1) == b"", image, step, "SIZE_MISMATCH", blob_http)
            except Hold as error:
                # GHCR bearer tokens can expire during a long blob; refresh a bounded number of times.
                if not str(error).endswith(" http=401") or refreshed >= RANGE_TRIES:
                    raise
                refreshed += 1
                query = urlencode({"service": "ghcr.io", "scope": f"repository:wasalx/{image}:pull"})
                token_raw, _ = fetch(open_url, image, "token", f"{REGISTRY}/token?{query}", {})
                token = json.loads(token_raw)["token"]
                require(isinstance(token, str) and token and token.isascii() and not any(c.isspace() for c in token),
                        image, "token", "INVALID_TOKEN")
                headers = {**headers, "Authorization": f"Bearer {token}"}
                continue
            except (OSError, HTTPException):
                # A partial network response is resumable. Preserve actual bytes on the SSD.
                stream.flush()
                require(stream.tell() == total, image, step, "WRITE_FAILED")
            if total < size or blob_http is None:
                failures = 0 if total > before else failures + 1
                require(failures < RANGE_TRIES, image, step, "RANGE_RETRIES", blob_http)
    require(total == size, image, step, "SIZE_MISMATCH", blob_http)
    # F15: a swallowed write/seek/truncate error can leave stored bytes that differ from the hashed stream.
    require(file_sha(target) == name, image, step, "DIGEST_MISMATCH", blob_http)
    require("sha256:" + digest.hexdigest() == pin, image, step, "DIGEST_MISMATCH", blob_http)
    sizes[name] = size
    return f"blobs/sha256/{name}"


def add_bytes(archive, member, data):
    info = tarfile.TarInfo(member)
    info.mode = 0o400
    info.size = len(data)
    archive.addfile(info, io.BytesIO(data))


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode("utf-8")


def check_archive(path):
    try:
        with tarfile.open(path, "r:") as archive:
            entries = archive.getmembers()
            end = archive.offset
        with path.open("rb") as stream:
            stream.seek(end)
            require(entries and stream.read(2 * tarfile.BLOCKSIZE) == bytes(2 * tarfile.BLOCKSIZE),
                    "-", "export", "TAR_INCOMPLETE")
    except tarfile.TarError:
        raise Hold("-", "export", "reason=TAR_INCOMPLETE") from None



def capacity(mount):
    ssd = os.statvfs(mount)
    root = os.statvfs("/")
    require(ssd.f_bavail * ssd.f_frsize >= 96_000_000_000, "-", "capacity", "STAGING_SSD_LOW")
    require(root.f_bavail * root.f_frsize >= 95_000_000_000, "-", "capacity", "ROOT_LOW")
    mem = next(line for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith("MemAvailable:"))
    pressure = Path("/proc/pressure/memory").read_text().splitlines()[0].split()[1]
    require(int(mem.split()[1]) * 1024 >= 30_000_000_000 and float(pressure.split("=")[1]) <= 10,
            "-", "capacity", "MEMORY_PRESSURE")


def seal(directory):
    return "".join(f"{file_sha(directory / name)}  {name}\n"
                   for name in ("images-manifest.json", "host-export.json", *ARCHIVES)).encode("ascii")


def stage(manifest_path, staging, mount):
    require(staging.resolve() == staging and staging.stat().st_dev == mount.stat().st_dev
            and staging.stat().st_dev != Path("/").stat().st_dev, "-", "workdir", "SSD_REQUIRED")
    capacity(mount)
    manifest_raw = manifest_path.read_bytes()
    manifest = json.loads(manifest_raw)
    commit, tree = manifest["commit"], manifest["tree"]
    require(re.fullmatch(r"[0-9a-f]{40}", commit) and re.fullmatch(r"[0-9a-f]{40}", tree),
            "-", "inventory", "SOURCE_IDENTITY")
    final = staging / commit
    if final.exists():
        require((final / "images-manifest.json").read_bytes() == manifest_raw and
                (final / "SHA256SUMS").read_bytes() == seal(final), "-", "workdir", "FINAL_MISMATCH")
        return
    work = staging / (commit + ".partial")
    work.mkdir(mode=0o700, exist_ok=True)
    saved_manifest = work / "images-manifest.json"
    if saved_manifest.exists():
        require(saved_manifest.read_bytes() == manifest_raw, "-", "workdir", "PARTIAL_MISMATCH")
    else:
        saved_manifest.write_bytes(manifest_raw)
    blobs = work / "sha256"
    blobs.mkdir(mode=0o700, exist_ok=True)
    for name in ARCHIVES:
        (work / name).unlink(missing_ok=True)

    opener = build_opener(ProxyHandler({}), RegistryRedirect()).open
    sizes, descriptors, legacy = {}, [], []
    with (tarfile.open(work / ARCHIVES[0], "x:") as image_tar,
          tarfile.open(work / ARCHIVES[1], "x:") as evidence):
        add_bytes(evidence, "images-manifest.json", manifest_raw)
        for image, row in sorted(manifest["images"].items()):
            require(re.fullmatch(r"[a-z0-9-]+", image), "-", "inventory", "IMAGE_NAME")
            pin = row["digest"]
            raw = (manifest_path.parent / image / "manifest.json").read_bytes()
            verify_bytes(raw, pin, image, "manifest")
            image_manifest = json.loads(raw)
            require(image_manifest["mediaType"] in MANIFEST_TYPES and
                    image_manifest["config"]["digest"] == row["configDigest"], image, "manifest", "MANIFEST_IDENTITY")
            prefix = f"{REGISTRY}/v2/wasalx/{image}"
            query = urlencode({"service": "ghcr.io", "scope": f"repository:wasalx/{image}:pull"})
            token_raw, _ = fetch(opener, image, "token", f"{REGISTRY}/token?{query}", {})
            token = json.loads(token_raw)["token"]
            require(isinstance(token, str) and token and token.isascii() and not any(c.isspace() for c in token),
                    image, "token", "INVALID_TOKEN")
            headers = {"Authorization": f"Bearer {token}", "Accept-Encoding": "identity"}
            for name in ("manifest.json", "signature.sigstore.json", "provenance.sigstore.json"):
                add_bytes(evidence, f"{image}/{name}", (manifest_path.parent / image / name).read_bytes())

            config = store_blob(opener, image, prefix, headers, image_manifest["config"], "config", blobs, sizes, mount)
            config_json = json.loads((work / config.removeprefix("blobs/")).read_bytes())
            labels = config_json["config"]["Labels"]
            require(config_json["os"] == "linux" and config_json["architecture"] == "amd64" and
                    labels.get("org.opencontainers.image.revision") == commit and
                    labels.get("io.wasalx.source.tree") == tree and
                    labels.get("org.opencontainers.image.source") == "https://github.com/WasalX/wasalx-platform",
                    image, "config", "CONFIG_IDENTITY")
            layers = [store_blob(opener, image, prefix, headers, layer, "layer", blobs, sizes, mount)
                      for layer in image_manifest["layers"]]
            (blobs / pin[7:]).write_bytes(raw)
            sizes[pin[7:]] = len(raw)
            reference = f"ghcr.io/wasalx/{image}:{commit}"
            descriptors.append({"mediaType": image_manifest["mediaType"], "digest": pin, "size": len(raw),
                                "platform": {"os": "linux", "architecture": "amd64"},
                                "annotations": {"io.containerd.image.name": reference,
                                                "org.opencontainers.image.ref.name": reference}})
            legacy.append({"Config": config, "RepoTags": [reference], "Layers": layers})
        add_bytes(image_tar, "oci-layout", json_bytes({"imageLayoutVersion": "1.0.0"}))
        add_bytes(image_tar, "index.json", json_bytes({"schemaVersion": 2, "mediaType": OCI_INDEX,
                                                     "manifests": descriptors}))
        add_bytes(image_tar, "manifest.json", json_bytes(legacy))
        for name in sorted(sizes):
            capacity(mount)
            image_tar.add(blobs / name, arcname=f"blobs/sha256/{name}", recursive=False)

    proof = {}
    for name in ARCHIVES:
        path = work / name
        check_archive(path)
        proof[name] = {"bytes": path.stat().st_size, "sha256": file_sha(path)}
    (work / "host-export.json").write_bytes(json_bytes(proof))
    (work / "SHA256SUMS").write_bytes(seal(work))
    for path in work.iterdir():
        if path.is_file():
            with path.open("rb") as stream:
                os.fsync(stream.fileno())
    shutil.rmtree(blobs)
    work.rename(final)
    fd = os.open(staging, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


if __name__ == "__main__":
    os.umask(0o077)
    try:
        stage(*(Path(value) for value in sys.argv[1:]))
    except (Hold, OSError, ValueError, KeyError, HTTPException):
        sys.exit(75)
