import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { boundedInteger } from "../languageToolCore.js";
import {
  boundedText,
  executeProviderCommand,
  markdownToText,
  normalizeCommand,
  normalizeRange,
  normalizeUriForComparison,
  openDocumentUri,
  optionalStringArg,
  positionArg,
  stringArg
} from "./runtime.js";
import type { ToolOptions } from "./types.js";
import {
  ensureWorkspaceEditCanBeApplied,
  ensureWritesAllowed,
  requestWriteApproval
} from "./writeSafety.js";

const completionGrantTtlMs = 2 * 60 * 1_000;
const completionGrantLimit = 256;
const completionGrantMaxBytes = 8_388_608;
const completionMaxItems = 100;
const completionMaxEdits = 100;
const completionMaxInsertedBytes = 1_048_576;
const completionMaxDeletedCharacters = 1_048_576;
const completionPreviewTextMaxLength = 8_192;

interface CompletionGrant {
  uri: vscode.Uri;
  document: vscode.TextDocument;
  documentVersion: number;
  label: string;
  edits: vscode.TextEdit[];
  expiresAt: number;
}

const completionGrants = new Map<string, CompletionGrant>();
let completionGrantBytes = 0;

export async function completion(args: Record<string, unknown>): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const position = positionArg(args, document);
  const itemResolveCount = boundedInteger(args.itemResolveCount, "itemResolveCount", {
    defaultValue: 20,
    maximum: 100
  });
  const maxItems = boundedInteger(args.maxItems, "maxItems", { defaultValue: 100, maximum: completionMaxItems });
  const list = await executeProviderCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    uri,
    position,
    optionalStringArg(args, "triggerCharacter"),
    itemResolveCount
  );
  pruneCompletionGrants();
  const protectedReferences = new Set<string>();
  return {
    isIncomplete: list?.isIncomplete ?? false,
    totalItems: list?.items.length ?? 0,
    truncated: (list?.items.length ?? 0) > maxItems,
    items: (list?.items ?? []).slice(0, maxItems).map((item, index) =>
      normalizeCompletionItem(item, document, position, index, protectedReferences)
    )
  };
}

function normalizeCompletionItem(
  item: vscode.CompletionItem,
  document: vscode.TextDocument,
  position: vscode.Position,
  index: number,
  protectedReferences: Set<string>
): object {
  const label = typeof item.label === "string" ? item.label : item.label.label;
  const insertion = completionInsertion(item, document, position);
  const allAdditionalTextEdits = item.additionalTextEdits ?? [];
  const additionalTextEdits = allAdditionalTextEdits.slice(0, 20);
  const tooManyAdditionalEdits = allAdditionalTextEdits.length >= completionMaxEdits;
  const edits = insertion.applyEdit && !tooManyAdditionalEdits
    ? [insertion.applyEdit, ...allAdditionalTextEdits]
    : [];
  const editsAreSafe = edits.length > 0 && completionEditsAreSafe(document, edits);
  const completionId = editsAreSafe
    ? rememberCompletionGrant(document, label, edits, protectedReferences)
    : undefined;
  return {
    itemIndex: index + 1,
    completionId,
    label: boundedText(label, 1_024),
    labelDetails: typeof item.label === "string" ? undefined : {
      detail: boundedText(item.label.detail, 2_048),
      description: boundedText(item.label.description, 2_048)
    },
    kind: item.kind === undefined ? undefined : vscode.CompletionItemKind[item.kind],
    tags: item.tags?.map(tag => vscode.CompletionItemTag[tag]),
    detail: boundedText(item.detail, completionPreviewTextMaxLength),
    documentation: boundedText(markdownToText(item.documentation), completionPreviewTextMaxLength),
    sortText: boundedText(item.sortText, 1_024),
    filterText: boundedText(item.filterText, 1_024),
    preselect: item.preselect,
    keepWhitespace: item.keepWhitespace,
    commitCharacters: item.commitCharacters?.slice(0, 50).map(value => boundedText(value, 16)),
    insertText: insertion.previewText,
    insertTextFormat: insertion.isSnippet ? "snippet" : "plainText",
    textEdit: insertion.normalizedEdit,
    additionalTextEdits: additionalTextEdits.map(normalizeCompletionTextEdit),
    additionalTextEditsTruncated: (item.additionalTextEdits?.length ?? 0) > additionalTextEdits.length,
    command: normalizeCommand(item.command),
    commandExcludedOnApply: Boolean(item.command),
    applyUnavailableReason: completionId
      ? undefined
      : insertion.isSnippet
        ? "Snippet completions cannot be applied safely as plain text edits."
        : tooManyAdditionalEdits
          ? `The completion has ${allAdditionalTextEdits.length} additional edits, exceeding the safe apply limit.`
        : edits.length === 0
          ? "The completion did not provide applicable insertion text."
          : !editsAreSafe
            ? "The completion edits overlap or exceed the safe edit limits."
            : "The bounded completion snapshot cache is full; request fewer completion items and try again."
  };
}

