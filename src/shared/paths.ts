import * as os from "node:os";
import * as path from "node:path";

export function defaultConnectionFilePath(): string {
  return path.join(os.homedir(), ".vscode-lsp-mcp-bridge", "connection.json");
}

