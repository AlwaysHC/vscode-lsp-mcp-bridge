import * as vscode from "vscode";
import { boundedInteger } from "../languageToolCore.js";
import {
  ensureCanonicalWorkspaceContainment,
  executeProviderCommand,
  createProviderUriExposureGuard,
  isUriInWorkspace,
  locationsWithSourceLines,
  normalizeUriForComparison,
  normalizeWorkspaceSymbol,
  openDocumentUri,
  optionalStringArg,
  resolveFileUri,
  resultLimit,
  stringArg,
  withTimeout
} from "./runtime.js";
import type { FlattenedDocumentSymbol, ResolvedSymbolQuery, SymbolHints } from "./types.js";

export async function referencesForSymbol(args: Record<string, unknown>): Promise<object> {
  const resolved = await resolveWorkspaceSymbolQuery(args);
  const references = resolved.selectedSymbol
    ? await locationsWithSourceLines(
        await executeAtResolvedSymbol<vscode.Location[]>("vscode.executeReferenceProvider", resolved.selectedSymbol),
        resultLimit(args, 500)
      )
    : [];
  return normalizedResolution(resolved, { references });
}

export async function definitionForSymbol(args: Record<string, unknown>): Promise<object> {
  const resolved = await resolveWorkspaceSymbolQuery(args);
  const definitions = resolved.selectedSymbol
    ? await locationsWithSourceLines(
        await executeAtResolvedSymbol<Array<vscode.Location | vscode.LocationLink>>(
          "vscode.executeDefinitionProvider",
          resolved.selectedSymbol
        ),
        resultLimit(args, 100)
      )
    : [];
  return normalizedResolution(resolved, { definitions });
}

export function normalizedResolution(resolved: ResolvedSymbolQuery, result: object): object {
  return {
    query: resolved.query,
    selectedSymbol: resolved.selectedSymbol ? normalizeWorkspaceSymbol(resolved.selectedSymbol) : undefined,
    candidates: resolved.candidates.map(normalizeWorkspaceSymbol),
    ...result
  };
}

export async function resolveWorkspaceSymbolQuery(args: Record<string, unknown>): Promise<ResolvedSymbolQuery> {
  const query = stringArg(args, "query");
  const hints: SymbolHints = {
    query,
    containerName: optionalStringArg(args, "containerName"),
    file: optionalStringArg(args, "file"),
    kind: optionalStringArg(args, "kind")
  };
  const maxCandidates = boundedInteger(args.maxCandidates, "maxCandidates", { defaultValue: 10, maximum: 100 });
  const requestedFile = hints.file ? await resolveFileUri(hints.file) : undefined;
  const candidates = rankWorkspaceSymbols(await symbolsForQuery(hints), hints, requestedFile).slice(0, maxCandidates);
  return {
    query,
    selectedSymbol: candidates[0]?.symbol,
    candidates: candidates.map(value => value.symbol)
  };
}

export async function executeAtResolvedSymbol<T>(
  command: string,
  symbol: vscode.SymbolInformation
): Promise<T | undefined> {
  await ensureCanonicalWorkspaceContainment(symbol.location.uri);
  const document = await vscode.workspace.openTextDocument(symbol.location.uri);
  if (!document.validatePosition(symbol.location.range.start).isEqual(symbol.location.range.start)) {
    throw new Error("The resolved symbol position is outside its document.");
  }
  return executeProviderCommand<T>(command, symbol.location.uri, symbol.location.range.start);
}

