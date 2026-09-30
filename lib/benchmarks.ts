import { parse } from "yaml";

export type BenchmarkId = "deepswe" | "swebench" | "aider" | string;

export type BenchmarkResult = {
  id: string;
  model: string;
  score: number; // 0..1, using the dataset's stated metric.
  effort: string;
  harness: string;
  costUsd: number | null; // Per-task API spend, never a whole-run total.
  latencySeconds: number | null;
  evaluatedAt?: string;
};

export type BenchmarkDataset = {
  id: string;
  name: string;
  source: string;
  fetchedAt: string;
  updatedAt?: string;
  metric: string;
  description: string;
  rows: BenchmarkResult[];
};

export const BENCHMARK_SOURCES = [
  {
    id: "deepswe",
    name: "DeepSWE",
    url: "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json",
    description: "DeepSWE live coding results. Configurations and task sets differ from other benchmarks; tokens and agent steps are not latency.",
    metric: "PASS@1"
  },
  {
    id: "swebench",
    name: "SWE-bench Verified · bash-only",
    url: "https://www.swebench.com/",
    description: "Verified results using mini-SWE-agent only. Harness version and submission configuration are retained; API spend is the reported instance cost.",
    metric: "% resolved"
  },
  {
    id: "aider",
    name: "Aider Polyglot",
    url: "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml",
    description: "Single-model Polyglot runs, using final success after up to two attempts. API spend is positive reported total cost divided by test cases; zero totals are treated as unreported.",
    metric: "% solved · up to 2 attempts"
  }
] as const;

const MAX_ROWS = 20_000;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Object.values(Object.getOwnPropertyDescriptors(value)).some((entry) => !("value" in entry))) {
    throw new Error(`${label} must be a plain data object`);
  }
  return value as Record<string, unknown>;
}

