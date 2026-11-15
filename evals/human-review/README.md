# Human-review page coverage: round 1

This suite supplies fixed branches plus private coverage keys for evaluating
human-review HTML pages. Round 1 builds inputs and checks their integrity; it
does not call a model, generate recap.json, render pages, or score prose.
Each point describes one fact a reader should learn, with full/partial coverage
criteria and source evidence. Traps describe plausible false claims separately.
The intended next step is independent judging of page coverage against these keys.

## Run

Requires Git and Node 18+; there are no dependencies to install.

```sh
node evals/human-review/build-case-repo.mjs dev-1 /tmp/parcel-review
node evals/human-review/validate-keys.mjs
node evals/human-review/validate-keys.mjs --quiet
node --test 'evals/human-review/test/*.test.mjs'
```

The destination must not exist. The builder also exports
`buildCaseRepo({ caseId, dest })`, returning `{ dest, base, head }`.
The created repository starts with the base commit on main, then the case's
ordered commits on its feature branch. It remains checked out on that branch.
Names, email addresses, dates, Git configuration, and hooks are fixed or isolated.
Only two refs exist. No Git operation writes the enclosing worktree's index.

On Node releases that do not expand quoted test globs, use
`node --test evals/human-review/test/*.test.mjs` instead.

The validator accepts `--keys-dir DIR` and `--cases-dir DIR` for separately
stored held-out material. Both the validator and builder use the same base.
Each case directory contains change.patch plus commits.json (1–3 ordered
`{ message, patch_file }` entries). The exported builder accepts the same optional
`keysDir` and `casesDir` overrides. Key filenames must match case_id.
Supported splits are dev and held-out. Evidence sides are head and base (main).
Ranges are inclusive. A commit reference uses `{"ref":"commit:<n>","side":"head"}`,
where n is the 1-based index of an ordered feature commit. It must resolve to a
commit with a nonempty message body. Every why point must cite at least one such
body or a resolvable head comment/docs line that states the intent. The validator
checks the evidence form and location; editorial review checks its meaning. The validator checks schema, counts, categories, unique IDs,
kind constraints, evidence paths/lines, patch application, and base tests. Feature patches must contain 80–250 combined patch-file lines
and touch at least three files; mechanical-heavy cases must touch at least eight.
It cannot establish atomicity, factual truth, or agreement between prose judges;
those require editorial review. The integration tests additionally run the
existing and added fixture tests on all four heads. Private reproductions belong
only in summary_for_maintainers, never in fixture tests.

## Development cases

| Case | Kind | Change |
| --- | --- | --- |
| dev-1 | planted-defect | Batch reads and resettable cache metrics; warm reads expose shared values. |
| dev-2 | planted-defect | Token validation and fixed expiry; new validation errors bypass the unchanged HTTP client-error mapping. |
| dev-3 | mostly-clean | Per-operation retry policies with a linear default trade recovery speed for outage traffic. |
| dev-4 | mechanical-heavy | Move lifecycle/storage packages; reduce only the HTTP default page size. |

Case 4 uses delete/add patch entries for moved files so its touched-path count
is independent of Git's rename similarity heuristics. The model/service/cache/
repository contents are identical across those moves. HTTP pagination is the
single semantic change. Direct repository pagination keeps its old default.

## Leakage rules

Give the page-producing model **only the built standalone repository**. Never
expose this directory, the key files, the validator output, or the witness tests.
Keys live outside fixture/. Case metadata and patches are not copied into the
built tree. Commit messages use ordinary development language.
The builder scans commit messages, the base and every committed case tree for case-insensitive
`keys/`, `evals/`, `planted`, `defect`, and `key point`. It rejects symlinks.
The scan excludes Git's internal directory; no evaluation metadata is written
there. The builder also enforces exactly main plus the selected feature branch.
Quiet validation prints only one status line per case plus totals, including on
errors. Error details are suppressed in quiet mode because Git/test errors can
contain private source text. For sealed checks use --quiet, not ordinary mode.

## Reserved for held-out

Four of the eight functional source areas remain untouched by all dev patches:

- `src/reporting/`: bounded CSV export and aggregate reporting.
- `src/security/`: signed capabilities, expiry, and scope checks.
- `src/config/`: environment parsing and retry-setting validation.
- `src/audit/`: ordered event journal, cursor retention, and hash-chain verification.

Dev logic edits stay in storage, orders, retry, and http. The package move also
updates the composition root, imports in tests, and the fixture README. Held-out
authors can add two independent cases in the reserved areas without reusing the
development mechanisms. Keep their keys outside fixture/ and their prose out of
built trees. Validate sealed cases using the directory overrides above.
