/**
 * Reads which predicates a query matches inside which named graph.
 *
 * The only module that sees the SPARQL parser's syntax tree. Everything above
 * works with (graph, predicate) pairs:
 *
 *   GRAPH meta:Ontology { ?o omv:name ?n  OPTIONAL { ?o omv:x ?x } }
 *     → { graph: ".../metadata/Ontology", predicate: "...ontology#name" }
 *       { graph: ".../metadata/Ontology", predicate: "...ontology#x" }
 *
 * The tree is walked generically, by node type, rather than through the
 * parser's typed visitors: a triple nested anywhere (OPTIONAL, UNION, NOT
 * EXISTS, a subquery, a [ ] blank node) is found without listing every node
 * kind that can hold one.
 */

import { Parser } from "@traqula/parser-sparql-1-1";

export interface GraphPredicate {
  graph: string;
  predicate: string;
}

type Node = Record<string, unknown>;

/**
 * Path operators under which every IRI must match: a/b, ^a, a+. Under a|b,
 * a*, a? or !a, an IRI can match nothing and the path still succeed.
 */
const BINDING_PATHS = new Set(["/", "^", "+"]);

/**
 * Built once: the parser computes its grammar optimisations on construction.
 * Validation is off so an undeclared prefix still parses; Virtuoso predefines
 * many, and reporting the rest is its job.
 */
const parser = new Parser({ defaultContext: { skipValidation: true } });

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null;
}

/** A named node's full IRI, or null for a variable or an unknown prefix. */
function iriOf(term: unknown, prefixes: Record<string, string>): string | null {
  if (!isNode(term) || term.subType !== "namedNode" || typeof term.value !== "string") {
    return null;
  }

  if (typeof term.prefix !== "string") {
    return term.value;
  }

  const namespace = prefixes[term.prefix];
  return namespace === undefined ? null : `${namespace}${term.value}`;
}

/** The query's own PREFIX lines, over the defaults. */
function prefixesOf(ast: Node, defaults: Record<string, string>): Record<string, string> {
  const prefixes = { ...defaults };
  const context = Array.isArray(ast.context) ? ast.context : [];

  for (const definition of context) {
    if (!isNode(definition) || definition.subType !== "prefix" || typeof definition.key !== "string") {
      continue;
    }

    const namespace = iriOf(definition.value, {});
    if (namespace) {
      prefixes[definition.key] = namespace;
    }
  }
  return prefixes;
}

/** The IRIs a predicate position must match: one for a plain IRI, each link of a binding path. */
function pathIris(predicate: unknown, prefixes: Record<string, string>): string[] {
  if (!isNode(predicate)) {
    return [];
  }

  if (predicate.type === "term") {
    const iri = iriOf(predicate, prefixes);
    return iri ? [iri] : [];
  }

  if (predicate.type !== "path" || !BINDING_PATHS.has(String(predicate.subType))) {
    return [];
  }

  const items = Array.isArray(predicate.items) ? predicate.items : [];
  return items.flatMap((item) => pathIris(item, prefixes));
}

function visit(
  value: unknown,
  graph: string | null,
  prefixes: Record<string, string>,
  found: GraphPredicate[],
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visit(item, graph, prefixes, found);
    }
    return;
  }

  if (!isNode(value)) {
    return;
  }

  // GRAPH <g> { ... } reads <g> all the way down; GRAPH ?g reads no graph we can name.
  if (value.type === "pattern" && value.subType === "graph") {
    visit(value.patterns, iriOf(value.name, prefixes), prefixes, found);
    return;
  }

  // SERVICE runs on another endpoint, whose graphs are not ours.
  if (value.type === "pattern" && value.subType === "service") {
    return;
  }

  if (value.type === "triple" && graph) {
    for (const predicate of pathIris(value.predicate, prefixes)) {
      found.push({ graph, predicate });
    }
  }

  for (const child of Object.values(value)) {
    visit(child, graph, prefixes, found);
  }
}

/**
 * Every (graph, predicate) pair the query matches inside a GRAPH block.
 * Patterns outside GRAPH read the default graph and are left out. Null when
 * the query does not parse: Virtuoso reports that better than we would.
 */
export function graphPredicates(
  query: string,
  defaultPrefixes: Record<string, string>,
): GraphPredicate[] | null {
  let ast: unknown;
  try {
    ast = parser.parse(query);
  } catch {
    return null;
  }

  if (!isNode(ast)) {
    return null;
  }

  const found: GraphPredicate[] = [];
  visit(ast, null, prefixesOf(ast, defaultPrefixes), found);
  return found;
}
