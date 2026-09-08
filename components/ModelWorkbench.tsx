"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createWorker, PSM } from "tesseract.js";
import { AvailableModel, BenchmarkSnapshot, modelNamesMatch, rankModels, RankingObjective } from "@/lib/models";
import { parseModelTableText } from "@/lib/ocr";

const starterModels: AvailableModel[] = [];

type OcrWord = { text: string; confidence: number; bbox: { x0: number; y0: number; x1: number; y1: number } };

function numberAfter(words: string[], label: string) {
  const index = words.findIndex((word) => word.toLowerCase().replace(/[^a-z]/g, "").startsWith(label));
  const value = index >= 0 ? words[index + 1]?.replace(/[^\d.]/g, "") : "";
  return value ? Number(value) : null;
}

function parseOcrWords(words: OcrWord[], imageWidth: number): AvailableModel[] {
  const rows: OcrWord[][] = [];
  for (const word of words.filter((item) => item.text.trim() && item.confidence >= 20).sort((a, b) => a.bbox.y0 - b.bbox.y0)) {
    const row = rows.find((items) => Math.abs(items[0].bbox.y0 - word.bbox.y0) < 18);
    if (row) row.push(word); else rows.push([word]);
  }
  return rows.flatMap((row, index) => {
    const ordered = row.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const text = ordered.map((word) => word.text);
    const name = ordered.filter((word) => word.bbox.x0 < imageWidth * .27).map((word) => word.text).join(" ").trim();
    const context = ordered.find((word) => word.bbox.x0 >= imageWidth * .27 && word.bbox.x0 < imageWidth * .4 && /\d+[KMG]/i.test(word.text))?.text;
    if (!name || !context || /^(name|context|size|capabilities|cost)$/i.test(name)) return [];
    const labelled = (label: string) => numberAfter(text, label);
    const numeric = ordered.filter((word) => word.bbox.x0 >= imageWidth * .5 && /^\d+(?:\.\d+)?$/.test(word.text.replace(/,/g, ""))).map((word) => Number(word.text.replace(/,/g, "")));
    return [{ id: `${Date.now()}-${index}`, name, contextSize: context, capabilities: "Tools, Vision", inputCost: labelled("in") ?? numeric[0] ?? null, outputCost: labelled("out") ?? numeric[1] ?? null, cacheReadCost: labelled("cacheread") ?? numeric[2] ?? null, cacheWriteCost: labelled("cachewrite") ?? numeric[3] ?? null }];
  });
}

function parseOcrText(text: string): AvailableModel[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const values = [...line.matchAll(/(?:In|Out|Cache\s*Read|Cache\s*Write)\s*:?\s*(\d+(?:\.\d+)?)/gi)].map((match) => Number(match[1]));
    const context = line.match(/\b\d+[KMG]\b/i)?.[0];
    const name = line.split(/\b\d+[KMG]\b/i)[0]?.replace(/\b(Tools|Vision|In|Out|Cache|Read|Write)\b/gi, "").trim();
    if (!name || !context || values.length < 2 || /^(name|context|size|capabilities|cost)$/i.test(name)) return [];
    return [{ id: `${Date.now()}-text-${index}`, name, contextSize: context, capabilities: "Tools, Vision", inputCost: values[0] ?? null, outputCost: values[1] ?? null, cacheReadCost: values[2] ?? null, cacheWriteCost: values[3] ?? null }];
  });
}

