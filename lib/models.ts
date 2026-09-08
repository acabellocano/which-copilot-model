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
};

export type BenchmarkSnapshot = {
  source: string;
  fetchedAt: string;
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
  return a === b || a.startsWith(b) || b.startsWith(a);
}

export function parseNumber(value: string): number | null {
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

export function rankModels(available: AvailableModel[], rows: BenchmarkRow[], objective: "quality" | "cost" | "speed" | "efficiency") {
  const matches = available.flatMap((model) => rows.filter((row) => modelNamesMatch(row.model, model.name)).map((row) => ({ model, row })));
  if (!matches.length) return [];
  const range = (key: keyof BenchmarkRow) => {
    const values = matches.map(({ row }) => Number(row[key])).filter(Number.isFinite);
    return { min: Math.min(...values), max: Math.max(...values) };
  };
  const pass = range("passAt1"), cost = range("avgCost"), tokens = range("outputTokens"), steps = range("steps");
  const high = (v: number, r: { min: number; max: number }) => r.max === r.min ? 1 : (v - r.min) / (r.max - r.min);
  const low = (v: number, r: { min: number; max: number }) => r.max === r.min ? 1 : (r.max - v) / (r.max - r.min);
  return matches.map(({ model, row }) => {
    const score = objective === "quality" ? high(row.passAt1, pass) :
      objective === "cost" ? low(row.avgCost, cost) :
      objective === "speed" ? (low(row.outputTokens, tokens) + low(row.steps, steps)) / 2 :
      (high(row.passAt1, pass) + low(row.avgCost, cost) + low(row.outputTokens, tokens) + low(row.steps, steps)) / 4;
    return { model, row, score };
  }).sort((a, b) => b.score - a.score);
}
