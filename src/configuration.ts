import * as vscode from "vscode";

const configurationSection = "vscodeLspMcpBridge";

export function getBridgeConfiguration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(configurationSection);
}

export function getWriteToolsEnabled(): boolean {
  const config = getBridgeConfiguration();
  const inspected = config.inspect<boolean>("enableWriteTools");
  return inspected?.globalValue ?? config.get<boolean>("enableWriteTools", false);
}