function parseOcrRow(text: string, index: number): AvailableModel | null {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const contextMatch = cleaned.match(/\b\d+(?:\.\d+)?[KMG]\b/i);
  if (!contextMatch) return null;
  const beforeContext = cleaned.slice(0, contextMatch.index);
  const name = beforeContext.replace(/\b(Tools|Vision|Capabilities|Cost)\b/gi, "").trim();
  if (!name || /^(name|context|size)$/i.test(name)) return null;
  const values = [...cleaned.matchAll(/(?:In|Out|Cache\s*Read|Cache\s*Write|Read|Write)\s*:?\s*(\d+(?:\.\d+)?)/gi)].map((match) => Number(match[1]));
  const unlabeled = [...cleaned.matchAll(/(?:^|\s)(\d+(?:\.\d+)?)(?=\s|$)/g)].map((match) => Number(match[1]));
  const numbers = values.length >= 2 ? values : unlabeled.slice(-4);
  if (numbers.length < 2) return null;
  return {
    id: `${Date.now()}-row-${index}`,
    name,
    contextSize: contextMatch[0].toUpperCase(),
    capabilities: "Tools, Vision",
    inputCost: numbers[0] ?? null,
    outputCost: numbers[1] ?? null,
    cacheReadCost: numbers[2] ?? null,
    cacheWriteCost: numbers[3] ?? null
  };
}

async function recognizeRows(worker: Awaited<ReturnType<typeof createWorker>>, file: File): Promise<AvailableModel[]> {
  const image = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  const scale = 2;
  canvas.width = image.width * scale;
  const sourceHeight = image.height;
  const header = Math.round(sourceHeight * .075);
  const rowHeight = (sourceHeight - header) / 13;
  const context = canvas.getContext("2d");
  if (!context) return [];
  await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
  const rows: AvailableModel[] = [];
  for (let index = 0; index < 13; index += 1) {
    const y = header + index * rowHeight;
    const readColumn = async (left: number, right: number) => {
      canvas.width = Math.max(1, Math.round((right - left) * image.width * scale));
      canvas.height = Math.max(1, Math.round(rowHeight * scale));
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, left * image.width, y, (right - left) * image.width, rowHeight, 0, 0, canvas.width, canvas.height);
      return (await worker.recognize(canvas)).data.text.replace(/\s+/g, " ").trim();
    };
    const name = await readColumn(0, .27);
    const contextSize = await readColumn(.27, .4);
    const costs = await readColumn(.5, 1);
    const row = parseOcrRow(`${name} ${contextSize} ${costs}`, index);
    if (row) rows.push(row);
  }
  return rows;
}

async function preprocessImage(file: File) {
  const image = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = image.width * 2;
  canvas.height = image.height * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Unable to prepare screenshot for OCR");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 0; index < pixels.data.length; index += 4) {
    const luminance = pixels.data[index] * .299 + pixels.data[index + 1] * .587 + pixels.data[index + 2] * .114;
    const value = Math.max(0, Math.min(255, (255 - luminance) * 1.35));
    pixels.data[index] = pixels.data[index + 1] = pixels.data[index + 2] = value;
  }
  context.putImageData(pixels, 0, 0);
  return { source: await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Unable to prepare screenshot")), "image/png")), width: canvas.width };
}

