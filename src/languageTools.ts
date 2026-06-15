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
    case "call_hierarchy_for_symbol":
      return callHierarchyForSymbol(args);
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
  const position = positionArg(args);
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

function oneBasedNumberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Expected one-based positive integer argument: ${key}`);
  }

  return value;
}

function positionArg(args: Record<string, unknown>): vscode.Position {
  return new vscode.Position(
    oneBasedNumberArg(args, "line") - 1,
    oneBasedNumberArg(args, "column") - 1
  );
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

function optionalPositiveIntegerArg(args: Record<string, unknown>, key: string, defaultValue: number): number {
  const value = args[key];
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Expected optional positive integer argument: ${key}`);
  }

  return value;
}

function normalizeRange(range: vscode.Range): object {
  return {
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1
  };
}

function normalizeLocation(value: vscode.Location | vscode.LocationLink): object {
  if ("targetUri" in value) {
    const selectionRange = value.targetSelectionRange ?? value.targetRange;
    return {
      file: value.targetUri.fsPath,
      ...normalizeRange(selectionRange)
    };
  }

  return {
    file: value.uri.fsPath,
    ...normalizeRange(value.range)
  };
}

function locations(values: Array<vscode.Location | vscode.LocationLink> | undefined): object[] {
  return (values ?? []).map(normalizeLocation);
}

function normalizeHovers(values: vscode.Hover[] | undefined): object[] {
  return (values ?? []).map(hover => ({
    text: hover.contents.map(markedStringToText).join("\n\n"),
    ...(hover.range ? normalizeRange(hover.range) : {})
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
    ...normalizeRange(symbol.selectionRange),
    children: normalizeDocumentSymbols(symbol.children)
  }));
}

function normalizeWorkspaceSymbols(values: vscode.SymbolInformation[] | undefined): object[] {
  return (values ?? []).map(normalizeWorkspaceSymbol);
}

function normalizeWorkspaceSymbol(symbol: vscode.SymbolInformation): object {
  return {
    name: symbol.name,
    containerName: symbol.containerName,
    kind: vscode.SymbolKind[symbol.kind],
    ...normalizeLocation(symbol.location)
  };
}

function normalizeDocumentHighlights(values: vscode.DocumentHighlight[] | undefined): object[] {
  return (values ?? []).map(highlight => ({
    kind: highlight.kind === undefined ? undefined : vscode.DocumentHighlightKind[highlight.kind],
    ...normalizeRange(highlight.range)
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
    file: uri.fsPath,
    diagnostics: diagnosticsForUri.map(diagnostic => ({
      message: diagnostic.message,
      severity: vscode.DiagnosticSeverity[diagnostic.severity],
      source: diagnostic.source,
      code: diagnostic.code,
      ...normalizeRange(diagnostic.range)
    }))
  }));
}

async function callHierarchy(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const position = positionArg(args);
  return callHierarchyAt(uri, position);
}

async function callHierarchyForSymbol(args: Record<string, unknown>): Promise<object> {
  const query = stringArg(args, "query");
  const containerName = optionalStringArg(args, "containerName");
  const file = optionalStringArg(args, "file");
  const kind = optionalStringArg(args, "kind");
  const maxCandidates = optionalPositiveIntegerArg(args, "maxCandidates", 10);
  const rankedSymbols = rankWorkspaceSymbols(await workspaceSymbolsForQuery(query), {
    query,
    containerName,
    file,
    kind
  });
  const candidates = rankedSymbols.slice(0, maxCandidates);

  for (const candidate of candidates) {
    const hierarchy = await callHierarchyAt(candidate.symbol.location.uri, candidate.symbol.location.range.start);
    if (hierarchy.length > 0) {
      return {
        query,
        selectedSymbol: normalizeWorkspaceSymbol(candidate.symbol),
        candidates: candidates.map(value => normalizeWorkspaceSymbol(value.symbol)),
        callHierarchy: hierarchy
      };
    }
  }

  return {
    query,
    selectedSymbol: candidates[0] ? normalizeWorkspaceSymbol(candidates[0].symbol) : undefined,
    candidates: candidates.map(value => normalizeWorkspaceSymbol(value.symbol)),
    callHierarchy: []
  };
}

