"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { BENCHMARK_SOURCES, parseBenchmarkImport, validateBenchmarkDataset, type BenchmarkDataset } from "@/lib/benchmarks";
import { rankInventory, TASK_PROFILES, type DecisionObjective, type Evidence } from "@/lib/decisions";
import { emptyInventory, estimatedCredits, inventoryFromNames, manualModel, matchesModel, parseInventory, type InventoryModel, type ModelInventory } from "@/lib/inventory";

type Profile = keyof typeof TASK_PROFILES | "custom";
type Preferences = { profile: Profile; weights: Record<string, number>; objective: DecisionObjective; inputTokens: number; outputTokens: number; minimumCoverage: number };
const DEFAULTS: Preferences = { profile: "balanced", weights: { ...TASK_PROFILES.balanced.weights }, objective: "quality", inputTokens: 10_000, outputTokens: 2_000, minimumCoverage: 0 };
const MAX_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 15;
const message = (error: unknown) => error instanceof Error ? error.message : "Unexpected error; your previous data has been kept.";
const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const amount = (value: number | null) => value === null ? "Unknown" : value.toLocaleString("en", { maximumFractionDigits: 4 });
const date = (value?: string) => value ? new Date(value).toISOString().replace("T", " · ").replace(/\.\d+Z$/, " UTC") : "Unknown";
const stale = (dataset: BenchmarkDataset) => !!dataset.updatedAt && Date.now() - Date.parse(dataset.updatedAt) > 7 * 86_400_000;
const upsert = (previous: BenchmarkDataset[], incoming: BenchmarkDataset[]) => [...previous.filter((item) => !incoming.some((next) => next.id === item.id)), ...incoming];

function preferencesFrom(value: unknown): Preferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid saved preferences");
  const data = value as Record<string, unknown>;
  const result: Preferences = { ...DEFAULTS, weights: { ...DEFAULTS.weights } };
  if (data.profile === "custom" || (typeof data.profile === "string" && Object.hasOwn(TASK_PROFILES, data.profile))) result.profile = data.profile as Profile;
  if (result.profile !== "custom") result.weights = { ...TASK_PROFILES[result.profile].weights };
  if (data.objective === "quality" || data.objective === "value") result.objective = data.objective;
  if (data.minimumCoverage === 0 || data.minimumCoverage === 0.5 || data.minimumCoverage === 1) result.minimumCoverage = data.minimumCoverage;
  for (const key of ["inputTokens", "outputTokens"] as const) if (typeof data[key] === "number" && Number.isSafeInteger(data[key]) && data[key] >= 0 && data[key] <= 1_000_000_000) result[key] = data[key];
  if (data.weights && typeof data.weights === "object" && !Array.isArray(data.weights)) for (const [key, weight] of Object.entries(data.weights).slice(0, 500)) {
    if (key !== "__proto__" && key !== "constructor" && key !== "prototype" && key.length <= 256 && typeof weight === "number" && Number.isFinite(weight) && weight >= 0 && weight <= 100) result.weights[key] = weight;
  }
  if (result.profile !== "custom" && Object.entries(TASK_PROFILES[result.profile].weights).some(([id, weight]) => result.weights[id] !== weight)) result.profile = "custom";
  return result;
}

function parseText(text: string): unknown {
  if (new Blob([text]).size > MAX_BYTES) throw new Error("Import limit is 2 MB.");
  return JSON.parse(text);
}

function EvidenceTable({ evidence }: { evidence: Evidence[] }) {
  return <div className="table-scroll" tabIndex={0} aria-label="Recommendation evidence, scroll horizontally">
    <table><caption>Best observed configuration per source, not a Copilot run</caption>
      <thead><tr><th>Source / raw metric</th><th>Model</th><th>Effort / harness</th><th>Evaluated</th><th>API USD / task</th><th>Measured seconds</th></tr></thead>
      <tbody>{evidence.map(({ dataset, row }) => <tr key={dataset.id}><td>{dataset.name}<br /><strong>{percent(row.score)}</strong> {dataset.metric}</td><td>{row.model}</td><td>{row.effort}<br /><span className="muted">{row.harness}</span></td><td>{date(row.evaluatedAt)}</td><td>{row.costUsd === null ? "Unknown" : `$${amount(row.costUsd)}`}</td><td>{amount(row.latencySeconds)}</td></tr>)}</tbody>
    </table>
  </div>;
}

