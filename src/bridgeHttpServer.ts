import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as vscode from "vscode";
import { brand, brandAttribution } from "./branding.js";
import { getBridgeConfiguration, getWriteToolsEnabled } from "./configuration.js";
import { runLanguageTool } from "./languageTools.js";
import { createLanguageMcpServer } from "./mcp/createLanguageMcpServer.js";
import { validateLanguageToolArgs } from "./mcp/toolDefinitions.js";
import { showStatusNotification } from "./notifications.js";
import {
  bridgeAuthHeaders,
  createBridgeResponseProof,
  deriveWorkerProxyKey,
  hashBridgeBody,
  signBridgeRequest,
  verifyBridgeRequest,
  verifyBridgeResponseProof
} from "./shared/bridgeAuth.js";
import { defaultConnectionFilePath } from "./shared/paths.js";
import {
  BRIDGE_VERSION,
  BridgeConnectionInfo,
  BridgeToolRequest,
  BridgeToolResponse,
  DEFAULT_HOST,
  DEFAULT_PORT,
  LEGACY_BRIDGE_VERSION
} from "./shared/protocol.js";

type BridgeServerRole = "gateway" | "worker";

interface WorkspaceRegistration {
  id: string;
  name: string;
  host: string;
  port: number;
  workspaceFolders: string[];
  workspaceFolderUris: string[];
  startedAt: string;
  activate?: boolean;
}

interface RegisteredWorkspace extends WorkspaceRegistration {
  isLocal: boolean;
  lastSeenAt: string;
  proxyKey: string;
}

interface GatewayEndpoint {
  host: string;
  port: number;
  registrationToken: string;
}

interface McpSessionRoute {
  workspaceId: string;
  lastSeenAt: number;
}

export interface BridgeStatusBarInfo {
  connected: boolean;
  activeWorkspace: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface McpToolCallParams {
  name?: unknown;
  arguments?: unknown;
}

const registrationRefreshMs = 30_000;
const registrationStaleMs = 90_000;
const maxRegistrationFailures = 3;
const gatewayConnectionWaitMs = 3_000;
const recoveryRetryMs = 10_000;
const mcpSessionIdleMs = 30 * 60_000;
const maxMcpSessions = 64;
const maxMcpSessionRoutes = 256;
const maxRequestBodyBytes = 1_048_576;
const maxBufferedResponseBytes = 16_777_216;
const maxRegisteredWorkspaces = 32;
const maxWorkspaceFolders = 100;
const signedRequestReplayWindowMs = 60_000;
const maxSignedRequestNonces = 4_096;
const internalBridgeHeaderNames = new Set<string>(Object.values(bridgeAuthHeaders));
const symbolRouteMaxEntriesPerFolder = 50_000;
const symbolRouteTimeoutMs = 3_000;
const ignoredRouteDirectories = new Set([
  ".git",
  ".vs",
  "bin",
  "build",
  "dist",
  "node_modules",
  "obj",
  "out",
  "packages"
]);

class PayloadTooLargeError extends Error {}
class InvalidBridgeRequestError extends Error {}

export class BridgeHttpServer {
  private server: http.Server | undefined;
  private connectionInfo: BridgeConnectionInfo | undefined;
  private connectionFile: string | undefined;
  private role: BridgeServerRole | undefined;
  private workspaceId: string | undefined;
  private actualPort: number | undefined;
  private gatewayEndpoint: GatewayEndpoint | undefined;
  private activeWorkspaceId: string | undefined;
  private registrationTimer: ReturnType<typeof setInterval> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private registrationFailureCount = 0;
  private recoveryGatewayPort: number | undefined;
  private isPromoting = false;
  private pendingMcpSessions = 0;
  private pendingGatewayMcpInitializations = 0;
  private startPromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private promotionPromise: Promise<void> | undefined;
  private desiredRunning = false;
  private lifecycleGeneration = 0;
  private registeredWorkspaces = new Map<string, RegisteredWorkspace>();
  private mcpSessionRoutes = new Map<string, McpSessionRoute>();
  private signedBodyHashes = new WeakMap<http.IncomingMessage, string>();
  private signedRequestNonces = new Map<string, number>();
  private mcpSessions = new Map<
    string,
    {
      transport: StreamableHTTPServerTransport;
      server: McpServer;
      lastSeenAt: number;
    }
  >();

  constructor(private readonly context: vscode.ExtensionContext) {}

  get isRunning(): boolean {
    return this.server !== undefined && this.connectionInfo !== undefined;
  }

  getStatusBarInfo(): BridgeStatusBarInfo {
    const activeWorkspace = this.role === "gateway"
      ? this.activeWorkspace()?.name ?? this.workspaceDisplayName()
      : this.workspaceDisplayName();

    return {
      connected: this.isRunning,
      activeWorkspace
    };
  }

  get status(): string {
    const version = this.extensionVersion();
    const writeToolsEnabled = getWriteToolsEnabled();
    const writeToolsLine = brand(`Write tools: ${writeToolsEnabled ? "enabled" : "disabled"}`);

    if (!this.connectionInfo || !this.connectionFile) {
      return [brand("VS Code LSP MCP Bridge is stopped."), brandAttribution, brand(`Version: ${version}`), writeToolsLine].join("\n");
    }

    const gatewayConnection = this.gatewayConnectionValues();
    const currentWindowConnection = this.currentWindowConnectionValues();
    const endpointLines =
      currentWindowConnection.host === gatewayConnection.host && currentWindowConnection.port === gatewayConnection.port
        ? [brand(`MCP endpoint: http://${gatewayConnection.host}:${gatewayConnection.port}/mcp`)]
        : [
            brand(`Current-window MCP endpoint: http://${currentWindowConnection.host}:${currentWindowConnection.port}/mcp`),
            brand(`External-client gateway endpoint: http://${gatewayConnection.host}:${gatewayConnection.port}/mcp`)
          ];

    const lines = [
      brand(`VS Code LSP MCP Bridge is running as ${this.role ?? "server"}.`),
      brandAttribution,
      brand(`Version: ${version}`),
      writeToolsLine,
      ...endpointLines,
      brand(`Connection file: ${this.connectionFile}`),
      brand(`Workspace folders: ${this.connectionInfo.workspaceFolders.length}`)
    ];

    if (this.role === "gateway") {
      this.expireStaleWorkspaces();
      const activeWorkspace = this.activeWorkspaceId
        ? this.registeredWorkspaces.get(this.activeWorkspaceId)
        : undefined;
      lines.push(brand(`Active workspace: ${activeWorkspace?.name ?? "none"}`));
      lines.push(brand(`Registered workspaces: ${this.registeredWorkspaces.size}`));
    }

    return lines.join("\n");
  }

  private extensionVersion(): string {
    const version = this.context.extension.packageJSON.version;
    return typeof version === "string" && version.trim() ? version : "unknown";
  }

  async start(): Promise<void> {
    this.desiredRunning = true;
    await this.stopPromise?.catch(() => undefined);
    if (!this.desiredRunning) {
      return;
    }
    await this.startForGeneration(this.lifecycleGeneration);
  }

  private async startForGeneration(generation: number): Promise<void> {
    if (!this.desiredRunning || generation !== this.lifecycleGeneration) {
      return;
    }
    if (this.isRunning) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    const operation = this.startCore();
    this.startPromise = operation;
    try {
      await operation;
    } finally {
      if (this.startPromise === operation) {
        this.startPromise = undefined;
      }
    }
  }

  private async startCore(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    if (!vscode.workspace.isTrusted) {
      throw new Error("The bridge refuses to start in an untrusted workspace.");
    }

    const config = getBridgeConfiguration();
    const host = config.get<string>("host", DEFAULT_HOST);
    this.ensureLoopbackHost(host);
    const requestedPort = this.recoveryGatewayPort ?? config.get<number>("port", DEFAULT_PORT);
    if (!Number.isInteger(requestedPort) || requestedPort < 1_024 || requestedPort > 65_535) {
      throw new Error("Bridge port must be an integer from 1024 through 65535.");
    }
    const configuredConnectionFile = config.get<string>("connectionFile", "").trim();
    this.connectionFile = path.resolve(configuredConnectionFile || defaultConnectionFilePath());
    const savedConnection = await this.readConnectionFile(true);
    const publishedConnection = savedConnection?.version === BRIDGE_VERSION ? savedConnection : undefined;
    const token = savedConnection?.token ?? await this.getOrCreateToken();
    const registrationToken = savedConnection?.registrationToken ?? await this.getOrCreateRegistrationToken();
    this.workspaceId = this.createWorkspaceId();
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server.requestTimeout = 30_000;
    this.server.headersTimeout = 15_000;
    this.server.maxHeadersCount = 100;

    try {
      if (publishedConnection && await this.tryUsePublishedGateway(publishedConnection)) {
        await this.startWorkerBehindGateway(publishedConnection.host, publishedConnection.port, publishedConnection);
        return;
      }

      await this.listen(requestedPort, host);
      const port = this.listeningPort();
      this.role = "gateway";
      this.actualPort = port;
      this.connectionInfo = {
        version: BRIDGE_VERSION,
        host,
        port,
        token,
        registrationToken,
        ...this.currentWorkspaceFolderValues(),
        createdAt: new Date().toISOString()
      };

      await this.storeGatewayCredentials(token, registrationToken);
      this.registerLocalWorkspace(host, port, registrationToken);
      await this.writeConnectionFile();
      this.registrationFailureCount = 0;
      this.recoveryGatewayPort = undefined;
      this.clearRecoveryTimer();
    } catch (error) {
      if (!this.isAddressInUseError(error)) {
        await this.resetAfterFailedStart();
        throw error;
      }

      await this.startWorkerBehindGateway(host, requestedPort);
    }
  }

