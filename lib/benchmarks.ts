export type BenchmarkId = "deepswe" | "swebench" | "aider" | string;

export type BenchmarkResult = {
  id: string;
  model: string;
  score: number; // Fraction (0..1), or a raw finite index when dataset.scoreKind is "index".
  effort: string;
  harness: string;
  costUsd: number | null; // Per-task API spend, never a whole-run total.
  latencySeconds: number | null;
  evaluatedAt?: string;
  releaseDate?: string;
  benchmarkCount?: number;
};

export type BenchmarkDataset = {
  id: string;
  name: string;
  source: string;
  fetchedAt: string;
  updatedAt?: string;
  metric: string;
  scoreKind?: "fraction" | "index";
  description: string;
  rows: BenchmarkResult[];
};

export const BENCHMARK_SOURCES = [
  {
    id: "deepswe",
    defaultWeight: 20,
    name: "DeepSWE",
    url: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json",
    description: "DeepSWE live coding results. Configurations and task sets differ from other benchmarks; tokens and agent steps are not latency.",
    metric: "PASS@1"
  },
  {
    id: "swebench",
    defaultWeight: 20,
    name: "SWE-bench Verified · bash-only",
    url: "https://www.swebench.com/",
    description: "Verified results using mini-SWE-agent only. Harness version and submission configuration are retained; API spend is the reported instance cost.",
    metric: "% resolved"
  },
  {
    id: "aider",
    defaultWeight: 20,
    name: "Aider Polyglot",
    url: "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml",
    description: "Single-model Polyglot runs, using final success after up to two attempts. API spend is positive reported total cost divided by test cases; zero totals are treated as unreported.",
    metric: "% solved · up to 2 attempts"
  },
  {
    id: "frontiercode",
    defaultWeight: 20,
    name: "FrontierCode 1.1 · Main",
    url: "https://cognition.com/data/frontiercode-leaderboard/data.json",
    description: "Cognition's Main-set mergeability rubric score, with unfair-internet runs zeroed. Every effort and reported harness is retained; cost is USD per rollout. Extended and 1.0 results are excluded.",
    metric: "mergeability rubric score"
  },
  {
    id: "cursorbench",
    defaultWeight: 20,
    name: "CursorBench 4.0",
    url: "https://cursor.com/cursorbench",
    description: "Cursor-agent results on ambiguous, multi-file tasks from real sessions. Published configurations and API USD per task; tokens and steps are not latency. Harness-specific evidence, not Copilot runs.",
    metric: "CursorBench 4.0 score"
  },
  {
    id: "epoch",
    defaultWeight: 0,
    name: "Epoch software ECI · local refit",
    url: "https://epoch.ai/eci?eciPreset=software",
    description: "Software-domain capability refit from Epoch AI's public inputs (CC BY 4.0), requiring 2+ constituent benchmarks. Raw index, not percent; confidence intervals are not computed. Overlaps DeepSWE, SWE-bench, Aider and FrontierCode: excluded from presets to avoid double counting.",
    metric: "software ECI points · locally computed"
  }
] as const;

const MAX_ROWS = 20_000;

export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => !("value" in entry))) {
    throw new Error(`${label} must be a plain data object`);
  }
  return value as Record<string, unknown>;
}

