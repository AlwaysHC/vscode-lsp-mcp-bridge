import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  boundedInteger,
  normalizeComparableCode,
  traverseBoundedGraph
} from "../src/languageToolCore.ts";
import {
  toolDefinitions,
  validateLanguageToolArgs
} from "../src/mcp/toolDefinitions.ts";
import {
  languageMcpServerInstructions,
  toolSelectionInstructions
} from "../src/mcp/serverInstructions.ts";
import {
  bridgeAuthHeaders,
  createBridgeResponseProof,
  deriveWorkerProxyKey,
  hashBridgeBody,
  signBridgeRequest,
  verifyBridgeRequest,
  verifyBridgeResponseProof
} from "../src/shared/bridgeAuth.ts";

const bridgeKey = "11".repeat(32);
const bridgeTimestamp = 1_750_000_000_000;
const bridgeNonce = "22".repeat(32);

test("MCP instructions make proactive tool selection explicit in Codex's decision prefix", () => {
  assert.ok(toolSelectionInstructions.length <= 512);
  assert.ok(toolSelectionInstructions.includes("Proactively use"));
  assert.ok(toolSelectionInstructions.includes("user need not mention LSP"));
  assert.ok(toolSelectionInstructions.includes("semantic_navigation_guide"));
  assert.ok(toolSelectionInstructions.includes("text search only after provider failure"));
  assert.ok(languageMcpServerInstructions.startsWith(toolSelectionInstructions));
});

test("bounded graph traversal deduplicates cycles and respects depth", async () => {
  const graph = new Map([
    ["a", ["b", "c"]],
    ["b", ["a", "d"]],
    ["c", ["d"]],
    ["d", []]
  ]);
  const result = await traverseBoundedGraph(
    ["a"],
    value => value,
    async value => graph.get(value) ?? [],
    { maxDepth: 2, maxNodes: 10 }
  );

  assert.deepEqual(result.nodes.map(({ value, depth }) => [value, depth]), [
    ["a", 0],
    ["b", 1],
    ["c", 1],
    ["d", 2]
  ]);
  assert.equal(result.truncated, false);
  assert.equal(result.depthLimited, true);
});

test("bounded graph traversal never exceeds its node budget", async () => {
  const result = await traverseBoundedGraph(
    [0],
    String,
    async value => [value + 1, value + 2],
    { maxDepth: 10, maxNodes: 3 }
  );

  assert.equal(result.nodes.length, 3);
  assert.equal(result.truncated, true);
});

test("bounded integer and diagnostic-code normalization reject unsafe input", () => {
  assert.equal(boundedInteger(undefined, "limit", { defaultValue: 5, maximum: 10 }), 5);
  assert.throws(
    () => boundedInteger(11, "limit", { defaultValue: 5, maximum: 10 }),
    /integer from 1 through 10/u
  );
  assert.equal(normalizeComparableCode("CS1001"), "cs1001");
  assert.equal(normalizeComparableCode(404), "404");
});

test("every registered language tool has exactly one dispatcher case", async () => {
  const [definitionsSource, dispatcherSource] = await Promise.all([
    readFile("src/mcp/toolDefinitions.ts", "utf8"),
    readFile("src/languageTools.ts", "utf8")
  ]);
  const definitions = [...definitionsSource.matchAll(/\bname: "([^"]+)"/gu)].map(match => match[1]).sort();
  const cases = [...dispatcherSource.matchAll(/\bcase "([^"]+)"/gu)].map(match => match[1]).sort();

  assert.equal(new Set(definitions).size, definitions.length);
  assert.deepEqual(cases, definitions);
});

test("direct tool validation enforces the published bounded schema", () => {
  assert.deepEqual(validateLanguageToolArgs("semantic_navigation_guide", {}), {});
  assert.throws(
    () => validateLanguageToolArgs("workspace_symbols", { query: "x".repeat(1_001) }),
    /Too big|too_big|1000/u
  );
  assert.throws(
    () => validateLanguageToolArgs("hover", { file: "x.ts", line: 1, column: 1, unexpected: true }),
    /Unrecognized key|unrecognized_keys/u
  );
});

