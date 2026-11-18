#!/usr/bin/env node
/**
 * MCP server exposing an OntoPortal deployment's SPARQL endpoint.
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
import { FairnessOutcome, FairnessService, summarize } from "../catalog/fairness.js";
import { ClassGraphService, GraphOutcome } from "../catalog/graph.js";
import { PortalLinks } from "../catalog/links.js";
import { portalFromEnv } from "../catalog/portal.js";
import { prefixBlock } from "../catalog/vocabulary.js";
import { OfaireClient } from "../fairness/ofaire.js";
import { SparqlEndpoint } from "../sparql/endpoint.js";
import { EXAMPLES, linkRule, orientation } from "./guidance.js";
import { serveHttp } from "./http.js";
import { findSchemaCard } from "./paths.js";
import { logged, watchSession } from "./usage.js";
import { loadView } from "./views.js";

const SERVER_NAME = "ontoportal-sparql";
const SERVER_VERSION = "0.1.0";

enum ToolName {
  GetSchemaCard = "get_schema_card",
  ResolveOntology = "resolve_ontology",
  RunSparql = "run_sparql",
  ListTerms = "list_terms",
  ShowClassGraph = "show_class_graph",
  ShowFairScore = "show_fair_score",
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

const CARD_URI = "ontoportal://schema-card";
const EXAMPLES_URI = "ontoportal://examples";

const MARKDOWN = "text/markdown";

/**
 * MCP Apps: a tool names an HTML view by its ui:// resource, and a host that
 * supports the extension renders the tool's result in it, in a sandboxed
 * iframe. Other hosts ignore the metadata and show the text.
 */
const MCP_APP = "text/html;profile=mcp-app";
/** The pre-GA spelling of _meta.ui.resourceUri, which some hosts still read. The SDK sets both. */
const LEGACY_RESOURCE_URI_KEY = "ui/resourceUri";

interface View {
  /** The resource's name, and its file under ui/ with .html. */
  name: string;
  uri: string;
  title: string;
  tool: ToolName;
}

const CLASS_GRAPH_VIEW: View = {
  name: "class-graph",
  uri: "ui://ontoportal-sparql/class-graph.html",
  title: "Class graph",
  tool: ToolName.ShowClassGraph,
};

const FAIR_SCORE_VIEW: View = {
  name: "fair-score",
  uri: "ui://ontoportal-sparql/fair-score.html",
  title: "FAIR score",
  tool: ToolName.ShowFairScore,
};

/** A tool's _meta naming its view, in both spellings. */
function viewMeta(view: View) {
  return { ui: { resourceUri: view.uri }, [LEGACY_RESOURCE_URI_KEY]: view.uri };
}

function registerView(server: McpServer, view: View): void {
  server.registerResource(
    view.name,
    view.uri,
    {
      title: view.title,
      description: `Interactive view of ${view.tool}'s result, for hosts that render MCP Apps.`,
      mimeType: MCP_APP,
    },
    async () => ({
      contents: [
        {
          uri: view.uri,
          mimeType: MCP_APP,
          text: await loadView(`${view.name}.html`),
          _meta: { ui: { prefersBorder: true } },
        },
      ],
    }),
  );
}

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
  graphs: ClassGraphService;
  fairness: FairnessService;
  /** The portal's display name, as the model reads it in descriptions. */
  portal: string;
}

function buildServices(): Services {
  const portal = portalFromEnv();
  const endpoint = new SparqlEndpoint({ url: portal.sparqlUrl });
  const cards = new CardService(endpoint, portal.name, findSchemaCard);
  const links = new PortalLinks(endpoint, portal.uiUrl);
  const catalog = new Catalog(endpoint, links);

  return {
    catalog,
    queries: new QueryService(endpoint, cards, links),
    cards,
    graphs: new ClassGraphService(endpoint, catalog, links),
    fairness: new FairnessService(catalog, new OfaireClient({ url: portal.fairnessUrl })),
    portal: portal.name,
  };
}

