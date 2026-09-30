import { afterEach, describe, expect, it, vi } from "vitest";
import { BENCHMARK_SOURCES, parseBenchmarkImport, validateBenchmarkDataset, type BenchmarkDataset } from "./benchmarks";
import { fetchBenchmarkDataset } from "./benchmark-loaders";
import { GET } from "../app/api/benchmarks/route";

const canonical = (): BenchmarkDataset => ({
  id: "deepswe",
  name: "Imported benchmark",
  source: "https://example.com/results",
  fetchedAt: "2026-09-30T12:00:00Z",
  updatedAt: "2026-09-22",
  metric: "% solved",
  description: "A normalized test fixture, not production benchmark data.",
  rows: [{ id: "run-1", model: "Example model", score: 0.75, effort: "high", harness: "test harness", costUsd: null, latencySeconds: 0, evaluatedAt: "2026-09-22" }]
});

const deepFixture = {
  generated_at: "2026-09-22T06:27:15.860279+00:00",
  n_tasks_in_set: 113,
  rows: [{ model: "Example model", reasoning_effort: "high", pass_rate: 0.75, mean_cost_usd: 0, mean_output_tokens: 100, mean_agent_steps: 10, harness: "mini-swe-agent", config: "example-high" }]
};

function sweFixture(rows: unknown[]) {
  return `<script type='application/json' id='leaderboard-data'>${JSON.stringify([
    { name: "Lite", results: [{ agent: "mini-SWE-agent", model_display: "Wrong dataset", resolved: 100 }] },
    { name: "Verified", results: rows }
  ])}</script>`;
}

const miniFixture = {
  agent: "mini-SWE-agent",
  model_display: "Example model",
  name: "Example model (high)",
  reasoning_effort: "high",
  resolved: 76.8,
  instance_cost: 0.5,
  cost: 250,
  date: "2026-02-17",
  folder: "20260217_mini-v2_example-high",
  "mini-swe-agent_version": "2.0.0"
};

