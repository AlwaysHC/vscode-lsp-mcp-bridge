import * as path from "node:path";
import * as vscode from "vscode";

interface ToolOptions {
  allowWrites: boolean;
}

interface SymbolHints {
  query: string;
  containerName?: string;
  file?: string;
  kind?: string;
}

interface ResolvedSymbolQuery {
  query: string;
  selectedSymbol?: vscode.SymbolInformation;
  candidates: vscode.SymbolInformation[];
}

interface FlattenedDocumentSymbol {
  symbol: vscode.DocumentSymbol;
  containerName: string;
  uri: vscode.Uri;
}

interface WriteApprovalRequest {
  toolName: string;
  operation: string;
  files: vscode.Uri[];
  actionTitle?: string;
  command?: vscode.Command;
  editCount?: number;
}

type CodeActionLike = vscode.CodeAction | vscode.Command;

const sourceLineMaxLength = 240;

export async function runLanguageTool(
  name: string,
  args: Record<string, unknown>,
  options: ToolOptions
): Promise<unknown> {
  switch (name) {
    case "semantic_navigation_guide":
      return semanticNavigationGuide();
    case "find_references":
      return locationsWithSourceLines(await executeAtPosition<vscode.Location[]>("vscode.executeReferenceProvider", args));
    case "find_references_for_symbol":
      return referencesForSymbol(args);
    case "go_to_definition":
      return locationsWithSourceLines(await executeAtPosition<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDefinitionProvider", args));
    case "find_definition_for_symbol":
      return definitionForSymbol(args);
    case "go_to_declaration":
      return locationsWithSourceLines(await executeAtPosition<Array<vscode.Location | vscode.LocationLink>>("vscode.executeDeclarationProvider", args));
    case "go_to_implementation":
      return locationsWithSourceLines(await executeAtPosition<Array<vscode.Location | vscode.LocationLink>>("vscode.executeImplementationProvider", args));
    case "go_to_type_definition":
      return locationsWithSourceLines(await executeAtPosition<Array<vscode.Location | vscode.LocationLink>>("vscode.executeTypeDefinitionProvider", args));
    case "hover":
      return normalizeHovers(await executeAtPosition<vscode.Hover[]>("vscode.executeHoverProvider", args));
    case "document_symbols":
      return normalizeDocumentSymbols(
        await executeDocument<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>("vscode.executeDocumentSymbolProvider", args)
      );
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
    case "find_callers_for_symbol":
      return callRelationshipsForSymbol(args, "incoming");
    case "find_callees_for_symbol":
      return callRelationshipsForSymbol(args, "outgoing");
    case "call_hierarchy_for_symbol":
      return hierarchyForSymbol(args, "call");
    case "call_hierarchy":
      return callHierarchy(args);
    case "type_hierarchy_for_symbol":
      return hierarchyForSymbol(args, "type");
    case "type_hierarchy":
      return typeHierarchy(args);
    case "selection_ranges":
      return selectionRanges(args);
    case "document_links":
      return documentLinks(args);
    case "semantic_tokens":
      return semanticTokens(args, false);
    case "range_semantic_tokens":
      return semanticTokens(args, true);
    case "folding_ranges":
      return foldingRanges(args);
    case "document_colors":
      return documentColors(args);
    case "color_presentations":
      return colorPresentations(args);
    case "inline_values":
      return inlineValues(args);
    case "completion":
      return completion(args);
    case "signature_help":
      return signatureHelp(args);
    case "code_lens":
      return codeLens(args);
    case "inlay_hints":
      return inlayHints(args);
    case "code_actions":
      return codeActions(args);
    case "apply_code_action":
      return applyCodeAction(args, options);
    case "organize_imports":
      return sourceAction(args, options, vscode.CodeActionKind.SourceOrganizeImports.value, "organize_imports");
    case "fix_all":
      return sourceAction(args, options, vscode.CodeActionKind.SourceFixAll.value, "fix_all");
    case "format_document":
      return formatDocument(args, options);
    case "format_range":
      return formatRange(args, options);
    case "format_on_type":
      return formatOnType(args, options);
    case "prepare_rename":
      return normalizePrepareRename(await executeAtPosition<vscode.Range | { range: vscode.Range; placeholder: string }>("vscode.prepareRename", args));
    case "preview_rename":
      return rename(args, { ...options, forcePreviewOnly: true });
    case "rename_symbol":
      return rename(args, options);
    default:
      throw new Error(`Unknown language tool: ${name}`);
  }
}

function semanticNavigationGuide(): object {
  return {
    purpose: "Use VS Code language providers for semantic code navigation before text search.",
    primaryRules: [
      "For 'who calls X', 'incoming calls', 'callers', or call-site questions with a known symbol name, call find_callers_for_symbol first.",
      "For 'what does X call', 'outgoing calls', or callees with a known symbol name, call find_callees_for_symbol first.",
      "For symbol references by name, call find_references_for_symbol first. Use find_references only when you already have file, line, and column.",
      "For definitions by name, call find_definition_for_symbol first. Use go_to_definition only when you already have file, line, and column.",
      "For type hierarchy by name, call type_hierarchy_for_symbol first.",
      "Use workspace_symbols or document_symbols to resolve ambiguous names before falling back to rg, grep, or raw file search."
    ],
    fallbackRules: [
      "Use text search only when the user asks for text mentions, the language provider returns no usable semantic result, or the file is not language-provider backed.",
      "When falling back to text search, say that it is a fallback rather than a semantic result."
    ],
    resultUsage: [
      "Tool results use one-based editor line and column values.",
      "Prefer returned file, line, column, and sourceLine fields directly in user-facing answers."
    ]
  };
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
  const resolved = resolveFilePath(file);
  const uri = vscode.Uri.file(resolved);
  await vscode.workspace.openTextDocument(uri);
  return uri;
}

function resolveFilePath(file: string): string {
  return path.isAbsolute(file) ? file : path.join(firstWorkspaceFolder(), file);
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

function optionalOneBasedNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`Expected optional one-based positive integer argument: ${key}`);
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

function optionalNonNegativeIntegerArg(args: Record<string, unknown>, key: string, defaultValue: number): number {
  const value = args[key];
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Expected optional non-negative integer argument: ${key}`);
  }

  return value;
}

function optionalNumberArg(args: Record<string, unknown>, key: string, defaultValue: number): number {
  const value = args[key];
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`Expected optional number argument: ${key}`);
  }

  return value;
}

function optionalBooleanArg(args: Record<string, unknown>, key: string, defaultValue = false): boolean {
  const value = args[key];
  if (value === undefined || value === null) {
    return defaultValue;
  }

  if (typeof value !== "boolean") {
    throw new Error(`Expected optional boolean argument: ${key}`);
  }

  return value;
}

function positionArg(args: Record<string, unknown>): vscode.Position {
  return new vscode.Position(
    oneBasedNumberArg(args, "line") - 1,
    oneBasedNumberArg(args, "column") - 1
  );
}

function rangeArg(args: Record<string, unknown>): vscode.Range {
  return new vscode.Range(
    oneBasedNumberArg(args, "startLine") - 1,
    oneBasedNumberArg(args, "startColumn") - 1,
    oneBasedNumberArg(args, "endLine") - 1,
    oneBasedNumberArg(args, "endColumn") - 1
  );
}

function optionalRangeArg(args: Record<string, unknown>, document: vscode.TextDocument): vscode.Range {
  if (optionalOneBasedNumberArg(args, "startLine") === undefined) {
    return fullDocumentRange(document);
  }

  return rangeArg(args);
}

function stoppedLocationArg(args: Record<string, unknown>, fallback: vscode.Range): vscode.Range {
  const stoppedLine = optionalOneBasedNumberArg(args, "stoppedLine");
  const stoppedColumn = optionalOneBasedNumberArg(args, "stoppedColumn");
  if (stoppedLine === undefined && stoppedColumn === undefined) {
    return fallback;
  }

  if (stoppedLine === undefined || stoppedColumn === undefined) {
    throw new Error("stoppedLine and stoppedColumn must be provided together.");
  }

  const position = new vscode.Position(stoppedLine - 1, stoppedColumn - 1);
  return new vscode.Range(position, position);
}

function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const lastLine = Math.max(0, document.lineCount - 1);
  return new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).range.end.character);
}

function formattingOptions(args: Record<string, unknown>): vscode.FormattingOptions {
  return {
    tabSize: optionalPositiveIntegerArg(args, "tabSize", 4),
    insertSpaces: optionalBooleanArg(args, "insertSpaces", true)
  };
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
  const { uri, range } = locationTarget(value);
  return {
    file: uri.fsPath,
    ...normalizeRange(range)
  };
}

function locationTarget(value: vscode.Location | vscode.LocationLink): { uri: vscode.Uri; range: vscode.Range } {
  if ("targetUri" in value) {
    return {
      uri: value.targetUri,
      range: value.targetSelectionRange ?? value.targetRange
    };
  }

  return {
    uri: value.uri,
    range: value.range
  };
}

async function locationsWithSourceLines(values: Array<vscode.Location | vscode.LocationLink> | undefined): Promise<object[]> {
  return Promise.all((values ?? []).map(normalizeLocationWithSourceLine));
}

async function normalizeLocationWithSourceLine(value: vscode.Location | vscode.LocationLink): Promise<object> {
  const { uri, range } = locationTarget(value);
  return {
    file: uri.fsPath,
    ...normalizeRange(range),
    ...(await sourceLine(uri, range.start.line))
  };
}

async function sourceLine(uri: vscode.Uri, zeroBasedLine: number): Promise<{ sourceLine: string } | object> {
  try {
    const document = await openTextDocumentByUri(uri);
    return { sourceLine: truncateSourceLine(document.lineAt(zeroBasedLine).text.trim()) };
  } catch {
    return {};
  }
}

function truncateSourceLine(value: string): string {
  if (value.length <= sourceLineMaxLength) {
    return value;
  }

  return `${value.slice(0, sourceLineMaxLength - 3)}...`;
}

async function openTextDocumentByUri(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const openDocument = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
  return openDocument ?? vscode.workspace.openTextDocument(uri);
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

function markdownToText(value: string | vscode.MarkdownString | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return typeof value === "string" ? value : value.value;
}

function normalizeHovers(values: vscode.Hover[] | undefined): object[] {
  return (values ?? []).map(hover => ({
    text: hover.contents.map(markedStringToText).join("\n\n"),
    ...(hover.range ? normalizeRange(hover.range) : {})
  }));
}

function normalizeDocumentSymbols(values: Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined): object[] {
  return (values ?? []).map(symbol => {
    if ("location" in symbol) {
      return {
        name: symbol.name,
        containerName: symbol.containerName,
        kind: vscode.SymbolKind[symbol.kind],
        ...normalizeLocation(symbol.location)
      };
    }

    return {
      name: symbol.name,
      detail: symbol.detail,
      kind: vscode.SymbolKind[symbol.kind],
      range: normalizeRange(symbol.range),
      selection: normalizeRange(symbol.selectionRange),
      line: symbol.selectionRange.start.line + 1,
      column: symbol.selectionRange.start.character + 1,
      endLine: symbol.selectionRange.end.line + 1,
      endColumn: symbol.selectionRange.end.character + 1,
      children: normalizeDocumentSymbols(symbol.children)
    };
  });
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
      tags: diagnostic.tags?.map(tag => vscode.DiagnosticTag[tag]),
      relatedInformation: diagnostic.relatedInformation?.map(info => ({
        message: info.message,
        ...normalizeLocation(info.location)
      })),
      ...normalizeRange(diagnostic.range)
    }))
  }));
}

async function resolveWorkspaceSymbolQuery(args: Record<string, unknown>): Promise<ResolvedSymbolQuery> {
  const query = stringArg(args, "query");
  const hints = {
    query,
    containerName: optionalStringArg(args, "containerName"),
    file: optionalStringArg(args, "file"),
    kind: optionalStringArg(args, "kind")
  };
  const maxCandidates = optionalPositiveIntegerArg(args, "maxCandidates", 10);
  const candidates = rankWorkspaceSymbols(await symbolsForQuery(hints), hints).slice(0, maxCandidates);
  return {
    query,
    selectedSymbol: candidates[0]?.symbol,
    candidates: candidates.map(value => value.symbol)
  };
}

async function referencesForSymbol(args: Record<string, unknown>): Promise<object> {
  const resolved = await resolveWorkspaceSymbolQuery(args);
  const references = resolved.selectedSymbol
    ? await locationsWithSourceLines(
        await executeAtResolvedSymbol<vscode.Location[]>("vscode.executeReferenceProvider", resolved.selectedSymbol)
      )
    : [];

  return {
    query: resolved.query,
    selectedSymbol: resolved.selectedSymbol ? normalizeWorkspaceSymbol(resolved.selectedSymbol) : undefined,
    candidates: resolved.candidates.map(normalizeWorkspaceSymbol),
    references
  };
}

async function definitionForSymbol(args: Record<string, unknown>): Promise<object> {
  const resolved = await resolveWorkspaceSymbolQuery(args);
  const definitions = resolved.selectedSymbol
    ? await locationsWithSourceLines(
        await executeAtResolvedSymbol<Array<vscode.Location | vscode.LocationLink>>(
          "vscode.executeDefinitionProvider",
          resolved.selectedSymbol
        )
      )
    : [];

  return {
    query: resolved.query,
    selectedSymbol: resolved.selectedSymbol ? normalizeWorkspaceSymbol(resolved.selectedSymbol) : undefined,
    candidates: resolved.candidates.map(normalizeWorkspaceSymbol),
    definitions
  };
}

async function executeAtResolvedSymbol<T>(command: string, symbol: vscode.SymbolInformation): Promise<T | undefined> {
  await vscode.workspace.openTextDocument(symbol.location.uri);
  return vscode.commands.executeCommand<T>(command, symbol.location.uri, symbol.location.range.start);
}

async function hierarchyForSymbol(args: Record<string, unknown>, mode: "call" | "type"): Promise<object> {
  const resolved = await resolveWorkspaceSymbolQuery(args);

  for (const candidate of resolved.candidates) {
    const hierarchy = mode === "call"
      ? await callHierarchyAt(candidate.location.uri, candidate.location.range.start)
      : await typeHierarchyAt(candidate.location.uri, candidate.location.range.start);
    if (hierarchy.length > 0) {
      return {
        query: resolved.query,
        selectedSymbol: normalizeWorkspaceSymbol(candidate),
        candidates: resolved.candidates.map(normalizeWorkspaceSymbol),
        [mode === "call" ? "callHierarchy" : "typeHierarchy"]: hierarchy
      };
    }
  }

  return {
    query: resolved.query,
    selectedSymbol: resolved.selectedSymbol ? normalizeWorkspaceSymbol(resolved.selectedSymbol) : undefined,
    candidates: resolved.candidates.map(normalizeWorkspaceSymbol),
    [mode === "call" ? "callHierarchy" : "typeHierarchy"]: []
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

async function symbolsForQuery(hints: SymbolHints): Promise<vscode.SymbolInformation[]> {
  const symbols = new Map<string, vscode.SymbolInformation>();

  for (const symbol of await workspaceSymbolsForQuery(hints.query)) {
    symbols.set(workspaceSymbolKey(symbol), symbol);
  }

  for (const symbol of await documentSymbolsForQuery(hints)) {
    symbols.set(workspaceSymbolKey(symbol), symbol);
  }

  return [...symbols.values()];
}

async function documentSymbolsForQuery(hints: SymbolHints): Promise<vscode.SymbolInformation[]> {
  const uris = await documentSymbolSearchUris(hints);
  const result: vscode.SymbolInformation[] = [];

  for (const uri of uris) {
    const values = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
      "vscode.executeDocumentSymbolProvider",
      uri
    );

    for (const symbol of flattenDocumentSymbols(uri, values ?? [])) {
      result.push(new vscode.SymbolInformation(
        symbol.symbol.name,
        symbol.symbol.kind,
        symbol.containerName,
        new vscode.Location(uri, symbol.symbol.selectionRange)
      ));
    }
  }

  return result;
}

async function documentSymbolSearchUris(hints: SymbolHints): Promise<vscode.Uri[]> {
  if (hints.file) {
    return [await openDocumentUri(hints.file)];
  }

  const containerName = hints.containerName ?? hints.query.split(".").filter(Boolean).slice(0, -1).join(".");
  const leafContainerName = containerName.split(".").filter(Boolean).at(-1);
  if (!leafContainerName) {
    return [];
  }

  const files = await vscode.workspace.findFiles(
    `**/${leafContainerName}.*`,
    "**/{node_modules,bin,obj,dist,out,build,.git}/**",
    25
  );
  for (const uri of files) {
    await vscode.workspace.openTextDocument(uri);
  }

  return files;
}

function flattenDocumentSymbols(
  uri: vscode.Uri,
  values: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
  containerParts: string[] = []
): FlattenedDocumentSymbol[] {
  const result: FlattenedDocumentSymbol[] = [];

  for (const value of values) {
    if ("location" in value) {
      continue;
    }

    const containerName = containerParts.join(".");
    result.push({ symbol: value, containerName, uri });
    result.push(...flattenDocumentSymbols(uri, value.children, [...containerParts, value.name]));
  }

  return result;
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
  hints: SymbolHints
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

      if (["Method", "Function", "Constructor", "Class", "Interface", "Struct"].includes(symbolKind)) {
        score += 25;
      }

      if (requestedKind && symbolKind.toLowerCase() === requestedKind) {
        score += 50;
      }

      return { symbol, score };
    })
    .sort((left, right) => right.score - left.score);
}

function normalizePathForComparison(file: string): string {
  return path.normalize(file).toLowerCase();
}

async function callRelationshipsForSymbol(args: Record<string, unknown>, direction: "incoming" | "outgoing"): Promise<object> {
  const resolved = await resolveWorkspaceSymbolQuery(args);
  const relationshipKey = direction === "incoming" ? "callers" : "callees";
  let selectedSymbol = resolved.selectedSymbol;
  let relationships: object[] = [];

  for (const candidate of resolved.candidates) {
    relationships = await callRelationshipsAt(candidate.location.uri, candidate.location.range.start, direction);
    selectedSymbol = candidate;
    if (relationships.length > 0) {
      break;
    }
  }

  return {
    query: resolved.query,
    selectedSymbol: selectedSymbol ? normalizeWorkspaceSymbol(selectedSymbol) : undefined,
    candidates: resolved.candidates.map(normalizeWorkspaceSymbol),
    [relationshipKey]: relationships
  };
}

async function callRelationshipsAt(
  uri: vscode.Uri,
  position: vscode.Position,
  direction: "incoming" | "outgoing"
): Promise<object[]> {
  await vscode.workspace.openTextDocument(uri);
  const items = await vscode.commands.executeCommand<vscode.CallHierarchyItem[]>(
    "vscode.prepareCallHierarchy",
    uri,
    position
  );
  const result: object[] = [];

  for (const item of items ?? []) {
    if (direction === "incoming") {
      const incoming = await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>(
        "vscode.provideIncomingCalls",
        item
      );

      for (const call of incoming ?? []) {
        for (const range of call.fromRanges) {
          result.push({
            callerName: call.from.name,
            callerDetail: call.from.detail,
            callerKind: vscode.SymbolKind[call.from.kind],
            callerFile: call.from.uri.fsPath,
            callerLine: call.from.selectionRange.start.line + 1,
            callerColumn: call.from.selectionRange.start.character + 1,
            caller: normalizeCallHierarchyItem(call.from),
            callSite: await normalizeCallSite(call.from.uri, range)
          });
        }
      }
    } else {
      const outgoing = await vscode.commands.executeCommand<vscode.CallHierarchyOutgoingCall[]>(
        "vscode.provideOutgoingCalls",
        item
      );

      for (const call of outgoing ?? []) {
        for (const range of call.fromRanges) {
          result.push({
            calleeName: call.to.name,
            calleeDetail: call.to.detail,
            calleeKind: vscode.SymbolKind[call.to.kind],
            calleeFile: call.to.uri.fsPath,
            calleeLine: call.to.selectionRange.start.line + 1,
            calleeColumn: call.to.selectionRange.start.character + 1,
            callee: normalizeCallHierarchyItem(call.to),
            callSite: await normalizeCallSite(item.uri, range)
          });
        }
      }
    }
  }

  return result;
}

async function normalizeCallSite(uri: vscode.Uri, range: vscode.Range): Promise<object> {
  return {
    file: uri.fsPath,
    ...normalizeRange(range),
    ...(await sourceLine(uri, range.start.line))
  };
}

async function callHierarchy(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  return callHierarchyAt(uri, positionArg(args));
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
    range: normalizeRange(item.range),
    ...normalizeRange(item.selectionRange)
  };
}

async function typeHierarchy(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  return typeHierarchyAt(uri, positionArg(args));
}

async function typeHierarchyAt(uri: vscode.Uri, position: vscode.Position): Promise<object[]> {
  await vscode.workspace.openTextDocument(uri);
  const items = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
    "vscode.prepareTypeHierarchy",
    uri,
    position
  );

  const result = [];
  for (const item of items ?? []) {
    const supertypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
      "vscode.provideSupertypes",
      item
    );
    const subtypes = await vscode.commands.executeCommand<vscode.TypeHierarchyItem[]>(
      "vscode.provideSubtypes",
      item
    );

    result.push({
      item: normalizeTypeHierarchyItem(item),
      supertypes: (supertypes ?? []).map(normalizeTypeHierarchyItem),
      subtypes: (subtypes ?? []).map(normalizeTypeHierarchyItem)
    });
  }

  return result;
}

function normalizeTypeHierarchyItem(item: vscode.TypeHierarchyItem): object {
  return {
    name: item.name,
    detail: item.detail,
    kind: vscode.SymbolKind[item.kind],
    file: item.uri.fsPath,
    range: normalizeRange(item.range),
    ...normalizeRange(item.selectionRange)
  };
}

async function selectionRanges(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const values = await vscode.commands.executeCommand<vscode.SelectionRange[]>(
    "vscode.executeSelectionRangeProvider",
    uri,
    positionArg(args)
  );

  return (values ?? []).map(normalizeSelectionRange);
}

function normalizeSelectionRange(value: vscode.SelectionRange): object {
  return {
    ...normalizeRange(value.range),
    parent: value.parent ? normalizeSelectionRange(value.parent) : undefined
  };
}

async function documentLinks(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const linkResolveCount = optionalPositiveIntegerArg(args, "linkResolveCount", 100);
  const values = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
    "vscode.executeLinkProvider",
    uri,
    linkResolveCount
  );

  return (values ?? []).map(link => ({
    ...normalizeRange(link.range),
    target: link.target?.toString(true),
    tooltip: link.tooltip
  }));
}

async function semanticTokens(args: Record<string, unknown>, rangeMode: boolean): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const range = optionalRangeArg(args, document);
  const legend = rangeMode
    ? await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
        "vscode.provideDocumentRangeSemanticTokensLegend",
        uri,
        range
      )
    : await vscode.commands.executeCommand<vscode.SemanticTokensLegend>(
        "vscode.provideDocumentSemanticTokensLegend",
        uri
      );
  const tokens = rangeMode
    ? await vscode.commands.executeCommand<vscode.SemanticTokens>(
        "vscode.provideDocumentRangeSemanticTokens",
        uri,
        range
      )
    : await vscode.commands.executeCommand<vscode.SemanticTokens>(
        "vscode.provideDocumentSemanticTokens",
        uri
      );

  return {
    legend: legend ? {
      tokenTypes: legend.tokenTypes,
      tokenModifiers: legend.tokenModifiers
    } : undefined,
    resultId: tokens?.resultId,
    tokens: decodeSemanticTokens(tokens, legend)
  };
}

function decodeSemanticTokens(tokens: vscode.SemanticTokens | undefined, legend: vscode.SemanticTokensLegend | undefined): object[] {
  const data = Array.from(tokens?.data ?? []);
  const result = [];
  let line = 0;
  let character = 0;

  for (let index = 0; index + 4 < data.length; index += 5) {
    const deltaLine = data[index];
    const deltaStart = data[index + 1];
    const length = data[index + 2];
    const tokenType = data[index + 3];
    const tokenModifiers = data[index + 4];
    line += deltaLine;
    character = deltaLine === 0 ? character + deltaStart : deltaStart;

    result.push({
      line: line + 1,
      column: character + 1,
      endLine: line + 1,
      endColumn: character + length + 1,
      length,
      tokenType: legend?.tokenTypes[tokenType] ?? tokenType,
      tokenModifiers: decodeTokenModifiers(tokenModifiers, legend)
    });
  }

  return result;
}

function decodeTokenModifiers(bitset: number, legend: vscode.SemanticTokensLegend | undefined): Array<string | number> {
  if (!legend) {
    return bitset === 0 ? [] : [bitset];
  }

  return legend.tokenModifiers.filter((_, index) => (bitset & Math.pow(2, index)) !== 0);
}

async function foldingRanges(args: Record<string, unknown>): Promise<object[]> {
  const values = await executeDocument<vscode.FoldingRange[]>("vscode.executeFoldingRangeProvider", args);
  return (values ?? []).map(range => ({
    startLine: range.start + 1,
    endLine: range.end + 1,
    kind: range.kind
  }));
}

async function documentColors(args: Record<string, unknown>): Promise<object[]> {
  const values = await executeDocument<vscode.ColorInformation[]>("vscode.executeDocumentColorProvider", args);
  return (values ?? []).map(info => ({
    color: normalizeColor(info.color),
    ...normalizeRange(info.range)
  }));
}

async function colorPresentations(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const color = colorArg(args);
  const range = rangeArg(args);
  const values = await vscode.commands.executeCommand<vscode.ColorPresentation[]>(
    "vscode.executeColorPresentationProvider",
    color,
    { uri, range }
  );

  return (values ?? []).map(presentation => ({
    label: presentation.label,
    textEdit: presentation.textEdit ? normalizeTextEdit(presentation.textEdit) : undefined,
    additionalTextEdits: presentation.additionalTextEdits?.map(normalizeTextEdit)
  }));
}

function colorArg(args: Record<string, unknown>): vscode.Color {
  return new vscode.Color(
    optionalNumberArg(args, "red", 0),
    optionalNumberArg(args, "green", 0),
    optionalNumberArg(args, "blue", 0),
    optionalNumberArg(args, "alpha", 1)
  );
}

function normalizeColor(color: vscode.Color): object {
  return {
    red: color.red,
    green: color.green,
    blue: color.blue,
    alpha: color.alpha
  };
}

async function inlineValues(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const range = optionalRangeArg(args, document);
  const context: vscode.InlineValueContext = {
    frameId: optionalNonNegativeIntegerArg(args, "frameId", 0),
    stoppedLocation: stoppedLocationArg(args, range)
  };
  const values = await vscode.commands.executeCommand<vscode.InlineValue[]>(
    "vscode.executeInlineValueProvider",
    uri,
    range,
    context
  );

  return (values ?? []).map(normalizeInlineValue);
}

function normalizeInlineValue(value: vscode.InlineValue): object {
  if ("text" in value) {
    return {
      type: "text",
      text: value.text,
      ...normalizeRange(value.range)
    };
  }

  if ("variableName" in value || "caseSensitiveLookup" in value) {
    return {
      type: "variableLookup",
      variableName: value.variableName,
      caseSensitiveLookup: value.caseSensitiveLookup,
      ...normalizeRange(value.range)
    };
  }

  return {
    type: "evaluatableExpression",
    expression: value.expression,
    ...normalizeRange(value.range)
  };
}

async function completion(args: Record<string, unknown>): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const position = positionArg(args);
  const triggerCharacter = optionalStringArg(args, "triggerCharacter");
  const itemResolveCount = optionalPositiveIntegerArg(args, "itemResolveCount", 20);
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
      documentation: markdownToText(item.documentation),
      sortText: item.sortText,
      filterText: item.filterText,
      commitCharacters: item.commitCharacters,
      range: item.range && !("inserting" in item.range) ? normalizeRange(item.range) : undefined
    }))
  };
}

async function signatureHelp(args: Record<string, unknown>): Promise<object | undefined> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const triggerCharacter = optionalStringArg(args, "triggerCharacter");
  const value = await vscode.commands.executeCommand<vscode.SignatureHelp>(
    "vscode.executeSignatureHelpProvider",
    uri,
    positionArg(args),
    triggerCharacter
  );

  if (!value) {
    return undefined;
  }

  return {
    activeSignature: value.activeSignature + 1,
    activeParameter: value.activeParameter + 1,
    signatures: value.signatures.map(signature => ({
      label: signature.label,
      documentation: markdownToText(signature.documentation),
      activeParameter: signature.activeParameter === undefined ? undefined : signature.activeParameter + 1,
      parameters: signature.parameters.map(parameter => ({
        label: parameter.label,
        documentation: markdownToText(parameter.documentation)
      }))
    }))
  };
}

async function codeLens(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const itemResolveCount = optionalPositiveIntegerArg(args, "itemResolveCount", 100);
  const values = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    "vscode.executeCodeLensProvider",
    uri,
    itemResolveCount
  );

  return (values ?? []).map(codeLens => ({
    ...normalizeRange(codeLens.range),
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
  const values = await vscode.commands.executeCommand<vscode.InlayHint[]>(
    "vscode.executeInlayHintProvider",
    uri,
    optionalRangeArg(args, document)
  );

  return (values ?? []).map(hint => ({
    label: typeof hint.label === "string" ? hint.label : hint.label.map(part => part.value).join(""),
    kind: hint.kind === undefined ? undefined : vscode.InlayHintKind[hint.kind],
    line: hint.position.line + 1,
    column: hint.position.character + 1,
    tooltip: typeof hint.tooltip === "string" ? hint.tooltip : hint.tooltip?.value,
    paddingLeft: hint.paddingLeft,
    paddingRight: hint.paddingRight
  }));
}

async function codeActions(args: Record<string, unknown>): Promise<object[]> {
  const actions = await getCodeActions(args);
  return actions.map((action, index) => normalizeCodeAction(action, index));
}

async function getCodeActions(args: Record<string, unknown>): Promise<CodeActionLike[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const range = optionalRangeArg(args, document);
  const kind = optionalStringArg(args, "kind");
  const itemResolveCount = optionalPositiveIntegerArg(args, "itemResolveCount", 100);
  return await vscode.commands.executeCommand<CodeActionLike[]>(
    "vscode.executeCodeActionProvider",
    uri,
    range,
    kind ? codeActionKindFromString(kind) : undefined,
    itemResolveCount
  ) ?? [];
}

function codeActionKindFromString(value: string): vscode.CodeActionKind {
  const [head, ...rest] = value.split(".");
  const tail = rest.join(".");
  const base = (() => {
    switch (head) {
      case "quickfix":
        return vscode.CodeActionKind.QuickFix;
      case "refactor":
        return vscode.CodeActionKind.Refactor;
      case "source":
        return vscode.CodeActionKind.Source;
      case "notebook":
        return vscode.CodeActionKind.Notebook;
      default:
        return vscode.CodeActionKind.Empty;
    }
  })();
  return tail ? base.append(tail) : base;
}

function normalizeCodeAction(action: CodeActionLike, index: number): object {
  const command = isCodeAction(action) ? action.command : action;
  return {
    actionIndex: index + 1,
    title: action.title,
    kind: isCodeAction(action) ? action.kind?.value : undefined,
    isPreferred: isCodeAction(action) ? action.isPreferred : undefined,
    disabled: isCodeAction(action) ? action.disabled?.reason : undefined,
    diagnostics: isCodeAction(action) ? action.diagnostics?.map(diagnostic => ({
      message: diagnostic.message,
      severity: vscode.DiagnosticSeverity[diagnostic.severity],
      source: diagnostic.source,
      code: diagnostic.code,
      ...normalizeRange(diagnostic.range)
    })) : undefined,
    edit: isCodeAction(action) ? normalizeWorkspaceEdit(action.edit) : undefined,
    command: normalizeCommand(command)
  };
}

function isCodeAction(action: CodeActionLike): action is vscode.CodeAction {
  return "diagnostics" in action || "edit" in action || "kind" in action || "isPreferred" in action;
}

function normalizeCommand(command: vscode.Command | undefined): object | undefined {
  if (!command) {
    return undefined;
  }

  return {
    title: command.title,
    command: command.command,
    argumentCount: command.arguments?.length ?? 0
  };
}

async function applyCodeAction(args: Record<string, unknown>, options: ToolOptions): Promise<object> {
  ensureWritesAllowed(options);
  const fallbackUri = await openDocumentUri(stringArg(args, "file"));
  const actions = await getCodeActions(args);
  const selected = selectCodeAction(actions, args);
  const applied = await applySelectedCodeAction(
    selected,
    optionalBooleanArg(args, "executeCommand", true),
    {
      toolName: "apply_code_action",
      operation: "Apply code action",
      files: [fallbackUri],
      actionTitle: selected.action.title
    }
  );
  return {
    ...applied,
    selectedAction: normalizeCodeAction(selected.action, selected.index)
  };
}

async function sourceAction(
  args: Record<string, unknown>,
  options: ToolOptions,
  kind: string,
  toolName: string
): Promise<object> {
  const actionArgs = { ...args, kind };
  const actions = await getCodeActions(actionArgs);
  if (!optionalBooleanArg(args, "apply")) {
    return {
      applied: false,
      actions: actions.map((action, index) => normalizeCodeAction(action, index))
    };
  }

  ensureWritesAllowed(options);
  const fallbackUri = await openDocumentUri(stringArg(args, "file"));
  const selected = selectCodeAction(actions, actionArgs);
  const applied = await applySelectedCodeAction(
    selected,
    optionalBooleanArg(args, "executeCommand", true),
    {
      toolName,
      operation: `Apply ${kind}`,
      files: [fallbackUri],
      actionTitle: selected.action.title
    }
  );
  return {
    ...applied,
    selectedAction: normalizeCodeAction(selected.action, selected.index)
  };
}

function selectCodeAction(actions: CodeActionLike[], args: Record<string, unknown>): { action: CodeActionLike; index: number } {
  const actionIndex = optionalPositiveIntegerArg(args, "actionIndex", 1) - 1;
  const title = optionalStringArg(args, "title");
  const exactTitle = optionalBooleanArg(args, "exactTitle");
  const selectedIndex = title
    ? actions.findIndex(action => exactTitle ? action.title === title : action.title.toLowerCase().includes(title.toLowerCase()))
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
  const needsApproval = Boolean(edit || commandToExecute);
  if (needsApproval) {
    const approved = await requestWriteApproval({
      ...approval,
      files: [...affectedFilesFromWorkspaceEdit(edit), ...approval.files],
      command: commandToExecute,
      editCount: edit?.size ?? 0
    });
    if (!approved) {
      return { approved: false, appliedEdit: false, executedCommand: false };
    }
  }

  const appliedEdit = edit ? await vscode.workspace.applyEdit(edit) : false;
  let executedCommand = false;

  if (commandToExecute) {
    await vscode.commands.executeCommand(commandToExecute.command, ...(commandToExecute.arguments ?? []));
    executedCommand = true;
  }

  return { approved: true, appliedEdit, executedCommand };
}

async function formatDocument(args: Record<string, unknown>, options: ToolOptions): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    "vscode.executeFormatDocumentProvider",
    uri,
    formattingOptions(args)
  );

  return previewOrApplyTextEdits(uri, edits ?? [], args, options, "format_document");
}

async function formatRange(args: Record<string, unknown>, options: ToolOptions): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    "vscode.executeFormatRangeProvider",
    uri,
    rangeArg(args),
    formattingOptions(args)
  );

  return previewOrApplyTextEdits(uri, edits ?? [], args, options, "format_range");
}

async function formatOnType(args: Record<string, unknown>, options: ToolOptions): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const edits = await vscode.commands.executeCommand<vscode.TextEdit[]>(
    "vscode.executeFormatOnTypeProvider",
    uri,
    positionArg(args),
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
  const normalized = edits.map(normalizeTextEdit);
  if (optionalBooleanArg(args, "apply")) {
    ensureWritesAllowed(options);
    const workspaceEdit = new vscode.WorkspaceEdit();
    for (const edit of edits) {
      workspaceEdit.replace(uri, edit.range, edit.newText);
    }
    const approved = await requestWriteApproval({
      toolName,
      operation: "Apply formatting edits",
      files: [uri],
      editCount: edits.length
    });
    if (!approved) {
      return { approved: false, applied: false, edits: normalized };
    }

    const applied = await vscode.workspace.applyEdit(workspaceEdit);
    return { approved: true, applied, edits: normalized };
  }

  return { applied: false, edits: normalized };
}

async function rename(
  args: Record<string, unknown>,
  options: ToolOptions & { forcePreviewOnly?: boolean }
): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
    "vscode.executeDocumentRenameProvider",
    uri,
    positionArg(args),
    stringArg(args, "newName")
  );

  const normalized = normalizeWorkspaceEdit(edit);
  const apply = optionalBooleanArg(args, "apply") && !options.forcePreviewOnly;
  if (apply) {
    ensureWritesAllowed(options);
    const approved = await requestWriteApproval({
      toolName: "rename_symbol",
      operation: `Rename symbol to "${stringArg(args, "newName")}"`,
      files: [...affectedFilesFromWorkspaceEdit(edit), uri],
      editCount: edit?.size ?? 0
    });
    if (!approved) {
      return { approved: false, applied: false, edit: normalized };
    }

    const applied = edit ? await vscode.workspace.applyEdit(edit) : false;
    return { approved: true, applied, edit: normalized };
  }

  return { applied: false, edit: normalized };
}

function normalizePrepareRename(value: vscode.Range | { range: vscode.Range; placeholder: string } | undefined): object | undefined {
  if (!value) {
    return undefined;
  }

  if ("range" in value) {
    return {
      placeholder: value.placeholder,
      ...normalizeRange(value.range)
    };
  }

  return normalizeRange(value);
}

function ensureWritesAllowed(options: ToolOptions): void {
  if (!options.allowWrites) {
    throw new Error("Write tools are disabled. Enable vscodeLspMcpBridge.enableWriteTools to apply edits.");
  }
}

async function requestWriteApproval(request: WriteApprovalRequest): Promise<boolean> {
  const files = uniqueUris(request.files);
  const fileLines = files.length > 0
    ? files.slice(0, 10).map(uri => `- ${formatUriForApproval(uri)}`)
    : ["- No affected file reported by the provider"];
  const remainingFiles = files.length > 10 ? `\n- ...and ${files.length - 10} more` : "";
  const details = [
    `Tool: ${request.toolName}`,
    `Operation: ${request.operation}`,
    request.actionTitle ? `Action: ${request.actionTitle}` : undefined,
    `Text edit groups: ${request.editCount ?? 0}`,
    request.command ? `Command: ${request.command.title} (${request.command.command})` : undefined,
    `Affected files:\n${fileLines.join("\n")}${remainingFiles}`
  ].filter((value): value is string => Boolean(value)).join("\n\n");

  const choice = await vscode.window.showWarningMessage(
    `Allow MCP write tool "${request.toolName}" to apply changes?`,
    {
      modal: true,
      detail: details
    },
    "Apply Changes"
  );

  return choice === "Apply Changes";
}

function uniqueUris(uris: vscode.Uri[]): vscode.Uri[] {
  const seen = new Set<string>();
  const result = [];
  for (const uri of uris) {
    const key = uri.toString();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(uri);
    }
  }

  return result;
}

function affectedFilesFromWorkspaceEdit(edit: vscode.WorkspaceEdit | undefined): vscode.Uri[] {
  return edit?.entries().map(([uri]) => uri) ?? [];
}

function formatUriForApproval(uri: vscode.Uri): string {
  return uri.scheme === "file" ? vscode.workspace.asRelativePath(uri, false) : uri.toString(true);
}

function normalizeTextEdit(edit: vscode.TextEdit): object {
  return {
    ...normalizeRange(edit.range),
    newText: edit.newText
  };
}

function normalizeWorkspaceEdit(edit: vscode.WorkspaceEdit | undefined): object | undefined {
  if (!edit) {
    return undefined;
  }

  return {
    size: edit.size,
    entries: edit.entries().map(([uri, edits]) => ({
      file: uri.fsPath,
      edits: edits.map(normalizeTextEdit)
    }))
  };
}
