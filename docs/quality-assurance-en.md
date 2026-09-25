# Beluga Quality Assurance Plan

English | [한국어](quality-assurance-ko.md)

This plan defines quality reviews from requirements through post-release follow-up. It
uses existing repository checks and evidence; it does not replace CI, live-cluster tests,
security review, or the release owner's decision.

## Objectives and release criteria

| Objective | Measure | Release criterion |
|-----------|---------|-------------------|
| Requirements are verifiable | Acceptance criteria have an owner and evidence source | Every in-scope requirement is accepted or has a recorded exception |
| Changes are reviewed | Pull request review and required repository checks | All required CI checks pass on the exact release commit |
| Security and supply-chain risks are visible | SAST, dependency integrity, SBOM and provenance evidence | No unresolved critical finding without a current, named risk acceptance |
| Runtime behavior is evidenced | Relevant `tests/*.sh` results and environment | Required live checks pass, or an approved exception names the missing evidence |
| Findings are closed deliberately | Owner, severity, due date and closure evidence | No critical finding is silently carried into release |
| Release evidence is reproducible | Generated report records commit, check results and evidence references | Report is generated from a reviewed input file and retained with release records |

## Review lifecycle and ownership

| Phase | Review and cadence | Evidence owner | Reviewer |
|-------|-------------------|---------------|----------|
| Requirements and change scope | At issue/change-package acceptance and whenever acceptance criteria change | Issue or change owner | Product/platform owner |
| Architecture and security | Before implementation for security boundaries, runtime/toolchain changes, and cross-component changes | Design owner | Platform/security reviewer |
| Implementation | Every pull request; review source, manifests, docs and regression coverage | Author | A reviewer other than the author where repository controls permit |
| Verification | Every pull request and again for the exact release commit | Change owner | CI for automated checks; platform owner for live checks |
| Release readiness | Before each release or handover | Release owner | Platform/security/data owners for their evidence areas |
| Open quality findings | Monthly, and before any release | Finding owner | Quality/release owner |
| Lifecycle effectiveness | Quarterly and after a material incident | Quality owner | Platform owner |

The author records a durable evidence reference (CI run URL, test artifact, review, or
approved exception) and the commit it covers. A green static check is not evidence of
live-cluster behavior. Gateway/auth changes require both direct-service and documented
entry-path evidence, following [AGENTS.md](../AGENTS.md).

## Finding and corrective-action record

Track each finding as a GitHub issue or in the release QA input record. Each finding has
a unique ID, severity (`critical`, `high`, `medium`, or `low`), owner, due date, and one
of these states:

- `open`: corrective work remains; include the next action and due date.
- `accepted`: work remains under an explicit risk acceptance with approver, rationale,
  and expiry date. An expired acceptance does not authorize release.
- `closed`: include closure evidence and the person who verified closure.

Critical findings block release readiness unless the accountable risk owner explicitly
accepts the risk before the acceptance expiry. Risk acceptance records the affected
release/commit and cannot waive a failed required verification check. Re-open a finding
if closure evidence no longer applies to the release commit.

## Release and periodic QA report

Prepare a JSON evidence record from the actual checks for the candidate commit. The
input format and validation rules are implemented by
[`scripts/generate_release_qa_report.py`](../scripts/generate_release_qa_report.py).
The generator does not run checks or infer results: every check must include its result,
owner, and evidence reference. Keep the input with the release record so the output can
be regenerated.

The JSON record has a `report` object (`name`, `type`, 40-character lowercase `commit`,
`report_date`, `environment`, `owner`), a non-empty `checks` array (`name`, `phase`,
`result`, `owner`, `evidence`), and an optional `findings` array. `type` is `release` or
`periodic`; periodic reports also require `period_start` and `period_end` dates. Check results are
`pass`, `fail`, or `waived`; a waiver requires an approver, rationale, and expiry date.
Finding records require `id`, `severity`, `status`, `owner`, `due_date`, and `summary`.
Closed findings also require `closure_evidence` and `verified_by`; accepted findings
require an explicit `risk_acceptance` with approver, rationale, and expiry date.

```bash
python3 scripts/generate_release_qa_report.py \
  --input path/to/qa-evidence.json \
  --output path/to/qa-report.md
```

The report records the source commit, check results, finding states, active risk
acceptances, and a derived readiness status. A `NOT READY` result requires corrective
action or a valid risk acceptance; it is not a release approval. The release owner
reviews the report and records the final decision separately.

Run generator regression checks with:

```bash
make test-qa-report
```
