import type { BenchmarkDataset, BenchmarkResult } from "./benchmarks";
import { canonicalModelName, estimatedCredits, InventoryModel, matchesModel } from "./inventory";

export const TASK_PROFILES = {
  engineering: { name: "Repository engineering", description: "Long-horizon fixes, debugging, and multi-file changes; overlapping Epoch composite stays opt-in.", weights: { deepswe: 30, swebench: 20, aider: 10, frontiercode: 25, cursorbench: 15, epoch: 0 } },
  editing: { name: "Focused code edits", description: "Small changes, implementation, and polyglot editing; overlapping Epoch composite stays opt-in.", weights: { deepswe: 10, swebench: 10, aider: 45, frontiercode: 15, cursorbench: 20, epoch: 0 } },
  balanced: { name: "Balanced coding", description: "Equal weight across five coding sources; overlapping Epoch composite stays opt-in.", weights: { deepswe: 20, swebench: 20, aider: 20, frontiercode: 20, cursorbench: 20, epoch: 0 } }
} as const;

export type DecisionObjective = "quality" | "value";
export type Evidence = { dataset: BenchmarkDataset; row: BenchmarkResult; percentile: number };
export type Recommendation = { model: InventoryModel; evidence: Evidence[]; coverage: number; quality: number; index: number; credits: number | null };

export function rankInventory(models: InventoryModel[], datasets: BenchmarkDataset[], weights: Record<string, number>, objective: DecisionObjective, inputTokens: number, outputTokens: number, minimumCoverage = 0): Recommendation[] {
  const active = datasets.filter((dataset) => (weights[dataset.id] ?? 0) > 0 && dataset.rows.length > 0);
  const totalWeight = active.reduce((sum, dataset) => sum + weights[dataset.id], 0);
  if (!totalWeight) return [];
  // One best recorded configuration per model/source. This is an evidence ceiling, not a Copilot run.
  const bestBySource = new Map(active.map((dataset) => {
    const best = new Map<string, number>();
    for (const row of dataset.rows) {
      const name = canonicalModelName(row.model);
      best.set(name, Math.max(best.get(name) ?? -Infinity, row.score));
    }
    return [dataset.id, [...best.values()]] as const;
  }));
  return models.filter((model) => model.enabled && model.name.trim()).flatMap((model): Recommendation[] => {
    const evidence: Evidence[] = active.flatMap((dataset) => {
      const row = dataset.rows.filter((candidate) => matchesModel(model, candidate.model))
        .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))[0];
      if (!row) return [];
      const scores = bestBySource.get(dataset.id)!;
      // Tie-aware percentile; singleton/all-tied populations are neutral, not automatically perfect.
      const percentile = scores.length <= 1 ? 0.5 : (scores.filter((score) => score < row.score).length + (scores.filter((score) => score === row.score).length - 1) / 2) / (scores.length - 1);
      return [{ dataset, row, percentile }];
    });
    const coveredWeight = evidence.reduce((sum, item) => sum + weights[item.dataset.id], 0);
    const coverage = coveredWeight / totalWeight;
    if (!evidence.length || coverage < minimumCoverage) return [];
    const quality = evidence.reduce((sum, item) => sum + item.percentile * weights[item.dataset.id], 0) / totalWeight;
    const credits = estimatedCredits(model, inputTokens, outputTokens);
    return [{ model, evidence, coverage, quality, index: quality, credits }];
  }).filter((item) => objective === "quality" || item.credits !== null)
    .map((item) => ({ ...item, index: objective === "value" ? item.quality / (1 + item.credits!) : item.quality }))
    .sort((a, b) => b.index - a.index || b.coverage - a.coverage || a.model.name.localeCompare(b.model.name));
}