/**
 * Regenerate the schema card snapshot from the live endpoint.
 *
 * The server builds the card live (src/catalog/card.ts); this snapshot is what
 * it serves when the endpoint does not answer. Run this now and then (weekly
 * is plenty — AgroPortal ingests submissions continuously but its metadata
 * *shape* barely moves). Commit the result: the diff is a readable record of
 * what changed in the portal's metadata.
 *
 *   npm run schema:gen
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { buildSchemaCard, emptyGraphs, renderSchemaCard } from "../src/catalog/introspect.js";
import { portalFromEnv } from "../src/catalog/portal.js";
import { SparqlEndpoint } from "../src/sparql/endpoint.js";

const OUTPUT = resolve("schema/schema-card.md");

/** Introspection runs a dozen aggregate queries; give them room. */
const INTROSPECTION_TIMEOUT_MS = 120_000;

async function main(): Promise<void> {
  const portal = portalFromEnv();
  const endpoint = new SparqlEndpoint({
    url: portal.sparqlUrl,
    timeoutMs: INTROSPECTION_TIMEOUT_MS,
  });

  process.stderr.write("introspecting endpoint...\n");
  const card = await buildSchemaCard(endpoint);

  // An empty graph means that profile's queries all failed. Writing the card
  // anyway would silently replace good content with a heading and no table,
  // and the model would read the absence as "this graph has no predicates".
  const empty = emptyGraphs(card);
  if (empty.length > 0) {
    throw new Error(
      `introspection returned no predicates for ${empty.join(", ")}; refusing to overwrite the card`,
    );
  }

  mkdirSync(dirname(OUTPUT), { recursive: true });
  writeFileSync(OUTPUT, renderSchemaCard(card, portal.name), "utf8");

  const totalPredicates = card.graphs.reduce(
    (sum, graph) => sum + graph.predicates.length,
    0,
  );

  process.stderr.write(
    `wrote ${OUTPUT}\n` +
      `  ${card.ontologyCount} ontologies, ${card.submissionCount} submissions\n` +
      `  ${card.graphs.length} graphs profiled, ${totalPredicates} predicates total\n` +
      `  ${card.categories.length} categories, ${card.groups.length} groups\n`,
  );

  for (const graph of card.graphs) {
    process.stderr.write(
      `    ${graph.label.padEnd(20)} ${String(graph.subjects).padStart(7)} subjects  ` +
        `${graph.predicates.length} predicates\n`,
    );
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
