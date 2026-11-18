/**
 * Portal pages for the IRIs an answer names.
 *
 * The model cites the IRIs it is handed, and every metadata IRI points at
 * data.bioontology.org, an API that answers a browser with 401. So the tools
 * hand it the portal page next to each IRI:
 *
 *   http://data.bioontology.org/ontologies/AGROVOC  → {ui}/ontologies/AGROVOC
 *   http://data.bioontology.org/categories/AGRI     → {ui}/ontologies?categories=AGRI
 *   http://data.bioontology.org/groups/CROP         → {ui}/ontologies?groups=CROP
 *   http://data.bioontology.org/projects/BDG        → {ui}/projects/BDG
 *   a term, read from AGROVOC's content graph        → {ui}/ontologies/AGROVOC?p=classes&conceptid=...
 *
 * The portal answers 200 even for a term or project it does not have, with an
 * error inside the page, so a link is only built from an IRI the data vouches
 * for. A term must be what the classes tab lists for the ontology's format,
 * checked on 2026-11-12 against the rendered pages:
 *
 *   GACS (SKOS)      gacs/C11036, a skos:Concept              → page
 *   GACS (SKOS)      vocab#Chemical, an owl:Class             → no page
 *   NCBITAXON (OWL)  NCBITAXON/4577, an owl:Class             → page
 *   C3PO (OWL)       skos:Concept, declared owl:Class there   → page
 *
 * The last one is why W3C IRIs are not filtered out: where an ontology
 * declares one a class, the portal shows it as one.
 */

import {
  QueryOutcome,
  SparqlEndpoint,
  type SparqlBinding,
} from "../sparql/endpoint.js";
import { graphsOf } from "../sparql/patterns.js";
import {
  CONTENT_GRAPH_PREFIX,
  GRAPHS,
  OMV,
  ONTOLOGY_FORMAT_NS,
  PREFIXES,
  RECORD_NS,
} from "./vocabulary.js";

const SUBMISSION_PATH = "/submissions/";

const OWL_CLASS = "http://www.w3.org/2002/07/owl#Class";
const SKOS_CONCEPT = "http://www.w3.org/2004/02/skos/core#Concept";

/** What the classes tab lists, per format: concepts for SKOS, classes for the rest. */
const TERM_TYPE_BY_FORMAT: Record<string, string> = {
  SKOS: SKOS_CONCEPT,
  OWL: OWL_CLASS,
  OBO: OWL_CLASS,
  UMLS: OWL_CLASS,
};

