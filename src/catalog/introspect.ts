/**
 * Introspects the live endpoint to build the schema card.
 *
 * Why live introspection instead of the published metadata model at
 * data.agroportal.eu/submission_metadata: the model documents every property
 * AgroPortal *accepts*, which is a superset of what submitters actually fill
 * in. A predicate nobody populates is worse than useless in a prompt — it
 * invites the model to write a query that returns zero rows. Counts let us rank
 * and prune.
 *
 * The graph list is explicit and hand-maintained rather than discovered. Two
 * reasons: enumerating graphs on this endpoint reliably trips the ANYTIME
 * budget, and the portal's graphs do not share a namespace — the agent model
 * lives under foaf:, the identifier model under adms:. Discovery by namespace
 * prefix misses them silently, which is how the first version of this card
 * shipped with no agents, projects, metrics or mappings in it. When OntoPortal
 * adds a graph, add it to PROFILED.
 */

import {
  QueryOutcome,
  SparqlEndpoint,
  type SparqlResult,
} from "../sparql/endpoint.js";
import {
  GRAPHS,
  META,
  SUBMISSION_STATUS_ARCHIVED,
  SUBMISSION_STATUS_RDF,
  compact,
} from "./vocabulary.js";

/**
 * Predicates below this many uses are noise in the card — one submitter's
 * private field. The predicate check still accepts them: they hold data.
 */
const MIN_PREDICATE_USES = 3;

/** Content graphs listed in the card, as orientation rather than an inventory. */
const CONTENT_GRAPH_SAMPLE = 12;

/** Distinguishes a per-submission content graph from a metadata graph. */
const SUBMISSION_PATH = "/submissions/";

interface GraphSpec {
  iri: string;
  label: string;
  /** What the graph holds, and how you reach it from somewhere else. */
  note: string;
}

/**
 * The metadata graphs worth profiling, in the order a reader should meet them:
 * the catalogue first, then what hangs off it.
 */
const PROFILED: GraphSpec[] = [
  {
    iri: GRAPHS.ontology,
    label: "Ontology",
    note: "One record per ontology — the catalogue entry. Identity only; descriptive metadata lives on the submission.",
  },
  {
    iri: GRAPHS.submission,
    label: "OntologySubmission",
    note: "One record per version. Almost all descriptive metadata is here. Reach the ontology with meta:ontology.",
  },
  {
    iri: GRAPHS.metrics,
    label: "Metrics",
    note: "Size statistics per submission, reached via meta:metrics. Prefer these over the omv:numberOf* fields, which many current submissions omit.",
  },
  {
    iri: GRAPHS.agent,
    label: "foaf:Agent",
    note: "People and organizations. omv:hasCreator, dcterms:publisher and schema:copyrightHolder point here. foaf:agentType is 'person' or 'organization'.",
  },
  {
    iri: GRAPHS.identifier,
    label: "adms:Identifier",
    note: "ORCID and ROR identifiers, reached from an agent via adms:identifier. The value sits on skos:notation.",
  },
  {
    iri: GRAPHS.project,
    label: "Project",
    note: "Projects registered on the portal. meta:ontologyUsed links a project to the ontologies it uses.",
  },
  {
    iri: GRAPHS.contact,
    label: "Contact",
    note: "Submission contact names and emails, reached via meta:contact.",
  },
  {
    iri: GRAPHS.review,
    label: "Review",
    note: "User reviews with per-axis ratings, linked by meta:ontologyReviewed.",
  },
  {
    iri: GRAPHS.mappingProcess,
    label: "MappingProcess",
    note: "How a batch of mappings was made: source ontology (meta:source), relation, creator, date. Holds no terms; the term pairs are in RestBackupMapping. Large — constrain by meta:source before querying.",
  },
  {
    iri: GRAPHS.restBackupMapping,
    label: "RestBackupMapping",
    note: "The mappings stored on the portal, one record per term pair: two meta:class_urns, each \"urn:ACRONYM:termIRI\" (or \"ext:...\" for a vocabulary outside the portal), and meta:process to its MappingProcess. class_urns are not strings: wrap them in STR() before STRSTARTS. Large — filter on one ontology's urn prefix.",
  },
  {
    iri: GRAPHS.mappingCount,
    label: "MappingCount",
    note: "Mapping totals per ontology pair: two meta:ontologies acronyms as plain strings, and meta:count. Use it for \"how many mappings between X and Y\" instead of counting RestBackupMapping. Counts linger for deleted ontologies: join meta:Ontology on omv:acronym to keep live ones.",
  },
  {
    iri: GRAPHS.category,
    label: "Category",
    note: "Subject categories. An ontology links to these with omv:hasDomain.",
  },
  {
    iri: GRAPHS.group,
    label: "Group",
    note: "Ontology groups, linked with meta:group.",
  },
];

