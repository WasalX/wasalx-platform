"""Stage public GHCR manifests and Sigstore bundles for offline admission."""

import base64
from hashlib import sha256 as hash_bytes
from http.client import HTTPException
import json
from pathlib import Path
import re
import sys
from time import monotonic_ns
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
import urllib.request


DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def require(condition, message):
    if not condition:
        raise ValueError(message)


class RegistryRequestError(Exception):
    def __init__(self, path, repository, phase, result, elapsed_ms, *, status=None):
        self.status = status
        super().__init__(f"GET {path} repo={repository} phase={phase} {result} elapsed_ms={elapsed_ms}")


class RegistryRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        redirected = super().redirect_request(req, fp, code, msg, headers, newurl)
        source, target = urlsplit(req.full_url), urlsplit(redirected.full_url)
        if (source.scheme != "https" or target.scheme != "https"
                or source.netloc.lower().removesuffix(":443") != target.netloc.lower().removesuffix(":443")):
            redirected.remove_header("Authorization")
        return redirected


def registry_bytes(opener, request, repository, timings):
    # Keep the initial public path. HTTP errors and redirected URLs can contain tokens.
    path = urlsplit(request.full_url).path
    route = "token" if path == "/token" else path.split("/")[-2]
    started = monotonic_ns()
    status = None
    phase = "headers"
    try:
        with opener.open(request, timeout=30) as response:
            phase = "body"
            raw = response.read(2**20 + 1)
            status = response.status
    except (OSError, HTTPException) as error:
        elapsed_ms = (monotonic_ns() - started) // 1_000_000
        if isinstance(error, HTTPError):
            status = error.code
            error.close()
            result = f"http_status={status}"
        else:
            # URLError wraps socket and TLS exceptions. Do not print their text.
            cause = error.reason if isinstance(error, URLError) else error
            result = f"socket_error={type(cause).__name__}"
            if isinstance(code := getattr(cause, "errno", None), int):
                result += f" errno={code}"
        raise RegistryRequestError(path, repository, phase, result, elapsed_ms, status=status) from None
    finally:
        elapsed_ms = (monotonic_ns() - started) // 1_000_000
        timings.setdefault(route, []).append((elapsed_ms, status))
    require(len(raw) <= 2**20, "OCI metadata exceeds staging limit")
    return raw


def stage_hosted_bundles(manifest_path, timings):
    """Download exact public OCI bytes for the installer to verify offline."""
    path = Path(manifest_path)
    manifest = json.loads(path.read_bytes())
    catalog_path = Path(__file__).resolve().parents[2] / "release/installer-images.json"
    catalog = json.loads(catalog_path.read_bytes())
    require(manifest["repository"] == "WasalX/wasalx-platform" and manifest["platform"] == "linux/amd64"
            and manifest["publicationComplete"] is True and not manifest["pending"], "Complete main publication required")
    images = manifest["images"]
    require(set(images) == {row["id"] for row in catalog["images"]}, "Complete image catalog required")
    for image, row in images.items():
        require(re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", image) and DIGEST.fullmatch(row["digest"])
                and DIGEST.fullmatch(row["configDigest"]), "Invalid image name or digest")
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), RegistryRedirect())
    types = {"https://sigstore.dev/cosign/sign/v1": "signature", "https://slsa.dev/provenance/v0.2": "provenance"}
    for image, row in images.items():
        repository = "wasalx/" + image
        request = urllib.request.Request("https://ghcr.io/token?scope=repository:" + repository + ":pull")
        token = json.loads(registry_bytes(opener, request, repository, timings))["token"]

        def registry(kind, reference):
            request = urllib.request.Request(f"https://ghcr.io/v2/{repository}/{kind}/{reference}", headers={
                "Authorization": "Bearer " + token,
                "Accept": ("application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, "
                           "application/vnd.docker.distribution.manifest.v2+json"),
            })
            raw = registry_bytes(opener, request, repository, timings)
            if kind != "referrers" and DIGEST.fullmatch(reference):
                require("sha256:" + hash_bytes(raw).hexdigest() == reference, "OCI object digest mismatch")
            return raw

        digest = row["digest"]
        raw = registry("manifests", digest)
        metadata = json.loads(raw)
        require(metadata.get("mediaType") in {
            "application/vnd.oci.image.manifest.v1+json", "application/vnd.docker.distribution.manifest.v2+json",
        } and metadata.get("config", {}).get("digest") == row["configDigest"], "Image manifest or config digest mismatch")
        try:
            index = json.loads(registry("referrers", digest))
        except RegistryRequestError as error:
            if error.status != 404:
                raise
            index = json.loads(registry("manifests", digest.replace(":", "-")))
        bundles = {}
        for descriptor in index["manifests"]:
            reference = descriptor["digest"]
            require(DIGEST.fullmatch(reference), "Invalid OCI referrer digest")
            referrer = json.loads(registry("manifests", reference))
            if referrer.get("artifactType") != "application/vnd.dev.sigstore.bundle.v0.3+json":
                continue
            require(referrer["subject"]["digest"] == digest and len(referrer["layers"]) == 1, "Invalid Sigstore referrer")
            blob_digest = referrer["layers"][0]["digest"]
            require(DIGEST.fullmatch(blob_digest), "Invalid Sigstore blob digest")
            blob = registry("blobs", blob_digest)
            payload = json.loads(base64.b64decode(json.loads(blob)["dsseEnvelope"]["payload"], validate=True))
            if (name := types.get(payload["predicateType"])) is not None:
                bundles[name] = blob
        require(set(bundles) == set(types.values()), "Signature and provenance bundles required")
        destination = path.parent / image
        destination.mkdir(mode=0o700)
        (destination / "manifest.json").write_bytes(raw)
        for name, blob in bundles.items():
            (destination / f"{name}.sigstore.json").write_bytes(blob)


if __name__ == "__main__":
    timings = {}
    try:
        stage_hosted_bundles(sys.argv[1], timings)
    except RegistryRequestError as error:
        sys.exit(f"hosted bundle staging reason: {error}")
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        sys.exit(f"hosted bundle staging reason: invalid or unreadable OCI metadata ({type(error).__name__})")
    finally:
        for route, records in sorted(timings.items()):
            durations = sorted(elapsed_ms for elapsed_ms, _ in records)
            count = len(durations)
            p95 = durations[(count * 95 + 99) // 100 - 1]
            not_found = sum(status == 404 for _, status in records)
            throttled = sum(status == 429 for _, status in records)
            transport_errors = sum(status is None for _, status in records)
            print(f"hosted bundle staging timing: route={route} requests={count} total_ms={sum(durations)} p95_ms={p95} "
                  f"max_ms={durations[-1]} http_404={not_found} http_429={throttled} transport_errors={transport_errors}")
