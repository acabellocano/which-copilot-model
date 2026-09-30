"use strict";

const MAX_WORKBENCH_URL_LENGTH = 50_000;
const URL_ERROR = "Set whichCopilotModel.workbenchUrl to credential-free HTTPS, or HTTP on localhost, 127.0.0.1, or [::1], without a fragment.";

function createInventory(models, { vscodeVersion, scope, exportedAt = new Date().toISOString() }) {
  if (scope !== "copilot" && scope !== "all") {
    throw new Error("Set whichCopilotModel.vendor to copilot or all.");
  }
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("No API-visible models. Sign in to GitHub Copilot, open Chat, and retry, or use the manual workbench workflow.");
  }

  const ids = new Set();
  return {
    schemaVersion: 1,
    kind: "vscode-model-inventory",
    exportedAt,
    vscodeVersion,
    scope,
    models: models.map((model) => {
      if (!model || ["id", "name", "vendor", "family", "version"].some((key) => typeof model[key] !== "string") || !model.id ||
          !model.name.trim() || !Number.isSafeInteger(model.maxInputTokens) || model.maxInputTokens <= 0) {
        throw new Error("A provider returned invalid stable model metadata. Retry, or use the manual workbench workflow.");
      }
      if (ids.has(model.id)) {
        throw new Error("Duplicate model IDs returned by the API. Export stopped to avoid ambiguous rows. Retry with scope copilot, or use the manual workbench workflow.");
      }
      ids.add(model.id);
      // ponytail: preserve opaque API IDs; reject collisions rather than inventing provider identities.
      return {
        id: model.id,
        name: model.name,
        vendor: model.vendor,
        family: model.family,
        version: model.version,
        maxInputTokens: model.maxInputTokens,
        enabled: true,
        benchmarkAlias: "",
        inputCredits: null,
        outputCredits: null,
        cacheReadCredits: null,
        cacheWriteCredits: null,
        pricingSource: ""
      };
    })
  };
}

function serializeInventory(inventory) {
  return `${JSON.stringify(inventory, null, 2)}\n`;
}

function validateWorkbenchUrl(value) {
  if (typeof value !== "string") throw new Error(URL_ERROR);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(URL_ERROR);
  }
  const authority = value.match(/^https?:\/\/([^/?#]*)/i)?.[1];
  const isLoopback = Boolean(authority && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(authority));
  if (!authority || /[\\#\s]/.test(value) || authority.includes("@") || url.username || url.password ||
      !(url.protocol === "https:" || (url.protocol === "http:" && isLoopback))) {
    throw new Error(URL_ERROR);
  }
  return { url, isLoopback };
}

function createWorkbenchUrl(baseUrl, inventory) {
  const { url } = validateWorkbenchUrl(baseUrl);
  const link = `${url.href}#inventory=${encodeURIComponent(JSON.stringify(inventory))}`;
  return link.length > MAX_WORKBENCH_URL_LENGTH ? null : link;
}

module.exports = { createInventory, serializeInventory, validateWorkbenchUrl, createWorkbenchUrl, MAX_WORKBENCH_URL_LENGTH };