const aiderFixture = `
- dirname: example-high
  model: Example model (high)
  pass_rate_1: 40
  pass_rate_2: 80
  edit_format: diff
  total_cost: 45
  test_cases: 225
  seconds_per_case: 12.5
  versions: 0.85.1.dev
  date: 2025-06-27
- dirname: unreported-cost
  model: Other model
  pass_rate_2: 0
  edit_format: whole
  total_cost: 0
  test_cases: 225
  seconds_per_case: 0
- dirname: combination
  model: Example + Editor
  pass_rate_2: 95
  edit_format: architect
- dirname: unlabelled-architect
  model: Example model
  pass_rate_2: 90
  edit_format: architect
- dirname: parent-model
  model: Example model
  parent: Different editor model
  pass_rate_2: 90
- dirname: editor-command
  model: Example model
  command: aider --model example --editor-model different
  pass_rate_2: 90
`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("normalized benchmark imports", () => {
  it("preserves raw signed indices without fake percentages and validates optional metadata", () => {
    const data = canonical();
    const input = { ...data, scoreKind: "index", rows: [{ ...data.rows[0], score: -25.5, releaseDate: "2026-09-01", benchmarkCount: 3 }] };
    expect(parseBenchmarkImport(input)).toMatchObject({ scoreKind: "index", rows: [{ score: -25.5, releaseDate: "2026-09-01", benchmarkCount: 3 }] });
    for (const score of [NaN, Infinity, "150", null]) expect(() => validateBenchmarkDataset({ ...input, rows: [{ ...input.rows[0], score }] })).toThrow(/score/);
    for (const scoreKind of ["percent", null, "INDEX"]) expect(() => validateBenchmarkDataset({ ...input, scoreKind })).toThrow(/scoreKind/);
    for (const benchmarkCount of [0, -1, 1.5, "3"]) expect(() => validateBenchmarkDataset({ ...input, rows: [{ ...input.rows[0], benchmarkCount }] })).toThrow(/benchmarkCount/);
    expect(() => validateBenchmarkDataset({ ...input, rows: [{ ...input.rows[0], releaseDate: "2026-02-30" }] })).toThrow(/date/);
  });

  it("namespaces canonical custom IDs without mutating input or merging distinct IDs", () => {
    const data = canonical();
    expect(parseBenchmarkImport({ ...data, schemaVersion: 1 }).id).toBe("custom:deepswe");
    expect(parseBenchmarkImport({ ...data, id: "my-coding-run" }).id).toBe("custom:my-coding-run");
    expect(parseBenchmarkImport({ ...data, id: "custom:already-safe" }).id).toBe("custom:already-safe");
    for (const id of ["A/B", "A B", "A-B", "a/b", "a b", "CUSTOM:a-b"]) expect(() => parseBenchmarkImport({ ...data, id })).toThrow(/identifier/);
    expect(parseBenchmarkImport({ ...data, id: "a-b" }).id).toBe("custom:a-b");
    expect(data.id).toBe("deepswe");
    expect(validateBenchmarkDataset(data).id).toBe("deepswe");
  });

  it("preserves null versus zero, bounded score endpoints, and upstream dates", () => {
    const data = canonical();
    expect(parseBenchmarkImport(data).rows[0]).toMatchObject({ costUsd: null, latencySeconds: 0, evaluatedAt: "2026-09-22" });
    for (const score of [0, 1]) {
      expect(parseBenchmarkImport({ ...data, rows: [{ ...data.rows[0], score, costUsd: 0, latencySeconds: null }] }).rows[0])
        .toMatchObject({ score, costUsd: 0, latencySeconds: null });
    }
    expect(parseBenchmarkImport(data).updatedAt).toBe("2026-09-22");
  });

  it.each([2, "1", null, 0])("rejects unsupported schemaVersion %s", (schemaVersion) => {
    expect(() => parseBenchmarkImport({ ...canonical(), schemaVersion })).toThrow(/schemaVersion/);
  });

  it.each([-0.1, 1.1, NaN, Infinity, "0.5", null, undefined])("rejects invalid score %s without coercion", (score) => {
    const data = canonical();
    expect(() => parseBenchmarkImport({ ...data, rows: [{ ...data.rows[0], score }] })).toThrow(/score/);
  });

  it.each(["costUsd", "latencySeconds"])("rejects missing, nonfinite, negative, or coerced %s", (field) => {
    const data = canonical();
    for (const value of [-1, Infinity, NaN, "0", undefined]) {
      expect(() => parseBenchmarkImport({ ...data, rows: [{ ...data.rows[0], [field]: value }] })).toThrow(field);
    }
  });

  it.each(["http://example.com", "javascript:alert(1)", "/relative", "https:example.com", "https://user:secret@example.com"])("rejects noncanonical HTTPS source %s", (source) => {
    expect(() => parseBenchmarkImport({ ...canonical(), source })).toThrow(/HTTPS/);
  });

  it.each(["2025-02-29", "2026-02-30", "yesterday", "2026-09-22T12:00:00", "2026-09-22T25:00:00Z"])("rejects invalid dates %s", (invalid) => {
    const data = canonical();
    expect(() => parseBenchmarkImport({ ...data, fetchedAt: invalid })).toThrow(/date|timestamp/);
    expect(() => parseBenchmarkImport({ ...data, updatedAt: invalid })).toThrow(/date|timestamp/);
    expect(() => parseBenchmarkImport({ ...data, rows: [{ ...data.rows[0], evaluatedAt: invalid }] })).toThrow(/date|timestamp/);
  });

  it("accepts leap days and rejects empty metadata, model, harness, and duplicate row IDs", () => {
    const data = canonical();
    expect(parseBenchmarkImport({ ...data, updatedAt: "2024-02-29" }).updatedAt).toBe("2024-02-29");
    for (const field of ["id", "name", "metric", "description"]) {
      expect(() => parseBenchmarkImport({ ...data, [field]: " " })).toThrow(field);
    }
    for (const field of ["id", "model", "effort", "harness"]) {
      expect(() => parseBenchmarkImport({ ...data, rows: [{ ...data.rows[0], [field]: " " }] })).toThrow(field);
    }
    expect(() => parseBenchmarkImport({ ...data, id: "💻" })).toThrow(/identifier/);
    expect(() => parseBenchmarkImport({ ...data, rows: [data.rows[0], data.rows[0]] })).toThrow(/Duplicate/);
  });

  it("requires 1..20,000 real rows, with no sparse or prototype-backed arrays", () => {
    const data = canonical();
    for (const rows of [[], new Array(20_001), new Array(1), Array.prototype, Object.create(Array.prototype), { 0: data.rows[0], length: 1 }]) {
      expect(() => parseBenchmarkImport({ ...data, rows })).toThrow();
    }
    const inherited: unknown[] = new Array(1);
    Object.setPrototypeOf(inherited, [data.rows[0]]);
    expect(() => parseBenchmarkImport({ ...data, rows: inherited })).toThrow();
    const rows = Array.from({ length: 20_000 }, (_, index) => ({ ...data.rows[0], id: `row-${index}` }));
    expect(parseBenchmarkImport({ ...data, rows }).rows).toHaveLength(20_000);
  });

  it("does not trust inherited properties or invoke accessors", () => {
    const data = canonical();
    expect(() => parseBenchmarkImport(Object.create(data))).toThrow(/plain/);
    expect(() => parseBenchmarkImport({ ...data, rows: [Object.create(data.rows[0])] })).toThrow(/plain/);
    const getter = vi.fn(() => data.rows);
    expect(() => parseBenchmarkImport({ ...data, get rows() { return getter(); } })).toThrow(/plain/);
    expect(getter).not.toHaveBeenCalled();
    expect(() => parseBenchmarkImport({ ...data, rows: [null] })).toThrow(/plain/);
    const rows = [...data.rows];
    const mapGetter = vi.fn(() => { throw new Error("Untrusted array method"); });
    Object.defineProperty(rows, "map", { get: mapGetter });
    expect(parseBenchmarkImport({ ...data, rows }).rows).toHaveLength(1);
    expect(mapGetter).not.toHaveBeenCalled();
    const accessorRows: unknown[] = [];
    Object.defineProperty(accessorRows, "0", { get: getter });
    expect(() => parseBenchmarkImport({ ...data, rows: accessorRows })).toThrow(/accessor/);
    expect(getter).not.toHaveBeenCalled();
  });
});

