/**
 * Drives the MCP server over stdio, or HTTP with `--transport http`, with a
 * real MCP client.
 *
 * This is the test that matters for an MCP server: it spawns the actual
 * process, speaks the actual protocol, and would catch the failures that only
 * appear once the host launches you — a schema card resolved against the wrong
 * working directory, a stray stdout write corrupting the transport, a tool
 * whose Zod schema does not survive JSON Schema conversion.
 *
 * It deliberately launches the server from a DIFFERENT working directory,
 * because that is what a host does.
 *
 *   npx tsx scripts/mcp-smoke.ts [--transport http]
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { spawn, type ChildProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Readable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = resolve(PROJECT_ROOT, "src/mcp/server.ts");

/** Spawned directly, not through npx, so killing it stops the server. */
const TSX_BIN = resolve(PROJECT_ROOT, "node_modules/.bin/tsx");

enum Transport {
  Stdio = "stdio",
  Http = "http",
}

const TRANSPORT = parseArgs({
  options: { transport: { type: "string", default: Transport.Stdio } },
}).values.transport as Transport;
if (!Object.values(Transport).includes(TRANSPORT)) {
  throw new Error(`--transport must be one of ${Object.values(Transport).join(", ")}`);
}

/** The server's startup line: "ontoportal-sparql 0.1.0 ready on http://127.0.0.1:54321/mcp". */
const READY_URL = /ready on (http:\S+)/;

/** An HTTP server outlives its client, unlike a stdio one; stop them all on exit. */
const httpServers: ChildProcess[] = [];
process.on("exit", () => {
  for (const server of httpServers) {
    server.kill();
  }
});

const SMOKE_CLIENT = "smoke";

/** A usage event the server wrote to stderr; see src/mcp/usage.ts. */
type UsageEvent = Record<string, unknown>;

/** Events and responses travel on separate pipes; let the last events land. */
const LOG_SETTLE_MS = 300;

interface Launched {
  client: Client;
  /** The server's usage events, as they arrive. */
  events: UsageEvent[];
}

let failures = 0;

function check(name: string, passed: boolean, detail = ""): void {
  if (!passed) {
    failures += 1;
  }
  process.stdout.write(
    `  [${passed ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}\n`,
  );
}

/** Pull the first text block out of a tool or prompt result. */
function firstText(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  for (const block of content) {
    const candidate = block as { type?: string; text?: string };
    if (candidate.type === "text" && typeof candidate.text === "string") {
      return candidate.text;
    }
  }
  return "";
}

/** Nothing listens on the discard port: every query fails at once. */
const DEAD_ENDPOINT = "http://127.0.0.1:9/sparql";

/** The note the server puts on a card it could not build live. */
const SNAPSHOT_MARKER = "committed snapshot";

/** Keep a server's usage events; echo its other stderr lines as before. */
function tap(stderr: Readable, events: UsageEvent[]): Interface {
  const lines = createInterface({ input: stderr });
  lines.on("line", (line) => {
    if (line.startsWith("{")) {
      events.push(JSON.parse(line) as UsageEvent);
      return;
    }

    process.stderr.write(`${line}\n`);
  });
  return lines;
}

