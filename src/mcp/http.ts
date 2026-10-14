/**
 * Streamable HTTP transport, for hosts that connect to a running server
 * instead of launching their own: a shared deployment, or a host that only
 * speaks HTTP.
 *
 * Stateless. Each POST gets a fresh McpServer and transport, closed with the
 * response, so there are no sessions to track or expire and any replica can
 * answer any request. The one thing worth keeping between requests, the
 * schema card cache, lives in the services `open` closes over.
 *
 *     host ──POST /mcp──▶ open() ──▶ McpServer + transport ──▶ shared services
 *                                           │
 *                                response closed ──▶ closed
 *
 * The server never speaks first, so GET has no stream to open and DELETE no
 * session to end. Both get 405, which the spec allows.
 */

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIPv6, type AddressInfo } from "node:net";

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const MCP_PATH = "/mcp";
const MCP_METHOD = "POST";
const SESSION_HEADER = "mcp-session-id";

const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_INTERNAL_SERVER_ERROR = 500;

/** This machine, as `URL.hostname` spells it. */
const LOOPBACK_HOSTNAMES = ["localhost", "127.0.0.1", "[::1]"];

export interface HttpOptions {
  host: string;
  port: number;
}

/** Connects a fresh server to one request's transport, in the client's session. */
type Open = (transport: StreamableHTTPServerTransport, session: string) => Promise<McpServer>;

function log(message: string): void {
  process.stderr.write(`http: ${message}\n`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * DNS rebinding and cross-site requests come from browsers, and a browser
 * always sends Origin with a POST. Hosts send none. So: no Origin, or one on
 * this machine, such as the MCP Inspector's.
 */
function isTrusted(origin: string | undefined): boolean {
  if (origin === undefined) {
    return true;
  }

  return URL.canParse(origin) && LOOPBACK_HOSTNAMES.includes(new URL(origin).hostname);
}

/**
 * The client's session, for the usage log only: nothing is stored under it.
 * A client's first request carries none, so it gets a fresh id on the
 * response, which the spec obliges the client to send back from then on.
 */
function sessionOf(req: IncomingMessage, res: ServerResponse): string {
  const echoed = req.headers[SESSION_HEADER];
  if (typeof echoed === "string") {
    return echoed;
  }

  const minted = randomUUID();
  res.setHeader(SESSION_HEADER, minted);
  return minted;
}

async function handle(open: Open, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isTrusted(req.headers.origin)) {
    res.writeHead(HTTP_FORBIDDEN).end();
    return;
  }

  if (req.url?.split("?")[0] !== MCP_PATH) {
    res.writeHead(HTTP_NOT_FOUND).end();
    return;
  }

  if (req.method !== MCP_METHOD) {
    res.writeHead(HTTP_METHOD_NOT_ALLOWED, { Allow: MCP_METHOD }).end();
    return;
  }

  // One server and transport per request; closing the server closes both.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = await open(transport, sessionOf(req, res));
  res.on("close", () => {
    server.close().catch((error: unknown) => log(`close failed: ${messageOf(error)}`));
  });

  await transport.handleRequest(req, res);
}

/** Listen until the process exits. Resolves, once bound, with the URL hosts connect to. */
export async function serveHttp(open: Open, { host, port }: HttpOptions): Promise<string> {
  const listener = createServer((req, res) => {
    handle(open, req, res).catch((error: unknown) => {
      log(`${req.method} ${req.url} failed: ${messageOf(error)}`);
      if (!res.headersSent) {
        res.writeHead(HTTP_INTERNAL_SERVER_ERROR).end();
      }
    });
  });

  listener.listen(port, host);
  await once(listener, "listening");

  // Port 0 lets the OS pick; report the port it picked.
  const bound = (listener.address() as AddressInfo).port;
  return `http://${isIPv6(host) ? `[${host}]` : host}:${bound}${MCP_PATH}`;
}
