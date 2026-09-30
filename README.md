# Which Copilot Model? — Decision Desk

A local-first coding-model decision desk: bring the models exposed in **your VS Code instance**, compare independent programming benchmarks, and build a traceable shortlist. No screenshot OCR, fabricated leaderboard data, or model requests.

## Get started

Requires Node.js 20.19+ (Node 22 LTS recommended) and VS Code 1.95+ for the companion.

1. Install app dependencies with `npm install`.
2. Start the app with `npm run dev` and open <http://localhost:3000>.
3. Package the companion with `npm run extension:package`. In your **intended VS Code instance**, use **Extensions: Install from VSIX…** and select the generated package from the extension folder.
4. Open Copilot Chat and sign in. Run **Which Copilot Model: Open Workbench with Inventory** from the Command Palette. Alternatively run **Export Inventory** or **Copy Inventory**, then import/paste the JSON in the app.
5. Click **Refresh sources**, choose a task profile, and inspect the evidence behind the shortlist.

For extension development, choose **Run Model Inventory Companion** in Run and Debug and press **F5**. This creates a separate Extension Development Host: its exported inventory belongs to that host, not necessarily your original window. See [extension/README.md](extension/README.md).

No cloud OCR keys, database, app login, or environment variables are required. Any old OCR environment configuration is unused. Old browser OCR model names migrate automatically; ambiguous legacy prices are deliberately discarded.

## What VS Code can actually tell us

