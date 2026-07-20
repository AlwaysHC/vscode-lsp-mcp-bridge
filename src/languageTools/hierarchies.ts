import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { boundedInteger, traverseBoundedGraph } from "../languageToolCore.js";
import {
  boundedText,
  ensureCanonicalWorkspaceContainment,
  isSafeProviderResultUriForExposure,
  normalizeDocumentUri,
  normalizeRange,
  normalizeWorkspaceSymbol,
  openDocumentUri,
  optionalStringArg,
  positionArg,
  sourceLine,
  stringArg,
  withTimeout
} from "./runtime.js";
import { resolveWorkspaceSymbolQuery } from "./symbols.js";

const hierarchyMaxDepth = 4;
const hierarchyMaxNodes = 250;
const hierarchyDeadlineMs = 10_000;
const hierarchyCandidateMaxAttempts = 10;
const hierarchyPreparedRootLimit = 10;
const hierarchyTotalCallSitePreviewLimit = 1_000;

export interface HierarchyGraphResult {
  roots: string[];
  nodes: object[];
  edges: object[];
  errors: object[];
  truncated: boolean;
  depthLimited: boolean;
  truncationReasons: string[];
  limits: HierarchyLimits;
}

interface HierarchyLimits {
  maxDepth: number;
  maxNodes: number;
  maxEdges: number;
  maxChildrenPerNode: number;
  maxCallSitesPerEdge: number;
}

export async function hierarchyForSymbol(args: Record<string, unknown>, mode: "call" | "type"): Promise<object> {
  const resolved = await resolveWorkspaceSymbolQuery(args);
  const deadline = Date.now() + hierarchyDeadlineMs;
  for (const candidate of resolved.candidates.slice(0, hierarchyCandidateMaxAttempts)) {
    if (Date.now() >= deadline) {
      break;
    }
    const hierarchy = mode === "call"
      ? await callHierarchyAt(candidate.location.uri, candidate.location.range.start, args, deadline)
      : await typeHierarchyAt(candidate.location.uri, candidate.location.range.start, args, deadline);
    if (hierarchy.nodes.length > 0) {
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
    [mode === "call" ? "callHierarchy" : "typeHierarchy"]: emptyHierarchyGraph(args)
  };
}

export async function callRelationshipsForSymbol(
  args: Record<string, unknown>,
  direction: "incoming" | "outgoing"
): Promise<object> {
  const resolved = await resolveWorkspaceSymbolQuery(args);
  const maxResults = boundedInteger(args.maxResults, "maxResults", { defaultValue: 250, maximum: 1_000 });
  const deadline = Date.now() + hierarchyDeadlineMs;
  let selectedSymbol = resolved.selectedSymbol;
  let relationships: object[] = [];
  for (const candidate of resolved.candidates.slice(0, hierarchyCandidateMaxAttempts)) {
    if (Date.now() >= deadline) {
      break;
    }
    relationships = await callRelationshipsAt(
      candidate.location.uri,
      candidate.location.range.start,
      direction,
      maxResults,
      deadline
    );
    selectedSymbol = candidate;
    if (relationships.length > 0) {
      break;
    }
  }
  return {
    query: resolved.query,
    selectedSymbol: selectedSymbol ? normalizeWorkspaceSymbol(selectedSymbol) : undefined,
    candidates: resolved.candidates.map(normalizeWorkspaceSymbol),
    [direction === "incoming" ? "callers" : "callees"]: relationships
  };
}

export async function callRelationshipsAt(
  uri: vscode.Uri,
  position: vscode.Position,
  direction: "incoming" | "outgoing",
  maxResults: number,
  deadline = Date.now() + hierarchyDeadlineMs
): Promise<object[]> {
  await ensureCanonicalWorkspaceContainment(uri);
  const document = await vscode.workspace.openTextDocument(uri);
  if (!document.validatePosition(position).isEqual(position)) {
    throw new Error("The hierarchy position is outside the document.");
  }
  const items = await providerCommandWithinDeadline<vscode.CallHierarchyItem[]>(
    "vscode.prepareCallHierarchy",
    deadline,
    uri,
    position
  );
  const result: object[] = [];
  for (const item of (items ?? []).slice(0, hierarchyPreparedRootLimit)) {
    if (direction === "incoming") {
      const incoming = await providerCallWithinDeadline<vscode.CallHierarchyIncomingCall[]>(
        "vscode.provideIncomingCalls",
        item,
        deadline
      );
      for (const call of (incoming ?? []).slice(0, Math.min(maxResults, 1_000))) {
        if (!await isSafeHierarchyUri(call.from.uri, deadline)) {
          continue;
        }
        for (const range of call.fromRanges) {
          if (result.length >= maxResults) {
            return result;
          }
          if (Date.now() >= deadline) {
            return result;
          }
          result.push({
            callerName: boundedText(call.from.name, 1_024),
            callerDetail: boundedText(call.from.detail, 4_096),
            callerKind: vscode.SymbolKind[call.from.kind],
            ...normalizeDocumentUri(call.from.uri),
            callerLine: call.from.selectionRange.start.line + 1,
            callerColumn: call.from.selectionRange.start.character + 1,
            caller: normalizeCallHierarchyItem(call.from),
            callSite: await normalizeCallSite(call.from.uri, range, deadline)
          });
        }
      }
    } else {
      const outgoing = await providerCallWithinDeadline<vscode.CallHierarchyOutgoingCall[]>(
        "vscode.provideOutgoingCalls",
        item,
        deadline
      );
      for (const call of (outgoing ?? []).slice(0, Math.min(maxResults, 1_000))) {
        if (!await isSafeHierarchyUri(call.to.uri, deadline)) {
          continue;
        }
        for (const range of call.fromRanges) {
          if (result.length >= maxResults) {
            return result;
          }
          if (Date.now() >= deadline) {
            return result;
          }
          result.push({
            calleeName: boundedText(call.to.name, 1_024),
            calleeDetail: boundedText(call.to.detail, 4_096),
            calleeKind: vscode.SymbolKind[call.to.kind],
            ...normalizeDocumentUri(call.to.uri),
            calleeLine: call.to.selectionRange.start.line + 1,
            calleeColumn: call.to.selectionRange.start.character + 1,
            callee: normalizeCallHierarchyItem(call.to),
            callSite: await normalizeCallSite(item.uri, range, deadline)
          });
        }
      }
    }
  }
  return result;
}

async function normalizeCallSite(uri: vscode.Uri, range: vscode.Range, deadline: number): Promise<object> {
  if (!await isSafeHierarchyUri(uri, deadline)) {
    return { external: true };
  }
  const remaining = deadline - Date.now();
  const preview = remaining > 0
    ? await withTimeout(sourceLine(uri, range.start.line), Math.min(remaining, 1_000), "Source preview timed out.")
      .catch(() => ({}))
    : {};
  return { ...normalizeDocumentUri(uri), ...normalizeRange(range), ...preview };
}

export async function callHierarchy(args: Record<string, unknown>): Promise<HierarchyGraphResult> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  return callHierarchyAt(uri, positionArg(args), args);
}

