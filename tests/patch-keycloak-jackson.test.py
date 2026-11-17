import importlib.util
from pathlib import Path
from tempfile import TemporaryDirectory
import zipfile

spec = importlib.util.spec_from_file_location("patch", Path(__file__).parents[1] / "scripts/release/patch-keycloak-jackson.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
properties = "META-INF/maven/com.fasterxml.jackson.core/jackson-databind/pom.properties"
clazz = "com/fasterxml/jackson/databind/ext/CoreXMLDeserializers.class"
core_properties = "META-INF/maven/com.fasterxml.jackson.core/jackson-core/pom.properties"
core_class = "com/fasterxml/jackson/core/JsonFactory.class"
old_fdp = "com/fasterxml/jackson/core/io/doubleparser/v2_21_5/FastDoubleSwar.class"
new_fdp = old_fdp.replace("/v2_21_5/", "/v2_21_7/")

with TemporaryDirectory() as directory:
    cli, dependency, core = (Path(directory) / name for name in ("cli.jar", "fixed.jar", "core.jar"))
    original = {"META-INF/MANIFEST.MF": b"CLI manifest", "other/Provider.class": b"unchanged", clazz: b"old", properties: b"version=2.21.5\n"}
    fixed = {clazz: b"fixed bytecode with a different compressed length" * 100, properties: b"version=2.21.7\n", "META-INF/MANIFEST.MF": b"dependency manifest"}
    original.update({core_properties: b"version=2.21.5\n", core_class: b"old core", old_fdp: b"old FDP"})
    fixed_core = {core_properties: b"version=2.21.7\n", core_class: b"fixed core", new_fdp: b"fixed FDP", "META-INF/MANIFEST.MF": b"Multi-Release: true"}
    for version in (11, 17, 21):
        original[f"META-INF/versions/{version}/{old_fdp}"] = b"old versioned FDP"
        fixed_core[f"META-INF/versions/{version}/{new_fdp}"] = b"fixed versioned FDP"
    def write(path, entries):
        with zipfile.ZipFile(path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for name, value in entries.items():
                archive.writestr(name, value)
    write(cli, original)
    write(dependency, fixed)
    write(core, fixed_core)
    module.patch(cli, dependency, core)
    with zipfile.ZipFile(cli) as archive:
        expected = {name.replace("/v2_21_5/", "/v2_21_7/"): value for name, value in original.items()}
        expected.update({name: value for name, value in {**fixed, **fixed_core}.items() if name != "META-INF/MANIFEST.MF"})
        assert archive.namelist() == list(expected)
        assert {name: archive.read(name) for name in archive.namelist()} == expected
    for bad in ({**fixed, properties: b"version=2.21.5\n"}, {**fixed, properties: b"version=2.21.6\n"}, {properties: fixed[properties]}, {**fixed, clazz + "Extra.class": b"new"}):
        write(cli, original)
        write(dependency, bad)
        write(core, fixed_core)
        before = cli.read_bytes()
        try:
            module.patch(cli, dependency, core)
            raise AssertionError("Unexpected patch accepted")
        except ValueError:
            assert cli.read_bytes() == before
    for bad in ({**fixed_core, core_properties: b"version=2.21.5\n"},
                {**fixed_core, new_fdp.replace("/v2_21_7/", "/v2_21_8/"): b"unexpected namespace"},
                {name: value for name, value in fixed_core.items() if not name.startswith("META-INF/versions/21/")},
                {**fixed_core, "META-INF/versions/25/" + new_fdp: b"unexpected runtime"}):
        write(cli, original)
        write(dependency, fixed)
        write(core, bad)
        before = cli.read_bytes()
        try:
            module.patch(cli, dependency, core)
            raise AssertionError("Unexpected core patch accepted")
        except ValueError:
            assert cli.read_bytes() == before
    write(dependency, fixed)
    write(core, fixed_core)
    for signed in (False, True):
        write(cli, {**original, **({"META-INF/CLI.SF": b"signature"} if signed else {})})
        if not signed:
            with zipfile.ZipFile(cli, "a") as archive:
                archive.writestr(clazz, b"duplicate")
        before = cli.read_bytes()
        try:
            module.patch(cli, dependency, core)
            raise AssertionError("Unsafe CLI accepted")
        except ValueError:
            assert cli.read_bytes() == before
print("Atomic Jackson core/databind replacement preserves CLI members and rejects incompatible dependencies")