export interface PredicateFact {
  predicate: string;
  uses: number;
}

export interface GraphProfile {
  iri: string;
  label: string;
  note: string;
  subjects: number;
  predicates: PredicateFact[];
}

export interface TermFact {
  iri: string;
  label: string;
}

/** An ontology whose submission ids are not contiguous — evidence for the card. */
export interface IdGapFact {
  acronym: string;
  submissions: number;
  latestId: number;
}

export interface SchemaCard {
  generatedAt: string;
  ontologyCount: number;
  submissionCount: number;
  activeSubmissionCount: number;
  graphs: GraphProfile[];
  categories: TermFact[];
  groups: TermFact[];
  largestContentGraphs: { graph: string; triples: number }[];
  idGap: IdGapFact | null;
  /** Ontologies carrying more than one parsed, non-archived submission. */
  multiLiveCount: number;
}

function rowsOf(result: SparqlResult): Record<string, string>[] {
  if (result.outcome !== QueryOutcome.Ok) {
    return [];
  }
  return SparqlEndpoint.plain(result.rows);
}

async function countOf(
  endpoint: SparqlEndpoint,
  query: string,
  variable: string,
): Promise<number> {
  const result = await endpoint.select(query);
  const first = rowsOf(result)[0];
  return Number(first?.[variable] ?? 0);
}

/**
 * Profile one graph: how many subjects it holds, and which predicates they use.
 *
 * Deliberately not filtered by rdf:type — each metadata graph holds exactly one
 * record type, so a class filter would need maintaining per graph for no gain,
 * and a record that stops declaring its type still shows up here.
 */
async function profileGraph(
  endpoint: SparqlEndpoint,
  spec: GraphSpec,
): Promise<GraphProfile> {
  const predicates = await endpoint.select(`
    SELECT ?p (COUNT(*) AS ?n) WHERE {
      GRAPH <${spec.iri}> { ?s ?p ?o }
    } GROUP BY ?p ORDER BY DESC(?n)
  `);

  const subjects = await countOf(
    endpoint,
    `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE { GRAPH <${spec.iri}> { ?s ?p ?o } }`,
    "n",
  );

  return {
    iri: spec.iri,
    label: spec.label,
    note: spec.note,
    subjects,
    predicates: rowsOf(predicates)
      .map((row) => ({ predicate: row.p ?? "", uses: Number(row.n ?? 0) }))
      .filter((fact) => fact.predicate),
  };
}

/** Small closed vocabularies worth embedding wholesale — they ground entities. */
async function termsIn(
  endpoint: SparqlEndpoint,
  graph: string,
): Promise<TermFact[]> {
  const result = await endpoint.select(`
    SELECT ?s ?name WHERE {
      GRAPH <${graph}> { ?s <${META.name}> ?name }
    } ORDER BY ?name
  `);

  return rowsOf(result).map((row) => ({
    iri: row.s ?? "",
    label: row.name ?? "",
  }));
}

/**
 * Find an ontology where submission count != max submission id. Its existence
 * is the reason the card tells the model not to use MAX(submissionId) to pick
 * the current version.
 */
async function findIdGap(endpoint: SparqlEndpoint): Promise<IdGapFact | null> {
  const result = await endpoint.select(`
    SELECT ?ont (COUNT(?s) AS ?n) (MAX(?id) AS ?latest) WHERE {
      GRAPH <${GRAPHS.submission}> {
        ?s <${META.ontology}> ?ont ; <${META.submissionId}> ?id
      }
    } GROUP BY ?ont HAVING (COUNT(?s) != MAX(?id)) ORDER BY DESC(COUNT(?s)) LIMIT 1
  `);

  const first = rowsOf(result)[0];
  if (!first?.ont) {
    return null;
  }

  return {
    acronym: first.ont.split("/").pop() ?? first.ont,
    submissions: Number(first.n ?? 0),
    latestId: Number(first.latest ?? 0),
  };
}