export async function callHierarchyAt(
  uri: vscode.Uri,
  position: vscode.Position,
  args: Record<string, unknown>,
  deadline = Date.now() + hierarchyDeadlineMs
): Promise<HierarchyGraphResult> {
  await ensureCanonicalWorkspaceContainment(uri);
  const document = await vscode.workspace.openTextDocument(uri);
  if (!document.validatePosition(position).isEqual(position)) {
    throw new Error("The call-hierarchy position is outside the document.");
  }
  const preparedValues = await providerCommandWithinDeadline<vscode.CallHierarchyItem[]>(
    "vscode.prepareCallHierarchy",
    deadline,
    uri,
    position
  ) ?? [];
  const preparedCandidates = preparedValues.slice(0, hierarchyPreparedRootLimit * 5);
  const preparedSafety = await Promise.all(preparedCandidates.map(item => isSafeHierarchyUri(item.uri, deadline)));
  const roots = preparedCandidates.filter((_, index) => preparedSafety[index]).slice(0, hierarchyPreparedRootLimit);
  const limits = hierarchyLimits(args);
  const direction = hierarchyDirection(args, ["both", "incoming", "outgoing"] as const);
  const edges: object[] = [];
  const edgeKeys = new Set<string>();
  const errors: object[] = [];
  const truncationReasons = new Set<string>();
  const publicHierarchyId = createPublicHierarchyId();
  let remainingCallSitePreviews = hierarchyTotalCallSitePreviewLimit;
  if (preparedValues.length > roots.length) {
    truncationReasons.add("preparedRoots");
  }
  const addEdge = (edge: object, key: string): void => {
    if (edgeKeys.has(key)) {
      return;
    }
    if (edges.length >= limits.maxEdges) {
      truncationReasons.add("maxEdges");
      return;
    }
    edgeKeys.add(key);
    edges.push(edge);
  };
  const traversal = await traverseBoundedGraph(
    roots,
    callHierarchyItemKey,
    async item => {
      if (Date.now() >= deadline) {
        truncationReasons.add("deadline");
        return [];
      }
      const related: vscode.CallHierarchyItem[] = [];
      if (direction === "both" || direction === "incoming") {
        try {
          const incoming = await providerCallWithinDeadline<vscode.CallHierarchyIncomingCall[]>(
            "vscode.provideIncomingCalls",
            item,
            deadline
          );
          for (const call of (incoming ?? []).slice(0, limits.maxChildrenPerNode)) {
            if (!await isSafeHierarchyUri(call.from.uri, deadline)) {
              continue;
            }
            related.push(call.from);
            const from = callHierarchyItemKey(call.from);
            const to = callHierarchyItemKey(item);
            const callSiteLimit = Math.min(limits.maxCallSitesPerEdge, remainingCallSitePreviews);
            remainingCallSitePreviews -= Math.min(call.fromRanges.length, callSiteLimit);
            if (call.fromRanges.length > callSiteLimit) {
              truncationReasons.add("callSiteBudget");
            }
            addEdge({
              direction: "incoming",
              from: publicHierarchyId(from),
              to: publicHierarchyId(to),
              callSites: await normalizeCallSites(call.from.uri, call.fromRanges, callSiteLimit, deadline)
            }, `incoming|${from}|${to}`);
          }
          if ((incoming?.length ?? 0) > limits.maxChildrenPerNode) {
            truncationReasons.add("maxChildrenPerNode");
          }
        } catch (error) {
          errors.push({
            node: publicHierarchyId(callHierarchyItemKey(item)),
            direction: "incoming",
            error: hierarchyErrorMessage(error, item.uri)
          });
        }
      }
      if (direction === "both" || direction === "outgoing") {
        try {
          const outgoing = await providerCallWithinDeadline<vscode.CallHierarchyOutgoingCall[]>(
            "vscode.provideOutgoingCalls",
            item,
            deadline
          );
          for (const call of (outgoing ?? []).slice(0, limits.maxChildrenPerNode)) {
            if (!await isSafeHierarchyUri(call.to.uri, deadline)) {
              continue;
            }
            related.push(call.to);
            const from = callHierarchyItemKey(item);
            const to = callHierarchyItemKey(call.to);
            const callSiteLimit = Math.min(limits.maxCallSitesPerEdge, remainingCallSitePreviews);
            remainingCallSitePreviews -= Math.min(call.fromRanges.length, callSiteLimit);
            if (call.fromRanges.length > callSiteLimit) {
              truncationReasons.add("callSiteBudget");
            }
            addEdge({
              direction: "outgoing",
              from: publicHierarchyId(from),
              to: publicHierarchyId(to),
              callSites: await normalizeCallSites(item.uri, call.fromRanges, callSiteLimit, deadline)
            }, `outgoing|${from}|${to}`);
          }
          if ((outgoing?.length ?? 0) > limits.maxChildrenPerNode) {
            truncationReasons.add("maxChildrenPerNode");
          }
        } catch (error) {
          errors.push({
            node: publicHierarchyId(callHierarchyItemKey(item)),
            direction: "outgoing",
            error: hierarchyErrorMessage(error, item.uri)
          });
        }
      }
      return related;
    },
    limits
  );
  if (traversal.truncated) {
    truncationReasons.add("maxNodes");
  }
  if (traversal.depthLimited) {
    truncationReasons.add("maxDepth");
  }
  return graphResult(
    roots.map(item => publicHierarchyId(callHierarchyItemKey(item))),
    traversal.nodes.map(({ value, depth }) => ({
      id: publicHierarchyId(callHierarchyItemKey(value)),
      depth,
      ...normalizeCallHierarchyItem(value)
    })),
    filterEdgesToKnownNodes(edges, traversal.nodes.map(({ value }) => publicHierarchyId(callHierarchyItemKey(value)))),
    errors,
    truncationReasons,
    traversal.depthLimited,
    limits
  );
}

