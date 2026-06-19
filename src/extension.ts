import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { BridgeHttpServer } from "./bridgeHttpServer.js";

let bridge: BridgeHttpServer | undefined;
let updateStatusBarQuickAccessTooltip: (() => void) | undefined;

const mcpServerDefinitionProviderId = "vscode-lsp-mcp-bridge.provider";
const copyMcpConfigAction = "Copy MCP Config";
const enableWriteToolsAction = "Enable Write Tools";
const disableWriteToolsAction = "Disable Write Tools";

type ClientConfigId = "codex" | "vscode-copilot" | "claude-code" | "generic";

interface ClientConfigOption extends vscode.QuickPickItem {
  id: ClientConfigId;
}

interface ClientConfigFileOption extends vscode.QuickPickItem {
  snippetClientId: ClientConfigId;
  getPath: () => string | undefined;
  initialContent: string;
}

interface BridgeQuickAccessOption extends vscode.QuickPickItem {
  command: string;
}

const emptyMcpServersJson = JSON.stringify({ mcpServers: {} }, null, 2) + "\n";
const emptyVsCodeMcpJson = JSON.stringify({ servers: {} }, null, 2) + "\n";

const bridgeQuickAccessOptions: BridgeQuickAccessOption[] = [
  {
    label: "$(play) Start Server",
    description: "Start the local LSP MCP bridge server.",
    command: "vscode-lsp-mcp-bridge.start"
  },
  {
    label: "$(debug-stop) Stop Server",
    description: "Stop the local LSP MCP bridge server.",
    command: "vscode-lsp-mcp-bridge.stop"
  },
  {
    label: "$(info) Show Status",
    description: "Show LSP MCP bridge endpoint, version, and workspace details.",
    command: "vscode-lsp-mcp-bridge.showStatus"
  },
  {
    label: "$(workspace-trusted) Route Gateway To This Workspace",
    description: "Make this workspace the target for new LSP MCP external-client sessions.",
    command: "vscode-lsp-mcp-bridge.useWorkspace"
  },
  {
    label: "$(unlock) Enable Write Tools",
    description: "Enable LSP MCP Bridge write tools from the extension.",
    command: "vscode-lsp-mcp-bridge.enableWriteTools"
  },
  {
    label: "$(lock) Disable Write Tools",
    description: "Disable LSP MCP Bridge write tools from the extension.",
    command: "vscode-lsp-mcp-bridge.disableWriteTools"
  },
  {
    label: "$(copy) Copy MCP Client Config",
    description: "Copy a ready-to-use LSP MCP bridge config snippet for an MCP client.",
    command: "vscode-lsp-mcp-bridge.copyClientConfig"
  },
  {
    label: "$(go-to-file) Open MCP Client Config File",
    description: "Open a common LSP MCP client config file and copy the matching snippet.",
    command: "vscode-lsp-mcp-bridge.openClientConfig"
  }
];

const clientConfigOptions: ClientConfigOption[] = [
  {
    label: "Codex",
    id: "codex",
    detail: "TOML config for Codex MCP servers."
  },
  {
    label: "VS Code / GitHub Copilot",
    id: "vscode-copilot",
    detail: "Optional fallback JSON for VS Code user or workspace mcp.json."
  },
  {
    label: "Claude Code",
    id: "claude-code",
    detail: "CLI command using HTTP transport and Authorization header."
  },
  {
    label: "Generic HTTP MCP Client",
    id: "generic",
    detail: "JSON shape for MCP clients that support Streamable HTTP servers."
  }
];

