import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { BridgeHttpServer } from "./bridgeHttpServer.js";
import { codexGuidanceBlock, removeCodexGuidance, upsertCodexGuidance } from "./codexGuidance.js";
import { getBridgeConfiguration, getWriteToolsEnabled } from "./configuration.js";
import { showStatusNotification } from "./notifications.js";

let bridge: BridgeHttpServer | undefined;
let updateStatusBarQuickAccessTooltip: (() => void) | undefined;

const mcpServerDefinitionProviderId = "vscode-lsp-mcp-bridge.provider";
const copyMcpConfigAction = "Copy MCP Config";
const enableWriteToolsAction = "Enable Write Tools";
const installCodexGuidanceAction = "Install Guidance";
const removeCodexGuidanceAction = "Remove Guidance";

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
  },
  {
    label: "$(sparkle) Install Codex Guidance",
    description: "Require Codex to try semantic LSP tools before text search.",
    command: "vscode-lsp-mcp-bridge.installCodexGuidance"
  },
  {
    label: "$(trash) Remove Codex Guidance",
    description: "Remove only the guidance block managed by this extension.",
    command: "vscode-lsp-mcp-bridge.removeCodexGuidance"
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
    getUri: () => homeUri(".codex", "config.toml"),
    initialContent: ""
  },
  {
    label: "VS Code workspace MCP config",
    detail: "<workspace>/.vscode/mcp.json",
    description: "Optional workspace-level LSP MCP fallback config for VS Code and GitHub Copilot.",
    snippetClientId: "vscode-copilot",
    getUri: () => workspaceUri(".vscode", "mcp.json"),
    initialContent: emptyVsCodeMcpJson
  },
  {
    label: "Claude Code project config",
    detail: "<workspace>/.mcp.json",
    description: "Shared project LSP MCP config. For local config, prefer the copied claude mcp add command.",
    snippetClientId: "generic",
    getUri: () => workspaceUri(".mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Cursor user config",
    detail: "~/.cursor/mcp.json",
    description: "User-wide LSP MCP config for Cursor.",
    snippetClientId: "generic",
    getUri: () => homeUri(".cursor", "mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Cursor workspace config",
    detail: "<workspace>/.cursor/mcp.json",
    description: "Workspace-level LSP MCP config for Cursor.",
    snippetClientId: "generic",
    getUri: () => workspaceUri(".cursor", "mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Windsurf user config",
    detail: "~/.codeium/windsurf/mcp_config.json",
    description: "User-wide LSP MCP config for Windsurf/Cascade.",
    snippetClientId: "generic",
    getUri: () => homeUri(".codeium", "windsurf", "mcp_config.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Cline user config",
    detail: "~/.cline/mcp.json",
    description: "CLI-style LSP MCP config for Cline. The VS Code extension also has its own MCP Servers view.",
    snippetClientId: "generic",
    getUri: () => homeUri(".cline", "mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Roo Code workspace config",
    detail: "<workspace>/.roo/mcp.json",
    description: "Workspace-level LSP MCP config for Roo Code.",
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
      showStatusNotification("VS Code LSP MCP Bridge started.");
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.stop", async () => {
      await bridge?.stop();
      refreshStatusBarQuickAccessTooltip();
      showStatusNotification("VS Code LSP MCP Bridge stopped.");
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.showStatus", () => {
      vscode.window.showInformationMessage(bridge?.status ?? "VS Code LSP MCP Bridge is not initialized.", {
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
        "Enable LSP MCP Bridge write tools?",
        {
          modal: true,
          detail: "This updates the global VS Code extension setting. Each write-capable tool call still requires a VS Code approval before edits are applied."
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
      showStatusNotification(`${selected.label} MCP config copied to clipboard.`);
      if (selected.id === "codex") {
        await installCodexGuidance();
      }
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.openClientConfig", async () => {
      await bridge?.start();
      refreshStatusBarQuickAccessTooltip();
      if (!bridge) {
        showStatusNotification("VS Code LSP MCP Bridge is not initialized.");
        return;
      }

      const selected = await vscode.window.showQuickPick(clientConfigFileOptions, {
        title: "Open MCP Client Config File",
        placeHolder: "Choose the config file you want to update"
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
      if (selected.snippetClientId === "codex") {
        await installCodexGuidance();
      }
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.installCodexGuidance", installCodexGuidance),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.removeCodexGuidance", removeInstalledCodexGuidance)
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
  item.name = "LSP MCP Bridge";
  item.text = "LSP MCP";
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
    "LSP MCP Bridge",
    `The MCP server is ${connected ? "connected" : "not connected"}.`,
    `Write tools are ${writeToolsEnabled ? "enabled" : "disabled"}.`,
    `Active workspace: ${activeWorkspace}.`
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
      `${label} does not exist. Create it now?`,
      { modal: true, detail: fileUri.toString(true) },
      "Create and Open"
    );
    if (choice !== "Create and Open") {
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

async function readTextFile(fileUri: vscode.Uri): Promise<string | undefined> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(fileUri)).toString("utf8");
  } catch {
    return undefined;
  }
}

async function activeCodexGuidanceFile(): Promise<readonly [uri: vscode.Uri, content: string]> {
  const overrideUri = homeUri(".codex", "AGENTS.override.md");
  const overrideContent = await readTextFile(overrideUri);
  if (overrideContent?.trim()) {
    return [overrideUri, overrideContent];
  }

  const agentsUri = homeUri(".codex", "AGENTS.md");
  return [agentsUri, await readTextFile(agentsUri) ?? ""];
}

async function installCodexGuidance(): Promise<void> {
  const [fileUri, content] = await activeCodexGuidanceFile();
  const nextContent = upsertCodexGuidance(content);
  if (nextContent === content) {
    showStatusNotification(`Codex LSP guidance is already installed in ${fileUri.fsPath}.`);
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Install durable Codex guidance for eager LSP tool use?",
    {
      modal: true,
      detail: `This adds a clearly marked block to ${fileUri.fsPath}, preserving existing content. Codex reads this file before starting work. Start a new Codex session afterward.\n\n${codexGuidanceBlock}`
    },
    installCodexGuidanceAction
  );
  if (choice !== installCodexGuidanceAction) {
    return;
  }

  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(fileUri, ".."));
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(nextContent, "utf8"));
  showStatusNotification(`Codex LSP guidance installed in ${fileUri.fsPath}. Start a new Codex session.`);
}

async function removeInstalledCodexGuidance(): Promise<void> {
  const candidates = [
    homeUri(".codex", "AGENTS.override.md"),
    homeUri(".codex", "AGENTS.md")
  ] as const;
  const files = (await Promise.all(candidates.map(async uri => [uri, await readTextFile(uri)] as const)))
    .filter((entry): entry is readonly [vscode.Uri, string] => entry[1] !== undefined)
    .map(([uri, content]) => [uri, content, removeCodexGuidance(content)] as const)
    .filter(([, content, nextContent]) => content !== nextContent);

  if (files.length === 0) {
    showStatusNotification("No Codex guidance managed by LSP MCP Bridge was found.");
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    "Remove the Codex guidance managed by LSP MCP Bridge?",
    { modal: true, detail: files.map(([uri]) => uri.fsPath).join("\n") },
    removeCodexGuidanceAction
  );
  if (choice !== removeCodexGuidanceAction) {
    return;
  }

  await Promise.all(files.map(([uri, , nextContent]) =>
    vscode.workspace.fs.writeFile(uri, Buffer.from(nextContent, "utf8"))));
  showStatusNotification("Codex LSP guidance removed. Start a new Codex session.");
}