function buildServer(
  { catalog, queries, cards, graphs, fairness, portal }: Services,
  session: string,
): McpServer {
  // Hosts that honour server instructions put them in the system prompt; the
  // tool descriptions repeat the rule for those that do not.
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: linkRule(portal) },
  );

  // --- Resources: for hosts that can attach context without a tool call ------

  server.registerResource(
    "schema-card",
    CARD_URI,
    {
      title: `${portal} schema card`,
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
      title: `${portal} query idioms`,
      description: "Worked SPARQL examples, each verified against the endpoint.",
      mimeType: MARKDOWN,
    },
    async () => ({
      contents: [{ uri: EXAMPLES_URI, mimeType: MARKDOWN, text: EXAMPLES }],
    }),
  );

  registerView(server, CLASS_GRAPH_VIEW);
  registerView(server, FAIR_SCORE_VIEW);

  // --- Tools ----------------------------------------------------------------

  server.registerTool(
    ToolName.GetSchemaCard,
    {
      title: `Get the ${portal} schema`,
      description:
        `Return the full ${portal} metadata schema: 13 named graphs — ontologies, ` +
        "submissions, metrics, agents, identifiers, projects, contacts, reviews, " +
        "mapping processes, mapped term pairs, mapping counts, categories, groups — " +
        "each with every predicate and its usage " +
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
        "Resolve an ontology name or acronym to its real IRI, its portal page, and " +
        "the named graph holding its current content. Call this before writing any query that " +
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
      title: `Run SPARQL against ${portal}`,
      description:
        `Execute a read-only SPARQL query against the ${portal} endpoint and ` +
        "return the rows, with the portal page of each ontology, category, group, " +
        "project and term in them. Rejects writes, unscoped patterns and predicates a " +
        "metadata graph never uses, caps result size, " +
        "and reports errors, timeouts and empty results with advice on how to " +
        "repair the query — read that advice and call again rather than giving up." +
        "\n\n" +
        orientation(portal),
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
        `List ${portal}'s subject categories or ontology groups with their IRIs and portal pages. ` +
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

  server.registerTool(
    ToolName.ShowClassGraph,
    {
      title: "Show a class in its hierarchy",
      description:
        "Draw a class or concept of one ontology in context, as the portal's Graph " +
        "tab does: its ancestors up to the roots, and the terms it points to " +
        "through other properties (e.g. 'capable of'), with their ancestors. Hosts " +
        "that render MCP Apps show an interactive graph; the same nodes and edges " +
        "come back as JSON, each node with its portal page. Use it when the user " +
        "asks to see, show or visualise a class, or where it sits. Get the IRI from " +
        "a query on the content graph resolve_ontology returns, never by guessing.",
      inputSchema: {
        ontology: z.string().min(1).describe("The ontology's acronym, e.g. 'SFWO'"),
        iri: z
          .string()
          .min(1)
          .describe("The class or concept IRI, e.g. 'http://purl.obolibrary.org/obo/ECOCORE_00000010'"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: viewMeta(CLASS_GRAPH_VIEW),
    },
    logged(session, ToolName.ShowClassGraph, async ({ ontology, iri }, note) => {
      const result = await graphs.build(ontology, iri);
      note({ outcome: result.outcome });

      if (result.outcome === GraphOutcome.UnknownOntology) {
        return text(`No ontology has the acronym "${ontology}". Find it with resolve_ontology.`, true);
      }

      if (result.outcome === GraphOutcome.UnknownClass) {
        return text(
          `${ontology}'s current submission has no term <${iri}>. Find its IRI with ` +
            "run_sparql on the content graph resolve_ontology returns.",
          true,
        );
      }

      const { graph } = result;
      note({ rows: graph.nodes.length, truncated: graph.truncated });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(graph, null, 2) }],
        structuredContent: { ...graph },
      };
    }),
  );

  server.registerTool(
    ToolName.ShowFairScore,
    {
      title: "Show an ontology's FAIR score",
      description:
        `Assess how FAIR (Findable, Accessible, Interoperable, Reusable) an ontology is, ` +
        `with O'FAIRe on its ${portal} metadata record, as the FAIR score section of ` +
        "its page shows: the total, each category and principle, and every question it " +
        "misses with the metadata property that question checks, which is what a " +
        "curator fills to raise the score. Hosts that render MCP Apps show radar and " +
        "bar charts. Use it for questions about an ontology's FAIRness, metadata " +
        "quality or score.",
      inputSchema: {
        ontology: z.string().min(1).describe("The ontology's acronym, e.g. 'WEBVOC'; case does not matter"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      _meta: viewMeta(FAIR_SCORE_VIEW),
    },
    logged(session, ToolName.ShowFairScore, async ({ ontology }, note) => {
      const result = await fairness.assess(ontology);
      note({ outcome: result.outcome });

      if (result.outcome === FairnessOutcome.UnknownOntology) {
        return text(`No ontology has the acronym "${ontology}". Find it with resolve_ontology.`, true);
      }

      if (result.outcome === FairnessOutcome.Unavailable) {
        return text(
          `O'FAIRe did not assess ${ontology}: ${result.message}. Retry once, then tell ` +
            "the user the assessment service is unreachable.",
          true,
        );
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(summarize(result.report), null, 2) }],
        structuredContent: { ...result.report },
      };
    }),
  );

  // --- Prompt: a ready-made framing for hosts that surface slash commands ----

  server.registerPrompt(
    "query_portal",
    {
      title: `Ask ${portal} a question`,
      description:
        `Answer a question about ${portal}'s ontologies by querying the SPARQL ` +
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
              `Answer this question about ${portal} by querying its SPARQL endpoint.`,
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
              `- ${portal} is multilingual. Before saying something is not available,`,
              "  retry with the term translated and without any LANG() filter.",
              "- Answer in prose with the figures you retrieved, then show the query.",
              `- ${linkRule(portal)}`,
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
