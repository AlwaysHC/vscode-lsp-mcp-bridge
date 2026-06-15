import * as vscode from "vscode";
import { BridgeHttpServer } from "./bridgeHttpServer.js";

let bridge: BridgeHttpServer | undefined;

const clientConfigOptions = [
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

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  bridge = new BridgeHttpServer(context);

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
