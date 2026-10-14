/**
 * Smoke test for everything below the model: guards, driver, catalog,
 * execution. Hits the live endpoint, so it is slow and needs network.
 *
 * This exists because the expensive failures in this project are not model
 * failures — they are a predicate that quietly stopped existing, or an idiom
 * that stopped returning rows after an AgroPortal release. Run it after
 * regenerating the schema card.
 *
 *   npx tsx scripts/smoke.ts
 */

import { Catalog } from "../src/catalog/catalog.js";
import { QueryService } from "../src/catalog/execution.js";
import { buildSchemaCard, renderSchemaCard } from "../src/catalog/introspect.js";
import { AGROPORTAL_ENDPOINT } from "../src/catalog/vocabulary.js";
import { GuardVerdict, guard } from "../src/guards/guards.js";
import { QueryOutcome, SparqlEndpoint } from "../src/sparql/endpoint.js";

let failures = 0;

function check(name: string, passed: boolean, detail = ""): void {
  const mark = passed ? "PASS" : "FAIL";
  if (!passed) {
    failures += 1;
  }
  process.stdout.write(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}\n`);
}

function guardTests(): void {
  process.stdout.write("\nguards\n");

  const write = guard("DELETE WHERE { GRAPH <g> { ?s ?p ?o } }");
  check("rejects DELETE", write.verdict === GuardVerdict.Rejected);

  const unscoped = guard("SELECT ?s WHERE { ?s ?p ?o }");
  check("rejects unscoped pattern", unscoped.verdict === GuardVerdict.Rejected);

  const huge = guard("SELECT ?s WHERE { GRAPH <g> { ?s ?p ?o } } LIMIT 999999");
  check("rejects oversized LIMIT", huge.verdict === GuardVerdict.Rejected);

  const bare = guard("SELECT ?s WHERE { GRAPH <g> { ?s ?p ?o } }");
  check(
    "appends a default LIMIT",
    bare.verdict === GuardVerdict.Allowed && /LIMIT \d+/.test(bare.query),
  );

  // A literal containing the word "delete" must not trip the write check.
  const literal = guard(
    'SELECT ?s WHERE { GRAPH <g> { ?s ?p "please delete this" } } LIMIT 10',
  );
  check("does not trip on DELETE inside a literal", literal.verdict === GuardVerdict.Allowed);
}

async function catalogTests(catalog: Catalog): Promise<void> {
  process.stdout.write("\ncatalog\n");

  const matches = await catalog.findOntology("agrovoc");
  const exact = matches.find((match) => match.acronym === "AGROVOC");
  check("resolves 'agrovoc' to AGROVOC", Boolean(exact), exact?.iri ?? "no match");

  const submission = await catalog.latestSubmission("AGROVOC");
  check(
    "finds AGROVOC current submission",
    submission !== null && submission.contentGraph.includes("/submissions/"),
    submission?.contentGraph ?? "none",
  );

  const categories = await catalog.listTerms("category");
  check("lists categories", categories.length > 20, `${categories.length} found`);

  const groups = await catalog.listTerms("group");
  check("lists groups", groups.length > 5, `${groups.length} found`);
}

async function executionTests(service: QueryService): Promise<void> {
  process.stdout.write("\nexecution\n");

  const ok = await service.run(`
    PREFIX meta: <http://data.bioontology.org/metadata/>
    PREFIX omv: <http://omv.ontoware.org/2005/05/ontology#>
    SELECT ?acronym WHERE {
      GRAPH meta:Ontology { ?ont a meta:Ontology ; omv:acronym ?acronym }
    } ORDER BY ?acronym LIMIT 5
  `);
  check("runs a valid query", ok.outcome === QueryOutcome.Ok, `${ok.rowCount ?? 0} rows`);

  const syntax = await service.run("SELECT ?s WHERE { GRAPH <g> { ?s ?p");
  check("classifies a syntax error", syntax.outcome === QueryOutcome.Invalid);

  const empty = await service.run(`
    PREFIX meta: <http://data.bioontology.org/metadata/>
    PREFIX dcterms: <http://purl.org/dc/terms/>
    SELECT ?title WHERE {
      GRAPH meta:Ontology { ?ont a meta:Ontology ; dcterms:title ?title }
    } LIMIT 5
  `);
  check(
    "reports the dcterms:title trap as empty with advice",
    empty.outcome === QueryOutcome.Empty && Boolean(empty.advice),
  );

  const rejected = await service.run("SELECT ?s WHERE { ?s ?p ?o }");
  check("blocks an unscoped query before it reaches the endpoint", rejected.outcome === "rejected");

  // Virtuoso declines an expensive query up front with SQL state 42000, not the
  // S1TAT it uses when the ANYTIME budget runs out. Both mean "too expensive";
  // misreading 42000 as Unavailable tells the model the endpoint is down and
  // that it should stop retrying, which is the opposite of the right move.
  const tooExpensive = await service.run(`
    PREFIX skosxl: <http://www.w3.org/2008/05/skos-xl#>
    SELECT ?a ?b WHERE {
      GRAPH <http://data.bioontology.org/ontologies/AGROVOC/submissions/61> {
        ?a skosxl:literalForm ?l1 . ?b skosxl:literalForm ?l2 .
        FILTER (STR(?l1) = STR(?l2) && ?a != ?b)
      }
    } LIMIT 10
  `);
  check(
    "a cost-estimator refusal reads as timeout, not unavailable",
    tooExpensive.outcome === QueryOutcome.Timeout,
    String(tooExpensive.outcome),
  );

  // STRSTARTS on an IRI compiles, then fails at run time with SQL state 22023.
  // That is the query's fault, so it must read as invalid: unavailable tells the
  // model the endpoint is down and not to retry a query it could simply fix.
  const wrongType = await service.run(`
    PREFIX meta: <http://data.bioontology.org/metadata/>
    PREFIX omv: <http://omv.ontoware.org/2005/05/ontology#>
    SELECT ?domain WHERE {
      GRAPH meta:Ontology { ?ont omv:hasDomain ?domain . FILTER (STRSTARTS(?domain, "http")) }
    } LIMIT 1
  `);
  check(
    "a run-time type error reads as invalid, not unavailable",
    wrongType.outcome === QueryOutcome.Invalid,
    `${wrongType.outcome}: ${wrongType.advice?.slice(0, 120) ?? ""}`,
  );
}

/**
 * The idioms the schema card teaches. If one of these breaks, the card is
 * lying to the model and must be regenerated or corrected.
 */
async function idiomTests(service: QueryService): Promise<void> {
  process.stdout.write("\ncard idioms\n");

  const currentSubmission = await service.run(`
    PREFIX meta: <http://data.bioontology.org/metadata/>
    PREFIX status: <http://data.bioontology.org/submission_statuses/>
    PREFIX omv: <http://omv.ontoware.org/2005/05/ontology#>
    SELECT ?acronym ?classes WHERE {
      GRAPH meta:OntologySubmission {
        ?sub meta:ontology ?ont ; meta:submissionId ?id ; omv:numberOfClasses ?classes .
        FILTER NOT EXISTS { ?sub meta:submissionStatus status:ARCHIVED }
        FILTER NOT EXISTS {
          ?other meta:ontology ?ont ; meta:submissionId ?id2 .
          FILTER NOT EXISTS { ?other meta:submissionStatus status:ARCHIVED }
          FILTER (?id2 > ?id)
        }
      }
      GRAPH meta:Ontology { ?ont omv:acronym ?acronym }
    } LIMIT 200
  `);

  const rows = currentSubmission.rows ?? [];
  const acronyms = rows.map((row) => row.acronym);
  const unique = new Set(acronyms);
  check(
    "current-submission idiom yields one row per ontology",
    rows.length > 0 && unique.size === acronyms.length,
    `${acronyms.length} rows, ${unique.size} distinct`,
  );

  // The size idiom must go through Metrics, not omv:numberOfClasses. If this
  // ever ranks a small vocabulary top, the omv route has crept back in: most
  // current submissions omit the omv fields, so it silently drops the giants.
  const sizes = await service.run(`
    PREFIX meta: <http://data.bioontology.org/metadata/>
    PREFIX status: <http://data.bioontology.org/submission_statuses/>
    PREFIX omv: <http://omv.ontoware.org/2005/05/ontology#>
    PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
    SELECT ?acronym ?classes WHERE {
      GRAPH meta:OntologySubmission {
        ?sub meta:ontology ?ont ; meta:submissionId ?id ; meta:metrics ?m .
        FILTER NOT EXISTS { ?sub meta:submissionStatus status:ARCHIVED }
        FILTER NOT EXISTS {
          ?other meta:ontology ?ont ; meta:submissionId ?id2 .
          FILTER NOT EXISTS { ?other meta:submissionStatus status:ARCHIVED }
          FILTER (?id2 > ?id)
        }
      }
      GRAPH meta:Metrics { ?m meta:classes ?classes }
      GRAPH meta:Ontology { ?ont omv:acronym ?acronym }
    } ORDER BY DESC(xsd:integer(?classes)) LIMIT 3
  `);
  const biggest = sizes.rows?.[0];
  check(
    "metrics idiom ranks the genuinely largest ontology first",
    Number(biggest?.classes ?? 0) > 100_000,
    `${biggest?.acronym ?? "none"} ${biggest?.classes ?? ""}`,
  );

  // omv:hasCreator yields an opaque agent IRI; a name needs the foaf:Agent
  // graph, which lives outside the meta: namespace.
  const creators = await service.run(`
    PREFIX meta: <http://data.bioontology.org/metadata/>
    PREFIX status: <http://data.bioontology.org/submission_statuses/>
    PREFIX omv: <http://omv.ontoware.org/2005/05/ontology#>
    PREFIX foaf: <http://xmlns.com/foaf/0.1/>
    SELECT ?name WHERE {
      GRAPH meta:Ontology { ?ont omv:acronym "AGROVOC" }
      GRAPH meta:OntologySubmission {
        ?sub meta:ontology ?ont ; omv:hasCreator ?agent .
        FILTER NOT EXISTS { ?sub meta:submissionStatus status:ARCHIVED }
      }
      GRAPH foaf:Agent { ?agent foaf:name ?name }
    } LIMIT 5
  `);
  check(
    "agent join resolves a creator IRI to a name",
    creators.outcome === QueryOutcome.Ok,
    creators.rows?.[0]?.name ?? "no name",
  );

  const projects = await service.run(`
    PREFIX meta: <http://data.bioontology.org/metadata/>
    PREFIX omv: <http://omv.ontoware.org/2005/05/ontology#>
    SELECT ?pname WHERE {
      GRAPH meta:Ontology { ?ont omv:acronym "AGROVOC" }
      GRAPH meta:Project { ?project meta:ontologyUsed ?ont ; meta:name ?pname }
    } LIMIT 10
  `);
  check(
    "project join finds projects using an ontology",
    projects.outcome === QueryOutcome.Ok,
    `${projects.rowCount ?? 0} projects`,
  );

  const contentGraph = await service.run(`
    PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
    SELECT (COUNT(DISTINCT ?c) AS ?concepts) WHERE {
      GRAPH <http://data.bioontology.org/ontologies/GACS/submissions/2> { ?c a skos:Concept }
    }
  `);
  check(
    "content graph is queryable",
    contentGraph.outcome === QueryOutcome.Ok,
    contentGraph.rows?.[0]?.concepts ?? "no count",
  );
}

/**
 * The card claims its graph list is complete. MappingProcess only says how a
 * batch of mappings was made; the term pairs and the totals per ontology pair
 * live in two other graphs, and without them mapping questions are unanswerable.
 */
async function cardTests(endpoint: SparqlEndpoint): Promise<void> {
  process.stdout.write("\nschema card\n");

  const card = renderSchemaCard(await buildSchemaCard(endpoint));
  check("card covers the mapped term pairs", card.includes("meta:class_urns"));
  check("card covers the mapping totals per ontology pair", card.includes("meta:pair_count"));
}

async function main(): Promise<void> {
  const endpoint = new SparqlEndpoint({
    url: process.env.AGROPORTAL_SPARQL_URL ?? AGROPORTAL_ENDPOINT,
  });

  guardTests();
  await catalogTests(new Catalog(endpoint));
  await executionTests(new QueryService(endpoint));
  await idiomTests(new QueryService(endpoint));
  await cardTests(endpoint);

  process.stdout.write(failures === 0 ? "\nall passed\n" : `\n${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
