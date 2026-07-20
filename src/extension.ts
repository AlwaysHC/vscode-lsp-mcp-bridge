import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { brand, brandAttribution } from "./branding.js";
import { BridgeHttpServer } from "./bridgeHttpServer.js";
import { getBridgeConfiguration, getWriteToolsEnabled } from "./configuration.js";
import { showStatusNotification } from "./notifications.js";

let bridge: BridgeHttpServer | undefined;
let updateStatusBarQuickAccessTooltip: (() => void) | undefined;

const mcpServerDefinitionProviderId = "vscode-lsp-mcp-bridge.provider";
const copyMcpConfigAction = brand("Copy MCP Config");
const enableWriteToolsAction = brand("Enable Write Tools");

type ClientConfigId = "codex" | "vscode-copilot" | "claude-code" | "generic";

interface ClientConfigOption extends vscode.QuickPickItem {
  id: ClientConfigId;
}

interface ClientConfigFileOption extends vscode.QuickPickItem {
  snippetClientId: ClientConfigId;
  getUri: () => vscode.Uri | undefined;
  initialContent: string;
}

interface BridgeQuickAccessOption extends vscode.QuickPickItem {
  command: string;
}

const emptyMcpServersJson = JSON.stringify({ mcpServers: {} }, null, 2) + "\n";
const emptyVsCodeMcpJson = JSON.stringify({ servers: {} }, null, 2) + "\n";

const bridgeQuickAccessOptions: BridgeQuickAccessOption[] = [
  {
    label: "$(play) GA - Start Server",
    description: brand("Start the local LSP MCP bridge server."),
    command: "vscode-lsp-mcp-bridge.start"
  },
  {
    label: "$(debug-stop) GA - Stop Server",
    description: brand("Stop the local LSP MCP bridge server."),
    command: "vscode-lsp-mcp-bridge.stop"
  },
  {
    label: "$(info) GA - Show Status",
    description: brand("Show LSP MCP bridge endpoint, version, and workspace details."),
    command: "vscode-lsp-mcp-bridge.showStatus"
  },
  {
    label: "$(workspace-trusted) GA - Route Gateway To This Workspace",
    description: brand("Make this workspace the target for new LSP MCP external-client sessions."),
    command: "vscode-lsp-mcp-bridge.useWorkspace"
  },
  {
    label: "$(unlock) GA - Enable Write Tools",
    description: brand("Enable LSP MCP Bridge write tools from the extension."),
    command: "vscode-lsp-mcp-bridge.enableWriteTools"
  },
  {
    label: "$(lock) GA - Disable Write Tools",
    description: brand("Disable LSP MCP Bridge write tools from the extension."),
    command: "vscode-lsp-mcp-bridge.disableWriteTools"
  },
  {
    label: "$(copy) GA - Copy MCP Client Config",
    description: brand("Copy a ready-to-use LSP MCP bridge config snippet for an MCP client."),
    command: "vscode-lsp-mcp-bridge.copyClientConfig"
  },
  {
    label: "$(go-to-file) GA - Open MCP Client Config File",
    description: brand("Open a common LSP MCP client config file and copy the matching snippet."),
    command: "vscode-lsp-mcp-bridge.openClientConfig"
  }
];

const clientConfigOptions: ClientConfigOption[] = [
  {
    label: brand("Codex"),
    id: "codex",
    detail: brand("TOML config for Codex MCP servers.")
  },
  {
    label: brand("VS Code / GitHub Copilot"),
    id: "vscode-copilot",
    detail: brand("Optional fallback JSON for VS Code user or workspace mcp.json.")
  },
  {
    label: brand("Claude Code"),
    id: "claude-code",
    detail: brand("CLI command using HTTP transport and Authorization header.")
  },
  {
    label: brand("Generic HTTP MCP Client"),
    id: "generic",
    detail: brand("JSON shape for MCP clients that support Streamable HTTP servers.")
  }
];

