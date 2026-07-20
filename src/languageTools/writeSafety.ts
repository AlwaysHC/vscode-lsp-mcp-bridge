import * as vscode from "vscode";
import { brand, brandAttribution } from "../branding.js";
import {
  boundedText,
  ensureCanonicalWorkspaceContainment,
  formatUriForApproval,
  isUriInWorkspace,
  normalizeDocumentUri,
  normalizeTextEdit
} from "./runtime.js";
import type { ToolOptions, WriteApprovalRequest } from "./types.js";

const workspaceEditMaxFiles = 100;
const workspaceEditMaxEdits = 5_000;
const workspaceEditMaxInsertedBytes = 4_194_304;
const workspaceEditMaxDeletedCharacters = 4_194_304;
const workspaceEditPreviewMaxFiles = 25;
const workspaceEditPreviewMaxEdits = 100;
const workspaceEditPreviewMaxCharacters = 65_536;

interface DocumentVersionSnapshot {
  document: vscode.TextDocument;
  version: number;
}

export interface WorkspaceEditValidation {
  versions: ReadonlyMap<string, DocumentVersionSnapshot>;
  editCount: number;
  insertedBytes: number;
  deletedCharacters: number;
}

export function ensureWritesAllowed(options: ToolOptions): void {
  if (!options.allowWrites) {
    throw new Error(brand("Write tools are disabled. Enable vscodeLspMcpBridge.enableWriteTools to apply edits."));
  }
}

export async function requestWriteApproval(request: WriteApprovalRequest): Promise<boolean> {
  const files = uniqueUris(request.files);
  const fileLines = files.length > 0
    ? files.slice(0, 10).map(uri => `- ${formatUriForApproval(uri)}`)
    : ["- No affected file reported by the provider"];
  const remainingFiles = files.length > 10 ? `\n- ...and ${files.length - 10} more` : "";
  const details = [
    brandAttribution,
    brand(`Tool: ${request.toolName}`),
    brand(`Operation: ${request.operation}`),
    request.actionTitle ? brand(`Action: ${boundedText(request.actionTitle, 1_024)}`) : undefined,
    brand(`Text edits: ${request.editCount ?? 0}`),
    brand(`Inserted bytes: ${request.insertedBytes ?? 0}`),
    brand(`Deleted/replaced characters: ${request.deletedCharacters ?? 0}`),
    brand(`Affected files:\n${fileLines.join("\n")}${remainingFiles}`)
  ].filter((value): value is string => Boolean(value)).join("\n\n");
  const choice = await vscode.window.showWarningMessage(
    brand(`Allow MCP write tool "${request.toolName}" to apply changes?`),
    { modal: true, detail: details },
    brand("Apply Changes")
  );
  return choice === brand("Apply Changes");
}

export async function requestCommandExecutionApproval(
  command: vscode.Command,
  approval: WriteApprovalRequest
): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    brand(`Allow MCP tool "${approval.toolName}" to execute a VS Code command?`),
    {
      modal: true,
      detail: [
        brandAttribution,
        brand(`Command: ${boundedText(command.title, 1_024)} (${boundedText(command.command, 1_024)})`),
        approval.actionTitle ? brand(`Action: ${boundedText(approval.actionTitle, 1_024)}`) : undefined,
        brand("Command effects are defined by the contributing extension and cannot be previewed or confined to workspace text edits. Continue only if you trust this action.")
      ].filter((value): value is string => Boolean(value)).join("\n\n")
    },
    brand("Execute Command")
  );
  return choice === brand("Execute Command");
}