export function own(value: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function text(value: unknown, label: string, maxLength = 2_048): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${label} must be a nonempty string (max ${maxLength} characters)`);
  }
  return value.trim();
}

function number(value: unknown, label: string, maximum = Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > maximum) {
    throw new Error(`${label} must be a finite number between 0 and ${maximum}`);
  }
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  return value === null ? null : number(value, label);
}

export function date(value: unknown, label: string): string {
  const result = text(value, label, 64);
  const calendar = result.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(result) ||
    !Number.isFinite(Date.parse(result)) ||
    new Date(`${calendar}T00:00:00Z`).toISOString().slice(0, 10) !== calendar) {
    throw new Error(`${label} must be a valid ISO date or timestamp with timezone`);
  }
  return result;
}

function optionalDate(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : date(value, label);
}

export function rowsArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value === Array.prototype || Object.getPrototypeOf(value) !== Array.prototype ||
    value.length === 0 || value.length > MAX_ROWS) {
    throw new Error(`${label} must be an array of 1 to ${MAX_ROWS} rows`);
  }
  const rows: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(index));
    if (!entry || !("value" in entry)) {
      throw new Error(`${label} must not contain sparse, inherited, or accessor rows`);
    }
    rows.push(entry.value);
  }
  return rows;
}

/** Validate canonical cached datasets without changing their built-in IDs. Never fetches source URLs. */
export function validateBenchmarkDataset(data: unknown): BenchmarkDataset {
  const dataset = record(data, "Dataset");
  const version = own(dataset, "schemaVersion");
  if (version !== undefined && version !== 1) throw new Error("Unsupported benchmark schemaVersion; expected 1");
  const scoreKind = own(dataset, "scoreKind");
  if (scoreKind !== undefined && scoreKind !== "fraction" && scoreKind !== "index") throw new Error("scoreKind must be fraction or index");
  const source = text(own(dataset, "source"), "source");
  let url: URL;
  try { url = new URL(source); } catch { throw new Error("source must be an absolute HTTPS URL"); }
  if (!/^https:\/\//i.test(source) || url.protocol !== "https:" || !url.hostname || url.username || url.password) {
    throw new Error("source must be an absolute HTTPS URL without credentials");
  }
  const ids = new Set<string>();
  const rows = rowsArray(own(dataset, "rows"), "rows").map((value, index): BenchmarkResult => {
    const row = record(value, `rows[${index}]`);
    const id = text(own(row, "id"), `rows[${index}].id`, 256);
    if (ids.has(id)) throw new Error(`Duplicate row id: ${id}`);
    ids.add(id);
    const evaluatedAt = optionalDate(own(row, "evaluatedAt"), `rows[${index}].evaluatedAt`);
    const releaseDate = optionalDate(own(row, "releaseDate"), `rows[${index}].releaseDate`);
    const benchmarkCount = own(row, "benchmarkCount");
    if (benchmarkCount !== undefined && (!Number.isSafeInteger(benchmarkCount) || (benchmarkCount as number) <= 0)) throw new Error("benchmarkCount must be a positive safe integer");
    const score = own(row, "score");
    if (scoreKind === "index" && (typeof score !== "number" || !Number.isFinite(score))) throw new Error(`rows[${index}].score must be a finite index`);
    return {
      id,
      model: text(own(row, "model"), `rows[${index}].model`),
      score: scoreKind === "index" ? score as number : number(score, `rows[${index}].score`, 1),
      effort: text(own(row, "effort"), `rows[${index}].effort`, 256),
      harness: text(own(row, "harness"), `rows[${index}].harness`),
      costUsd: nullableNumber(own(row, "costUsd"), `rows[${index}].costUsd`),
      latencySeconds: nullableNumber(own(row, "latencySeconds"), `rows[${index}].latencySeconds`),
      ...(evaluatedAt === undefined ? {} : { evaluatedAt }),
      ...(releaseDate === undefined ? {} : { releaseDate }),
      ...(benchmarkCount === undefined ? {} : { benchmarkCount: benchmarkCount as number })
    };
  });
  const updatedAt = optionalDate(own(dataset, "updatedAt"), "updatedAt");
  return {
    id: text(own(dataset, "id"), "id", 256),
    name: text(own(dataset, "name"), "name"),
    source,
    fetchedAt: date(own(dataset, "fetchedAt"), "fetchedAt"),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    metric: text(own(dataset, "metric"), "metric"),
    ...(scoreKind === undefined ? {} : { scoreKind }),
    description: text(own(dataset, "description"), "description", 10_000),
    rows
  };
}

/** Namespace canonical IDs without lossy sanitization that could overwrite another source. */
export function parseBenchmarkImport(data: unknown): BenchmarkDataset {
  const dataset = validateBenchmarkDataset(data);
  const slug = dataset.id.replace(/^custom:/, "");
  if (!/^[a-z0-9][a-z0-9._-]{0,248}$/.test(slug)) throw new Error("Custom dataset identifier must use 1–249 lowercase letters, digits, dots, underscores or hyphens, starting with a letter or digit");
  return { ...dataset, id: `custom:${slug}` };
}
