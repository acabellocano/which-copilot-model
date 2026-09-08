import { BenchmarkRow } from "./models";

const source = "https://deepswe.datacurve.ai/artifacts/v1.1/leaderboard-live.json";

type DeepSWERawRow = {
  model?: unknown;
  reasoning_effort?: unknown;
  pass_rate?: unknown;
  pass_at_1?: unknown;
  mean_cost_usd?: unknown;
  mean_output_tokens?: unknown;
  mean_agent_steps?: unknown;
  harness?: unknown;
  provider?: unknown;
  config?: unknown;
};

export function parseDeepSWEData(data: { rows?: unknown }): BenchmarkRow[] {
  if (!Array.isArray(data.rows)) return [];
  return data.rows.flatMap((value) => {
    const row = value as DeepSWERawRow;
    const passAt1 = typeof row.pass_rate === "number" ? row.pass_rate : row.pass_at_1;
    if (typeof row.model !== "string" ||
      typeof passAt1 !== "number" || typeof row.mean_cost_usd !== "number" ||
      typeof row.mean_output_tokens !== "number" || typeof row.mean_agent_steps !== "number") return [];
    return [{
      model: row.model,
      effort: typeof row.reasoning_effort === "string" && row.reasoning_effort ? row.reasoning_effort : "none",
      passAt1,
      avgCost: row.mean_cost_usd,
      outputTokens: row.mean_output_tokens,
      steps: row.mean_agent_steps,
      harness: typeof row.harness === "string" ? row.harness : undefined,
      provider: typeof row.provider === "string" ? row.provider : undefined,
      config: typeof row.config === "string" ? row.config : undefined
    }];
  });
}

export async function fetchDeepSWESnapshot(): Promise<{ source: string; fetchedAt: string; generatedAt?: string; latestJob?: { name?: string; finishedAt?: string }; rows: BenchmarkRow[] }> {
  const response = await fetch(source, { headers: { "User-Agent": "which-copilot-model/0.1" }, next: { revalidate: 3600 } });
  if (!response.ok) throw new Error(`DeepSWE returned HTTP ${response.status}`);
  const data = await response.json() as { rows?: unknown; generated_at?: unknown; latest_job?: { name?: unknown; finished_at?: unknown } };
  const rows = parseDeepSWEData(data);
  if (!rows.length) throw new Error("DeepSWE page did not contain recognizable benchmark rows");
  return {
    source,
    fetchedAt: new Date().toISOString(),
    generatedAt: typeof data.generated_at === "string" ? data.generated_at : undefined,
    latestJob: data.latest_job ? {
      name: typeof data.latest_job.name === "string" ? data.latest_job.name : undefined,
      finishedAt: typeof data.latest_job.finished_at === "string" ? data.latest_job.finished_at : undefined
    } : undefined,
    rows
  };
}