  async stop(): Promise<void> {
    this.desiredRunning = false;
    this.lifecycleGeneration += 1;
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }

    const operation = this.stopCore();
    this.stopPromise = operation;
    try {
      await operation;
    } finally {
      if (this.stopPromise === operation) {
        this.stopPromise = undefined;
      }
    }
  }

  private async stopCore(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    await this.promotionPromise?.catch(() => undefined);
    this.stopRegistrationHeartbeat();
    this.clearRecoveryTimer();
    this.registrationFailureCount = 0;
    this.recoveryGatewayPort = undefined;

    if (this.role === "worker") {
      await this.unregisterFromGateway().catch(() => undefined);
    }

    const server = this.server;
    this.server = undefined;
    this.connectionInfo = undefined;
    this.connectionFile = undefined;
    this.role = undefined;
    this.workspaceId = undefined;
    this.actualPort = undefined;
    this.gatewayEndpoint = undefined;
    this.activeWorkspaceId = undefined;
    this.registeredWorkspaces.clear();
    this.mcpSessionRoutes.clear();
    this.signedRequestNonces.clear();
    this.signedBodyHashes = new WeakMap<http.IncomingMessage, string>();

    await this.closeMcpSessions();

    if (server) {
      await this.closeHttpServer(server);
    }
  }

  async restart(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    await this.stop();
    await this.start();
  }

  async refreshWorkspaceContext(): Promise<void> {
    if (!this.connectionInfo) {
      return;
    }
    Object.assign(this.connectionInfo, this.currentWorkspaceFolderValues());
    if (this.role === "gateway") {
      this.registerLocalWorkspace(
        this.connectionInfo.host,
        this.actualPort ?? this.connectionInfo.port,
        this.connectionInfo.registrationToken,
        false
      );
      await this.writeConnectionFile();
    } else if (this.role === "worker") {
      await this.refreshGatewayRegistration(false);
    }
  }

  getClientConfigSnippet(clientId: string): string {
    switch (clientId) {
      case "codex":
        return this.getCodexConfigSnippet();
      case "vscode-copilot":
        return this.getVsCodeCopilotConfigSnippet();
      case "claude-code":
        return this.getClaudeCodeConfigSnippet();
      case "generic":
        return this.getGenericHttpMcpConfigSnippet();
      default:
        throw new Error(`Unknown MCP client config: ${clientId}`);
    }
  }

  getVsCodeMcpServerDefinition(): vscode.McpHttpServerDefinition {
    const { host, port, token } = this.currentWindowConnectionValues();

    return new vscode.McpHttpServerDefinition(
      brand("VS Code LSP MCP Bridge"),
      vscode.Uri.parse(`http://${host}:${port}/mcp`),
      {
        Authorization: `Bearer ${token}`
      },
      this.extensionVersion()
    );
  }

  private getCodexConfigSnippet(): string {
    const { host, port, token } = this.gatewayConnectionValues();

    return [
      "[mcp_servers.vscode_lsp]",
      `url = "http://${host}:${port}/mcp"`,
      `http_headers = { Authorization = "Bearer ${token}" }`
    ].join("\n");
  }

  private getVsCodeCopilotConfigSnippet(): string {
    const { host, port, token } = this.gatewayConnectionValues();

    return JSON.stringify(
      {
        servers: {
          vscode_lsp: {
            type: "http",
            url: `http://${host}:${port}/mcp`,
            requestInit: {
              headers: {
                Authorization: `Bearer ${token}`
              }
            }
          }
        }
      },
      null,
      2
    );
  }

  private getClaudeCodeConfigSnippet(): string {
    const { host, port, token } = this.gatewayConnectionValues();

    return `claude mcp add --transport http vscode_lsp http://${host}:${port}/mcp --header "Authorization: Bearer ${token}"`;
  }

  private getGenericHttpMcpConfigSnippet(): string {
    const { host, port, token } = this.gatewayConnectionValues();

    return JSON.stringify(
      {
        mcpServers: {
          vscode_lsp: {
            type: "http",
            url: `http://${host}:${port}/mcp`,
            headers: {
              Authorization: `Bearer ${token}`
            }
          }
        }
      },
      null,
      2
    );
  }

  private gatewayConnectionValues(): { host: string; port: number; token: string } {
    const config = getBridgeConfiguration();
    const host = this.connectionInfo?.host ?? config.get<string>("host", DEFAULT_HOST);
    const port = this.connectionInfo?.port ?? config.get<number>("port", DEFAULT_PORT);
    const token = this.connectionInfo?.token ?? "<start-the-bridge-first>";

    return { host, port, token };
  }