const clientConfigFileOptions: ClientConfigFileOption[] = [
  {
    label: "Codex global config",
    detail: "~/.codex/config.toml",
    description: "Paste the copied LSP MCP TOML block into this file.",
    snippetClientId: "codex",
    getPath: () => homePath(".codex", "config.toml"),
    initialContent: ""
  },
  {
    label: "VS Code workspace MCP config",
    detail: "<workspace>/.vscode/mcp.json",
    description: "Optional workspace-level LSP MCP fallback config for VS Code and GitHub Copilot.",
    snippetClientId: "vscode-copilot",
    getPath: () => workspacePath(".vscode", "mcp.json"),
    initialContent: emptyVsCodeMcpJson
  },
  {
    label: "Claude Code project config",
    detail: "<workspace>/.mcp.json",
    description: "Shared project LSP MCP config. For local config, prefer the copied claude mcp add command.",
    snippetClientId: "generic",
    getPath: () => workspacePath(".mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Cursor user config",
    detail: "~/.cursor/mcp.json",
    description: "User-wide LSP MCP config for Cursor.",
    snippetClientId: "generic",
    getPath: () => homePath(".cursor", "mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Cursor workspace config",
    detail: "<workspace>/.cursor/mcp.json",
    description: "Workspace-level LSP MCP config for Cursor.",
    snippetClientId: "generic",
    getPath: () => workspacePath(".cursor", "mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Windsurf user config",
    detail: "~/.codeium/windsurf/mcp_config.json",
    description: "User-wide LSP MCP config for Windsurf/Cascade.",
    snippetClientId: "generic",
    getPath: () => homePath(".codeium", "windsurf", "mcp_config.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Cline user config",
    detail: "~/.cline/mcp.json",
    description: "CLI-style LSP MCP config for Cline. The VS Code extension also has its own MCP Servers view.",
    snippetClientId: "generic",
    getPath: () => homePath(".cline", "mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Roo Code workspace config",
    detail: "<workspace>/.roo/mcp.json",
    description: "Workspace-level LSP MCP config for Roo Code.",
    snippetClientId: "generic",
    getPath: () => workspacePath(".roo", "mcp.json"),
    initialContent: emptyMcpServersJson
  }
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  bridge = new BridgeHttpServer(context);
  registerMcpServerDefinitionProvider(context, bridge);
  registerStatusBarQuickAccess(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.openQuickAccess", async () => {
      const selected = await vscode.window.showQuickPick(bridgeQuickAccessOptions, {
        title: "LSP MCP Bridge",
        placeHolder: "Choose a bridge action"
      });
      if (!selected) {
        return;
      }

      await vscode.commands.executeCommand(selected.command);
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.start", async () => {
      await bridge?.start();
      refreshStatusBarQuickAccessTooltip();
      vscode.window.showInformationMessage("VS Code LSP MCP Bridge started.");
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.stop", async () => {
      await bridge?.stop();
      refreshStatusBarQuickAccessTooltip();
      vscode.window.showInformationMessage("VS Code LSP MCP Bridge stopped.");
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.showStatus", () => {
      vscode.window.showInformationMessage(bridge?.status ?? "VS Code LSP MCP Bridge is not initialized.", {
        modal: true
      });
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.useWorkspace", async () => {
      if (!bridge) {
        vscode.window.showWarningMessage("VS Code LSP MCP Bridge is not initialized.");
        return;
      }

      try {
        const message = await bridge.useThisWorkspace();
        refreshStatusBarQuickAccessTooltip();
        vscode.window.showInformationMessage(message);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showWarningMessage(`VS Code LSP MCP Bridge could not activate this workspace: ${message}`);
        refreshStatusBarQuickAccessTooltip();
      }
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.enableWriteTools", async () => {
      const choice = await vscode.window.showInformationMessage(
        "Enable LSP MCP Bridge write tools?",
        {
          modal: true,
          detail: "This updates the VS Code extension setting. Each write-capable tool call still requires a VS Code approval before edits are applied."
        },
        enableWriteToolsAction
      );
      if (choice !== enableWriteToolsAction) {
        return;
      }

      await updateWriteToolsForCurrentScope(true);
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.disableWriteTools", async () => {
      await updateWriteToolsForCurrentScope(false);
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.copyClientConfig", async () => {
      await bridge?.start();
      refreshStatusBarQuickAccessTooltip();
      if (!bridge) {
        vscode.window.showWarningMessage("VS Code LSP MCP Bridge is not initialized.");
        return;
      }

      const selected = await vscode.window.showQuickPick(clientConfigOptions, {
        title: "Copy MCP Client Config",
        placeHolder: "Choose the AI coding tool or MCP client you want to configure"
      });
      if (!selected) {
        return;
      }

      const snippet = bridge.getClientConfigSnippet(selected.id);
      const choice = await vscode.window.showInformationMessage(
        `Copy the ${selected.label} MCP config to the clipboard?`,
        { modal: true },
        copyMcpConfigAction
      );
      if (choice !== copyMcpConfigAction) {
        return;
      }

      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage(`${selected.label} MCP config copied to clipboard.`);
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.openClientConfig", async () => {
      await bridge?.start();
      refreshStatusBarQuickAccessTooltip();
      if (!bridge) {
        vscode.window.showWarningMessage("VS Code LSP MCP Bridge is not initialized.");
        return;
      }

      const selected = await vscode.window.showQuickPick(clientConfigFileOptions, {
        title: "Open MCP Client Config File",
        placeHolder: "Choose the config file you want to update"
      });
      if (!selected) {
        return;
      }

      const filePath = selected.getPath();
      if (!filePath) {
        vscode.window.showWarningMessage("Open a workspace before selecting a workspace-level MCP config file.");
        return;
      }

      const opened = await openOrCreateFile(filePath, selected.initialContent, selected.label);
      if (!opened) {
        return;
      }

      const snippet = bridge.getClientConfigSnippet(selected.snippetClientId);
      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage(`${selected.label} opened. MCP config snippet copied to clipboard.`);
    })
  );

  const autoStart = vscode.workspace
    .getConfiguration("vscodeLspMcpBridge")
    .get<boolean>("autoStart", true);

  if (autoStart) {
    try {
      await bridge.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showWarningMessage(`VS Code LSP MCP Bridge did not start: ${message}`);
    } finally {
      refreshStatusBarQuickAccessTooltip();
    }
  }
}

export async function deactivate(): Promise<void> {
  await bridge?.stop();
}

function registerMcpServerDefinitionProvider(
  context: vscode.ExtensionContext,
  bridgeServer: BridgeHttpServer
): void {
  const definitionsChanged = new vscode.EventEmitter<void>();

  context.subscriptions.push(
    definitionsChanged,
    vscode.workspace.onDidChangeConfiguration(event => {
      if (
        event.affectsConfiguration("vscodeLspMcpBridge.host") ||
        event.affectsConfiguration("vscodeLspMcpBridge.port")
      ) {
        definitionsChanged.fire();
      }
    }),
    vscode.lm.registerMcpServerDefinitionProvider(mcpServerDefinitionProviderId, {
      onDidChangeMcpServerDefinitions: definitionsChanged.event,
      provideMcpServerDefinitions: () => [bridgeServer.getVsCodeMcpServerDefinition()],
      resolveMcpServerDefinition: async server => {
        await bridgeServer.start();
        return bridgeServer.getVsCodeMcpServerDefinition();
      }
    })
  );
}

function registerStatusBarQuickAccess(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = "LSP MCP Bridge";
  item.text = "LSP MCP";
  item.command = "vscode-lsp-mcp-bridge.openQuickAccess";
  item.show();

  updateStatusBarQuickAccessTooltip = () => {
    item.tooltip = statusBarQuickAccessTooltip();
  };
  updateStatusBarQuickAccessTooltip();

  const refreshTimer = setInterval(refreshStatusBarQuickAccessTooltip, 15_000);

  context.subscriptions.push(
    item,
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("vscodeLspMcpBridge.enableWriteTools")) {
        refreshStatusBarQuickAccessTooltip();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshStatusBarQuickAccessTooltip();
    }),
    new vscode.Disposable(() => {
      clearInterval(refreshTimer);
      updateStatusBarQuickAccessTooltip = undefined;
    })
  );
}

async function updateWriteToolsForCurrentScope(enabled: boolean): Promise<void> {
  const hasWorkspace = Boolean(vscode.workspace.workspaceFolders?.length);
  const target = hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const scope = hasWorkspace ? "this workspace" : "your user settings";

  try {
    await vscode.workspace
      .getConfiguration("vscodeLspMcpBridge")
      .update("enableWriteTools", enabled, target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vscode.window.showWarningMessage(`LSP MCP Bridge write tools could not be updated: ${message}`);
    return;
  }

  const state = enabled ? "enabled" : "disabled";
  refreshStatusBarQuickAccessTooltip();
  vscode.window.showInformationMessage(`LSP MCP Bridge write tools ${state} for ${scope}.`);
}

function refreshStatusBarQuickAccessTooltip(): void {
  updateStatusBarQuickAccessTooltip?.();
}

function statusBarQuickAccessTooltip(): string {
  const bridgeInfo = bridge?.getStatusBarInfo();
  const connected = bridgeInfo?.connected ?? false;
  const activeWorkspace = bridgeInfo?.activeWorkspace ?? currentWorkspaceDisplayName();
  const writeToolsEnabled = vscode.workspace
    .getConfiguration("vscodeLspMcpBridge")
    .get<boolean>("enableWriteTools", false);

  return [
    "LSP MCP Bridge",
    `The MCP server is ${connected ? "connected" : "not connected"}.`,
    `Write tools are ${writeToolsEnabled ? "enabled" : "disabled"}.`,
    `Active workspace: ${activeWorkspace}.`
  ].join("\n");
}

function homePath(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
}

function currentWorkspaceDisplayName(): string {
  const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return vscode.workspace.name ?? (firstFolder ? path.basename(firstFolder) : "No workspace");
}

function workspacePath(...segments: string[]): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? path.join(folder.uri.fsPath, ...segments) : undefined;
}

async function openOrCreateFile(filePath: string, initialContent: string, label: string): Promise<boolean> {
  let exists = true;
  try {
    await fs.access(filePath);
  } catch {
    exists = false;
  }

  if (!exists) {
    const choice = await vscode.window.showInformationMessage(
      `${label} does not exist. Create it now?`,
      { modal: true, detail: filePath },
      "Create and Open"
    );
    if (choice !== "Create and Open") {
      return false;
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, initialContent, "utf8");
  }

  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
  await vscode.window.showTextDocument(document, { preview: false });
  return true;
}