/** Start an HTTP server on a free port; resolve with its URL once it listens. */
function listen(env: Record<string, string>, events: UsageEvent[]): Promise<URL> {
  const child = spawn(TSX_BIN, [SERVER_ENTRY, "--transport", Transport.Http, "--port", "0"], {
    cwd: tmpdir(),
    env: { ...getDefaultEnvironment(), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  httpServers.push(child);

  return new Promise((resolve, reject) => {
    tap(child.stderr, events).on("line", (line) => {
      const url = READY_URL.exec(line)?.[1];
      if (url) {
        resolve(new URL(url));
      }
    });
    child.once("exit", (code) => reject(new Error(`server exited (${code}) before listening`)));
  });
}

/**
 * Launch from the temp dir: if the server resolves its schema card snapshot
 * relative to cwd instead of its own module, this is where it breaks.
 */
async function launch(env: Record<string, string> = {}): Promise<Launched> {
  const client = new Client({ name: SMOKE_CLIENT, version: "0.0.0" });
  const events: UsageEvent[] = [];

  if (TRANSPORT === Transport.Http) {
    await client.connect(new StreamableHTTPClientTransport(await listen(env, events)));
    return { client, events };
  }

  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", SERVER_ENTRY],
    cwd: tmpdir(),
    env,
    stderr: "pipe",
  });
  // Piped stderr is a PassThrough, there before the process starts.
  tap(transport.stderr as Readable, events);

  await client.connect(transport);
  return { client, events };
}

async function main(): Promise<void> {
  const { client, events } = await launch();

  process.stdout.write("\ndiscovery\n");

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name).sort();
  check(
    "exposes the four tools",
    ["get_schema_card", "list_terms", "resolve_ontology", "run_sparql"].every((name) =>
      names.includes(name),
    ),
    names.join(", "),
  );

  const orientationInDescription = tools
    .find((tool) => tool.name === "run_sparql")
    ?.description?.includes("omv:name");
  check("run_sparql description carries the orientation", Boolean(orientationInDescription));

  const { resources } = await client.listResources();
  check(
    "exposes both resources",
    resources.length === 2,
    resources.map((resource) => resource.uri).join(", "),
  );

  const { prompts } = await client.listPrompts();
  check("exposes the query_portal prompt", prompts.some((p) => p.name === "query_portal"));

  process.stdout.write("\nschema card (launched from a foreign cwd)\n");

  const cardResource = await client.readResource({ uri: "ontoportal://schema-card" });
  // Resource contents are a text|blob union — narrow rather than cast.
  const cardEntry = cardResource.contents[0];
  const cardText =
    cardEntry && "text" in cardEntry && typeof cardEntry.text === "string"
      ? cardEntry.text
      : "";
  // Live means the card's headline count is the endpoint's count right now.
  const counted = await client.callTool({
    name: "run_sparql",
    arguments: {
      query: `
        PREFIX meta: <http://data.bioontology.org/metadata/>
        SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { GRAPH meta:Ontology { ?s ?p ?o } }`,
    },
  });
  const ontologies = JSON.parse(firstText(counted.content)).rows?.[0]?.n ?? "?";
  check(
    "builds the card live from the endpoint",
    cardText.includes(`\n${ontologies} ontologies,`) && !cardText.includes(SNAPSHOT_MARKER),
    `endpoint has ${ontologies} ontologies; card says "${cardText.match(/\d+ ontologies/)?.[0]}"`,
  );

  const cardTool = await client.callTool({ name: "get_schema_card", arguments: {} });
  check(
    "get_schema_card returns card plus idioms",
    firstText(cardTool.content).includes("Worked examples"),
  );

  // Endpoint down: the snapshot is the only card left, and it must still
  // resolve from a foreign cwd.
  const { client: offline, events: offlineEvents } = await launch({
    PORTAL_SPARQL_URL: DEAD_ENDPOINT,
  });
  const offlineCard = firstText(
    (await offline.callTool({ name: "get_schema_card", arguments: {} })).content,
  );
  check(
    "falls back to the snapshot, flagged, despite an unrelated cwd",
    offlineCard.includes("AgroPortal SPARQL schema card") && offlineCard.includes(SNAPSHOT_MARKER),
  );

  // An outage must read as an outage: read as "no matches", it sends the
  // model off to tell the user AgroPortal lacks an ontology it has.
  const offlineLookup = await offline.callTool({
    name: "resolve_ontology",
    arguments: { term: "agrovoc" },
  });
  const offlineTerms = await offline.callTool({
    name: "list_terms",
    arguments: { kind: "category" },
  });
  check(
    "lookups report a dead endpoint as an error, not as no results",
    offlineLookup.isError === true &&
      !firstText(offlineLookup.content).includes("No ontology matches") &&
      offlineTerms.isError === true,
    firstText(offlineLookup.content).slice(0, 80),
  );

  await sleep(LOG_SETTLE_MS);
  const loggedLookup = offlineEvents.find((event) => event.tool === "resolve_ontology");
  check(
    "the usage log records the outage as an error, not a miss",
    loggedLookup?.outcome === "error",
    `outcome: ${String(loggedLookup?.outcome)}`,
  );
  await offline.close();

  process.stdout.write("\ntools against live data\n");

  const resolved = await client.callTool({
    name: "resolve_ontology",
    arguments: { term: "agrovoc" },
  });
  const resolvedText = firstText(resolved.content);
  check(
    "resolve_ontology finds AGROVOC and its content graph",
    resolvedText.includes("AGROVOC") && resolvedText.includes("/submissions/"),
  );

  const good = await client.callTool({
    name: "run_sparql",
    arguments: {
      query: `
        PREFIX meta: <http://data.bioontology.org/metadata/>
        PREFIX omv: <http://omv.ontoware.org/2005/05/ontology#>
        SELECT ?acronym WHERE {
          GRAPH meta:Ontology { ?ont a meta:Ontology ; omv:acronym ?acronym }
        } ORDER BY ?acronym LIMIT 5`,
    },
  });
  check(
    "run_sparql returns rows for a valid query",
    good.isError !== true && firstText(good.content).includes('"outcome": "ok"'),
  );

  const unscoped = await client.callTool({
    name: "run_sparql",
    arguments: { query: "SELECT ?s WHERE { ?s ?p ?o }" },
  });
  check(
    "run_sparql flags an unscoped query as an error the model must fix",
    unscoped.isError === true && firstText(unscoped.content).includes("rejected"),
  );

  const writeAttempt = await client.callTool({
    name: "run_sparql",
    arguments: { query: "DELETE WHERE { GRAPH <g> { ?s ?p ?o } }" },
  });
  check("run_sparql refuses a write", writeAttempt.isError === true);

  const hallucinated = await client.callTool({
    name: "run_sparql",
    arguments: {
      query: `
        PREFIX meta: <http://data.bioontology.org/metadata/>
        PREFIX dcterms: <http://purl.org/dc/terms/>
        SELECT ?title WHERE {
          GRAPH meta:Ontology { ?ont a meta:Ontology ; dcterms:title ?title }
        } LIMIT 5`,
    },
  });
  check(
    "the dcterms:title trap is rejected with the graph's predicates",
    hallucinated.isError === true && firstText(hallucinated.content).includes("omv:name"),
  );

  const empty = await client.callTool({
    name: "run_sparql",
    arguments: {
      query: `
        PREFIX meta: <http://data.bioontology.org/metadata/>
        PREFIX omv: <http://omv.ontoware.org/2005/05/ontology#>
        SELECT ?ont WHERE {
          GRAPH meta:Ontology { ?ont omv:acronym "NO-SUCH-ONTOLOGY" }
        } LIMIT 5`,
    },
  });
  check(
    "zero rows come back empty with repair advice",
    firstText(empty.content).includes('"outcome": "empty"') &&
      firstText(empty.content).includes("GRAPH is wrong"),
  );

  const terms = await client.callTool({
    name: "list_terms",
    arguments: { kind: "category" },
  });
  check("list_terms returns categories", firstText(terms.content).includes("Agronomy"));

  process.stdout.write("\nprompt\n");

  const prompt = await client.getPrompt({
    name: "query_portal",
    arguments: { question: "Which ontologies cover soil?" },
  });
  const promptText = firstText(prompt.messages.map((message) => message.content));
  check(
    "prompt embeds the question, the card and the prefixes",
    promptText.includes("Which ontologies cover soil?") &&
      promptText.includes("schema card") &&
      promptText.includes("PREFIX omv:"),
  );

  process.stdout.write("\nusage log\n");

  await sleep(LOG_SETTLE_MS);
  const session = events.find((event) => event.event === "session");
  const calls = events.filter((event) => event.event === "tool");
  check(
    "logs the client as it connects",
    session?.client === SMOKE_CLIENT,
    JSON.stringify(session),
  );

  // Over HTTP this only holds if the client sent back the session id it was given.
  check(
    "logs every tool call under that client's session",
    calls.length > 0 && calls.every((call) => call.session === session?.session),
    `${calls.length} calls`,
  );

  const outcomes = new Set(
    calls.filter((call) => call.tool === "run_sparql").map((call) => call.outcome),
  );
  check(
    "logs how each run_sparql call ended",
    ["ok", "empty", "rejected"].every((outcome) => outcomes.has(outcome)),
    [...outcomes].join(", "),
  );

  await client.close();

  process.stdout.write(failures === 0 ? "\nall passed\n" : `\n${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
