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
import { namedGraphs } from "../sparql/patterns.js";
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
  private readonly termTypes = new Map<string, string | null>();

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
   * Pages for the IRIs in result rows, keyed by IRI. Records always link.
   * Terms link when the query read exactly one content graph, which names
   * their ontology, and only once that graph confirms they are terms.
   */
  async forRows(query: string, rows: SparqlBinding[]): Promise<Record<string, string>> {
    const iris = new Set<string>();
    for (const row of rows) {
      for (const cell of Object.values(row)) {
        if (cell.type === "uri") {
          iris.add(cell.value);
        }
      }
    }

    const links: Record<string, string> = {};
    const candidates: string[] = [];
    for (const iri of iris) {
      const page = this.forRecord(iri);
      if (page) {
        links[iri] = page;
        continue;
      }
      candidates.push(iri);
    }

    const content = this.contentGraph(query);
    if (!content || candidates.length === 0) {
      return links;
    }

    for (const term of await this.termsIn(content.graph, candidates)) {
      links[term] =
        `${this.uiUrl}/ontologies/${encodeURIComponent(content.acronym)}` +
        `?p=classes&conceptid=${encodeURIComponent(term)}`;
    }
    return links;
  }

  /** The one content graph the query reads, with its ontology's acronym; null for none or several. */
  private contentGraph(query: string): { graph: string; acronym: string } | null {
    const graphs = (namedGraphs(query, PREFIXES) ?? []).filter(
      (graph) => graph.startsWith(CONTENT_GRAPH_PREFIX) && graph.includes(SUBMISSION_PATH),
    );

    const [graph] = graphs;
    if (!graph || new Set(graphs).size > 1) {
      return null;
    }

    const acronym = graph.slice(CONTENT_GRAPH_PREFIX.length).split(SUBMISSION_PATH)[0];
    return acronym ? { graph, acronym } : null;
  }

  /** The candidates the graph types as its format's term type. A failed check links none. */
  private async termsIn(graph: string, candidates: string[]): Promise<string[]> {
    const type = await this.termType(graph);
    if (!type) {
      return [];
    }

    const values = candidates
      .filter((iri) => !UNSAFE_IRI.test(iri))
      .map((iri) => `<${iri}>`)
      .join(" ");

    const result = await this.endpoint.select(`
      SELECT DISTINCT ?term WHERE {
        GRAPH <${graph}> { VALUES ?term { ${values} } ?term a <${type}> }
      }
    `);

    if (result.outcome !== QueryOutcome.Ok) {
      return [];
    }
    return SparqlEndpoint.plain(result.rows).flatMap((row) => (row.term ? [row.term] : []));
  }

  /**
   * What the classes tab lists for this submission's format, or null for an
   * unknown format. The content graph IRI is also the submission's, which
   * carries the format. Looked up apart from the terms: joined in one query,
   * the two trip Virtuoso's optimiser (SQ156).
   */
  private async termType(graph: string): Promise<string | null> {
    const cached = this.termTypes.get(graph);
    if (cached !== undefined) {
      return cached;
    }

    const result = await this.endpoint.select(`
      SELECT ?format WHERE {
        GRAPH <${GRAPHS.submission}> { <${graph}> <${OMV.hasOntologyLanguage}> ?format }
      } LIMIT 1
    `);

    // An outage is not an answer: leave it uncached so the next call asks again.
    if (result.outcome !== QueryOutcome.Ok && result.outcome !== QueryOutcome.Empty) {
      return null;
    }

    const format = SparqlEndpoint.plain(result.rows)[0]?.format ?? "";
    const type = TERM_TYPE_BY_FORMAT[format.slice(ONTOLOGY_FORMAT_NS.length)] ?? null;
    this.termTypes.set(graph, type);
    return type;
  }
}