test("signed bridge requests bind every routed field and the body hash", () => {
  const input = {
    method: "POST",
    path: "/internal/mcp",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    sessionId: "session-a",
    protocolVersion: "2025-06-18",
    lastEventId: "event-a",
    timestamp: bridgeTimestamp,
    nonce: bridgeNonce
  } as const;
  const signed = signBridgeRequest(bridgeKey, input);
  const verificationInput = {
    method: input.method,
    path: input.path,
    sessionId: input.sessionId,
    protocolVersion: input.protocolVersion,
    lastEventId: input.lastEventId
  };

  assert.deepEqual(
    verifyBridgeRequest(bridgeKey, verificationInput, signed.headers, bridgeTimestamp),
    {
      bodyHash: hashBridgeBody(input.body),
      nonce: bridgeNonce,
      timestamp: bridgeTimestamp
    }
  );

  for (const tampered of [
    { ...verificationInput, method: "DELETE" },
    { ...verificationInput, path: "/internal/register" },
    { ...verificationInput, sessionId: "session-b" },
    { ...verificationInput, protocolVersion: "2024-11-05" },
    { ...verificationInput, lastEventId: "event-b" }
  ]) {
    assert.equal(verifyBridgeRequest(bridgeKey, tampered, signed.headers, bridgeTimestamp), undefined);
  }

  assert.equal(
    verifyBridgeRequest("33".repeat(32), verificationInput, signed.headers, bridgeTimestamp),
    undefined
  );
  assert.equal(
    verifyBridgeRequest(bridgeKey, verificationInput, {
      ...signed.headers,
      [bridgeAuthHeaders.bodyHash]: hashBridgeBody("tampered")
    }, bridgeTimestamp),
    undefined
  );
});

test("bridge request verification rejects stale and malformed authentication metadata", () => {
  const input = {
    method: "GET",
    path: "/internal/health",
    timestamp: bridgeTimestamp,
    nonce: bridgeNonce
  } as const;
  const signed = signBridgeRequest(bridgeKey, input);
  const verificationInput = { method: input.method, path: input.path };

  assert.equal(
    verifyBridgeRequest(bridgeKey, verificationInput, signed.headers, bridgeTimestamp + 30_001),
    undefined
  );
  for (const [header, value] of [
    [bridgeAuthHeaders.timestamp, "not-a-time"],
    [bridgeAuthHeaders.nonce, "short"],
    [bridgeAuthHeaders.bodyHash, "not-hex"],
    [bridgeAuthHeaders.signature, "00"]
  ] as const) {
    assert.equal(verifyBridgeRequest(bridgeKey, verificationInput, {
      ...signed.headers,
      [header]: value
    }, bridgeTimestamp), undefined);
  }
});

test("bridge response proofs bind the request nonce and HTTP status", () => {
  const proof = createBridgeResponseProof(bridgeKey, bridgeNonce, 204);

  assert.equal(verifyBridgeResponseProof(bridgeKey, bridgeNonce, 204, proof), true);
  assert.equal(verifyBridgeResponseProof(bridgeKey, bridgeNonce, 200, proof), false);
  assert.equal(verifyBridgeResponseProof(bridgeKey, "44".repeat(32), 204, proof), false);
  assert.equal(verifyBridgeResponseProof("55".repeat(32), bridgeNonce, 204, proof), false);
  assert.equal(verifyBridgeResponseProof(bridgeKey, bridgeNonce, 204, "not-hex"), false);
  assert.equal(verifyBridgeResponseProof(bridgeKey, bridgeNonce, 204, undefined), false);
});

test("worker proxy keys are isolated by workspace identity", () => {
  const first = deriveWorkerProxyKey(bridgeKey, "workspace-a");
  const second = deriveWorkerProxyKey(bridgeKey, "workspace-b");

  assert.notEqual(first, second);
  assert.equal(first, deriveWorkerProxyKey(bridgeKey, "workspace-a"));
  assert.equal(verifyBridgeResponseProof(second, bridgeNonce, 200,
    createBridgeResponseProof(first, bridgeNonce, 200)), false);
});

test("tool safety annotations classify every potentially mutating entry point", () => {
  const mutatingTools = toolDefinitions
    .filter(definition => !definition.readOnly)
    .map(definition => definition.name)
    .sort();
  const openWorldTools = toolDefinitions
    .filter(definition => definition.openWorld === true)
    .map(definition => definition.name)
    .sort();

  assert.deepEqual(mutatingTools, [
    "apply_code_action",
    "apply_completion",
    "fix_all",
    "format_document",
    "format_on_type",
    "format_range",
    "organize_imports"
  ]);
  assert.deepEqual(openWorldTools, [
    "apply_code_action",
    "fix_all",
    "organize_imports",
    "read_virtual_document"
  ]);
  assert.equal(toolDefinitions.find(definition => definition.name === "rename_symbol")?.readOnly, true);
  assert.equal(toolDefinitions.find(definition => definition.name === "preview_rename")?.readOnly, true);
});
