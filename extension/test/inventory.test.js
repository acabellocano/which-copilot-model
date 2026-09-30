"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createInventory, serializeInventory, validateWorkbenchUrl, createWorkbenchUrl, MAX_WORKBENCH_URL_LENGTH } = require("../src/inventory");

const model = {
  id: "opaque/provider:model#1",
  name: "Example Model",
  vendor: "copilot",
  family: "example",
  version: "1",
  maxInputTokens: 128000
};
const metadata = { vscodeVersion: "1.95.0", scope: "copilot", exportedAt: "2026-09-30T12:00:00.000Z" };

test("canonical inventory preserves opaque IDs and includes only stable fields plus manual defaults", () => {
  const inventory = createInventory([{
    ...model,
    capabilities: "unsupported",
    apiKey: "must-not-export",
    username: "must-not-export",
    workspacePath: "must-not-export",
    sendRequest() { throw new Error("Never send prompts"); },
    countTokens() { throw new Error("Never count tokens"); }
  }], metadata);
  assert.deepEqual(inventory, {
    schemaVersion: 1,
    kind: "vscode-model-inventory",
    exportedAt: metadata.exportedAt,
    vscodeVersion: metadata.vscodeVersion,
    scope: "copilot",
    models: [{
      ...model,
      enabled: true,
      benchmarkAlias: "",
      inputCredits: null,
      outputCredits: null,
      cacheReadCredits: null,
      cacheWriteCredits: null,
      pricingSource: ""
    }]
  });
  assert.deepEqual(JSON.parse(serializeInventory(inventory)), inventory);
  assert.ok(serializeInventory(inventory).endsWith("\n"));
});

test("all-provider scope retains separate rows and fresh manual fields", () => {
  const inventory = createInventory([model, { ...model, id: "other-id", vendor: "other" }], { ...metadata, scope: "all" });
  assert.equal(inventory.scope, "all");
  assert.equal(inventory.models[1].vendor, "other");
  inventory.models[0].enabled = false;
  assert.equal(inventory.models[1].enabled, true);
  assert.equal(createInventory([model], metadata).models[0].enabled, true);
});

test("export time defaults to an ISO timestamp", () => {
  const inventory = createInventory([model], { vscodeVersion: "1.95.0", scope: "copilot" });
  assert.equal(new Date(inventory.exportedAt).toISOString(), inventory.exportedAt);
});

test("empty inventories, invalid scopes, and duplicate IDs are rejected rather than guessed", () => {
  assert.throws(() => createInventory([], metadata), /Sign in.*open Chat.*retry/);
  assert.throws(() => createInventory([model], { ...metadata, scope: "unknown" }), /vendor/);
  assert.throws(() => createInventory([model, model], metadata), /Duplicate model IDs/);
  assert.throws(() => createInventory([model, { ...model, vendor: "other" }], { ...metadata, scope: "all" }), /Duplicate model IDs/);
});

test("invalid stable metadata is rejected", () => {
  for (const key of ["id", "name", "vendor", "family", "version"]) {
    assert.throws(() => createInventory([{ ...model, [key]: undefined }], metadata), /invalid stable model metadata/);
  }
  for (const maxInputTokens of [-1, NaN, Infinity, 1.5, "128000"]) {
    assert.throws(() => createInventory([{ ...model, maxInputTokens }], metadata), /invalid stable model metadata/);
  }
  assert.throws(() => createInventory([{ ...model, id: "" }], metadata), /invalid stable model metadata/);
});

test("only the explicit loopback host forms bypass remote confirmation", () => {
  for (const value of ["http://localhost:3000", "http://127.0.0.1/path?view=models", "http://[::1]:3000", "https://LOCALHOST:444/workbench"]) {
    assert.equal(validateWorkbenchUrl(value).isLoopback, true, value);
  }
  for (const value of ["https://example.com/workbench?view=models", "https://localhost.example.com", "https://127.1", "https://[::2]"]) {
    assert.equal(validateWorkbenchUrl(value).isLoopback, false, value);
  }
});

test("unsafe, ambiguous, credential-bearing, and fragment-bearing URLs are rejected", () => {
  for (const value of [
    "http://example.com", "http://localhost.example.com", "http://127.0.0.2", "http://127.1", "http://2130706433", "http://[::2]",
    "javascript:alert(1)", "file:///tmp/workbench", "ftp://localhost", "//localhost:3000", "https:example.com",
    "https://user:password@example.com", "http://user@localhost", "https://@example.com",
    "http://localhost:3000#", "https://example.com/#inventory=old", "https://example.com/path#old",
    " https://example.com", "https://example.com/a b", "https://example.com\\@localhost", "http://localhost:99999", "", null
  ]) {
    assert.throws(() => validateWorkbenchUrl(value), /workbenchUrl/, String(value));
  }
});

test("workbench fragment round-trips JSON, preserves queries, and encodes special characters", () => {
  const inventory = createInventory([{ ...model, name: "Unicode · & # ? / % 😀" }], metadata);
  const link = createWorkbenchUrl("http://localhost:3000/workbench?view=models", inventory);
  const parsed = new URL(link);
  assert.equal(parsed.search, "?view=models");
  assert.ok(parsed.hash.startsWith("#inventory="));
  assert.deepEqual(JSON.parse(decodeURIComponent(parsed.hash.slice("#inventory=".length))), inventory);
});

test("URL size limit is applied to the encoded link, including the destination", () => {
  const inventory = createInventory([model], metadata);
  const link = createWorkbenchUrl("http://localhost:3000/", inventory);
  const padding = "a".repeat(MAX_WORKBENCH_URL_LENGTH - link.length);
  const exactLimit = createWorkbenchUrl(`http://localhost:3000/${padding}`, inventory);
  assert.equal(exactLimit.length, MAX_WORKBENCH_URL_LENGTH);
  assert.equal(createWorkbenchUrl(`http://localhost:3000/${padding}a`, inventory), null);
  assert.equal(createWorkbenchUrl("http://localhost:3000", createInventory([{ ...model, name: "😀".repeat(10000) }], metadata)), null);
});