export async function typeHierarchy(args: Record<string, unknown>): Promise<HierarchyGraphResult> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  return typeHierarchyAt(uri, positionArg(args), args);
}

export async function typeHierarchyAt(
  uri: vscode.Uri,
  position: vscode.Position,
  args: Record<string, unknown>,
  deadline = Date.now() + hierarchyDeadlineMs
): Promise<HierarchyGraphResult> {
  await ensureCanonicalWorkspaceContainment(uri);
  const document = await vscode.workspace.openTextDocument(uri);
  if (!document.validatePosition(position).isEqual(position)) {
    throw new Error("The type-hierarchy position is outside the document.");
  }
  const preparedValues = await providerCommandWithinDeadline<vscode.TypeHierarchyItem[]>(
    "vscode.prepareTypeHierarchy",
    deadline,
    uri,
    position
  ) ?? [];
  const preparedCandidates = preparedValues.slice(0, hierarchyPreparedRootLimit * 5);
  const preparedSafety = await Promise.all(preparedCandidates.map(item => isSafeHierarchyUri(item.uri, deadline)));
  const roots = preparedCandidates.filter((_, index) => preparedSafety[index]).slice(0, hierarchyPreparedRootLimit);
  const limits = hierarchyLimits(args);
  const direction = hierarchyDirection(args, ["both", "supertypes", "subtypes"] as const);
  const edges: object[] = [];
  const edgeKeys = new Set<string>();
  const errors: object[] = [];
  const truncationReasons = new Set<string>();
  const publicHierarchyId = createPublicHierarchyId();
  if (preparedValues.length > roots.length) {
    truncationReasons.add("preparedRoots");
  }
  const addEdge = (relation: "supertype" | "subtype", from: string, to: string): void => {
    const key = `${relation}|${from}|${to}`;
    if (edgeKeys.has(key)) {
      return;
    }
    if (edges.length >= limits.maxEdges) {
      truncationReasons.add("maxEdges");
      return;
    }
    edgeKeys.add(key);
    edges.push({ relation, from, to });
  };
  const traversal = await traverseBoundedGraph(
    roots,
    typeHierarchyItemKey,
    async item => {
      if (Date.now() >= deadline) {
        truncationReasons.add("deadline");
        return [];
      }
      const related: vscode.TypeHierarchyItem[] = [];
      for (const relation of ["supertypes", "subtypes"] as const) {
        if (direction !== "both" && direction !== relation) {
          continue;
        }
        try {
          const command = relation === "supertypes" ? "vscode.provideSupertypes" : "vscode.provideSubtypes";
          const values = await providerCallWithinDeadline<vscode.TypeHierarchyItem[]>(command, item, deadline);
          for (const relatedItem of (values ?? []).slice(0, limits.maxChildrenPerNode)) {
            if (!await isSafeHierarchyUri(relatedItem.uri, deadline)) {
              continue;
            }
            related.push(relatedItem);
            addEdge(
              relation === "supertypes" ? "supertype" : "subtype",
              publicHierarchyId(typeHierarchyItemKey(item)),
              publicHierarchyId(typeHierarchyItemKey(relatedItem))
            );
          }
          if ((values?.length ?? 0) > limits.maxChildrenPerNode) {
            truncationReasons.add("maxChildrenPerNode");
          }
        } catch (error) {
          errors.push({
            node: publicHierarchyId(typeHierarchyItemKey(item)),
            direction: relation,
            error: hierarchyErrorMessage(error, item.uri)
          });
        }
      }
      return related;
    },
    limits
  );
  if (traversal.truncated) {
    truncationReasons.add("maxNodes");
  }
  if (traversal.depthLimited) {
    truncationReasons.add("maxDepth");
  }
  return graphResult(
    roots.map(item => publicHierarchyId(typeHierarchyItemKey(item))),
    traversal.nodes.map(({ value, depth }) => ({
      id: publicHierarchyId(typeHierarchyItemKey(value)),
      depth,
      ...normalizeTypeHierarchyItem(value)
    })),
    filterEdgesToKnownNodes(edges, traversal.nodes.map(({ value }) => publicHierarchyId(typeHierarchyItemKey(value)))),
    errors,
    truncationReasons,
    traversal.depthLimited,
    limits
  );
}

