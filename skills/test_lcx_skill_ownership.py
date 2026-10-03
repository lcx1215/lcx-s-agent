"""LCX Skill ownership and profile-scoped parity helper regressions."""

import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
MANIFEST = REPO / "ops/engineering/lcx-skill-ownership.json"
HELPER = REPO / "skills/live-sidecar-sync-doctor/scripts/live-sidecar-sync-doctor.sh"


def test_project_skills_have_one_canonical_pointer():
    manifest = json.loads(MANIFEST.read_text())
    project = manifest["projectSkills"]
    portable = manifest["portableSkills"]
    assert len(project) == len(set(project))
    assert set(project).isdisjoint(portable)
    for name in project:
        canonical = REPO / "skills" / name
        bridge = REPO / ".agents/skills" / name
        assert (canonical / "SKILL.md").is_file()
        assert bridge.is_symlink()
        assert not Path(os.readlink(bridge)).is_absolute()
        assert bridge.resolve() == canonical.resolve()
    for name in portable:
        assert (REPO / "skills" / name / "SKILL.md").is_file()
    assert sorted(p.name for p in (REPO / ".agents/skills").iterdir()) == sorted(project)


def test_historical_skills_are_not_reinstalled():
    manifest = json.loads(MANIFEST.read_text())
    active = set(manifest["projectSkills"] + manifest["portableSkills"])
    for entry in manifest["historicalNames"]:
        assert entry["name"] not in active
        assert entry["replacement"] in active


@pytest.fixture
def parity(tmp_path):
    if not all(shutil.which(binary) for binary in ("node", "bash", "git")):
        pytest.skip("requires local node, bash and git")
    source = tmp_path / "source"
    runtime = tmp_path / "runtime"
    source.mkdir()
    runtime.mkdir()
    subprocess.run(["git", "init", "-q", str(source)], check=True)
    (source / "README.md").write_text("current source\n")
    (runtime / "README.md").write_text("old runtime\n")
    (runtime / "unrelated.txt").write_text("keep\n")
    manifest = tmp_path / "parity.json"
    manifest.write_text(json.dumps({"files": ["README.md"]}))
    env = {
        **os.environ,
        "LCX_REPO_ROOT": str(source),
        "LCX_EXTERNAL_CHANNEL_RUNTIME": str(runtime),
        "LCX_RUNTIME_PARITY_MANIFEST": str(manifest),
    }

    def run(*args, overrides=None):
        return subprocess.run(
            ["bash", str(HELPER), *args],
            env={**env, **(overrides or {})},
            text=True,
            capture_output=True,
            timeout=10,
            check=False,
        )

    return source, runtime, manifest, run


def test_parity_read_only_then_apply_keeps_unrelated_files(parity):
    _, runtime, _, run = parity
    result = run()
    assert result.returncode == 0
    payload = json.loads(result.stdout.splitlines()[0])
    assert payload["status"] == "drift"
    assert payload["applied"] is False
    assert (runtime / "README.md").read_text() == "old runtime\n"
    assert "summary same=0 missing=0 different=1" in result.stdout
    result = run("--apply")
    assert result.returncode == 0
    assert (runtime / "README.md").read_text() == "current source\n"
    assert (runtime / "unrelated.txt").read_text() == "keep\n"
    result = run()
    assert "summary same=1 missing=0 different=0" in result.stdout


def test_missing_source_blocks_before_first_copy(parity):
    _, runtime, manifest, run = parity
    manifest.write_text(json.dumps({"files": ["README.md", "missing.ts"]}))
    result = run("--apply")
    assert result.returncode == 2
    assert (runtime / "README.md").read_text() == "old runtime\n"


def test_oversized_parity_set_blocks_without_reading_or_copying_it(parity):
    source, runtime, manifest, run = parity
    with (source / "oversized.bin").open("wb") as handle:
        handle.truncate(129 * 1024 * 1024)
    manifest.write_text(json.dumps({"files": ["README.md", "oversized.bin"]}))
    assert run("--apply").returncode == 2
    assert (runtime / "README.md").read_text() == "old runtime\n"


@pytest.mark.parametrize("relative", ["../outside", "/absolute", ".git/config", ".env", ".env.local", "README.md/../README.md"])
def test_invalid_or_protected_parity_path_blocks(parity, relative):
    _, runtime, manifest, run = parity
    manifest.write_text(json.dumps({"files": ["README.md", relative]}))
    result = run("--apply")
    assert result.returncode == 2
    assert (runtime / "README.md").read_text() == "old runtime\n"


def test_destination_symlink_escape_blocks(parity, tmp_path):
    source, runtime, manifest, run = parity
    (source / "linked").mkdir()
    (source / "linked/file.txt").write_text("new\n")
    outside = tmp_path / "outside"
    outside.mkdir()
    (runtime / "linked").symlink_to(outside, target_is_directory=True)
    manifest.write_text(json.dumps({"files": ["README.md", "linked/file.txt"]}))
    result = run("--apply")
    assert result.returncode == 2
    assert not (outside / "file.txt").exists()
    assert (runtime / "README.md").read_text() == "old runtime\n"


def test_no_profile_manifest_is_explicitly_blocked(parity):
    _, runtime, _, run = parity
    result = run("--apply", overrides={"LCX_RUNTIME_PARITY_MANIFEST": ""})
    assert result.returncode == 2
    assert (runtime / "README.md").read_text() == "old runtime\n"
