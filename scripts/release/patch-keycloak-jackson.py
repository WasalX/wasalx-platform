"""Replace both Jackson dependencies in Keycloak's bundled admin CLI atomically."""
import os
from copy import copy
import sys
import zipfile


def patch(cli_path, databind_path, core_path):
    temporary = str(cli_path) + ".patched"
    with zipfile.ZipFile(cli_path) as cli, zipfile.ZipFile(databind_path) as databind, zipfile.ZipFile(core_path) as core:
        if any(len(archive.namelist()) != len(set(archive.namelist())) for archive in (cli, databind, core)):
            raise ValueError("Duplicate JAR entries")
        if any(name.endswith((".SF", ".RSA", ".DSA")) for name in cli.namelist()):
            raise ValueError("Cannot rewrite a signed CLI JAR")
        replacements = {}
        for artifact, dependency in (("databind", databind), ("core", core)):
            prefixes = (f"com/fasterxml/jackson/{artifact}/", f"META-INF/maven/com.fasterxml.jackson.core/jackson-{artifact}/")
            if artifact == "core":
                prefixes += tuple(f"META-INF/versions/{version}/com/fasterxml/jackson/core/" for version in (11, 17, 21))
                if any(name.startswith("META-INF/versions/") and "/com/fasterxml/jackson/core/" in name and not name.startswith(prefixes)
                       for archive in (cli, dependency) for name in archive.namelist()):
                    raise ValueError("Unexpected versioned Jackson core layout")
            properties = prefixes[1] + "pom.properties"
            old = {name for name in cli.namelist() if name.startswith(prefixes)}
            new = {name for name in dependency.namelist() if name.startswith(prefixes)}
            # Core's bundled FastDoubleParser version namespace is the only reviewed rename.
            renamed = {name: name.replace("/v2_21_5/", "/v2_21_7/") if artifact == "core" else name for name in old}
            if set(renamed.values()) != new or len(set(renamed.values())) != len(old) or not any(name.endswith(".class") for name in new):
                raise ValueError("Unexpected Jackson layout; review the upstream release")
            for archive, version in ((cli, b"2.21.5"), (dependency, b"2.21.7")):
                if b"version=" + version not in archive.read(properties).splitlines():
                    raise ValueError("Unexpected Jackson version")
            replacements.update({old_name: (new_name, dependency.read(new_name)) for old_name, new_name in renamed.items()})
        expected_names = [replacements[name][0] if name in replacements else name for name in cli.namelist()]
        if len(expected_names) != len(set(expected_names)):
            raise ValueError("Conflicting relocated JAR entries")
        with zipfile.ZipFile(temporary, "x") as output:
            for info in cli.infolist():
                target, content = replacements.get(info.filename, (info.filename, cli.read(info.filename)))
                updated = copy(info)
                updated.filename = target
                output.writestr(updated, content)
        with zipfile.ZipFile(temporary) as output:
            if output.testzip() is not None or output.namelist() != expected_names:
                raise ValueError("Corrupt rewritten CLI JAR")
            for name in cli.namelist():
                target, expected = replacements.get(name, (name, cli.read(name)))
                if output.read(target) != expected:
                    raise ValueError("CLI member verification failed")
    os.replace(temporary, cli_path)


if __name__ == "__main__":
    patch(*sys.argv[1:])