export default function ModelWorkbench() {
  const [inventory, setInventory] = useState<ModelInventory | null>(null);
  const [datasets, setDatasets] = useState<BenchmarkDataset[]>([]);
  const [preferences, setPreferences] = useState<Preferences>(DEFAULTS);
  const [hydrated, setHydrated] = useState(false);
  const [notice, setNotice] = useState({ text: "Your desk is empty. Import your inventory, then load evidence when you’re ready.", error: false });
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [inventoryText, setInventoryText] = useState("");
  const [namesText, setNamesText] = useState("");
  const [benchmarkText, setBenchmarkText] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [search, setSearch] = useState("");
  const [availableOnly, setAvailableOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState("index");
  const inventoryFile = useRef<HTMLInputElement>(null);
  const benchmarkFile = useRef<HTMLInputElement>(null);
  const inventoryPaste = useRef<HTMLDetailsElement>(null);
  const pasteArea = useRef<HTMLTextAreaElement>(null);
  const initialized = useRef(false);
  const storageWarned = useRef(false);
  const models = inventory?.models ?? [];
  const notify = (text: string, error = false) => setNotice({ text, error });

  useEffect(() => {
    // React Strict Mode replays mount effects; a consumed inventory fragment must not be lost.
    if (initialized.current) return;
    initialized.current = true;
    const warnings: string[] = [];
    const read = (key: string): unknown => { try { const text = localStorage.getItem(key); return text === null ? null : JSON.parse(text); } catch { warnings.push(`${key}: cache unavailable or corrupt`); return null; } };
    let restored: ModelInventory | null = null;
    const saved = read("model-inventory-v1");
    try { if (saved !== null) restored = parseInventory(saved); } catch { warnings.push("Saved inventory rejected; other valid caches are still restored."); }
    if (!restored) {
      const legacy = read("ocr-models");
      if (Array.isArray(legacy)) {
        const names = legacy.flatMap((row) => row && typeof row.name === "string" && row.name.trim() && row.name.length <= 2048 ? [{ name: row.name }] : []).slice(0, 500);
        try { if (names.length) { restored = parseInventory(names); warnings.push("Migrated legacy names only. All legacy prices were discarded."); } } catch { warnings.push("Legacy names could not be restored."); }
      }
    }
    const cached = read("coding-benchmarks-v1");
    const valid: BenchmarkDataset[] = [];
    if (Array.isArray(cached)) for (const item of cached.slice(0, 500)) {
      try { const dataset = validateBenchmarkDataset(item); const index = valid.findIndex((row) => row.id === dataset.id); if (index >= 0) valid[index] = dataset; else valid.push(dataset); } catch { warnings.push("A corrupt benchmark cache was skipped."); }
    } else if (cached !== null) warnings.push("Invalid benchmark cache skipped.");
    let restoredPreferences = preferencesFrom(DEFAULTS);
    const prefs = read("coding-preferences-v1");
    try { if (prefs !== null) restoredPreferences = preferencesFrom(prefs); } catch { warnings.push("Invalid preferences reset."); }
    for (const dataset of valid) if (!Object.hasOwn(restoredPreferences.weights, dataset.id)) restoredPreferences.weights = { ...restoredPreferences.weights, [dataset.id]: 33 };
    if (window.location.hash.startsWith("#inventory=")) {
      const fragment = window.location.hash.slice(11);
      try {
        // Remove metadata from browser history before decoding or trusting it.
        window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
        if (fragment.length > 100_000) throw new Error("Inventory link exceeds the 100k limit; use file import instead.");
        const decoded = decodeURIComponent(fragment);
        if (decoded.length > 100_000) throw new Error("Inventory link exceeds the 100k limit.");
        restored = parseInventory(JSON.parse(decoded));
        warnings.push("Imported API-visible inventory from the companion link; this does not identify your selected model.");
      } catch (error) { warnings.push(`Inventory link rejected: ${message(error)}`); }
    }
    setInventory(restored); setDatasets(valid); setPreferences(restoredPreferences); setHydrated(true);
    setNotice({ text: warnings.length ? [...new Set(warnings)].join(" ") : restored || valid.length ? "Restored valid local data. Nothing is fetched automatically." : "Ready for your first inventory. No sample models or results are loaded.", error: warnings.some((item) => /corrupt|rejected|unavailable|invalid|skipped|reset/i.test(item)) });
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      // Keep the last valid inventory while a name is temporarily blank during editing.
      let savedInventory: ModelInventory | null = null;
      try { if (inventory) savedInventory = parseInventory(inventory); } catch { /* In-progress edits are not a valid cache yet. */ }
      if (savedInventory) localStorage.setItem("model-inventory-v1", JSON.stringify(savedInventory));
      localStorage.setItem("coding-benchmarks-v1", JSON.stringify(datasets));
      localStorage.setItem("coding-preferences-v1", JSON.stringify(preferences));
    } catch { if (!storageWarned.current) { storageWarned.current = true; setNotice({ text: "Browser storage is unavailable or full. This desk still works in memory; export your inventory before leaving.", error: true }); } }
  }, [hydrated, inventory, datasets, preferences]);

  const benchmarkNames = useMemo(() => [...new Set(datasets.flatMap((dataset) => dataset.rows.map((row) => row.model)))].sort(), [datasets]);
  const matches = useMemo(() => new Map(models.map((model) => [model.id, benchmarkNames.filter((name) => matchesModel(model, name))])), [models, benchmarkNames]);
  const enabled = models.filter((model) => model.enabled);
  const covered = enabled.filter((model) => matches.get(model.id)?.length).length;
  const ranked = useMemo(() => rankInventory(models, datasets, preferences.weights, preferences.objective, preferences.inputTokens, preferences.outputTokens, preferences.minimumCoverage), [models, datasets, preferences]);
  const ordered = useMemo(() => [...ranked].sort((a, b) => sort === "name" ? a.model.name.localeCompare(b.model.name) : sort === "coverage" ? b.coverage - a.coverage : sort === "credits" ? (a.credits ?? Infinity) - (b.credits ?? Infinity) : b.index - a.index), [ranked, sort]);
  const selected = datasets.find((dataset) => dataset.id === sourceId) ?? datasets[0];
  const rows = useMemo(() => (selected?.rows ?? []).filter((row) => (!availableOnly || models.some((model) => model.enabled && matchesModel(model, row.model))) && `${row.model} ${row.effort} ${row.harness}`.toLowerCase().includes(search.toLowerCase())), [selected, availableOnly, models, search]);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages);
  useEffect(() => { setPage(1); }, [sourceId, search, availableOnly, inventory, datasets]);

  function importData(text: string, kind: "inventory" | "benchmark" | "names") {
    try {
      if (kind === "benchmark") {
        const dataset = parseBenchmarkImport(parseText(text));
        setDatasets((previous) => upsert(previous, [dataset])); setSourceId(dataset.id);
        setPreferences((previous) => ({ ...previous, profile: "custom", weights: { ...previous.weights, [dataset.id]: previous.weights[dataset.id] ?? 33 } }));
        notify(`Imported ${dataset.name}: ${dataset.rows.length} configurations. Custom source weight defaults to 33.`);
      } else {
        if (new Blob([text]).size > MAX_BYTES) throw new Error("Import limit is 2 MB.");
        const next = kind === "names" ? inventoryFromNames(text) : parseInventory(parseText(text));
        setInventory(next);
        notify(`Imported ${next.models.length} models · ${next.scope} scope${next.vscodeVersion ? ` · VS Code ${next.vscodeVersion}` : ""}. API-visible metadata is not the exact picker or your selected model.`);
      }
    } catch (error) { notify(`Import rejected. ${message(error)} Previous data kept.`, true); }
  }

  async function readFile(file: File | undefined, kind: "inventory" | "benchmark") {
    if (!file) return;
    try { if (file.size > MAX_BYTES) throw new Error("Import limit is 2 MB."); importData(await file.text(), kind); }
    catch (error) { notify(`File import rejected. ${message(error)} Previous data kept.`, true); }
  }

  async function refresh() {
    setRefreshing(true); notify("Refreshing three independent sources. Valid cached evidence stays available.");
    try {
      const response = await fetch("/api/benchmarks", { cache: "no-store", signal: AbortSignal.timeout(60_000) });
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !("datasets" in body) || !Array.isArray(body.datasets) || !("errors" in body) || !Array.isArray(body.errors)) throw new Error(`Invalid benchmark response (HTTP ${response.status}).`);
      const valid: BenchmarkDataset[] = [];
      const failures: Record<string, string> = {};
      for (const raw of body.datasets) {
        try { const dataset = validateBenchmarkDataset(raw); if (!BENCHMARK_SOURCES.some((source) => source.id === dataset.id)) throw new Error("Unexpected source ID"); valid.push(dataset); }
        catch (error) { const id = raw && typeof raw.id === "string" ? raw.id : "unknown"; failures[id] = message(error); }
      }
      for (const error of body.errors) if (error && typeof error.id === "string") failures[error.id] = typeof error.message === "string" ? error.message : "Refresh failed";
      for (const source of BENCHMARK_SOURCES) if (!valid.some((dataset) => dataset.id === source.id) && !failures[source.id]) failures[source.id] = "Source did not return validated data.";
      setDatasets((previous) => upsert(previous, valid)); setSourceErrors(failures);
      notify(`${valid.length} sources refreshed; ${Object.keys(failures).length} failed. Failed sources retain their last valid cache. Custom datasets are unchanged.`, Object.keys(failures).length > 0);
    } catch (error) { setSourceErrors(Object.fromEntries(BENCHMARK_SOURCES.map((source) => [source.id, message(error)]))); notify(`Refresh failed. ${message(error)} All last-valid datasets kept.`, true); }
    finally { setRefreshing(false); }
  }

  function edit(id: string, patch: Partial<InventoryModel>) { setInventory((previous) => previous ? { ...previous, models: previous.models.map((model) => model.id === id ? { ...model, ...patch } : model) } : previous); }
  function editNumber(id: string, field: "maxInputTokens" | "inputCredits" | "outputCredits" | "cacheReadCredits" | "cacheWriteCredits", value: string) {
    const number = value === "" ? null : Number(value);
    if (number !== null && (!Number.isFinite(number) || number < 0 || (field === "maxInputTokens" && (!Number.isSafeInteger(number) || number === 0)))) return;
    edit(id, { [field]: number });
  }
  function setWeight(id: string, weight: number) { setPreferences((previous) => ({ ...previous, profile: "custom", weights: { ...previous.weights, [id]: weight } })); }
  function setProfile(profile: Profile) {
    setPreferences((previous) => ({ ...previous, profile, weights: profile === "custom" ? previous.weights : { ...Object.fromEntries(datasets.filter((dataset) => dataset.id.startsWith("custom:")).map((dataset) => [dataset.id, previous.weights[dataset.id] ?? 20])), ...previous.weights, ...TASK_PROFILES[profile].weights } }));
  }
  function exportInventory() {
    try {
      const data = parseInventory({ ...(inventory ?? emptyInventory()), exportedAt: new Date().toISOString() });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "model-inventory.json";
      document.body.append(link);
      try { link.click(); notify("Exported inventory metadata and your manual edits. No prompts or credentials are included."); }
      finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000); }
    } catch (error) { notify(`Export rejected. ${message(error)}`, true); }
  }
  function openPaste() { if (inventoryPaste.current) inventoryPaste.current.open = true; pasteArea.current?.focus(); }
  const sourceCards = [...BENCHMARK_SOURCES.map((source) => ({ ...source, dataset: datasets.find((dataset) => dataset.id === source.id) })), ...datasets.filter((dataset) => !BENCHMARK_SOURCES.some((source) => source.id === dataset.id)).map((dataset) => ({ ...dataset, url: dataset.source, dataset }))];
  const knownFreshness = datasets.filter((dataset) => dataset.updatedAt).length;
  const unknownPrices = enabled.filter((model) => estimatedCredits(model, preferences.inputTokens, preferences.outputTokens) === null).length;

  return <main className="desk" aria-busy={!hydrated}>
    <header className="masthead"><a className="brand" href="#top"><span className="brand-mark" aria-hidden="true">↗</span>which copilot<span className="brand-dot">.</span><span className="brand-label">DECISION DESK</span></a><nav aria-label="Desk sections"><a href="#inventory">Inventory</a><a href="#sources">Evidence</a><a href="#ranking">Shortlist</a></nav><span className="local-badge">Local-first · no prompts sent</span></header>
    <section id="top" className="hero"><div><p className="eyebrow">YOUR MODELS. TRACEABLE EVIDENCE.</p><h1>Less guessing.<br /><span>Better coding choices.</span></h1><p className="lede">A decision desk for your Copilot model inventory. Bring the models you can see, weigh real coding benchmarks, and build a shortlist you can explain.</p>
      <div className="toolbar"><button className="button" disabled={!hydrated} onClick={() => inventoryFile.current?.click()}>Import inventory <span aria-hidden="true">↗</span></button><button className="button secondary" disabled={!hydrated} onClick={openPaste}>Paste inventory</button><a className="text-link" href="#sources">Explore evidence ↓</a></div><p className="hint">{inventory ? `Imported snapshot · ${inventory.scope} scope · not a live VS Code connection` : "Not connected to VS Code. Start with an exported JSON snapshot."}</p></div>
      <aside className="start-card"><span className="eyebrow">THE WORKFLOW</span><h2>{models.length ? "Your desk, your decision." : "An honest blank canvas."}</h2><ol className="steps"><li><span>01</span><div><strong>Bring your inventory</strong><p>Export API-visible model metadata from your VS Code instance.</p></div></li><li><span>02</span><div><strong>Load independent evidence</strong><p>Refresh three sources, or import a canonical dataset.</p></div></li><li><span>03</span><div><strong>Choose your trade-off</strong><p>Quality first, or value with your own credit rates.</p></div></li></ol></aside>
    </section>
    <div className="stats" aria-label="Desk summary"><div><span>Enabled inventory</span><strong>{enabled.length}<small> / {models.length}</small></strong></div><div><span>Covered models</span><strong>{covered}<small> with loaded evidence</small></strong></div><div><span>Evidence sources</span><strong>{datasets.length}<small> loaded</small></strong></div><div><span>Upstream freshness</span><strong>{datasets.filter(stale).length}<small> stale · {datasets.length - knownFreshness} unknown</small></strong></div></div>
    <div className={`notice ${notice.error ? "error" : ""}`} role={notice.error ? "alert" : "status"} aria-live={notice.error ? "assertive" : "polite"} aria-atomic="true"><span aria-hidden="true">{notice.error ? "!" : "↳"}</span>{notice.text}</div>

    <section id="inventory" className="panel"><div className="section-heading"><div><p className="eyebrow">01 / YOUR WORKSPACE SNAPSHOT</p><h2>Model inventory <span className="count">{models.length}</span></h2></div><div className="toolbar compact"><button className="button secondary" disabled={!hydrated || models.length >= 500} onClick={() => setInventory((previous) => ({ ...(previous ?? emptyInventory()), models: [...(previous?.models ?? []), manualModel("New model")] }))}>+ Add model</button><button className="button secondary" disabled={!inventory} onClick={exportInventory}>Export JSON</button><button className="button ghost danger" disabled={!models.length} onClick={() => { if (window.confirm("Clear your inventory? Export first if you want to keep your edits.")) { setInventory(emptyInventory()); notify("Inventory cleared. Evidence sources kept."); } }}>Clear</button></div></div>
      <input ref={inventoryFile} type="file" accept=".json,application/json" hidden aria-label="Import inventory JSON file" onChange={(event) => { void readFile(event.target.files?.[0], "inventory"); event.target.value = ""; }} />
      <details className="guide"><summary>How to get your real VS Code inventory</summary><div><p>In the intended VS Code instance, install the companion and run <strong>Which Copilot Model: Export Inventory</strong>, <strong>Which Copilot Model: Copy Inventory</strong>, or <strong>Which Copilot Model: Open Workbench with Inventory</strong> from the Command Palette.</p><p>Developing from this repository? Press <kbd>F5</kbd> with <strong>Run Model Inventory Companion</strong> selected. Commands then run in the Extension Development Host, not your original instance. Use the installed companion in your real intended instance for its inventory.</p><p>The companion exports or copies available API metadata; it sends no prompts. API visibility is not exact picker coverage, entitlement, or the currently selected model. Pricing and quota are not available from this API.</p></div></details>
      <details ref={inventoryPaste} className="paste-box"><summary>Paste inventory JSON or enter names manually</summary><div className="paste-grid"><div><label htmlFor="inventory-json">Versioned inventory JSON (replaces inventory)</label><textarea id="inventory-json" ref={pasteArea} value={inventoryText} maxLength={MAX_BYTES} onChange={(event) => setInventoryText(event.target.value)} placeholder="Paste the companion’s JSON export" /><button className="button secondary" disabled={!hydrated || !inventoryText.trim()} onClick={() => importData(inventoryText, "inventory")}>Import pasted JSON</button></div><div><label htmlFor="inventory-names">Fallback: one model name per line</label><textarea id="inventory-names" value={namesText} maxLength={MAX_BYTES} onChange={(event) => setNamesText(event.target.value)} placeholder="Enter only names you have verified" /><button className="button secondary" disabled={!hydrated || !namesText.trim()} onClick={() => importData(namesText, "names")}>Import names only</button><p className="hint">Replaces inventory; vendor is manual and prices stay unknown.</p></div></div></details>
      {inventory && <p className="metadata">Scope: {inventory.scope} · Exported: {date(inventory.exportedAt)} · VS Code: {inventory.vscodeVersion || "Unknown"} · Enable checkboxes are your shortlist choices, not provider-confirmed availability.</p>}
      <p className="hint">Manual rates are <strong>credits per 1M tokens, not USD</strong>. Blank means unknown, never zero. Type vendor “copilot” explicitly to use a model in value estimates. Alias replaces normalized name matching; it does not verify equivalent behavior.</p>
      {!models.length ? <div className="empty"><span aria-hidden="true">＋</span><h3>Your models belong here.</h3><p>Import a snapshot, paste JSON, or add a model manually. Nothing is invented for you.</p></div> : <div className="table-scroll" tabIndex={0} aria-label="Editable model inventory, scroll horizontally"><table className="inventory-table"><caption className="sr-only">Editable inventory and manual credit rates</caption><thead><tr><th>Use</th><th>Model / evidence match</th><th>Vendor / input limit</th><th>Benchmark alias</th><th>Input credits / 1M</th><th>Output credits / 1M</th><th>Details</th><th><span className="sr-only">Remove</span></th></tr></thead>
        <tbody>{models.map((model) => <tr key={model.id}><td><input type="checkbox" checked={model.enabled} aria-label={`Enable ${model.name}`} onChange={(event) => edit(model.id, { enabled: event.target.checked })} /></td><td><input aria-label={`Model name for ${model.name}`} maxLength={2048} value={model.name} onChange={(event) => edit(model.id, { name: event.target.value })} /><span className={`badge ${matches.get(model.id)?.length ? "mint" : "amber"}`}>{matches.get(model.id)?.length ? model.benchmarkAlias ? "Explicit alias · normalized match" : "Normalized name match" : model.benchmarkAlias ? "Alias not found" : "Missing coverage"}</span></td>
          <td><input aria-label={`Vendor for ${model.name}`} list="vendor-names" maxLength={2048} value={model.vendor} onChange={(event) => edit(model.id, { vendor: event.target.value })} /><input aria-label={`Maximum input tokens for ${model.name}`} type="number" min="1" step="1" value={model.maxInputTokens ?? ""} placeholder="Input tokens · unknown" onChange={(event) => editNumber(model.id, "maxInputTokens", event.target.value)} /></td>
          <td><input aria-label={`Explicit benchmark alias for ${model.name}`} list="benchmark-names" maxLength={2048} value={model.benchmarkAlias} placeholder="Optional exact row name" onChange={(event) => edit(model.id, { benchmarkAlias: event.target.value })} /></td>
          {(["inputCredits", "outputCredits"] as const).map((field) => <td key={field}><input aria-label={`${field === "inputCredits" ? "Input" : "Output"} credits per million tokens for ${model.name}`} type="number" min="0" step="any" value={model[field] ?? ""} placeholder="Unknown" onChange={(event) => editNumber(model.id, field, event.target.value)} /></td>)}
          <td><details className="row-details"><summary>Metadata + rates</summary><div><p>Version: {model.version || "Unknown"}<br />Family: {model.family || "Unknown"}</p><p className="hint">Matched rows: {matches.get(model.id)?.join(" · ") || "None. Check the name or choose an explicit alias; no fuzzy guessing."}</p>{(["cacheReadCredits", "cacheWriteCredits"] as const).map((field) => <label key={field}>{field === "cacheReadCredits" ? "Cache read" : "Cache write"} credits / 1M<input aria-label={`${field === "cacheReadCredits" ? "Cache read" : "Cache write"} credits per million tokens for ${model.name}`} type="number" min="0" step="any" value={model[field] ?? ""} placeholder="Unknown" onChange={(event) => editNumber(model.id, field, event.target.value)} /></label>)}<label>Pricing source / date / notes<input aria-label={`Pricing source and date notes for ${model.name}`} maxLength={2048} value={model.pricingSource} placeholder="Your manually verified source" onChange={(event) => edit(model.id, { pricingSource: event.target.value })} /></label></div></details></td>
          <td><button className="button ghost danger" aria-label={`Remove ${model.name}`} onClick={() => setInventory((previous) => previous ? { ...previous, models: previous.models.filter((row) => row.id !== model.id) } : previous)}>Remove</button></td></tr>)}</tbody></table></div>}
      <datalist id="vendor-names"><option value="copilot" /><option value="manual" /></datalist><datalist id="benchmark-names">{benchmarkNames.slice(0, 500).map((name) => <option key={name} value={name} />)}</datalist>
      {benchmarkNames.length > 500 && <p className="hint">Alias suggestions show the first 500 unique names. You can type any exact benchmark row name.</p>}
    </section>

    <section id="sources" className="panel"><div className="section-heading"><div><p className="eyebrow">02 / INDEPENDENT CODING EVIDENCE</p><h2>Keep the sources in view.</h2></div><div className="toolbar compact"><button className="button secondary" disabled={!hydrated} onClick={() => benchmarkFile.current?.click()}>Import benchmark JSON</button><button className="button" disabled={!hydrated || refreshing} onClick={() => void refresh()}>{refreshing ? "Refreshing…" : "Refresh sources ↻"}</button></div></div>
      <p className="hint">No automatic network fetch. A failed source keeps its cache; successful sources update independently. Upstream update time and fetch time are different. Submission dates do not establish source freshness.</p>
      <input ref={benchmarkFile} type="file" accept=".json,application/json" hidden aria-label="Import canonical benchmark JSON file" onChange={(event) => { void readFile(event.target.files?.[0], "benchmark"); event.target.value = ""; }} />
      <details className="paste-box"><summary>Paste a canonical benchmark dataset</summary><label htmlFor="benchmark-json">Canonical JSON · scores must be 0–1 · 2 MB maximum</label><textarea id="benchmark-json" maxLength={MAX_BYTES} value={benchmarkText} onChange={(event) => setBenchmarkText(event.target.value)} placeholder="Paste a complete canonical dataset with real evidence rows" /><button className="button secondary" disabled={!hydrated || !benchmarkText.trim()} onClick={() => importData(benchmarkText, "benchmark")}>Import custom dataset</button><p className="hint">Imports are namespaced as custom sources, never overwrite built-ins, and start at weight 33.</p></details>
      <div className="source-grid">{sourceCards.map((source) => { const dataset = source.dataset; const weight = preferences.weights[source.id] ?? 33; const failure = Object.hasOwn(sourceErrors, source.id) ? sourceErrors[source.id] : ""; return <article className="source-card" key={source.id}>
        <div className="source-title"><h3><a href={source.url} target="_blank" rel="noreferrer">{source.name} <span aria-hidden="true">↗</span></a></h3><span className={`badge ${failure || (dataset && stale(dataset)) ? "amber" : dataset ? "mint" : ""}`}>{failure ? dataset ? "Cached, refresh failed" : "Refresh failed · no cache" : dataset ? stale(dataset) ? "Upstream stale >7d" : dataset.updatedAt ? "Upstream within 7d" : "Update unknown" : "Not loaded"}</span></div>
        <p>{source.description}</p><div className="source-metric"><strong>{dataset?.rows.length.toLocaleString("en") ?? "—"}</strong><span>configurations · {dataset?.metric ?? source.metric}</span></div>
        <dl className="source-dates"><div><dt>Upstream updated</dt><dd>{date(dataset?.updatedAt)}</dd></div><div><dt>Fetched</dt><dd>{date(dataset?.fetchedAt)}</dd></div></dl>
        {failure && <p className="source-error">{failure}{!dataset && " Excluded from the scoring denominator until valid evidence is loaded."}</p>}
        <div className="weight-heading"><label><input type="checkbox" aria-label={`Use ${source.name} in ranking`} checked={weight > 0} onChange={(event) => setWeight(source.id, event.target.checked ? 33 : 0)} /> Use source</label><output htmlFor={`weight-${source.id}`}>{weight} weight</output></div><input id={`weight-${source.id}`} aria-label={`${source.name} evidence weight`} type="range" min="0" max="100" step="1" value={weight} onChange={(event) => setWeight(source.id, Number(event.target.value))} />
        {source.id.startsWith("custom:") && <button className="button ghost danger" onClick={() => { setDatasets((previous) => previous.filter((item) => item.id !== source.id)); notify(`Removed custom source ${source.name}.`); }}>Remove custom source</button>}
      </article>; })}</div>
    </section>

    <section id="ranking" className="panel"><div className="section-heading"><div><p className="eyebrow">03 / A SHORTLIST, NOT A GUARANTEE</p><h2>Choose your next coding partner.</h2></div><span className="badge violet">{preferences.objective === "quality" ? "Quality index" : "Value index"}</span></div>
      <div className="decision-controls"><label>Task profile<select value={preferences.profile} onChange={(event) => setProfile(event.target.value as Profile)}>{Object.entries(TASK_PROFILES).map(([id, profile]) => <option key={id} value={id}>{profile.name}</option>)}<option value="custom">Custom weights</option></select></label><label>Objective<select value={preferences.objective} onChange={(event) => setPreferences((previous) => ({ ...previous, objective: event.target.value as DecisionObjective }))}><option value="quality">Quality · evidence only</option><option value="value">Value · quality / (1 + credits)</option></select></label><label>Required weighted coverage<select value={preferences.minimumCoverage} onChange={(event) => setPreferences((previous) => ({ ...previous, minimumCoverage: Number(event.target.value) }))}><option value="0">Any observed evidence</option><option value="0.5">At least 50%</option><option value="1">100% of active weight</option></select></label></div>
      <p className="profile-note">{preferences.profile === "custom" ? "Custom weights: you control each source; no preset is implied." : TASK_PROFILES[preferences.profile].description} Presets reset the three built-in weights; custom weights are preserved (20 if unset).</p>
      <div className="scenario"><div><strong>Uncached token scenario</strong><p className="hint">Default: 10,000 input + 2,000 output tokens. Estimates use explicit “copilot” vendor and both manual credit rates. BYOK and unknown prices are excluded from value; cache fields are not used. No quota or USD conversion is assumed.</p></div>{(["inputTokens", "outputTokens"] as const).map((field) => <label key={field}>{field === "inputTokens" ? "Input tokens" : "Output tokens"}<input type="number" min="0" max="1000000000" step="1" value={preferences[field]} onChange={(event) => { const value = Number(event.target.value); if (Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000) setPreferences((previous) => ({ ...previous, [field]: value })); }} /></label>)}</div>
      <div className="method-note"><strong>Relative index ≠ success probability.</strong> Raw benchmark percentages are never averaged. Each source uses a within-source percentile of best observed configurations, then your weights combine those indices. Missing evidence in a loaded, weighted source contributes zero—not a proven worst score. Failed sources without cache are excluded, changing the active denominator. Best observed effort / harness is an evidence ceiling, not a guarantee of equivalent Copilot behavior. No speed objective is fabricated.</div>
      {preferences.objective === "value" && <p className="hint">{unknownPrices} enabled models excluded from value because Copilot credit rates are unknown or vendor is not explicitly “copilot”.</p>}
      {!ranked.length ? <div className="empty"><span aria-hidden="true">◇</span><h3>{!models.length ? "Bring your models to the desk." : !datasets.length ? "Your next step: load evidence." : "No eligible matches yet."}</h3><p>{!datasets.length ? "Refresh sources or import a real canonical dataset. Your shortlist will appear here." : "Check enabled models, aliases, nonzero source weights, required coverage, and credit rates for value."}</p></div> : <>
        <div className="rank-grid">{ranked.slice(0, 3).map((item, index) => <article className={`rank-card ${index === 0 ? "best" : ""}`} key={item.model.id}><div className="rank-top"><span>0{index + 1} / {index === 0 ? "LEADING OBSERVED MATCH" : "ALTERNATIVE"}</span><span aria-hidden="true">↗</span></div><h3>{item.model.name}</h3><div className="index-value">{(item.index * 100).toFixed(1)}<small> / 100 index</small></div><div className="rank-meta"><span>{percent(item.coverage)} weighted coverage</span><span>{item.credits === null ? "Credits unknown" : `${amount(item.credits)} estimated credits`}</span></div><details><summary>Inspect raw evidence ({item.evidence.length})</summary><EvidenceTable evidence={item.evidence} /></details></article>)}</div>
        <details className="ranking-table"><summary>All eligible models ({ranked.length})</summary><label className="sort-control">Sort by<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="index">Index · high to low</option><option value="coverage">Coverage · high to low</option><option value="credits">Estimated credits · low to high</option><option value="name">Model · A–Z</option></select></label><div className="table-scroll" tabIndex={0} aria-label="All ranked models, scroll horizontally"><table><caption className="sr-only">All eligible ranked inventory models</caption><thead><tr><th>Model</th><th>Relative index / 100</th><th>Weighted coverage</th><th>Estimated credits</th><th>Raw evidence</th></tr></thead><tbody>{ordered.map((item) => <tr key={item.model.id}><td>{item.model.name}</td><td>{(item.index * 100).toFixed(1)}</td><td>{percent(item.coverage)}</td><td>{amount(item.credits)}</td><td><details><summary>{item.evidence.length} sources</summary><EvidenceTable evidence={item.evidence} /></details></td></tr>)}</tbody></table></div></details>
      </>}
      {enabled.some((model) => !matches.get(model.id)?.length) && <div className="unmatched-note"><strong>Unmatched enabled models</strong><p>{enabled.filter((model) => !matches.get(model.id)?.length).map((model) => model.name || "Unnamed model").join(" · ")}</p><span>No guessed mapping. Inspect source names and enter an explicit alias if appropriate.</span></div>}
    </section>

    <section id="explorer" className="panel"><div className="section-heading"><div><p className="eyebrow">04 / SHOW THE WORK</p><h2>Raw evidence explorer</h2></div><span className="badge">15 rows per page</span></div><p className="hint">Raw scores belong to each source’s metric. API cost is benchmark USD per task, not a Copilot bill; seconds are only displayed when measured. Evaluated dates are submission dates, not source update dates.</p>
      {!datasets.length ? <div className="empty"><h3>Evidence, without the fiction.</h3><p>No datasets loaded. Refresh or import to inspect real configurations.</p></div> : <><div className="explorer-controls"><label>Source<select value={selected?.id ?? ""} onChange={(event) => setSourceId(event.target.value)}>{datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.name}</option>)}</select></label><label>Search model, effort or harness<input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Filter configurations…" /></label><label className="checkbox-label"><input type="checkbox" checked={availableOnly} onChange={(event) => setAvailableOnly(event.target.checked)} /> Enabled inventory matches only</label></div>
        <div className="table-scroll" tabIndex={0} aria-label="Raw benchmark evidence, scroll horizontally"><table><caption>{selected?.name} · {rows.length.toLocaleString("en")} matching configurations</caption><thead><tr><th>Benchmark model / inventory match</th><th>{selected?.metric} · raw</th><th>Effort</th><th>Harness</th><th>Evaluated</th><th>API USD / task</th><th>Measured seconds</th></tr></thead><tbody>{rows.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE).map((row) => <tr key={row.id}><td><strong>{row.model}</strong><br /><span className="muted">{enabled.filter((model) => matchesModel(model, row.model)).map((model) => `${model.name}${model.benchmarkAlias ? " (explicit alias)" : " (normalized name)"}`).join(" · ") || "No enabled inventory match"}</span></td><td>{percent(row.score)}</td><td>{row.effort}</td><td>{row.harness}</td><td>{date(row.evaluatedAt)}</td><td>{row.costUsd === null ? "Unknown" : `$${amount(row.costUsd)}`}</td><td>{amount(row.latencySeconds)}</td></tr>)}</tbody></table>{!rows.length && <p className="empty">No configurations match these filters.</p>}</div>
        <div className="pagination"><span>Page {currentPage} of {pages}</span><button className="button secondary" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>Previous</button><button className="button secondary" disabled={currentPage >= pages} onClick={() => setPage(currentPage + 1)}>Next</button></div>
      </>}
    </section>
    <footer className="desk-footer"><span className="brand">which copilot<span className="brand-dot">.</span></span><p>Available metadata. Observed evidence. Your judgment.</p><a href="#top">Back to top ↑</a></footer>
  </main>;
}
