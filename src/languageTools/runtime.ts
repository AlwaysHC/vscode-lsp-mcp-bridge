import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { brand, brandAttribution } from "../branding.js";
import { boundedInteger } from "../languageToolCore.js";

const sourceLineMaxLength = 240;
const argumentMaxLength = 32_768;
const workspaceFolderLimit = 100;
const workspaceContainmentTimeoutMs = 10_000;
const virtualDocumentUriTtlMs = 5 * 60 * 1_000;
const virtualDocumentUriLimit = 256;

export const blockedVirtualDocumentSchemes = new Set([
  "chat",
  "comments",
  "command",
  "data",
  "debug",
  "file",
  "git",
  "http",
  "https",
  "interactive",
  "javascript",
  "keybindings",
  "mailto",
  "output",
  "search-editor",
  "settings",
  "terminal",
  "untitled",
  "vscode",
  "vscode-insiders",
  "webview"
]);

export function isBlockedVirtualDocumentScheme(scheme: string): boolean {
  const normalized = scheme.toLowerCase();
  return normalized.startsWith("vscode") || blockedVirtualDocumentSchemes.has(normalized);
}

export interface VirtualDocumentGrant {
  uri: vscode.Uri;
  expiresAt: number;
  approved: boolean;
}

const virtualDocumentGrants = new Map<string, VirtualDocumentGrant>();
const virtualDocumentRefsByUri = new Map<string, string>();

export function semanticNavigationGuide(): object {
  return {
    attribution: brandAttribution,
    purpose: brand("Use VS Code language providers for semantic code navigation before text search."),
    primaryRules: [
      "For 'who calls X', 'incoming calls', 'callers', or call-site questions with a known symbol name, call find_callers_for_symbol first.",
      "For 'what does X call', 'outgoing calls', or callees with a known symbol name, call find_callees_for_symbol first.",
      "For symbol references by name, call find_references_for_symbol first. Use find_references only when you already have file, line, and column.",
      "For definitions by name, call find_definition_for_symbol first. Use go_to_definition only when you already have file, line, and column.",
      "For broad symbol understanding, call symbol_context or symbol_context_for_symbol.",
      "For type hierarchy by name, call type_hierarchy_for_symbol first.",
      "Use workspace_symbols or document_symbols to resolve ambiguous names before falling back to rg, grep, or raw file search."
    ],
    fallbackRules: [
      "Use text search only when the user asks for text mentions, the language provider returns no usable semantic result, or the file is not language-provider backed.",
      "When falling back to text search, say that it is a fallback rather than a semantic result."
    ],
    resultUsage: [
      "Tool results use one-based editor line and column values.",
      "Prefer returned file, uri, line, column, and sourceLine fields directly in user-facing answers."
    ]
  };
}

