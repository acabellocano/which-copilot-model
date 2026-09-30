import { load } from "cheerio";
import { parse } from "csv-parse/sync";
import type { BenchmarkResult } from "./benchmarks";

const FRONTIERCODE_URL = "https://cognition.com/data/frontiercode-leaderboard/data.json";
const CURSORBENCH_URL = "https://cursor.com/cursorbench";
const EPOCH_URLS = [
  "https://epoch.ai/data/eci_scores.csv",
  "https://epoch.ai/data/processed_data_for_eci.csv",
  "https://epoch.ai/data/edi_scores.csv"
] as const;

export const SOFTWARE_BENCHMARKS = [
  "MirrorCode", "SWE-Bench verified", "Terminal Bench", "Aider polyglot", "Cybench",
  "WeirdML", "FrontierSWE", "GSO-Bench", "ExploitBench", "PostTrainBench", "FrontierCode",
  "DeepSWE", "Surface Evolver Bench"
] as const;

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

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  // Preserve source keys exactly: trimming them would change Epoch model/benchmark joins.
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function nonnegative(value: unknown, label: string, maximum = Number.MAX_VALUE): number {
  const result = finite(value, label);
  if (result < 0 || result > maximum) throw new Error(`${label} must be between 0 and ${maximum}`);
  return result;
}

function optionalMeasurement(value: unknown, label: string): number | null {
  return value === undefined || value === null ? null : nonnegative(value, label);
}

