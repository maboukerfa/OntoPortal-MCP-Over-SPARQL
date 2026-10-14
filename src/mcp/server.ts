#!/usr/bin/env node
/**
 * MCP server exposing AgroPortal's SPARQL endpoint.
 *
 * The shift from the standalone agent: the host owns the model and the loop.
 * There is no Anthropic SDK here and no orchestration — the repair loop happens
 * because `run_sparql` returns actionable advice on failure and the host model
 * calls it again. Everything below this file is unchanged from the agent
 * version, which is the point: the driver, guards, grounding and execution
 * services never knew what was driving them.
 *
 *     host model  ──calls──▶  tools (this file)
 *                                 │
 *                    Catalog / QueryService / guards
 *                                 │
 *                          SparqlEndpoint  ──HTTP──▶  Virtuoso
 *
 * CAUTION: under stdio, stdout is the MCP transport. Anything written there that
 * is not a protocol frame corrupts the session. Log to stderr, never console.log.
 */

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";

import { CardService } from "../catalog/card.js";
import { Catalog } from "../catalog/catalog.js";
import { QueryService } from "../catalog/execution.js";
import { AGROPORTAL_ENDPOINT, prefixBlock } from "../catalog/vocabulary.js";
import { SparqlEndpoint } from "../sparql/endpoint.js";
import { EXAMPLES, ORIENTATION } from "./guidance.js";
import { serveHttp } from "./http.js";
import { findSchemaCard } from "./paths.js";
import { logged, watchSession } from "./usage.js";

const SERVER_NAME = "agroportal-sparql";
const SERVER_VERSION = "0.1.0";

enum ToolName {
  GetSchemaCard = "get_schema_card",
  ResolveOntology = "resolve_ontology",
  RunSparql = "run_sparql",
  ListTerms = "list_terms",
}

enum Transport {
  /** The host launches this process and talks over its stdin and stdout. */
  Stdio = "stdio",
  /** This process listens; hosts connect to it. */
  Http = "http",
}

/** Loopback: reachable from the network only when asked. */
const DEFAULT_HOST = "127.0.0.1";
/** Not 3000, which the OntoPortal UI takes in development. */
const DEFAULT_PORT = 8080;

const CARD_URI = "agroportal://schema-card";
const EXAMPLES_URI = "agroportal://examples";

const MARKDOWN = "text/markdown";

/** Outcomes the host model should treat as "fix it and call me again". */
const REPAIRABLE = new Set(["rejected", "invalid", "timeout", "unavailable"]);

function text(body: string, isError = false) {
  return { content: [{ type: "text" as const, text: body }], isError };
}

/** What the tools run on. One per process, so every HTTP request shares the card cache. */
interface Services {
  catalog: Catalog;
  queries: QueryService;
  cards: CardService;
}

function buildServices(): Services {
  const endpoint = new SparqlEndpoint({
    url: process.env.AGROPORTAL_SPARQL_URL ?? AGROPORTAL_ENDPOINT,
  });

  return {
    catalog: new Catalog(endpoint),
    queries: new QueryService(endpoint),
    cards: new CardService(endpoint, findSchemaCard),
  };
}

