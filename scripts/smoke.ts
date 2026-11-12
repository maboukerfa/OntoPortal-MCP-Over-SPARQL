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

import { CardService } from "../src/catalog/card.js";
import { Catalog } from "../src/catalog/catalog.js";
import { QueryService } from "../src/catalog/execution.js";
import { PortalLinks } from "../src/catalog/links.js";
import {
  buildSchemaCard,
  renderSchemaCard,
  type GraphProfile,
} from "../src/catalog/introspect.js";
import { portalFromEnv } from "../src/catalog/portal.js";
import { misplacedPredicates } from "../src/catalog/predicates.js";
import { GRAPHS, META, OMV, prefixBlock } from "../src/catalog/vocabulary.js";
import { GuardVerdict, guard } from "../src/guards/guards.js";
import { EXAMPLES } from "../src/mcp/guidance.js";
import { findSchemaCard } from "../src/mcp/paths.js";
import { QueryOutcome, SparqlEndpoint } from "../src/sparql/endpoint.js";

let failures = 0;

function check(name: string, passed: boolean, detail = ""): void {
  const mark = passed ? "PASS" : "FAIL";
  if (!passed) {
    failures += 1;
  }
  process.stdout.write(`  [${mark}] ${name}${detail ? ` — ${detail}` : ""}\n`);
}

/**
 * A worked example exactly as the model reads it: the first sparql block
 * under `heading`, behind the prefixes the host prompt declares. Testing a
 * copy instead would let the example drift unnoticed.
 */
function example(heading: string): string {
  const section = EXAMPLES.split(`### ${heading}\n`)[1] ?? "";
  const body = /```sparql\n([\s\S]*?)```/.exec(section)?.[1] ?? "";
  return `${prefixBlock()}\n${body}`;
}

/** Parsed means status RDF: until then a submission's content graph is empty. */
async function isParsed(endpoint: SparqlEndpoint, submissionIri: string): Promise<boolean> {
  const result = await endpoint.select(`
    PREFIX meta: <http://data.bioontology.org/metadata/>
    PREFIX status: <http://data.bioontology.org/submission_statuses/>
    SELECT ?status WHERE {
      GRAPH meta:OntologySubmission {
        <${submissionIri}> meta:submissionStatus ?status .
        FILTER (?status = status:RDF)
      }
    } LIMIT 1
  `);
  return result.outcome === QueryOutcome.Ok;
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

  const comment = guard("SELECT ?s WHERE { GRAPH <g> { ?s ?p ?o } } # then DELETE it\nLIMIT 10");
  check(
    "does not trip on DELETE inside a comment",
    comment.verdict === GuardVerdict.Allowed && !/LIMIT 100/.test(comment.query),
  );

  // A # inside an IRI or a string starts no comment: the LIMIT after it must
  // still count, or a second LIMIT is appended and Virtuoso rejects the query.
  const hashIri = guard(
    "SELECT ?l WHERE { GRAPH <g> { ?c <http://www.w3.org/2004/02/skos/core#prefLabel> ?l } } LIMIT 3",
  );
  check(
    "reads a LIMIT after an IRI holding #",
    hashIri.verdict === GuardVerdict.Allowed && !/LIMIT 100/.test(hashIri.query),
    hashIri.verdict === GuardVerdict.Allowed ? hashIri.query.slice(-20) : hashIri.reason,
  );

  const hashString = guard('SELECT ?l WHERE { GRAPH <g> { ?c ?p ?l FILTER (?l = "#1") } } LIMIT 3');
  check(
    "reads a LIMIT after a string holding #",
    hashString.verdict === GuardVerdict.Allowed && !/LIMIT 100/.test(hashString.query),
    hashString.verdict === GuardVerdict.Allowed ? hashString.query.slice(-20) : hashString.reason,
  );
}

/** Two graphs, two predicates each: enough to tell "wrong graph" from "nowhere". */
const PROFILE: GraphProfile[] = [
  {
    iri: GRAPHS.ontology,
    label: "Ontology",
    note: "",
    subjects: 1,
    predicates: [
      { predicate: OMV.acronym, uses: 1 },
      { predicate: OMV.name, uses: 1 },
    ],
  },
  {
    iri: GRAPHS.submission,
    label: "OntologySubmission",
    note: "",
    subjects: 1,
    predicates: [
      { predicate: META.ontology, uses: 1 },
      { predicate: OMV.description, uses: 1 },
    ],
  },
];

/** A query over the test profile, behind the prefixes the host prompt declares. */
function misplaced(where: string): string | null {
  return misplacedPredicates(`${prefixBlock()}\nSELECT * WHERE { ${where} }`, PROFILE);
}