The companion calls the supported [`vscode.lm.selectChatModels()` API](https://code.visualstudio.com/api/extension-guides/language-model) in response to your command. It exports opaque model ID, display name, vendor, family, version, maximum **input** tokens, inventory scope, export timestamp, and VS Code version.

It does **not** expose exact model-picker coverage, selected model/effort/context, plan entitlement, Copilot prices, remaining quota, or successful-request availability. API visibility can differ from the picker. Empty results are actionable errors, not proof that no models exist. The companion never sends a test prompt or consumes credits to verify availability.

The default scope is Copilot. Set `whichCopilotModel.vendor` to `all` in user settings to include other API-visible providers. Enable checkboxes are editable shortlist choices, not policy-confirmed availability.

A browser cannot inspect a running VS Code window. The companion provides three handoffs:

- **JSON file:** most reliable and portable.
- **Clipboard:** no file required.
- **Open Workbench:** optional URL-fragment import; the page removes the fragment from the current history entry. Large links fall back to copying. The fragment is not sent in the initial HTTP request, but page scripts, browser extensions, and history can expose it. Remote HTTPS destinations require confirmation.

Neither the app nor companion collects prompts, source code, workspace paths, account credentials, or tokens. Inventory, benchmark snapshots, and preferences persist in this browser’s local storage. There is no background inventory upload. Do not use an untrusted hosted workbench; its scripts can read imported metadata.

## Coding evidence, not a universal leaderboard

| Source | Scope and metric | Cost and time |
| --- | --- | --- |
| [DeepSWE](https://deepswe.datacurve.ai/) | Long-horizon engineering; PASS@1; observed effort configurations | API USD per task. Tokens/steps are not speed. |
| [SWE-bench Verified](https://www.swebench.com/) | Verified **mini-SWE-agent only**; resolved percentage; harness version retained | USD per instance. Submission dates do not imply source freshness. |
| [Aider Polyglot](https://aider.chat/docs/leaderboards/) | Single-model editing; final solve rate after **up to two attempts** | Positive total USD / test cases; measured seconds per case. Explicit multi-model runs excluded. |

The server fetches fixed public sources through `GET /api/benchmarks`, with a 15-second timeout per source and hourly upstream caching. Successful sources update independently. Failed sources preserve the last valid browser snapshot and display an error. A failed source without cache is excluded from the active scoring denominator; this can change recommendations.

Fetch timestamps describe retrieval, not evidence freshness. DeepSWE supplies a generation timestamp. SWE-bench and Aider lack a source-wide update timestamp in these feeds, so freshness remains **unknown** even when retrieval succeeds. Evaluation/submission dates are separate. Upstream schemas can change: failures stay visible and results are never fabricated.

### How recommendations work

1. Match normalized names conservatively. Formatting, recognized effort annotations, provider prefixes, and dated snapshots may normalize, but model generations, mini/pro/chat variants, and fast mode do not collapse. A dated snapshot match is not proof that the current checkpoint is identical. An explicit benchmark alias **replaces** name matching and is visibly marked.
2. For each source, use the best observed configuration per canonical model. Compare its score to that source’s model population using a tie-aware percentile. Tied/singleton populations are neutral.
3. Combine within-source percentiles using task-profile weights. Missing evidence in a loaded weighted source contributes zero and reduces visible weighted coverage. It does not prove poor performance.
4. For **value**, divide the quality index by `1 + estimated credits`. Only explicit Copilot vendors with both manual input/output rates are eligible. This is a heuristic, not a billing forecast.

Raw percentages from different tasks/harnesses are **never averaged**. The 0–100 index is relative evidence, not success probability. Best effort/harness results are an evidence ceiling; Copilot may use different prompts, harnesses, reasoning levels, or checkpoints. No latency objective is inferred from tokens/steps. Small differences are not proof of statistical significance.

### Pricing stays separate

Enter **Copilot credits per 1 million tokens** from your current picker or [official billing documentation](https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing), and record the source/date. Blank means unknown; explicitly entered zero means zero. Dollar pricing and premium-request multipliers are not interchangeable with token credit rates.

The scenario defaults to 10,000 uncached input + 2,000 output tokens. Credits are `(input tokens × input rate + output tokens × output rate) / 1,000,000`. Cache rates are recorded but unused by this scenario. BYOK pricing, quotas, allowances, and credit-to-USD conversion are not assumed. Benchmark provider USD is evidence, never substituted for your Copilot bill.

## Import additional benchmarks

LiveCodeBench, SWE-bench Pro, Terminal-Bench, ProgramBench, and private evaluations can be imported as canonical JSON. State the metric and use scores from 0–1; do not mix incompatible harnesses/task versions in one population.

| Field | Required content |
| --- | --- |
| `schemaVersion` | Optional `1`; other versions rejected. |
| `id`, `name`, `metric`, `description` | Nonempty strings describing one comparable evaluation population. |
| `source` | Absolute, credential-free HTTPS provenance URL; never fetched by the importer. |
| `fetchedAt` | ISO date or timestamp with timezone. |
| `updatedAt` | Optional actual upstream update date/timestamp. |
| `rows` | 1–20,000 real result objects, unique IDs; browser imports limited to 2 MB. |
| Row fields | `id`, `model`, `score` (0–1), `effort`, `harness`, `costUsd`, `latencySeconds`; optional `evaluatedAt`. |
| Missing measurements | Explicit `null` for cost/time. USD is per task, seconds must be measured. |

Imported IDs become `custom:<id>` and cannot replace built-in sources. Use a canonical ID of 1–249 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit; an existing `custom:` prefix is accepted. Invalid IDs are rejected rather than rewritten into a potentially colliding ID. Reimporting the same canonical ID updates that custom dataset. Import validation keeps previous data on failure. No user-supplied URL fetching or arbitrary server file import is supported.

## Development and verification

- `npm test`: parser/import/matching/ranking tests and dependency-free companion tests.
- `npm run typecheck` / `npm run lint`: TypeScript checks, not ESLint.
- `npm run build`: production build; `npm start` serves it.
- `npm run extension:check`: companion JavaScript syntax check.
- `npm run extension:package`: installable VSIX; downloads VSCE tooling.
- `npm audit`: dependency advisories. The patched PostCSS override is intentional.

Run locally or on a Next.js Node-compatible host such as Vercel. Keep `whichCopilotModel.workbenchUrl` aligned with the app. Hosted deployments need normal infrastructure rate limits; this prototype has no distributed limiter/account system. Export your inventory before clearing browser storage.

See [docs/PLAN.md](docs/PLAN.md) for architecture and next increments: verified source adapters, dated pricing catalogs, confidence/sample metadata, and explicit-budget private evaluations. Those are not claimed as implemented.
