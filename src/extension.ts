import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { BridgeHttpServer } from "./bridgeHttpServer.js";

let bridge: BridgeHttpServer | undefined;

const mcpServerDefinitionProviderId = "vscode-lsp-mcp-bridge.provider";

type ClientConfigId = "codex" | "vscode-copilot" | "claude-code" | "generic";

interface ClientConfigOption extends vscode.QuickPickItem {
  id: ClientConfigId;
}

interface ClientConfigFileOption extends vscode.QuickPickItem {
  snippetClientId: ClientConfigId;
  getPath: () => string | undefined;
  initialContent: string;
}

const emptyMcpServersJson = JSON.stringify({ mcpServers: {} }, null, 2) + "\n";
const emptyVsCodeMcpJson = JSON.stringify({ servers: {} }, null, 2) + "\n";

const clientConfigOptions: ClientConfigOption[] = [
  {
    label: "Codex",
    id: "codex",
    detail: "TOML config for Codex MCP servers."
  },
  {
    label: "VS Code / GitHub Copilot",
    id: "vscode-copilot",
    detail: "JSON for VS Code user or workspace mcp.json."
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
    description: "Paste the copied TOML block into this file.",
    snippetClientId: "codex",
    getPath: () => homePath(".codex", "config.toml"),
    initialContent: ""
  },
  {
    label: "VS Code workspace MCP config",
    detail: "<workspace>/.vscode/mcp.json",
    description: "Workspace-level MCP config for VS Code and GitHub Copilot.",
    snippetClientId: "vscode-copilot",
    getPath: () => workspacePath(".vscode", "mcp.json"),
    initialContent: emptyVsCodeMcpJson
  },
  {
    label: "Claude Code project config",
    detail: "<workspace>/.mcp.json",
    description: "Shared project MCP config. For local config, prefer the copied claude mcp add command.",
    snippetClientId: "generic",
    getPath: () => workspacePath(".mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Cursor user config",
    detail: "~/.cursor/mcp.json",
    description: "User-wide Cursor MCP config.",
    snippetClientId: "generic",
    getPath: () => homePath(".cursor", "mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Cursor workspace config",
    detail: "<workspace>/.cursor/mcp.json",
    description: "Workspace-level Cursor MCP config.",
    snippetClientId: "generic",
    getPath: () => workspacePath(".cursor", "mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Windsurf user config",
    detail: "~/.codeium/windsurf/mcp_config.json",
    description: "User-wide Windsurf/Cascade MCP config.",
    snippetClientId: "generic",
    getPath: () => homePath(".codeium", "windsurf", "mcp_config.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Cline user config",
    detail: "~/.cline/mcp.json",
    description: "CLI-style Cline MCP config. The VS Code extension also has its own MCP Servers view.",
    snippetClientId: "generic",
    getPath: () => homePath(".cline", "mcp.json"),
    initialContent: emptyMcpServersJson
  },
  {
    label: "Roo Code workspace config",
    detail: "<workspace>/.roo/mcp.json",
    description: "Workspace-level Roo Code MCP config.",
    snippetClientId: "generic",
    getPath: () => workspacePath(".roo", "mcp.json"),
    initialContent: emptyMcpServersJson
  }
];

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  bridge = new BridgeHttpServer(context);
  registerMcpServerDefinitionProvider(context, bridge);

  context.subscriptions.push(
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.start", async () => {
      await bridge?.start();
      vscode.window.showInformationMessage("VS Code LSP MCP Bridge started.");
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.stop", async () => {
      await bridge?.stop();
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
        vscode.window.showInformationMessage(message);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        vscode.window.showWarningMessage(`VS Code LSP MCP Bridge could not activate this workspace: ${message}`);
      }
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.copyClientConfig", async () => {
      await bridge?.start();
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
        "Copy MCP Config"
      );
      if (choice !== "Copy MCP Config") {
        return;
      }

      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage(`${selected.label} MCP config copied to clipboard.`);
    }),
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.openClientConfig", async () => {
      await bridge?.start();
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

function homePath(...segments: string[]): string {
  return path.join(os.homedir(), ...segments);
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
