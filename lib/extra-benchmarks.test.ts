import { describe, expect, it, vi } from "vitest";
import { fitSoftwareCapability, loadExtraBenchmark, parseCursorBench, parseEpochSoftware, parseFrontierCode, SOFTWARE_BENCHMARKS } from "./extra-benchmarks";

function frontierFixture() {
  return {
    v1: { models: ["Wrong version"], data: {} },
    v1_1: {
      models: ["Example:model", "Other model"],
      harness: { "Example:model": "real-harness v2", "Other model": "different-harness" },
      efforts: { "Example:model": ["adaptive", "unlimited"], "Other model": ["none"] },
      subsets: { main: 100, extended: 150 },
      data: {
        "Example:model": {
          adaptive: { main: { new_score: 0.7, correct: 0.99, cost: 0, duration_min: 1.5 }, extended: { new_score: 0.1 } },
          unlimited: { main: { new_score: 0, correct: 1, duration_min: 0 } }
        },
        "Other model": { none: { main: { new_score: 1, cost: 1.25, duration_min: 2 } } }
      }
    }
  };
}

function cursorTable(configs = [
  ["Opus 5.5 Max", "80%", "$0.25"],
  ["Opus 5.5 Extra High", "81.5%", "$0"],
  ["GPT-5.6 Sol High", "99%", "$1,234.56"]
]) {
  return `<table><thead><tr><th>Rank</th><th>Model</th><th>Score</th><th>Cost / Task</th><th>Tokens/Task</th><th>Steps</th></tr></thead><tbody>${configs.map(([model, score, cost], index) =>
    `<tr><td>${index + 1}</td><td><span>${model}</span></td><td>${score}</td><td>${cost}</td><td>12345</td><td>99</td></tr>`).join("")}</tbody></table>`;
}

function cursorFixture(configs?: string[][]) {
  const table = cursorTable(configs);
  return `<h1>CursorBench4.0</h1>${table}${table}<script src="/not-to-download.js"></script>`;
}

const logistic = (x: number, edi: number, slope: number) => 1 / (1 + Math.exp(-slope * (x - edi)));

function epochFixture(x = -25) {
  const performanceA = logistic(x, -10, 0.025);
  const performanceB = logistic(x, 0, 0.04);
  return {
    eci: "Model,Display name,eci,date\r\nexact-key,Visible Model,250,2026-02-12\r\nsingle,One observation,275,2026-03-01\r\nmissing,No observations,290,\r\n",
    processed: `model,benchmark,performance,date\r\nexact-key,MirrorCode,0.01,2025-01-01\r\nexact-key,MirrorCode,${performanceA},2026-01-01\r\nexact-key,SWE-Bench verified,${performanceB},2026-01-02\r\nexact-key,MMLU,1,2026-01-02\r\nsingle,MirrorCode,0.9,2026-01-02\r\nsingle,MirrorCode,0.95,2026-01-03\r\nExact-key,MirrorCode,1,2026-01-03\r\nExact-key,SWE-Bench verified,1,2026-01-03\r\nVisible Model,MirrorCode,1,2026-01-03\r\nVisible Model,SWE-Bench verified,1,2026-01-03\r\n`,
    edi: "benchmark_name,edi,estimated_slope_scaled\r\nMirrorCode,-10,0.025\r\nSWE-Bench verified,0,0.04\r\nMMLU,30,0.1\r\n" + SOFTWARE_BENCHMARKS.filter(name => !["MirrorCode", "SWE-Bench verified"].includes(name)).map(name => `${name},100,0.1\r\n`).join("")
  };
}

