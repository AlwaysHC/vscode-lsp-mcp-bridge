export const BRIDGE_VERSION = 3;
export const LEGACY_BRIDGE_VERSION = 2;
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 36521;

export interface BridgeConnectionInfo {
  version: number;
  host: string;
  port: number;
  token: string;
  registrationToken: string;
  workspaceFolders: string[];
  workspaceFolderUris: string[];
  createdAt: string;
}

export interface BridgeToolRequest {
  name: string;
  args: Record<string, unknown>;
}

export interface BridgeToolResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface PositionInput {
  file: string;
  line: number;
  column: number;
}

export interface DocumentInput {
  file: string;
}

export interface WorkspaceSymbolsInput {
  query: string;
}

export interface RenameInput extends PositionInput {
  newName: string;
  apply?: boolean;
}

export interface FormatInput extends DocumentInput {
  apply?: boolean;
}
