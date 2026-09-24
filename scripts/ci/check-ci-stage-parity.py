#!/usr/bin/env python3
"""Validate parity between Makefile targets and documented CI stages (Issue #100).

Issue #100 acceptance criterion:
  "Makefile common target set과 documented CI stages가 일치한다"

Enforces static, fail-closed parity across three surfaces:
1. Every documented CI stage maps to a Makefile target that exists in Makefile.
2. Every CI workflow step that runs a repository check invokes the documented make target
   (or is explicitly listed as a non-make stage with an explanatory reason).
3. The documented list does not reference workflows, steps, or make targets that do not exist.
4. Built-in negative self-tests verify drift detection fail-closed.
"""
from __future__ import annotations

import re
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

try:
    import yaml
except ImportError:
    print("error: PyYAML is required; install the pinned CI requirements (see requirements-ci.txt)", file=sys.stderr)
    sys.exit(2)

REPO_ROOT = Path(__file__).resolve().parents[2]
MAKEFILE_PATH = REPO_ROOT / "Makefile"
WORKFLOWS_DIR = REPO_ROOT / ".github" / "workflows"
DOCS_DEV_PATH = REPO_ROOT / "docs" / "development.md"
DOCS_DEV_KO_PATH = REPO_ROOT / "docs" / "development-ko.md"

EXCLUDED_WORKFLOWS = {
    "openforge-status.yml",
    "publish-openforge-status.yml",
    "cleanup-merged-branch.yml",
}


@dataclass(frozen=True)
class DocumentedStage:
    workflow: str
    step: str
    target: str | None
    reason: str


@dataclass(frozen=True)
class WorkflowStep:
    name: str
    run: str
    uses: str
    is_setup: bool


def parse_makefile_targets(makefile_path: Path) -> set[str]:
    """Extract all target names defined in Makefile."""
    content = makefile_path.read_text(encoding="utf-8")
    return set(re.findall(r"^([a-zA-Z0-9_-]+):", content, re.MULTILINE))


def _is_setup_step(name: str, uses: str, run_text: str) -> bool:
    # D107 (issue #107): "actions/setup-node" and "npm ci"/"npm install" are toolchain
    # setup for the policy compiler seam's live recompile (test 14), the same category as
    # the existing "azure/setup-helm" and "pip install" exemptions below — not a check step,
    # so it does not need a CI-stage-parity doc table row.
    if any(
        uses.startswith(p)
        for p in (
            "step-security/harden-runner",
            "actions/checkout",
            "azure/setup-helm",
            "actions/setup-node",
        )
    ):
        return True
    if name in ("Harden Runner", "Checkout", "Install Helm", "Install PyYAML"):
        return True
    run_tokens = run_text.split()
    if any(token.startswith("pip") for token in run_tokens) and "install" in run_tokens:
        return True
    if run_tokens[:2] == ["npm", "ci"] or (
        run_tokens[:1] == ["npm"] and "install" in run_tokens
    ):
        return True
    return False


def extract_workflow_steps(content: str) -> list[WorkflowStep]:
    """Parse workflow steps via a structural walk of `yaml.safe_load` output.

    Walks jobs.*.steps directly instead of pattern-matching indentation, so a
    job's steps are found regardless of nesting depth (e.g. under
    strategy/matrix) or list-indent width.
    """
    try:
        doc = yaml.safe_load(content)
    except yaml.YAMLError as exc:
        raise ValueError(f"invalid workflow YAML: {exc}") from exc

    steps: list[WorkflowStep] = []
    if not isinstance(doc, dict):
        return steps

    jobs = doc.get("jobs")
    if not isinstance(jobs, dict):
        return steps

    for job in jobs.values():
        if not isinstance(job, dict):
            continue
        job_steps = job.get("steps")
        if not isinstance(job_steps, list):
            continue
        for raw_step in job_steps:
            if not isinstance(raw_step, dict):
                continue
            name = str(raw_step.get("name") or "").strip()
            uses = str(raw_step.get("uses") or "").strip()
            run = raw_step.get("run")
            run_text = "" if run is None else str(run)
            steps.append(
                WorkflowStep(
                    name=name,
                    run=run_text,
                    uses=uses,
                    is_setup=_is_setup_step(name, uses, run_text),
                )
            )

    return steps


def parse_documented_stages(doc_path: Path) -> list[DocumentedStage]:
    """Parse the CI stages and Makefile parity table from documentation."""
    if not doc_path.is_file():
        return []

    lines = doc_path.read_text(encoding="utf-8").splitlines()
    stages: list[DocumentedStage] = []
    in_table = False

    for line in lines:
        stripped = line.strip()
        if not stripped.startswith("|"):
            if in_table:
                break
            continue

        cells = [c.strip() for c in stripped.strip("|").split("|")]
        if len(cells) < 4:
            continue

        header_first = cells[0].lower().replace("`", "")
        if header_first in ("workflow", "워크플로우") or set(cells[0]) <= {"-", ":"}:
            in_table = True
            continue

        if not in_table:
            continue

        workflow = cells[0].strip(" `")
        step = cells[1].strip(" `")
        target_raw = cells[2].strip(" `*()")
        reason = cells[3].strip()

        target = (
            target_raw
            if target_raw and target_raw.lower() not in ("none", "-", "해당 없음")
            else None
        )
        stages.append(
            DocumentedStage(
                workflow=workflow,
                step=step,
                target=target,
                reason=reason,
            )
        )

    return stages


