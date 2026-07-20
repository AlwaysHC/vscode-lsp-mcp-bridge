import * as crypto from "node:crypto";

export const bridgeAuthHeaders = {
  timestamp: "x-vscode-lsp-bridge-timestamp",
  nonce: "x-vscode-lsp-bridge-nonce",
  bodyHash: "x-vscode-lsp-bridge-content-sha256",
  signature: "x-vscode-lsp-bridge-signature",
  responseProof: "x-vscode-lsp-bridge-response-proof"
} as const;

export interface BridgeRequestSignatureInput {
  method: string;
  path: string;
  body?: string;
  sessionId?: string;
  protocolVersion?: string;
  lastEventId?: string;
  timestamp?: number;
  nonce?: string;
}

export interface SignedBridgeRequest {
  headers: Record<string, string>;
  nonce: string;
}

export interface VerifiedBridgeRequest {
  bodyHash: string;
  nonce: string;
  timestamp: number;
}

const hexSecretPattern = /^[0-9a-f]{64}$/u;

export function hashBridgeBody(body = ""): string {
  return crypto.createHash("sha256").update(body, "utf8").digest("hex");
}

export function deriveWorkerProxyKey(registrationToken: string, workspaceId: string): string {
  return hmac(registrationToken, JSON.stringify(["v1", "worker-proxy", workspaceId]));
}

export function signBridgeRequest(key: string, input: BridgeRequestSignatureInput): SignedBridgeRequest {
  const timestamp = input.timestamp ?? Date.now();
  const nonce = input.nonce ?? crypto.randomBytes(32).toString("hex");
  const bodyHash = hashBridgeBody(input.body);
  const signature = hmac(key, canonicalRequest(input, timestamp, nonce, bodyHash));

  return {
    nonce,
    headers: {
      [bridgeAuthHeaders.timestamp]: String(timestamp),
      [bridgeAuthHeaders.nonce]: nonce,
      [bridgeAuthHeaders.bodyHash]: bodyHash,
      [bridgeAuthHeaders.signature]: signature
    }
  };
}

export function verifyBridgeRequest(
  key: string,
  input: Omit<BridgeRequestSignatureInput, "body" | "timestamp" | "nonce">,
  headers: Record<string, string | string[] | undefined>,
  now = Date.now(),
  maximumClockSkewMs = 30_000
): VerifiedBridgeRequest | undefined {
  const timestampText = firstHeader(headers[bridgeAuthHeaders.timestamp]);
  const nonce = firstHeader(headers[bridgeAuthHeaders.nonce]);
  const bodyHash = firstHeader(headers[bridgeAuthHeaders.bodyHash]);
  const signature = firstHeader(headers[bridgeAuthHeaders.signature]);
  if (!timestampText || !/^\d{10,13}$/u.test(timestampText) ||
    !nonce || !hexSecretPattern.test(nonce) ||
    !bodyHash || !hexSecretPattern.test(bodyHash) ||
    !signature || !hexSecretPattern.test(signature)) {
    return undefined;
  }

  const timestamp = Number(timestampText);
  if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > maximumClockSkewMs) {
    return undefined;
  }

  const expected = hmac(key, canonicalRequest(input, timestamp, nonce, bodyHash));
  return timingSafeHexEqual(signature, expected) ? { bodyHash, nonce, timestamp } : undefined;
}

export function createBridgeResponseProof(key: string, requestNonce: string, statusCode: number): string {
  return hmac(key, JSON.stringify(["v1", "response", requestNonce, statusCode]));
}

export function verifyBridgeResponseProof(
  key: string,
  requestNonce: string,
  statusCode: number,
  proof: string | undefined
): boolean {
  return proof !== undefined && hexSecretPattern.test(proof) &&
    timingSafeHexEqual(proof, createBridgeResponseProof(key, requestNonce, statusCode));
}

function canonicalRequest(
  input: Omit<BridgeRequestSignatureInput, "body">,
  timestamp: number,
  nonce: string,
  bodyHash: string
): string {
  return JSON.stringify([
    "v1",
    "request",
    input.method.toUpperCase(),
    input.path,
    String(timestamp),
    nonce,
    bodyHash,
    input.sessionId ?? "",
    input.protocolVersion ?? "",
    input.lastEventId ?? ""
  ]);
}

function hmac(key: string, value: string): string {
  if (!hexSecretPattern.test(key)) {
    throw new Error("Bridge authentication keys must be 32-byte hexadecimal secrets.");
  }
  return crypto.createHmac("sha256", Buffer.from(key, "hex")).update(value, "utf8").digest("hex");
}

function timingSafeHexEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