export async function ensureWorkspaceEditCanBeApplied(
  edit: vscode.WorkspaceEdit | undefined,
  expectedVersions?: ReadonlyMap<string, DocumentVersionSnapshot>
): Promise<WorkspaceEditValidation> {
  if (!edit) {
    return { versions: new Map(), editCount: 0, insertedBytes: 0, deletedCharacters: 0 };
  }
  const entries = edit.entries();
  if (entries.length > workspaceEditMaxFiles) {
    throw new Error(`The workspace edit affects more than ${workspaceEditMaxFiles} files.`);
  }

  const versions = new Map<string, DocumentVersionSnapshot>();
  let editCount = 0;
  let insertedBytes = 0;
  let deletedCharacters = 0;
  for (const [uri, edits] of entries) {
    if (!isUriInWorkspace(uri)) {
      throw new Error("The provider attempted to edit a file outside the open workspace.");
    }
    await ensureCanonicalWorkspaceContainment(uri);
    editCount += edits.length;
    insertedBytes += edits.reduce((size, textEdit) => size + Buffer.byteLength(textEdit.newText), 0);
    if (editCount > workspaceEditMaxEdits) {
      throw new Error(`The workspace edit contains more than ${workspaceEditMaxEdits} text edits.`);
    }
    if (insertedBytes > workspaceEditMaxInsertedBytes) {
      throw new Error(`The workspace edit inserts more than ${workspaceEditMaxInsertedBytes} bytes.`);
    }

    const document = await vscode.workspace.openTextDocument(uri);
    const uriKey = uri.toString();
    const expected = expectedVersions?.get(uriKey);
    if (expectedVersions && (
      expected === undefined ||
      expected.document !== document ||
      expected.document.isClosed ||
      expected.version !== document.version
    )) {
      throw new Error(`The document changed while approval was pending: ${formatUriForApproval(uri)}.`);
    }
    versions.set(uriKey, { document, version: document.version });
    const offsets = edits.map(textEdit => {
      if (!document.validateRange(textEdit.range).isEqual(textEdit.range)) {
        throw new Error(`The provider returned an invalid edit range for ${formatUriForApproval(uri)}.`);
      }
      return {
        start: document.offsetAt(textEdit.range.start),
        end: document.offsetAt(textEdit.range.end)
      };
    }).sort((left, right) => left.start - right.start || left.end - right.end);
    deletedCharacters += offsets.reduce((size, editOffset) => size + editOffset.end - editOffset.start, 0);
    if (deletedCharacters > workspaceEditMaxDeletedCharacters) {
      throw new Error(`The workspace edit deletes or replaces more than ${workspaceEditMaxDeletedCharacters} characters.`);
    }
    for (let index = 1; index < offsets.length; index += 1) {
      if (offsets[index].start < offsets[index - 1].end) {
        throw new Error(`The provider returned overlapping edits for ${formatUriForApproval(uri)}.`);
      }
    }
  }
  if (expectedVersions && expectedVersions.size !== versions.size) {
    throw new Error("The set of edited documents changed while approval was pending.");
  }
  return { versions, editCount, insertedBytes, deletedCharacters };
}

export async function normalizeWorkspaceEdit(edit: vscode.WorkspaceEdit | undefined): Promise<object | undefined> {
  if (!edit) {
    return undefined;
  }
  const entries = edit.entries();
  const selectedEntries = entries.slice(0, workspaceEditPreviewMaxFiles);
  let remainingEdits = workspaceEditPreviewMaxEdits;
  let remainingCharacters = workspaceEditPreviewMaxCharacters;
  let truncated = entries.length > selectedEntries.length;
  const normalizedEntries = await Promise.all(selectedEntries.map(async ([uri, edits]) => {
    const selected = edits.slice(0, Math.max(0, remainingEdits));
    if (selected.length < edits.length) {
      truncated = true;
    }
    remainingEdits -= selected.length;
    if (!isUriInWorkspace(uri)) {
      return { external: true, editCount: edits.length };
    }
    try {
      await ensureCanonicalWorkspaceContainment(uri);
    } catch {
      return { external: true, editCount: edits.length };
    }
    return {
      ...normalizeDocumentUri(uri),
      edits: selected.map(textEdit => {
        const maximum = Math.max(0, Math.min(8_192, remainingCharacters));
        const newText = textEdit.newText.length <= maximum
          ? textEdit.newText
          : maximum < 4 ? "" : `${textEdit.newText.slice(0, maximum - 3)}...`;
        if (newText.length < textEdit.newText.length) {
          truncated = true;
        }
        remainingCharacters -= newText.length;
        return normalizeTextEdit(vscode.TextEdit.replace(textEdit.range, newText));
      })
    };
  }));
  return {
    visibleTextEditFiles: entries.length,
    mayContainUninspectableOperations: true,
    applySupported: false,
    truncated,
    entries: normalizedEntries
  };
}

function uniqueUris(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  return uris.filter(uri => {
    const key = uri.toString();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