async function workspaceSymbolsForQuery(query: string): Promise<vscode.SymbolInformation[]> {
  const queryParts = query.split(".").filter(Boolean);
  const queries = [query, queryParts.at(-1)].filter(
    (value, index, values): value is string => Boolean(value) && values.indexOf(value) === index
  );
  const symbols = new Map<string, vscode.SymbolInformation>();
  const canExpose = createProviderUriExposureGuard();
  const results = await Promise.all(queries.map(workspaceQuery =>
    executeProviderCommand<vscode.SymbolInformation[]>("vscode.executeWorkspaceSymbolProvider", workspaceQuery)
  ));
  for (const values of results) {
    for (const symbol of await safeWorkspaceSymbols((values ?? []).slice(0, 5_000), canExpose)) {
      symbols.set(workspaceSymbolKey(symbol), symbol);
    }
  }
  return [...symbols.values()];
}

async function symbolsForQuery(hints: SymbolHints): Promise<vscode.SymbolInformation[]> {
  const symbols = new Map<string, vscode.SymbolInformation>();
  const [workspaceSymbols, documentSymbols] = await Promise.all([
    workspaceSymbolsForQuery(hints.query),
    documentSymbolsForQuery(hints)
  ]);
  for (const symbol of workspaceSymbols) {
    symbols.set(workspaceSymbolKey(symbol), symbol);
  }
  for (const symbol of documentSymbols) {
    symbols.set(workspaceSymbolKey(symbol), symbol);
  }
  return [...symbols.values()];
}

async function documentSymbolsForQuery(hints: SymbolHints): Promise<vscode.SymbolInformation[]> {
  const uris = await documentSymbolSearchUris(hints);
  const result: vscode.SymbolInformation[] = [];
  const canExpose = createProviderUriExposureGuard();
  const valuesByUri = await Promise.all(uris.map(async uri => ({
    uri,
    values: await executeProviderCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
      "vscode.executeDocumentSymbolProvider",
      uri
    )
  })));
  for (const { uri, values } of valuesByUri) {
    const legacySymbols = (values ?? []).filter(
      (value): value is vscode.SymbolInformation => "location" in value && isUriInWorkspace(value.location.uri)
    ).slice(0, 1_000);
    for (const symbol of await safeWorkspaceSymbols(legacySymbols, canExpose)) {
      result.push(symbol);
      if (result.length >= 5_000) {
        return result;
      }
    }
    for (const symbol of flattenDocumentSymbols(uri, values ?? [])) {
      result.push(new vscode.SymbolInformation(
        symbol.symbol.name,
        symbol.symbol.kind,
        symbol.containerName,
        new vscode.Location(uri, symbol.symbol.selectionRange)
      ));
      if (result.length >= 5_000) {
        return result;
      }
    }
  }
  return result;
}

async function safeWorkspaceSymbols(
  values: vscode.SymbolInformation[],
  canExpose: (uri: vscode.Uri) => Promise<boolean>
): Promise<vscode.SymbolInformation[]> {
  const result: vscode.SymbolInformation[] = [];
  for (let index = 0; index < values.length; index += 16) {
    const batch = values.slice(index, index + 16);
    const allowed = await Promise.all(batch.map(symbol => canExpose(symbol.location.uri)));
    result.push(...batch.filter((_, batchIndex) => allowed[batchIndex]));
  }
  return result;
}

async function documentSymbolSearchUris(hints: SymbolHints): Promise<vscode.Uri[]> {
  if (hints.file) {
    return [await openDocumentUri(hints.file)];
  }
  const containerName = hints.containerName ?? hints.query.split(".").filter(Boolean).slice(0, -1).join(".");
  const leaf = containerName.split(".").filter(Boolean).at(-1);
  if (!leaf || !/^[\p{L}\p{N}_$-]+$/u.test(leaf)) {
    return [];
  }
  const files = await withTimeout(
    vscode.workspace.findFiles(
      `**/${leaf}.*`,
      "**/{node_modules,bin,obj,dist,out,build,.git}/**",
      10
    ),
    10_000,
    "Document-symbol fallback search timed out."
  );
  await Promise.all(files.map(async uri => {
    await ensureCanonicalWorkspaceContainment(uri);
    await withTimeout(vscode.workspace.openTextDocument(uri), 10_000, "Opening a symbol candidate document timed out.");
  }));
  return files;
}