describe("FrontierCode 1.1 Main", () => {
  it("enumerates arbitrary efforts and uses only main new_score with measured minutes and actual harnesses", () => {
    const rows = parseFrontierCode(frontierFixture());
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      id: `frontiercode:${JSON.stringify(["Example:model", "adaptive"])}`,
      model: "Example:model", effort: "adaptive", score: 0.7,
      harness: "FrontierCode1.1/Main · real-harness v2", costUsd: 0, latencySeconds: 90
    });
    expect(rows[1]).toMatchObject({ effort: "unlimited", score: 0, costUsd: null, latencySeconds: 0 });
    expect(rows[2]).toMatchObject({ score: 1, costUsd: 1.25, latencySeconds: 120, harness: "FrontierCode1.1/Main · different-harness" });
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(rows.every((row) => !("evaluatedAt" in row))).toBe(true);
  });

  it("accepts a changed task count without a hardcoded configuration count", () => {
    const fixture = frontierFixture();
    fixture.v1_1.subsets.main = 101;
    expect(parseFrontierCode(fixture)).toHaveLength(3);
  });

  it.each([-1, 1.01, NaN, Infinity, "0.7", undefined])("rejects invalid new_score %s", (new_score) => {
    const fixture = frontierFixture();
    const main = { ...fixture.v1_1.data["Example:model"].adaptive.main, new_score };
    fixture.v1_1.data["Example:model"].adaptive.main = main as typeof fixture.v1_1.data["Example:model"]["adaptive"]["main"];
    expect(() => parseFrontierCode(fixture)).toThrow(/new_score/);
  });

  it("rejects version/split/schema drift instead of falling back to v1, correct, or extended", () => {
    const fixture = frontierFixture();
    const main = fixture.v1_1.data["Example:model"].adaptive.main;
    for (const data of [null, { v1: fixture.v1_1 }, { v1_1: { ...fixture.v1_1, models: [] } },
      { v1_1: { ...fixture.v1_1, subsets: { extended: 150 } } },
      { v1_1: { ...fixture.v1_1, data: { ...fixture.v1_1.data, "Example:model": { adaptive: { extended: main }, unlimited: fixture.v1_1.data["Example:model"].unlimited } } } },
      { v1_1: { ...fixture.v1_1, harness: {} } },
      { v1_1: { ...fixture.v1_1, efforts: { ...fixture.v1_1.efforts, "Example:model": ["adaptive"] } } }
    ]) expect(() => parseFrontierCode(data)).toThrow(/FrontierCode/);
  });

  it("rejects invalid measured cost or duration rather than hiding bad data", () => {
    for (const field of ["cost", "duration_min"]) {
      const fixture = frontierFixture();
      Object.assign(fixture.v1_1.data["Example:model"].adaptive.main, { [field]: -1 });
      expect(() => parseFrontierCode(fixture)).toThrow(/cost|duration/);
    }
  });
});

describe("CursorBench 4.0 SSR", () => {
  it("reads one table, preserves generations/flavors, and splits only a trailing recognized effort", () => {
    const rows = parseCursorBench(cursorFixture());
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ model: "Claude Opus 5.5", effort: "max", score: 0.8, costUsd: 0.25 });
    expect(rows[1]).toMatchObject({ model: "Claude Opus 5.5", effort: "extra high", score: 0.815, costUsd: 0 });
    expect(rows[2]).toMatchObject({ model: "GPT-5.6 Sol", effort: "high", score: 0.99, costUsd: 1234.56 });
    expect(rows.every((row) => row.latencySeconds === null && !("evaluatedAt" in row))).toBe(true);
    expect(rows[0].harness).toBe("Cursor agent · CursorBench 4.0 (exact harness version unreported)");
  });

  it("reads all 63 configurations once without limiting the number of rows", () => {
    const configurations = Array.from({ length: 63 }, (_, index) => [`GPT-5.6 Sol ${index} High`, "50%", "$0.5"]);
    expect(parseCursorBench(cursorFixture(configurations))).toHaveLength(63);
  });

  it("handles all effort suffixes, explicit Claude identities, and leaves unrecognized suffixes intact", () => {
    const configurations = ["Sonnet 5.5 Medium", "Fable 5.5 Low", "Haiku 5.5 None", "Claude Opus 5.5 High", "GPT-5.6 Sol Turbo", "High Model 1"];
    const rows = parseCursorBench(cursorFixture(configurations.map((model) => [model, "0%", "$0"])));
    expect(rows.map(({ model, effort }) => [model, effort])).toEqual([
      ["Claude Sonnet 5.5", "medium"], ["Claude Fable 5.5", "low"], ["Claude Haiku 5.5", "none"],
      ["Claude Opus 5.5", "high"], ["GPT-5.6 Sol Turbo", "unspecified"], ["High Model 1", "unspecified"]
    ]);
  });

  it.each(["101%", "-1%", "NaN%", "80", "80% (best)"])("rejects invalid score %s in any expected row", (score) => {
    expect(() => parseCursorBench(cursorFixture([["Good", "80%", "$0"], ["Bad", score, "$1"]]))).toThrow(/score/);
  });

  it.each(["$-1", "NaN", "1", "$1,23", "$Infinity"])("rejects invalid cost %s", (cost) => {
    expect(() => parseCursorBench(cursorFixture([["Model", "80%", cost]]))).toThrow(/cost/);
  });

  it("rejects version drift, an unrelated first table, empty tables, missing cells and duplicate configs", () => {
    const fixture = cursorFixture();
    for (const html of [fixture.replace("CursorBench4.0", "CursorBench5.0"),
      fixture.replace("<h1>CursorBench4.0</h1>", ""),
      `<h1>CursorBench4.0</h1><table><tr><th>Unrelated</th></tr></table>${cursorTable()}`,
      cursorFixture([]), fixture.replace("<th>Score</th>", "<th>Old metric</th>"),
      fixture.replace("<td>99</td>", ""), cursorFixture([["Model High", "80%", "$1"], ["Model High", "90%", "$2"]])
    ]) expect(() => parseCursorBench(html)).toThrow(/CursorBench/);
  });
});

