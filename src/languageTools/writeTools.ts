import * as vscode from "vscode";
import { boundedInteger } from "../languageToolCore.js";
import {
  formattingOptions,
  boundedText,
  executeProviderCommand,
  normalizeCommand,
  normalizeRange,
  openDocumentUri,
  optionalBooleanArg,
  optionalRangeArg,
  optionalStringArg,
  positionArg,
  rangeArg,
  stringArg,
  withTimeout
} from "./runtime.js";
import type { CodeActionLike, ToolOptions, WriteApprovalRequest } from "./types.js";
import {
  ensureWorkspaceEditCanBeApplied,
  ensureWritesAllowed,
  normalizeWorkspaceEdit,
  requestCommandExecutionApproval,
  requestWriteApproval
} from "./writeSafety.js";

export async function codeActions(args: Record<string, unknown>): Promise<object[]> {
  const actions = await getCodeActions(args);
  return Promise.all(actions.map((action, index) => normalizeCodeAction(action, index)));
}

async function getCodeActions(args: Record<string, unknown>): Promise<CodeActionLike[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const kind = optionalStringArg(args, "kind");
  const itemResolveCount = boundedInteger(args.itemResolveCount, "itemResolveCount", {
    defaultValue: 100,
    maximum: 100
  });
  const values = await executeProviderCommand<CodeActionLike[]>(
    "vscode.executeCodeActionProvider",
    uri,
    codeActionRange(args, document),
    kind ? codeActionKindFromString(kind) : undefined,
    itemResolveCount
  );
  return (values ?? []).slice(0, 100);
}

function codeActionRange(args: Record<string, unknown>, document: vscode.TextDocument): vscode.Range {
  const range = optionalRangeArg(args, document);
  return args.startLine === undefined ? range : new vscode.Selection(range.start, range.end);
}

function codeActionKindFromString(value: string): vscode.CodeActionKind {
  return vscode.CodeActionKind.Empty.append(value);
}

async function normalizeCodeAction(action: CodeActionLike, index: number): Promise<object> {
  const command = isCodeAction(action) ? action.command : action;
  return {
    actionIndex: index + 1,
    title: boundedText(action.title, 1_024),
    kind: isCodeAction(action) ? action.kind?.value : undefined,
    isPreferred: isCodeAction(action) ? action.isPreferred : undefined,
    disabled: isCodeAction(action) ? boundedText(action.disabled?.reason, 4_096) : undefined,
    diagnostics: isCodeAction(action) ? action.diagnostics?.slice(0, 20).map(diagnostic => ({
      message: boundedText(diagnostic.message, 4_096),
      severity: vscode.DiagnosticSeverity[diagnostic.severity],
      source: boundedText(diagnostic.source, 512),
      code: boundedText(String(typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code ?? ""), 1_024),
      ...normalizeRange(diagnostic.range)
    })) : undefined,
    edit: isCodeAction(action) ? await normalizeWorkspaceEdit(action.edit) : undefined,
    command: normalizeCommand(command),
    commandRequiresExplicitApproval: Boolean(command)
  };
}

function isCodeAction(action: CodeActionLike): action is vscode.CodeAction {
  return typeof action.command !== "string";
}

export async function applyCodeAction(args: Record<string, unknown>, options: ToolOptions): Promise<object> {
  ensureWritesAllowed(options);
  const fallbackUri = await openDocumentUri(stringArg(args, "file"));
  const selected = selectCodeAction(await getCodeActions(args), args);
  const applied = await applySelectedCodeAction(
    selected,
    optionalBooleanArg(args, "executeCommand", false),
    {
      toolName: "apply_code_action",
      operation: "Apply code action",
      files: [fallbackUri],
      actionTitle: selected.action.title
    }
  );
  return { ...applied, selectedAction: await normalizeCodeAction(selected.action, selected.index) };
}

export async function sourceAction(
  args: Record<string, unknown>,
  options: ToolOptions,
  kind: string,
  toolName: string
): Promise<object> {
  const actionArgs = { ...args, kind };
  const actions = await getCodeActions(actionArgs);
  if (!optionalBooleanArg(args, "apply")) {
    return { applied: false, actions: await Promise.all(actions.map((action, index) => normalizeCodeAction(action, index))) };
  }
  ensureWritesAllowed(options);
  const fallbackUri = await openDocumentUri(stringArg(args, "file"));
  const selected = selectCodeAction(actions, actionArgs);
  const applied = await applySelectedCodeAction(
    selected,
    optionalBooleanArg(args, "executeCommand", false),
    {
      toolName,
      operation: `Apply ${kind}`,
      files: [fallbackUri],
      actionTitle: selected.action.title
    }
  );
  return { ...applied, selectedAction: await normalizeCodeAction(selected.action, selected.index) };
}

function selectCodeAction(
  actions: CodeActionLike[],
  args: Record<string, unknown>
): { action: CodeActionLike; index: number } {
  const actionIndex = boundedInteger(args.actionIndex, "actionIndex", { defaultValue: 1, maximum: 100 }) - 1;
  const title = optionalStringArg(args, "title");
  const exactTitle = optionalBooleanArg(args, "exactTitle");
  const selectedIndex = title
    ? actions.findIndex(action => exactTitle
        ? action.title === title
        : action.title.toLowerCase().includes(title.toLowerCase()))
    : actionIndex;
  const action = actions[selectedIndex];
  if (!action) {
    throw new Error("No matching code action was found.");
  }
  if (isCodeAction(action) && action.disabled) {
    throw new Error(`Code action is disabled: ${action.disabled.reason}`);
  }
  return { action, index: selectedIndex };
}

