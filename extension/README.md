# Which Copilot Model · Inventory

A dependency-free, CommonJS VS Code companion that exports **stable API-visible model metadata**, not an exact copy of the Copilot model picker. Requires VS Code 1.95 or newer. It runs in the local UI extension host (`extensionKind: ["ui"]`), including when a workspace is remote.

## Commands

Run these from the Command Palette:

| Title | Command ID | Result |
| --- | --- | --- |
| Which Copilot Model: Export Inventory | `whichCopilotModel.exportInventory` | Choose a JSON destination with the save dialog. |
| Which Copilot Model: Copy Inventory | `whichCopilotModel.copyInventory` | Copy JSON to the clipboard. |
| Which Copilot Model: Open Workbench with Inventory | `whichCopilotModel.openWorkbench` | Open a browser URL with `#inventory=encodeURIComponent(JSON.stringify(inventory))`. |

Nothing is collected at activation or in the background. Each command awaits `vscode.lm.selectChatModels`. Empty results produce a warning without saving, copying, or opening an inventory. Sign in to GitHub Copilot, open Chat, and retry; alternatively enter verified model names manually in the workbench.

## Settings and consent

Both settings are application/user settings, not workspace settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `whichCopilotModel.vendor` | `copilot` | `copilot` selects `{ vendor: "copilot" }`; `all` selects `{}` for all API-visible providers. |
| `whichCopilotModel.workbenchUrl` | `http://localhost:3000` | Credential-free HTTPS, or HTTP on exactly `localhost`, `127.0.0.1`, or `[::1]`, optionally with a port. No existing fragment is allowed. |

Opening a non-loopback destination requires explicit confirmation every time, before collection and browser launch. The confirmation explains that the destination's browser scripts can read and share the inventory metadata. Cancelling does not launch the browser. A `false` result from VS Code's browser opener is reported as a warning.

Fragments are not included in the initial HTTP request, but **all scripts on the opened page can read them**, including scripts on a local workbench. Redirects, browser extensions, and browser history can also expose the URL; HTTPS and confirmation do not make an untrusted page safe. Only use a trusted workbench. The extension itself makes no fetch requests and sends no language-model prompts. It does not collect credentials, account details, usernames, workspace paths, or source code. Exported fields are limited to model metadata, VS Code version, scope, and export time.

The URL is capped at 50,000 characters **after encoding**, including the destination. Larger inventories are not opened: the warning offers to copy the already-collected snapshot or use the export command for manual import. Browser/platform limits may be lower. Fragment import requires a workbench that supports this inventory schema; the companion does not implement or modify the web importer.

## Inventory and public API limitations

JSON has `schemaVersion: 1`, `kind: "vscode-model-inventory"`, `exportedAt` (ISO timestamp), `vscodeVersion`, `scope`, and `models`.

Each model contains only the stable API fields `id`, `name`, `vendor`, `family`, `version`, and `maxInputTokens`, plus editable defaults: `enabled: true`, `benchmarkAlias: ""`, `inputCredits: null`, `outputCredits: null`, `cacheReadCredits: null`, `cacheWriteCredits: null`, and `pricingSource: ""`.

- IDs are opaque and retained verbatim. Duplicate IDs, including across vendors, stop the command rather than guessing a new identity. Retry with Copilot-only scope or use the manual workflow.
- API-visible models can differ from the picker because of provider exposure, sign-in, policy, permissions, or API coverage. An empty result is not proof that the picker is empty. This inventory is not an account entitlement or availability check.
- `enabled: true` is a manual workbench default, not a provider-confirmed status. `maxInputTokens` is the API's input-token limit, not a guarantee of the picker's full context/output limits.
- The stable API does not provide the pricing or capability metadata needed for this workflow. Pricing stays unknown; aliases need manual review. No proposed/private API, capability/pricing inference, model request, or token-counting call is used.

## Local development

No install or TypeScript build is needed. From the repository root:

```sh
npm --prefix extension run check
npm --prefix extension test
```

Use **Run Model Inventory Companion** in Run and Debug, or press **F5**, to launch an Extension Development Host. The launch configuration points to the extension directory with no prelaunch task. In that host, sign in/open Copilot Chat and run the commands. For workbench testing, start the existing web app separately using its existing development instructions.

Manual checks: export and copy a nonempty inventory; cancel a save dialog; retry when signed out/no models are API-visible; reject an HTTP non-loopback URL, credentials, or an existing fragment; cancel/accept a remote HTTPS confirmation; verify that an oversized inventory offers copy instead of browser launch. The automated Node tests cover canonical serialization, opaque/duplicate IDs, field allowlisting, scope, URL validation, fragment round-tripping, and the encoded size boundary.

## Packaging

From the repository root:

```sh
npm --prefix extension run package
```

The script downloads and invokes pinned `@vscode/vsce@3.9.2` using `npx --yes` in the extension directory. Packaging needs network access and Node.js 20+; development/tests do not download VSCE. No dependency is added to either package. The generated VSIX is placed in the extension directory. Use **Extensions: Install from VSIX…** to install it locally; no Marketplace publication is required.