const clientConfigFileOptions: ClientConfigFileOption[] = [
  {
    label: brand("Codex global config"),
    detail: "~/.codex/config.toml",
    description: brand("Paste the copied LSP MCP TOML block into this file."),
    snippetClientId: "codex",
    getUri: () => homeUri(".codex", "config.toml"),
    initialContent: ""
  },
  {
    label: brand("VS Code workspace MCP config"),
    detail: "<workspace>/.vscode/mcp.json",
    description: brand("Optional workspace-level LSP MCP fallback config for VS Code and GitHub Copilot."),
    snippetClientId: "vscode-copilot",
    getUri: () => workspaceUri(".vscode", "mcp.json"),
    initialContent: emptyVsCodeMcpJson
  },
  {
    label: brand("Claude Code project config"),
    detail: "<workspace>/.mcp.json",
    description: brand("Shared project LSP MCP config. For local config, prefer the copied claude mcp add command."),
    snippetClientId: "generic",
    getUri: () => workspaceUri(".mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: brand("Cursor user config"),
    detail: "~/.cursor/mcp.json",
    description: brand("User-wide LSP MCP config for Cursor."),
    snippetClientId: "generic",
    getUri: () => homeUri(".cursor", "mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: brand("Cursor workspace config"),
    detail: "<workspace>/.cursor/mcp.json",
    description: brand("Workspace-level LSP MCP config for Cursor."),
    snippetClientId: "generic",
    getUri: () => workspaceUri(".cursor", "mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: brand("Windsurf user config"),
    detail: "~/.codeium/windsurf/mcp_config.json",
    description: brand("User-wide LSP MCP config for Windsurf/Cascade."),
    snippetClientId: "generic",
    getUri: () => homeUri(".codeium", "windsurf", "mcp_config.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: brand("Cline user config"),
    detail: "~/.cline/mcp.json",
    description: brand("CLI-style LSP MCP config for Cline. The VS Code extension also has its own MCP Servers view."),
    snippetClientId: "generic",
    getUri: () => homeUri(".cline", "mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: brand("Roo Code workspace config"),
    detail: "<workspace>/.roo/mcp.json",
    description: brand("Workspace-level LSP MCP config for Roo Code."),
    snippetClientId: "generic",
    getUri: () => workspaceUri(".roo", "mcp.json"),
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
        title: brand("LSP MCP Bridge"),
        placeHolder: brand("Choose a bridge action")
      });
      if (!selected) {
        return;
      }

      await vscode.commands.executeCommand(selected.command);
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.start", async () => {
      await bridge?.start();
      refreshStatusBarQuickAccessTooltip();
      showStatusNotification("VS Code LSP MCP Bridge started.");
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.stop", async () => {
      await bridge?.stop();
      refreshStatusBarQuickAccessTooltip();
      showStatusNotification("VS Code LSP MCP Bridge stopped.");
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.showStatus", () => {
      vscode.window.showInformationMessage(brand(bridge?.status ?? "VS Code LSP MCP Bridge is not initialized."), {
        modal: true
      });
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.useWorkspace", async () => {
      if (!bridge) {
        showStatusNotification("VS Code LSP MCP Bridge is not initialized.");
        return;
      }

      try {
        const message = await bridge.useThisWorkspace();
        refreshStatusBarQuickAccessTooltip();
        showStatusNotification(message);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        showStatusNotification(`VS Code LSP MCP Bridge could not activate this workspace: ${message}`);
        refreshStatusBarQuickAccessTooltip();
      }
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.enableWriteTools", async () => {
      const choice = await vscode.window.showInformationMessage(
        brand("Enable LSP MCP Bridge write tools?"),
        {
          modal: true,
          detail: brand(`${brandAttribution} This updates the global VS Code extension setting. Each write-capable tool call still requires a VS Code approval before edits are applied.`)
        },
        enableWriteToolsAction
      );
      if (choice !== enableWriteToolsAction) {
        return;
      }

      await updateWriteToolsGlobally(true);
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.disableWriteTools", async () => {
      await updateWriteToolsGlobally(false);
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.copyClientConfig", async () => {
      await bridge?.start();
      refreshStatusBarQuickAccessTooltip();
      if (!bridge) {
        showStatusNotification("VS Code LSP MCP Bridge is not initialized.");
        return;
      }

      const selected = await vscode.window.showQuickPick(clientConfigOptions, {
        title: brand("Copy MCP Client Config"),
        placeHolder: brand("Choose the AI coding tool or MCP client you want to configure")
      });
      if (!selected) {
        return;
      }

      const snippet = bridge.getClientConfigSnippet(selected.id);
      const choice = await vscode.window.showInformationMessage(
        brand(`Copy the ${selected.label.replace(/^GA - /, "")} MCP config to the clipboard?`),
        { modal: true },
        copyMcpConfigAction
      );
      if (choice !== copyMcpConfigAction) {
        return;
      }

      await vscode.env.clipboard.writeText(snippet);
      showStatusNotification(`${selected.label} MCP config copied to clipboard.`);
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.openClientConfig", async () => {
      await bridge?.start();
      refreshStatusBarQuickAccessTooltip();
      if (!bridge) {
        showStatusNotification("VS Code LSP MCP Bridge is not initialized.");
        return;
      }

      const selected = await vscode.window.showQuickPick(clientConfigFileOptions, {
        title: brand("Open MCP Client Config File"),
        placeHolder: brand("Choose the config file you want to update")
      });
      if (!selected) {
        return;
      }

      const fileUri = selected.getUri();
      if (!fileUri) {
        showStatusNotification("Open a workspace before selecting a workspace-level MCP config file.");
        return;
      }

      const opened = await openOrCreateFile(fileUri, selected.initialContent, selected.label);
      if (!opened) {
        return;
      }

      const snippet = bridge.getClientConfigSnippet(selected.snippetClientId);
      await vscode.env.clipboard.writeText(snippet);
      showStatusNotification(`${selected.label} opened. MCP config snippet copied to clipboard.`);
    })
  );

  const autoStart = getBridgeConfiguration().get<boolean>("autoStart", true);

  if (autoStart) {
    try {
      await bridge.start();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      showStatusNotification(`VS Code LSP MCP Bridge did not start: ${message}`);
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
      const restartRequired =
        event.affectsConfiguration("vscodeLspMcpBridge.host") ||
        event.affectsConfiguration("vscodeLspMcpBridge.port") ||
        event.affectsConfiguration("vscodeLspMcpBridge.connectionFile");
      if (restartRequired) {
        void bridgeServer.restart().then(
          () => {
            definitionsChanged.fire();
            refreshStatusBarQuickAccessTooltip();
          },
          error => {
            showStatusNotification(`VS Code LSP MCP Bridge could not restart: ${error instanceof Error ? error.message : String(error)}`);
          }
        );
      }
    }),
    vscode.lm.registerMcpServerDefinitionProvider(mcpServerDefinitionProviderId, {
      onDidChangeMcpServerDefinitions: definitionsChanged.event,
      provideMcpServerDefinitions: () => [bridgeServer.getVsCodeMcpServerDefinition()],
      resolveMcpServerDefinition: async _server => {
        await bridgeServer.start();
        return bridgeServer.getVsCodeMcpServerDefinition();
      }
    })
  );
}