describe("Epoch SOFTWARE local refit", () => {
  it("uses the exact verified thirteen-name preset", () => {
    expect(SOFTWARE_BENCHMARKS).toEqual([
      "MirrorCode", "SWE-Bench verified", "Terminal Bench", "Aider polyglot", "Cybench", "WeirdML",
      "FrontierSWE", "GSO-Bench", "ExploitBench", "PostTrainBench", "FrontierCode", "DeepSWE", "Surface Evolver Bench"
    ]);
  });

  it.each([-70, -25, 0, 127.25, 250])("fits synthetic known capability %s on the raw signed scale", (capability) => {
    const points = [{ edi: capability - 10, slope: 0.025 }, { edi: capability + 20, slope: 0.045 }, { edi: capability + 2, slope: 0.1 }]
      .map(({ edi, slope }) => ({ edi, slope, performance: logistic(capability, edi, slope) }));
    expect(fitSoftwareCapability(points)).toBeCloseTo(capability, 6);
  });

  it("clamps performances and respects both capability bounds", () => {
    expect(fitSoftwareCapability([{ performance: 0, edi: -1000, slope: 0.01 }])).toBe(-100);
    expect(fitSoftwareCapability([{ performance: 1, edi: 1000, slope: 0.01 }])).toBe(300);
    expect(fitSoftwareCapability([{ performance: -10, edi: 0, slope: 0.1 }]))
      .toBeCloseTo(Math.log(0.001 / 0.999) / 0.1, 6);
    expect(fitSoftwareCapability([{ performance: 10, edi: 0, slope: 0.1 }]))
      .toBeCloseTo(Math.log(0.999 / 0.001) / 0.1, 6);
  });

  it("rejects empty/nonfinite observations and zero slopes", () => {
    for (const points of [[], [{ performance: NaN, edi: 1, slope: 0.1 }],
      [{ performance: 0.5, edi: Infinity, slope: 0.1 }], [{ performance: 0.5, edi: 1, slope: 0 }],
      [{ performance: 0.5, edi: 1, slope: NaN }]
    ]) expect(() => fitSoftwareCapability(points)).toThrow();
  });

  it("joins exact model keys, takes max per benchmark, requires two distinct matches and never uses general ECI", () => {
    const fixture = epochFixture();
    const rows = parseEpochSoftware(fixture.eci, fixture.processed, fixture.edi);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBeCloseTo(-25, 6);
    expect(rows[0]).toMatchObject({
      model: "Visible Model", benchmarkCount: 2, releaseDate: "2026-02-12",
      effort: "best reported per benchmark", costUsd: null, latencySeconds: null,
      harness: "Epoch software preset · local refit · 2 constituent benchmarks · 90% CI not computed"
    });
    expect(Number.isFinite(rows[0].score)).toBe(true);
    expect(rows[0]).not.toHaveProperty("evaluatedAt");
    expect(rows[0]).not.toHaveProperty("updatedAt");
    expect(rows[0]).not.toHaveProperty("confidenceInterval");
    expect(parseEpochSoftware(fixture.eci.replace(",250,", ",-999,"), fixture.processed, fixture.edi)).toEqual(rows);
    const reversed = fixture.processed.trim().split(/\r?\n/);
    expect(parseEpochSoftware(fixture.eci, [reversed[0], ...reversed.slice(1).reverse()].join("\n"), fixture.edi)).toEqual(rows);
  });

  it("preserves unknown release dates without inventing evaluated dates", () => {
    const fixture = epochFixture();
    const rows = parseEpochSoftware(fixture.eci.replace("2026-02-12", ""), fixture.processed, fixture.edi);
    expect(rows[0]).not.toHaveProperty("releaseDate");
    expect(rows[0]).not.toHaveProperty("evaluatedAt");
  });

  it("parses quoted CSV display names and BOM without hand-splitting CSV", () => {
    const fixture = epochFixture();
    const rows = parseEpochSoftware(`\uFEFF${fixture.eci.replace("Visible Model", '"Visible, Model"')}`, fixture.processed, fixture.edi);
    expect(rows[0].model).toBe("Visible, Model");
  });

  it("does not join case variants, display names or whitespace variants of model keys", () => {
    const fixture = epochFixture();
    const unmatched = fixture.processed.replace(/^exact-key,/gm, "exact-key ,");
    expect(() => parseEpochSoftware(fixture.eci, unmatched, fixture.edi)).toThrow(/at least 2/);
  });

  it("does not substitute similar benchmark spellings or nonsoftware benchmarks", () => {
    const fixture = epochFixture();
    const processed = fixture.processed.replace(/SWE-Bench verified/g, "SWE-bench Verified");
    expect(() => parseEpochSoftware(fixture.eci, processed, fixture.edi)).toThrow(/at least 2/);
  });

  it("rejects header drift, empty data, invalid selected numbers, duplicate difficulties and invalid release dates", () => {
    const fixture = epochFixture();
    for (const [eci, processed, edi] of [
      [fixture.eci.replace("Display name", "display_name"), fixture.processed, fixture.edi],
      [fixture.eci, fixture.processed.replace("performance,date", "score,date"), fixture.edi],
      [fixture.eci, fixture.processed, fixture.edi.replace("estimated_slope_scaled", "slope")],
      ["Model,Display name,eci,date\n", fixture.processed, fixture.edi],
      [fixture.eci, fixture.processed.replace("MirrorCode,0.01", "MirrorCode,NaN"), fixture.edi],
      [fixture.eci, fixture.processed, fixture.edi.replace("-10,0.025", "-10,0")],
      [fixture.eci, fixture.processed, `${fixture.edi}MirrorCode,0,0.1\n`],
      [fixture.eci.replace("2026-02-12", "2026-02-30"), fixture.processed, fixture.edi]
    ]) expect(() => parseEpochSoftware(eci, processed, edi)).toThrow(/Epoch/);
  });
});

