/**
 * Entity grounding.
 *
 * The model is good at SPARQL shape and bad at IRIs. Rather than let it guess
 * that "agrovoc" maps to <http://data.bioontology.org/ontologies/AGROVOC>, it
 * asks here and gets the real one. Every lookup is graph-scoped and bounded,
 * so these are cheap.
 */

import {
  QueryOutcome,
  SparqlEndpoint,
  type SparqlResult,
} from "../sparql/endpoint.js";
import {
  CLASSES,
  GRAPHS,
  META,
  OMV,
  SUBMISSION_STATUS_ARCHIVED,
} from "./vocabulary.js";

const MAX_MATCHES = 10;

export interface OntologyRef {
  acronym: string;
  name: string;
  iri: string;
}

export interface SubmissionRef {
  submissionIri: string;
  submissionId: number;
  /** The named graph holding this submission's concepts. */
  contentGraph: string;
}

/**
 * Escape a user/model supplied term for embedding in a SPARQL string literal.
 * The term reaches us from model output, which is untrusted input.
 */
function literal(term: string): string {
  return term
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

/**
 * A failed lookup throws rather than reading as zero rows: "no ontology
 * matches" during an outage has the model tell the user AgroPortal lacks an
 * ontology it has.
 */
function rowsOf(result: SparqlResult): Record<string, string>[] {
  if (result.outcome === QueryOutcome.Empty) {
    return [];
  }

  if (result.outcome !== QueryOutcome.Ok) {
    throw new Error(
      `AgroPortal's endpoint failed this lookup (${result.outcome}: ${result.message}). ` +
        `This is not an empty result: retry once, then tell the user the lookup failed.`,
    );
  }
  return SparqlEndpoint.plain(result.rows);
}

export class Catalog {
  constructor(private readonly endpoint: SparqlEndpoint) {}

  /**
   * Resolve free text to ontologies. Matches acronym or display name,
   * case-insensitively, so "agrovoc", "AGROVOC" and "Agrovoc Thesaurus" all land.
   */
  async findOntology(term: string): Promise<OntologyRef[]> {
    const needle = literal(term.trim());

    const result = await this.endpoint.select(`
      SELECT ?ont ?acronym ?name WHERE {
        GRAPH <${GRAPHS.ontology}> {
          ?ont a <${CLASSES.ontology}> ;
               <${OMV.acronym}> ?acronym ;
               <${OMV.name}> ?name .
          FILTER (
            CONTAINS(LCASE(STR(?acronym)), LCASE("${needle}")) ||
            CONTAINS(LCASE(STR(?name)), LCASE("${needle}"))
          )
        }
      } ORDER BY ?acronym LIMIT ${MAX_MATCHES}
    `);

    return rowsOf(result).map((row) => ({
      acronym: row.acronym ?? "",
      name: row.name ?? "",
      iri: row.ont ?? "",
    }));
  }

  /**
   * The submission currently serving an ontology's content, identified by the
   * absence of ARCHIVED rather than by the highest id.
   */
  async latestSubmission(acronym: string): Promise<SubmissionRef | null> {
    const needle = literal(acronym.trim());

    const result = await this.endpoint.select(`
      SELECT ?sub ?id WHERE {
        GRAPH <${GRAPHS.ontology}> {
          ?ont a <${CLASSES.ontology}> ; <${OMV.acronym}> ?acronym .
          FILTER (LCASE(STR(?acronym)) = LCASE("${needle}"))
        }
        GRAPH <${GRAPHS.submission}> {
          ?sub <${META.ontology}> ?ont ; <${META.submissionId}> ?id .
          FILTER NOT EXISTS {
            ?sub <${META.submissionStatus}> <${SUBMISSION_STATUS_ARCHIVED}>
          }
        }
      } ORDER BY DESC(?id) LIMIT 1
    `);

    const first = rowsOf(result)[0];
    if (!first?.sub) {
      return null;
    }

    return {
      submissionIri: first.sub,
      submissionId: Number(first.id ?? 0),
      // The submission record IRI *is* the content graph IRI in OntoPortal.
      contentGraph: first.sub,
    };
  }

  /**
   * Resolve a term to candidates plus, where it is unambiguous, the current
   * submission.
   *
   * An exact acronym match wins even when other ontologies contain the term as
   * a substring: "AGROVOC" also matches AGROVOC-PT-BR, and treating that as
   * ambiguous would withhold the content graph in the most common case there is.
   */
  async resolve(
    term: string,
  ): Promise<{ matches: OntologyRef[]; currentSubmission: SubmissionRef | null }> {
    const matches = await this.findOntology(term);
    const wanted = term.trim().toLowerCase();

    const exact = matches.find((match) => match.acronym.toLowerCase() === wanted);
    const chosen = exact ?? (matches.length === 1 ? matches[0] : undefined);

    if (!chosen) {
      return { matches, currentSubmission: null };
    }

    return {
      matches,
      currentSubmission: await this.latestSubmission(chosen.acronym),
    };
  }

  /** Categories and groups are small closed vocabularies — useful for filters. */
  async listTerms(kind: "category" | "group"): Promise<OntologyRef[]> {
    const graph = kind === "category" ? GRAPHS.category : GRAPHS.group;

    const result = await this.endpoint.select(`
      SELECT ?term ?acronym ?name WHERE {
        GRAPH <${graph}> {
          ?term <${META.acronym}> ?acronym ; <${META.name}> ?name
        }
      } ORDER BY ?name
    `);

    return rowsOf(result).map((row) => ({
      acronym: row.acronym ?? "",
      name: row.name ?? "",
      iri: row.term ?? "",
    }));
  }
}