function uniqueStrings(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} must be a nonempty array`);
  const entries = Array.from(value, (entry) => text(entry, label));
  if (new Set(entries).size !== entries.length) throw new Error(`${label} contains duplicates`);
  return entries;
}

/** FrontierCode 1.1, Main split, new_score only; every published effort is a separate row. */
export function parseFrontierCode(data: unknown): BenchmarkResult[] {
  const root = record(data, "FrontierCode response");
  const version = record(own(root, "v1_1"), "FrontierCode v1_1");
  const models = uniqueStrings(own(version, "models"), "FrontierCode v1_1 models");
  const harnesses = record(own(version, "harness"), "FrontierCode harness");
  const efforts = record(own(version, "efforts"), "FrontierCode efforts");
  const results = record(own(version, "data"), "FrontierCode data");
  const subsets = record(own(version, "subsets"), "FrontierCode subsets");
  const mainCount = nonnegative(own(subsets, "main"), "FrontierCode main task count");
  if (!Number.isInteger(mainCount) || mainCount === 0) throw new Error("FrontierCode main task count must be a positive integer");
  if (Object.keys(results).some((model) => !models.includes(model))) {
    throw new Error("FrontierCode data contains a model absent from models");
  }
  return models.flatMap((model) => {
    const harness = text(own(harnesses, model), `FrontierCode harness for ${model}`);
    const configurations = uniqueStrings(own(efforts, model), `FrontierCode efforts for ${model}`);
    const modelResults = record(own(results, model), `FrontierCode data for ${model}`);
    if (Object.keys(modelResults).some((effort) => !configurations.includes(effort))) {
      throw new Error(`FrontierCode data contains an undeclared effort for ${model}`);
    }
    return configurations.map((effort) => {
      const configuration = record(own(modelResults, effort), `FrontierCode ${model}/${effort}`);
      const main = record(own(configuration, "main"), `FrontierCode ${model}/${effort}/main`);
      const minutes = optionalMeasurement(own(main, "duration_min"), "FrontierCode duration_min");
      return {
        id: `frontiercode:${JSON.stringify([model, effort])}`,
        model,
        effort,
        score: nonnegative(own(main, "new_score"), "FrontierCode main new_score", 1),
        harness: `FrontierCode1.1/Main · ${harness}`,
        costUsd: optionalMeasurement(own(main, "cost"), "FrontierCode main cost"),
        latencySeconds: minutes === null ? null : nonnegative(minutes * 60, "FrontierCode latencySeconds")
      };
    });
  });
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cursorNumber(value: string, unit: "$" | "%", label: string): number {
  const pattern = unit === "$" ? /^\$\s*((?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?)$/ : /^(\d+(?:\.\d+)?)\s*%$/;
  const match = value.match(pattern);
  if (!match) throw new Error(`CursorBench ${label} has an unexpected format: ${value}`);
  return nonnegative(Number(match[1].replace(/,/g, "")), `CursorBench ${label}`, unit === "%" ? 100 : Number.MAX_VALUE);
}

/** Parse only the first SSR table; the mobile duplicate must not become extra configurations. */
export function parseCursorBench(html: string): BenchmarkResult[] {
  const $ = load(html);
  if (!/^CursorBench\s*4\.0$/.test(normalizedText($("h1").first().text()))) {
    throw new Error("CursorBench version drift: expected h1 CursorBench 4.0");
  }
  const table = $("table").first();
  const headers = table.find("tr").first().find("th").map((_, cell) => {
    const header = $(cell).clone();
    header.find(".md\\:hidden").remove();
    return (header.text() || header.attr("aria-label") || "").replace(/\s+/g, "").toLowerCase();
  }).get();
  if (headers.length !== 6 || headers[0] !== "rank" || headers[1] !== "model" ||
    headers[2] !== "score" || headers[3] !== "cost/task" ||
    !/^tokens(?:\/task)?$/.test(headers[4]) || !/^steps(?:\/task)?$/.test(headers[5])) {
    throw new Error("CursorBench first table has unexpected rank/model/score/cost/task/tokens/steps headers");
  }
  const rows: BenchmarkResult[] = [];
  const ids = new Set<string>();
  table.find("tr").each((_, element) => {
    const cells = $(element).find("td");
    if (!cells.length) return;
    if (cells.length !== 6) throw new Error("CursorBench result must have six cells");
    const values = cells.map((_, cell) => normalizedText($(cell).text())).get();
    if (!/^[1-9]\d*$/.test(values[0])) throw new Error("CursorBench rank must be a positive integer");
    const label = text(values[1], "CursorBench model");
    const suffix = label.match(/\s+(Extra High|Max|High|Medium|Low|None)$/);
    let model = suffix ? label.slice(0, -suffix[0].length) : label;
    model = text(model, "CursorBench model without effort");
    if (/^(?:Opus|Sonnet|Fable|Haiku)(?:\s|$)/.test(model)) model = `Claude ${model}`;
    const effort = suffix ? suffix[1].toLowerCase() : "unspecified";
    const id = `cursorbench:${JSON.stringify([model, effort])}`;
    if (ids.has(id)) throw new Error(`CursorBench duplicate configuration: ${label}`);
    ids.add(id);
    rows.push({
      id,
      model,
      effort,
      score: cursorNumber(values[2], "%", "score") / 100,
      costUsd: cursorNumber(values[3], "$", "cost/task"),
      latencySeconds: null,
      harness: "Cursor agent · CursorBench 4.0 (exact harness version unreported)"
    });
  });
  if (!rows.length) throw new Error("CursorBench first table contains no results");
  return rows;
}

function csvRows(source: string, required: readonly string[], label: string): Record<string, unknown>[] {
  const rows: unknown = parse(source, { columns: true, skip_empty_lines: true, bom: true });
  if (!Array.isArray(rows) || !rows.length) throw new Error(`${label} CSV contains no rows`);
  return rows.map((value) => {
    const row = record(value, `${label} CSV row`);
    if (required.some((column) => !Object.prototype.hasOwnProperty.call(row, column))) {
      throw new Error(`${label} CSV headers must include ${required.join(", ")}`);
    }
    return row;
  });
}

function csvNumber(value: unknown, label: string): number {
  const valueText = text(value, label);
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(valueText.trim())) {
    throw new Error(`${label} must be a decimal number`);
  }
  return finite(Number(valueText), label);
}

function releaseDate(value: unknown): string | undefined {
  if (value === "") return undefined;
  const result = text(value, "Epoch release date");
  const calendar = result.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d))?$/.test(result) ||
    !Number.isFinite(Date.parse(result)) || new Date(`${calendar}T00:00:00Z`).toISOString().slice(0, 10) !== calendar) {
    throw new Error("Epoch release date must be a valid ISO date or timestamp with timezone");
  }
  return result;
}

export type SoftwareObservation = { performance: number; edi: number; slope: number };

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exponential = Math.exp(value);
  return exponential / (1 + exponential);
}

/** Independent bounded least-squares refit, using official general EDI/slopes unchanged. */
export function fitSoftwareCapability(observations: readonly SoftwareObservation[]): number {
  if (!observations.length) throw new Error("Software capability needs observations");
  const points = observations.map(({ performance, edi, slope }) => {
    finite(edi, "Epoch EDI");
    finite(slope, "Epoch slope");
    if (slope <= 0) throw new Error("Epoch slope must be positive");
    return { performance: Math.max(0.001, Math.min(0.999, finite(performance, "Epoch performance"))), edi, slope };
  });
  const loss = (x: number) => points.reduce((sum, point) =>
    sum + (point.performance - sigmoid(point.slope * (x - point.edi))) ** 2, 0);
  const lower = -100;
  const upper = 300;
  const weight = points.reduce((sum, point) => sum + point.slope ** 2, 0);
  const inverse = points.reduce((sum, point) => sum + point.slope ** 2 *
    (point.edi + Math.log(point.performance / (1 - point.performance)) / point.slope), 0) / weight;
  let best = Number.isFinite(inverse) ? Math.max(lower, Math.min(upper, inverse)) : lower;
  let bestLoss = loss(best);
  // A coarse scan avoids depending on a single local starting point; then refine its best interval.
  for (let x = lower; x <= upper; x++) {
    const candidate = loss(x);
    if (candidate < bestLoss) { best = x; bestLoss = candidate; }
  }
  let left = Math.max(lower, best - 1);
  let right = Math.min(upper, best + 1);
  const ratio = (Math.sqrt(5) - 1) / 2;
  let a = right - ratio * (right - left);
  let b = left + ratio * (right - left);
  let fa = loss(a);
  let fb = loss(b);
  while (right - left > 1e-8) {
    if (fa < fb) {
      right = b; b = a; fb = fa;
      a = right - ratio * (right - left); fa = loss(a);
    } else {
      left = a; a = b; fa = fb;
      b = left + ratio * (right - left); fb = loss(b);
    }
  }
  const refined = (left + right) / 2;
  return loss(refined) < bestLoss ? refined : best;
}

/** SOFTWARE ECI is locally computed from official inputs, never copied from general eci_scores. */
export function parseEpochSoftware(eciCsv: string, processedCsv: string, ediCsv: string): BenchmarkResult[] {
  const models = csvRows(eciCsv, ["Model", "Display name", "eci", "date"], "Epoch general models");
  const processed = csvRows(processedCsv, ["model", "benchmark", "performance", "date"], "Epoch processed performance");
  const difficultyRows = csvRows(ediCsv, ["benchmark_name", "edi", "estimated_slope_scaled"], "Epoch difficulty");
  const software = new Set<string>(SOFTWARE_BENCHMARKS);
  const difficulties = new Map<string, { edi: number; slope: number }>();
  for (const row of difficultyRows) {
    const benchmark = text(row.benchmark_name, "Epoch benchmark_name");
    if (!software.has(benchmark)) continue;
    if (difficulties.has(benchmark)) throw new Error(`Duplicate Epoch difficulty: ${benchmark}`);
    const slope = csvNumber(row.estimated_slope_scaled, "Epoch estimated_slope_scaled");
    if (slope <= 0) throw new Error("Epoch estimated_slope_scaled must be positive");
    difficulties.set(benchmark, { edi: csvNumber(row.edi, "Epoch edi"), slope });
  }
  const performances = new Map<string, Map<string, number>>();
  if (difficulties.size !== SOFTWARE_BENCHMARKS.length) throw new Error("Epoch software preset is missing expected difficulty inputs");
  for (const row of processed) {
    const model = text(row.model, "Epoch processed model");
    const benchmark = text(row.benchmark, "Epoch processed benchmark");
    if (!software.has(benchmark) || !difficulties.has(benchmark)) continue;
    const performance = csvNumber(row.performance, "Epoch performance");
    if (performance < 0 || performance > 1) throw new Error("Epoch performance must be between 0 and 1");
    const byBenchmark = performances.get(model) ?? new Map<string, number>();
    byBenchmark.set(benchmark, Math.max(byBenchmark.get(benchmark) ?? -Infinity, performance));
    performances.set(model, byBenchmark);
  }
  const rows: BenchmarkResult[] = [];
  const ids = new Set<string>();
  for (const modelRow of models) {
    const key = text(modelRow.Model, "Epoch Model");
    if (ids.has(key)) throw new Error(`Duplicate Epoch Model: ${key}`);
    ids.add(key);
    const model = text(modelRow["Display name"], "Epoch Display name");
    csvNumber(modelRow.eci, "Epoch general eci"); // Schema check only; never a SOFTWARE score.
    const released = releaseDate(modelRow.date);
    const byBenchmark = performances.get(key);
    if (!byBenchmark || byBenchmark.size < 2) continue;
    const points = Array.from(byBenchmark, ([benchmark, performance]) => ({ performance, ...difficulties.get(benchmark)! }));
    const row = {
      id: `epoch-software:${JSON.stringify([key])}`,
      model,
      score: fitSoftwareCapability(points),
      effort: "best reported per benchmark",
      harness: `Epoch software preset · local refit · ${points.length} constituent benchmarks · 90% CI not computed`,
      benchmarkCount: points.length,
      costUsd: null,
      latencySeconds: null,
      ...(released === undefined ? {} : { releaseDate: released })
    };
    rows.push(row);
  }
  if (!rows.length) throw new Error("Epoch SOFTWARE has no models with at least 2 matched constituent benchmarks");
  return rows;
}

/** IDs select fixed official URLs; all network policy belongs to the supplied fetchText. */
export async function loadExtraBenchmark(
  id: string,
  fetchText: (url: string) => Promise<string>
): Promise<{ rows: BenchmarkResult[]; scoreKind?: "index" }> {
  switch (id) {
    case "frontiercode": return { rows: parseFrontierCode(JSON.parse(await fetchText(FRONTIERCODE_URL))) };
    case "cursorbench": return { rows: parseCursorBench(await fetchText(CURSORBENCH_URL)) };
    case "epoch":
    case "epoch-software": {
      const [eci, processed, edi] = await Promise.all(EPOCH_URLS.map((url) => fetchText(url)));
      return { rows: parseEpochSoftware(eci, processed, edi), scoreKind: "index" };
    }
    default: throw new Error(`Unknown extra benchmark: ${id}`);
  }
}