function flattenDocumentSymbols(
  uri: vscode.Uri,
  values: Array<vscode.DocumentSymbol | vscode.SymbolInformation>
): FlattenedDocumentSymbol[] {
  const result: FlattenedDocumentSymbol[] = [];
  const pending = values
    .filter((value): value is vscode.DocumentSymbol => !("location" in value))
    .map(symbol => ({ symbol, containers: [] as string[], depth: 0 }));
  const seen = new Set<vscode.DocumentSymbol>();
  while (pending.length > 0 && result.length < 5_000) {
    const current = pending.pop();
    if (!current || seen.has(current.symbol) || current.depth > 50) {
      continue;
    }
    seen.add(current.symbol);
    result.push({ symbol: current.symbol, containerName: current.containers.join("."), uri });
    for (const child of current.symbol.children.slice(0, 1_000)) {
      pending.push({
        symbol: child,
        containers: [...current.containers, current.symbol.name],
        depth: current.depth + 1
      });
    }
  }
  return result;
}

function workspaceSymbolKey(symbol: vscode.SymbolInformation): string {
  return [
    symbol.name.slice(0, 4_096),
    symbol.containerName.slice(0, 8_192),
    symbol.location.uri.toString().slice(0, 32_768),
    symbol.location.range.start.line,
    symbol.location.range.start.character
  ].join("|");
}

function rankWorkspaceSymbols(
  symbols: vscode.SymbolInformation[],
  hints: SymbolHints,
  requestedFile: vscode.Uri | undefined
): Array<{ symbol: vscode.SymbolInformation; score: number }> {
  const query = hints.query.toLowerCase();
  const queryParts = hints.query.split(".").filter(Boolean);
  const requestedName = (queryParts.at(-1) ?? hints.query).toLowerCase();
  const requestedContainer = (hints.containerName ?? queryParts.slice(0, -1).join(".")).toLowerCase();
  const requestedFileKey = requestedFile ? normalizeUriForComparison(requestedFile) : undefined;
  const requestedKind = hints.kind?.toLowerCase();
  return symbols
    .filter(symbol => {
      if (requestedFileKey && normalizeUriForComparison(symbol.location.uri) !== requestedFileKey) {
        return false;
      }
      if (hints.containerName && !symbol.containerName.toLowerCase().includes(hints.containerName.toLowerCase())) {
        return false;
      }
      if (requestedKind && vscode.SymbolKind[symbol.kind].toLowerCase() !== requestedKind) {
        return false;
      }
      const name = symbol.name.slice(0, 4_096).toLowerCase();
      if (!name) {
        return false;
      }
      return name === requestedName
        || name.includes(requestedName)
        || requestedName.includes(name)
        || query.includes(name);
    })
    .map(symbol => {
      const name = symbol.name.slice(0, 4_096).toLowerCase();
      const container = symbol.containerName.slice(0, 8_192).toLowerCase();
      const symbolKind = vscode.SymbolKind[symbol.kind];
      const nameScore = name === requestedName
        ? 120
        : name.includes(requestedName) || requestedName.includes(name)
          ? 60
          : query.includes(name) ? 20 : 0;
      const containerScore = !requestedContainer
        ? 0
        : container === requestedContainer
          ? 100
          : container.includes(requestedContainer) || requestedContainer.includes(container) ? 50 : 0;
      const semanticKindScore = ["Method", "Function", "Constructor", "Class", "Interface", "Struct"].includes(symbolKind)
        ? 25
        : 0;
      const exactKindScore = requestedKind && symbolKind.toLowerCase() === requestedKind ? 50 : 0;
      return { symbol, score: nameScore + containerScore + semanticKindScore + exactKindScore };
    })
    .sort((left, right) => right.score - left.score
      || workspaceSymbolKey(left.symbol).localeCompare(workspaceSymbolKey(right.symbol)));
}
