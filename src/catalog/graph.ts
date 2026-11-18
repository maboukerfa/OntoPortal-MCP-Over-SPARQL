/**
 * A class in context: its ancestors up to the roots, and the terms it points
 * to through a property, with their own ancestors. What the portal's Graph
 * tab draws, read from the content graph.
 *
 *        entity                      ← no parent: a root
 *       ╱      ╲
 *   continuant  occurrent
 *       │          │
 *    organism   process
 *       │          │
 *   heterotroph ──capable of──▶ heterotrophy
 *       ▲
 *     the class asked about
 *
 * OntoPortal flattens an OWL restriction ("capable of some heterotrophy") into
 * a plain triple when it parses, so a relation is a triple to another term,
 * not a blank node.
 *
 * Every query starts from the class and its relation targets as constant
 * subjects. Virtuoso does not anchor a `*` path on a VALUES-bound start (it
 * returned the whole graph's pairs), and a VALUES list of every node outgrows
 * the endpoint's URL limit (414 at 12 KB).
 */

import { QueryOutcome, SparqlEndpoint, type SparqlResult } from "../sparql/endpoint.js";
import type { Catalog } from "./catalog.js";
import type { PortalLinks } from "./links.js";
import { PREFIXES } from "./vocabulary.js";

/** Relations from the class, each one a seed: the ancestor queries grow with them. */
const MAX_RELATIONS = 15;
/** Is-a edges. Past this the picture is a hairball, not an answer. */
const MAX_EDGES = 200;

/** Every class's implicit parent: an edge to it says nothing. */
const OWL_THING = "owl:Thing";

/** What a class can point to and still be drawn as a node. */
const TERM_TYPES = ["owl:Class", "skos:Concept"];

/** Hierarchy and bookkeeping, not relations. narrower would draw the children. */
const NOT_RELATIONS = [
  "rdf:type",
  "rdfs:subClassOf",
  "skos:broader",
  "skos:narrower",
  "skos:hasTopConcept",
  "skos:topConceptOf",
];

/** OntoPortal's own annotations (prefLabel, mappingSameURI...) live here. */
const PORTAL_NS = "http://data.bioontology.org/";

/** OWL and SKOS hierarchies, one path for both formats. */
const PARENT = "(rdfs:subClassOf|skos:broader)";
const LABEL = "skos:prefLabel|rdfs:label";
/** IAO_0000115 is OBO's "definition". */
const DEFINITION = "<http://purl.obolibrary.org/obo/IAO_0000115>|skos:definition";

/** English or untagged first; many AgroPortal terms carry only French. */
const PREFERRED_LANGUAGES = '"en", ""';