export async function buildSchemaCard(
  endpoint: SparqlEndpoint,
): Promise<SchemaCard> {
  // Sequential on purpose: firing thirteen graph profiles at once is a burst this
  // shared endpoint does not deserve, and the whole run still finishes well
  // inside a minute.
  const graphs: GraphProfile[] = [];
  for (const spec of PROFILED) {
    graphs.push(await profileGraph(endpoint, spec));
  }

  const [categories, groups] = await Promise.all([
    termsIn(endpoint, GRAPHS.category),
    termsIn(endpoint, GRAPHS.group),
  ]);

  const [submissionCount, activeSubmissionCount] = await Promise.all([
    countOf(
      endpoint,
      `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE {
         GRAPH <${GRAPHS.submission}> { ?s <${META.submissionId}> ?id }
       }`,
      "n",
    ),
    countOf(
      endpoint,
      `SELECT (COUNT(DISTINCT ?s) AS ?n) WHERE {
         GRAPH <${GRAPHS.submission}> {
           ?s <${META.submissionId}> ?id .
           FILTER NOT EXISTS {
             ?s <${META.submissionStatus}> <${SUBMISSION_STATUS_ARCHIVED}>
           }
         }
       }`,
      "n",
    ),
  ]);

  const idGap = await findIdGap(endpoint);

  // The status filters alone do not yield one row per ontology. Measuring
  // how badly is what justifies the nested NOT EXISTS in the examples.
  const multiLiveCount = await countOf(
    endpoint,
    `SELECT (COUNT(*) AS ?n) WHERE {
       { SELECT ?ont (COUNT(?sub) AS ?live) WHERE {
           GRAPH <${GRAPHS.submission}> {
             ?sub <${META.ontology}> ?ont ;
                  <${META.submissionStatus}> <${SUBMISSION_STATUS_RDF}> .
             FILTER NOT EXISTS {
               ?sub <${META.submissionStatus}> <${SUBMISSION_STATUS_ARCHIVED}>
             }
           }
         } GROUP BY ?ont HAVING (COUNT(?sub) > 1) }
     }`,
    "n",
  );

  // Unscoped, but bounded by LIMIT and tolerated by the ANYTIME budget. If this
  // ever starts timing out, drop it from the card rather than raising the budget.
  // Over-fetch and filter here: the server-side FILTER that would exclude the
  // metadata graphs is itself what trips the timeout.
  const largest = await endpoint.select(`
    SELECT ?g (COUNT(*) AS ?n) WHERE { GRAPH ?g { ?s ?p ?o } }
    GROUP BY ?g ORDER BY DESC(?n) LIMIT ${CONTENT_GRAPH_SAMPLE * 2}
  `);

  const ontologyGraph = graphs.find((graph) => graph.iri === GRAPHS.ontology);

  return {
    generatedAt: new Date().toISOString(),
    ontologyCount: ontologyGraph?.subjects ?? 0,
    submissionCount,
    activeSubmissionCount,
    graphs,
    categories,
    groups,
    largestContentGraphs: rowsOf(largest)
      .filter((row) => (row.g ?? "").includes(SUBMISSION_PATH))
      .slice(0, CONTENT_GRAPH_SAMPLE)
      .map((row) => ({
        graph: row.g ?? "",
        triples: Number(row.n ?? 0),
      })),
    idGap,
    multiLiveCount,
  };
}

/**
 * Graphs that came back with no predicates: their profile query failed. A card
 * carrying one tells the model the graph is empty, and the card claims to be
 * complete.
 */
export function emptyGraphs(card: SchemaCard): string[] {
  return card.graphs
    .filter((graph) => graph.predicates.length === 0)
    .map((graph) => graph.label);
}

function predicateTable(facts: PredicateFact[]): string {
  const lines = facts.filter((fact) => fact.uses >= MIN_PREDICATE_USES).map(
    (fact) => `| \`${compact(fact.predicate)}\` | ${fact.uses} |`,
  );
  return ["| predicate | uses |", "|---|---|", ...lines].join("\n");
}

/**
 * Render the card as Markdown. This string becomes the cached system-prompt
 * prefix, so it must be byte-stable between runs when the data has not changed
 * — hence sorted inputs everywhere and a timestamp kept out of the cached body.
 */