export async function languageCapabilities(args: Record<string, unknown>): Promise<object> {
  const availableCommands = new Set(await vscode.commands.getCommands(true));
  const file = optionalStringArg(args, "file");
  const document = file ? await vscode.workspace.openTextDocument(await openDocumentUri(file)) : undefined;
  const stableProviderCommands = {
    references: "vscode.executeReferenceProvider",
    definition: "vscode.executeDefinitionProvider",
    declaration: "vscode.executeDeclarationProvider",
    implementation: "vscode.executeImplementationProvider",
    typeDefinition: "vscode.executeTypeDefinitionProvider",
    hover: "vscode.executeHoverProvider",
    documentSymbols: "vscode.executeDocumentSymbolProvider",
    workspaceSymbols: "vscode.executeWorkspaceSymbolProvider",
    documentHighlights: "vscode.executeDocumentHighlights",
    callHierarchy: "vscode.prepareCallHierarchy",
    incomingCalls: "vscode.provideIncomingCalls",
    outgoingCalls: "vscode.provideOutgoingCalls",
    typeHierarchy: "vscode.prepareTypeHierarchy",
    supertypes: "vscode.provideSupertypes",
    subtypes: "vscode.provideSubtypes",
    selectionRanges: "vscode.executeSelectionRangeProvider",
    documentLinks: "vscode.executeLinkProvider",
    semanticTokens: "vscode.provideDocumentSemanticTokens",
    rangeSemanticTokens: "vscode.provideDocumentRangeSemanticTokens",
    foldingRanges: "vscode.executeFoldingRangeProvider",
    documentColors: "vscode.executeDocumentColorProvider",
    colorPresentations: "vscode.executeColorPresentationProvider",
    inlineValues: "vscode.executeInlineValueProvider",
    completion: "vscode.executeCompletionItemProvider",
    signatureHelp: "vscode.executeSignatureHelpProvider",
    codeLens: "vscode.executeCodeLensProvider",
    inlayHints: "vscode.executeInlayHintProvider",
    codeActions: "vscode.executeCodeActionProvider",
    formatting: "vscode.executeFormatDocumentProvider",
    rangeFormatting: "vscode.executeFormatRangeProvider",
    onTypeFormatting: "vscode.executeFormatOnTypeProvider",
    prepareRename: "vscode.prepareRename",
    rename: "vscode.executeDocumentRenameProvider"
  } as const;

  return {
    document: document ? {
      ...normalizeDocumentUri(document.uri),
      languageId: document.languageId,
      version: document.version
    } : undefined,
    invocationSurface: Object.fromEntries(
      Object.entries(stableProviderCommands).map(([feature, command]) => [
        feature,
        availableCommands.has(command) ? "public-command" : "unavailable"
      ])
    ),
    bridgeFeatures: {
      recursiveCallHierarchy: true,
      recursiveTypeHierarchy: true,
      diagnosticFilteringAndSettling: true,
      richCompletionPreview: true,
      approvedPlainTextCompletionApply: true,
      combinedSymbolContext: true,
      provenanceGuardedVirtualDocuments: true,
      providerWorkspaceEditsPreviewOnly: true,
      approvedTextEditFormattingApply: true
    },
    unavailableThroughStableVscodeConsumerApis: {
      linkedEditingRanges: "Provider registration exists, but VS Code has no documented command for querying other extensions' providers.",
      inlineCompletions: "Provider registration exists, but VS Code has no documented command for querying other extensions' providers.",
      monikers: "The stable VS Code extension API does not expose moniker providers.",
      pullDiagnostics: "VS Code exposes its aggregated diagnostic collection instead of raw LSP pull requests.",
      workspaceSymbolResolve: "The documented workspace-symbol command has no explicit resolve operation."
    },
    note: "Command availability describes VS Code's invocation surface, not whether a particular language provider will return a result."
  };
}

export async function executeAtPosition<T>(command: string, args: Record<string, unknown>): Promise<T | undefined> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  return executeProviderCommand<T>(command, uri, positionArg(args, document));
}

export async function executeDocument<T>(command: string, args: Record<string, unknown>): Promise<T | undefined> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  return executeProviderCommand<T>(command, uri);
}

export async function executeProviderCommand<T>(command: string, ...args: unknown[]): Promise<T | undefined> {
  return withTimeout(
    vscode.commands.executeCommand<T>(command, ...args),
    15_000,
    `Language provider command timed out: ${command}`
  );
}

export async function openDocumentUri(file: string): Promise<vscode.Uri> {
  const uri = await resolveFileUri(file);
  await withTimeout(vscode.workspace.openTextDocument(uri), 10_000, "Opening the workspace document timed out.");
  return uri;
}

