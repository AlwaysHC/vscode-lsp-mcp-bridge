import * as path from "node:path";
import * as vscode from "vscode";

interface ToolOptions {
  allowWrites: boolean;
}

export async function runLanguageTool(
  name: string,
  args: Record<string, unknown>,
  options: ToolOptions
): Promise<unknown> {
  switch (name) {
    case "find_references":
      return locations(await executeAtPosition<vscode.Location[]>("vscode.executeReferenceProvider", args));
    case "go_to_definition":
      return locations(await executeAtPosition<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDefinitionProvider", args));
    case "go_to_declaration":
      return locations(await executeAtPosition<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDeclarationProvider", args));
    case "go_to_implementation":
      return locations(await executeAtPosition<Array<vscode.Location | vscode.LocationLink>>("vscode.executeImplementationProvider", args));
    case "go_to_type_definition":
      return locations(await executeAtPosition<Array<vscode.Location | vscode.LocationLink>>("vscode.executeTypeDefinitionProvider", args));
    case "hover":
      return normalizeHovers(await executeAtPosition<vscode.Hover[]>("vscode.executeHoverProvider", args));
    case "document_symbols":
      return normalizeDocumentSymbols(await executeDocument<vscode.DocumentSymbol[]>("vscode.executeDocumentSymbolProvider", args));
    case "workspace_symbols":
      return normalizeWorkspaceSymbols(
        await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
          "vscode.executeWorkspaceSymbolProvider",
          stringArg(args, "query")
        )
      );
    case "document_highlights":
      return normalizeDocumentHighlights(await executeAtPosition<vscode.DocumentHighlight[]>("vscode.executeDocumentHighlights", args));
    case "diagnostics":
      return diagnostics(args);
    case "call_hierarchy":
      return callHierarchy(args);
    case "completion":
      return completion(args);
    case "signature_help":
      return executeAtPosition<vscode.SignatureHelp>("vscode.executeSignatureHelpProvider", args);
    case "code_lens":
      return normalizeCodeLens(await executeDocument<vscode.CodeLens[]>("vscode.executeCodeLensProvider", args));
    case "inlay_hints":
      return inlayHints(args);
    case "code_actions":
      return codeActions(args);
    case "format_document":
      return formatDocument(args, options);
    case "prepare_rename":
      return executeAtPosition<unknown>("vscode.prepareRename", args);
    case "preview_rename":
      return rename(args, { ...options, forcePreviewOnly: true });
    case "rename_symbol":
      return rename(args, options);
    default:
      throw new Error(`Unknown language tool: ${name}`);
  }
}

async function executeAtPosition<T>(command: string, args: Record<string, unknown>): Promise<T | undefined> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const position = new vscode.Position(numberArg(args, "line"), numberArg(args, "character"));
  return vscode.commands.executeCommand<T>(command, uri, position);
}

async function executeDocument<T>(command: string, args: Record<string, unknown>): Promise<T | undefined> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  return vscode.commands.executeCommand<T>(command, uri);
}

async function openDocumentUri(file: string): Promise<vscode.Uri> {
  const resolved = path.isAbsolute(file) ? file : path.join(firstWorkspaceFolder(), file);
  const uri = vscode.Uri.file(resolved);
  await vscode.workspace.openTextDocument(uri);
  return uri;
}

function firstWorkspaceFolder(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error("No workspace folder is open in VS Code.");
  }

  return folder.uri.fsPath;
}

function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Expected string argument: ${key}`);
  }

  return value;
}

function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`Expected optional string argument: ${key}`);
  }

  return value;
}

function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Expected non-negative integer argument: ${key}`);
  }

  return value;
}

