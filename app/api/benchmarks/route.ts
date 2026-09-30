import { NextResponse } from "next/server";
import { BENCHMARK_SOURCES, fetchBenchmarkDataset, type BenchmarkDataset } from "../../../lib/benchmarks";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.getAll("source");
  if (requested.length > 1 || (requested.length === 1 && !BENCHMARK_SOURCES.some((source) => source.id === requested[0]))) {
    return NextResponse.json({ error: "source must be one of: deepswe, swebench, aider" }, { status: 400 });
  }
  const sources = requested.length ? BENCHMARK_SOURCES.filter((source) => source.id === requested[0]) : BENCHMARK_SOURCES;
  const results = await Promise.allSettled(sources.map((source) => fetchBenchmarkDataset(source.id)));
  const datasets: BenchmarkDataset[] = [];
  const errors: { id: string; message: string }[] = [];
  results.forEach((result, index) => {
    if (result.status === "fulfilled") datasets.push(result.value);
    else errors.push({
      id: sources[index].id,
      message: result.reason instanceof Error ? result.reason.message : "Unable to fetch benchmark data"
    });
  });
  return NextResponse.json({ datasets, errors, fetchedAt: new Date().toISOString() }, { status: datasets.length ? 200 : 502 });
}