function graphResult(
  roots: string[],
  nodes: object[],
  edges: object[],
  errors: object[],
  reasons: Set<string>,
  depthLimited: boolean,
  limits: HierarchyLimits
): HierarchyGraphResult {
  return {
    roots: roots.slice(0, limits.maxNodes),
    nodes,
    edges,
    errors,
    truncated: reasons.size > 0,
    depthLimited,
    truncationReasons: [...reasons],
    limits
  };
}

function normalizeCallHierarchyItem(item: vscode.CallHierarchyItem): object {
  return {
    name: boundedText(item.name, 1_024),
    detail: boundedText(item.detail, 4_096),
    kind: vscode.SymbolKind[item.kind],
    ...normalizeDocumentUri(item.uri),
    range: normalizeRange(item.range),
    ...normalizeRange(item.selectionRange)
  };
}

function normalizeTypeHierarchyItem(item: vscode.TypeHierarchyItem): object {
  return {
    name: boundedText(item.name, 1_024),
    detail: boundedText(item.detail, 4_096),
    kind: vscode.SymbolKind[item.kind],
    ...normalizeDocumentUri(item.uri),
    range: normalizeRange(item.range),
    ...normalizeRange(item.selectionRange)
  };
}

function callHierarchyItemKey(item: vscode.CallHierarchyItem): string {
  return hierarchyItemKey(item.uri, item.selectionRange, item.name, item.kind);
}