export async function resolveFileUri(file: string): Promise<vscode.Uri> {
  const folders = (vscode.workspace.workspaceFolders ?? []).slice(0, workspaceFolderLimit);
  if (folders.length === 0) {
    throw new Error("No workspace folder is open in VS Code.");
  }

  const explicitUri = parseExplicitUri(file);
  if (explicitUri) {
    pathSegments(explicitUri.path);
    if (!isUriInWorkspace(explicitUri)) {
      throw new Error(`File URI is outside the open workspace: ${file}`);
    }
    await withTimeout(vscode.workspace.fs.stat(explicitUri), 5_000, "Checking the workspace document timed out.");
    await ensureCanonicalWorkspaceContainment(explicitUri);
    return explicitUri;
  }

  const absolute = isAbsoluteFilePath(file);
  const candidates = absolute
    ? folders.flatMap(folder => {
        const relative = relativePathWithinFolder(
          folder.uri.fsPath,
          file,
          folder.uri.scheme === "file" && process.platform === "win32"
        );
        return relative === undefined ? [] : [vscode.Uri.joinPath(folder.uri, ...pathSegments(relative))];
      })
    : folders.map(folder => vscode.Uri.joinPath(folder.uri, ...pathSegments(file)));
  const contained = candidates.filter(isUriInWorkspace);
  if (contained.length === 0) {
    throw new Error(`File is outside the open workspace: ${file}`);
  }

  const checked = await Promise.all(contained.map(async candidate => {
    try {
      await withTimeout(vscode.workspace.fs.stat(candidate), 5_000, "Checking the workspace document timed out.");
      return candidate;
    } catch {
      return undefined;
    }
  }));
  const existing = checked.filter((candidate): candidate is vscode.Uri => candidate !== undefined);
  if (existing.length > 1) {
    throw new Error(`Relative file path is ambiguous across workspace folders: ${file}`);
  }
  const resolved = existing[0] ?? (contained.length === 1 ? contained[0] : undefined);
  if (!resolved) {
    throw new Error(`File was not found in any workspace folder: ${file}`);
  }
  await ensureCanonicalWorkspaceContainment(resolved);
  return resolved;
}

function parseExplicitUri(value: string): vscode.Uri | undefined {
  if (/^[A-Za-z]:[\\/]/u.test(value) || !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    return undefined;
  }
  try {
    const uri = vscode.Uri.parse(value, true);
    return uri.scheme ? uri : undefined;
  } catch {
    throw new Error(`Invalid document URI: ${value}`);
  }
}

function isAbsoluteFilePath(file: string): boolean {
  return path.isAbsolute(file) || file.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(file);
}

function pathSegments(file: string): string[] {
  const segments = file.split(/[\\/]+/u).filter(segment => segment && segment !== ".");
  if (segments.length > 256) {
    throw new Error("Document paths may not contain more than 256 segments.");
  }
  if (segments.includes("..")) {
    throw new Error("Document paths may not contain parent-directory traversal segments.");
  }
  return segments;
}

function relativePathWithinFolder(folder: string, file: string, caseInsensitive: boolean): string | undefined {
  const normalizedFolder = normalizeFsPath(folder, caseInsensitive).replace(/\/$/u, "");
  const normalizedFile = normalizeFsPath(file, caseInsensitive);
  if (normalizedFile === normalizedFolder) {
    return "";
  }
  return normalizedFile.startsWith(`${normalizedFolder}/`)
    ? file.replace(/\\/gu, "/").slice(folder.replace(/\\/gu, "/").replace(/\/$/u, "").length + 1)
    : undefined;
}

export function normalizeFsPath(value: string, caseInsensitive: boolean): string {
  const normalized = value.replace(/\\/gu, "/");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

export function isUriInWorkspace(uri: vscode.Uri): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some(folder => {
    if (folder.uri.scheme !== uri.scheme || folder.uri.authority !== uri.authority) {
      return false;
    }
    const caseInsensitive = uri.scheme === "file" && process.platform === "win32";
    const folderPath = normalizeFsPath(folder.uri.path, caseInsensitive).replace(/\/$/u, "");
    const uriPath = normalizeFsPath(uri.path, caseInsensitive);
    return uriPath === folderPath || uriPath.startsWith(`${folderPath}/`);
  });
}

