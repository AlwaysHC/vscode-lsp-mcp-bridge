import * as vscode from "vscode";
import { boundedInteger, normalizeComparableCode } from "../languageToolCore.js";
import {
  boundedText,
  createProviderUriExposureGuard,
  isSafeProviderResultUri,
  isUriInWorkspace,
  normalizeDocumentUri,
  normalizeLocation,
  normalizeRange,
  normalizeUriForComparison,
  openDocumentUri,
  optionalStringArg,
  optionalStringArrayArg
} from "./runtime.js";

const diagnosticMaxFiles = 500;
const diagnosticMaxItems = 5_000;
const diagnosticScanMaxItems = 50_000;
const diagnosticMaxWaitMs = 10_000;
const diagnosticOutputTextBudget = 4_194_304;
const diagnosticRelatedWorkspaceMaxFiles = 500;

export async function diagnostics(args: Record<string, unknown>): Promise<object> {
  const file = optionalStringArg(args, "file");
  const requestedUri = file ? await openDocumentUri(file) : undefined;
  const waitMs = boundedInteger(args.waitForSettledMs, "waitForSettledMs", {
    defaultValue: 0,
    minimum: 0,
    maximum: diagnosticMaxWaitMs
  });
  const settleMs = boundedInteger(args.settleMs, "settleMs", {
    defaultValue: 250,
    minimum: 50,
    maximum: 2_000
  });
  const wait = waitMs > 0
    ? await waitForDiagnosticsToSettle(requestedUri, waitMs, Math.min(settleMs, waitMs))
    : { elapsedMs: 0, timedOut: false, quietPeriodMs: 0 };
  const requestedSeverities = new Set(
    optionalStringArrayArg(args, "severities", 4).map(value => value.toLowerCase())
  );
  const requestedTags = new Set(optionalStringArrayArg(args, "tags", 2).map(value => value.toLowerCase()));
  const sourceFilter = optionalStringArg(args, "source")?.toLowerCase();
  const codeFilter = optionalStringArg(args, "code")?.toLowerCase();
  const messageFilter = optionalStringArg(args, "message")?.toLowerCase();
  const maxFiles = boundedInteger(args.maxFiles, "maxFiles", { defaultValue: 100, maximum: diagnosticMaxFiles });
  const maxDiagnostics = boundedInteger(args.maxDiagnostics, "maxDiagnostics", {
    defaultValue: 1_000,
    maximum: diagnosticMaxItems
  });
  const observedEntries: Array<[vscode.Uri, readonly vscode.Diagnostic[]]> = requestedUri
    ? [[requestedUri, vscode.languages.getDiagnostics(requestedUri)]]
    : vscode.languages.getDiagnostics().filter(([uri]) => isUriInWorkspace(uri));
  observedEntries.sort(([left], [right]) => left.toString().localeCompare(right.toString()));
  const canExpose = createProviderUriExposureGuard();
  const entries = requestedUri
    ? observedEntries
    : await canonicalDiagnosticEntries(observedEntries.slice(0, diagnosticMaxFiles), canExpose);

  const summary: Record<string, number> = { Error: 0, Warning: 0, Information: 0, Hint: 0 };
  const matching: Array<{ uri: vscode.Uri; diagnostic: vscode.Diagnostic }> = [];
  let scanned = 0;
  let scanTruncated = observedEntries.length > diagnosticMaxFiles;
  for (const [uri, values] of entries) {
    for (const diagnostic of values) {
      scanned += 1;
      if (scanned > diagnosticScanMaxItems) {
        scanTruncated = true;
        break;
      }
      const severity = vscode.DiagnosticSeverity[diagnostic.severity];
      const tags = diagnostic.tags?.map(tag => vscode.DiagnosticTag[tag].toLowerCase()) ?? [];
      if ((requestedSeverities.size > 0 && !requestedSeverities.has(severity.toLowerCase()))
        || (requestedTags.size > 0 && !tags.some(tag => requestedTags.has(tag)))
        || (sourceFilter && diagnostic.source?.toLowerCase() !== sourceFilter)
        || (codeFilter && normalizeComparableCode(diagnosticCodeValue(diagnostic.code)) !== codeFilter)
        || (messageFilter && !diagnostic.message.slice(0, 32_768).toLowerCase().includes(messageFilter))) {
        continue;
      }
      summary[severity] += 1;
      matching.push({ uri, diagnostic });
    }
    if (scanned > diagnosticScanMaxItems) {
      break;
    }
  }
  matching.sort((left, right) =>
    left.uri.toString().localeCompare(right.uri.toString())
      || left.diagnostic.range.start.compareTo(right.diagnostic.range.start)
  );

  const selected = matching.slice(0, maxDiagnostics);
  const allowedWorkspaceUris = await canonicalRelatedWorkspaceUris(entries, selected, canExpose);
  const grouped = new Map<string, { uri: vscode.Uri; diagnostics: object[] }>();
  let outputTextCharacters = 0;
  let outputBudgetTruncated = false;
  for (const { uri, diagnostic } of selected) {
    const key = uri.toString();
    if (!grouped.has(key) && grouped.size >= maxFiles) {
      continue;
    }
    const textSize = diagnosticOutputTextSize(diagnostic);
    if (outputTextCharacters + textSize > diagnosticOutputTextBudget) {
      outputBudgetTruncated = true;
      break;
    }
    outputTextCharacters += textSize;
    const group = grouped.get(key) ?? { uri, diagnostics: [] };
    group.diagnostics.push(normalizeDiagnostic(diagnostic, allowedWorkspaceUris));
    grouped.set(key, group);
  }
  const files = [...grouped.values()].map(group => ({
    ...normalizeDocumentUri(group.uri),
    diagnostics: group.diagnostics
  }));
  const returnedDiagnostics = files.reduce((count, group) => count + group.diagnostics.length, 0);
  return {
    summary: {
      workspaceFilesObserved: observedEntries.length,
      scannedDiagnostics: Math.min(scanned, diagnosticScanMaxItems),
      totalMatchingDiagnostics: matching.length,
      returnedDiagnostics,
      bySeverity: summary,
      truncated: scanTruncated || outputBudgetTruncated || returnedDiagnostics < matching.length
    },
    wait,
    files
  };
}

