/**
 * Usage log: one JSON object per line on stderr, saying who connected, what
 * they asked, how long it took and how it ended. stderr because under stdio
 * stdout is the protocol; whatever collects the process's output keeps it.
 * Plain-text logs share the stream; events are the lines starting with "{".
 *
 *   {"ts":"…","event":"session","session":"7f3c…","client":"claude-code","version":"2.1.4"}
 *   {"ts":"…","event":"tool","session":"7f3c…","tool":"run_sparql","args":{"query":"…"},"ms":842,"outcome":"empty","rows":0}
 *
 * A session groups one client's calls: a stdio process, or an HTTP client
 * (see http.ts). Nothing here identifies a person: no IP, no account.
 */

import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

enum EventKind {
  /** A client introduced itself. */
  Session = "session",
  /** A tool call finished. */
  Tool = "tool",
}

/** How a call ended, for tools without outcomes of their own. */
enum Outcome {
  Ok = "ok",
  /** Zero results: for resolve_ontology, a term AgroPortal does not have. */
  Empty = "empty",
  /** The handler threw. */
  Error = "error",
}

/** What a handler may add to its call's event. */
interface Facts {
  outcome?: string;
  rows?: number;
  truncated?: boolean;
}

interface SessionEvent {
  event: EventKind.Session;
  session: string;
  client: string;
  version: string;
}

interface ToolEvent extends Facts {
  event: EventKind.Tool;
  session: string;
  tool: string;
  args: unknown;
  ms: number;
  outcome: string;
  error?: string;
}

function record(event: SessionEvent | ToolEvent): void {
  process.stderr.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

/**
 * Record the client as it introduces itself. Call before connect:
 * Protocol.connect keeps a handler already on the transport and runs it first.
 */
export function watchSession(transport: Transport, session: string): void {
  transport.onmessage = (message) => {
    if (!isInitializeRequest(message)) {
      return;
    }

    const { name, version } = message.params.clientInfo;
    record({ event: EventKind.Session, session, client: name, version });
  };
}

/**
 * Time a tool call and record it as one event. `note` lets the handler add
 * what only it knows, e.g. run_sparql's outcome. Zero rows and no outcome
 * noted count as empty.
 */
export function logged<Args, Result>(
  session: string,
  tool: string,
  handler: (args: Args, note: (facts: Facts) => void) => Promise<Result>,
): (args: Args) => Promise<Result> {
  return async (args) => {
    const started = performance.now();
    const facts: Facts = {};
    const call = { event: EventKind.Tool, session, tool, args } as const;

    try {
      const result = await handler(args, (more) => Object.assign(facts, more));
      const outcome = facts.outcome ?? (facts.rows === 0 ? Outcome.Empty : Outcome.Ok);
      const { rows, truncated } = facts;
      record({ ...call, ms: elapsed(started), outcome, rows, truncated });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      record({ ...call, ms: elapsed(started), outcome: Outcome.Error, error: message });
      throw error;
    }
  };
}
