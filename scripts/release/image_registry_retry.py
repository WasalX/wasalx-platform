"""Retry recognized registry failures within one command budget."""

import re
import subprocess
import sys
import time


HTTP_STATUS = r"\b(?:unexpected (?:http )?status(?: code)?(?: from [^\n]+)?:?\s+|HTTP/[\d.]+\s+)"
TRANSIENT = re.compile(
    HTTP_STATUS + r"(?:408|429|500|502|503|504)\b"
    r"|\b(?:toomanyrequests:|net/http: TLS handshake timeout|Client\.Timeout exceeded while awaiting headers)"
    r"|\b(?:dial|read|write) tcp\b[^\n]*: (?:i/o timeout|connection reset by peer|broken pipe|connection refused)\b"
    r"|\blookup\b[^\n]*: (?:temporary failure in name resolution|i/o timeout)\b"
    r'|\b(?:Get|Head|Put|Post) "https?://[^"\n]+": stream error: stream ID \d+; INTERNAL_ERROR; received from peer',
    re.IGNORECASE,
)
MISSING_MANIFEST = re.compile(
    r"ERROR: httpReadSeeker: failed open: content at https://([^/\s]+)/v2/"
    r"([^@\s]+)/manifests/(sha256:[0-9a-f]{64}) not found: not found"
)
TERMINAL = re.compile(
    HTTP_STATUS + r"(?:400|401|403|404|405|409|422)\b"
    r"|\b(?:unauthorized|denied|forbidden|authentication required|invalid credentials|manifest unknown|"
    r"digest mismatch|checksum mismatch|signature verification failed|no matching signatures|"
    r"no matching attestations|certificate identity mismatch|invalid provenance|x509|"
    r"did not complete successfully: exit code)\b",
    re.IGNORECASE,
)


def last_diagnostic(stderr):
    return (stderr or b"").decode("utf-8", errors="replace").strip().rsplit("\n", 1)[-1]


def registry_output(*command, timeout=None, delays=(10, 20), capture_stdout=True,
                    retry_unknown_blob=False, retry_missing_manifest=False, report_failure=None):
    """Use the failure callback in place of printing CLI diagnostics."""
    for attempt in range(len(delays) + 1):
        try:
            result = subprocess.run(command, check=True, stdout=subprocess.PIPE if capture_stdout else None,
                                    stderr=subprocess.PIPE, timeout=timeout)
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
            diagnostic = (error.stderr or b"").decode("utf-8", errors="replace")
            if report_failure is not None:
                report_failure(attempt + 1, error)
            else:
                if retry_unknown_blob:
                    print(f"Image push attempt {attempt + 1}/{len(delays) + 1} failed.", file=sys.stderr)
                    if error.stdout:
                        sys.stderr.write(error.stdout.decode("utf-8", errors="replace"))
                if diagnostic:
                    sys.stderr.write(diagnostic)
            reason = last_diagnostic(error.stderr)
            unknown_blob = retry_unknown_blob and diagnostic.strip() == "unknown blob"
            manifest = MISSING_MANIFEST.fullmatch(diagnostic.strip()) if retry_missing_manifest else None
            missing_manifest = manifest is not None and (
                f"{manifest[1]}/{manifest[2]}@{manifest[3]}" == command[-1])
            if attempt == len(delays) or TERMINAL.search(diagnostic):
                raise
            if not isinstance(error, subprocess.TimeoutExpired) and (
                    error.returncode <= 0 or not (unknown_blob or missing_manifest or TRANSIENT.search(reason))):
                raise
            if report_failure is None:
                failure = f"Transient registry transport failure in {command[0]}"
                if unknown_blob:
                    failure = "Image push returned unknown blob"
                elif missing_manifest:
                    failure = "Published image manifest is not yet visible"
                print(f"{failure}; retrying in {delays[attempt]} seconds.", file=sys.stderr)
            time.sleep(delays[attempt])
        else:
            if result.stderr and report_failure is None:
                sys.stderr.write(result.stderr.decode("utf-8", errors="replace"))
            return result.stdout
