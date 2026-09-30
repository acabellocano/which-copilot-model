"use strict";

const vscode = require("vscode");
const { TextEncoder } = require("node:util");
const { createInventory, serializeInventory, validateWorkbenchUrl, createWorkbenchUrl, MAX_WORKBENCH_URL_LENGTH } = require("./inventory");

async function collectInventory() {
  const scope = vscode.workspace.getConfiguration("whichCopilotModel").get("vendor", "copilot");
  if (scope !== "copilot" && scope !== "all") {
    throw new Error("Set whichCopilotModel.vendor to copilot or all.");
  }
  if (typeof vscode.lm?.selectChatModels !== "function") {
    throw new Error("The stable model API is unavailable. Update VS Code (1.95 or newer) and GitHub Copilot Chat, or use the manual workbench workflow.");
  }
  const models = await vscode.lm.selectChatModels(scope === "all" ? {} : { vendor: "copilot" });
  if (!models.length) {
    await vscode.window.showWarningMessage("No API-visible models. Sign in to GitHub Copilot, open Chat, and retry. For other providers, set whichCopilotModel.vendor to all. Otherwise enter verified model names manually in the workbench. Nothing was saved, copied, or opened.");
    return null;
  }
  return createInventory(models, { vscodeVersion: vscode.version, scope });
}

async function copyInventory(inventory) {
  await vscode.env.clipboard.writeText(serializeInventory(inventory));
  await vscode.window.showInformationMessage(`Copied ${inventory.models.length} API-visible models. Pricing and benchmark aliases need manual review.`);
}

function activate(context) {
  const actions = {
    exportInventory: async () => {
      const inventory = await collectInventory();
      if (!inventory) return;
      const uri = await vscode.window.showSaveDialog({
        title: "Export API-visible model inventory",
        saveLabel: "Export Inventory",
        filters: { JSON: ["json"] }
      });
      if (!uri) return;
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(serializeInventory(inventory)));
      await vscode.window.showInformationMessage(`Exported ${inventory.models.length} API-visible models. This is not an exact Copilot picker inventory.`);
    },
    copyInventory: async () => {
      const inventory = await collectInventory();
      if (inventory) await copyInventory(inventory);
    },
    openWorkbench: async () => {
      const baseUrl = vscode.workspace.getConfiguration("whichCopilotModel").get("workbenchUrl", "http://localhost:3000");
      const { url, isLoopback } = validateWorkbenchUrl(baseUrl);
      if (!isLoopback) {
        const choice = await vscode.window.showWarningMessage(
          `Share model inventory with the remote workbench at ${url.origin}?`,
          {
            modal: true,
            detail: "The URL fragment includes model IDs, names, provider metadata, inventory scope, export time, and your VS Code version. Fragments are not sent in the initial HTTP request, but browser scripts at this destination can read and share this metadata. No prompts, credentials, account details, workspace paths, or source code are collected by this extension. Continue only if you trust the destination."
          },
          "Open workbench"
        );
        if (choice !== "Open workbench") return;
      }
      const inventory = await collectInventory();
      if (!inventory) return;
      const link = createWorkbenchUrl(baseUrl, inventory);
      if (!link) {
        const choice = await vscode.window.showWarningMessage(
          `The inventory URL exceeds ${MAX_WORKBENCH_URL_LENGTH.toLocaleString("en-US")} characters. Use Which Copilot Model: Copy Inventory or Export Inventory for a manual import.`,
          "Copy inventory"
        );
        if (choice === "Copy inventory") await copyInventory(inventory);
        return;
      }
      if (!await vscode.env.openExternal(vscode.Uri.parse(link, true))) {
        throw new Error("The browser did not open. Retry, or use Which Copilot Model: Copy Inventory or Export Inventory for a manual import.");
      }
    }
  };

  for (const [name, action] of Object.entries(actions)) {
    context.subscriptions.push(vscode.commands.registerCommand(`whichCopilotModel.${name}`, async () => {
      try {
        await action();
      } catch (error) {
        await vscode.window.showWarningMessage(`Model inventory command failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }
}

module.exports = { activate };