describe("allowlisted benchmark loaders", () => {
  it("normalizes DeepSWE pass rates and config without substituting tokens for latency", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(deepFixture));
    vi.stubGlobal("fetch", fetchMock);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const dataset = await fetchBenchmarkDataset("deepswe");
    expect(dataset.id).toBe("deepswe");
    expect(dataset.updatedAt).toBe(deepFixture.generated_at);
    expect(dataset.rows[0]).toMatchObject({ score: 0.75, effort: "high", costUsd: 0, latencySeconds: null, harness: "mini-swe-agent · config: example-high" });
    expect(timeout).toHaveBeenCalledWith(15_000);
    expect(fetchMock).toHaveBeenCalledWith(BENCHMARK_SOURCES[0].url, expect.objectContaining({
      signal: expect.any(AbortSignal), redirect: "error", next: { revalidate: 3600 }
    }));
  });

  it("accepts pass_at_1 when pass_rate is absent and preserves unreported spend", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ rows: [{ model: "Example", pass_at_1: 0.5 }] })));
    const dataset = await fetchBenchmarkDataset("deepswe");
    expect(dataset.rows[0]).toMatchObject({ score: 0.5, costUsd: null, latencySeconds: null, effort: "unspecified" });
    expect(dataset.updatedAt).toBeUndefined();
  });

  it("filters SWE-bench to Verified mini-SWE-agent rows with explicit model evidence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(sweFixture([
      miniFixture,
      { ...miniFixture, agent: "Some arbitrary agent", model_display: "Wrong agent" },
      { ...miniFixture, model_display: undefined, name: "An agent submission, not a model" },
      { ...miniFixture, resolved: 110 },
      { ...miniFixture, model_display: "No reported cost", instance_cost: null },
      { ...miniFixture, model_display: "Zero reported cost", instance_cost: 0 }
    ]))));
    const dataset = await fetchBenchmarkDataset("swebench");
    expect(dataset.name).toBe("SWE-bench Verified · bash-only");
    expect(dataset.rows).toHaveLength(3);
    expect(dataset.rows[0]).toMatchObject({ model: "Example model", score: 0.768, costUsd: 0.5, latencySeconds: null, evaluatedAt: "2026-02-17" });
    expect(dataset.rows[0].harness).toContain("v2.0.0 · config: 20260217_mini-v2_example-high");
    expect(dataset.rows[1].costUsd).toBeNull();
    expect(dataset.rows[2].costUsd).toBe(0);
    expect(dataset.updatedAt).toBeUndefined();
  });

  it("uses YAML final-attempt Aider scores, per-task spend, and measured seconds only", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(aiderFixture)));
    const dataset = await fetchBenchmarkDataset("aider");
    expect(dataset.metric).toBe("% solved · up to 2 attempts");
    expect(dataset.rows).toHaveLength(2);
    expect(dataset.rows[0]).toMatchObject({ score: 0.8, effort: "high", costUsd: 0.2, latencySeconds: 12.5, evaluatedAt: "2025-06-27" });
    expect(dataset.rows[0].harness).toContain("edit: diff · config: example-high");
    expect(dataset.rows[1]).toMatchObject({ score: 0, costUsd: null, latencySeconds: 0 });
    expect(dataset.updatedAt).toBeUndefined();
  });

  it.each(["https://localhost/private", "custom:deepswe", "__proto__", "unknown"])("rejects non-allowlisted source %s before fetching", async (id) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchBenchmarkDataset(id)).rejects.toThrow(/Unknown/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["deepswe", JSON.stringify({ rows: [{ model: "Bad", pass_rate: 2 }] })],
    ["swebench", sweFixture([{ agent: "Other agent", model_display: "Example", resolved: 90 }])],
    ["aider", "- model: Example + Editor\n  pass_rate_2: 90\n"]
  ])("fails visibly for %s with no recognizable rows", async (id, body) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body)));
    await expect(fetchBenchmarkDataset(id)).rejects.toThrow(/recognizable/);
  });

  it("reports upstream HTTP and malformed embedded-data failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 })));
    await expect(fetchBenchmarkDataset("deepswe")).rejects.toThrow(/HTTP 503/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>changed layout</html>")));
    await expect(fetchBenchmarkDataset("swebench")).rejects.toThrow(/leaderboard-data/);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("- malformed: [yaml")));
    await expect(fetchBenchmarkDataset("aider")).rejects.toThrow();
  });
});

