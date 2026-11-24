"""Stage public GHCR manifests and Sigstore bundles for offline admission."""

import base64
from hashlib import sha256 as hash_bytes
import json
from pathlib import Path
import re
import sys
from urllib.error import HTTPError, URLError
import urllib.request


DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def require(condition, message):
    if not condition:
        raise ValueError(message)


def stage_hosted_bundles(manifest_path):
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
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    types = {"https://sigstore.dev/cosign/sign/v1": "signature", "https://slsa.dev/provenance/v0.2": "provenance"}
    for image, row in images.items():
        repository = "wasalx/" + image
        with opener.open("https://ghcr.io/token?scope=repository:" + repository + ":pull", timeout=30) as response:
            token = json.load(response)["token"]

        def registry(kind, reference):
            request = urllib.request.Request(f"https://ghcr.io/v2/{repository}/{kind}/{reference}", headers={
                "Authorization": "Bearer " + token,
                "Accept": ("application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, "
                           "application/vnd.docker.distribution.manifest.v2+json"),
            })
            with opener.open(request, timeout=30) as response:
                raw = response.read(2**20 + 1)
            require(len(raw) <= 2**20, "OCI metadata exceeds staging limit")
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
        except HTTPError as error:
            if error.code != 404:
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
    try:
        stage_hosted_bundles(sys.argv[1])
    except HTTPError as error:
        sys.exit(f"hosted bundle staging reason: registry returned HTTP {error.code}")
    except (URLError, TimeoutError):
        sys.exit("hosted bundle staging reason: registry connection failed or timed out")
    except (OSError, ValueError, KeyError, TypeError, IndexError) as error:
        sys.exit(f"hosted bundle staging reason: invalid or unreadable OCI metadata ({type(error).__name__})")
