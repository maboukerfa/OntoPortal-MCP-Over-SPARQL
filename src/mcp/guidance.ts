/**
 * Worked query idioms, served to the host model via `get_schema_card` and as
 * an MCP resource.
 *
 * Every query here was executed against sparql.agroportal.eu and returned the
 * stated result. They cover *idioms*, not topics — the graph join, the
 * current-submission filter, the content-graph entry point — because a model
 * generalises query shape far better than subject matter.
 *
 * If you add one, run it first. An example that returns zero rows teaches the
 * model to write queries that return zero rows.
 */

export const EXAMPLES = `## Worked examples

### Ontologies in a subject category

\`\`\`sparql
SELECT ?acronym ?name WHERE {
  GRAPH meta:Ontology {
    ?ont a meta:Ontology ;
         omv:acronym ?acronym ;
         omv:name ?name ;
         omv:hasDomain <http://data.bioontology.org/categories/AGRI> .
  }
} ORDER BY ?acronym LIMIT 100
\`\`\`

Categories are IRIs under \`.../categories/\`, not strings. \`omv:hasDomain\` is
the link, and it is repeated — an ontology sits in several categories.

### The current submission of a named ontology

\`\`\`sparql
SELECT ?sub ?version ?description WHERE {
  GRAPH meta:Ontology {
    ?ont omv:acronym "AGROVOC" .
  }
  GRAPH meta:OntologySubmission {
    ?sub meta:ontology ?ont ;
         meta:submissionId ?id ;
         meta:submissionStatus status:RDF .
    FILTER NOT EXISTS {
      ?sub meta:submissionStatus status:ARCHIVED
    }
    OPTIONAL { ?sub omv:version ?version }
    OPTIONAL { ?sub omv:description ?description }
  }
} ORDER BY DESC(?id) LIMIT 1
\`\`\`

Two graphs, joined on \`?ont\`. Metadata fields are almost all optional in
practice — wrap anything non-identifying in OPTIONAL or you will silently drop
rows.

\`status:RDF\` means parsed. A newer upload is live but empty until then:
AGROVOC 62 holds nothing while 61 serves. Order by \`meta:submissionId\`, never
by \`?sub\`: IRIs sort as strings, so \`.../7\` outranks \`.../26\`.

### One row per ontology, with its real size

\`\`\`sparql
SELECT ?acronym ?classes WHERE {
  GRAPH meta:OntologySubmission {
    ?sub meta:ontology ?ont ;
         meta:submissionId ?id ;
         meta:submissionStatus status:RDF ;
         meta:metrics ?m .
    FILTER NOT EXISTS {
      ?sub meta:submissionStatus status:ARCHIVED
    }
    FILTER NOT EXISTS {
      ?other meta:ontology ?ont ;
             meta:submissionId ?id2 ;
             meta:submissionStatus status:RDF .
      FILTER NOT EXISTS {
        ?other meta:submissionStatus status:ARCHIVED
      }
      FILTER (?id2 > ?id)
    }
  }
  GRAPH meta:Metrics { ?m meta:classes ?classes }
  GRAPH meta:Ontology { ?ont omv:acronym ?acronym }
} ORDER BY DESC(xsd:integer(?classes)) LIMIT 10
\`\`\`

Three things at once, all of them easy to get wrong.

The nested NOT EXISTS means "no newer parsed, live submission for this
ontology". Use it whenever the answer should have one row per ontology. Dropping
it double-counts: six ontologies carry several parsed, non-archived submissions,
and NCBITAXON alone would contribute three rows. Dropping \`status:RDF\` lets in
failed parses, whose metrics survive: TAXREF-LD (ERROR_RDF) would rank third
with 310,008 classes the portal does not show.

Size comes from the **Metrics graph**, via \`meta:metrics\`, not from
\`omv:numberOfClasses\` on the submission. Many current submissions omit the omv
fields even though their archived predecessors carry them, so the omv route
quietly drops most of the large ontologies — it ranks GR-TAX top at 58,598 when
the real answer is NCBITAXON at 722,299.

Note \`xsd:integer\` in the ORDER BY. Metric values are untyped literals, so a
plain DESC sorts them lexically and puts 9 above 722299.

### Who created an ontology

\`\`\`sparql
SELECT ?name ?notation WHERE {
  GRAPH meta:Ontology { ?ont omv:acronym "AGROVOC" }
  GRAPH meta:OntologySubmission {
    ?sub meta:ontology ?ont ;
         meta:submissionStatus status:RDF ;
         omv:hasCreator ?agent .
    FILTER NOT EXISTS { ?sub meta:submissionStatus status:ARCHIVED }
  }
  GRAPH foaf:Agent { ?agent foaf:name ?name }
  OPTIONAL {
    GRAPH foaf:Agent    { ?agent adms:identifier ?id }
    GRAPH adms:Identifier { ?id skos:notation ?notation }
  }
} LIMIT 20
\`\`\`

\`omv:hasCreator\` yields an opaque agent IRI, never a name — resolving it needs
the \`foaf:Agent\` graph, which sits *outside* the \`meta:\` namespace. One more
hop through \`adms:identifier\` reaches an ORCID (people) or ROR (organizations)
in \`adms:Identifier\`. \`foaf:agentType\` separates \`"person"\` from
\`"organization"\`.

### Projects using an ontology

\`\`\`sparql
SELECT ?pname WHERE {
  GRAPH meta:Ontology { ?ont omv:acronym "AGROVOC" }
  GRAPH meta:Project { ?project meta:ontologyUsed ?ont ; meta:name ?pname }
} LIMIT 50
\`\`\`

\`meta:ontologyUsed\` points from a project to the ontologies it uses, so the
join runs project → ontology, not the other way round.

### Counting inside an ontology's content

\`\`\`sparql
SELECT (COUNT(DISTINCT ?c) AS ?concepts) WHERE {
  GRAPH <http://data.bioontology.org/ontologies/GACS/submissions/2> {
    ?c a skos:Concept
  }
}
\`\`\`

The content graph IRI is the submission IRI. Resolve it with
\`resolve_ontology\` first — do not construct it by guessing a submission number.

### Reading labels out of a content graph

\`\`\`sparql
SELECT ?c ?label WHERE {
  GRAPH <http://data.bioontology.org/ontologies/GACS/submissions/2> {
    ?c a skos:Concept ;
       skos:prefLabel ?label .
    FILTER (LANG(?label) = "en")
  }
} LIMIT 100
\`\`\`

Content graphs are ordinary SKOS/OWL — no OntoPortal vocabulary applies inside
them. Some ontologies use SKOS-XL instead, where the label is reached with
\`skosxl:prefLabel/skosxl:literalForm\`.

The \`"en"\` filter is a choice, not a default. GACS tags its labels with 31
languages; E-PHY has none tagged \`en\` — 51,592 labels carry no tag at all and
36 are tagged \`fr\`. An empty result under one language says nothing until the
filter is dropped and the term tried in other languages.
`;