function typeHierarchyItemKey(item: vscode.TypeHierarchyItem): string {
  return hierarchyItemKey(item.uri, item.selectionRange, item.name, item.kind);
}

function hierarchyItemKey(uri: vscode.Uri, range: vscode.Range, name: string, kind: vscode.SymbolKind): string {
  return JSON.stringify([uri.toString(), range.start.line, range.start.character, name, kind]);
}

function createPublicHierarchyId(): (internalKey: string) => string {
  const ids = new Map<string, string>();
  return internalKey => {
    const existing = ids.get(internalKey);
    if (existing) {
      return existing;
    }
    const id = crypto.randomUUID();
    ids.set(internalKey, id);
    return id;
  };
}

function filterEdgesToKnownNodes(edges: object[], nodeIds: string[]): object[] {
  const known = new Set(nodeIds);
  return edges.filter(edge => {
    const endpoints = edge as { from?: unknown; to?: unknown };
    return typeof endpoints.from === "string" && typeof endpoints.to === "string"
      && known.has(endpoints.from) && known.has(endpoints.to);
  });
}

function hierarchyErrorMessage(_error: unknown, uri: vscode.Uri): string {
  return `The language provider could not expand this ${boundedText(uri.scheme, 64) ?? "provider-backed"} hierarchy node.`;
}

function hierarchyLimits(args: Record<string, unknown>): HierarchyLimits {
  return {
    maxDepth: boundedInteger(args.maxDepth, "maxDepth", { defaultValue: 2, minimum: 0, maximum: hierarchyMaxDepth }),
    maxNodes: boundedInteger(args.maxNodes, "maxNodes", { defaultValue: 100, maximum: hierarchyMaxNodes }),
    maxEdges: boundedInteger(args.maxEdges, "maxEdges", { defaultValue: 250, maximum: 1_000 }),
    maxChildrenPerNode: boundedInteger(args.maxChildrenPerNode, "maxChildrenPerNode", { defaultValue: 100, maximum: 100 }),
    maxCallSitesPerEdge: boundedInteger(args.maxCallSitesPerEdge, "maxCallSitesPerEdge", { defaultValue: 50, maximum: 100 })
  };
}

function emptyHierarchyGraph(args: Record<string, unknown>): HierarchyGraphResult {
  return graphResult([], [], [], [], new Set(), false, hierarchyLimits(args));
}

function hierarchyDirection<const T extends readonly string[]>(args: Record<string, unknown>, allowed: T): T[number] {
  const direction = optionalStringArg(args, "direction") ?? "both";
  if (!(allowed as readonly string[]).includes(direction)) {
    throw new Error(`Expected direction to be one of: ${allowed.join(", ")}.`);
  }
  return direction as T[number];
}

async function normalizeCallSites(
  uri: vscode.Uri,
  ranges: vscode.Range[],
  limit: number,
  deadline: number
): Promise<object[]> {
  if (!await isSafeHierarchyUri(uri, deadline)) {
    return [];
  }
  const result: object[] = [];
  const selected = ranges.slice(0, limit);
  for (let index = 0; index < selected.length && Date.now() < deadline; index += 8) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      break;
    }
    result.push(...await Promise.all(selected.slice(index, index + 8).map(async range => ({
      ...normalizeDocumentUri(uri),
      ...normalizeRange(range),
      ...(await withTimeout(sourceLine(uri, range.start.line), Math.min(remaining, 1_000), "Source preview timed out.")
        .catch(() => ({})))
    }))));
  }
  return result;
}

async function isSafeHierarchyUri(uri: vscode.Uri, deadline: number): Promise<boolean> {
  const remaining = deadline - Date.now();
  return remaining > 0 && await withTimeout(
    isSafeProviderResultUriForExposure(uri),
    Math.min(remaining, 1_000),
    "Hierarchy URI validation timed out."
  ).catch(() => false);
}

async function providerCallWithinDeadline<T>(command: string, item: unknown, deadline: number): Promise<T | undefined> {
  return providerCommandWithinDeadline<T>(command, deadline, item);
}

async function providerCommandWithinDeadline<T>(
  command: string,
  deadline: number,
  ...args: unknown[]
): Promise<T | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("Hierarchy traversal reached its deadline.");
  }
  return withTimeout(
    vscode.commands.executeCommand<T>(command, ...args),
    Math.min(remaining, 3_000),
    "Hierarchy provider request timed out."
  );
}
