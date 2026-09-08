import { AvailableModel } from "./models";

function valueAfter(line: string, label: string) {
  const match = line.match(new RegExp(`${label}\\s*:?\\s*(\\d+(?:\\.\\d+)?)`, "i"));
  return match ? Number(match[1]) : null;
}

export function parseModelTableText(text: string): AvailableModel[] {
  return text.split(/\r?\n/).map((raw, index) => {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || /^(name|context size|capabilities|cost|model)$/i.test(line)) return null;
    const context = line.match(/\b\d+(?:\.\d+)?[KMG]\b/i)?.[0] ?? "";
    const prefix = context ? line.slice(0, line.indexOf(context)) : line;
    const name = prefix.replace(/\b(Tools|Vision|In|Out|Cache|Read|Write)\b/gi, "").replace(/[|:]+$/, "").trim();
    const values = [valueAfter(line, "In"), valueAfter(line, "Out"), valueAfter(line, "Cache\\s*Read"), valueAfter(line, "Cache\\s*Write")];
    const numbers = [...line.matchAll(/\b\d+(?:\.\d+)?\b/g)].map((match) => Number(match[0]));
    const costs = values.every((value) => value === null) ? numbers.slice(context ? 1 : 0) : values;
    if (!name || name.length < 2 || (!context && !costs.some((value) => value !== null))) return null;
    return {
      id: `ocr-${Date.now()}-${index}`,
      name,
      contextSize: context,
      capabilities: "Tools, Vision",
      inputCost: costs[0] ?? null,
      outputCost: costs[1] ?? null,
      cacheReadCost: costs[2] ?? null,
      cacheWriteCost: costs[3] ?? null
    };
  }).filter((row): row is AvailableModel => row !== null);
}

export async function recognizeWithCloudOcr(file: File): Promise<{ models: AvailableModel[]; provider: string }> {
  const body = Buffer.from(await file.arrayBuffer()).toString("base64");
  if (process.env.GOOGLE_CLOUD_VISION_API_KEY) {
    const response = await fetch(`https://vision.googleapis.com/v1/images:annotate?key=${process.env.GOOGLE_CLOUD_VISION_API_KEY}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requests: [{ image: { content: body }, features: [{ type: "DOCUMENT_TEXT_DETECTION" }] }] })
    });
    if (!response.ok) throw new Error(`Google Vision returned HTTP ${response.status}`);
    const data = await response.json();
    return { models: parseModelTableText(data.responses?.[0]?.fullTextAnnotation?.text ?? ""), provider: "Google Cloud Vision" };
  }
  if (process.env.OCR_SPACE_API_KEY) {
    const form = new FormData();
    form.append("base64Image", `data:${file.type || "image/png"};base64,${body}`);
    form.append("language", "eng");
    form.append("isTable", "true");
    form.append("OCREngine", "2");
    const response = await fetch("https://api.ocr.space/parse/image", { method: "POST", headers: { apikey: process.env.OCR_SPACE_API_KEY }, body: form });
    if (!response.ok) throw new Error(`OCR.space returned HTTP ${response.status}`);
    const data = await response.json();
    return { models: parseModelTableText(data.ParsedResults?.map((result: { ParsedText?: string }) => result.ParsedText ?? "").join("\n") ?? ""), provider: "OCR.space" };
  }
  throw new Error("No cloud OCR provider configured");
}