function optionalBooleanArg(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Expected optional boolean argument: ${key}`);
  }

  return value;
}

function normalizeRange(range: vscode.Range): object {
  return {
    start: {
      line: range.start.line,
      character: range.start.character
    },
    end: {
      line: range.end.line,
      character: range.end.character
    }
  };
}

function normalizeLocation(value: vscode.Location | vscode.LocationLink): object {
  if ("targetUri" in value) {
    return {
      uri: value.targetUri.fsPath,
      range: normalizeRange(value.targetRange),
      selectionRange: normalizeRange(value.targetSelectionRange ?? value.targetRange)
    };
  }

  return {
    uri: value.uri.fsPath,
    range: normalizeRange(value.range)
  };
}

function locations(values: Array<vscode.Location | vscode.LocationLink> | undefined): object[] {
  return (values ?? []).map(normalizeLocation);
}

function normalizeHovers(values: vscode.Hover[] | undefined): object[] {
  return (values ?? []).map(hover => ({
    contents: hover.contents.map(markedStringToText),
    range: hover.range ? normalizeRange(hover.range) : undefined
  }));
}

function markedStringToText(value: vscode.MarkdownString | vscode.MarkedString): string {
  if (typeof value === "string") {
    return value;
  }

  if ("language" in value) {
    return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
  }

  return value.value;
}

function normalizeDocumentSymbols(values: vscode.DocumentSymbol[] | undefined): object[] {
  return (values ?? []).map(symbol => ({
    name: symbol.name,
    detail: symbol.detail,
    kind: vscode.SymbolKind[symbol.kind],
    range: normalizeRange(symbol.range),
    selectionRange: normalizeRange(symbol.selectionRange),
    children: normalizeDocumentSymbols(symbol.children)
  }));
}

function normalizeWorkspaceSymbols(values: vscode.SymbolInformation[] | undefined): object[] {
  return (values ?? []).map(symbol => ({
    name: symbol.name,
    containerName: symbol.containerName,
    kind: vscode.SymbolKind[symbol.kind],
    location: normalizeLocation(symbol.location)
  }));
}

function normalizeDocumentHighlights(values: vscode.DocumentHighlight[] | undefined): object[] {
  return (values ?? []).map(highlight => ({
    kind: highlight.kind === undefined ? undefined : vscode.DocumentHighlightKind[highlight.kind],
    range: normalizeRange(highlight.range)
  }));
}

async function diagnostics(args: Record<string, unknown>): Promise<object[]> {
  const file = optionalStringArg(args, "file");
  const entries: Array<[vscode.Uri, vscode.Diagnostic[]]> = [];

  if (file) {
    const uri = await openDocumentUri(file);
    entries.push([uri, vscode.languages.getDiagnostics(uri)]);
  } else {
    entries.push(...vscode.languages.getDiagnostics());
  }

  return entries.map(([uri, diagnosticsForUri]) => ({
    uri: uri.fsPath,
    diagnostics: diagnosticsForUri.map(diagnostic => ({
      message: diagnostic.message,
      severity: vscode.DiagnosticSeverity[diagnostic.severity],
      source: diagnostic.source,
      code: diagnostic.code,
      range: normalizeRange(diagnostic.range)
    }))
  }));
}

async function callHierarchy(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const position = new vscode.Position(numberArg(args, "line"), numberArg(args, "character"));
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    "vscode.prepareCallHierarchy",
    uri,
    position
  );

  const result = [];
  for (const item of items ?? []) {
    const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
      "vscode.provideIncomingCalls",
      item
    );
    const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
      "vscode.provideOutgoingCalls",
      item
    );

    result.push({
      item: normalizeCallHierarchyItem(item),
      incoming: (incoming ?? []).map(call => ({
        from: normalizeCallHierarchyItem(call.from),
        fromRanges: call.fromRanges.map(normalizeRange)
      })),
      outgoing: (outgoing ?? []).map(call => ({
        to: normalizeCallHierarchyItem(call.to),
        fromRanges: call.fromRanges.map(normalizeRange)
      }))
    });
  }

  return result;
}

function normalizeCallHierarchyItem(item: vscode.CallHierarchyItem): object {
  return {
    name: item.name,
    detail: item.detail,
    kind: vscode.SymbolKind[item.kind],
    uri: item.uri.fsPath,
    range: normalizeRange(item.range),
    selectionRange: normalizeRange(item.selectionRange)
  };
}

async function completion(args: Record<string, unknown>): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const position = new vscode.Position(numberArg(args, "line"), numberArg(args, "character"));
  const triggerCharacter = optionalStringArg(args, "triggerCharacter");
  const itemResolveCount = typeof args.itemResolveCount === "number" ? args.itemResolveCount : 20;
  const list = await vscode.commands.executeCommand<vscode.CompletionList>(
    "vscode.executeCompletionItemProvider",
    uri,
    position,
    triggerCharacter,
    itemResolveCount
  );

  return {
    isIncomplete: list?.isIncomplete ?? false,
    items: (list?.items ?? []).map(item => ({
      label: typeof item.label === "string" ? item.label : item.label.label,
      kind: item.kind === undefined ? undefined : vscode.CompletionItemKind[item.kind],
      detail: item.detail,
      documentation: typeof item.documentation === "string" ? item.documentation : item.documentation?.value
    }))
  };
}

function normalizeCodeLens(values: vscode.CodeLens[] | undefined): object[] {
  return (values ?? []).map(codeLens => ({
    range: normalizeRange(codeLens.range),
    command: codeLens.command
      ? {
          title: codeLens.command.title,
          command: codeLens.command.command
        }
      : undefined
  }));
}

async function inlayHints(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const range = new vscode.Range(0, 0, document.lineCount, 0);
  const values = await vscode.commands.executeCommand<vscode.InlayHint[]>(
    "vscode.executeInlayHintProvider",
    uri,
    range
  );

  return (values ?? []).map(hint => ({
    label: typeof hint.label === "string" ? hint.label : hint.label.map(part => part.value).join(""),
    kind: hint.kind === undefined ? undefined : vscode.InlayHintKind[hint.kind],
    position: {
      line: hint.position.line,
      character: hint.position.character
    },
    tooltip: typeof hint.tooltip === "string" ? hint.tooltip : hint.tooltip?.value
  }));
}

async function codeActions(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const range = new vscode.Range(0, 0, document.lineCount, 0);
  const actions = await vscode.commands.executeCommand<Array<vscode.CodeAction | vscode.Command>>(
    "vscode.executeCodeActionProvider",
    uri,
    range,
    undefined,
    100
  );

  return (actions ?? []).map(action => ({
    title: action.title,
    kind: isCodeAction(action) ? action.kind?.value : undefined,
    command: isCodeAction(action) ? action.command?.command : action.command
  }));
}

function isCodeAction(action: vscode.CodeAction | vscode.Command): action is vscode.CodeAction {
  return "diagnostics" in action || "edit" in action || "kind" in action;
}

async function formatDocument(args: Record<string, unknown>, options: ToolOptions): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    "vscode.executeFormatDocumentProvider",
    uri,
    {
      tabSize: 4,
      insertSpaces: true
    }
  );

  const normalized = normalizeTextEdits(edits ?? []);
  const apply = optionalBooleanArg(args, "apply");
  if (apply) {
    ensureWritesAllowed(options);
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of edits ?? []) {
      workspaceEdit.replace(uri, edit.range, edit.newText);
    }
    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    return { applied, edits: normalized };
  }

  return { applied: false, edits: normalized };
}

async function rename(
  args: Record<string, unknown>,
  options: ToolOptions & { forcePreviewOnly?: boolean }
): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const position = new vscode.Position(numberArg(args, "line"), numberArg(args, "character"));
  const newName = stringArg(args, "newName");
  const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
    "vscode.executeDocumentRenameProvider",
    uri,
    position,
    newName
  );

  const normalized = normalizeWorkspaceEdit(edit);
  const apply = optionalBooleanArg(args, "apply") && !options.forcePreviewOnly;
  if (apply) {
    ensureWritesAllowed(options);
    const applied = edit ? await vscode.workspace.applyEdit(edit) : false;
    return { applied, edit: normalized };
  }

  return { applied: false, edit: normalized };
}

function ensureWritesAllowed(options: ToolOptions): void {
  if (!options.allowWrites) {
    throw new Error("Write tools are disabled. Enable vscodeLspMcpBridge.enableWriteTools to apply edits.");
  }
}

function normalizeTextEdits(values: vscode.TextEdit[]): object[] {
  return values.map(edit => ({
    range: normalizeRange(edit.range),
    newText: edit.newText
  }));
}

function normalizeWorkspaceEdit(edit: vscode.WorkspaceEdit | undefined): object {
  if (!edit) {
    return { entries: [] };
  }

  return {
    entries: edit.entries().map(([uri, edits]) => ({
      uri: uri.fsPath,
      edits: normalizeTextEdits(edits)
    }))
  };
}
