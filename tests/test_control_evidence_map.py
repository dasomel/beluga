#!/usr/bin/env python3
"""Fail-closed regression tests for scripts/ci/check-control-evidence-map.py (Issue #50)."""
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "control_map", ROOT / "scripts/ci/check-control-evidence-map.py"
)
gate = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(gate)

MAKEFILE = "validate:\n\tpython3 scripts/ci/check-a.py\n\tpython3 scripts/ci/check-b.py\n\nlint:\n\ttrue\n"
DOC = """# Map
<!-- controls:start -->
| ID | Area | Verifier | Make | Evidence | Status |
|---|---|---|---|---|---|
| C1 | A | `scripts/ci/check-a.py` | `validate` | log | implemented |
| C2 | B | none | none | none | gap |
<!-- controls:end -->
<!-- out-of-scope:start -->
| Script | Reason |
|---|---|
| `scripts/ci/check-b.py` | hygiene only |
<!-- out-of-scope:end -->
"""


class ControlEvidenceMapTests(unittest.TestCase):
    def build(self, doc=DOC, doc_ko=None, makefile=MAKEFILE, extra=()):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        (root / "scripts/ci").mkdir(parents=True)
        (root / "docs").mkdir()
        for name in ("check-a.py", "check-b.py", *extra):
            (root / "scripts/ci" / name).touch()
        (root / "Makefile").write_text(makefile, encoding="utf-8")
        (root / gate.DOC).write_text(doc, encoding="utf-8")
        (root / gate.DOC_KO).write_text(doc if doc_ko is None else doc_ko, encoding="utf-8")
        return root

    def rejects(self, root, text):
        with self.assertRaises(ValueError) as ctx:
            gate.check(root)
        self.assertIn(text, str(ctx.exception))

    def test_valid_fixture_passes(self):
        gate.check(self.build())

    def test_missing_referenced_file_fails(self):
        root = self.build(DOC.replace("`scripts/ci/check-a.py` | `validate`", "`scripts/ci/nope.py` | `validate`"))
        self.rejects(root, "referenced file does not exist")

    def test_unmapped_script_fails(self):
        self.rejects(self.build(extra=["check-c.py"]), "neither mapped nor out-of-scope")

    def test_missing_make_target_fails(self):
        self.rejects(self.build(DOC.replace("`validate`", "`ghost`")), "Make target does not exist")

    def test_out_of_scope_without_reason_fails(self):
        self.rejects(self.build(DOC.replace("hygiene only", " ")), "reason")

    def test_out_of_scope_missing_script_fails(self):
        self.rejects(self.build(DOC.replace("check-b.py` | hygiene", "check-z.py` | hygiene")),
                     "out-of-scope script does not exist")

    def test_mapped_and_out_of_scope_fails(self):
        doc = DOC.replace("| `scripts/ci/check-b.py` | hygiene only |", "| `scripts/ci/check-a.py` | dup |")
        self.rejects(self.build(doc, makefile=MAKEFILE), "both mapped and out-of-scope")

    def test_gap_with_verifier_fails(self):
        self.rejects(self.build(DOC.replace("| none | none | none | gap", "| `scripts/ci/check-a.py` | none | none | gap")),
                     "gap control must not cite")

    def test_non_gap_without_verifier_fails(self):
        self.rejects(self.build(DOC.replace("| `scripts/ci/check-a.py` | `validate`", "| none | `validate`")),
                     "cites no verifier")

    def test_invalid_status_fails(self):
        self.rejects(self.build(DOC.replace("| implemented", "| done")), "invalid status")

    def test_validate_claim_not_in_makefile_fails(self):
        root = self.build(makefile="validate:\n\tpython3 scripts/ci/check-b.py\n")
        self.rejects(root, "scripts/ci/check-a.py is not run by any claimed Make target")

    def test_missing_markers_fails(self):
        self.rejects(self.build("# nothing\n"), "missing <!-- controls")

    def test_ko_drift_fails(self):
        self.rejects(self.build(doc_ko=DOC.replace("| implemented", "| partial")), "differ")

    def test_ko_missing_fails(self):
        root = self.build()
        (root / gate.DOC_KO).unlink()
        with self.assertRaises(OSError):
            gate.check(root)

    def test_missing_header_row_fails(self):
        header = "| ID | Area | Verifier | Make | Evidence | Status |\n|---|---|---|---|---|---|\n"
        self.assertIn(header, DOC)
        self.rejects(self.build(DOC.replace(header, "|---|---|---|---|---|---|\n")), "must start with its header row")

    def test_missing_ko_header_row_fails(self):
        header = "| Script | Reason |\n|---|---|\n"
        self.rejects(self.build(doc_ko=DOC.replace(header, "|---|---|\n")), "must start with its header row")

    def test_duplicate_id_fails(self):
        self.rejects(self.build(DOC.replace("| C2 |", "| C1 |")), "duplicate control id C1")

    def test_wrong_column_count_fails(self):
        self.rejects(self.build(DOC.replace("| C2 | B | none |", "| C2 | none |")), "must have 6 columns")

    def test_empty_controls_table_fails(self):
        head = "| ID | Area | Verifier | Make | Evidence | Status |\n|---|---|---|---|---|---|\n"
        start, end = DOC.index("| C1 |"), DOC.index("<!-- controls:end -->")
        self.rejects(self.build(DOC[:start] + DOC[end:]), "no controls")
        self.assertIn(head, DOC[:start])

    def test_out_of_scope_with_several_scripts_fails(self):
        doc = DOC.replace("| `scripts/ci/check-b.py` |", "| `scripts/ci/check-b.py` `scripts/ci/check-a.py` |")
        self.rejects(self.build(doc), "exactly one script")

    def test_missing_makefile_fails(self):
        root = self.build()
        (root / "Makefile").unlink()
        with self.assertRaises(FileNotFoundError):
            gate.check(root)

    def test_ko_missing_table_marker_fails(self):
        ko = DOC.replace("<!-- out-of-scope:start -->", "").replace("<!-- out-of-scope:end -->", "")
        self.rejects(self.build(doc_ko=ko), gate.DOC_KO)

    def test_parent_dir_path_fails(self):
        doc = DOC.replace("`scripts/ci/check-a.py` | `validate`", "`scripts/ci/../ci/check-a.py` | `validate`")
        root = self.build(doc)
        self.assertTrue((root / "scripts/ci/../ci/check-a.py").is_file())
        self.rejects(root, "does not exist or is unsafe")

    def test_absolute_path_fails(self):
        root = self.build()
        absolute = str(root / "scripts/ci/check-a.py")
        doc = DOC.replace("scripts/ci/check-a.py` | `validate`", absolute + "` | `validate`")
        (root / gate.DOC).write_text(doc, encoding="utf-8")
        self.assertTrue(Path(absolute).is_file())
        self.rejects(root, "does not exist or is unsafe")

    def test_symlink_verifier_fails(self):
        root = self.build()
        (root / "scripts/ci/check-a.py").unlink()
        (root / "real.py").touch()
        os.symlink(root / "real.py", root / "scripts/ci/check-a.py")
        self.assertTrue((root / "scripts/ci/check-a.py").is_file())
        self.rejects(root, "does not exist or is unsafe")

    def test_phony_as_target_fails(self):
        root = self.build(DOC.replace("`validate`", "`.PHONY`"), makefile=".PHONY: validate\n" + MAKEFILE)
        self.rejects(root, "Make target does not exist: .PHONY")

    def test_gap_with_make_target_fails(self):
        self.rejects(self.build(DOC.replace("| none | none | none | gap", "| none | `validate` | none | gap")),
                     "gap control must not cite")

    def test_verifier_named_only_in_echo_fails(self):
        mk = 'validate:\n\t@echo "python3 scripts/ci/check-a.py"\n\tpython3 scripts/ci/check-b.py\n'
        self.rejects(self.build(makefile=mk), "not run by any claimed Make target")

    def test_verifier_named_only_in_comment_fails(self):
        mk = "# scripts/ci/check-a.py\nvalidate:\n\t# scripts/ci/check-a.py\n\tpython3 scripts/ci/check-b.py\n"
        self.rejects(self.build(makefile=mk), "not run by any claimed Make target")

    def test_verifier_only_in_other_target_fails(self):
        mk = "validate:\n\tpython3 scripts/ci/check-b.py\n\nlint:\n\tpython3 scripts/ci/check-a.py\n"
        self.rejects(self.build(makefile=mk), "not run by any claimed Make target")

    def test_echo_then_command_passes(self):
        mk = 'validate:\n\t@echo "x" && python3 scripts/ci/check-a.py\n\tpython3 scripts/ci/check-b.py\n'
        gate.check(self.build(makefile=mk))

    def test_sub_make_and_prerequisite_pass(self):
        mk = "validate: pre\n\t$(MAKE) --no-print-directory sub\n\npre:\n\tpython3 scripts/ci/check-a.py\n\nsub:\n\ttrue\n"
        gate.check(self.build(makefile=mk))

    def test_tests_verifier_must_run_under_claimed_target(self):
        doc = DOC.replace("`scripts/ci/check-a.py`", "`tests/01-x.sh`")
        mk = "validate:\n\tpython3 scripts/ci/check-b.py\n"
        root = self.build(doc, makefile=mk)
        (root / "tests").mkdir()
        (root / "tests/01-x.sh").touch()
        self.rejects(root, "tests/01-x.sh is not run by any claimed Make target")

    def test_run_all_counts_for_test_target(self):
        doc = DOC.replace("`scripts/ci/check-a.py` | `validate`", "`scripts/ci/check-a.py` `tests/01-x.sh` | `test`")
        mk = "validate:\n\ttrue\n\ntest:\n\tpython3 scripts/ci/check-a.py\n\tbash tests/run-all.sh\n"
        root = self.build(doc, makefile=mk)
        (root / "tests").mkdir()
        (root / "tests/01-x.sh").touch()
        (root / "tests/run-all.sh").write_text('bash "${SCRIPT_DIR}/01-x.sh"\n', encoding="utf-8")
        gate.check(root)

    def test_trailing_comment_after_code_fails(self):
        mk = "validate:\n\ttrue # python3 scripts/ci/check-a.py\n\tpython3 scripts/ci/check-b.py\n"
        self.rejects(self.build(makefile=mk), "check-a.py is not run by any claimed Make target")

    def test_echo_continuation_line_fails(self):
        mk = "validate:\n\t@echo x \\\n\t  python3 scripts/ci/check-a.py\n\tpython3 scripts/ci/check-b.py\n"
        self.rejects(self.build(makefile=mk), "check-a.py is not run by any claimed Make target")

    def test_echo_text_with_hash_then_command_passes(self):
        mk = 'validate:\n\t@echo "issue #10" && python3 scripts/ci/check-a.py\n\tpython3 scripts/ci/check-b.py\n'
        gate.check(self.build(makefile=mk))

    def test_verifier_missing_from_one_of_several_claimed_targets_fails(self):
        doc = DOC.replace("| `validate` |", "| `validate` `test` |")
        mk = MAKEFILE + "\ntest:\n\ttrue\n"
        self.rejects(self.build(doc, makefile=mk), "not run by claimed Make target(s) test; claim only the targets")

    def test_verifier_in_every_claimed_target_passes(self):
        doc = DOC.replace("| `validate` |", "| `validate` `test` |")
        mk = MAKEFILE + "\ntest:\n\tpython3 scripts/ci/check-a.py\n"
        gate.check(self.build(doc, makefile=mk))

    def test_real_repo_passes(self):
        gate.check(ROOT)


if __name__ == "__main__":
    unittest.main()
