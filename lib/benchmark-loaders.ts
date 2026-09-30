import { parse } from "yaml";
import { BENCHMARK_SOURCES, record, own, date, rowsArray, validateBenchmarkDataset, type BenchmarkDataset, type BenchmarkResult } from "./benchmarks";

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
  const signal = AbortSignal.timeout(15_000);
  const fetchText = async (url: string) => {
    const response = await fetch(url, {
    headers: { "User-Agent": "which-copilot-model/0.2" },
    signal,
    redirect: "error", // Do not follow upstream redirects to non-allowlisted URLs.
    next: { revalidate: 3600 }
    });
    if (!response.ok) throw new Error(`${source.name} returned HTTP ${response.status}`);
    return response.text();
  };
  const result = id === "deepswe" ? deepSWERows(JSON.parse(await fetchText(source.url))) :
    id === "swebench" ? swebenchRows(await fetchText(source.url)) :
    id === "aider" ? aiderRows(await fetchText(source.url)) :
    await (await import("./extra-benchmarks")).loadExtraBenchmark(id, fetchText);
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