def check_parity(
    makefile_path: Path, workflows_dir: Path, doc_path: Path
) -> list[str]:
    """Validate full two-way parity between Makefile, workflows, and documentation."""
    errors: list[str] = []

    if not makefile_path.is_file():
        return [f"Makefile not found at {makefile_path}"]
    if not workflows_dir.is_dir():
        return [f"Workflows directory not found at {workflows_dir}"]
    if not doc_path.is_file():
        return [f"Documentation not found at {doc_path}"]

    makefile_targets = parse_makefile_targets(makefile_path)
    documented_stages = parse_documented_stages(doc_path)

    if not documented_stages:
        return [f"No documented CI stages found in table in {doc_path}"]

    # 1. Validate documented stages against Makefile and filesystem
    documented_map: dict[tuple[str, str], DocumentedStage] = {}
    for stage in documented_stages:
        key = (stage.workflow, stage.step)
        if key in documented_map:
            errors.append(
                f"Duplicate documented stage in {doc_path.name}: {stage.workflow} -> {stage.step}"
            )
        documented_map[key] = stage

        # Target existence in Makefile
        if stage.target is not None:
            if stage.target not in makefile_targets:
                errors.append(
                    f"Documented target '{stage.target}' for workflow '{stage.workflow}' "
                    f"step '{stage.step}' does not exist in Makefile"
                )

        # Workflow file existence
        wf_file = workflows_dir / Path(stage.workflow).name
        if not wf_file.is_file():
            errors.append(
                f"Documented workflow file '{stage.workflow}' does not exist on disk"
            )
            continue

        # Step existence in workflow
        try:
            wf_steps = extract_workflow_steps(wf_file.read_text(encoding="utf-8"))
        except ValueError as exc:
            errors.append(f"Workflow '{stage.workflow}': {exc}")
            continue
        matching_steps = [s for s in wf_steps if s.name == stage.step]
        if not matching_steps:
            errors.append(
                f"Documented step '{stage.step}' does not exist in workflow '{stage.workflow}'"
            )

    # 2. Validate all workflow check steps against documentation
    for wf_file in sorted(workflows_dir.glob("*.yml")):
        if wf_file.name in EXCLUDED_WORKFLOWS:
            continue
        rel_path = f".github/workflows/{wf_file.name}"
        try:
            steps = extract_workflow_steps(wf_file.read_text(encoding="utf-8"))
        except ValueError as exc:
            errors.append(f"Workflow '{rel_path}': {exc}")
            continue
        check_steps = [s for s in steps if not s.is_setup]

        for step in check_steps:
            key = (rel_path, step.name)
            doc_stage = documented_map.get(key)
            if not doc_stage:
                errors.append(
                    f"CI workflow step '{step.name}' in '{rel_path}' is not documented in {doc_path.name}"
                )
                continue

            invoked_makes = re.findall(r"\bmake\s+([a-zA-Z0-9_-]+)", step.run)
            if invoked_makes:
                invoked_target = invoked_makes[0]
                if doc_stage.target != invoked_target:
                    errors.append(
                        f"CI step '{step.name}' in '{rel_path}' invokes 'make {invoked_target}', "
                        f"but documentation maps it to '{doc_stage.target or 'none'}'"
                    )
            else:
                if doc_stage.target is not None:
                    errors.append(
                        f"CI step '{step.name}' in '{rel_path}' does not invoke make, "
                        f"but documentation claims it maps to 'make {doc_stage.target}'"
                    )
                if not doc_stage.reason.startswith("Non-make:"):
                    errors.append(
                        f"Non-make CI step '{step.name}' in '{rel_path}' is missing an explicit "
                        f"non-make reason (must start with 'Non-make:')"
                    )

    return errors


