"""Bounded retries for image registry commands."""

import subprocess
import time


def retry(action):
    # shortcut: treat nonzero exits as transient until registry error classification is needed.
    for attempt in range(1, 4):
        try:
            return action()
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
            if attempt == 3:
                raise
            time.sleep(10 * attempt)