function buildServer({ catalog, queries, cards }: Services, session: string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // --- Resources: for hosts that can attach context without a tool call ------

  server.registerResource(
    "schema-card",
    CARD_URI,
    {
      title: "AgroPortal schema card",
      description:
        "Generated from the live endpoint: every metadata predicate with usage " +
        "counts, the named-graph layout, categories, groups, and query idioms.",
      mimeType: MARKDOWN,
    },
    async () => ({
      contents: [{ uri: CARD_URI, mimeType: MARKDOWN, text: await cards.current() }],
    }),
  );

  server.registerResource(
    "examples",
    EXAMPLES_URI,
    {
      title: "AgroPortal query idioms",
      description: "Worked SPARQL examples, each verified against the endpoint.",
      mimeType: MARKDOWN,
    },
    async () => ({
      contents: [{ uri: EXAMPLES_URI, mimeType: MARKDOWN, text: EXAMPLES }],
    }),
  );

  // --- Tools ----------------------------------------------------------------

  server.registerTool(
    ToolName.GetSchemaCard,
    {
      title: "Get the AgroPortal schema",
      description:
        "Return the full AgroPortal metadata schema: 11 named graphs — ontologies, " +
        "submissions, metrics, agents, identifiers, projects, contacts, reviews, " +
        "mappings, categories, groups — each with every predicate and its usage " +
        "count, plus worked query idioms. Call this once before writing your first " +
        "SPARQL query in a conversation. Within those graphs the predicate list is " +
        "complete: if something is not in it, it is not in the data. It does not " +
        "describe the per-submission content graphs, which are plain SKOS/OWL. " +
        "Built from the live endpoint, so its counts are current.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    logged(session, ToolName.GetSchemaCard, async () =>
      text([await cards.current(), EXAMPLES].join("\n---\n\n")),
    ),
  );

  server.registerTool(
    ToolName.ResolveOntology,
    {
      title: "Resolve an ontology to its IRIs",
      description:
        "Resolve an ontology name or acronym to its real IRI and the named graph " +
        "holding its current content. Call this before writing any query that " +
        "mentions a specific ontology — never construct these IRIs by guessing, " +
        "and never assume a submission number.",
      inputSchema: {
        term: z
          .string()
          .min(1)
          .describe("Ontology acronym or name fragment, e.g. 'AGROVOC' or 'crop'"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    logged(session, ToolName.ResolveOntology, async ({ term }, note) => {
      const resolved = await catalog.resolve(term);
      note({ rows: resolved.matches.length });

      if (resolved.matches.length === 0) {
        return text(
          `No ontology matches "${term}". Try a shorter fragment, the term in ` +
            `another language (many names are French), or list candidates with ` +
            `a query over the meta:Ontology graph.`,
        );
      }

      return text(JSON.stringify(resolved, null, 2));
    }),
  );

  server.registerTool(
    ToolName.RunSparql,
    {
      title: "Run SPARQL against AgroPortal",
      description:
        "Execute a read-only SPARQL query against the AgroPortal endpoint and " +
        "return the rows. Rejects writes and unscoped patterns, caps result size, " +
        "and reports errors, timeouts and empty results with advice on how to " +
        "repair the query — read that advice and call again rather than giving up." +
        "\n\n" +
        ORIENTATION,
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe("A complete SPARQL query including its PREFIX lines"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    logged(session, ToolName.RunSparql, async ({ query }, note) => {
      const report = await queries.run(query);
      note({ outcome: report.outcome, rows: report.rowCount, truncated: report.truncated });
      const failed = REPAIRABLE.has(String(report.outcome));
      return text(JSON.stringify(report, null, 2), failed);
    }),
  );

  server.registerTool(
    ToolName.ListTerms,
    {
      title: "List categories or groups",
      description:
        "List AgroPortal's subject categories or ontology groups with their IRIs. " +
        "Both are small closed vocabularies used to filter ontologies; category " +
        "and group values are IRIs, not strings.",
      inputSchema: {
        kind: z.enum(["category", "group"]).describe("Which vocabulary to list"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    logged(session, ToolName.ListTerms, async ({ kind }) =>
      text(JSON.stringify(await catalog.listTerms(kind), null, 2)),
    ),
  );

  // --- Prompt: a ready-made framing for hosts that surface slash commands ----

  server.registerPrompt(
    "query_agroportal",
    {
      title: "Ask AgroPortal a question",
      description:
        "Answer a question about AgroPortal's ontologies by querying the SPARQL " +
        "endpoint, with the schema and idioms preloaded.",
      argsSchema: {
        question: z.string().describe("The question to answer"),
      },
    },
    async ({ question }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Answer this question about AgroPortal by querying its SPARQL endpoint.",
              "",
              `Question: ${question}`,
              "",
              "Rules:",
              "- Resolve ontology names to IRIs with resolve_ontology before querying.",
              "- Use only predicates from the schema below.",
              "- Never state a number you did not get back from the endpoint. If a",
              "  query fails and you cannot repair it, say so and show what you tried.",
              "- Zero rows nearly always means the query was wrong, not that the",
              "  answer is zero. Check the graph and the predicate before concluding.",
              "- AgroPortal is multilingual. Before saying something is not available,",
              "  retry with the term translated and without any LANG() filter.",
              "- Answer in prose with the figures you retrieved, then show the query.",
              "",
              "Prefixes:",
              "```sparql",
              prefixBlock(),
              "```",
              "",
              await cards.current(),
              "",
              EXAMPLES,
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}

/** Serve one client's session over `transport`: a stdio process, or one HTTP request. */
async function open(
  services: Services,
  transport: McpTransport,
  session: string,
): Promise<McpServer> {
  watchSession(transport, session);

  const server = buildServer(services, session);
  await server.connect(transport);
  return server;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      transport: { type: "string", default: Transport.Stdio },
      host: { type: "string", default: DEFAULT_HOST },
      port: { type: "string", default: String(DEFAULT_PORT) },
    },
  });

  const transport = values.transport as Transport;
  if (!Object.values(Transport).includes(transport)) {
    throw new Error(`--transport must be one of ${Object.values(Transport).join(", ")}`);
  }

  const services = buildServices();

  if (transport === Transport.Http) {
    const url = await serveHttp((channel, session) => open(services, channel, session), {
      host: values.host,
      port: Number(values.port),
    });
    process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready on ${url}\n`);
    return;
  }

  // A stdio process serves one client: one session.
  await open(services, new StdioServerTransport(), randomUUID());
  process.stderr.write(`${SERVER_NAME} ${SERVER_VERSION} ready on stdio\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${SERVER_NAME} failed to start: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
