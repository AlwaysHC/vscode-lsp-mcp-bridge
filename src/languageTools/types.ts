import * as vscode from "vscode";

export interface ToolOptions {
  allowWrites: boolean;
}

export interface SymbolHints {
  query: string;
  containerName?: string;
  file?: string;
  kind?: string;
}

export interface ResolvedSymbolQuery {
  query: string;
  selectedSymbol?: vscode.SymbolInformation;
  candidates: vscode.SymbolInformation[];
}

export interface FlattenedDocumentSymbol {
  symbol: vscode.DocumentSymbol;
  containerName: string;
  uri: vscode.Uri;
}

export interface WriteApprovalRequest {
  toolName: string;
  operation: string;
  files: vscode.Uri[];
  actionTitle?: string;
  command?: vscode.Command;
  editCount?: number;
  insertedBytes?: number;
  deletedCharacters?: number;
}

export type CodeActionLike = vscode.CodeAction | vscode.Command;
