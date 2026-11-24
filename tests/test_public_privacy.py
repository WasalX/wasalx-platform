import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCANNER = Path(__file__).resolve().parents[1] / "scripts/public-privacy.py"
TOKEN = "ghp_" + "A" * 36
IP = ".".join(("172", "19", "7", "42"))
HOST = ".".join(("sample", "internal"))
PATH = "Q:" + "\\Users\\sample\\config"
KEY = "-----BEGIN " + "OPENSSH PRIVATE KEY-----"


class PublicPrivacyTest(unittest.TestCase):
    def setUp(self):
        work = tempfile.TemporaryDirectory()
        self.addCleanup(work.cleanup)
        self.root = Path(work.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.git("init", "--initial-branch=main")
        self.base = self.commit("baseline")

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-c", "user.name=Test Bot", "-c", "user.email=test@users.noreply.github.com",
             "-c", "core.autocrlf=false", *args],
            cwd=self.repo, stderr=subprocess.PIPE, text=True,
        ).strip()

    def commit(self, message):
        self.git("add", ".")
        self.git("commit", "--allow-empty", "-m", message)
        return self.git("rev-parse", "HEAD")

    def scan(self, event, payload, expected, head=None):
        event_path = self.root / "event.json"
        event_path.write_text(json.dumps(payload), encoding="utf-8")
        run = subprocess.run(
            [sys.executable, "-I", "-B", SCANNER], cwd=self.repo, capture_output=True, text=True,
            env={**os.environ, "GITHUB_EVENT_NAME": event, "GITHUB_EVENT_PATH": str(event_path),
                 "GITHUB_SHA": head or self.base},
        )
        self.assertEqual(run.returncode, expected, "Unexpected privacy check exit status")
        for value in (TOKEN, IP, HOST, PATH, KEY):
            self.assertFalse(value in run.stdout + run.stderr, "Privacy finding leaked its value")
        self.assertEqual(run.stderr, "", "Unexpected scanner stderr")
        return run.stdout.splitlines()

    def pr(self, title="Clean PR", body=None):
        return {"pull_request": {"title": title, "body": body, "head": {"ref": "fixture"},
                                 "base": {"sha": self.base}}}

    def test_pr_rejects_a_leak_even_when_a_later_commit_removes_it(self):
        file = self.repo / "fixture text.txt"
        file.write_text(f"header\n{TOKEN}\n{IP}\n", encoding="utf-8")
        self.commit("temporary fixture")
        file.unlink()
        head = self.commit("remove fixture")
        self.assertCountEqual(self.scan("pull_request", self.pr(), 1, head), [
            'privacy "fixture text.txt":2 github-token',
            'privacy "fixture text.txt":3 private-ipv4',
        ])

    def test_pr_and_issue_screen_title_and_body_without_executing_text(self):
        for event, field in (("pull_request", "pull_request"), ("issues", "issue")):
            with self.subTest(event=event):
                title = '$(echo untrusted) ' + KEY
                body = f"Details\r\nhttps://{HOST}\r\n{PATH}"
                payload = self.pr(title, body) if event == "pull_request" else {field: {"title": title, "body": body}}
                self.assertCountEqual(self.scan(event, payload, 1), [
                    f'privacy "{field}.title":1 private-key',
                    f'privacy "{field}.body":2 private-host',
                    f'privacy "{field}.body":3 private-path',
                ])

    def test_queue_and_branch_pushes_scan_the_introduced_commits(self):
        (self.repo / f"operator@{HOST}").write_text(TOKEN, encoding="utf-8")
        head = self.commit("seed " + IP)
        self.git("update-ref", "refs/remotes/origin/main", self.base)
        for event, payload in (
            ("merge_group", {"merge_group": {"base_sha": self.base, "head_sha": head}}),
            ("push", {"before": "0" * 40, "after": head, "ref": "refs/heads/fixture",
                      "repository": {"default_branch": "main"}}),
            ("push", {"before": "f" * 40, "after": head, "ref": "refs/heads/fixture", "forced": True,
                      "repository": {"default_branch": "main"}}),
        ):
            with self.subTest(event=event):
                self.assertCountEqual(self.scan(event, payload, 1, head), [
                    'privacy "commit.message":1 private-ipv4',
                    'privacy "<redacted path>":1 private-host',
                    'privacy "<redacted path>":1 github-token',
                ])

    def test_clean_pr_allows_public_urls_and_preexisting_lines(self):
        file = self.repo / "fixture.txt"
        file.write_text(IP + "\n", encoding="utf-8")
        self.base = self.commit("baseline fixture")
        file.write_text(IP + "\nhttps://example.org/ 192.0.2.8\n", encoding="utf-8")
        head = self.commit("public documentation")
        self.assertEqual(self.scan("pull_request", self.pr(), 0, head), [])
        self.assertEqual(self.scan("issues", {"issue": {"title": "Clean issue", "body": None}}, 0), [])

    def test_member_access_and_public_placeholders_pass(self):
        env_example = SCANNER.parents[1] / ".env.example"
        provider = next(line for line in env_example.read_text(encoding="utf-8").splitlines()
                        if line.startswith("WAHA_BASE_URL="))
        (self.repo / ".env.example").write_text(provider + "\n", encoding="utf-8")
        (self.repo / "fixture.js").write_text("return article.internal ?? body.internal;\n", encoding="utf-8")
        head = self.commit("public local configuration and member access")
        body = "\n".join(("https://example.internal/", "http://identity.local",
                          "http://host.docker.internal:3000", "https://release.home.arpa"))
        self.assertEqual(self.scan("pull_request", self.pr(body=body), 0, head), [])

    def test_edited_pr_checks_host_in_payload_without_commit_history(self):
        payload = self.pr(body=f"https://operator@{HOST}:8443/path")
        payload["action"] = "edited"
        self.assertEqual(self.scan("pull_request", payload, 1, "f" * 40), [
            'privacy "pull_request.body":1 private-host',
        ])

    def test_type_change_scans_the_new_file(self):
        file = self.repo / "mode-fixture"
        file.write_text("target", encoding="utf-8")
        blob = self.git("hash-object", "-w", file.name)
        self.git("update-index", "--add", "--cacheinfo", f"120000,{blob},{file.name}")
        self.git("commit", "-m", "Introduce symlink")
        self.base = self.git("rev-parse", "HEAD")
        self.git("update-index", "--force-remove", file.name)
        file.write_text(TOKEN, encoding="utf-8")
        head = self.commit("Replace symlink with a file")
        self.assertEqual(self.scan("pull_request", self.pr(), 1, head), [
            'privacy "mode-fixture":1 github-token',
        ])

    def test_missing_payload_fails_closed(self):
        self.assertEqual(self.scan("pull_request", {}, 2), ["Privacy scan could not read its input."])


if __name__ == "__main__":
    unittest.main()
