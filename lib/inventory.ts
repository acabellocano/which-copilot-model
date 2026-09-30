export type InventoryModel = {
  id: string;
  name: string;
  vendor: string;
  family: string;
  version: string;
  maxInputTokens: number | null;
  enabled: boolean;
  benchmarkAlias: string;
  inputCredits: number | null;
  outputCredits: number | null;
  cacheReadCredits: number | null;
  cacheWriteCredits: number | null;
  pricingSource: string;
};

export type ModelInventory = {
  schemaVersion: 1;
  kind: "vscode-model-inventory";
  exportedAt: string;
  vscodeVersion: string;
  scope: "copilot" | "all" | "manual";
  models: InventoryModel[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

function text(value: unknown, fallback = ""): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.length > 2_048) throw new Error("Model text must be a string of at most 2,048 characters");
  return value.trim();
}

function numeric(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${field} must be a nonnegative finite number or null`);
  return value;
}

export function emptyInventory(): ModelInventory {
  return { schemaVersion: 1, kind: "vscode-model-inventory", exportedAt: new Date().toISOString(), vscodeVersion: "", scope: "manual", models: [] };
}

export function manualModel(name = ""): InventoryModel {
  return { id: crypto.randomUUID(), name, vendor: "manual", family: "", version: "", maxInputTokens: null, enabled: true, benchmarkAlias: "", inputCredits: null, outputCredits: null, cacheReadCredits: null, cacheWriteCredits: null, pricingSource: "" };
}

/** Legacy OCR names can migrate; ambiguous legacy prices must not acquire credit units. */
export function parseInventory(data: unknown): ModelInventory {
  const legacy = Array.isArray(data);
  const input = legacy ? { models: data } : object(data);
  if (!legacy && input.schemaVersion !== 1) throw new Error("Unsupported inventory schemaVersion; expected 1");
  if (!legacy && input.kind !== "vscode-model-inventory") throw new Error("Expected a VS Code model inventory");
  if (!Array.isArray(input.models) || input.models.length > 500) throw new Error("Expected at most 500 models");
  const ids = new Set<string>();
  const models = input.models.map((value, index): InventoryModel => {
    const row = object(value);
    const id = text(row.id, `import-${index}`);
    const name = text(row.name);
    if (!id || !name) throw new Error(`Model ${index + 1} needs a nonempty id and name`);
    if (ids.has(id)) throw new Error(`Duplicate model id: ${id}`);
    ids.add(id);
    if (row.enabled !== undefined && typeof row.enabled !== "boolean") throw new Error("enabled must be a boolean");
    const maxInputTokens = numeric(row.maxInputTokens, "maxInputTokens");
    if (maxInputTokens !== null && (!Number.isSafeInteger(maxInputTokens) || maxInputTokens === 0)) throw new Error("maxInputTokens must be a positive integer or null");
    return {
      id, name, vendor: text(row.vendor, legacy ? "legacy import" : "unknown"),
      family: text(row.family), version: text(row.version), maxInputTokens,
      enabled: row.enabled !== false, benchmarkAlias: text(row.benchmarkAlias),
      inputCredits: legacy ? null : numeric(row.inputCredits, "inputCredits"),
      outputCredits: legacy ? null : numeric(row.outputCredits, "outputCredits"),
      cacheReadCredits: legacy ? null : numeric(row.cacheReadCredits, "cacheReadCredits"),
      cacheWriteCredits: legacy ? null : numeric(row.cacheWriteCredits, "cacheWriteCredits"),
      pricingSource: legacy ? "" : text(row.pricingSource)
    };
  });
  const scope = legacy ? "manual" : input.scope;
  if (scope !== "manual" && scope !== "copilot" && scope !== "all") throw new Error("Invalid inventory scope");
  const exportedAt = legacy ? new Date().toISOString() : text(input.exportedAt);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(exportedAt) || !Number.isFinite(Date.parse(exportedAt))) throw new Error("Invalid inventory export date");
  return { schemaVersion: 1, kind: "vscode-model-inventory", exportedAt, vscodeVersion: text(input.vscodeVersion), scope, models };
}

export function inventoryFromNames(value: string): ModelInventory {
  const names = [...new Set(value.split(/\r?\n/).map((name) => name.trim()).filter(Boolean))];
  if (!names.length || names.length > 500) throw new Error("Enter 1 to 500 model names, one per line");
  return parseInventory({ ...emptyInventory(), models: names.map((name) => manualModel(name)) });
}

export function canonicalModelName(value: string): string {
  let name = value.toLowerCase().trim()
    .replace(/^(?:openai|anthropic|google|gemini|copilot)\//, "")
    .replace(/\[(?:xhigh|high|medium|low|max|none|thinking)\]/g, "")
    .replace(/\((?:xhigh|high|medium|low|max|none|thinking|no thinking|reasoning[^)]*)\)/g, "")
    .replace(/\b(?:preview|latest)\b/g, "")
    .replace(/[- ]\d{4}[- ]?\d{2}[- ]?\d{2}$/, "")
    .replace(/(\d)[- ](?=\d)/g, "$1.");
  // Claude leaderboards use both "Claude 4.5 Sonnet" and "Claude Sonnet 4.5".
  name = name.replace(/claude[- ]+(\d+(?:\.\d+)*)(?:[- ]+)(sonnet|opus|haiku|fable)/, "claude $2 $1");
  return name.replace(/[^a-z0-9.]+/g, "");
}

export function matchesModel(model: InventoryModel, benchmarkName: string): boolean {
  // Auto is a router, not a stable checkpoint, even if API family/version names a backing model.
  if (model.name.trim().toLowerCase() === "auto") return false;
  const target = canonicalModelName(benchmarkName);
  // An explicit alias replaces automatic matching, rather than broadening it.
  return !!target && canonicalModelName(model.benchmarkAlias || model.name) === target;
}

export function estimatedCredits(model: InventoryModel, inputTokens: number, outputTokens: number): number | null {
  if (model.vendor !== "copilot" || model.inputCredits === null || model.outputCredits === null ||
    !Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || inputTokens < 0 || outputTokens < 0) return null;
  return (model.inputCredits * inputTokens + model.outputCredits * outputTokens) / 1_000_000;
}

export function modelMatchStatus(model: InventoryModel, benchmarkNames: readonly string[], loadedSources: number): string {
  if (model.name.trim().toLowerCase() === "auto") return "Auto is a routing policy, not one benchmarkable model. API family/version is not a guaranteed selected checkpoint.";
  if (!loadedSources) return "No evidence loaded. Refresh sources before diagnosing a name match.";
  const count = benchmarkNames.filter(name => matchesModel(model, name)).length;
  if (count) return `${count} benchmark names matched. Coverage is separate from whether the source is weighted in ranking.`;
  return model.benchmarkAlias
    ? `Explicit alias “${model.benchmarkAlias}” was not found in ${loadedSources} loaded sources. Clear or correct it; it replaces name matching.`
    : `No exact normalized identity in ${loadedSources} loaded sources. This does not mean the model is unavailable in Copilot. The sources may not evaluate this checkpoint or may use a different label; inspect raw names before assigning an alias.`;
}