def self_test() -> None:
    """Run built-in negative fixtures to verify drift detection fail-closed."""
    with tempfile.TemporaryDirectory(prefix="beluga-ci-stage-parity-") as tmpdir:
        tmp = Path(tmpdir)
        mk_file = tmp / "Makefile"
        wf_dir = tmp / ".github" / "workflows"
        wf_dir.mkdir(parents=True)
        doc_file = tmp / "development.md"

        # Baseline setup
        mk_file.write_text(
            "lint:\n\techo lint\nvalidate:\n\techo validate\ntest-agent:\n\techo agent\n",
            encoding="utf-8",
        )
        ci_yml = wf_dir / "ci.yml"
        ci_yml.write_text(
            """name: CI
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@v2
      - name: Checkout
        uses: actions/checkout@v4
      - name: shellcheck + helm lint
        run: make lint
  validate:
    runs-on: ubuntu-latest
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@v2
      - name: Checkout
        uses: actions/checkout@v4
      - name: helm template render + YAML syntax validation
        run: make validate
""",
            encoding="utf-8",
        )
        docs_check_yml = wf_dir / "docs-check.yml"
        docs_check_yml.write_text(
            """name: Docs
jobs:
  docs:
    runs-on: ubuntu-latest
    steps:
      - name: Verify bilingual pairs
        run: ./check-pairs.sh
""",
            encoding="utf-8",
        )

        base_table = """### CI stages and Makefile parity

| Workflow | Step / Stage | Makefile target | Type / Reason |
|---|---|---|---|
| `.github/workflows/ci.yml` | `shellcheck + helm lint` | `lint` | Makefile target |
| `.github/workflows/ci.yml` | `helm template render + YAML syntax validation` | `validate` | Makefile target |
| `.github/workflows/docs-check.yml` | `Verify bilingual pairs` | *(none)* | Non-make: inline shell check |
"""
        doc_file.write_text(base_table, encoding="utf-8")

        baseline_errors = check_parity(mk_file, wf_dir, doc_file)
        if baseline_errors:
            raise ValueError(f"Baseline self-test failed: {baseline_errors}")

        test_cases = [
            (
                "documented_target_missing_in_makefile",
                base_table.replace("`lint`", "`lint-missing`"),
                ci_yml.read_text(encoding="utf-8"),
                "does not exist in Makefile",
            ),
            (
                "workflow_step_invokes_unmatched_make_target",
                base_table.replace("`lint`", "`validate`"),
                ci_yml.read_text(encoding="utf-8"),
                "invokes 'make lint', but documentation maps it to 'validate'",
            ),
            (
                "workflow_step_missing_from_docs",
                base_table,
                ci_yml.read_text(encoding="utf-8")
                + "      - name: Extra check\n        run: echo extra\n",
                "is not documented",
            ),
            (
                "workflow_step_nonstandard_indent_not_documented",
                base_table,
                ci_yml.read_text(encoding="utf-8")
                + (
                    "  matrix-job:\n"
                    "    runs-on: ubuntu-latest\n"
                    "    strategy:\n"
                    "      matrix:\n"
                    "        component: [a, b]\n"
                    "    steps:\n"
                    "        - name: Harden Runner\n"
                    "          uses: step-security/harden-runner@v2\n"
                    "        - name: Checkout\n"
                    "          uses: actions/checkout@v4\n"
                    "        - name: undocumented matrix check\n"
                    "          run: make lint\n"
                ),
                "is not documented",
            ),
            (
                "doc_lists_nonexistent_workflow_step",
                base_table
                + "| `.github/workflows/ci.yml` | `Nonexistent step` | `lint` | Makefile target |\n",
                ci_yml.read_text(encoding="utf-8"),
                "does not exist in workflow",
            ),
            (
                "non_make_step_missing_reason",
                base_table.replace("Non-make: inline shell check", "Inline shell check"),
                ci_yml.read_text(encoding="utf-8"),
                "missing an explicit non-make reason",
            ),
            (
                "non_make_step_falsely_claimed_as_make",
                base_table.replace(
                    "| `.github/workflows/docs-check.yml` | `Verify bilingual pairs` | *(none)* | Non-make: inline shell check |",
                    "| `.github/workflows/docs-check.yml` | `Verify bilingual pairs` | `lint` | Makefile target |",
                ),
                ci_yml.read_text(encoding="utf-8"),
                "does not invoke make, but documentation claims it maps to 'make lint'",
            ),
        ]

        for name, doc_content, wf_content, expected_diagnostic in test_cases:
            doc_file.write_text(doc_content, encoding="utf-8")
            ci_yml.write_text(wf_content, encoding="utf-8")
            errs = check_parity(mk_file, wf_dir, doc_file)
            if not errs:
                raise ValueError(
                    f"Self-test {name} unexpectedly PASSED (drift not detected)"
                )
            if not any(expected_diagnostic in e for e in errs):
                raise ValueError(
                    f"Self-test {name} failed without expected diagnostic '{expected_diagnostic}': {errs}"
                )

    print(f"Self-tests OK: {len(test_cases)} drift fixtures rejected.")


def main() -> int:
    try:
        self_test()
    except (OSError, UnicodeError, ValueError) as error:
        print(f"CI stage parity self-test FAIL: {error}", file=sys.stderr)
        return 1

    print("=== Makefile vs documented CI stages parity check ===\n")
    errors = check_parity(MAKEFILE_PATH, WORKFLOWS_DIR, DOCS_DEV_PATH)

    if DOCS_DEV_KO_PATH.is_file():
        ko_errors = check_parity(MAKEFILE_PATH, WORKFLOWS_DIR, DOCS_DEV_KO_PATH)
        for err in ko_errors:
            errors.append(f"[docs/development-ko.md] {err}")

    if errors:
        for err in errors:
            print(f"FAIL: {err}")
        print(
            "\nParity mismatch detected between Makefile, CI workflows, and documentation."
        )
        return 1

    print("OK: All documented CI stages, workflow check steps, and Makefile targets match.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