export async function ensureCanonicalWorkspaceContainment(uri: vscode.Uri): Promise<void> {
  if (!isUriInWorkspace(uri)) {
    throw new Error(`File is outside the open workspace: ${uri.toString(true)}`);
  }
  if (uri.scheme !== "file") {
    await ensureRemotePathHasNoReportedSymlink(uri);
    return;
  }
  const target = await withTimeout(
    fs.realpath(uri.fsPath),
    workspaceContainmentTimeoutMs,
    "Resolving the workspace document timed out."
  );
  const rootCandidates = await Promise.all(
    (vscode.workspace.workspaceFolders ?? [])
      .slice(0, workspaceFolderLimit)
      .filter(folder => folder.uri.scheme === "file")
      .map(folder => withTimeout(
        fs.realpath(folder.uri.fsPath),
        workspaceContainmentTimeoutMs,
        "Resolving a workspace folder timed out."
      ).catch(() => undefined))
  );
  const roots = rootCandidates.filter((root): root is string => root !== undefined);
  const normalizedTarget = normalizeFsPath(target, process.platform === "win32");
  const contained = roots.some(root => {
    const normalizedRoot = normalizeFsPath(root, process.platform === "win32").replace(/\/$/u, "");
    return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}/`);
  });
  if (!contained) {
    throw new Error(`File resolves outside the open workspace: ${uri.fsPath}`);
  }
}

export async function isCanonicalWorkspaceUri(uri: vscode.Uri): Promise<boolean> {
  if (!isUriInWorkspace(uri)) {
    return false;
  }
  try {
    await ensureCanonicalWorkspaceContainment(uri);
    return true;
  } catch {
    return false;
  }
}

export async function isSafeProviderResultUriForExposure(uri: vscode.Uri): Promise<boolean> {
  if (!isSafeProviderResultUri(uri)) {
    return false;
  }
  return !isUriInWorkspace(uri) || isCanonicalWorkspaceUri(uri);
}

export function createProviderUriExposureGuard(timeoutMs = 10_000): (uri: vscode.Uri) => Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const checks = new Map<string, Promise<boolean>>();
  return uri => {
    const key = uri.toString(true);
    const existing = checks.get(key);
    if (existing) {
      return existing;
    }
    const remaining = deadline - Date.now();
    const check = remaining <= 0
      ? Promise.resolve(false)
      : withTimeout(
          isSafeProviderResultUriForExposure(uri),
          remaining,
          "Provider URI validation timed out."
        ).catch(() => false);
    checks.set(key, check);
    return check;
  };
}

async function ensureRemotePathHasNoReportedSymlink(uri: vscode.Uri): Promise<void> {
  const folder = (vscode.workspace.workspaceFolders ?? []).find(candidate => {
    if (candidate.uri.scheme !== uri.scheme || candidate.uri.authority !== uri.authority) {
      return false;
    }
    const folderPath = candidate.uri.path.replace(/\/$/u, "");
    return uri.path === folderPath || uri.path.startsWith(`${folderPath}/`);
  });
  if (!folder) {
    throw new Error("The remote document does not belong to an open workspace folder.");
  }
  const folderPath = folder.uri.path.replace(/\/$/u, "");
  const relative = uri.path.slice(folderPath.length).replace(/^\/+/, "");
  const segments = relative.split("/").filter(Boolean);
  if (segments.length > 256) {
    throw new Error("Remote document paths may not contain more than 256 segments.");
  }
  if (segments.includes("..")) {
    throw new Error("Remote document paths may not contain parent-directory traversal segments.");
  }
  let current = folder.uri;
  const deadline = Date.now() + workspaceContainmentTimeoutMs;
  for (const segment of segments) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Checking the remote document path timed out.");
    }
    current = vscode.Uri.joinPath(current, segment);
    const stat = await withTimeout(
      vscode.workspace.fs.stat(current),
      Math.min(remainingMs, 2_000),
      "Checking the remote document path timed out."
    );
    if ((stat.type & vscode.FileType.SymbolicLink) !== 0) {
      throw new Error(`The remote document traverses a reported symbolic link: ${formatUriForApproval(current)}`);
    }
  }
}

export function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0 || value.length > argumentMaxLength) {
    throw new Error(`Expected non-empty string argument no longer than ${argumentMaxLength} characters: ${key}`);
  }
  return value;
}

export function optionalStringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || value.length > argumentMaxLength) {
    throw new Error(`Expected optional string argument no longer than ${argumentMaxLength} characters: ${key}`);
  }
  return value;
}

export function optionalStringArrayArg(args: Record<string, unknown>, key: string, maximumItems: number): string[] {
  const value = args[key];
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.length > maximumItems || value.some(item => typeof item !== "string" || item.length > 1_000)) {
    throw new Error(`Expected ${key} to be an array of at most ${maximumItems} bounded strings.`);
  }
  return value as string[];
}

export function oneBasedNumberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10_000_000) {
    throw new Error(`Expected one-based positive integer argument: ${key}`);
  }
  return value;
}

export function optionalOneBasedNumberArg(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 10_000_000) {
    throw new Error(`Expected optional one-based positive integer argument: ${key}`);
  }
  return value;
}

export function optionalPositiveIntegerArg(args: Record<string, unknown>, key: string, defaultValue: number): number {
  return boundedInteger(args[key], key, { defaultValue, maximum: 10_000 });
}

export function optionalNonNegativeIntegerArg(args: Record<string, unknown>, key: string, defaultValue: number): number {
  return boundedInteger(args[key], key, { defaultValue, minimum: 0, maximum: 2_147_483_647 });
}

export function optionalNumberArg(args: Record<string, unknown>, key: string, defaultValue: number): number {
  const value = args[key];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Expected finite optional number argument: ${key}`);
  }
  return value;
}