function own(value: Record<string, unknown>, key: string): unknown {
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

function date(value: unknown, label: string): string {
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

function rowsArray(value: unknown, label: string): unknown[] {
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
    return {
      id,
      model: text(own(row, "model"), `rows[${index}].model`),
      score: number(own(row, "score"), `rows[${index}].score`, 1),
      effort: text(own(row, "effort"), `rows[${index}].effort`, 256),
      harness: text(own(row, "harness"), `rows[${index}].harness`),
      costUsd: nullableNumber(own(row, "costUsd"), `rows[${index}].costUsd`),
      latencySeconds: nullableNumber(own(row, "latencySeconds"), `rows[${index}].latencySeconds`),
      ...(evaluatedAt === undefined ? {} : { evaluatedAt })
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

function upstreamText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function measured(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function upstreamDate(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return date(value, "Upstream date");
}

function deepSWERows(data: unknown): { rows: BenchmarkResult[]; updatedAt?: string } {
  const dataset = record(data, "DeepSWE response");
  const rows = rowsArray(own(dataset, "rows"), "DeepSWE rows").flatMap((value, index): BenchmarkResult[] => {
    const row = record(value, "DeepSWE row");
    const model = upstreamText(row.model);
    const score = row.pass_rate ?? row.pass_at_1;
    if (!model || measured(score) === null || (score as number) > 1) return [];
    const harness = upstreamText(row.harness) ?? "unspecified";
    const config = upstreamText(row.config);
    return [{
      id: `deepswe:${index}`,
      model,
      score: score as number,
      effort: upstreamText(row.reasoning_effort) ?? "unspecified",
      harness: config ? `${harness} · config: ${config}` : harness,
      costUsd: measured(row.mean_cost_usd),
      // ponytail: DeepSWE latency is intentionally unsupported; never infer it from tokens or steps.
      latencySeconds: null
    }];
  });
  return { rows, updatedAt: upstreamDate(own(dataset, "generated_at")) };
}

function swebenchRows(html: string): { rows: BenchmarkResult[] } {
  // ponytail: extract the site's embedded JSON, not a second HTML parsing dependency.
  const script = html.match(/<script\b(?=[^>]*\bid\s*=\s*["']leaderboard-data["'])(?=[^>]*\btype\s*=\s*["']application\/json["'])[^>]*>([\s\S]*?)<\/script\s*>/i);
  if (!script) throw new Error("SWE-bench page did not contain leaderboard-data JSON");
  const groups = rowsArray(JSON.parse(script[1]), "SWE-bench groups");
  const verified = groups.map((value) => record(value, "SWE-bench group")).find((group) => group.name === "Verified");
  if (!verified) throw new Error("SWE-bench page did not contain the Verified dataset");
  const rows = rowsArray(own(verified, "results"), "SWE-bench results").flatMap((value, index): BenchmarkResult[] => {
    const row = record(value, "SWE-bench result");
    if (upstreamText(row.agent)?.toLowerCase() !== "mini-swe-agent") return [];
    // A submission/agent name is not sufficient evidence of the underlying model.
    const model = upstreamText(row.model_display);
    const score = measured(row.resolved);
    if (!model || score === null || score > 100) return [];
    const version = upstreamText(row["mini-swe-agent_version"]);
    const config = upstreamText(row.folder) ?? upstreamText(row.name);
    const evaluatedAt = upstreamDate(row.date);
    return [{
      id: `swebench:${index}`,
      model,
      score: score / 100,
      effort: upstreamText(row.reasoning_effort) ?? "unspecified",
      harness: `mini-SWE-agent${version ? ` v${version}` : " (version unreported)"}${config ? ` · config: ${config}` : ""}`,
      costUsd: measured(row.instance_cost),
      latencySeconds: null,
      ...(evaluatedAt === undefined ? {} : { evaluatedAt })
    }];
  });
  return { rows };
}

function aiderRows(yaml: string): { rows: BenchmarkResult[] } {
  const rows = rowsArray(parse(yaml), "Aider rows").flatMap((value, index): BenchmarkResult[] => {
    const row = record(value, "Aider row");
    const model = upstreamText(row.model);
    const format = upstreamText(row.edit_format);
    // Architect and parent-linked runs can involve an editor model not named by model.
    if (!model || model.includes("+") || format?.toLowerCase() === "architect" || row.parent != null ||
      /--editor-model(?:\s|=)/.test(upstreamText(row.command) ?? "")) return [];
    const score = measured(row.pass_rate_2);
    if (score === null || score > 100) return [];
    const total = measured(row.total_cost);
    const cases = measured(row.test_cases);
    const cost = total !== null && total > 0 && cases !== null && cases > 0 ? measured(total / cases) : null;
    const config = upstreamText(row.dirname);
    const version = upstreamText(row.versions);
    const evaluatedAt = upstreamDate(row.date);
    return [{
      id: `aider:${index}`,
      model,
      score: score / 100,
      effort: upstreamText(row.reasoning_effort) ?? model.match(/\(([^()]*(?:high|medium|low|think|reasoner|chat)[^()]*)\)/i)?.[1] ?? "unspecified",
      harness: `aider${version ? ` v${version}` : ""} · edit: ${format ?? "unspecified"}${config ? ` · config: ${config}` : ""}`,
      costUsd: cost,
      latencySeconds: measured(row.seconds_per_case),
      ...(evaluatedAt === undefined ? {} : { evaluatedAt })
    }];
  });
  return { rows };
}

export async function fetchBenchmarkDataset(id: string): Promise<BenchmarkDataset> {
  const source = BENCHMARK_SOURCES.find((entry) => entry.id === id);
  if (!source) throw new Error(`Unknown benchmark source: ${id}`);
  const response = await fetch(source.url, {
    headers: { "User-Agent": "which-copilot-model/0.1" },
    signal: AbortSignal.timeout(15_000),
    redirect: "error", // Do not follow upstream redirects to non-allowlisted URLs.
    next: { revalidate: 3600 }
  });
  if (!response.ok) throw new Error(`${source.name} returned HTTP ${response.status}`);
  const result = id === "deepswe" ? deepSWERows(await response.json()) :
    id === "swebench" ? swebenchRows(await response.text()) : aiderRows(await response.text());
  if (!result.rows.length) throw new Error(`${source.name} did not contain recognizable benchmark rows`);
  return validateBenchmarkDataset({
    id: source.id,
    name: source.name,
    source: source.url,
    fetchedAt: new Date().toISOString(),
    metric: source.metric,
    description: source.description,
    ...result
  });
}