/** Characters that cannot sit inside <...> in a query. */
const UNSAFE_IRI = /[\s<>"{}|^`\\]/;

const PROLOGUE = ["rdf", "rdfs", "owl", "skos"]
  .map((short) => `PREFIX ${short}: <${PREFIXES[short]}>`)
  .join("\n");

export enum EdgeKind {
  /** Child to parent: rdfs:subClassOf or skos:broader. */
  IsA = "is-a",
  /** The class to another term, through any other property. */
  Relation = "relation",
}

export interface GraphNode {
  iri: string;
  label: string;
  definition?: string;
  /** The term's page on the portal, when the portal lists it. */
  portalUrl?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  /** The property, for a relation. */
  property?: string;
  /** Its label, for a relation. */
  label?: string;
}

export interface ClassGraph {
  ontology: string;
  /** The class asked about. */
  focus: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Relations or ancestors were cut at their cap. */
  truncated: boolean;
}

export enum GraphOutcome {
  Ok = "ok",
  UnknownOntology = "unknown-ontology",
  /** The ontology's current content has no such term. */
  UnknownClass = "unknown-class",
}

export type GraphResult =
  | { outcome: GraphOutcome.Ok; graph: ClassGraph }
  | { outcome: GraphOutcome.UnknownOntology }
  | { outcome: GraphOutcome.UnknownClass };

interface Relation {
  property: string;
  target: string;
  label?: string;
}

interface Details {
  types: string[];
  label?: string;
  definition?: string;
}

/** Same contract as the catalog's lookups: an outage throws, it is not "no such class". */
function rowsOf(result: SparqlResult): Record<string, string>[] {
  if (result.outcome === QueryOutcome.Empty) {
    return [];
  }

  if (result.outcome !== QueryOutcome.Ok) {
    throw new Error(
      `The endpoint failed this lookup (${result.outcome}: ${result.message}). ` +
        `This is not an empty result: retry once, then tell the user the lookup failed.`,
    );
  }
  return SparqlEndpoint.plain(result.rows);
}

/** The IRI's last segment: a label for a term that has none. */
function localName(iri: string): string {
  return iri.split(/[/#]/).filter(Boolean).pop() ?? iri;
}

/** `{ <a> path* ?n } UNION { <b> path* ?n }`: every node reachable from a seed, seeds included. */
function reachable(seeds: string[], variable: string): string {
  return seeds.map((seed) => `{ <${seed}> ${PARENT}* ?${variable} }`).join("\n    UNION\n    ");
}

export class ClassGraphService {
  constructor(
    private readonly endpoint: SparqlEndpoint,
    private readonly catalog: Catalog,
    private readonly links: PortalLinks,
  ) {}

  async build(acronym: string, iri: string): Promise<GraphResult> {
    if (UNSAFE_IRI.test(iri)) {
      return { outcome: GraphOutcome.UnknownClass };
    }

    const submission = await this.catalog.latestSubmission(acronym);
    if (!submission) {
      return { outcome: GraphOutcome.UnknownOntology };
    }
    const graph = submission.contentGraph;

    // Relations first: their targets seed the ancestor walk too.
    const related = await this.relations(graph, iri);
    const relations = related.slice(0, MAX_RELATIONS);
    const seeds = [iri, ...new Set(relations.map((relation) => relation.target))];

    const parents = await this.parents(graph, seeds);
    const isA = parents.slice(0, MAX_EDGES);

    const details = await this.details(graph, seeds);
    if (!details.get(iri)?.types.length) {
      return { outcome: GraphOutcome.UnknownClass };
    }

    // Draw what the edges reach, never more: details covers every ancestor, even past the cap.
    const drawn = new Set([...seeds, ...isA.flatMap((edge) => [edge.from, edge.to])]);
    const pages = await this.links.forTyped(
      graph,
      [...drawn].map((node) => ({ iri: node, types: details.get(node)?.types ?? [] })),
    );

    const nodes = [...drawn].map((node) => {
      const known = details.get(node);
      return {
        iri: node,
        label: known?.label ?? localName(node),
        definition: known?.definition,
        portalUrl: pages.get(node),
      };
    });

    const edges: GraphEdge[] = [
      ...isA,
      ...relations.map((relation) => ({
        from: iri,
        to: relation.target,
        kind: EdgeKind.Relation,
        property: relation.property,
        label: relation.label ?? localName(relation.property),
      })),
    ];

    return {
      outcome: GraphOutcome.Ok,
      graph: {
        ontology: acronym,
        focus: iri,
        nodes,
        edges,
        truncated: related.length > MAX_RELATIONS || parents.length > MAX_EDGES,
      },
    };
  }

  /** Terms the class points to through a property other than the hierarchy's. */
  private async relations(graph: string, iri: string): Promise<Relation[]> {
    const result = await this.endpoint.select(`
      ${PROLOGUE}
      SELECT ?property ?target (SAMPLE(?name) AS ?label) WHERE {
        GRAPH <${graph}> {
          <${iri}> ?property ?target .
          ?target a ?type .
          FILTER (?type IN (${TERM_TYPES.join(", ")}))
          FILTER (?target != <${iri}>)
          FILTER (?property NOT IN (${NOT_RELATIONS.join(", ")}))
          FILTER (!STRSTARTS(STR(?property), "${PORTAL_NS}"))
          OPTIONAL {
            ?property ${LABEL} ?name .
            FILTER (LANG(?name) IN (${PREFERRED_LANGUAGES}))
          }
        }
      } GROUP BY ?property ?target LIMIT ${MAX_RELATIONS + 1}
    `);

    return rowsOf(result).map((row) => ({
      property: row.property ?? "",
      target: row.target ?? "",
      label: row.label,
    }));
  }

  /** Child-to-parent edges among everything above the seeds. */
  private async parents(graph: string, seeds: string[]): Promise<GraphEdge[]> {
    const result = await this.endpoint.select(`
      ${PROLOGUE}
      SELECT DISTINCT ?child ?parent WHERE {
        GRAPH <${graph}> {
          ${reachable(seeds, "child")}
          ?child ${PARENT} ?parent .
          FILTER (isIRI(?parent) && ?parent != ${OWL_THING})
        }
      } LIMIT ${MAX_EDGES + 1}
    `);

    return rowsOf(result).map((row) => ({
      from: row.child ?? "",
      to: row.parent ?? "",
      kind: EdgeKind.IsA,
    }));
  }

  /**
   * Types, label and definition of the seeds and their ancestors. Grouped,
   * because AGROVOC carries 40 labels a concept and the rows would multiply.
   * The class asked about sorts first, so the cap never drops it.
   */
  private async details(graph: string, seeds: string[]): Promise<Map<string, Details>> {
    const result = await this.endpoint.select(`
      ${PROLOGUE}
      SELECT ?n (GROUP_CONCAT(DISTINCT STR(?type); separator=" ") AS ?types)
             (SAMPLE(?preferred) AS ?label) (SAMPLE(?other) AS ?fallback)
             (SAMPLE(?meaning) AS ?definition) WHERE {
        GRAPH <${graph}> {
          ${reachable(seeds, "n")}
          OPTIONAL { ?n a ?type }
          OPTIONAL { ?n ${LABEL} ?preferred . FILTER (LANG(?preferred) IN (${PREFERRED_LANGUAGES})) }
          OPTIONAL { ?n ${LABEL} ?other }
          OPTIONAL {
            ?n ${DEFINITION} ?meaning .
            FILTER (isLiteral(?meaning) && LANG(?meaning) IN (${PREFERRED_LANGUAGES}))
          }
        }
      } GROUP BY ?n ORDER BY (IF(?n = <${seeds[0]}>, 0, 1)) LIMIT ${MAX_EDGES + seeds.length + 1}
    `);

    return new Map(
      rowsOf(result).map((row) => [
        row.n ?? "",
        {
          types: (row.types ?? "").split(" ").filter(Boolean),
          label: row.label ?? row.fallback,
          definition: row.definition,
        },
      ]),
    );
  }
}
