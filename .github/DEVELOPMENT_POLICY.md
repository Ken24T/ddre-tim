# Shared code and documentation policy

Policy: `shared-development-policy` **1.0.0**, approved by Ken on 19 October 2026.
The machine-readable companion is `.github/development-policy.json`.
This policy applies equally to every adopting repository, including DDRE Intranet.

## Design and review

Prefer cohesive modules, clear interfaces and understandable dependencies. Files
and functions should have clear responsibilities. Hidden shared state, circular
dependencies and difficult testing warrant review at any file size. Avoid
fragmenting one coherent operation into many tightly coupled files.

File size is a review signal. Around **300 physical lines**, consider the
structure. A new or materially changed file at **600 lines or more**, or
substantial growth in an already large file, receives a brief recorded design
review. These are review prompts, never mandatory split points or size-only
failures. Function length, nesting, related-function counts and import counts
also need judgement; their counts alone do not require extraction.

The review records one of:

- retain the file, explaining its cohesive responsibility and testability;
- extract useful boundaries, explaining the improvement in dependencies or clarity;
- record a scoped follow-up with a reason for deferring it.

Record the outcome in change/review notes or a maintained design decision. A
boilerplate header in every large file is unnecessary. Existing large files
are reviewed incrementally as they change; adoption does not require a bulk
refactor. Genuine correctness or safety problems still require resolution.

## Documentation, configuration, tests and styles

Documentation follows the same review approach. Organise it around a reader's
task or a coherent reference topic, with useful headings, navigation, examples
and a clear source of truth. Split when that improves finding or understanding
information. A long, coherent reference may remain together with a rationale.
Avoid duplicating guidance across instructions, templates and project docs.

Configuration, test suites, stylesheets and static data are assessed in context.
Preserve formats and invariants that require related material to stay together.
Generated and vendored files are excluded from ordinary size review. Useful
comments, examples, whitespace and tests must not be removed to lower a count.

Arbitrary documentation word or line ceilings are not part of this shared
policy. A genuine external or operational constraint, such as a context budget
for specifically loaded documents, needs a separate documented reason and
scope; it does not become a general source-code cap.

## Reporting and quality checks

Run `node scripts/check-modularity.cjs --changed` for working changes, or omit
`--changed` for a repository overview. `--json` provides a structured report.
Physical lines include comments and blank lines; a final newline does not add
an extra line. Counts are descriptive and are not comparable to older
language-specific effective-line budgets.

The reporter is read-only and advisory: a size or growth finding does not fail
lint, checkpoint or publication. Invalid policy/input and inspection errors
remain errors. A report does not prove cohesion, perform a review, approve a
change or grant permission to commit, publish, deploy or stop services.

Syntax, type, test, security and dependency checks keep their existing rules.
Pure functions are preferred where practical, and side effects stay explicit.
Existing restrictions on unsafe exported types remain; exported TypeScript
signatures must not gain `any` as a consequence of adopting this policy.
Git, approval, secret-handling and code-preservation protections are unchanged.
Refactoring is separate, reviewed work with checks appropriate to its risk.

## Maintenance and distribution

TCTBP holds the canonical policy; TCTBP-Web carries the same policy for new
projects. Repository copies of this document, its JSON companion and reporter
must stay identical for a given policy version. Workflow profiles and agent
instructions reference these copies. Scaffolding and reconciliation carry the
policy files together and preserve each project's unrelated workflow settings.

An intentional policy change updates the shared source, version and adopting
copies together. Policy changes travel through each repo's normal Git workflow;
machine-local work is preserved before another checkout receives them.