function normalizeDiagnostic(diagnostic: vscode.Diagnostic, allowedWorkspaceUris: ReadonlySet<string>): object {
  return {
    message: boundedText(diagnostic.message, 8_192),
    severity: vscode.DiagnosticSeverity[diagnostic.severity],
    source: boundedText(diagnostic.source, 512),
    code: boundedDiagnosticCode(diagnosticCodeValue(diagnostic.code)),
    tags: diagnostic.tags?.map(tag => vscode.DiagnosticTag[tag]),
    relatedInformation: diagnostic.relatedInformation
      ?.slice(0, 20)
      .filter(info => providerResultUriCanBeExposed(info.location.uri, allowedWorkspaceUris))
      .map(info => ({
        message: isUriInWorkspace(info.location.uri) ? boundedText(info.message, 2_048) : undefined,
        ...normalizeLocation(info.location)
      })),
    ...normalizeRange(diagnostic.range)
  };
}

async function canonicalDiagnosticEntries(
  entries: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>,
  canExpose: (uri: vscode.Uri) => Promise<boolean>
): Promise<Array<[vscode.Uri, readonly vscode.Diagnostic[]]>> {
  const result: Array<[vscode.Uri, readonly vscode.Diagnostic[]]> = [];
  for (let index = 0; index < entries.length; index += 8) {
    const batch = entries.slice(index, index + 8);
    const allowed = await Promise.all(batch.map(([uri]) => canExpose(uri)));
    for (let offset = 0; offset < batch.length; offset += 1) {
      if (allowed[offset]) {
        result.push(batch[offset]);
      }
    }
  }
  return result;
}

