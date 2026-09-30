import { describe, expect, it } from "vitest";
import { rankInventory, TASK_PROFILES } from "./decisions";
import { manualModel } from "./inventory";
import type { BenchmarkDataset, BenchmarkResult } from "./benchmarks";

const row = (model: string, score: number, id = model): BenchmarkResult => ({ id, model, score, effort: "high", harness: "test-only", costUsd: null, latencySeconds: null });
const dataset = (id: string, rows: BenchmarkResult[]): BenchmarkDataset => ({ id, name: id, source: "https://example.com", fetchedAt: "2026-09-30T12:00:00Z", metric: "test score", description: "Unit fixture only", rows });

describe("coding decision indices", () => {
  it("ranks signed raw indices without replacing negative values with zero", () => {
    const source = { ...dataset("epoch", [row("Alpha", -10), row("Beta", -20), row("Gamma", -30)]), scoreKind: "index" as const };
    const results = rankInventory([manualModel("Alpha"), manualModel("Beta"), manualModel("Gamma")], [source], { epoch: 1 }, "quality", 0, 0);
    expect(results.map(item => [item.model.name, item.index])).toEqual([["Alpha", 1], ["Beta", .5], ["Gamma", 0]]);
  });

  it("keeps the overlapping Epoch composite opt-in for every preset", () => {
    for (const profile of Object.values(TASK_PROFILES)) {
      expect(profile.weights.epoch).toBe(0);
      expect(profile.weights.frontiercode).toBeGreaterThan(0);
      expect(profile.weights.cursorbench).toBeGreaterThan(0);
    }
  });
  it("retains separate inventory entries even when they share benchmark evidence", () => {
    const one = manualModel("Alpha");
    const two = { ...manualModel("Different display"), benchmarkAlias: "Alpha" };
    expect(rankInventory([one, two], [dataset("one", [row("Alpha", .8)])], { one: 1 }, "quality", 0, 0)).toHaveLength(2);
  });

  it("uses within-source rank, counts canonical model identity once, and retains best effort", () => {
    const results = rankInventory([manualModel("Alpha"), manualModel("Beta")], [dataset("one", [row("Alpha (high)", .8, "a1"), row("Alpha (low)", .5, "a2"), row("Beta", .6)])], { one: 1 }, "quality", 0, 0);
    expect(results[0].model.name).toBe("Alpha");
    expect(results[0].evidence[0].row.id).toBe("a1");
    expect(results[0].index).toBe(1);
    expect(results[1].index).toBe(0);
  });

  it("penalizes missing loaded coverage and supports a minimum coverage gate", () => {
    const sources = [dataset("one", [row("Alpha", .9), row("Beta", .8)]), dataset("two", [row("Beta", .7), row("Gamma", .6)])];
    const models = [manualModel("Alpha"), manualModel("Beta")];
    const result = rankInventory(models, sources, { one: 1, two: 1 }, "quality", 0, 0);
    expect(result.find((item) => item.model.name === "Alpha")).toMatchObject({ coverage: .5, quality: .5 });
    expect(rankInventory(models, sources, { one: 1, two: 1 }, "quality", 0, 0, 1).map((item) => item.model.name)).toEqual(["Beta"]);
  });

  it("ignores unloaded and zero-weight sources; does not invent coverage", () => {
    const model = manualModel("Alpha");
    expect(rankInventory([model], [], { one: 1 }, "quality", 0, 0)).toEqual([]);
    expect(rankInventory([model], [dataset("one", [row("Alpha", .7)])], { one: 0 }, "quality", 0, 0)).toEqual([]);
    expect(rankInventory([model], [dataset("one", [row("Alpha", .7)])], { one: 1, unloaded: 100 }, "quality", 0, 0)[0]).toMatchObject({ coverage: 1, quality: .5 });
  });

  it("keeps tied evidence neutral and excludes unknown prices only in value mode", () => {
    const models = [{ ...manualModel("Alpha"), vendor: "copilot", inputCredits: 0, outputCredits: 0 }, manualModel("Beta")];
    const sources = [dataset("one", [row("Alpha", .8), row("Beta", .8)])];
    const quality = rankInventory(models, sources, { one: 1 }, "quality", 10000, 2000);
    expect(quality.map((item) => item.index)).toEqual([.5, .5]);
    expect(rankInventory(models, sources, { one: 1 }, "value", 10000, 2000).map((item) => item.model.name)).toEqual(["Alpha"]);
    expect(rankInventory([{ ...models[0], enabled: false }], sources, { one: 1 }, "quality", 0, 0)).toEqual([]);
  });
});