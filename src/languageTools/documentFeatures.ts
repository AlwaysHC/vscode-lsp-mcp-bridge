import * as vscode from "vscode";
import { boundedInteger } from "../languageToolCore.js";
import {
  boundedText,
  createProviderUriExposureGuard,
  executeDocument,
  executeProviderCommand,
  isUriInWorkspace,
  markdownToText,
  normalizeCommand,
  normalizeDocumentUri,
  normalizeRange,
  openDocumentUri,
  optionalNonNegativeIntegerArg,
  optionalNumberArg,
  optionalRangeArg,
  optionalStringArg,
  positionArg,
  rangeArg,
  resultLimit,
  stoppedLocationArg,
  stringArg
} from "./runtime.js";

export async function selectionRanges(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const values = await executeProviderCommand<vscode.SelectionRange[]>(
    "vscode.executeSelectionRangeProvider",
    uri,
    [positionArg(args, document)]
  );
  return (values ?? []).slice(0, resultLimit(args, 100)).map(normalizeSelectionRange);
}

function normalizeSelectionRange(value: vscode.SelectionRange): object {
  const ranges: object[] = [];
  const seen = new Set<vscode.SelectionRange>();
  let current: vscode.SelectionRange | undefined = value;
  while (current && ranges.length < 100 && !seen.has(current)) {
    seen.add(current);
    ranges.push(normalizeRange(current.range));
    current = current.parent;
  }
  return { ranges, truncated: Boolean(current) };
}

export async function documentLinks(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const linkResolveCount = boundedInteger(args.linkResolveCount, "linkResolveCount", {
    defaultValue: 100,
    maximum: 500
  });
  const values = await executeProviderCommand<vscode.DocumentLink[]>(
    "vscode.executeLinkProvider",
    uri,
    linkResolveCount
  );
  const selected = (values ?? []).slice(0, resultLimit(args, 500));
  const canExpose = createProviderUriExposureGuard();
  const result: object[] = [];
  for (let index = 0; index < selected.length; index += 8) {
    result.push(...await Promise.all(selected.slice(index, index + 8).map(async link => {
      const targetIsSafe = link.target ? await canExpose(link.target) : false;
      const target = link.target ? normalizeLinkTarget(link.target, targetIsSafe) : undefined;
      const targetIsWorkspace = targetIsSafe && link.target ? isUriInWorkspace(link.target) : false;
      return {
        ...normalizeRange(link.range),
        target,
        tooltip: !link.target || targetIsWorkspace ? boundedText(link.tooltip, 4_096) : undefined
      };
    })));
  }
  return result;
}

function normalizeLinkTarget(uri: vscode.Uri, safe: boolean): object {
  if (safe) {
    return normalizeDocumentUri(uri);
  }
  return {
    uriScheme: uri.scheme,
    external: true,
    openableThroughBridge: false
  };
}

export async function semanticTokens(args: Record<string, unknown>, rangeMode: boolean): Promise<object> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const range = optionalRangeArg(args, document);
  const maxTokens = boundedInteger(args.maxTokens, "maxTokens", { defaultValue: 5_000, maximum: 20_000 });
  const legend = rangeMode
    ? await executeProviderCommand<vscode.SemanticTokensLegend>("vscode.provideDocumentRangeSemanticTokensLegend", uri, range)
    : await executeProviderCommand<vscode.SemanticTokensLegend>("vscode.provideDocumentSemanticTokensLegend", uri);
  const tokens = rangeMode
    ? await executeProviderCommand<vscode.SemanticTokens>("vscode.provideDocumentRangeSemanticTokens", uri, range)
    : await executeProviderCommand<vscode.SemanticTokens>("vscode.provideDocumentSemanticTokens", uri);
  const decoded = decodeSemanticTokens(tokens, legend, maxTokens);
  return {
    legend: legend ? {
      tokenTypes: legend.tokenTypes.slice(0, 256).map(value => boundedText(value, 256)),
      tokenModifiers: legend.tokenModifiers.slice(0, 256).map(value => boundedText(value, 256)),
      truncated: legend.tokenTypes.length > 256 || legend.tokenModifiers.length > 256
    } : undefined,
    resultId: tokens?.resultId,
    totalTokens: Math.floor((tokens?.data.length ?? 0) / 5),
    truncated: Math.floor((tokens?.data.length ?? 0) / 5) > decoded.length,
    tokens: decoded
  };
}