async function workspaceSymbolsForQuery(query: string): Promise<vscode.SymbolInformation[]> {
  const queryParts = query.split(".").filter(Boolean);
  const queries = [query, queryParts[queryParts.length - 1]].filter(
    (value, index, values): value is string => Boolean(value) && values.indexOf(value) === index
  );
  const symbols = new Map<string, vscode.SymbolInformation>();

  for (const workspaceQuery of queries) {
    const values = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      "vscode.executeWorkspaceSymbolProvider",
      workspaceQuery
    );

    for (const symbol of values ?? []) {
      symbols.set(workspaceSymbolKey(symbol), symbol);
    }
  }

  return [...symbols.values()];
}

function workspaceSymbolKey(symbol: vscode.SymbolInformation): string {
  return [
    symbol.name,
    symbol.containerName,
    symbol.location.uri.toString(),
    symbol.location.range.start.line,
    symbol.location.range.start.character
  ].join("|");
}

function rankWorkspaceSymbols(
  symbols: vscode.SymbolInformation[],
  hints: { query: string; containerName?: string; file?: string; kind?: string }
): Array<{ symbol: vscode.SymbolInformation; score: number }> {
  const query = hints.query.toLowerCase();
  const queryParts = hints.query.split(".").filter(Boolean);
  const requestedName = (queryParts[queryParts.length - 1] ?? hints.query).toLowerCase();
  const requestedContainer = (hints.containerName ?? queryParts.slice(0, -1).join(".")).toLowerCase();
  const requestedFile = hints.file ? normalizePathForComparison(resolveFilePath(hints.file)) : undefined;
  const requestedKind = hints.kind?.toLowerCase();

  return symbols
    .filter(symbol => {
      if (requestedFile && normalizePathForComparison(symbol.location.uri.fsPath) !== requestedFile) {
        return false;
      }

      if (hints.containerName && !symbol.containerName.toLowerCase().includes(hints.containerName.toLowerCase())) {
        return false;
      }

      if (requestedKind && vscode.SymbolKind[symbol.kind].toLowerCase() !== requestedKind) {
        return false;
      }

      return true;
    })
    .map(symbol => {
      const name = symbol.name.toLowerCase();
      const container = symbol.containerName.toLowerCase();
      const symbolKind = vscode.SymbolKind[symbol.kind];
      let score = 0;

      if (name === requestedName) {
        score += 120;
      } else if (name.includes(requestedName) || requestedName.includes(name)) {
        score += 60;
      } else if (query.includes(name)) {
        score += 20;
      }

      if (requestedContainer) {
        if (container === requestedContainer) {
          score += 100;
        } else if (container.includes(requestedContainer) || requestedContainer.includes(container)) {
          score += 50;
        }
      }

      if (["Method", "Function", "Constructor"].includes(symbolKind)) {
        score += 25;
      }

      if (requestedKind && symbolKind.toLowerCase() === requestedKind) {
        score += 50;
      }

      return { symbol, score };
    })
    .sort((left, right) => right.score - left.score);
}

function resolveFilePath(file: string): string {
  return path.isAbsolute(file) ? file : path.join(firstWorkspaceFolder(), file);
}

function normalizePathForComparison(file: string): string {
  return path.normalize(file).toLowerCase();
}

async function callHierarchyAt(uri: vscode.Uri, position: vscode.Position): Promise<object[]> {
  await vscode.workspace.openTextDocument(uri);
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
        caller: normalizeCallHierarchyItem(call.from),
        callSites: call.fromRanges.map(normalizeRange)
      })),
      outgoing: (outgoing ?? []).map(call => ({
        callee: normalizeCallHierarchyItem(call.to),
        callSites: call.fromRanges.map(normalizeRange)
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
    file: item.uri.fsPath,
    ...normalizeRange(item.selectionRange)
  };
}

async function completion(args: Record<string, unknown>): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const position = positionArg(args);
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
    ...normalizeRange(codeLens.range),
    command: codeLens.command
      ? {
          title: codeLens.command.title
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
    line: hint.position.line + 1,
    column: hint.position.character + 1,
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
    kind: isCodeAction(action) ? action.kind?.value : undefined
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
  const position = positionArg(args);
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
    ...normalizeRange(edit.range),
    newText: edit.newText
  }));
}

function normalizeWorkspaceEdit(edit: vscode.WorkspaceEdit | undefined): object {
  if (!edit) {
    return { entries: [] };
  }

  return {
    entries: edit.entries().map(([uri, edits]) => ({
      file: uri.fsPath,
      edits: normalizeTextEdits(edits)
    }))
  };
}