export function renderSchemaCard(card: SchemaCard, portal: string): string {
  const categoryList = card.categories
    .map((term) => `${term.label} (\`${term.iri.split("/").pop()}\`)`)
    .join(", ");

  const groupList = card.groups
    .map((term) => `${term.label} (\`${term.iri.split("/").pop()}\`)`)
    .join(", ");

  const gapEvidence = card.idGap
    ? ` (${card.idGap.acronym} has ${card.idGap.submissions} submissions but a latest id of ${card.idGap.latestId})`
    : "";

  const contentGraphs = card.largestContentGraphs
    .map((entry) => `  ${entry.graph}  (${entry.triples.toLocaleString()})`)
    .join("\n");

  const graphIndex = [
    "| graph | holds | subjects |",
    "|---|---|---|",
    ...card.graphs.map(
      (graph) =>
        `| \`${compact(graph.iri)}\` | ${graph.note} | ${graph.subjects.toLocaleString()} |`,
    ),
  ].join("\n");

  const graphSections = card.graphs
    .map((graph) =>
      [
        `### ${graph.label} — \`<${graph.iri}>\``,
        "",
        graph.note,
        "",
        predicateTable(graph.predicates),
      ].join("\n"),
    )
    .join("\n\n");

  return `# ${portal} SPARQL schema card

${card.ontologyCount} ontologies, ${card.submissionCount} submissions
(${card.activeSubmissionCount} not archived).

## Graph layout

Metadata and ontology content live in different named graphs. Choosing the
wrong one returns **zero rows with no error**, so always scope with GRAPH.

Two metadata graphs sit outside the \`data.bioontology.org/metadata/\` namespace:
agents are in \`<http://xmlns.com/foaf/0.1/Agent>\` and their ORCID / ROR
identifiers in \`<http://www.w3.org/ns/adms#Identifier>\`.

${graphIndex}

    CONTENT (large, plain SKOS/OWL — one graph per submission)
${contentGraphs}

A content graph IRI is \`.../ontologies/{ACRONYM}/submissions/{ID}\`, and is the
same IRI as the submission record. To query an ontology's concepts you must
first resolve which submission is current.

## Idioms that are easy to get wrong

**Current submission** — this is the trap that bites hardest. Current means
parsed (\`status:RDF\`) and not ARCHIVED: a newer upload is live but empty until
parsed, and a failed parse keeps its metrics. Even so, ${card.multiLiveCount} ontologies
carry more than one such submission, so the filters alone double-count. Pair
them with a "no newer live sibling" check to get exactly one row per ontology:

    ?sub meta:ontology ?ont ; meta:submissionId ?id ; meta:submissionStatus status:RDF .
    FILTER NOT EXISTS { ?sub meta:submissionStatus status:ARCHIVED }
    FILTER NOT EXISTS {
      ?other meta:ontology ?ont ; meta:submissionId ?id2 ; meta:submissionStatus status:RDF .
      FILTER NOT EXISTS { ?other meta:submissionStatus status:ARCHIVED }
      FILTER (?id2 > ?id)
    }

Do not reach for MAX(submissionId) instead: ids are not contiguous${gapEvidence},
so it reads as if it were picking an arbitrary version.

**Ontology size** — use the Metrics graph, not the \`omv:numberOf*\` fields on
the submission. Many current submissions omit the omv fields while their
archived predecessors carry them, so a query over omv either finds nothing or
silently reports a stale figure. Follow \`meta:metrics\` into the Metrics graph
and read \`meta:classes\`, \`meta:properties\`, \`meta:individuals\`.

**Who made an ontology** — \`omv:hasCreator\` does not give you a name. It gives
an agent IRI in the \`foaf:Agent\` graph; join there for \`foaf:name\`, and on to
\`adms:identifier\` → \`skos:notation\` for an ORCID or ROR.

**Ontology identity** — \`omv:acronym\` is the short code (AGROVOC),
\`omv:name\` the display name. There is no \`dcterms:title\` and no \`rdfs:label\`
on these records.

**Submission to ontology** — \`?sub meta:ontology ?ont\` points from the
submission record to the ontology record, which lives in a *different* graph.

## Predicates by graph

${graphSections}

## Categories

${categoryList}

## Groups

${groupList}
`;
}