function decodeSemanticTokens(
  tokens: vscode.SemanticTokens | undefined,
  legend: vscode.SemanticTokensLegend | undefined,
  maxTokens: number
): object[] {
  const data = tokens?.data ?? new Uint32Array();
  const result: object[] = [];
  let line = 0;
  let character = 0;
  for (let index = 0; index + 4 < data.length && result.length < maxTokens; index += 5) {
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
      tokenType: boundedText(legend?.tokenTypes[tokenType], 256) ?? tokenType,
      tokenModifiers: decodeTokenModifiers(tokenModifiers, legend)
    });
  }
  return result;
}

function decodeTokenModifiers(bitset: number, legend: vscode.SemanticTokensLegend | undefined): Array<string | number> {
  return legend
    ? legend.tokenModifiers.slice(0, 32)
      .filter((_, index) => (bitset & Math.pow(2, index)) !== 0)
      .map(value => boundedText(value, 256) ?? "")
    : bitset === 0 ? [] : [bitset];
}

export async function foldingRanges(args: Record<string, unknown>): Promise<object[]> {
  const values = await executeDocument<vscode.FoldingRange[]>("vscode.executeFoldingRangeProvider", args);
  return (values ?? []).slice(0, resultLimit(args, 1_000)).map(range => ({
    startLine: range.start + 1,
    endLine: range.end + 1,
    kind: range.kind
  }));
}

export async function documentColors(args: Record<string, unknown>): Promise<object[]> {
  const values = await executeDocument<vscode.ColorInformation[]>("vscode.executeDocumentColorProvider", args);
  return (values ?? []).slice(0, resultLimit(args, 1_000)).map(info => ({
    color: normalizeColor(info.color),
    ...normalizeRange(info.range)
  }));
}

export async function colorPresentations(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const values = await executeProviderCommand<vscode.ColorPresentation[]>(
    "vscode.executeColorPresentationProvider",
    colorArg(args),
    { uri, range: rangeArg(args, document) }
  );
  return (values ?? []).slice(0, resultLimit(args, 100)).map(presentation => ({
    label: boundedText(presentation.label, 4_096),
    textEdit: presentation.textEdit ? normalizeBoundedTextEdit(presentation.textEdit, 4_096) : undefined,
    additionalTextEdits: presentation.additionalTextEdits?.slice(0, 20)
      .map(edit => normalizeBoundedTextEdit(edit, 4_096)),
    additionalTextEditsTruncated: (presentation.additionalTextEdits?.length ?? 0) > 20
  }));
}

function colorArg(args: Record<string, unknown>): vscode.Color {
  const channels = ["red", "green", "blue", "alpha"] as const;
  const values = channels.map(channel => optionalNumberArg(args, channel, channel === "alpha" ? 1 : 0));
  if (values.some(value => value < 0 || value > 1)) {
    throw new Error("Color channels must be numbers from 0 through 1.");
  }
  return new vscode.Color(values[0], values[1], values[2], values[3]);
}

function normalizeColor(color: vscode.Color): object {
  return { red: color.red, green: color.green, blue: color.blue, alpha: color.alpha };
}

export async function inlineValues(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const range = optionalRangeArg(args, document);
  const values = await executeProviderCommand<vscode.InlineValue[]>(
    "vscode.executeInlineValueProvider",
    uri,
    range,
    {
      frameId: optionalNonNegativeIntegerArg(args, "frameId", 0),
      stoppedLocation: stoppedLocationArg(args, range, document)
    } satisfies vscode.InlineValueContext
  );
  return (values ?? []).slice(0, resultLimit(args, 1_000)).map(normalizeInlineValue);
}

function normalizeInlineValue(value: vscode.InlineValue): object {
  if ("text" in value) {
    return { type: "text", text: boundedText(value.text, 4_096), ...normalizeRange(value.range) };
  }
  if ("variableName" in value || "caseSensitiveLookup" in value) {
    return {
      type: "variableLookup",
      variableName: boundedText(value.variableName, 1_024),
      caseSensitiveLookup: value.caseSensitiveLookup,
      ...normalizeRange(value.range)
    };
  }
  return { type: "evaluatableExpression", expression: boundedText(value.expression, 4_096), ...normalizeRange(value.range) };
}