  private currentWindowConnectionValues(): { host: string; port: number; token: string } {
    const gatewayConnection = this.gatewayConnectionValues();
    return {
      ...gatewayConnection,
      port: this.actualPort ?? gatewayConnection.port
    };
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    try {
      if (request.method === "GET" && request.url === "/health") {
        const authorized = this.hasBearerToken(request, this.connectionInfo?.token);
        this.writeJson(response, 200, {
          ok: true,
          running: this.isRunning,
          version: BRIDGE_VERSION,
          mcp: "/mcp",
          role: authorized ? this.role : undefined,
          activeWorkspace: authorized ? this.activeWorkspaceSummary() : undefined,
          workspaceCount: authorized && this.role === "gateway" ? this.registeredWorkspaces.size : undefined
        });
        return;
      }

      if (!this.desiredRunning || this.stopPromise) {
        this.writeJson(response, 503, { ok: false, error: "The bridge is stopping." });
        return;
      }

      const requestPath = request.url?.split("?", 1)[0];

      if (request.method === "POST" && requestPath === "/gateway/challenge") {
        await this.handleGatewayChallenge(request, response);
        return;
      }

      if (requestPath?.startsWith("/gateway/")) {
        if (!this.isGatewayAuthorized(request, response)) {
          this.writeJson(response, 401, { ok: false, error: "Unauthorized" });
          return;
        }

        await this.handleGatewayRequest(requestPath, request, response);
        return;
      }

      if (requestPath === "/mcp") {
        if (!this.isAuthorized(request, response)) {
          this.writeMcpError(response, 401, -32001, "Unauthorized");
          return;
        }

        await this.handleGatewayMcpRequest(request, response);
        return;
      }

      if (request.method !== "POST" || requestPath !== "/tool") {
        this.writeJson(response, 404, { ok: false, error: "Not found" });
        return;
      }

      if (!this.isAuthorized(request, response)) {
        this.writeJson(response, 401, { ok: false, error: "Unauthorized" });
        return;
      }

      const body = this.validateBridgeToolRequest(await this.readJson<unknown>(request));
      const hintedWorkspace = await this.workspaceForToolRequest(body);
      const backend = hintedWorkspace
        ? hintedWorkspace.isLocal ? undefined : hintedWorkspace
        : this.activeRemoteWorkspace();
      if (backend) {
        await this.proxyRequestToWorkspace(request, response, backend, body, { mcp: false });
        return;
      }

      const allowWrites = getWriteToolsEnabled();

      const result = await runLanguageTool(body.name, body.args ?? {}, { allowWrites });
      this.writeJson(response, 200, { ok: true, result } satisfies BridgeToolResponse);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }

      const statusCode = error instanceof PayloadTooLargeError
        ? 413
        : error instanceof InvalidBridgeRequestError ? 400 : 500;
      this.writeJson(response, statusCode, {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      } satisfies BridgeToolResponse);
    }
  }

  private async handleGatewayMcpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    const method = request.method?.toUpperCase();
    const sessionId = this.getHeader(request, "mcp-session-id");

    if (this.role === "gateway" && sessionId) {
      this.expireIdleMcpSessionRoutes();
      const route = this.mcpSessionRoutes.get(sessionId);
      if (route) {
        route.lastSeenAt = Date.now();
        const backendId = route.workspaceId;
        if (backendId === this.workspaceId) {
          const localSession = this.mcpSessions.get(sessionId);
          if (localSession) {
            localSession.lastSeenAt = route.lastSeenAt;
          }
        }
        const body = method === "POST" ? await this.readJson<unknown>(request) : undefined;
        const targetWorkspace = body !== undefined ? await this.workspaceForMcpToolCall(body, true) : undefined;
        if (body !== undefined && targetWorkspace && targetWorkspace.id !== backendId) {
          if (await this.tryHandleMcpToolCallInWorkspace(response, body, targetWorkspace)) {
            return;
          }
        }

        const backend = this.registeredWorkspaces.get(backendId);
        if (!backend) {
          this.mcpSessionRoutes.delete(sessionId);
          this.writeMcpError(response, 404, -32000, "MCP workspace session is no longer available.");
          return;
        }

        if (backend.isLocal) {
          await this.handleMcpRequest(request, response, body);
          if (method === "DELETE") {
            this.mcpSessionRoutes.delete(sessionId);
          }
          return;
        }

        await this.proxyRequestToWorkspace(request, response, backend, body, { mcp: true });
        if (method === "DELETE") {
          this.mcpSessionRoutes.delete(sessionId);
        }
        return;
      }

      this.writeMcpError(response, 404, -32000, "Unknown or expired MCP session.");
      return;
    }

    if (this.role === "gateway" && method === "POST" && !sessionId) {
      const body = await this.readJson<unknown>(request);
      if (isInitializeRequest(body)) {
        this.expireIdleMcpSessionRoutes();
        if (this.mcpSessionRoutes.size + this.pendingGatewayMcpInitializations >= maxMcpSessionRoutes) {
          this.writeMcpError(response, 429, -32000, "Too many active gateway MCP sessions.");
          return;
        }
        this.pendingGatewayMcpInitializations += 1;
        try {
          const backend = this.activeRemoteWorkspace();
          if (backend) {
            await this.proxyRequestToWorkspace(request, response, backend, body, { mcp: true });
            return;
          }

          await this.handleMcpRequest(request, response, body);
          return;
        } finally {
          this.pendingGatewayMcpInitializations -= 1;
        }
      }

      await this.handleMcpRequest(request, response, body);
      return;
    }

    await this.handleMcpRequest(request, response);
  }

  private async handleMcpRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    preReadBody?: unknown
  ): Promise<void> {
    const method = request.method?.toUpperCase();
    const sessionId = this.getHeader(request, "mcp-session-id");
    await this.expireIdleMcpSessions();

    if (method === "POST") {
      const body = preReadBody ?? (await this.readJson<unknown>(request));

      if (sessionId) {
        const session = this.mcpSessions.get(sessionId);
        if (!session) {
          this.writeMcpError(response, 404, -32000, "Unknown MCP session.");
          return;
        }

        session.lastSeenAt = Date.now();

        const targetWorkspace = await this.workspaceForMcpToolCall(body, true);
        if (targetWorkspace && targetWorkspace.id !== this.workspaceId && (await this.tryHandleMcpToolCallInWorkspace(response, body, targetWorkspace))) {
          return;
        }

        await session.transport.handleRequest(request, response, body);
        return;
      }

      if (!isInitializeRequest(body)) {
        this.writeMcpError(response, 400, -32000, "Missing MCP session. Send initialize first.");
        return;
      }

      if (this.mcpSessions.size + this.pendingMcpSessions >= maxMcpSessions) {
        this.writeMcpError(response, 429, -32000, "Too many active MCP sessions.");
        return;
      }

      this.pendingMcpSessions += 1;
      let initializedSessionId: string | undefined;
      const sessionGeneration = this.lifecycleGeneration;
      const mcpServer = createLanguageMcpServer(() => this.allowWrites, this.extensionVersion());
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: newSessionId => {
          if (!this.desiredRunning || sessionGeneration !== this.lifecycleGeneration) {
            throw new Error("The bridge stopped while the MCP session was initializing.");
          }
          if (this.role === "gateway" && this.workspaceId) {
            if (!this.setMcpSessionRoute(newSessionId, this.workspaceId)) {
              throw new Error("The gateway MCP session limit was reached during initialization.");
            }
          }
          initializedSessionId = newSessionId;
          this.mcpSessions.set(newSessionId, { transport, server: mcpServer, lastSeenAt: Date.now() });
        }
      });

      transport.onclose = () => {
        const closedSessionId = transport.sessionId ?? initializedSessionId;
        if (closedSessionId) {
          this.mcpSessions.delete(closedSessionId);
          this.mcpSessionRoutes.delete(closedSessionId);
        }
      };

      try {
        await mcpServer.connect(transport);
        await transport.handleRequest(request, response, body);
      } finally {
        this.pendingMcpSessions -= 1;
        if (!initializedSessionId) {
          await mcpServer.close().catch(() => undefined);
        }
      }
      return;
    }

    if (method === "GET" || method === "DELETE") {
      if (!sessionId) {
        this.writeMcpError(response, 400, -32000, "Missing MCP session ID.");
        return;
      }

      const session = this.mcpSessions.get(sessionId);
      if (!session) {
        this.writeMcpError(response, 404, -32000, "Unknown MCP session.");
        return;
      }

      session.lastSeenAt = Date.now();

      await session.transport.handleRequest(request, response);
      return;
    }

    this.writeMcpError(response, 405, -32000, "Method not allowed.");
  }

  private isAuthorized(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    if (this.hasBearerToken(request, this.connectionInfo?.token)) {
      return true;
    }

    const key = this.role === "worker" && this.connectionInfo?.registrationToken && this.workspaceId
      ? deriveWorkerProxyKey(this.connectionInfo.registrationToken, this.workspaceId)
      : undefined;
    return key ? this.acceptSignedRequest(request, response, key, `worker:${this.workspaceId}`) : false;
  }

  private isGatewayAuthorized(request: http.IncomingMessage, response: http.ServerResponse): boolean {
    const key = this.role === "gateway" ? this.connectionInfo?.registrationToken : undefined;
    return key ? this.acceptSignedRequest(request, response, key, "gateway") : false;
  }

  private acceptSignedRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    key: string,
    scope: string
  ): boolean {
    const now = Date.now();
    const verification = verifyBridgeRequest(key, {
      method: request.method ?? "GET",
      path: request.url ?? "/",
      sessionId: this.getHeader(request, "mcp-session-id"),
      protocolVersion: this.getHeader(request, "mcp-protocol-version"),
      lastEventId: this.getHeader(request, "last-event-id")
    }, request.headers, now);
    if (!verification ||
      ((request.method === "GET" || request.method === "DELETE") && verification.bodyHash !== hashBridgeBody())) {
      return false;
    }

    this.expireSignedRequestNonces(now);
    const scopedNonce = `${scope}:${verification.nonce}`;
    if (this.signedRequestNonces.has(scopedNonce) || this.signedRequestNonces.size >= maxSignedRequestNonces) {
      return false;
    }

    this.signedRequestNonces.set(scopedNonce, now + signedRequestReplayWindowMs);
    this.signedBodyHashes.set(request, verification.bodyHash);
    this.installAuthenticatedResponseProof(response, key, verification.nonce);
    return true;
  }

  private installAuthenticatedResponseProof(
    response: http.ServerResponse,
    key: string,
    requestNonce: string
  ): void {
    let installed = false;
    const install = (statusCode: number) => {
      if (!installed && !response.headersSent) {
        response.setHeader(
          bridgeAuthHeaders.responseProof,
          createBridgeResponseProof(key, requestNonce, statusCode)
        );
        installed = true;
      }
    };

    const originalWriteHead = response.writeHead.bind(response);
    response.writeHead = ((statusCode: number, ...args: unknown[]) => {
      install(statusCode);
      return Reflect.apply(originalWriteHead, response, [statusCode, ...args]) as http.ServerResponse;
    }) as typeof response.writeHead;

    const originalWrite = response.write.bind(response);
    response.write = ((chunk: unknown, ...args: unknown[]) => {
      install(response.statusCode);
      return Reflect.apply(originalWrite, response, [chunk, ...args]) as boolean;
    }) as typeof response.write;

    const originalEnd = response.end.bind(response);
    response.end = ((...args: unknown[]) => {
      install(response.statusCode);
      return Reflect.apply(originalEnd, response, args) as http.ServerResponse;
    }) as typeof response.end;

    const originalFlushHeaders = response.flushHeaders.bind(response);
    response.flushHeaders = (() => {
      install(response.statusCode);
      originalFlushHeaders();
    }) as typeof response.flushHeaders;
  }

  private expireSignedRequestNonces(now = Date.now()): void {
    for (const [nonce, expiresAt] of this.signedRequestNonces) {
      if (expiresAt <= now) {
        this.signedRequestNonces.delete(nonce);
      }
    }
  }

  private hasBearerToken(request: http.IncomingMessage, token: string | undefined): boolean {
    const actual = request.headers.authorization;
    const expected = token ? `Bearer ${token}` : undefined;
    if (!expected || typeof actual !== "string") {
      return false;
    }

    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  }

  private getHeader(request: http.IncomingMessage, name: string): string | undefined {
    const value = request.headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0];
    }

    return value;
  }

  private async readJson<T>(request: http.IncomingMessage): Promise<T> {
    const declaredLength = Number(request.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxRequestBodyBytes) {
      throw new PayloadTooLargeError(`Request body exceeds the ${maxRequestBodyBytes}-byte limit.`);
    }

    const chunks: Buffer[] = [];
    let byteLength = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > maxRequestBodyBytes) {
        throw new PayloadTooLargeError(`Request body exceeds the ${maxRequestBodyBytes}-byte limit.`);
      }
      chunks.push(buffer);
    }

    const payload = Buffer.concat(chunks).toString("utf8");
    const expectedBodyHash = this.signedBodyHashes.get(request);
    this.signedBodyHashes.delete(request);
    if (expectedBodyHash !== undefined && hashBridgeBody(payload) !== expectedBodyHash) {
      throw new InvalidBridgeRequestError("Signed bridge request content did not match its authenticated digest.");
    }

    return JSON.parse(payload) as T;
  }

  private writeJson(response: http.ServerResponse, statusCode: number, value: unknown): void {
    let payload = JSON.stringify(value, null, 2);
    if (Buffer.byteLength(payload) > maxBufferedResponseBytes) {
      statusCode = 507;
      payload = JSON.stringify({ ok: false, error: "Response exceeded the bridge output limit." });
    }
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(payload);
  }

  private writeMcpError(
    response: http.ServerResponse,
    statusCode: number,
    code: number,
    message: string
  ): void {
    this.writeJson(response, statusCode, {
      jsonrpc: "2.0",
      error: {
        code,
        message
      },
      id: null
    });
  }

  private async writeConnectionFile(): Promise<void> {
    if (!this.connectionFile || !this.connectionInfo) {
      return;
    }

    const directory = path.dirname(this.connectionFile);
    const directoryInfo = await fs.lstat(directory).catch(error => {
      if (this.isFileNotFoundError(error)) {
        return undefined;
      }
      throw error;
    });
    if (directoryInfo?.isSymbolicLink() || (directoryInfo && !directoryInfo.isDirectory())) {
      throw new Error("The bridge connection directory must be a regular directory, not a symbolic link.");
    }
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const defaultDirectory = path.dirname(defaultConnectionFilePath());
    if (!directoryInfo || this.normalizePathForComparison(directory) === this.normalizePathForComparison(defaultDirectory)) {
      await fs.chmod(directory, 0o700).catch(() => undefined);
    }

    const existing = await fs.lstat(this.connectionFile).catch(error => {
      if (this.isFileNotFoundError(error)) {
        return undefined;
      }
      throw error;
    });
    if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
      throw new Error("The bridge connection file must be a regular file, not a symbolic link or directory.");
    }

    const temporaryFile = `${this.connectionFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryFile, JSON.stringify(this.connectionInfo, null, 2), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx"
      });
      await fs.chmod(temporaryFile, 0o600).catch(() => undefined);
      await fs.rename(temporaryFile, this.connectionFile);
      await fs.chmod(this.connectionFile, 0o600).catch(() => undefined);
    } catch (error) {
      await fs.unlink(temporaryFile).catch(() => undefined);
      throw error;
    }
  }

  private async startWorkerBehindGateway(
    host: string,
    gatewayPort: number,
    knownConnection?: BridgeConnectionInfo
  ): Promise<void> {
    try {
      const gatewayConnection = knownConnection
        ?? await this.waitForGatewayConnection(host, gatewayPort, gatewayConnectionWaitMs);
      const gatewayToken = gatewayConnection?.token;
      const registrationToken = gatewayConnection?.registrationToken;
      if (!gatewayToken || !registrationToken || gatewayConnection.host !== host || gatewayConnection.port !== gatewayPort) {
        const legacyConnection = await this.readConnectionFile(true);
        if (legacyConnection?.version === LEGACY_BRIDGE_VERSION &&
          legacyConnection.host === host && legacyConnection.port === gatewayPort) {
          throw new Error(
            `Port ${gatewayPort} is owned by an older bridge protocol. Reload or close every older extension window before starting this version.`
          );
        }
        throw new Error(
          `Port ${gatewayPort} is busy, but no compatible VS Code LSP MCP Bridge gateway credentials were found in the connection file.`
        );
      }

      await this.listen(0, host);
      const workerPort = this.listeningPort();
      this.role = "worker";
      this.actualPort = workerPort;
      this.gatewayEndpoint = { host, port: gatewayPort, registrationToken };
      this.connectionInfo = {
        version: BRIDGE_VERSION,
        host,
        port: gatewayPort,
        token: gatewayToken,
        registrationToken,
        ...this.currentWorkspaceFolderValues(),
        createdAt: new Date().toISOString()
      };

      await this.verifyGatewayIdentity();
      await this.refreshGatewayRegistration(true);
      await this.storeGatewayCredentials(gatewayToken, registrationToken);
      this.startRegistrationHeartbeat();
      this.registrationFailureCount = 0;
      this.recoveryGatewayPort = undefined;
      this.clearRecoveryTimer();
      showStatusNotification(
        `VS Code LSP MCP Bridge registered this workspace with the external-client gateway at http://${host}:${gatewayPort}/mcp.`
      );
    } catch (error) {
      await this.resetAfterFailedStart();
      throw error;
    }
  }

  private async tryUsePublishedGateway(connection: BridgeConnectionInfo): Promise<boolean> {
    this.gatewayEndpoint = {
      host: connection.host,
      port: connection.port,
      registrationToken: connection.registrationToken
    };
    try {
      await this.verifyGatewayIdentity();
      return true;
    } catch {
      this.gatewayEndpoint = undefined;
      return false;
    }
  }

  private async waitForGatewayConnection(
    host: string,
    port: number,
    maximumWaitMs: number
  ): Promise<BridgeConnectionInfo | undefined> {
    const deadline = Date.now() + maximumWaitMs;
    do {
      const connection = await this.readConnectionFile();
      if (connection?.host === host && connection.port === port) {
        return connection;
      }
      await new Promise(resolve => setTimeout(resolve, 50 + Math.floor(Math.random() * 100)));
    } while (Date.now() < deadline);
    return undefined;
  }

  async useThisWorkspace(): Promise<string> {
    await this.start();

    if (!this.connectionInfo || !this.workspaceId) {
      throw new Error("VS Code LSP MCP Bridge is not initialized.");
    }

    if (this.role === "gateway") {
      this.registerLocalWorkspace(
        this.connectionInfo.host,
        this.connectionInfo.port,
        this.connectionInfo.registrationToken
      );
      return `VS Code LSP MCP Bridge gateway now routes external MCP client sessions to ${this.workspaceDisplayName()}.`;
    }

    await this.refreshGatewayRegistration(true);
    return `VS Code LSP MCP Bridge gateway now routes external MCP client sessions to ${this.workspaceDisplayName()}.`;
  }

  private async handleGatewayRequest(
    requestPath: string,
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    if (this.role !== "gateway") {
      this.writeJson(response, 409, { ok: false, error: "This bridge instance is not the gateway." });
      return;
    }

    if (request.method === "POST" && requestPath === "/gateway/register") {
      const registration = await this.readJson<WorkspaceRegistration>(request);
      this.registerRemoteWorkspace(registration);
      this.writeJson(response, 200, {
        ok: true,
        activeWorkspace: this.activeWorkspaceSummary(),
        workspaceCount: this.registeredWorkspaces.size
      });
      return;
    }

    if (request.method === "POST" && requestPath === "/gateway/unregister") {
      const body = await this.readJson<{ id?: string }>(request);
      if (body.id && body.id !== this.workspaceId && !this.registeredWorkspaces.get(body.id)?.isLocal) {
        this.removeRegisteredWorkspace(body.id);
      }

      this.writeJson(response, 200, {
        ok: true,
        activeWorkspace: this.activeWorkspaceSummary(),
        workspaceCount: this.registeredWorkspaces.size
      });
      return;
    }

    if (request.method === "GET" && requestPath === "/gateway/workspaces") {
      this.expireStaleWorkspaces();
      this.writeJson(response, 200, {
        ok: true,
        activeWorkspace: this.activeWorkspaceSummary(),
        workspaces: [...this.registeredWorkspaces.values()].map(workspace => this.workspaceSummary(workspace))
      });
      return;
    }

    this.writeJson(response, 404, { ok: false, error: "Not found" });
  }

  private async handleGatewayChallenge(
    request: http.IncomingMessage,
    response: http.ServerResponse
  ): Promise<void> {
    if (this.role !== "gateway" || !this.connectionInfo?.registrationToken) {
      this.writeJson(response, 409, { ok: false, error: "This bridge instance is not the gateway." });
      return;
    }
    const body = await this.readJson<{ nonce?: unknown }>(request);
    if (typeof body.nonce !== "string" || !/^[0-9a-f]{64}$/iu.test(body.nonce)) {
      this.writeJson(response, 400, { ok: false, error: "Invalid gateway challenge." });
      return;
    }
    const proof = crypto.createHmac("sha256", this.connectionInfo.registrationToken).update(body.nonce).digest("hex");
    this.writeJson(response, 200, { ok: true, proof });
  }

  private registerLocalWorkspace(host: string, port: number, registrationToken: string, activate = true): void {
    const registration = this.createWorkspaceRegistration(host, port, activate);
    this.registeredWorkspaces.set(registration.id, {
      ...registration,
      isLocal: true,
      lastSeenAt: new Date().toISOString(),
      proxyKey: deriveWorkerProxyKey(registrationToken, registration.id)
    });
    if (activate || !this.activeWorkspaceId) {
      this.activeWorkspaceId = registration.id;
    }
  }

  private registerRemoteWorkspace(registration: WorkspaceRegistration): void {
    const registrationToken = this.connectionInfo?.registrationToken;
    if (
      !registrationToken ||
      !this.isValidWorkspaceRegistration(registration) ||
      registration.id === this.workspaceId ||
      registration.port === this.actualPort ||
      this.registeredWorkspaces.get(registration.id)?.isLocal
    ) {
      throw new Error("Invalid bridge workspace registration.");
    }

    this.expireStaleWorkspaces();
    if (!this.registeredWorkspaces.has(registration.id) && this.registeredWorkspaces.size >= maxRegisteredWorkspaces) {
      throw new Error("The bridge workspace registration limit has been reached.");
    }
    this.registeredWorkspaces.set(registration.id, {
      ...registration,
      isLocal: false,
      lastSeenAt: new Date().toISOString(),
      proxyKey: deriveWorkerProxyKey(registrationToken, registration.id)
    });

    if (registration.activate || !this.activeWorkspaceId) {
      this.activeWorkspaceId = registration.id;
    }
  }

  private removeRegisteredWorkspace(id: string): void {
    this.registeredWorkspaces.delete(id);
    this.removeSessionRoutesForWorkspace(id);

    if (this.activeWorkspaceId === id) {
      this.activeWorkspaceId = this.workspaceId && this.registeredWorkspaces.has(this.workspaceId)
        ? this.workspaceId
        : this.registeredWorkspaces.keys().next().value;
    }
  }

  private activeRemoteWorkspace(): RegisteredWorkspace | undefined {
    if (this.role !== "gateway") {
      return undefined;
    }

    this.expireStaleWorkspaces();
    if (!this.activeWorkspaceId || this.activeWorkspaceId === this.workspaceId) {
      return undefined;
    }

    const activeWorkspace = this.registeredWorkspaces.get(this.activeWorkspaceId);
    return activeWorkspace && !activeWorkspace.isLocal ? activeWorkspace : undefined;
  }

  private activeWorkspace(): RegisteredWorkspace | undefined {
    if (this.role !== "gateway") {
      return undefined;
    }

    this.expireStaleWorkspaces();
    return this.activeWorkspaceId ? this.registeredWorkspaces.get(this.activeWorkspaceId) : undefined;
  }

  private activeWorkspaceSummary(): object | undefined {
    if (this.role !== "gateway" || !this.activeWorkspaceId) {
      return undefined;
    }

    const activeWorkspace = this.registeredWorkspaces.get(this.activeWorkspaceId);
    return activeWorkspace ? this.workspaceSummary(activeWorkspace) : undefined;
  }

  private workspaceSummary(workspace: RegisteredWorkspace): object {
    return {
      id: workspace.id,
      name: workspace.name,
      active: workspace.id === this.activeWorkspaceId,
      local: workspace.isLocal,
      workspaceFolders: workspace.workspaceFolders.length,
      lastSeenAt: workspace.lastSeenAt
    };
  }

  private createWorkspaceRegistration(
    host: string,
    port: number,
    activate: boolean
  ): WorkspaceRegistration {
    return {
      id: this.workspaceId ?? this.createWorkspaceId(),
      name: this.workspaceDisplayName(),
      host,
      port,
      ...this.currentWorkspaceFolderValues(),
      startedAt: new Date().toISOString(),
      activate
    };
  }

  private currentWorkspaceFolderValues(): Pick<BridgeConnectionInfo, "workspaceFolders" | "workspaceFolderUris"> {
    const folders = (vscode.workspace.workspaceFolders ?? []).slice(0, maxWorkspaceFolders);
    return {
      workspaceFolders: folders.map(folder => folder.uri.fsPath),
      workspaceFolderUris: folders.map(folder => folder.uri.toString())
    };
  }

  private createWorkspaceId(): string {
    return crypto.randomUUID();
  }

  private isValidWorkspaceRegistration(value: WorkspaceRegistration): boolean {
    return typeof value?.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.id) &&
      typeof value.name === "string" && value.name.length > 0 && value.name.length <= 200 &&
      this.isLoopbackHost(value.host) &&
      Number.isInteger(value.port) && value.port >= 1 && value.port <= 65_535 &&
      Array.isArray(value.workspaceFolders) && value.workspaceFolders.length <= maxWorkspaceFolders &&
      value.workspaceFolders.every(folder => typeof folder === "string" && folder.length <= 32_768) &&
      Array.isArray(value.workspaceFolderUris) && value.workspaceFolderUris.length === value.workspaceFolders.length &&
      value.workspaceFolderUris.every(uri => typeof uri === "string" && uri.length <= 32_768) &&
      typeof value.startedAt === "string" && !Number.isNaN(Date.parse(value.startedAt)) &&
      (value.activate === undefined || typeof value.activate === "boolean");
  }

  private workspaceDisplayName(): string {
    const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return vscode.workspace.name ?? (firstFolder ? path.basename(firstFolder) : "No workspace");
  }

  private expireStaleWorkspaces(): void {
    if (this.role !== "gateway") {
      return;
    }

    const now = Date.now();
    for (const workspace of this.registeredWorkspaces.values()) {
      if (!workspace.isLocal && now - Date.parse(workspace.lastSeenAt) > registrationStaleMs) {
        this.removeRegisteredWorkspace(workspace.id);
      }
    }
  }

  private removeSessionRoutesForWorkspace(workspaceId: string): void {
    for (const [sessionId, route] of this.mcpSessionRoutes.entries()) {
      if (route.workspaceId === workspaceId) {
        this.mcpSessionRoutes.delete(sessionId);
      }
    }
  }

  private async refreshGatewayRegistration(activate: boolean): Promise<void> {
    if (!this.gatewayEndpoint || this.actualPort === undefined) {
      return;
    }

    const registration = this.createWorkspaceRegistration(
      this.gatewayEndpoint.host,
      this.actualPort,
      activate
    );

    await this.postJsonToGateway("/gateway/register", registration);
  }

  private async unregisterFromGateway(): Promise<void> {
    if (!this.gatewayEndpoint || !this.workspaceId) {
      return;
    }

    await this.postJsonToGateway("/gateway/unregister", { id: this.workspaceId });
  }

  private startRegistrationHeartbeat(): void {
    this.stopRegistrationHeartbeat();
    this.registrationTimer = setInterval(() => {
      void this.refreshGatewayRegistration(false)
        .then(() => {
          this.registrationFailureCount = 0;
        })
        .catch(error => {
          this.registrationFailureCount += 1;
          console.warn(
            `VS Code LSP MCP Bridge gateway registration refresh failed (${this.registrationFailureCount}/${maxRegistrationFailures}).`,
            error
          );
          if (this.registrationFailureCount >= maxRegistrationFailures) {
            void this.promoteWorkerIfGatewayDisappeared();
          }
        });
    }, registrationRefreshMs);
  }

  private stopRegistrationHeartbeat(): void {
    if (this.registrationTimer) {
      clearInterval(this.registrationTimer);
      this.registrationTimer = undefined;
    }
  }

  private async promoteWorkerIfGatewayDisappeared(): Promise<void> {
    if (this.role !== "worker" || this.isPromoting || !this.desiredRunning) {
      return;
    }

    const generation = this.lifecycleGeneration;
    this.isPromoting = true;
    const operation = this.promoteWorker(generation);
    this.promotionPromise = operation;
    try {
      await operation;
    } catch (error) {
      console.warn("VS Code LSP MCP Bridge worker promotion failed.", error);
      this.scheduleRecoveryStart(generation);
    } finally {
      if (this.promotionPromise === operation) {
        this.promotionPromise = undefined;
      }
      this.isPromoting = false;
    }
  }

  private async promoteWorker(generation: number): Promise<void> {
    this.recoveryGatewayPort = this.gatewayEndpoint?.port;
    const server = this.server;
    this.server = undefined;
    this.connectionInfo = undefined;
    this.role = undefined;
    this.actualPort = undefined;
    this.gatewayEndpoint = undefined;
    this.stopRegistrationHeartbeat();
    await this.closeMcpSessions();

    if (server) {
      await this.closeHttpServer(server).catch(() => undefined);
    }

    if (!this.desiredRunning || generation !== this.lifecycleGeneration) {
      return;
    }
    await this.startForGeneration(generation);
  }

  private scheduleRecoveryStart(generation: number): void {
    if (this.recoveryTimer || !this.desiredRunning || generation !== this.lifecycleGeneration) {
      return;
    }
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (!this.desiredRunning || generation !== this.lifecycleGeneration) {
        return;
      }
      void this.startForGeneration(generation).catch(error => {
        console.warn("VS Code LSP MCP Bridge recovery start failed.", error);
        this.scheduleRecoveryStart(generation);
      });
    }, recoveryRetryMs);
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) {
      clearTimeout(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
  }

  private async postJsonToGateway(pathname: string, body: unknown): Promise<void> {
    if (!this.gatewayEndpoint) {
      throw new Error("Gateway endpoint is not initialized.");
    }
    const payload = JSON.stringify(body);
    const signedRequest = signBridgeRequest(this.gatewayEndpoint.registrationToken, {
      method: "POST",
      path: pathname,
      body: payload
    });
    await this.requestJson({
      host: this.gatewayEndpoint.host,
      port: this.gatewayEndpoint.port,
      path: pathname,
      method: "POST",
      headers: {
        ...signedRequest.headers,
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      }
    }, payload, {
      key: this.gatewayEndpoint.registrationToken,
      nonce: signedRequest.nonce
    });
  }

  private async verifyGatewayIdentity(): Promise<void> {
    if (!this.gatewayEndpoint) {
      throw new Error("Gateway endpoint is not initialized.");
    }
    const nonce = crypto.randomBytes(32).toString("hex");
    const payload = JSON.stringify({ nonce });
    const result = await this.requestJson({
      host: this.gatewayEndpoint.host,
      port: this.gatewayEndpoint.port,
      path: "/gateway/challenge",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(payload)
      }
    }, payload);
    const proof = this.isJsonObject(result) && typeof result.proof === "string" ? result.proof : "";
    const expected = crypto.createHmac("sha256", this.gatewayEndpoint.registrationToken).update(nonce).digest("hex");
    const proofBuffer = Buffer.from(proof);
    const expectedBuffer = Buffer.from(expected);
    if (proofBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(proofBuffer, expectedBuffer)) {
      throw new Error("The process on the configured port did not prove that it is the expected bridge gateway.");
    }
  }

  private async proxyRequestToWorkspace(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    workspace: RegisteredWorkspace,
    body: unknown,
    options: { mcp: boolean }
  ): Promise<void> {
    try {
      await this.proxyRequest(request, response, workspace, body);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      if (options.mcp) {
        this.writeMcpError(response, 502, -32000, `MCP workspace proxy failed: ${message}`);
      } else {
        this.writeJson(response, 502, { ok: false, error: `Workspace proxy failed: ${message}` });
      }
    }
  }

  private async tryHandleMcpToolCallInWorkspace(
    response: http.ServerResponse,
    body: unknown,
    workspace: RegisteredWorkspace
  ): Promise<boolean> {
    const toolRequest = this.mcpToolRequestFromBody(body);
    if (!toolRequest) {
      return false;
    }

    try {
      const validatedRequest = this.validateBridgeToolRequest(toolRequest.request);
      const toolResponse = workspace.isLocal
        ? await this.runLocalToolRequest(validatedRequest)
        : await this.postToolRequestToWorkspace(workspace, validatedRequest);
      if (toolResponse.ok) {
        this.writeJson(response, 200, {
          jsonrpc: "2.0",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(toolResponse.result ?? null, null, 2)
              }
            ]
          },
          id: toolRequest.id
        });
        return true;
      }

      this.writeJson(response, 200, {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: toolResponse.error ?? "Workspace tool call failed."
        },
        id: toolRequest.id
      });
      return true;
    } catch (error) {
      this.writeJson(response, 200, {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: `MCP workspace tool proxy failed: ${error instanceof Error ? error.message : String(error)}`
        },
        id: toolRequest.id
      });
      return true;
    }
  }

  private async workspaceForMcpToolCall(
    body: unknown,
    requireUnique = false
  ): Promise<RegisteredWorkspace | undefined> {
    const toolRequest = this.mcpToolRequestFromBody(body);
    return toolRequest ? this.workspaceForToolRequest(toolRequest.request, requireUnique) : undefined;
  }

  private async workspaceForToolRequest(
    request: BridgeToolRequest,
    requireUnique = false
  ): Promise<RegisteredWorkspace | undefined> {
    if (this.role !== "gateway") {
      return undefined;
    }

    const file = this.toolFileArgument(request.args);
    if (file) {
      this.expireStaleWorkspaces();
      const workspaces = [...this.registeredWorkspaces.values()];
      if (path.isAbsolute(file)) {
        return this.workspaceContainingAbsolutePath(workspaces, file, requireUnique);
      }

      const uri = this.parseToolUri(file);
      if (uri) {
        return uri.scheme === "file"
          ? this.workspaceContainingAbsolutePath(workspaces, uri.fsPath, requireUnique)
          : this.workspaceContainingUri(workspaces, uri, requireUnique);
      }

      const matches = [];
      for (const workspace of workspaces) {
        for (const folder of this.localWorkspaceFolders(workspace)) {
          const candidate = path.resolve(folder, file);
          if (this.pathContains(folder, this.normalizePathForComparison(candidate)) && await this.pathExists(candidate)) {
            matches.push(workspace);
            break;
          }
        }
      }

      return this.selectWorkspaceMatch(matches, requireUnique);
    }

    return this.workspaceForSymbolQuery(request.args, requireUnique);
  }

  private async workspaceForSymbolQuery(
    args: Record<string, unknown>,
    requireUnique: boolean
  ): Promise<RegisteredWorkspace | undefined> {
    const containerName = this.symbolQueryContainerName(args);
    if (!containerName) {
      return undefined;
    }

    const leafContainerName = containerName.split(".").filter(Boolean).at(-1);
    if (!leafContainerName) {
      return undefined;
    }

    this.expireStaleWorkspaces();
    const workspaces = [...this.registeredWorkspaces.values()];
    const deadline = Date.now() + symbolRouteTimeoutMs;
    const matches = [];
    for (const workspace of workspaces) {
      if (Date.now() >= deadline) {
        break;
      }
      if (await this.workspaceContainsFileBaseName(workspace, leafContainerName, deadline)) {
        matches.push(workspace);
      }
    }

    return this.selectWorkspaceMatch(matches, requireUnique);
  }

  private selectWorkspaceMatch(
    matches: RegisteredWorkspace[],
    requireUnique = false
  ): RegisteredWorkspace | undefined {
    if (matches.length === 1) {
      return matches[0];
    }

    if (requireUnique) {
      return undefined;
    }

    const activeWorkspace = this.activeWorkspace();
    return activeWorkspace && matches.some(workspace => workspace.id === activeWorkspace.id)
      ? activeWorkspace
      : undefined;
  }

  private toolFileArgument(args: Record<string, unknown>): string | undefined {
    const file = args.file;
    return typeof file === "string" && file.length <= 32_768 && file.trim() ? file : undefined;
  }

  private symbolQueryContainerName(args: Record<string, unknown>): string | undefined {
    const explicitContainer = args.containerName;
    if (typeof explicitContainer === "string" && explicitContainer.length <= 1_000 && explicitContainer.trim()) {
      return explicitContainer.trim();
    }

    const query = args.query;
    if (typeof query !== "string" || query.length > 1_000 || !query.trim()) {
      return undefined;
    }

    const queryParts = query.split(".").filter(Boolean);
    return queryParts.length > 1 ? queryParts.slice(0, -1).join(".") : undefined;
  }

  private async workspaceContainsFileBaseName(
    workspace: RegisteredWorkspace,
    baseName: string,
    deadline: number
  ): Promise<boolean> {
    for (const folder of this.localWorkspaceFolders(workspace)) {
      if (Date.now() >= deadline) {
        return false;
      }
      if (await this.folderContainsFileBaseName(folder, baseName, deadline)) {
        return true;
      }
    }

    return false;
  }

  private async folderContainsFileBaseName(folder: string, baseName: string, deadline: number): Promise<boolean> {
    const expectedPrefix = `${baseName.toLowerCase()}.`;
    const pending = [folder];
    let visited = 0;

    while (pending.length > 0 && visited < symbolRouteMaxEntriesPerFolder && Date.now() < deadline) {
      const current = pending.pop();
      if (!current) {
        continue;
      }

      let entries;
      try {
        entries = await this.withTimeout(
          fs.readdir(current, { withFileTypes: true }),
          Math.max(1, deadline - Date.now()),
          "Symbol routing timed out."
        );
      } catch {
        continue;
      }

      for (const entry of entries) {
        visited += 1;
        if (entry.isDirectory()) {
          if (!ignoredRouteDirectories.has(entry.name)) {
            pending.push(path.join(current, entry.name));
          }
          continue;
        }

        if (entry.isFile() && entry.name.toLowerCase().startsWith(expectedPrefix)) {
          return true;
        }
      }
    }

    return false;
  }

  private workspaceContainingAbsolutePath(
    workspaces: RegisteredWorkspace[],
    file: string,
    requireUnique: boolean
  ): RegisteredWorkspace | undefined {
    const normalizedFile = this.normalizePathForComparison(file);
    const matches = workspaces.filter(workspace =>
      workspace.workspaceFolders.some((folder, index) => {
        try {
          return vscode.Uri.parse(workspace.workspaceFolderUris[index] ?? "", true).scheme === "file"
            && this.pathContains(folder, normalizedFile);
        } catch {
          return false;
        }
      })
    );
    return this.selectWorkspaceMatch(matches, requireUnique);
  }

  private workspaceContainingUri(
    workspaces: RegisteredWorkspace[],
    file: vscode.Uri,
    requireUnique: boolean
  ): RegisteredWorkspace | undefined {
    const matches = workspaces.filter(workspace => workspace.workspaceFolderUris.some(value => {
      try {
        const folder = vscode.Uri.parse(value, true);
        if (folder.scheme.toLowerCase() !== file.scheme.toLowerCase() ||
          folder.authority.toLowerCase() !== file.authority.toLowerCase()) {
          return false;
        }

        const folderPath = folder.path.endsWith("/") ? folder.path : `${folder.path}/`;
        return file.path === folder.path || file.path.startsWith(folderPath);
      } catch {
        return false;
      }
    }));

    return this.selectWorkspaceMatch(matches, requireUnique);
  }

  private parseToolUri(value: string): vscode.Uri | undefined {
    if (!/^[a-z][a-z0-9+.-]*:/iu.test(value) || /^[a-z]:[\\/]/iu.test(value)) {
      return undefined;
    }

    try {
      const uri = vscode.Uri.parse(value, true);
      return uri.scheme ? uri : undefined;
    } catch {
      return undefined;
    }
  }

  private pathContains(folder: string, normalizedFile: string): boolean {
    const normalizedFolder = this.normalizePathForComparison(folder);
    const folderWithSeparator = normalizedFolder.endsWith(path.sep) ? normalizedFolder : `${normalizedFolder}${path.sep}`;
    return normalizedFile === normalizedFolder || normalizedFile.startsWith(folderWithSeparator);
  }

  private normalizePathForComparison(file: string): string {
    const resolved = path.resolve(file);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  private localWorkspaceFolders(workspace: RegisteredWorkspace): string[] {
    return workspace.workspaceFolders.filter((_, index) => {
      const value = workspace.workspaceFolderUris[index];
      if (!value) {
        return false;
      }
      try {
        return vscode.Uri.parse(value).scheme === "file";
      } catch {
        return false;
      }
    });
  }

  private async pathExists(file: string): Promise<boolean> {
    try {
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
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

  private mcpToolRequestFromBody(body: unknown): { id: string | number | null | undefined; request: BridgeToolRequest } | undefined {
    if (!this.isJsonObject(body)) {
      return undefined;
    }

    const request = body as JsonRpcRequest;
    if (request.method !== "tools/call" || !this.isJsonObject(request.params)) {
      return undefined;
    }

    const params = request.params as McpToolCallParams;
    if (typeof params.name !== "string") {
      return undefined;
    }

    const args = this.isJsonObject(params.arguments) ? params.arguments as Record<string, unknown> : {};

    return {
      id: request.id,
      request: {
        name: params.name,
        args
      }
    };
  }

  private validateBridgeToolRequest(body: unknown): BridgeToolRequest {
    if (!this.isJsonObject(body) || typeof body.name !== "string" || body.name.length > 100 ||
      (body.args !== undefined && !this.isJsonObject(body.args))) {
      throw new InvalidBridgeRequestError("Expected a language tool name and an object of arguments.");
    }
    try {
      return { name: body.name, args: validateLanguageToolArgs(body.name, body.args ?? {}) };
    } catch (error) {
      throw new InvalidBridgeRequestError(error instanceof Error ? error.message : String(error));
    }
  }

  private async postToolRequestToWorkspace(
    workspace: RegisteredWorkspace,
    body: BridgeToolRequest
  ): Promise<BridgeToolResponse> {
    const payload = JSON.stringify(body);
    const signedRequest = signBridgeRequest(workspace.proxyKey, {
      method: "POST",
      path: "/tool",
      body: payload
    });
    return await new Promise<BridgeToolResponse>((resolve, reject) => {
      const request = http.request(
        {
          host: workspace.host,
          port: workspace.port,
          path: "/tool",
          method: "POST",
          headers: {
            ...signedRequest.headers,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(payload)
          }
        },
        response => {
          if (!verifyBridgeResponseProof(
            workspace.proxyKey,
            signedRequest.nonce,
            response.statusCode ?? 500,
            this.firstHeaderValue(response.headers[bridgeAuthHeaders.responseProof])
          )) {
            response.resume();
            reject(new Error("The workspace bridge did not authenticate its response."));
            return;
          }

          const chunks: Buffer[] = [];
          let byteLength = 0;
          response.on("data", chunk => {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            byteLength += buffer.byteLength;
            if (byteLength > maxBufferedResponseBytes) {
              response.destroy(new Error("Workspace tool response exceeded the buffer limit."));
              return;
            }
            chunks.push(buffer);
          });
          response.on("error", reject);
          response.on("end", () => {
            try {
              const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as BridgeToolResponse;
              if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
                reject(new Error(parsed.error ?? `HTTP ${response.statusCode}`));
                return;
              }
              resolve(parsed);
            } catch (error) {
              reject(error);
            }
          });
        }
      );

      request.on("error", reject);
      request.write(payload);
      request.end();
    });
  }

  private async runLocalToolRequest(body: BridgeToolRequest): Promise<BridgeToolResponse> {
    try {
      const result = await runLanguageTool(body.name, body.args ?? {}, { allowWrites: this.allowWrites });
      return { ok: true, result };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async proxyRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    workspace: RegisteredWorkspace,
    body: unknown
  ): Promise<void> {
    const method = (request.method ?? "GET").toUpperCase();
    const sessionId = this.getHeader(request, "mcp-session-id");
    const protocolVersion = this.getHeader(request, "mcp-protocol-version");
    const lastEventId = this.getHeader(request, "last-event-id");
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const requestPath = request.url ?? "/mcp";
    const signedRequest = signBridgeRequest(workspace.proxyKey, {
      method,
      path: requestPath,
      body: payload,
      sessionId,
      protocolVersion,
      lastEventId
    });
    const headers: http.OutgoingHttpHeaders = {
      ...signedRequest.headers,
      accept: request.headers.accept ?? "application/json, text/event-stream"
    };

    if (sessionId) {
      headers["mcp-session-id"] = sessionId;
    }
    if (protocolVersion) {
      headers["mcp-protocol-version"] = protocolVersion;
    }
    if (lastEventId) {
      headers["last-event-id"] = lastEventId;
    }

    if (payload !== undefined) {
      headers["content-type"] = "application/json";
      headers["content-length"] = Buffer.byteLength(payload);
    }

    await new Promise<void>((resolve, reject) => {
      const proxyRequest = http.request(
        {
          host: workspace.host,
          port: workspace.port,
          path: requestPath,
          method,
          headers
        },
        proxyResponse => {
          if (!verifyBridgeResponseProof(
            workspace.proxyKey,
            signedRequest.nonce,
            proxyResponse.statusCode ?? 500,
            this.firstHeaderValue(proxyResponse.headers[bridgeAuthHeaders.responseProof])
          )) {
            proxyResponse.resume();
            reject(new Error("The workspace bridge did not authenticate its response."));
            return;
          }

          const proxiedSessionId = this.firstHeaderValue(proxyResponse.headers["mcp-session-id"]);
          if (proxiedSessionId && !this.setMcpSessionRoute(proxiedSessionId, workspace.id)) {
            proxyResponse.resume();
            reject(new Error("The gateway MCP session limit was reached during initialization."));
            return;
          }

          response.writeHead(proxyResponse.statusCode ?? 502, this.outgoingHeaders(proxyResponse.headers));
          proxyResponse.pipe(response);
          proxyResponse.on("error", reject);
          proxyResponse.on("end", resolve);
        }
      );

      proxyRequest.on("error", reject);

      if (payload !== undefined) {
        proxyRequest.write(payload);
      }
      proxyRequest.end();
    });
  }

  private async requestJson(
    options: http.RequestOptions,
    payload: string,
    expectedResponse?: { key: string; nonce: string }
  ): Promise<unknown> {
    return await new Promise<unknown>((resolve, reject) => {
      const request = http.request(options, response => {
        if (expectedResponse && !verifyBridgeResponseProof(
          expectedResponse.key,
          expectedResponse.nonce,
          response.statusCode ?? 500,
          this.firstHeaderValue(response.headers[bridgeAuthHeaders.responseProof])
        )) {
          response.resume();
          reject(new Error("The process on the gateway port did not authenticate its response."));
          return;
        }

        const chunks: Buffer[] = [];
        let byteLength = 0;
        response.on("data", chunk => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          byteLength += buffer.byteLength;
          if (byteLength > maxBufferedResponseBytes) {
            response.destroy(new Error("Bridge gateway response exceeded the buffer limit."));
            return;
          }
          chunks.push(buffer);
        });
        response.on("error", reject);
        response.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
              reject(new Error(text || `HTTP ${response.statusCode}`));
              return;
            }
            resolve(text ? JSON.parse(text) : {});
          } catch (error) {
            reject(error);
          }
        });
      });

      request.on("error", reject);
      request.setTimeout(5_000, () => {
        request.destroy(new Error("Timed out while contacting the bridge gateway."));
      });
      request.write(payload);
      request.end();
    });
  }

  private async readConnectionFile(includeLegacy = false): Promise<BridgeConnectionInfo | undefined> {
    if (!this.connectionFile) {
      return undefined;
    }

    try {
      const info = await fs.lstat(this.connectionFile);
      if (info.isSymbolicLink() || !info.isFile() || info.size > 1_048_576) {
        return undefined;
      }
      const value = JSON.parse(await fs.readFile(this.connectionFile, "utf8")) as Partial<BridgeConnectionInfo>;
      const supportedVersion = value.version === BRIDGE_VERSION ||
        (includeLegacy && value.version === LEGACY_BRIDGE_VERSION);
      return supportedVersion && this.isLoopbackHost(value.host) &&
        Number.isInteger(value.port) && (value.port ?? 0) > 0 && (value.port ?? 0) <= 65_535 &&
        typeof value.token === "string" && /^[0-9a-f]{64}$/iu.test(value.token) &&
        typeof value.registrationToken === "string" && /^[0-9a-f]{64}$/iu.test(value.registrationToken)
        ? value as BridgeConnectionInfo
        : undefined;
    } catch {
      return undefined;
    }
  }

  private outgoingHeaders(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
    const outgoing: http.OutgoingHttpHeaders = {};
    for (const [key, value] of Object.entries(headers)) {
      if (value !== undefined && !internalBridgeHeaderNames.has(key.toLowerCase())) {
        outgoing[key] = value;
      }
    }

    return outgoing;
  }

  private firstHeaderValue(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  private setMcpSessionRoute(sessionId: string, workspaceId: string): boolean {
    this.expireIdleMcpSessionRoutes();
    if (!this.mcpSessionRoutes.has(sessionId) && this.mcpSessionRoutes.size >= maxMcpSessionRoutes) {
      return false;
    }
    this.mcpSessionRoutes.set(sessionId, { workspaceId, lastSeenAt: Date.now() });
    return true;
  }

  private expireIdleMcpSessionRoutes(): void {
    const cutoff = Date.now() - mcpSessionIdleMs;
    for (const [sessionId, route] of this.mcpSessionRoutes) {
      if (route.lastSeenAt < cutoff) {
        this.mcpSessionRoutes.delete(sessionId);
      }
    }
  }

  private isJsonObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }

  private async resetAfterFailedStart(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.connectionInfo = undefined;
    this.connectionFile = undefined;
    this.role = undefined;
    this.workspaceId = undefined;
    this.actualPort = undefined;
    this.gatewayEndpoint = undefined;
    this.activeWorkspaceId = undefined;
    this.registeredWorkspaces.clear();
    this.mcpSessionRoutes.clear();
    this.signedRequestNonces.clear();
    this.signedBodyHashes = new WeakMap<http.IncomingMessage, string>();

    if (server?.listening) {
      await this.closeHttpServer(server).catch(() => undefined);
    }
  }

  private async listen(port: number, host: string): Promise<void> {
    const server = this.server;
    if (!server) {
      throw new Error("Bridge HTTP server is not initialized.");
    }

    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        server.off("error", onError);
        server.off("listening", onListening);
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      const onListening = () => {
        cleanup();
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      try {
        server.listen(port, host);
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  private listeningPort(): number {
    const address = this.server?.address();
    if (address && typeof address !== "string") {
      return address.port;
    }

    throw new Error("Bridge HTTP server is not listening on a TCP port.");
  }

  private isAddressInUseError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "EADDRINUSE";
  }

  private isFileNotFoundError(error: unknown): boolean {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
  }

  private ensureLoopbackHost(host: string): void {
    if (!this.isLoopbackHost(host)) {
      throw new Error("The bridge host must be 127.0.0.1.");
    }
  }

  private isLoopbackHost(host: unknown): host is string {
    return host === "127.0.0.1";
  }

  private async closeHttpServer(server: http.Server): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      server.close(error => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
      server.closeAllConnections();
    });
  }

  private async getOrCreateToken(): Promise<string> {
    const secretKey = "bridgeToken";
    const existing = await this.context.secrets.get(secretKey);
    if (existing) {
      return existing;
    }

    const token = crypto.randomBytes(32).toString("hex");
    await this.context.secrets.store(secretKey, token);
    return token;
  }

  private async getOrCreateRegistrationToken(): Promise<string> {
    const secretKey = "gatewayRegistrationToken";
    const existing = await this.context.secrets.get(secretKey);
    if (existing) {
      return existing;
    }

    const token = crypto.randomBytes(32).toString("hex");
    await this.context.secrets.store(secretKey, token);
    return token;
  }

  private async storeGatewayCredentials(token: string, registrationToken: string): Promise<void> {
    await Promise.all([
      this.context.secrets.store("bridgeToken", token),
      this.context.secrets.store("gatewayRegistrationToken", registrationToken)
    ]);
  }

  private get allowWrites(): boolean {
    return getWriteToolsEnabled();
  }

  private async closeMcpSessions(): Promise<void> {
    const sessions = [...this.mcpSessions.entries()];
    this.mcpSessions.clear();
    for (const [sessionId] of sessions) {
      this.mcpSessionRoutes.delete(sessionId);
    }

    await Promise.allSettled(
      sessions.map(async ([, session]) => {
        await session.server.close();
      })
    );
  }

  private async expireIdleMcpSessions(): Promise<void> {
    const cutoff = Date.now() - mcpSessionIdleMs;
    const expired = [...this.mcpSessions.entries()].filter(([, session]) => session.lastSeenAt < cutoff);
    for (const [sessionId, session] of expired) {
      this.mcpSessions.delete(sessionId);
      this.mcpSessionRoutes.delete(sessionId);
      await session.server.close().catch(() => undefined);
    }
  }
}
