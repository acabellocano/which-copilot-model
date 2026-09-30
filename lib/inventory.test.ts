import { describe, expect, it } from "vitest";
import { canonicalModelName, emptyInventory, estimatedCredits, inventoryFromNames, manualModel, matchesModel, modelMatchStatus, parseInventory } from "./inventory";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createInventory } = require("../extension/src/inventory.js");

describe("model inventory boundary", () => {
  it("accepts the actual companion export without losing opaque metadata", () => {
    const exported = createInventory([{ id: "opaque-id", name: "GPT-6 Astra", vendor: "copilot", family: "gpt-6-astra", version: "v1", maxInputTokens: 128000 }], { vscodeVersion: "1.136.1", scope: "copilot" });
    const result = parseInventory(JSON.parse(JSON.stringify(exported)));
    expect(result.models[0]).toMatchObject({ id: "opaque-id", name: "GPT-6 Astra", maxInputTokens: 128000, inputCredits: null, enabled: true });
  });

  it("migrates names but never assigns units to legacy OCR pricing", () => {
    expect(parseInventory([{ id: "old", name: "Alpha", inputCost: 200, inputCredits: 200 }]).models[0].inputCredits).toBeNull();
  });

  it("deduplicates manually pasted names and keeps unknown metadata unknown", () => {
    const result = inventoryFromNames("Alpha\r\nBeta\r\nAlpha\r\n");
    expect(result.models.map((model) => model.name)).toEqual(["Alpha", "Beta"]);
    expect(result.models[0].maxInputTokens).toBeNull();
    expect(result.models[0].inputCredits).toBeNull();
  });

  it("rejects invalid schema, duplicate IDs, bad numbers, and malformed rows", () => {
    const model = manualModel("Alpha");
    const inventory = { ...emptyInventory(), models: [model] };
    for (const invalid of [{ ...inventory, schemaVersion: 2 }, { ...inventory, scope: "picker" }, { ...inventory, models: [model, model] }, { ...inventory, models: [null] }, { ...inventory, models: [{ ...model, name: "" }] }, { ...inventory, models: [{ ...model, enabled: "true" }] }]) {
      expect(() => parseInventory(invalid)).toThrow();
    }
    for (const value of [-1, NaN, Infinity, "2"]) expect(() => parseInventory({ ...inventory, models: [{ ...model, inputCredits: value }] })).toThrow();
    for (const value of [0, 1.5, "128k"]) expect(() => parseInventory({ ...inventory, models: [{ ...model, maxInputTokens: value }] })).toThrow();
  });
});

describe("conservative benchmark identity", () => {
  it.each([
    ["GPT-6 Astra", "gpt-6-astra [xhigh]"],
    ["Claude Sonnet 4.5", "Claude 4.5 Sonnet (high)"],
    ["Claude Sonnet 3.5", "anthropic/claude-3-5-sonnet-20241022"],
    ["Gemini 3.8 Flash", "gemini-3-8-flash-preview"],
    ["GPT-5.3-Codex", "GPT-5.3 Codex"],
    ["Claude Opus 5.5", "Claude Opus 5.5"],
    ["Claude Sonnet 5.5", "Claude Sonnet 5.5"],
    ["GPT-6.1 Sol", "GPT-6.1 Sol"],
    ["GPT-6 Luna", "GPT-6 Luna"],
    ["GPT-6 Sol", "GPT-6 Sol"],
    ["Grok 4.7", "Grok 4.7"]
  ])("matches formatting variants %s and %s", (left, right) => {
    expect(canonicalModelName(left)).toBe(canonicalModelName(right));
    expect(matchesModel(manualModel(left), right)).toBe(true);
  });

  it.each([
    ["Claude Fable 5", "Claude Fable 5.1"],
    ["GPT-5", "GPT-5 mini"],
    ["GPT-5.4", "GPT-5.4 Codex"],
    ["Gemini 3.8 Flash", "Gemini 3.8 Pro"],
    ["Qwen3 Coder", "Qwen3 Coder Chat"],
    ["DeepSeek V3", "DeepSeek Chat V3"],
    ["MAI-Code-1.1-Flash", "Gemini 3.8 Flash"],
    ["Claude Opus 4.8", "Claude Opus 4.8 (fast mode)"]
  ])("does not guess across %s and %s", (left, right) => {
    expect(matchesModel(manualModel(left), right)).toBe(false);
  });

  it("uses an explicit alias as a replacement, never a fuzzy extension", () => {
    const model = { ...manualModel("Evaluation codename"), benchmarkAlias: "GPT-6 Astra" };
    expect(matchesModel(model, "gpt-6-astra")).toBe(true);
    expect(matchesModel(model, "Evaluation codename")).toBe(false);
  });

  it("explains absent evidence versus aliases and never attributes Auto to an API backing model", () => {
    const model = manualModel("Claude Opus 5.5");
    expect(modelMatchStatus(model, [], 0)).toContain("No evidence loaded");
    expect(modelMatchStatus(model, ["Claude Opus 5.5"], 6)).toContain("1 benchmark names matched");
    expect(modelMatchStatus(model, ["Claude Opus 4.8"], 3)).toContain("does not mean the model is unavailable");
    expect(modelMatchStatus({ ...model, benchmarkAlias: "Wrong" }, [model.name], 3)).toContain("Explicit alias");
    const auto = { ...manualModel("Auto"), family: "gpt-5.3-codex", benchmarkAlias: "GPT-5.3 Codex" };
    expect(matchesModel(auto, "GPT-5.3 Codex")).toBe(false);
    expect(modelMatchStatus(auto, ["GPT-5.3 Codex"], 6)).toContain("routing policy");
  });
});

describe("credit estimates", () => {
  it("separates explicit Copilot credits from unknown and BYOK pricing", () => {
    const model = { ...manualModel("Alpha"), vendor: "copilot", inputCredits: 200, outputCredits: 1000 };
    expect(estimatedCredits(model, 10000, 2000)).toBe(4);
    expect(estimatedCredits({ ...model, inputCredits: 0, outputCredits: 0 }, 10000, 2000)).toBe(0);
    expect(estimatedCredits({ ...model, inputCredits: null }, 10000, 2000)).toBeNull();
    expect(estimatedCredits({ ...model, vendor: "openai" }, 10000, 2000)).toBeNull();
    expect(estimatedCredits(model, -1, 100)).toBeNull();
  });
});