export async function signatureHelp(args: Record<string, unknown>): Promise<object | undefined> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const value = await executeProviderCommand<vscode.SignatureHelp>(
    "vscode.executeSignatureHelpProvider",
    uri,
    positionArg(args, document),
    optionalStringArg(args, "triggerCharacter")
  );
  if (!value) {
    return undefined;
  }
  return {
    activeSignature: value.activeSignature + 1,
    activeParameter: value.activeParameter + 1,
    signatures: value.signatures.slice(0, 25).map(signature => ({
      label: boundedText(signature.label, 4_096),
      documentation: boundedText(markdownToText(signature.documentation), 4_096),
      activeParameter: signature.activeParameter === undefined ? undefined : signature.activeParameter + 1,
      parameters: signature.parameters.slice(0, 50).map(parameter => ({
        label: typeof parameter.label === "string" ? boundedText(parameter.label, 2_048) : parameter.label,
        documentation: boundedText(markdownToText(parameter.documentation), 2_048)
      }))
    }))
  };
}

export async function codeLens(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const itemResolveCount = boundedInteger(args.itemResolveCount, "itemResolveCount", { defaultValue: 100, maximum: 500 });
  const values = await executeProviderCommand<vscode.CodeLens[]>("vscode.executeCodeLensProvider", uri, itemResolveCount);
  return (values ?? []).slice(0, resultLimit(args, 500)).map(lens => ({
    ...normalizeRange(lens.range),
    command: normalizeCommand(lens.command)
  }));
}

export async function inlayHints(args: Record<string, unknown>): Promise<object[]> {
  const uri = await openDocumentUri(stringArg(args, "file"));
  const document = await vscode.workspace.openTextDocument(uri);
  const values = await executeProviderCommand<vscode.InlayHint[]>(
    "vscode.executeInlayHintProvider",
    uri,
    optionalRangeArg(args, document)
  );
  const takeText = createTextBudget(4_194_304);
  const canExpose = createProviderUriExposureGuard();
  const selected = (values ?? []).slice(0, resultLimit(args, 1_000));
  const result: object[] = [];
  for (let index = 0; index < selected.length; index += 8) {
    result.push(...await Promise.all(selected.slice(index, index + 8).map(hint =>
      normalizeInlayHint(hint, takeText, canExpose)
    )));
  }
  return result;
}

async function normalizeInlayHint(
  hint: vscode.InlayHint,
  takeText: (value: string | undefined, itemMaximum: number) => string | undefined,
  canExpose: (uri: vscode.Uri) => Promise<boolean>
): Promise<object> {
  return {
    label: typeof hint.label === "string" ? takeText(hint.label, 4_096) : await Promise.all(hint.label.slice(0, 20).map(async part => {
      const exposeLocation = part.location
        ? await canExpose(part.location.uri)
        : false;
      const workspaceLocation = exposeLocation && part.location && isUriInWorkspace(part.location.uri);
      return {
        value: takeText(part.value, 1_024),
        tooltip: !part.location || workspaceLocation
          ? takeText(typeof part.tooltip === "string" ? part.tooltip : part.tooltip?.value, 2_048)
          : undefined,
        location: exposeLocation && part.location
          ? { ...normalizeDocumentUri(part.location.uri), ...normalizeRange(part.location.range) }
          : undefined,
        command: normalizeCommand(part.command)
      };
    })),
    kind: hint.kind === undefined ? undefined : vscode.InlayHintKind[hint.kind],
    line: hint.position.line + 1,
    column: hint.position.character + 1,
    tooltip: takeText(typeof hint.tooltip === "string" ? hint.tooltip : hint.tooltip?.value, 2_048),
    textEdits: hint.textEdits?.slice(0, 5).map(edit => ({
      ...normalizeRange(edit.range),
      newText: takeText(edit.newText, 2_048)
    })),
    textEditsTruncated: (hint.textEdits?.length ?? 0) > 5,
    paddingLeft: hint.paddingLeft,
    paddingRight: hint.paddingRight
  };
}

function normalizeBoundedTextEdit(edit: vscode.TextEdit, maximumTextLength: number): object {
  return { ...normalizeRange(edit.range), newText: boundedText(edit.newText, maximumTextLength) };
}

function createTextBudget(maximumCharacters: number): (value: string | undefined, itemMaximum: number) => string | undefined {
  let remaining = maximumCharacters;
  return (value, itemMaximum) => {
    const text = boundedText(value, Math.min(itemMaximum, remaining));
    remaining -= text?.length ?? 0;
    return text;
  };
}
