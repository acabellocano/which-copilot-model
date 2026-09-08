import { BenchmarkRow, parseNumber } from "./models";

const source = "https://deepswe.datacurve.ai/";

export function parseDeepSWEHtml(html: string): BenchmarkRow[] {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const rows: BenchmarkRow[] = [];
  const pattern = /([a-z0-9][a-z0-9 ._-]+?)\s*\[\s*([a-z]+)\s*\]\s+(\d{1,3})\s*%\s*(?:[±+−-]\s*\d+\s*%?)?\s*(?:Avg cost\s*)?\$?(\d+(?:\.\d+)?)\s*(?:Out tok\s*)?(\d+(?:\.\d+)?[kKmM]?)\s*(?:Steps\s*)?(\d+)/gi;
  for (const match of text.matchAll(pattern)) {
    const tokenText = match[5].toLowerCase();
    const multiplier = tokenText.endsWith("m") ? 1_000_000 : tokenText.endsWith("k") ? 1_000 : 1;
    rows.push({
      model: match[1].trim(),
      effort: match[2].toLowerCase(),
      passAt1: Number(match[3]) / 100,
      avgCost: Number(match[4]),
      outputTokens: Number(tokenText.replace(/[km]$/, "")) * multiplier,
      steps: Number(match[6])
    });
  }
  return rows;
}

export async function fetchDeepSWESnapshot(): Promise<{ source: string; fetchedAt: string; rows: BenchmarkRow[] }> {
  const response = await fetch(source, { headers: { "User-Agent": "which-copilot-model/0.1" }, next: { revalidate: 3600 } });
  if (!response.ok) throw new Error(`DeepSWE returned HTTP ${response.status}`);
  const rows = parseDeepSWEHtml(await response.text());
  if (!rows.length) throw new Error("DeepSWE page did not contain recognizable benchmark rows");
  return { source, fetchedAt: new Date().toISOString(), rows };
}