function predicateTests(): void {
  process.stdout.write("\npredicates\n");

  check(
    "passes predicates their graph uses",
    misplaced("GRAPH meta:Ontology { ?o omv:acronym ?a ; omv:name ?n }") === null,
  );

  const wrongGraph = misplaced("GRAPH meta:Ontology { ?o omv:description ?d }");
  check(
    "names the graph a misplaced predicate lives in",
    wrongGraph?.includes("`meta:OntologySubmission`") === true,
    wrongGraph?.split("\n")[1] ?? "passed",
  );

  const nowhere = misplaced("GRAPH meta:Ontology { ?o dcterms:title ?t }");
  check(
    "lists the graph's predicates for one used nowhere",
    nowhere?.includes("no metadata graph") === true && nowhere.includes("`omv:name`"),
    nowhere?.split("\n")[1] ?? "passed",
  );

  // Patterns that never fail the query: the wrong answers come from these.
  check(
    "finds a misplaced predicate under NOT EXISTS",
    misplaced("GRAPH meta:Ontology { ?o omv:name ?n FILTER NOT EXISTS { ?o omv:description ?d } }") !== null,
  );
  check(
    "finds a misplaced predicate under OPTIONAL in a subquery",
    misplaced("{ SELECT ?o WHERE { GRAPH meta:Ontology { ?o omv:name ?n OPTIONAL { ?o omv:description ?d } } } }") !== null,
  );

  check(
    "checks each link of a sequence path",
    misplaced("GRAPH meta:Ontology { ?o omv:name/omv:description ?d }") !== null,
  );
  check(
    "lets an alternative path through",
    misplaced("GRAPH meta:Ontology { ?o omv:name|omv:description ?d }") === null,
  );

  check(
    "leaves graphs the card does not profile alone",
    misplaced("GRAPH ?g { ?o omv:description ?d } GRAPH <http://example.org/content> { ?c omv:x ?y } ?s omv:y ?z") === null,
  );
  check(
    "leaves SERVICE alone",
    misplaced("SERVICE <http://example.org/sparql> { GRAPH meta:Ontology { ?o omv:description ?d } }") === null,
  );

  // An undeclared prefix resolves to the portal's own; Virtuoso still reports it.
  check(
    "resolves an undeclared prefix",
    misplacedPredicates("SELECT * WHERE { GRAPH meta:Ontology { ?o omv:description ?d } }", PROFILE) !== null,
  );
  check(
    "lets an unparseable query through to the endpoint",
    misplacedPredicates("SELECT ?s WHERE { GRAPH meta:Ontology { ?s", PROFILE) === null,
  );
}