export function optionalBooleanArg(args: Record<string, unknown>, key: string, defaultValue = false): boolean {
  const value = args[key];
  if (value === undefined || value === null) {
    return defaultValue;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Expected optional boolean argument: ${key}`);
  }
  return value;
}

export function positionArg(args: Record<string, unknown>, document?: vscode.TextDocument): vscode.Position {
  const position = new vscode.Position(oneBasedNumberArg(args, "line") - 1, oneBasedNumberArg(args, "column") - 1);
  if (document && !document.validatePosition(position).isEqual(position)) {
    throw new Error("The requested position is outside the document.");
  }
  return position;
}

export function rangeArg(args: Record<string, unknown>, document?: vscode.TextDocument): vscode.Range {
  const start = new vscode.Position(
    oneBasedNumberArg(args, "startLine") - 1,
    oneBasedNumberArg(args, "startColumn") - 1
  );
  const end = new vscode.Position(
    oneBasedNumberArg(args, "endLine") - 1,
    oneBasedNumberArg(args, "endColumn") - 1
  );
  if (start.isAfter(end)) {
    throw new Error("Range start must not be after range end.");
  }
  const range = new vscode.Range(start, end);
  if (document && !document.validateRange(range).isEqual(range)) {
    throw new Error("The requested range is outside the document.");
  }
  return range;
}

export function optionalRangeArg(args: Record<string, unknown>, document: vscode.TextDocument): vscode.Range {
  const keys = ["startLine", "startColumn", "endLine", "endColumn"] as const;
  const values = keys.map(key => optionalOneBasedNumberArg(args, key));
  if (values.every(value => value === undefined)) {
    return fullDocumentRange(document);
  }
  if (values.some(value => value === undefined)) {
    throw new Error("startLine, startColumn, endLine, and endColumn must be provided together.");
  }
  return rangeArg(args, document);
}

export function stoppedLocationArg(
  args: Record<string, unknown>,
  fallback: vscode.Range,
  document?: vscode.TextDocument
): vscode.Range {
  const stoppedLine = optionalOneBasedNumberArg(args, "stoppedLine");
  const stoppedColumn = optionalOneBasedNumberArg(args, "stoppedColumn");
  if (stoppedLine === undefined && stoppedColumn === undefined) {
    return fallback;
  }
  if (stoppedLine === undefined || stoppedColumn === undefined) {
    throw new Error("stoppedLine and stoppedColumn must be provided together.");
  }
  const position = new vscode.Position(stoppedLine - 1, stoppedColumn - 1);
  if (document && !document.validatePosition(position).isEqual(position)) {
    throw new Error("The stopped location is outside the document.");
  }
  return new vscode.Range(position, position);
}

export function fullDocumentRange(document: vscode.TextDocument): vscode.Range {
  const lastLine = Math.max(0, document.lineCount - 1);
  return new vscode.Range(0, 0, lastLine, document.lineAt(lastLine).range.end.character);
}

export function formattingOptions(args: Record<string, unknown>): vscode.FormattingOptions {
  return {
    tabSize: boundedInteger(args.tabSize, "tabSize", { defaultValue: 4, maximum: 32 }),
    insertSpaces: optionalBooleanArg(args, "insertSpaces", true)
  };
}

export function normalizeRange(range: vscode.Range): object {
  return {
    line: range.start.line + 1,
    column: range.start.character + 1,
    endLine: range.end.line + 1,
    endColumn: range.end.character + 1
  };
}

export function locationTarget(value: vscode.Location | vscode.LocationLink): { uri: vscode.Uri; range: vscode.Range } {
  return "targetUri" in value
    ? { uri: value.targetUri, range: value.targetSelectionRange ?? value.targetRange }
    : { uri: value.uri, range: value.range };
}

export function normalizeLocation(value: vscode.Location | vscode.LocationLink): object {
  const { uri, range } = locationTarget(value);
  return isSafeProviderResultUri(uri)
    ? { ...normalizeDocumentUri(uri), ...normalizeRange(range) }
    : { external: true };
}

export function normalizeDocumentUri(uri: vscode.Uri): {
  uri?: string;
  file?: string;
  uriScheme?: string;
  virtualDocumentRef?: string;
} {
  if (isUriInWorkspace(uri)) {
    return {
      uri: boundedText(uri.toString(true), argumentMaxLength),
      file: boundedText(uri.fsPath, argumentMaxLength)
    };
  }
  return {
    uriScheme: boundedText(uri.scheme, 256),
    virtualDocumentRef: rememberProviderReturnedVirtualUri(uri)
  };
}

export function isSafeProviderResultUri(uri: vscode.Uri): boolean {
  return isUriInWorkspace(uri)
    || (uri.scheme !== "file" && !isBlockedVirtualDocumentScheme(uri.scheme));
}

function rememberProviderReturnedVirtualUri(uri: vscode.Uri): string | undefined {
  if (isBlockedVirtualDocumentScheme(uri.scheme) || isUriInWorkspace(uri)) {
    return undefined;
  }
  pruneVirtualDocumentGrants();
  const uriKey = uri.toString(true);
  if (uriKey.length > argumentMaxLength) {
    return undefined;
  }
  const existingReference = virtualDocumentRefsByUri.get(uriKey);
  const existing = existingReference ? virtualDocumentGrants.get(existingReference) : undefined;
  if (existingReference && existing) {
    existing.expiresAt = Date.now() + virtualDocumentUriTtlMs;
    return existingReference;
  }
  while (virtualDocumentGrants.size >= virtualDocumentUriLimit) {
    const oldestReference = virtualDocumentGrants.keys().next().value as string | undefined;
    if (!oldestReference) {
      break;
    }
    deleteVirtualDocumentGrant(oldestReference);
  }
  const reference = crypto.randomUUID();
  virtualDocumentGrants.set(reference, {
    uri,
    expiresAt: Date.now() + virtualDocumentUriTtlMs,
    approved: false
  });
  virtualDocumentRefsByUri.set(uriKey, reference);
  return reference;
}

export function getVirtualDocumentGrant(reference: string): VirtualDocumentGrant | undefined {
  pruneVirtualDocumentGrants();
  return virtualDocumentGrants.get(reference);
}

export function deleteVirtualDocumentGrant(reference: string): void {
  const grant = virtualDocumentGrants.get(reference);
  virtualDocumentGrants.delete(reference);
  if (grant) {
    virtualDocumentRefsByUri.delete(grant.uri.toString(true));
  }
}

export function refreshVirtualDocumentGrant(grant: VirtualDocumentGrant): void {
  grant.expiresAt = Date.now() + virtualDocumentUriTtlMs;
}

function pruneVirtualDocumentGrants(): void {
  const now = Date.now();
  for (const [reference, grant] of virtualDocumentGrants) {
    if (grant.expiresAt <= now) {
      deleteVirtualDocumentGrant(reference);
    }
  }
}

export async function locationsWithSourceLines(
  values: Array<vscode.Location | vscode.LocationLink> | undefined,
  maxResults = 500
): Promise<object[]> {
  const candidates: Array<vscode.Location | vscode.LocationLink> = [];
  for (const value of values ?? []) {
    if (isSafeProviderResultUri(locationTarget(value).uri)) {
      candidates.push(value);
      if (candidates.length >= maxResults) {
        break;
      }
    }
  }
  const selected: Array<vscode.Location | vscode.LocationLink> = [];
  const canExpose = createProviderUriExposureGuard();
  for (let index = 0; index < candidates.length; index += 8) {
    const batch = candidates.slice(index, index + 8);
    const allowed = await Promise.all(batch.map(value => canExpose(locationTarget(value).uri)));
    for (let offset = 0; offset < batch.length; offset += 1) {
      if (allowed[offset]) {
        selected.push(batch[offset]);
      }
    }
  }
  const result: object[] = [];
  for (let index = 0; index < selected.length; index += 8) {
    result.push(...await Promise.all(selected.slice(index, index + 8).map(normalizeLocationWithSourceLine)));
  }
  return result;
}

export function resultLimit(args: Record<string, unknown>, defaultValue: number): number {
  return boundedInteger(args.maxResults, "maxResults", { defaultValue, maximum: 1_000 });
}

async function normalizeLocationWithSourceLine(value: vscode.Location | vscode.LocationLink): Promise<object> {
  const { uri, range } = locationTarget(value);
  return {
    ...normalizeDocumentUri(uri),
    ...normalizeRange(range),
    ...(await sourceLine(uri, range.start.line))
  };
}

export async function sourceLine(uri: vscode.Uri, zeroBasedLine: number): Promise<{ sourceLine: string } | object> {
  if (!isUriInWorkspace(uri)) {
    return {};
  }
  try {
    const document = await withTimeout((async () => {
      await ensureCanonicalWorkspaceContainment(uri);
      return openTextDocumentByUri(uri);
    })(), 5_000, "Opening source context timed out.");
    return { sourceLine: truncateSourceLine(document.lineAt(zeroBasedLine).text.trim()) };
  } catch {
    return {};
  }
}

function truncateSourceLine(value: string): string {
  return value.length <= sourceLineMaxLength ? value : `${value.slice(0, sourceLineMaxLength - 3)}...`;
}

async function openTextDocumentByUri(uri: vscode.Uri): Promise<vscode.TextDocument> {
  return vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString())
    ?? vscode.workspace.openTextDocument(uri);
}

export function markedStringToText(value: vscode.MarkdownString | vscode.MarkedString): string {
  if (typeof value === "string") {
    return value;
  }
  return "language" in value
    ? `\`\`\`${value.language}\n${value.value}\n\`\`\``
    : value.value;
}

export function markdownToText(value: string | vscode.MarkdownString | undefined): string | undefined {
  return value === undefined ? undefined : typeof value === "string" ? value : value.value;
}

export function normalizeHovers(values: vscode.Hover[] | undefined): object[] {
  return (values ?? []).slice(0, 100).map(hover => ({
    text: boundedText(
      hover.contents.slice(0, 100).map(value => boundedText(markedStringToText(value), 4_096)).join("\n\n"),
      16_384
    ),
    ...(hover.range ? normalizeRange(hover.range) : {})
  }));
}

export async function normalizeDocumentSymbols(
  values: Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined,
  maxResults = 1_000
): Promise<object[]> {
  const symbols = values ?? [];
  const symbolInformationUris = new Map<string, vscode.Uri>();
  for (const symbol of symbols.slice(0, maxResults)) {
    if ("location" in symbol) {
      symbolInformationUris.set(symbol.location.uri.toString(), symbol.location.uri);
    }
  }
  const allowedSymbolInformationUris = new Set<string>();
  const canExpose = createProviderUriExposureGuard();
  const uriEntries = [...symbolInformationUris.entries()];
  for (let index = 0; index < uriEntries.length; index += 8) {
    const batch = uriEntries.slice(index, index + 8);
    const allowed = await Promise.all(batch.map(([, uri]) => canExpose(uri)));
    for (let offset = 0; offset < batch.length; offset += 1) {
      if (allowed[offset]) {
        allowedSymbolInformationUris.add(batch[offset][0]);
      }
    }
  }

  let remaining = maxResults;
  const seen = new Set<vscode.DocumentSymbol | vscode.SymbolInformation>();
  const visit = (
    symbols: Array<vscode.DocumentSymbol | vscode.SymbolInformation>,
    depth: number
  ): object[] => {
    if (depth > 50 || remaining <= 0) {
      return [];
    }
    const normalized: object[] = [];
    for (const symbol of symbols) {
      if (remaining <= 0 || seen.has(symbol)) {
        continue;
      }
      seen.add(symbol);
      if ("location" in symbol) {
        if (!allowedSymbolInformationUris.has(symbol.location.uri.toString())) {
          continue;
        }
        remaining -= 1;
        normalized.push({
          name: boundedText(symbol.name, 1_024),
          containerName: boundedText(symbol.containerName, 2_048),
          kind: vscode.SymbolKind[symbol.kind],
          ...normalizeLocation(symbol.location)
        });
        continue;
      }
      remaining -= 1;
      normalized.push({
        name: boundedText(symbol.name, 1_024),
        detail: boundedText(symbol.detail, 4_096),
        kind: vscode.SymbolKind[symbol.kind],
        range: normalizeRange(symbol.range),
        selection: normalizeRange(symbol.selectionRange),
        line: symbol.selectionRange.start.line + 1,
        column: symbol.selectionRange.start.character + 1,
        endLine: symbol.selectionRange.end.line + 1,
        endColumn: symbol.selectionRange.end.character + 1,
        children: visit(symbol.children, depth + 1)
      });
    }
    return normalized;
  };
  return visit(symbols, 0);
}

export function normalizeWorkspaceSymbol(symbol: vscode.SymbolInformation): object {
  return {
    name: boundedText(symbol.name, 1_024),
    containerName: boundedText(symbol.containerName, 2_048),
    kind: vscode.SymbolKind[symbol.kind],
    ...normalizeLocation(symbol.location)
  };
}

export async function workspaceSymbols(args: Record<string, unknown>): Promise<object[]> {
  const values = await executeProviderCommand<vscode.SymbolInformation[]>(
    "vscode.executeWorkspaceSymbolProvider",
    stringArg(args, "query")
  );
  const maximum = resultLimit(args, 500);
  const candidates: vscode.SymbolInformation[] = [];
  for (const symbol of values ?? []) {
    if (isUriInWorkspace(symbol.location.uri)) {
      candidates.push(symbol);
      if (candidates.length >= maximum) {
        break;
      }
    }
  }

  const canExpose = createProviderUriExposureGuard();
  const normalized: object[] = [];
  for (let index = 0; index < candidates.length; index += 8) {
    const batch = candidates.slice(index, index + 8);
    const allowed = await Promise.all(batch.map(symbol => canExpose(symbol.location.uri)));
    for (let offset = 0; offset < batch.length; offset += 1) {
      if (allowed[offset]) {
        normalized.push(normalizeWorkspaceSymbol(batch[offset]));
      }
    }
  }
  return normalized;
}

export function normalizeDocumentHighlights(
  values: vscode.DocumentHighlight[] | undefined,
  maxResults = 1_000
): object[] {
  return (values ?? []).slice(0, maxResults).map(highlight => ({
    kind: highlight.kind === undefined ? undefined : vscode.DocumentHighlightKind[highlight.kind],
    ...normalizeRange(highlight.range)
  }));
}

export function normalizeUriForComparison(uri: vscode.Uri): string {
  const caseInsensitive = uri.scheme === "file" && process.platform === "win32";
  return `${uri.scheme}://${uri.authority}${normalizeFsPath(uri.path, caseInsensitive)}`;
}

export function normalizeCommand(command: vscode.Command | undefined): object | undefined {
  return command ? {
    title: boundedText(command.title, 1_024),
    command: boundedText(command.command, 1_024),
    argumentCount: command.arguments?.length ?? 0
  } : undefined;
}

export function normalizeTextEdit(edit: vscode.TextEdit): object {
  return { ...normalizeRange(edit.range), newText: boundedText(edit.newText, 262_144) };
}

export function boundedText(value: string | undefined, maximumLength = 65_536): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.length <= maximumLength
    ? value
    : maximumLength <= 3 ? value.slice(0, maximumLength) : `${value.slice(0, maximumLength - 3)}...`;
}

export async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length <= 500 ? message : `${message.slice(0, 497)}...`;
}

export function formatUriForApproval(uri: vscode.Uri): string {
  return isUriInWorkspace(uri) ? vscode.workspace.asRelativePath(uri, false) : `${uri.scheme}:<provider document>`;
}
