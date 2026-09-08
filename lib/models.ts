export type AvailableModel = {
  id: string;
  name: string;
  contextSize: string;
  inputCost: number | null;
  outputCost: number | null;
  cacheReadCost: number | null;
  cacheWriteCost: number | null;
  capabilities: string;
};

export type BenchmarkRow = {
  model: string;
  effort: string;
  passAt1: number;
  avgCost: number;
  outputTokens: number;
  steps: number;
  harness?: string;
  provider?: string;
  config?: string;
};

export type BenchmarkSnapshot = {
  source: string;
  fetchedAt: string;
  generatedAt?: string;
  latestJob?: { name?: string; finishedAt?: string };
  rows: BenchmarkRow[];
};

export function normalizeModelName(value: string): string {
  return value.toLowerCase()
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\b(chat|preview|latest)\b/g, "")
    .replace(/[^a-z0-9]+/g, "");
}

export function modelNamesMatch(left: string, right: string): boolean {
  const a = normalizeModelName(left);
  const b = normalizeModelName(right);
  if (!a || !b) return false;
  if (a === b || a.startsWith(b) || b.startsWith(a)) return true;
  const tokens = (value: string) => value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !["chat", "preview", "latest", "gpt", "claude", "gemini", "openai", "anthropic", "google", "flash", "code", "model", "pro", "max"].includes(token));
  const leftTokens = new Set(tokens(left));
  const rightTokens = new Set(tokens(right));
  const shared = [...leftTokens].filter((token) => rightTokens.has(token) && token !== "gpt");
  return shared.some((token) => token.length >= 5) || shared.length >= 2;
}

export function parseNumber(value: string): number | null {
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export type RankingObjective = "quality" | "cost" | "speed" | "efficiency" | "quality-cost" | "quality-speed" | "cost-speed" | "custom";

export function rankModels(available: AvailableModel[], rows: BenchmarkRow[], objective: RankingObjective, minimumPassAt1 = 0.66, customWeights?: [number, number, number]) {
  const matches = [...new Map(available.flatMap((model) => rows
    .filter((row) => modelNamesMatch(row.model, model.name) && row.passAt1 >= minimumPassAt1)
    .map((row) => [`${row.config ?? row.model}-${row.effort}`, { model, row }] as const))).values()];
  if (!matches.length) return [];
  const range = (key: keyof BenchmarkRow) => {
    const values = matches.map(({ row }) => Number(row[key])).filter(Number.isFinite);
    return { min: Math.min(...values), max: Math.max(...values) };
  };
  const pass = range("passAt1"), cost = range("avgCost"), tokens = range("outputTokens"), steps = range("steps");
  const high = (v: number, r: { min: number; max: number }) => r.max === r.min ? 1 : (v - r.min) / (r.max - r.min);
  const low = (v: number, r: { min: number; max: number }) => r.max === r.min ? 1 : (r.max - v) / (r.max - r.min);
  return matches.map(({ model, row }) => {
    const components = {
      quality: high(row.passAt1, pass),
      cost: low(row.avgCost, cost),
      outputTokens: low(row.outputTokens, tokens),
      steps: low(row.steps, steps)
    };
    const weights = objective === "quality" ? [1, 0, 0] :
      objective === "cost" ? [0, 1, 0] :
      objective === "speed" ? [0, 0, 1] :
      objective === "quality-cost" ? [.5, .5, 0] :
      objective === "quality-speed" ? [.5, 0, .5] :
      objective === "cost-speed" ? [0, .5, .5] :
      objective === "custom" ? (customWeights ?? [34, 33, 33]).map((weight) => weight / Math.max(1, (customWeights ?? [34, 33, 33]).reduce((sum, value) => sum + value, 0))) :
      [1 / 3, 1 / 3, 1 / 3];
    const score = components.quality * weights[0] + components.cost * weights[1] + ((components.outputTokens + components.steps) / 2) * weights[2];
    return { model, row, score, components };
  }).sort((a, b) => b.score - a.score);
}
