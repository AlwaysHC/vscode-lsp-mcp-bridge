import * as vscode from "vscode";
import { BridgeHttpServer } from "./bridgeHttpServer.js";

let bridge: BridgeHttpServer | undefined;

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
    vscode.commands.registerCommand("vscode-lsp-mcp-bridge.copyCodexConfig", async () => {
      await bridge?.start();
      const snippet = bridge?.getCodexConfigSnippet();
      if (!snippet) {
        vscode.window.showWarningMessage("VS Code LSP MCP Bridge is not initialized.");
        return;
      }

      await vscode.env.clipboard.writeText(snippet);
      vscode.window.showInformationMessage("Codex MCP config copied to clipboard.");
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