function completionInsertion(
  item: vscode.CompletionItem,
  document: vscode.TextDocument,
  position: vscode.Position
): {
  previewText?: string;
  isSnippet: boolean;
  normalizedEdit?: object;
  applyEdit?: vscode.TextEdit;
} {
  const textEdit = item.textEdit;
  if (textEdit) {
    const previewText = boundedText(textEdit.newText, completionPreviewTextMaxLength);
    return {
      previewText,
      isSnippet: false,
      normalizedEdit: { ...normalizeRange(textEdit.range), newText: previewText },
      applyEdit: vscode.TextEdit.replace(textEdit.range, textEdit.newText)
    };
  }

  const snippet = item.insertText instanceof vscode.SnippetString ? item.insertText : undefined;
  const insertionText = snippet?.value
    ?? (typeof item.insertText === "string" ? item.insertText : undefined)
    ?? (typeof item.label === "string" ? item.label : item.label.label);
  const previewText = boundedText(insertionText, completionPreviewTextMaxLength);
  if (snippet) {
    return { previewText, isSnippet: true };
  }
  if (item.range && "inserting" in item.range) {
    return {
      previewText,
      isSnippet: false,
      normalizedEdit: {
        inserting: normalizeRange(item.range.inserting),
        replacing: normalizeRange(item.range.replacing),
        newText: previewText
      },
      applyEdit: vscode.TextEdit.replace(item.range.replacing, insertionText)
    };
  }
  const range = item.range ?? document.getWordRangeAtPosition(position) ?? new vscode.Range(position, position);
  return {
    previewText,
    isSnippet: false,
    normalizedEdit: { ...normalizeRange(range), newText: previewText },
    applyEdit: vscode.TextEdit.replace(range, insertionText)
  };
}

function rememberCompletionGrant(
  document: vscode.TextDocument,
  label: string,
  edits: vscode.TextEdit[],
  protectedReferences: Set<string>
): string | undefined {
  pruneCompletionGrants();
  const storedLabel = boundedText(label, 1_024) ?? "";
  const storedEdits = edits.map(edit => vscode.TextEdit.replace(edit.range, edit.newText));
  const byteSize = Buffer.byteLength(storedLabel)
    + storedEdits.reduce((size, edit) => size + Buffer.byteLength(edit.newText), 0);
  while (completionGrants.size >= completionGrantLimit || completionGrantBytes + byteSize > completionGrantMaxBytes) {
    const evictable = [...completionGrants.keys()].find(reference => !protectedReferences.has(reference));
    if (!evictable) {
      return undefined;
    }
    deleteCompletionGrant(evictable);
  }
  const now = Date.now();
  const reference = crypto.randomUUID();
  completionGrants.set(reference, {
    uri: document.uri,
    document,
    documentVersion: document.version,
    label: storedLabel,
    edits: storedEdits,
    expiresAt: now + completionGrantTtlMs
  });
  completionGrantBytes += byteSize;
  protectedReferences.add(reference);
  return reference;
}