async function canonicalRelatedWorkspaceUris(
  entries: Array<[vscode.Uri, readonly vscode.Diagnostic[]]>,
  selected: Array<{ uri: vscode.Uri; diagnostic: vscode.Diagnostic }>,
  canExpose: (uri: vscode.Uri) => Promise<boolean>
): Promise<Set<string>> {
  const allowed = new Set(entries.map(([uri]) => uri.toString()));
  const candidates = new Map<string, vscode.Uri>();
  for (const { diagnostic } of selected) {
    for (const info of diagnostic.relatedInformation?.slice(0, 20) ?? []) {
      const uri = info.location.uri;
      const key = uri.toString();
      if (isUriInWorkspace(uri) && !allowed.has(key) && !candidates.has(key)) {
        candidates.set(key, uri);
        if (candidates.size >= diagnosticRelatedWorkspaceMaxFiles) {
          break;
        }
      }
    }
    if (candidates.size >= diagnosticRelatedWorkspaceMaxFiles) {
      break;
    }
  }

  const values = [...candidates.entries()];
  for (let index = 0; index < values.length; index += 8) {
    const batch = values.slice(index, index + 8);
    const canonical = await Promise.all(batch.map(([, uri]) => canExpose(uri)));
    for (let offset = 0; offset < batch.length; offset += 1) {
      if (canonical[offset]) {
        allowed.add(batch[offset][0]);
      }
    }
  }
  return allowed;
}

function providerResultUriCanBeExposed(uri: vscode.Uri, allowedWorkspaceUris: ReadonlySet<string>): boolean {
  return isSafeProviderResultUri(uri)
    && (!isUriInWorkspace(uri) || allowedWorkspaceUris.has(uri.toString()));
}

function boundedDiagnosticCode(code: string | number | undefined): string | number | undefined {
  return typeof code === "string" ? boundedText(code, 1_024) : code;
}

function diagnosticOutputTextSize(diagnostic: vscode.Diagnostic): number {
  return Math.min(diagnostic.message.length, 8_192)
    + Math.min(diagnostic.source?.length ?? 0, 512)
    + Math.min(String(diagnosticCodeValue(diagnostic.code) ?? "").length, 1_024)
    + (diagnostic.relatedInformation ?? []).slice(0, 20)
      .reduce((size, info) => size + Math.min(info.message.length, 2_048), 0);
}

function diagnosticCodeValue(code: vscode.Diagnostic["code"]): string | number | undefined {
  return code === undefined || typeof code === "string" || typeof code === "number" ? code : code.value;
}

async function waitForDiagnosticsToSettle(
  requestedUri: vscode.Uri | undefined,
  maximumWaitMs: number,
  quietPeriodMs: number
): Promise<{ elapsedMs: number; timedOut: boolean; quietPeriodMs: number }> {
  const startedAt = Date.now();
  return new Promise(resolve => {
    let finished = false;
    let quietTimer: NodeJS.Timeout | undefined;
    let maximumTimer: NodeJS.Timeout | undefined;
    let subscription: vscode.Disposable | undefined;
    const finish = (timedOut: boolean): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (quietTimer) {
        clearTimeout(quietTimer);
      }
      if (maximumTimer) {
        clearTimeout(maximumTimer);
      }
      subscription?.dispose();
      resolve({ elapsedMs: Date.now() - startedAt, timedOut, quietPeriodMs });
    };
    const restartQuietTimer = (): void => {
      if (quietTimer) {
        clearTimeout(quietTimer);
      }
      quietTimer = setTimeout(() => finish(false), quietPeriodMs);
    };
    subscription = vscode.languages.onDidChangeDiagnostics(event => {
      const relevant = event.uris.some(uri => requestedUri
        ? normalizeUriForComparison(uri) === normalizeUriForComparison(requestedUri)
        : isUriInWorkspace(uri));
      if (relevant) {
        restartQuietTimer();
      }
    });
    restartQuietTimer();
    maximumTimer = setTimeout(() => finish(true), maximumWaitMs);
  });
}