async function applySelectedCodeAction(
  selected: { action: CodeActionLike; index: number },
  executeCommand: boolean,
  approval: WriteApprovalRequest
): Promise<{ approved: boolean; appliedEdit: boolean; executedCommand: boolean }> {
  const { action } = selected;
  const edit = isCodeAction(action) ? action.edit : undefined;
  const command = isCodeAction(action) ? action.command : action;
  const commandToExecute = executeCommand ? command : undefined;
  if (edit) {
    throw new Error(
      "Provider WorkspaceEdit application is preview-only because the stable VS Code API cannot enumerate file, notebook, snippet, or other hidden operations safely. Nothing was applied."
    );
  }
  if (command && !commandToExecute) {
    throw new Error("The selected action is command-only. Set executeCommand to true to request separate command approval.");
  }
  if (!commandToExecute) {
    return { approved: false, appliedEdit: false, executedCommand: false };
  }
  if (commandToExecute && !await requestCommandExecutionApproval(commandToExecute, approval)) {
    return { approved: false, appliedEdit: false, executedCommand: false };
  }
  await withTimeout(
    vscode.commands.executeCommand(commandToExecute.command, ...(commandToExecute.arguments ?? [])),
    30_000,
    "The approved VS Code command did not finish within 30 seconds."
  );
  return { approved: true, appliedEdit: false, executedCommand: true };
}

export async function formatDocument(args: Record<string, unknown>, options: ToolOptions): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const edits = await executeProviderCommand<vscode.TextEdit[]>(
    "vscode.executeFormatDocumentProvider",
    uri,
    formattingOptions(args)
  );
  return previewOrApplyTextEdits(uri, edits ?? [], args, options, "format_document");
}

export async function formatRange(args: Record<string, unknown>, options: ToolOptions): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const edits = await executeProviderCommand<vscode.TextEdit[]>(
    "vscode.executeFormatRangeProvider",
    uri,
    rangeArg(args, document),
    formattingOptions(args)
  );
  return previewOrApplyTextEdits(uri, edits ?? [], args, options, "format_range");
}

export async function formatOnType(args: Record<string, unknown>, options: ToolOptions): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const edits = await executeProviderCommand<vscode.TextEdit[]>(
    "vscode.executeFormatOnTypeProvider",
    uri,
    positionArg(args, document),
    stringArg(args, "triggerCharacter"),
    formattingOptions(args)
  );
  return previewOrApplyTextEdits(uri, edits ?? [], args, options, "format_on_type");
}

async function previewOrApplyTextEdits(
  uri: vscode.Uri,
  edits: vscode.TextEdit[],
  args: Record<string, unknown>,
  options: ToolOptions,
  toolName: string
): Promise<object> {
  const workspaceEdit = new vscode.WorkspaceEdit();
  workspaceEdit.set(uri, edits);
  const validation = await ensureWorkspaceEditCanBeApplied(workspaceEdit);
  const normalized = normalizeTextEditsPreview(edits);
  if (!optionalBooleanArg(args, "apply")) {
    return { applied: false, truncated: normalized.truncated, edits: normalized.edits };
  }
  ensureWritesAllowed(options);
  const approved = await requestWriteApproval({
    toolName,
    operation: "Apply formatting edits",
    files: [uri],
    editCount: validation.editCount,
    insertedBytes: validation.insertedBytes,
    deletedCharacters: validation.deletedCharacters
  });
  if (!approved) {
    return { approved: false, applied: false, edits: normalized.edits, truncated: normalized.truncated };
  }
  await ensureWorkspaceEditCanBeApplied(workspaceEdit, validation.versions);
  return {
    approved: true,
    applied: await vscode.workspace.applyEdit(workspaceEdit),
    edits: normalized.edits,
    truncated: normalized.truncated
  };
}

function normalizeTextEditsPreview(edits: vscode.TextEdit[]): { edits: object[]; truncated: boolean } {
  const maximumEdits = 1_000;
  const maximumCharacters = 4_194_304;
  let remainingCharacters = maximumCharacters;
  let truncated = edits.length > maximumEdits;
  const normalized: object[] = [];
  for (const edit of edits.slice(0, maximumEdits)) {
    const maximum = Math.min(8_192, remainingCharacters);
    const newText = edit.newText.length <= maximum
      ? edit.newText
      : maximum < 4 ? "" : `${edit.newText.slice(0, maximum - 3)}...`;
    if (newText.length < edit.newText.length) {
      truncated = true;
    }
    remainingCharacters -= newText.length;
    normalized.push({ ...normalizeRange(edit.range), newText });
  }
  return { edits: normalized, truncated };
}

export async function rename(
  args: Record<string, unknown>,
  options: ToolOptions & { forcePreviewOnly?: boolean }
): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const newName = stringArg(args, "newName");
  const edit = await executeProviderCommand<vscode.WorkspaceEdit>(
    "vscode.executeDocumentRenameProvider",
    uri,
    positionArg(args, document),
    newName
  );
  const normalized = await normalizeWorkspaceEdit(edit);
  if (!optionalBooleanArg(args, "apply") || options.forcePreviewOnly) {
    return { applied: false, edit: normalized };
  }
  ensureWritesAllowed(options);
  throw new Error(
    "Semantic rename application is preview-only because the stable VS Code API cannot enumerate every WorkspaceEdit operation safely. Use preview_rename and apply the reviewed rename in VS Code."
  );
}

export function normalizePrepareRename(
  value: vscode.Range | { range: vscode.Range; placeholder: string } | undefined
): object | undefined {
  if (!value) {
    return undefined;
  }
  return "range" in value
    ? { placeholder: value.placeholder, ...normalizeRange(value.range) }
    : normalizeRange(value);
}
