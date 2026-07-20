import * as vscode from "vscode";
import { boundedInteger } from "../languageToolCore.js";
import { callRelationshipsAt } from "./hierarchies.js";
import {
  boundedText,
  ensureCanonicalWorkspaceContainment,
  locationsWithSourceLines,
  normalizeDocumentUri,
  normalizeHovers,
  normalizeRange,
  normalizeWorkspaceSymbol,
  openDocumentUri,
  positionArg,
  stringArg,
  withTimeout
} from "./runtime.js";
import { resolveWorkspaceSymbolQuery } from "./symbols.js";

export async function symbolContextAtPosition(args: Record<string, unknown>): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  return symbolContext(uri, positionArg(args, document), args);
}

export async function symbolContextForSymbol(args: Record<string, unknown>): Promise<object> {
  const resolved = await resolveWorkspaceSymbolQuery(args);
  const selected = resolved.selectedSymbol;
  return {
    query: resolved.query,
    selectedSymbol: selected ? normalizeWorkspaceSymbol(selected) : undefined,
    candidates: resolved.candidates.map(normalizeWorkspaceSymbol),
    context: selected
      ? await symbolContext(selected.location.uri, selected.location.range.start, args)
      : emptySymbolContext()
  };
}

async function symbolContext(
  uri: vscode.Uri,
  position: vscode.Position,
  args: Record<string, unknown>
): Promise<object> {
  await ensureCanonicalWorkspaceContainment(uri);
  const document = await vscode.workspace.openTextDocument(uri);
  if (!document.validatePosition(position).isEqual(position)) {
    throw new Error("The symbol-context position is outside the document.");
  }
  const maxResults = boundedInteger(args.maxResults, "maxResults", { defaultValue: 50, maximum: 500 });
  const tasks = [
    {
      name: "hover",
      run: async () => normalizeHovers(await vscode.commands.executeCommand<vscode.Hover[]>(
        "vscode.executeHoverProvider",
        uri,
        position
      )).slice(0, maxResults)
    },
    locationTask("definitions", "vscode.executeDefinitionProvider", uri, position, maxResults),
    locationTask("typeDefinitions", "vscode.executeTypeDefinitionProvider", uri, position, maxResults),
    locationTask("implementations", "vscode.executeImplementationProvider", uri, position, maxResults),
    locationTask("references", "vscode.executeReferenceProvider", uri, position, maxResults),
    { name: "callers", run: async () => callRelationshipsAt(uri, position, "incoming", maxResults) },
    { name: "callees", run: async () => callRelationshipsAt(uri, position, "outgoing", maxResults) },
    { name: "containingSymbols", run: async () => containingDocumentSymbols(uri, position, maxResults) }
  ];
  const { values, errors } = await settleProviderTasks(tasks, 3, 10_000);
  return {
    at: { ...normalizeDocumentUri(uri), line: position.line + 1, column: position.character + 1 },
    hover: values.hover ?? [],
    definitions: values.definitions ?? [],
    typeDefinitions: values.typeDefinitions ?? [],
    implementations: values.implementations ?? [],
    references: values.references ?? [],
    callers: values.callers ?? [],
    callees: values.callees ?? [],
    containingSymbols: values.containingSymbols ?? [],
    errors,
    maxResultsPerCategory: maxResults
  };
}

function locationTask(
  name: string,
  command: string,
  uri: vscode.Uri,
  position: vscode.Position,
  maxResults: number
): { name: string; run: () => Promise<object[]> } {
  return {
    name,
    run: async () => locationsWithSourceLines(
      await vscode.commands.executeCommand<Array<vscode.Location | vscode.LocationLink>>(command, uri, position),
      maxResults
    )
  };
}

function emptySymbolContext(): object {
  return {
    hover: [],
    definitions: [],
    typeDefinitions: [],
    implementations: [],
    references: [],
    callers: [],
    callees: [],
    containingSymbols: [],
    errors: []
  };
}

async function settleProviderTasks(
  tasks: Array<{ name: string; run: () => Promise<unknown> }>,
  concurrency: number,
  timeoutMs: number
): Promise<{ values: Record<string, unknown>; errors: object[] }> {
  const values: Record<string, unknown> = {};
  const errors: object[] = [];
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (nextIndex < tasks.length) {
      const task = tasks[nextIndex];
      nextIndex += 1;
      try {
        values[task.name] = await withTimeout(task.run(), timeoutMs, `${task.name} provider request timed out.`);
      } catch {
        values[task.name] = [];
        errors.push({ feature: task.name, error: "The language provider request failed or timed out." });
      }
    }
  }));
  errors.sort((left, right) => String((left as { feature: string }).feature).localeCompare((right as { feature: string }).feature));
  return { values, errors };
}

async function containingDocumentSymbols(
  uri: vscode.Uri,
  position: vscode.Position,
  maxResults: number
): Promise<object[]> {
  const roots = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation>>(
    "vscode.executeDocumentSymbolProvider",
    uri
  );
  const result: Array<{ symbol: vscode.DocumentSymbol; depth: number }> = [];
  const pending = (roots ?? [])
    .filter((value): value is vscode.DocumentSymbol => !("location" in value))
    .map(symbol => ({ symbol, depth: 0 }));
  const seen = new Set<vscode.DocumentSymbol>();
  let visited = 0;
  while (pending.length > 0 && visited < 5_000) {
    const current = pending.pop();
    if (!current || seen.has(current.symbol)) {
      continue;
    }
    seen.add(current.symbol);
    visited += 1;
    if (current.symbol.range.contains(position)) {
      result.push(current);
      for (const child of current.symbol.children.slice(0, 1_000)) {
        pending.push({ symbol: child, depth: current.depth + 1 });
      }
    }
  }
  return result
    .sort((left, right) => right.depth - left.depth)
    .slice(0, maxResults)
    .map(({ symbol, depth }) => ({
      name: boundedText(symbol.name, 1_024),
      detail: boundedText(symbol.detail, 4_096),
      kind: vscode.SymbolKind[symbol.kind],
      depth,
      range: normalizeRange(symbol.range),
      selection: normalizeRange(symbol.selectionRange)
    }));
}
