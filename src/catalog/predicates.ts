/**
 * Rejects a query that reads a predicate from a metadata graph that never
 * uses it.
 *
 * Such a pattern matches nothing. Required, it empties the result. Under
 * OPTIONAL it leaves a column blank, and under NOT EXISTS it filters nothing:
 * both return plausible, wrong answers with no error. The schema card profiles
 * every predicate of every metadata graph, so the check is a lookup, and the
 * rejection can say where the predicate does live:
 *
 *   GRAPH meta:Ontology { ?o omv:description ?d }
 *     → omv:description is not in meta:Ontology; it is in meta:OntologySubmission
 *
 * Content graphs, GRAPH ?g and patterns outside GRAPH are not checked: the
 * card does not profile them.
 */

import { graphPredicates } from "../sparql/patterns.js";
import type { GraphProfile } from "./introspect.js";
import { PREFIXES, compact } from "./vocabulary.js";

function code(iri: string): string {
  return `\`${compact(iri)}\``;
}

/** Where a predicate does occur, for the repair hint. */
function homesOf(predicate: string, graphs: GraphProfile[]): string {
  const homes = graphs
    .filter((graph) => graph.predicates.some((fact) => fact.predicate === predicate))
    .map((graph) => code(graph.iri));

  if (homes.length === 0) {
    return "no metadata graph uses it";
  }
  return `it is in ${homes.join(", ")}`;
}

/**
 * Repair advice when the query reads a predicate its graph never uses, null
 * otherwise. A query that does not parse passes: the endpoint reports it.
 */
export function misplacedPredicates(query: string, graphs: GraphProfile[]): string | null {
  const uses = graphPredicates(query, PREFIXES);
  if (!uses) {
    return null;
  }

  // Graph IRI → its predicates. Graphs the card does not profile stay out.
  const known = new Map(
    graphs.map((graph) => [graph.iri, new Set(graph.predicates.map((fact) => fact.predicate))]),
  );

  // One line per distinct (graph, predicate), in query order.
  const misses = new Map<string, { graph: string; predicate: string }>();
  for (const use of uses) {
    const predicates = known.get(use.graph);
    if (!predicates || predicates.has(use.predicate)) {
      continue;
    }
    misses.set(`${use.graph} ${use.predicate}`, use);
  }

  if (misses.size === 0) {
    return null;
  }

  const lines = [...misses.values()].map(
    (miss) =>
      `- ${code(miss.predicate)} in GRAPH ${code(miss.graph)}: ${homesOf(miss.predicate, graphs)}.`,
  );

  // The full list for each graph at fault, most used first, so the fix needs no other call.
  const lists = [...new Set([...misses.values()].map((miss) => miss.graph))].map((iri) => {
    const graph = graphs.find((candidate) => candidate.iri === iri);
    const predicates = (graph?.predicates ?? []).map((fact) => code(fact.predicate));
    return `Predicates in ${code(iri)}: ${predicates.join(", ")}`;
  });

  return [
    "Not run: these predicates never occur in the graph the query reads them " +
      "from, so their patterns match nothing. Required, that means zero rows; " +
      "under OPTIONAL or NOT EXISTS, a silently wrong answer.",
    ...lines,
    "",
    ...lists,
  ].join("\n");
}