function registerStatusBarQuickAccess(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = brand("LSP MCP Bridge");
  item.text = "GA - LSP MCP";
  item.command = "vscode-lsp-mcp-bridge.openQuickAccess";
  item.show();

  let previousTooltip = "";
  updateStatusBarQuickAccessTooltip = () => {
    const nextTooltip = statusBarQuickAccessTooltip();
    if (nextTooltip !== previousTooltip) {
      item.tooltip = nextTooltip;
      previousTooltip = nextTooltip;
    }
  };
  updateStatusBarQuickAccessTooltip();

  context.subscriptions.push(
    item,
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration("vscodeLspMcpBridge.enableWriteTools")) {
        refreshStatusBarQuickAccessTooltip();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      refreshStatusBarQuickAccessTooltip();
      void bridge?.refreshWorkspaceContext().catch(error => {
        showStatusNotification(`VS Code LSP MCP Bridge could not refresh workspace routing: ${error instanceof Error ? error.message : String(error)}`);
      });
    }),
    vscode.window.onDidChangeWindowState(event => {
      if (event.focused) {
        refreshStatusBarQuickAccessTooltip();
      }
    }),
    new vscode.Disposable(() => {
      updateStatusBarQuickAccessTooltip = undefined;
    })
  );
}

async function updateWriteToolsGlobally(enabled: boolean): Promise<void> {
  try {
    await getBridgeConfiguration().update("enableWriteTools", enabled, vscode.ConfigurationTarget.Global);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    showStatusNotification(`LSP MCP Bridge write tools could not be updated: ${message}`);
    return;
  }

  const state = enabled ? "enabled" : "disabled";
  refreshStatusBarQuickAccessTooltip();
  showStatusNotification(`LSP MCP Bridge write tools ${state} globally.`);
}

function refreshStatusBarQuickAccessTooltip(): void {
  updateStatusBarQuickAccessTooltip?.();
}

function statusBarQuickAccessTooltip(): string {
  const bridgeInfo = bridge?.getStatusBarInfo();
  const connected = bridgeInfo?.connected ?? false;
  const activeWorkspace = bridgeInfo?.activeWorkspace ?? currentWorkspaceDisplayName();
  const writeToolsEnabled = getWriteToolsEnabled();

  return [
    brand("LSP MCP Bridge"),
    brandAttribution,
    brand(`The MCP server is ${connected ? "connected" : "not connected"}.`),
    brand(`Write tools are ${writeToolsEnabled ? "enabled" : "disabled"}.`),
    brand(`Active workspace: ${activeWorkspace}.`)
  ].join("\n");
}

function homeUri(...segments: string[]): vscode.Uri {
  return vscode.Uri.file(path.join(os.homedir(), ...segments));
}

function currentWorkspaceDisplayName(): string {
  const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return vscode.workspace.name ?? (firstFolder ? path.basename(firstFolder) : "No workspace");
}

function workspaceUri(...segments: string[]): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder ? vscode.Uri.joinPath(folder.uri, ...segments) : undefined;
}

async function openOrCreateFile(fileUri: vscode.Uri, initialContent: string, label: string): Promise<boolean> {
  let exists = true;
  try {
    await vscode.workspace.fs.stat(fileUri);
  } catch {
    exists = false;
  }

  if (!exists) {
    const choice = await vscode.window.showInformationMessage(
      brand(`${label.replace(/^GA - /, "")} does not exist. Create it now?`),
      { modal: true, detail: fileUri.toString(true) },
      brand("Create and Open")
    );
    if (choice !== brand("Create and Open")) {
      return false;
    }

    const parent = vscode.Uri.joinPath(fileUri, "..");
    await vscode.workspace.fs.createDirectory(parent);
    await vscode.workspace.fs.writeFile(fileUri, Buffer.from(initialContent, "utf8"));
  }

  const document = await vscode.workspace.openTextDocument(fileUri);
  await vscode.window.showTextDocument(document, { preview: false });
  return true;
}