export default function ModelWorkbench() {
  const [models, setModels] = useState<AvailableModel[]>(() => {
    if (typeof window === "undefined") return starterModels;
    try { return JSON.parse(window.localStorage.getItem("ocr-models") ?? "[]"); } catch { return []; }
  });
  const [snapshot, setSnapshot] = useState<BenchmarkSnapshot | null>(null);
  const [objective, setObjective] = useState<RankingObjective>("efficiency");
  const [minimumPassAt1, setMinimumPassAt1] = useState(0.5);
  const [customWeights, setCustomWeights] = useState<[number, number, number]>([34, 33, 33]);
  const [status, setStatus] = useState("Upload a VS Code model-selector screenshot to begin.");
  const [loading, setLoading] = useState(false);
  const [ocrError, setOcrError] = useState("");
  const [benchmarkFilter, setBenchmarkFilter] = useState<"available" | "all">("available");
  const [benchmarkPage, setBenchmarkPage] = useState(1);
  const [showAllRecommendations, setShowAllRecommendations] = useState(false);
  const ranked = useMemo(() => snapshot ? rankModels(models, snapshot.rows, objective, minimumPassAt1, customWeights) : [], [models, snapshot, objective, minimumPassAt1, customWeights]);
  const unmatched = useMemo(() => models.filter((model) => !snapshot?.rows.some((row) => modelNamesMatch(row.model, model.name))), [models, snapshot]);
  const stale = snapshot?.generatedAt ? Date.now() - Date.parse(snapshot.generatedAt) > 7 * 24 * 60 * 60 * 1000 : false;
  const benchmarkRows = useMemo(() => snapshot ? (benchmarkFilter === "all" ? snapshot.rows : snapshot.rows.filter((row) => models.some((model) => modelNamesMatch(row.model, model.name)))) : [], [snapshot, benchmarkFilter, models]);
  const benchmarkPageSize = 15;
  const benchmarkPageCount = Math.max(1, Math.ceil(benchmarkRows.length / benchmarkPageSize));
  const visibleBenchmarkRows = benchmarkRows.slice((benchmarkPage - 1) * benchmarkPageSize, benchmarkPage * benchmarkPageSize);
  const importInput = useRef<HTMLInputElement>(null);
  const [pasted, setPasted] = useState("");
  const date = (value: string) => new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  useEffect(() => { localStorage.setItem("ocr-models", JSON.stringify(models)); }, [models]);
  useEffect(() => { setBenchmarkPage(1); }, [benchmarkFilter, snapshot, models.length]);

  function saveModels() {
    localStorage.setItem("ocr-models", JSON.stringify(models));
    const blob = new Blob([JSON.stringify(models, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = "which-copilot-models.json"; link.click(); URL.revokeObjectURL(link.href);
    setStatus(`Saved ${models.length} OCR rows locally and to a JSON file.`);
  }

  function importModels(value: string) {
    try {
      const data = JSON.parse(value);
      const rows = Array.isArray(data) ? data : data.models;
      if (!Array.isArray(rows)) throw new Error("Expected a model array");
      setModels(rows.map((row, index) => ({ ...row, id: row.id || `import-${Date.now()}-${index}` })));
      setStatus(`Imported ${rows.length} saved model rows.`);
    } catch (error) { setStatus(error instanceof Error ? error.message : "Unable to import saved model data."); }
  }

  function importPasted() {
    const rows = parseModelTableText(pasted);
    if (!rows.length) { setStatus("No model rows found in pasted text."); return; }
    setModels(rows); setStatus(`Imported ${rows.length} model rows from pasted text.`);
  }

  async function handleImage(file?: File) {
    if (!file) return;
    setLoading(true); setOcrError(""); setStatus("Sending the screenshot to the high-accuracy OCR provider...");
    try {
      const form = new FormData();
      form.append("image", file);
      const response = await fetch("/api/ocr", { method: "POST", body: form });
      const cloud = await response.json();
      if (response.ok && cloud.models?.length) {
        setModels(cloud.models);
        setStatus(`${cloud.provider} extracted ${cloud.models.length} rows. Missing cells are highlighted for review.`);
        setLoading(false);
        return;
      }
      if (!response.ok || cloud.error) throw new Error(cloud.error || `Cloud OCR returned no model rows (HTTP ${response.status})`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown cloud OCR error";
      setOcrError(message);
      setStatus(`Cloud OCR failed: ${message}. Using local OCR fallback...`);
    }
    const worker = await createWorker("eng");
    try {
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: "1" });
      const prepared = await preprocessImage(file);
      const [originalResult, preparedResult] = await Promise.all([worker.recognize(file), worker.recognize(prepared.source)]);
      const originalExtracted = parseOcrWords(originalResult.data.words as OcrWord[], prepared.width / 2);
      const preparedExtracted = parseOcrWords(preparedResult.data.words as OcrWord[], prepared.width);
      const wordExtracted = originalExtracted.length >= preparedExtracted.length ? originalExtracted : preparedExtracted;
      const text = originalResult.data.text + "\n" + preparedResult.data.text;
      const rowExtracted = await recognizeRows(worker, file);
      const extracted = rowExtracted.length >= wordExtracted.length ? rowExtracted : (wordExtracted.length >= 3 ? wordExtracted : parseOcrText(text));
      if (!extracted.length) setStatus("OCR completed, but no model rows were recognized. Add rows manually below.");
      else { setModels(extracted); setStatus(`Extracted ${extracted.length} model rows. Review the table before fetching benchmarks.`); }
    } finally { await worker.terminate(); setLoading(false); }
  }

  async function loadBenchmark() {
    setLoading(true); setStatus("Fetching the latest DeepSWE snapshot...");
    try {
      const response = await fetch("/api/deepswe");
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSnapshot(data); localStorage.setItem("deepswe-snapshot", JSON.stringify(data));
      setStatus(`Loaded ${data.rows.length} benchmark rows.`);
    } catch (error) {
      const cached = localStorage.getItem("deepswe-snapshot");
      if (cached) { setSnapshot(JSON.parse(cached)); setStatus(`Live fetch failed; showing the cached snapshot. ${error instanceof Error ? error.message : ""}`); }
      else setStatus(error instanceof Error ? error.message : "Unable to fetch DeepSWE data.");
    } finally { setLoading(false); }
  }

  function updateModel(id: string, field: keyof AvailableModel, value: string) {
    setModels((current) => current.map((model) => model.id === id ? { ...model, [field]: ["inputCost", "outputCost", "cacheReadCost", "cacheWriteCost"].includes(field) ? (value ? Number(value) : null) : value } : model));
  }

  return <main className="shell">
    <div className="eyebrow">Model selection lab</div>
    <h1>Which Copilot model should you use?</h1>
    <p className="lede">Turn the model list in your VS Code instance into an evidence-based shortlist using the latest available DeepSWE coding benchmark.</p>
    <div className="grid">
      <section className="panel">
        <h2>1. Read your model selector</h2>
        <div className="dropzone">
          <strong>Drop a screenshot here or choose a file</strong>
          <input type="file" accept="image/*" disabled={loading} onChange={(event) => handleImage(event.target.files?.[0])} />
          <p className="hint">The app tries high-accuracy server OCR first, then falls back to local OCR.</p>
        </div>
        <div className="toolbar"><button className="button secondary" onClick={() => setModels([...models, { id: crypto.randomUUID(), name: "New model", contextSize: "1M", capabilities: "Tools, Vision", inputCost: null, outputCost: null, cacheReadCost: null, cacheWriteCost: null }])}>Add row</button><button className="button secondary" onClick={saveModels}>Save OCR results</button><button className="button secondary" onClick={() => importInput.current?.click()}>Import JSON</button><input ref={importInput} hidden type="file" accept=".json,application/json" onChange={async (event) => { const file = event.target.files?.[0]; if (file) importModels(await file.text()); event.target.value = ""; }} /></div>
        <details className="paste-import"><summary>Paste previously saved OCR text</summary><textarea value={pasted} onChange={(event) => setPasted(event.target.value)} placeholder="Paste an OCR.space table or rows such as: Claude Sonnet 5 | 1M | Tools Vision | In: 1000 | Out: 5000" /><button className="button secondary" onClick={importPasted}>Use pasted rows</button></details>
        {models.length === 0 ? <div className="empty">No models extracted yet.</div> : <div className="table-scroll"><table><thead><tr><th>Name</th><th>Context</th><th>In</th><th>Out</th><th>Cache read</th><th>Cache write</th><th /></tr></thead><tbody>{models.map((model) => <tr key={model.id}><td><input className={!model.name ? "missing" : ""} value={model.name} onChange={(event) => updateModel(model.id, "name", event.target.value)} /></td><td><input className={!model.contextSize ? "missing" : ""} value={model.contextSize} onChange={(event) => updateModel(model.id, "contextSize", event.target.value)} /></td><td><input className={model.inputCost === null ? "missing" : ""} type="number" value={model.inputCost ?? ""} onChange={(event) => updateModel(model.id, "inputCost", event.target.value)} /></td><td><input className={model.outputCost === null ? "missing" : ""} type="number" value={model.outputCost ?? ""} onChange={(event) => updateModel(model.id, "outputCost", event.target.value)} /></td><td><input className={model.cacheReadCost === null ? "missing" : ""} type="number" value={model.cacheReadCost ?? ""} onChange={(event) => updateModel(model.id, "cacheReadCost", event.target.value)} /></td><td><input className={model.cacheWriteCost === null ? "missing" : ""} type="number" value={model.cacheWriteCost ?? ""} onChange={(event) => updateModel(model.id, "cacheWriteCost", event.target.value)} /></td><td><button className="button secondary" onClick={() => setModels(models.filter((row) => row.id !== model.id))}>Remove</button></td></tr>)}</tbody></table></div>}
      </section>
      <section className="panel">
        <h2>2. Load DeepSWE</h2>
        <p className="hint">The server fetches and parses the all-effort-level benchmark page. A browser cache is used if the live source is unavailable.</p>
        <button className="button" disabled={loading} onClick={loadBenchmark}>{loading ? "Working..." : "Fetch latest results"}</button>
        <p className="status">{status}</p>
        {snapshot && <div className={`callout ${stale ? "warning" : ""}`}>
          <strong>{stale ? "Stale benchmark data" : "Benchmark data loaded"}</strong>
          <br />Source generated {snapshot.generatedAt ? date(snapshot.generatedAt) : "unknown"} · fetched {date(snapshot.fetchedAt)} · {snapshot.rows.length} configurations
          {snapshot.latestJob?.name && <><br />Latest job: {snapshot.latestJob.name}</>}
        </div>}
        {ocrError && <div className="callout error"><strong>Cloud OCR diagnostic</strong><br />{ocrError}<br /><span>Check the server environment key and provider quota, or continue with paste/import/local OCR.</span></div>}
        {snapshot && <div className="data-inspector"><div className="inspector-heading"><h3>DeepSWE results ({benchmarkRows.length} shown)</h3><div className="toolbar control"><label htmlFor="benchmark-filter">Show</label><select id="benchmark-filter" value={benchmarkFilter} onChange={(event) => setBenchmarkFilter(event.target.value as typeof benchmarkFilter)}><option value="available">Models available in Copilot</option><option value="all">All benchmark configurations</option></select></div></div><div className="table-scroll"><table><thead><tr><th>Model</th><th>Effort</th><th>PASS@1</th><th>Avg cost</th><th>Output tokens</th><th>Steps</th></tr></thead><tbody>{visibleBenchmarkRows.map((row) => <tr key={row.config ?? `${row.model}-${row.effort}`}><td>{row.model}</td><td>{row.effort || "—"}</td><td>{(row.passAt1 * 100).toFixed(1)}%</td><td>${row.avgCost.toFixed(2)}</td><td>{row.outputTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td><td>{row.steps.toFixed(1)}</td></tr>)}</tbody></table></div><div className="pagination"><span>Page {benchmarkPage} of {benchmarkPageCount}</span><button className="button secondary" disabled={benchmarkPage <= 1} onClick={() => setBenchmarkPage((page) => page - 1)}>Previous</button><button className="button secondary" disabled={benchmarkPage >= benchmarkPageCount} onClick={() => setBenchmarkPage((page) => page + 1)}>Next</button></div></div>}
        <div className="toolbar control"><label htmlFor="objective">Objective</label><select id="objective" value={objective} onChange={(event) => setObjective(event.target.value as typeof objective)}><option value="efficiency">Balanced: quality + cost + speed</option><option value="quality">Quality only</option><option value="cost">Cost only</option><option value="speed">Speed only</option><option value="quality-cost">Quality + cost</option><option value="quality-speed">Quality + speed</option><option value="cost-speed">Cost + speed</option><option value="custom">Custom weights</option></select><label htmlFor="minimum-pass">Minimum PASS@1</label><select id="minimum-pass" value={minimumPassAt1} onChange={(event) => setMinimumPassAt1(Number(event.target.value))}><option value="0.5">50%</option><option value="0.6">60%</option><option value="0.65">65%</option><option value="0.7">70%</option></select></div>
        {objective === "custom" && <div className="weights"><div className="triangle"><span className="triangle-quality">Quality {customWeights[0]}%</span><span className="triangle-cost">Cost {customWeights[1]}%</span><span className="triangle-speed">Speed {customWeights[2]}%</span></div>{[["Quality", 0], ["Cost", 1], ["Speed", 2]].map(([label, index]) => <label key={label as string}>{label as string}<input type="range" min="0" max="100" value={customWeights[index as number]} onChange={(event) => setCustomWeights((current) => { const selected = Number(event.target.value); const other = [0, 1, 2].filter((i) => i !== index); const remainder = 100 - selected; const total = current[other[0]] + current[other[1]]; const first = total ? Math.round(remainder * current[other[0]] / total) : Math.round(remainder / 2); const next: [number, number, number] = [...current]; next[index as number] = selected; next[other[0]] = first; next[other[1]] = remainder - first; return next; })} /></label>)}</div>}
      </section>
      <section className="panel panel-wide">
        <h2>3. Recommendations</h2>
        {!snapshot ? <div className="empty">Fetch benchmark results to see matched recommendations.</div> : ranked.length === 0 ? <div className="empty">No matched configurations meet the {Math.round(minimumPassAt1 * 100)}% PASS@1 threshold.</div> : <><div className="recommendation"><span>Best match for {objective === "efficiency" ? "balanced efficiency" : objective.replace("-", " + ")}</span><br /><strong>{ranked[0].model.name}</strong> · {ranked[0].row.model} [{ranked[0].row.effort}]<div className="chips"><span className="chip">PASS@1 {(ranked[0].row.passAt1 * 100).toFixed(0)}%</span><span className="chip">${ranked[0].row.avgCost.toFixed(2)} avg cost</span><span className="chip">{ranked[0].row.outputTokens.toLocaleString()} output tokens</span><span className="chip">{ranked[0].row.steps.toFixed(0)} steps</span><span className="chip">Score {(ranked[0].score * 100).toFixed(0)}%</span></div><p className="hint">Only configurations at or above {Math.round(minimumPassAt1 * 100)}% PASS@1 are scored. Quality uses PASS@1, cost uses average benchmark cost, and speed combines output tokens with agent steps.</p></div><div className="toolbar recommendation-controls"><strong>{showAllRecommendations ? "All eligible configurations" : "Top 10 picks"}</strong><button className="button secondary" onClick={() => setShowAllRecommendations((value) => !value)}>{showAllRecommendations ? "Show top 10" : `Show all ${ranked.length}`}</button></div><table><thead><tr><th>Available model</th><th>Benchmark effort</th><th>PASS@1</th><th>Avg cost</th><th>Tokens</th><th>Steps</th><th>Score</th></tr></thead><tbody>{(showAllRecommendations ? ranked : ranked.slice(0, 10)).map(({ model, row, score }) => <tr key={`${model.id}-${row.config ?? `${row.model}-${row.effort}`}`}><td>{model.name}</td><td>{row.effort}</td><td>{(row.passAt1 * 100).toFixed(0)}%</td><td>${row.avgCost.toFixed(2)}</td><td>{row.outputTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td><td>{row.steps.toFixed(0)}</td><td>{(score * 100).toFixed(0)}%</td></tr>)}</tbody></table>{unmatched.length > 0 && <p className="hint unmatched">Not matched to DeepSWE ({unmatched.length}): {unmatched.map((model) => model.name).join(", ")}</p>}{unmatched.length === 0 && models.length > 0 && <p className="hint matched">All {models.length} extracted models matched to at least one DeepSWE configuration.</p>}</>}
      </section>
    </div>
  </main>;
}