/**
 * Compact orientation embedded in tool descriptions.
 *
 * Unlike a system prompt, an MCP server cannot count on the host injecting its
 * schema card — the model may call `run_sparql` without ever reading it. Tool
 * descriptions ARE always in context, so the few facts that prevent the most
 * expensive mistakes live here. Keep it short: this text is resent on every
 * request, and it competes with the rest of the host's context.
 */
export function orientation(portal: string): string {
  return `${portal} metadata is split across named graphs; always scope with GRAPH.
  meta:Ontology            one record per ontology (omv:acronym, omv:name)
  meta:OntologySubmission  one record per version (omv:description, omv:hasLicense)
  meta:Metrics             sizes — reach via meta:metrics, NOT omv:numberOfClasses
  foaf:Agent               creators and publishers — omv:hasCreator points here,
                           to an opaque IRI, never to a name
  meta:Project             projects, linked to ontologies by meta:ontologyUsed
  <.../ontologies/{ACRONYM}/submissions/{ID}>  that version's SKOS/OWL content
Fields you expect from Dublin Core are OMV here: use omv:name and omv:hasCreator,
NOT dcterms:title or dcterms:creator, which do not exist on these records.
${portal} is multilingual: names, descriptions and labels come in English,
French, Spanish and many more. Before saying something is not in ${portal},
retry with the term translated and without any LANG() filter.
Call get_schema_card for the full predicate list before writing a query.`;
}