/** Characters that cannot sit inside <...> in a query; an IRI holding one is skipped. */
const UNSAFE_IRI = /[\s<>"{}|^`\\]/;

/** A record IRI's acronym: the single path segment after its namespace. */
const ACRONYM = /^[^/?#]+$/;

export class PortalLinks {
  private readonly pages: { namespace: string; page: (acronym: string) => string }[];

  /** Content graph → its term type. A submission's format never changes. */
  private readonly termTypeOf = new Map<string, string | null>();

  constructor(
    private readonly endpoint: SparqlEndpoint,
    private readonly uiUrl: string,
  ) {
    this.pages = [
      { namespace: RECORD_NS.ontology, page: (acronym) => `${uiUrl}/ontologies/${acronym}` },
      { namespace: RECORD_NS.category, page: (acronym) => `${uiUrl}/ontologies?categories=${acronym}` },
      { namespace: RECORD_NS.group, page: (acronym) => `${uiUrl}/ontologies?groups=${acronym}` },
      { namespace: RECORD_NS.project, page: (acronym) => `${uiUrl}/projects/${acronym}` },
    ];
  }

  /** The page of an ontology, category, group or project record, or null for any other IRI. */
  forRecord(iri: string): string | null {
    for (const { namespace, page } of this.pages) {
      const acronym = iri.startsWith(namespace) ? iri.slice(namespace.length) : "";
      if (ACRONYM.test(acronym)) {
        return page(encodeURIComponent(acronym));
      }
    }
    return null;
  }

  /**
   * Pages for the IRIs in result rows, keyed by IRI. Records always link. A
   * term links when its row names one content graph, which names its
   * ontology, and only once that graph confirms it is a term. The row names
   * it when the query reads a single content graph, or binds it in a
   * GRAPH ?g column:
   *
   *   GRAPH <.../AGROVOC/submissions/61> { ... }   every row: AGROVOC
   *   GRAPH ?g { ... }   each row: whichever ontology its ?g holds
   *
   * A class imported into several ontologies gets a page in each.
   */
  async forRows(query: string, rows: SparqlBinding[]): Promise<PortalLinkMap> {
    const graphs = graphsOf(query, PREFIXES);
    const named = soleContentGraph(graphs?.iris ?? []);
    const variables = graphs?.variables ?? [];

    const links: PortalLinkMap = {};
    const candidates: Candidate[] = [];

    for (const row of rows) {
      const graph = rowGraph(row, named, variables);

      for (const [name, cell] of Object.entries(row)) {
        // The ?g column is a submission, not something the answer names.
        if (cell.type !== "uri" || variables.includes(name)) {
          continue;
        }

        const page = this.forRecord(cell.value);
        if (page) {
          addLink(links, cell.value, page);
          continue;
        }

        if (graph) {
          candidates.push({ graph, iri: cell.value });
        }
      }
    }

    for (const term of await this.confirmed(candidates)) {
      addLink(links, term.iri, this.termPage(term));
    }
    return links;
  }

  /**
   * Pages for terms whose types the caller already read from one content
   * graph. Checking them here instead would list every term in a URL, and a
   * class graph's few hundred outgrow the endpoint's limit (414 at 12 KB).
   */
  async forTyped(graph: string, terms: TypedTerm[]): Promise<Map<string, string>> {
    const pages = new Map<string, string>();

    const termType = (await this.termTypes([graph])).get(graph);
    if (!termType) {
      return pages;
    }

    for (const { iri, types } of terms) {
      if (types.includes(termType)) {
        pages.set(iri, this.termPage({ graph, iri }));
      }
    }
    return pages;
  }

  private termPage({ graph, iri }: Candidate): string {
    const acronym = graph.slice(CONTENT_GRAPH_PREFIX.length).split(SUBMISSION_PATH)[0] ?? "";
    return (
      `${this.uiUrl}/ontologies/${encodeURIComponent(acronym)}` +
      `?p=classes&conceptid=${encodeURIComponent(iri)}`
    );
  }

  /** The candidates their graph types as its format's term type. A failed check confirms none. */
  private async confirmed(candidates: Candidate[]): Promise<Candidate[]> {
    const unique = new Map(
      candidates
        .filter((candidate) => !UNSAFE_IRI.test(candidate.iri))
        .map((candidate) => [`${candidate.graph} ${candidate.iri}`, candidate]),
    );
    if (unique.size === 0) {
      return [];
    }

    const types = await this.termTypes([...new Set([...unique.values()].map((c) => c.graph))]);
    const checkable = [...unique.values()].filter((candidate) => types.get(candidate.graph));
    if (checkable.length === 0) {
      return [];
    }

    // All the types of every pair at once; the format decides which one counts.
    const pairs = checkable.map(({ graph, iri }) => `(<${graph}> <${iri}>)`).join(" ");
    const result = await this.endpoint.select(`
      SELECT DISTINCT ?g ?term ?type WHERE {
        VALUES (?g ?term) { ${pairs} }
        GRAPH ?g { ?term a ?type }
      }
    `);

    if (result.outcome !== QueryOutcome.Ok) {
      return [];
    }

    return SparqlEndpoint.plain(result.rows).flatMap((row) => {
      if (!row.g || !row.term || types.get(row.g) !== row.type) {
        return [];
      }
      return [{ graph: row.g, iri: row.term }];
    });
  }

  /**
   * What the classes tab lists for each submission's format, or null for an
   * unknown one. A content graph IRI is also its submission's, which carries
   * the format. Looked up apart from the terms: joined in one query, the two
   * trip Virtuoso's optimiser (SQ156).
   */
  private async termTypes(graphs: string[]): Promise<Map<string, string | null>> {
    const missing = graphs.filter((graph) => !this.termTypeOf.has(graph));

    if (missing.length > 0) {
      const result = await this.endpoint.select(`
        SELECT ?g ?format WHERE {
          VALUES ?g { ${missing.map((graph) => `<${graph}>`).join(" ")} }
          GRAPH <${GRAPHS.submission}> { ?g <${OMV.hasOntologyLanguage}> ?format }
        }
      `);

      // An outage is not an answer: leave them uncached so the next call asks again.
      if (result.outcome === QueryOutcome.Ok || result.outcome === QueryOutcome.Empty) {
        const formats = new Map(
          SparqlEndpoint.plain(result.rows).map((row) => [row.g ?? "", row.format ?? ""]),
        );
        for (const graph of missing) {
          const format = (formats.get(graph) ?? "").slice(ONTOLOGY_FORMAT_NS.length);
          this.termTypeOf.set(graph, TERM_TYPE_BY_FORMAT[format] ?? null);
        }
      }
    }

    return new Map(graphs.map((graph) => [graph, this.termTypeOf.get(graph) ?? null]));
  }
}

/** A portal page per IRI; a list when the IRI is a class in several ontologies. */
export type PortalLinkMap = Record<string, string | string[]>;

/** A term and every rdf:type its content graph gives it. */
export interface TypedTerm {
  iri: string;
  types: string[];
}

/** An IRI from a row, and the content graph that row read. */
interface Candidate {
  graph: string;
  iri: string;
}

function isContentGraph(iri: string): boolean {
  return iri.startsWith(CONTENT_GRAPH_PREFIX) && iri.includes(SUBMISSION_PATH) && !UNSAFE_IRI.test(iri);
}

/** The one content graph among the query's GRAPH <...> IRIs; null for none or several. */
function soleContentGraph(iris: string[]): string | null {
  const content = new Set(iris.filter(isContentGraph));
  const [graph] = content;
  return graph && content.size === 1 ? graph : null;
}

/** The content graph a row read: the query's own, or its GRAPH ?g binding. Null when not exactly one. */
function rowGraph(row: SparqlBinding, named: string | null, variables: string[]): string | null {
  const graphs = new Set(named ? [named] : []);

  for (const variable of variables) {
    const cell = row[variable];
    if (cell?.type === "uri" && isContentGraph(cell.value)) {
      graphs.add(cell.value);
    }
  }

  const [graph] = graphs;
  return graph && graphs.size === 1 ? graph : null;
}

/** Add a page; an IRI met in several ontologies keeps one page per ontology. */
function addLink(links: PortalLinkMap, iri: string, page: string): void {
  const known = links[iri];
  if (known === undefined) {
    links[iri] = page;
    return;
  }

  const pages = [known].flat();
  if (!pages.includes(page)) {
    links[iri] = [...pages, page];
  }
}
