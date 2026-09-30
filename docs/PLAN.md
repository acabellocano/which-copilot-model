# Reinvention: a personal coding-model decision desk

## Product direction

Answer “which model available in **my** VS Code is supported by evidence for this coding task?” rather than publish another universal leaderboard. Keep availability, benchmark evidence, and billing as separate facts.

## Architecture and first release

1. **Inventory companion:** a small VS Code extension calls the stable `vscode.lm.selectChatModels()` API on an explicit command. Export/copy a versioned JSON inventory; optionally open the web app with inventory in the URL fragment. Never send prompts, read credentials, scrape the editor UI, or expose a local server.
2. **Decision desk:** retain Next.js. Validate imported data, persist only in browser storage, let users disable models and explicitly map benchmark aliases, and show unmatched models instead of guessing across model versions.
3. **Coding evidence:** fetch DeepSWE, SWE-bench Verified (mini-SWE-agent only), Aider Polyglot, FrontierCode 1.1 Main, CursorBench 4.0, and Epoch software ECI separately, server-side. Epoch is explicitly a local refit of official public inputs, raw points with no computed confidence intervals; its overlapping composite defaults to zero weight. Store source, metric, configuration, and upstream freshness. Permit canonical fraction/index JSON imports for other coding benchmarks and private evaluations.
4. **Recommendations:** select a task profile, normalize quality within each source, weight sources, and visibly penalize missing coverage. Show raw results and evaluated configurations beside the index. Scores are evidence summaries, not probabilities of success in Copilot.
5. **Validation:** parser/matching/ranking regressions, TypeScript checks, production build, extension packaging, live feed smoke test, and browser workflow checks.

## Boundaries that must stay visible

- The stable language-model API exposes identifiers, name, vendor, family, version, and maximum input tokens. It does not expose Copilot billing, remaining quota, selected reasoning/context settings, or every model-picker entitlement. Enumeration is an API-visible snapshot, not a successful-request test.
- A web page cannot inspect a running VS Code window. The companion must execute in the intended VS Code instance. JSON export/copy is the reliable bridge; URL-fragment handoff is optional and contains model metadata only.
- Copilot credits per million tokens are not benchmark provider USD. Enter pricing manually from the current picker or official billing documentation; unknown is not free. Legacy OCR prices must not silently acquire a unit.
- DeepSWE pass@1, SWE-bench resolved percentage, and Aider's final two-attempt solve rate are different metrics on different tasks. Do not average their raw percentages. Agent harnesses, prompts, effort, versions, and task populations affect results.
- Tokens/agent steps are not latency. Show measured duration only when the source supplies it.
- No synthetic benchmark records, automatic paid evaluations, speculative pricing, arbitrary-URL server fetches, accounts, database, or background inventory upload in this release.

## Next increments, after the first release proves useful

- Expand sources to LiveCodeBench, SWE-bench Pro, Terminal-Bench, and ProgramBench only after their public data contracts, licenses, and model-versus-agent attribution are verified. Canonical JSON imports cover these immediately without brittle scraping.
- Add a separately sourced, dated Copilot pricing catalog with units and plan restrictions; do not derive account-specific pricing from public model lists.
- Package/publish the companion after testing in real signed-in VS Code instances and across organization policies. An authenticated local bridge is justified only if export friction becomes material.
- Add opt-in private repository evaluations with isolated execution, explicit token budgets, and human review. Repository code must never be uploaded implicitly.
- Capture confidence intervals, sample counts, and historical runs where sources support them; avoid treating small leaderboard differences as statistically decisive.
