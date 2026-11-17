import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [sourceDirectory, version, packageVersion, packageSha256, revision, candidateCommit, candidateTree] =
  process.argv.slice(2);

if (
  !sourceDirectory ||
  !/^\d+\.\d+\.\d+$/u.test(version ?? "") ||
  !/^\d+\.\d+\.\d+$/u.test(packageVersion ?? "") ||
  !/^[a-f0-9]{64}$/u.test(packageSha256 ?? "") ||
  !/^[a-f0-9]{40}$/u.test(revision ?? "") ||
  !/^[a-f0-9]{40}$/u.test(candidateCommit ?? "") ||
  !/^[a-f0-9]{40}$/u.test(candidateTree ?? "")
) {
  throw new Error(
    "usage: prepare-zammad-previous-stable-image <source> <version> <package-version> <package-sha256> <upstream-revision> <candidate-commit> <candidate-tree>",
  );
}

const dockerfilePath = path.join(sourceDirectory, "Dockerfile");
let dockerfile = await readFile(dockerfilePath, "utf8");

function replaceExactlyOnce(needle, replacement, label) {
  const first = dockerfile.indexOf(needle);
  if (first === -1 || dockerfile.indexOf(needle, first + needle.length) !== -1) {
    throw new Error(`upstream Dockerfile ${label} contract changed`);
  }
  dockerfile = dockerfile.replace(needle, replacement);
}

replaceExactlyOnce(
  "    ZAMMAD_SAFE_MODE=1 DATABASE_URL=postgresql://zammad:/zammad bundle exec rake assets:precompile",
  "    NODE_OPTIONS=--max-old-space-size=1536 ZAMMAD_SAFE_MODE=1 DATABASE_URL=postgresql://zammad:/zammad bundle exec rake assets:precompile",
  "asset-build",
);

replaceExactlyOnce(
  "RUN bundle install && \\\n    rm -rf ~/.bundle/ \"${BUNDLE_PATH}\"/ruby/*/cache \"${BUNDLE_PATH}\"/ruby/*/bundler/gems/*/.git",
  `ARG WASALX_GIT_MIRROR_PREFIX=""
RUN if [[ -n "\${WASALX_GIT_MIRROR_PREFIX}" ]]; then \\
      git config --global url."\${WASALX_GIT_MIRROR_PREFIX%/}/https://github.com/".insteadOf "https://github.com/"; \\
    fi && \\
    bundle install && \\
    rm -rf ~/.bundle/ "\${BUNDLE_PATH}"/ruby/*/cache "\${BUNDLE_PATH}"/ruby/*/bundler/gems/*/.git`,
  "bundler-git-transport",
);

const copyMarker =
  'COPY --chown=1000:1000 --from=build /opt/zammad /opt/zammad\n# Backwards compatibility for older images that used /docker-entrypoint.sh';
const sourceIdentity = JSON.stringify({ commit: candidateCommit, tree: candidateTree });
const runtime = `COPY --chown=1000:1000 --from=build /opt/zammad /opt/zammad
RUN /usr/bin/timeout --version >/dev/null && \\
    install -d -o 0 -g 0 -m 0755 /usr/local/lib/wasalx && \\
    install -o 0 -g 0 -m 0755 /opt/zammad/.wasalx-runtime/install-package.sh /usr/local/bin/wasalx-package-install && \\
    install -o 0 -g 0 -m 0644 /opt/zammad/.wasalx-runtime/install-package.rb /usr/local/lib/wasalx/install-package.rb && \\
    install -o 0 -g 0 -m 0644 /opt/zammad/.wasalx-runtime/verify-package.rb /usr/local/lib/wasalx/verify-package.rb && \\
    install -o 0 -g 0 -m 0755 /opt/zammad/.wasalx-runtime/bootstrap-runtime.sh /usr/local/bin/wasalx-runtime-bootstrap && \\
    install -o 0 -g 0 -m 0644 /opt/zammad/.wasalx-runtime/bootstrap-runtime.rb /usr/local/lib/wasalx/bootstrap-runtime.rb && \\
    printf '%s' '${sourceIdentity}' > /usr/local/lib/wasalx/source-identity.json && \\
    chmod 0444 /usr/local/lib/wasalx/source-identity.json && \\
    rm -rf /opt/zammad/.wasalx-runtime
ENV AUTOWIZARD_RELATIVE_PATH=tmp/auto_wizard.json \\
    WASALX_ZPM_PATH=/opt/zammad/contrib/wasalx.zpm \\
    WASALX_PACKAGE_VERSION=${packageVersion} \\
    WASALX_PACKAGE_SHA256=${packageSha256}
LABEL org.opencontainers.image.title="WasalX Zammad compatibility image" \\
      org.opencontainers.image.version="${version}-wasalx-${packageVersion}" \\
      org.opencontainers.image.revision="${revision}" \\
      com.wasalx.zammad.package.sha256="${packageSha256}"
# Backwards compatibility for older images that used /docker-entrypoint.sh`;
replaceExactlyOnce(copyMarker, runtime, "runtime-installation");

await writeFile(dockerfilePath, dockerfile, "utf8");