async function catalogTests(catalog: Catalog, endpoint: SparqlEndpoint): Promise<void> {
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

  // An uploaded submission stays empty until parsed (AGROVOC 62 on
  // 2026-10-15), so the current one must carry RDF, as on the portal.
  check(
    "AGROVOC current submission is parsed",
    await isParsed(endpoint, submission?.submissionIri ?? ""),
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

  const hallucinated = await service.run(`
    PREFIX meta: <http://data.bioontology.org/metadata/>
    PREFIX dcterms: <http://purl.org/dc/terms/>
    SELECT ?title WHERE {
      GRAPH meta:Ontology { ?ont a meta:Ontology ; dcterms:title ?title }
    } LIMIT 5
  `);
  check(
    "rejects the dcterms:title trap before it runs, listing omv:name",
    hallucinated.outcome === "rejected" && Boolean(hallucinated.advice?.includes("`omv:name`")),
    String(hallucinated.outcome),
  );

  const empty = await service.run(`
    PREFIX meta: <http://data.bioontology.org/metadata/>
    PREFIX omv: <http://omv.ontoware.org/2005/05/ontology#>
    SELECT ?ont WHERE {
      GRAPH meta:Ontology { ?ont omv:acronym "NO-SUCH-ONTOLOGY" }
    } LIMIT 5
  `);
  check(
    "reports zero rows as empty with advice",
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
async function idiomTests(service: QueryService, catalog: Catalog): Promise<void> {
  process.stdout.write("\ncard idioms\n");

  const currentSubmission = await service.run(`
    PREFIX meta: <http://data.bioontology.org/metadata/>
    PREFIX status: <http://data.bioontology.org/submission_statuses/>
    PREFIX omv: <http://omv.ontoware.org/2005/05/ontology#>
    SELECT ?acronym ?classes WHERE {
      GRAPH meta:OntologySubmission {
        ?sub meta:ontology ?ont ; meta:submissionId ?id ; meta:submissionStatus status:RDF ;
             omv:numberOfClasses ?classes .
        FILTER NOT EXISTS { ?sub meta:submissionStatus status:ARCHIVED }
        FILTER NOT EXISTS {
          ?other meta:ontology ?ont ; meta:submissionId ?id2 ; meta:submissionStatus status:RDF .
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

  // The named-ontology example must agree with resolve_ontology. Two traps
  // on 2026-10-15: AGROVOC 62 is uploaded but unparsed, and submission IRIs
  // sort as strings, which puts NCBITAXON's ".../7" above ".../26".
  for (const acronym of ["AGROVOC", "NCBITAXON"]) {
    const named = await service.run(
      example("The current submission of a named ontology").replace(
        '"AGROVOC"',
        `"${acronym}"`,
      ),
    );
    const expected = await catalog.latestSubmission(acronym);
    const picked = named.rows?.[0]?.sub;
    check(
      `named-ontology example picks ${acronym}'s current submission`,
      picked !== undefined && picked === expected?.submissionIri,
      `${picked ?? "none"}, resolve_ontology says ${expected?.submissionIri ?? "none"}`,
    );
  }

  // The size idiom must go through Metrics, not omv:numberOfClasses. If this
  // ever ranks a small vocabulary top, the omv route has crept back in: most
  // current submissions omit the omv fields, so it silently drops the giants.
  const sizes = await service.run(example("One row per ontology, with its real size"));
  const biggest = sizes.rows?.[0];
  check(
    "metrics idiom ranks the genuinely largest ontology first",
    Number(biggest?.classes ?? 0) > 100_000,
    `${biggest?.acronym ?? "none"} ${biggest?.classes ?? ""}`,
  );

  // Metrics survive a failed parse: TAXREF-LD's only live submission is
  // ERROR_RDF yet carries 310,008 classes, while the portal shows no size.
  const ranked = sizes.rows ?? [];
  const unparsed: string[] = [];
  for (const row of ranked) {
    if ((await catalog.latestSubmission(row.acronym ?? "")) === null) {
      unparsed.push(row.acronym ?? "");
    }
  }
  check(
    "metrics idiom ranks only parsed submissions",
    ranked.length > 0 && unparsed.length === 0,
    unparsed.length > 0 ? `unparsed: ${unparsed.join(", ")}` : `${ranked.length} ranked`,
  );

  // omv:hasCreator yields an opaque agent IRI; a name needs the foaf:Agent
  // graph, which lives outside the meta: namespace.
  const creators = await service.run(example("Who created an ontology"));
  check(
    "agent join resolves a creator IRI to a name",
    creators.outcome === QueryOutcome.Ok,
    creators.rows?.[0]?.name ?? "no name",
  );

  // Every live submission repeats the creator: AGROVOC 61 and 62 both name FAO.
  const credits = (creators.rows ?? []).map((row) => JSON.stringify(row));
  check(
    "agent join lists each creator once",
    credits.length > 0 && new Set(credits).size === credits.length,
    `${credits.length} rows, ${new Set(credits).size} distinct`,
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
async function cardTests(endpoint: SparqlEndpoint, portal: string): Promise<void> {
  process.stdout.write("\nschema card\n");

  const card = renderSchemaCard(await buildSchemaCard(endpoint), portal);
  check("card covers the mapped term pairs", card.includes("meta:class_urns"));
  check("card covers the mapping totals per ontology pair", card.includes("meta:pair_count"));
  check(
    "card's current-submission idiom requires a parsed submission",
    card.includes("meta:submissionStatus status:RDF"),
  );
}

/**
 * The predicate check must never reject what the card teaches. A rejected
 * example means the check or the example is wrong, and either way the model
 * is told to fix a query that works.
 */
async function examplePredicateTests(cards: CardService): Promise<void> {
  process.stdout.write("\nexamples against the predicate check\n");

  const graphs = await cards.profiles();
  check("live card profiles every graph", graphs !== null);

  for (const [, body] of EXAMPLES.matchAll(/```sparql\n([\s\S]*?)```/g)) {
    const advice = misplacedPredicates(`${prefixBlock()}\n${body}`, graphs ?? []);
    check(
      `passes: ${body?.split("\n")[0] ?? ""}`,
      advice === null,
      advice?.split("\n")[1] ?? "",
    );
  }
}

/**
 * Every link must open a page about what it names. The portal answers 200
 * for a term or project it does not have, so a wrong link would not show up
 * as a 404 anywhere: only these checks catch it.
 */
async function linkTests(
  links: PortalLinks,
  catalog: Catalog,
  service: QueryService,
  ui: string,
): Promise<void> {
  process.stdout.write("\nportal links\n");

  const records: [string, string | null][] = [
    ["http://data.bioontology.org/ontologies/AGROVOC", `${ui}/ontologies/AGROVOC`],
    ["http://data.bioontology.org/categories/AGRI", `${ui}/ontologies?categories=AGRI`],
    ["http://data.bioontology.org/groups/CROP", `${ui}/ontologies?groups=CROP`],
    ["http://data.bioontology.org/projects/BDG", `${ui}/projects/BDG`],
    ["http://data.bioontology.org/ontologies/AGROVOC/submissions/61", null],
    ["http://aims.fao.org/aos/agrovoc/c_12332", null],
  ];
  for (const [iri, expected] of records) {
    const page = links.forRecord(iri);
    check(`links ${iri.split("/").slice(-2).join("/")}`, page === expected, page ?? "none");
  }

  const agrovoc = (await catalog.findOntology("agrovoc")).find((match) => match.acronym === "AGROVOC");
  check(
    "resolve_ontology hands back AGROVOC's page",
    agrovoc?.portalUrl === `${ui}/ontologies/AGROVOC`,
    agrovoc?.portalUrl ?? "none",
  );

  const categories = await catalog.listTerms("category");
  check(
    "list_terms hands back a page per category",
    categories.length > 0 && categories.every((term) => term.portalUrl?.includes("?categories=")),
  );

  const ontologies = await service.run(`
    PREFIX meta: <http://data.bioontology.org/metadata/>
    PREFIX omv: <http://omv.ontoware.org/2005/05/ontology#>
    SELECT ?ont WHERE { GRAPH meta:Ontology { ?ont omv:acronym "AGROVOC" } }
  `);
  check(
    "run_sparql links the ontology records in its rows",
    ontologies.links?.["http://data.bioontology.org/ontologies/AGROVOC"] === `${ui}/ontologies/AGROVOC`,
    JSON.stringify(ontologies.links ?? {}),
  );

  // GACS is SKOS: its concepts have pages. ?type binds skos:Concept, which does not.
  const concepts = await service.run(`
    SELECT ?c ?type WHERE {
      GRAPH <http://data.bioontology.org/ontologies/GACS/submissions/2> {
        ?c a ?type . FILTER (?type = <http://www.w3.org/2004/02/skos/core#Concept>)
      }
    } LIMIT 3
  `);
  const conceptIris = (concepts.rows ?? []).map((row) => row.c ?? "");
  check(
    "run_sparql links the concepts of a SKOS ontology",
    conceptIris.length > 0 &&
      conceptIris.every((iri) =>
        concepts.links?.[iri] === `${ui}/ontologies/GACS?p=classes&conceptid=${encodeURIComponent(iri)}`,
      ),
    `${Object.keys(concepts.links ?? {}).length} links for ${conceptIris.length} rows`,
  );
  check(
    "run_sparql does not link skos:Concept itself",
    !concepts.links?.["http://www.w3.org/2004/02/skos/core#Concept"],
  );

  // An owl:Class in a SKOS ontology is not on its classes tab.
  const gacsClass = await service.run(`
    SELECT ?c WHERE {
      GRAPH <http://data.bioontology.org/ontologies/GACS/submissions/2> {
        VALUES ?c { <http://id.agrisemantics.org/vocab#Chemical> } ?c a ?type
      }
    }
  `);
  check(
    "run_sparql does not link an owl:Class of a SKOS ontology",
    gacsClass.rowCount !== undefined && gacsClass.rowCount > 0 && !gacsClass.links,
    JSON.stringify(gacsClass.links ?? {}),
  );

  // NCBITAXON is OWL: its classes have pages. ?p binds the properties beside one, which have none.
  const taxon = "http://purl.bioontology.org/ontology/NCBITAXON/4577";
  const classes = await service.run(`
    SELECT DISTINCT ?c ?p WHERE {
      GRAPH <http://data.bioontology.org/ontologies/NCBITAXON/submissions/26> {
        VALUES ?c { <${taxon}> } ?c ?p ?o
      }
    } LIMIT 5
  `);
  check(
    "run_sparql links an OWL class and not its properties",
    (classes.rowCount ?? 0) > 1 &&
      classes.links?.[taxon] === `${ui}/ontologies/NCBITAXON?p=classes&conceptid=${encodeURIComponent(taxon)}` &&
      Object.keys(classes.links).length === 1,
    `${classes.rowCount ?? 0} rows, ${Object.keys(classes.links ?? {}).length} links`,
  );
}

async function main(): Promise<void> {
  const portal = portalFromEnv();
  const endpoint = new SparqlEndpoint({ url: portal.sparqlUrl });
  const cards = new CardService(endpoint, portal.name, findSchemaCard);
  const links = new PortalLinks(endpoint, portal.uiUrl);

  guardTests();
  predicateTests();
  await catalogTests(new Catalog(endpoint, links), endpoint);
  await executionTests(new QueryService(endpoint, cards, links));
  await idiomTests(new QueryService(endpoint, cards, links), new Catalog(endpoint, links));
  await cardTests(endpoint, portal.name);
  await examplePredicateTests(cards);
  await linkTests(links, new Catalog(endpoint, links), new QueryService(endpoint, cards, links), portal.uiUrl);

  process.stdout.write(failures === 0 ? "\nall passed\n" : `\n${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
