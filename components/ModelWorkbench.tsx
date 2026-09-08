"use client";

import { useMemo, useState } from "react";
import { createWorker } from "tesseract.js";
import { AvailableModel, BenchmarkSnapshot, modelNamesMatch, rankModels } from "@/lib/models";

const starterModels: AvailableModel[] = [];

function parseOcr(text: string): AvailableModel[] {
  return text.split(/\r?\n/).flatMap((line, index) => {
    const match = line.match(/^(.*?)\s+(\d+[KMG])\s+.*?In:\s*([\d.]+).*?Out:\s*([\d.]+)/i);
    if (!match) return [];
    return [{ id: `${Date.now()}-${index}`, name: match[1].trim(), contextSize: match[2], capabilities: "Tools, Vision", inputCost: Number(match[3]), outputCost: Number(match[4]), cacheReadCost: null, cacheWriteCost: null }];
  });
}

export default function ModelWorkbench() {
  const [models, setModels] = useState(starterModels);
  const [snapshot, setSnapshot] = useState<BenchmarkSnapshot | null>(null);
  const [objective, setObjective] = useState<"quality" | "cost" | "speed" | "efficiency">("efficiency");
  const [status, setStatus] = useState("Upload a VS Code model-selector screenshot to begin.");
  const [loading, setLoading] = useState(false);
  const ranked = useMemo(() => snapshot ? rankModels(models, snapshot.rows, objective) : [], [models, snapshot, objective]);
  const unmatched = useMemo(() => models.filter((model) => !snapshot?.rows.some((row) => modelNamesMatch(row.model, model.name))), [models, snapshot]);

  async function handleImage(file?: File) {
    if (!file) return;
    setLoading(true); setStatus("OCR is reading the screenshot locally...");
    const worker = await createWorker("eng");
    try {
      const result = await worker.recognize(file);
      const extracted = parseOcr(result.data.text);
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
          <p className="hint">OCR runs in your browser. Nothing is uploaded for screenshot processing.</p>
        </div>
        <div className="toolbar"><button className="button secondary" onClick={() => setModels([...models, { id: crypto.randomUUID(), name: "New model", contextSize: "1M", capabilities: "Tools, Vision", inputCost: null, outputCost: null, cacheReadCost: null, cacheWriteCost: null }])}>Add row</button></div>
        {models.length === 0 ? <div className="empty">No models extracted yet.</div> : <table><thead><tr><th>Name</th><th>Context</th><th>In</th><th>Out</th><th /></tr></thead><tbody>{models.map((model) => <tr key={model.id}><td><input value={model.name} onChange={(event) => updateModel(model.id, "name", event.target.value)} /></td><td><input value={model.contextSize} onChange={(event) => updateModel(model.id, "contextSize", event.target.value)} /></td><td><input type="number" value={model.inputCost ?? ""} onChange={(event) => updateModel(model.id, "inputCost", event.target.value)} /></td><td><input type="number" value={model.outputCost ?? ""} onChange={(event) => updateModel(model.id, "outputCost", event.target.value)} /></td><td><button className="button secondary" onClick={() => setModels(models.filter((row) => row.id !== model.id))}>Remove</button></td></tr>)}</tbody></table>}
      </section>
      <section className="panel">
        <h2>2. Load DeepSWE</h2>
        <p className="hint">The server fetches and parses the all-effort-level benchmark page. A browser cache is used if the live source is unavailable.</p>
        <button className="button" disabled={loading} onClick={loadBenchmark}>{loading ? "Working..." : "Fetch latest results"}</button>
        <p className="status">{status}</p>
        {snapshot && <div className="callout">Source snapshot: {new Date(snapshot.fetchedAt).toLocaleString()} · {snapshot.rows.length} rows</div>}
        <div className="toolbar control"><label htmlFor="objective">Primary objective</label><select id="objective" value={objective} onChange={(event) => setObjective(event.target.value as typeof objective)}><option value="quality">Quality (PASS@1)</option><option value="cost">Lowest benchmark cost</option><option value="speed">Speed (tokens + steps)</option><option value="efficiency">Balanced efficiency</option></select></div>
      </section>
      <section className="panel panel-wide">
        <h2>3. Recommendations</h2>
        {!snapshot ? <div className="empty">Fetch benchmark results to see matched recommendations.</div> : ranked.length === 0 ? <div className="empty">No model names matched yet. Try editing OCR names to match the benchmark labels.</div> : <><div className="recommendation"><span>Best match for {objective}</span><br /><strong>{ranked[0].model.name}</strong> · {ranked[0].row.model} [{ranked[0].row.effort}]<div className="chips"><span className="chip">PASS@1 {(ranked[0].row.passAt1 * 100).toFixed(0)}%</span><span className="chip">${ranked[0].row.avgCost.toFixed(2)} avg cost</span><span className="chip">{ranked[0].row.outputTokens.toLocaleString()} output tokens</span><span className="chip">{ranked[0].row.steps} steps</span></div></div><table><thead><tr><th>Available model</th><th>Benchmark effort</th><th>PASS@1</th><th>Avg cost</th><th>Tokens</th><th>Steps</th><th>Score</th></tr></thead><tbody>{ranked.map(({ model, row, score }) => <tr key={`${model.id}-${row.effort}`}><td>{model.name}</td><td>{row.effort}</td><td>{(row.passAt1 * 100).toFixed(0)}%</td><td>${row.avgCost.toFixed(2)}</td><td>{row.outputTokens.toLocaleString()}</td><td>{row.steps}</td><td>{(score * 100).toFixed(0)}</td></tr>)}</tbody></table>{unmatched.length > 0 && <p className="hint">Not matched to DeepSWE: {unmatched.map((model) => model.name).join(", ")}</p>}</>}
      </section>
    </div>
  </main>;
}
