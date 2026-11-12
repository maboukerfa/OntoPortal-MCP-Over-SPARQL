/**
 * OntoPortal's fixed vocabulary: named graphs, prefixes.
 *
 * These IRIs are stable across deployments (AgroPortal inherits the
 * data.bioontology.org namespace from its OntoPortal upstream, even though the
 * portal itself lives at data.agroportal.eu). Anything derived from live data —
 * predicate lists, counts, category values — belongs in the generated schema
 * card, not here.
 */

const METADATA_NS = "http://data.bioontology.org/metadata";

/**
 * Metadata graphs. Each class of record sits in its own named graph, which is
 * the single most important thing to get right — querying the wrong graph
 * returns zero rows rather than an error.
 */
export const GRAPHS = {
  ontology: `${METADATA_NS}/Ontology`,
  submission: `${METADATA_NS}/OntologySubmission`,
  category: `${METADATA_NS}/Category`,
  group: `${METADATA_NS}/Group`,
  metrics: `${METADATA_NS}/Metrics`,
  contact: `${METADATA_NS}/Contact`,
  project: `${METADATA_NS}/Project`,
  review: `${METADATA_NS}/Review`,
  mappingProcess: `${METADATA_NS}/MappingProcess`,
  restBackupMapping: `${METADATA_NS}/RestBackupMapping`,
  mappingCount: `${METADATA_NS}/MappingCount`,
  externalMappings: `${METADATA_NS}/ExternalMappings`,

  // Two graphs sit OUTSIDE the data.bioontology.org/metadata/ namespace, named
  // for the vocabulary class they hold rather than for the portal. Anything
  // that enumerates graphs by namespace prefix misses them silently — which is
  // exactly how the first schema card came to omit the entire agent model, the
  // one that omv:hasCreator points into.
  agent: "http://xmlns.com/foaf/0.1/Agent",
  identifier: "http://www.w3.org/ns/adms#Identifier",
} as const;

export const CLASSES = {
  ontology: `${METADATA_NS}/Ontology`,
  submission: `${METADATA_NS}/OntologySubmission`,
  category: `${METADATA_NS}/Category`,
  group: `${METADATA_NS}/Group`,
} as const;

const OMV_NS = "http://omv.ontoware.org/2005/05/ontology#";

/** OntoPortal-native predicates. */
export const META = {
  name: `${METADATA_NS}/name`,
  acronym: `${METADATA_NS}/acronym`,
  description: `${METADATA_NS}/description`,
  ontology: `${METADATA_NS}/ontology`,
  group: `${METADATA_NS}/group`,
  submissionId: `${METADATA_NS}/submissionId`,
  submissionStatus: `${METADATA_NS}/submissionStatus`,
  viewingRestriction: `${METADATA_NS}/viewingRestriction`,
} as const;

/**
 * OMV carries the fields an LLM expects to find in Dublin Core. This mismatch
 * is the single most common hallucination against this endpoint.
 */
export const OMV = {
  acronym: `${OMV_NS}acronym`,
  name: `${OMV_NS}name`,
  description: `${OMV_NS}description`,
  hasDomain: `${OMV_NS}hasDomain`,
  hasCreator: `${OMV_NS}hasCreator`,
  keywords: `${OMV_NS}keywords`,
  hasOntologyLanguage: `${OMV_NS}hasOntologyLanguage`,
} as const;

/** A submission's format, on omv:hasOntologyLanguage: .../ontology_formats/SKOS, OWL, OBO, UMLS. */
export const ONTOLOGY_FORMAT_NS = "http://data.bioontology.org/ontology_formats/";

/**
 * A submission is superseded when it carries the ARCHIVED status.
 *
 * Filtering out ARCHIVED and requiring RDF is necessary but NOT sufficient to
 * get one row per ontology: 6 ontologies carry several parsed, non-archived
 * submissions (NCBITAXON has 3). Pair the filters with a "no newer live
 * sibling" NOT EXISTS — see the current-submission idiom in the few-shot
 * examples.
 *
 * MAX(submissionId) is wrong: AGROVOC's highest id, 62, is unparsed. And ids
 * are not contiguous, so it reads as if it were picking an arbitrary version.
 */
export const SUBMISSION_STATUS_ARCHIVED =
  "http://data.bioontology.org/submission_statuses/ARCHIVED";

/**
 * A submission is parsed when it carries the RDF status. Until then its
 * content graph is empty: AGROVOC 62 was UPLOADED only while 61 served.
 */
export const SUBMISSION_STATUS_RDF = "http://data.bioontology.org/submission_statuses/RDF";

/** Content graphs are per-submission: .../ontologies/{ACRONYM}/submissions/{ID} */
export const CONTENT_GRAPH_PREFIX = "http://data.bioontology.org/ontologies/";

/**
 * Namespaces of the records the portal has a page for, each IRI ending in the
 * record's acronym: .../categories/AGRI, .../projects/BDG. These IRIs are not
 * pages themselves; data.bioontology.org is an API that refuses browsers.
 */
export const RECORD_NS = {
  ontology: CONTENT_GRAPH_PREFIX,
  category: "http://data.bioontology.org/categories/",
  group: "http://data.bioontology.org/groups/",
  project: "http://data.bioontology.org/projects/",
} as const;

export const PREFIXES: Record<string, string> = {
  meta: `${METADATA_NS}/`,
  status: "http://data.bioontology.org/submission_statuses/",
  omv: "http://omv.ontoware.org/2005/05/ontology#",
  mod: "https://w3id.org/mod#",
  dcterms: "http://purl.org/dc/terms/",
  dc: "http://purl.org/dc/elements/1.1/",
  skos: "http://www.w3.org/2004/02/skos/core#",
  skosxl: "http://www.w3.org/2008/05/skos-xl#",
  owl: "http://www.w3.org/2002/07/owl#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  foaf: "http://xmlns.com/foaf/0.1/",
  schema: "http://schema.org/",
  void: "http://rdfs.org/ns/void#",
  voaf: "http://purl.org/vocommons/voaf#",
  doap: "http://usefulinc.com/ns/doap#",
  pav: "http://purl.org/pav/",
  prov: "http://www.w3.org/ns/prov#",
  cc: "http://creativecommons.org/ns#",
  idot: "http://identifiers.org/idot/",
  vann: "http://purl.org/vocab/vann/",
  adms: "http://www.w3.org/ns/adms#",
  org: "http://www.w3.org/ns/org#",
  sd: "http://www.w3.org/ns/sparql-service-description#",
  nkos: "http://kannel.open.ac.uk/ontology#",
};

/** Ready-to-paste PREFIX block. Stable order keeps the prompt cache warm. */
export function prefixBlock(): string {
  return Object.entries(PREFIXES)
    .map(([short, iri]) => `PREFIX ${short}: <${iri}>`)
    .join("\n");
}

/** Shorten an IRI for display in the schema card. */
export function compact(iri: string): string {
  for (const [short, namespace] of Object.entries(PREFIXES)) {
    if (iri.startsWith(namespace)) {
      return `${short}:${iri.slice(namespace.length)}`;
    }
  }
  return `<${iri}>`;
}
