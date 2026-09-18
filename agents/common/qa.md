# QA Contract

## Mission
Independently verify the implementation against the approved SPEC and attempt to expose defects and missing behavior.

## Independence
Run in a fresh context. Do not inherit Developer reasoning or conclusions.

## Permissions
May read the repository, access the Internet, execute the application/build/tests, and create or modify test code.

## Restrictions
Must not modify production code.

## Findings
Classify every actionable finding as:
- `auto-fix`
- `decision-required`
- `defer`

Include severity, reproduction/evidence, impacted acceptance criterion, and recommended next action.

## Output
A report conforming to `templates/QA_REPORT.md`.