function pruneCompletionGrants(): void {
  const now = Date.now();
  for (const [reference, grant] of completionGrants) {
    if (grant.expiresAt <= now || grant.document.isClosed) {
      deleteCompletionGrant(reference);
    }
  }
}

function deleteCompletionGrant(reference: string): void {
  const grant = completionGrants.get(reference);
  if (!grant) {
    return;
  }
  completionGrantBytes -= Buffer.byteLength(grant.label)
    + grant.edits.reduce((size, edit) => size + Buffer.byteLength(edit.newText), 0);
  completionGrants.delete(reference);
}

function completionEditsAreSafe(document: vscode.TextDocument, edits: vscode.TextEdit[]): boolean {
  if (edits.length === 0 || edits.length > completionMaxEdits) {
    return false;
  }
  if (edits.reduce((size, edit) => size + Buffer.byteLength(edit.newText), 0) > completionMaxInsertedBytes) {
    return false;
  }
  const offsets = edits
    .map(edit => {
      if (!document.validateRange(edit.range).isEqual(edit.range)) {
        return undefined;
      }
      return { start: document.offsetAt(edit.range.start), end: document.offsetAt(edit.range.end) };
    });
  if (offsets.some(value => value === undefined)) {
    return false;
  }
  const sortedOffsets = offsets
    .filter((value): value is { start: number; end: number } => Boolean(value))
    .sort((left, right) => left.start - right.start || left.end - right.end);
  if (sortedOffsets.reduce((size, edit) => size + edit.end - edit.start, 0) > completionMaxDeletedCharacters) {
    return false;
  }
  return sortedOffsets.every((value, index) => index === 0
    || (value.start >= sortedOffsets[index - 1].end
      && (value.start !== sortedOffsets[index - 1].start || value.end !== sortedOffsets[index - 1].end)));
}

function normalizeCompletionTextEdit(edit: vscode.TextEdit): object {
  return { ...normalizeRange(edit.range), newText: boundedText(edit.newText, 4_096) };
}

export async function applyCompletion(args: Record<string, unknown>, options: ToolOptions): Promise<object> {
  ensureWritesAllowed(options);
  const anchorUri = await openDocumentUri(stringArg(args, "file"));
  const completionId = stringArg(args, "completionId");
  const grant = completionGrants.get(completionId);
  if (!grant || grant.expiresAt <= Date.now()) {
    deleteCompletionGrant(completionId);
    throw new Error("The completion reference is invalid or expired. Request completions again.");
  }
  if (normalizeUriForComparison(anchorUri) !== normalizeUriForComparison(grant.uri)) {
    throw new Error("The completion reference does not belong to the routed workspace document.");
  }
  const document = await vscode.workspace.openTextDocument(grant.uri);
  if (document !== grant.document || grant.document.isClosed ||
    document.version !== grant.documentVersion || !completionEditsAreSafe(document, grant.edits)) {
    deleteCompletionGrant(completionId);
    throw new Error("The document or completion changed. Request completions again.");
  }

  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(grant.uri, grant.edits);
  const validation = await ensureWorkspaceEditCanBeApplied(workspaceEdit);
  const approved = await requestWriteApproval({
    toolName: "apply_completion",
    operation: "Apply a plain-text completion (provider commands are excluded)",
    files: [grant.uri],
    actionTitle: grant.label,
    editCount: validation.editCount,
    insertedBytes: validation.insertedBytes,
    deletedCharacters: validation.deletedCharacters
  });
  if (!approved) {
    return { approved: false, applied: false };
  }

  const currentDocument = await vscode.workspace.openTextDocument(grant.uri);
  if (currentDocument !== grant.document || grant.document.isClosed || currentDocument.version !== grant.documentVersion) {
    deleteCompletionGrant(completionId);
    throw new Error("The document changed while approval was pending. Nothing was applied.");
  }
  await ensureWorkspaceEditCanBeApplied(workspaceEdit, validation.versions);
  deleteCompletionGrant(completionId);
  return {
    approved: true,
    applied: await vscode.workspace.applyEdit(workspaceEdit),
    commandExecuted: false
  };
}
