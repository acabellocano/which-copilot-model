import { describe, expect, it } from "vitest";
import { modelNamesMatch, normalizeModelName, rankModels } from "./models";
import { parseDeepSWEData } from "./deepswe";
import { parseModelTableText } from "./ocr";

describe("model matching and ranking", () => {
  it("normalizes effort annotations and punctuation", () => {
    expect(normalizeModelName("GPT-6 Astra [xhigh]")).toBe("gpt6astra");
    expect(modelNamesMatch("claude-fable-5", "Claude Fable 5.1")).toBe(true);
    expect(modelNamesMatch("Gemini 3.8 Flash", "gemini-3-8-flash")).toBe(true);
    expect(modelNamesMatch("MAI-Code-1.1-Flash", "gemini-3-8-flash")).toBe(false);
  });
  it("ranks quality when quality is selected", () => {
    const available = [{ id: "1", name: "Alpha", contextSize: "1M", inputCost: 1, outputCost: 2, cacheReadCost: null, cacheWriteCost: null, capabilities: "" }, { id: "2", name: "Beta", contextSize: "1M", inputCost: 1, outputCost: 2, cacheReadCost: null, cacheWriteCost: null, capabilities: "" }];
    const rows = [{ model: "Alpha", effort: "high", passAt1: .8, avgCost: 10, outputTokens: 100, steps: 5 }, { model: "Beta", effort: "high", passAt1: .6, avgCost: 1, outputTokens: 50, steps: 2 }];
    expect(rankModels(available, rows, "quality")[0].model.name).toBe("Alpha");
  });
  it("excludes configurations below the PASS@1 threshold", () => {
    const available = [{ id: "1", name: "Alpha", contextSize: "1M", inputCost: 1, outputCost: 2, cacheReadCost: null, cacheWriteCost: null, capabilities: "" }];
    const rows = [{ model: "Alpha", effort: "low", passAt1: .65, avgCost: 1, outputTokens: 1, steps: 1 }, { model: "Alpha", effort: "high", passAt1: .66, avgCost: 2, outputTokens: 2, steps: 2 }];
    expect(rankModels(available, rows, "quality")).toHaveLength(1);
    expect(rankModels(available, rows, "quality")[0].row.effort).toBe("high");
  });
  it("parses the DeepSWE artifact row shape", () => {
    const rows = parseDeepSWEData({ rows: [{ model: "gpt-6-astra", reasoning_effort: "xhigh", pass_rate: .74, mean_cost_usd: 6.52, mean_output_tokens: 30000, mean_agent_steps: 29 }] });
    expect(rows[0]).toMatchObject({ model: "gpt-6-astra", effort: "xhigh", passAt1: .74, avgCost: 6.52, outputTokens: 30000, steps: 29 });
  });
  it("keeps configurations without an effort label", () => {
    expect(parseDeepSWEData({ rows: [{ model: "kimi-k3", pass_rate: .5, mean_cost_usd: 1, mean_output_tokens: 2, mean_agent_steps: 3 }] })[0].effort).toBe("none");
  });
  it("keeps incomplete OCR rows for manual review", () => {
    const rows = parseModelTableText("Claude Sonnet 5 1M Tools Vision In: 200 Out: 1000");
    expect(rows).toHaveLength(1);
    expect(rows[0].cacheReadCost).toBeNull();
    expect(rows[0].cacheWriteCost).toBeNull();
  });
  it("parses OCR.space markdown table pricing", () => {
    const rows = parseModelTableText("| Claude Fable 5.1 | 1M | Tools Vision | In: 1000 | Out: 5000 | Cache Read: 25 | Cache Write: 1250 |");
    expect(rows[0]).toMatchObject({ inputCost: 1000, outputCost: 5000, cacheReadCost: 25, cacheWriteCost: 1250 });
  });
});
