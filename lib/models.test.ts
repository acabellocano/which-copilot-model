import { describe, expect, it } from "vitest";
import { modelNamesMatch, normalizeModelName, rankModels } from "./models";
import { parseDeepSWEHtml } from "./deepswe";
import { parseModelTableText } from "./ocr";

describe("model matching and ranking", () => {
  it("normalizes effort annotations and punctuation", () => {
    expect(normalizeModelName("GPT-6 Astra [xhigh]")).toBe("gpt6astra");
    expect(modelNamesMatch("claude-fable-5", "Claude Fable 5.1")).toBe(true);
  });
  it("ranks quality when quality is selected", () => {
    const available = [{ id: "1", name: "Alpha", contextSize: "1M", inputCost: 1, outputCost: 2, cacheReadCost: null, cacheWriteCost: null, capabilities: "" }, { id: "2", name: "Beta", contextSize: "1M", inputCost: 1, outputCost: 2, cacheReadCost: null, cacheWriteCost: null, capabilities: "" }];
    const rows = [{ model: "Alpha", effort: "high", passAt1: .8, avgCost: 10, outputTokens: 100, steps: 5 }, { model: "Beta", effort: "high", passAt1: .6, avgCost: 1, outputTokens: 50, steps: 2 }];
    expect(rankModels(available, rows, "quality")[0].model.name).toBe("Alpha");
  });
  it("parses the visible DeepSWE leaderboard row shape", () => {
    const rows = parseDeepSWEHtml("<div>gpt-6-astra [ xhigh ] 74 % ± 3 % Avg cost $6.52 Out tok 30k Steps 29</div>");
    expect(rows[0]).toMatchObject({ model: "gpt-6-astra", effort: "xhigh", passAt1: .74, avgCost: 6.52, outputTokens: 30000, steps: 29 });
  });
  it("keeps incomplete OCR rows for manual review", () => {
    const rows = parseModelTableText("Claude Sonnet 5 1M Tools Vision In: 200 Out: 1000");
    expect(rows).toHaveLength(1);
    expect(rows[0].cacheReadCost).toBeNull();
    expect(rows[0].cacheWriteCost).toBeNull();
  });
});