describe("benchmark API", () => {
  it("returns successful sources alongside independent failures", async () => {
    const called: string[] = [];
    const fixtures = new Map<string, string>([
      [BENCHMARK_SOURCES[0].url, JSON.stringify(deepFixture)],
      [BENCHMARK_SOURCES[2].url, aiderFixture]
    ]);
    const failedSources = BENCHMARK_SOURCES.filter((source) => !fixtures.has(source.url));
    const sourceIds = new Map<string, string>([
      ...failedSources.map((source): [string, string] => [source.url, source.id]),
      ["https://epoch.ai/data/eci_scores.csv", "epoch"],
      ["https://epoch.ai/data/processed_data_for_eci.csv", "epoch"],
      ["https://epoch.ai/data/edi_scores.csv", "epoch"]
    ]);
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      called.push(url);
      const fixture = fixtures.get(url);
      if (fixture !== undefined) return new Response(fixture);
      throw new Error(`${sourceIds.get(url) ?? url} temporarily offline`);
    }));
    const response = await GET(new Request("http://localhost/api/benchmarks"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(called).toHaveLength(8);
    expect(body.datasets.map((dataset: BenchmarkDataset) => dataset.id)).toEqual(["deepswe", "aider"]);
    expect(body.errors).toEqual(failedSources.map((source) => ({ id: source.id, message: `${source.id} temporarily offline` })));
    expect(Number.isFinite(Date.parse(body.fetchedAt))).toBe(true);
  });

  it("fetches only an explicitly selected allowlisted source", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(aiderFixture));
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(new Request("http://localhost/api/benchmarks?source=aider"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.datasets.map((dataset: BenchmarkDataset) => dataset.id)).toEqual(["aider"]);
    expect(body.errors).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(BENCHMARK_SOURCES[2].url);
  });

  it.each(["source=unknown", "source=", "source=https%3A%2F%2Flocalhost%2Fprivate", "source=aider&source=deepswe"])("returns 400 without fetching for %s", async (query) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await GET(new Request(`http://localhost/api/benchmarks?${query}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: `source must be one of: ${BENCHMARK_SOURCES.map((source) => source.id).join(", ")}` });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 502 with all source failures and no fabricated rows", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const response = await GET(new Request("http://localhost/api/benchmarks"));
    const body = await response.json();
    expect(response.status).toBe(502);
    expect(body.datasets).toEqual([]);
    expect(body.errors).toEqual(BENCHMARK_SOURCES.map((source) => ({ id: source.id, message: "offline" })));
  });
});