describe("fixed-URL extra benchmark loaders", () => {
  it("loads FrontierCode from its fixed JSON URL", async () => {
    const fetchText = vi.fn(async () => JSON.stringify(frontierFixture()));
    expect((await loadExtraBenchmark("frontiercode", fetchText)).rows).toHaveLength(3);
    expect(fetchText.mock.calls).toEqual([["https://cognition.com/data/frontiercode-leaderboard/data.json"]]);
  });

  it("loads CursorBench only from SSR HTML, without fetching scripts", async () => {
    const fetchText = vi.fn(async () => cursorFixture());
    const result = await loadExtraBenchmark("cursorbench", fetchText);
    expect(result.rows).toHaveLength(3);
    expect(result).not.toHaveProperty("scoreKind");
    expect(fetchText.mock.calls).toEqual([["https://cursor.com/cursorbench"]]);
  });

  it.each(["epoch", "epoch-software"])("loads %s from exactly three official inputs and labels the index", async (id) => {
    const fixture = epochFixture();
    const urls = ["https://epoch.ai/data/eci_scores.csv", "https://epoch.ai/data/processed_data_for_eci.csv", "https://epoch.ai/data/edi_scores.csv"];
    const bodies = [fixture.eci, fixture.processed, fixture.edi];
    const fetchText = vi.fn(async (url: string) => bodies[urls.indexOf(url)]);
    const result = await loadExtraBenchmark(id, fetchText);
    expect(result.scoreKind).toBe("index");
    expect(result.rows[0].score).toBeCloseTo(-25, 6);
    expect(fetchText.mock.calls).toEqual(urls.map((url) => [url]));
    expect(result).not.toHaveProperty("updatedAt");
  });

  it.each(["https://localhost/private", "custom:frontiercode", "__proto__", "unknown"])("rejects arbitrary id %s before fetching", async (id) => {
    const fetchText = vi.fn();
    await expect(loadExtraBenchmark(id, fetchText)).rejects.toThrow(/Unknown extra benchmark/);
    expect(fetchText).not.toHaveBeenCalled();
  });

  it("propagates fetch and malformed payload failures", async () => {
    await expect(loadExtraBenchmark("cursorbench", async () => { throw new Error("HTTP 503"); })).rejects.toThrow("HTTP 503");
    await expect(loadExtraBenchmark("frontiercode", async () => "not JSON")).rejects.toThrow();
    await expect(loadExtraBenchmark("epoch", async () => "wrong,headers\n1,2\n")).rejects.toThrow(/CSV headers/);
  });
});
