# AI Development Workflow

## Before Starting
1. Read relevant files in `docs/ai/`.
2. Inspect the repository and current branch.
3. Understand the requested outcome.
4. Identify affected files and dependencies.
5. Check for security, database, and deployment risks.

## During Implementation
1. Make focused changes.
2. Follow existing conventions.
3. Avoid unrelated refactoring.
4. Preserve backwards compatibility where possible.
5. Do not use placeholders for production functionality.
6. Do not expose credentials or private data.

## After Implementation
1. Review the diff.
2. Run relevant tests, linting, type checks, and builds.
3. Check for regressions.
4. Update documentation when necessary.
5. Record significant changes in `CHANGELOG.md`.
6. Record unresolved problems in `KNOWN_ISSUES.md`.

## Completion Report
Every task must report:

- Understanding
- Investigation
- Plan
- Implementation
- Files changed
- Tests/checks performed
- Verification status
- Remaining risks
- Next steps

## Verification Language
Use precise language:
- Verified: Evidence confirms the result.
- Partially verified: Some checks passed, but coverage is incomplete.
- Not verified: No reliable confirmation.
- Blocked: Verification could not proceed because of a stated dependency.

Never claim a feature is production-ready solely because code was written.
