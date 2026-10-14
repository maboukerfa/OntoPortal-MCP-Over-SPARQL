# AgroPortal SPARQL schema card

315 ontologies, 1825 submissions
(331 not archived).

## Graph layout

Metadata and ontology content live in different named graphs. Choosing the
wrong one returns **zero rows with no error**, so always scope with GRAPH.

Two metadata graphs sit outside the `data.bioontology.org/metadata/` namespace:
agents are in `<http://xmlns.com/foaf/0.1/Agent>` and their ORCID / ROR
identifiers in `<http://www.w3.org/ns/adms#Identifier>`.

| graph | holds | subjects |
|---|---|---|
| `meta:Ontology` | One record per ontology — the catalogue entry. Identity only; descriptive metadata lives on the submission. | 315 |
| `meta:OntologySubmission` | One record per version. Almost all descriptive metadata is here. Reach the ontology with meta:ontology. | 2,929 |
| `meta:Metrics` | Size statistics per submission, reached via meta:metrics. Prefer these over the omv:numberOf* fields, which many current submissions omit. | 1,862 |
| `foaf:Agent` | People and organizations. omv:hasCreator, dcterms:publisher and schema:copyrightHolder point here. foaf:agentType is 'person' or 'organization'. | 1,317 |
| `adms:Identifier` | ORCID and ROR identifiers, reached from an agent via adms:identifier. The value sits on skos:notation. | 852 |
| `meta:Project` | Projects registered on the portal. meta:ontologyUsed links a project to the ontologies it uses. | 92 |
| `meta:Contact` | Submission contact names and emails, reached via meta:contact. | 542 |
| `meta:Review` | User reviews with per-axis ratings, linked by meta:ontologyReviewed. | 3 |
| `meta:MappingProcess` | Term-to-term mappings between ontologies. Large — constrain by meta:source or a specific term before querying. | 426,027 |
| `meta:Category` | Subject categories. An ontology links to these with omv:hasDomain. | 43 |
| `meta:Group` | Ontology groups, linked with meta:group. | 12 |

    CONTENT (large, plain SKOS/OWL — one graph per submission)
  http://data.bioontology.org/ontologies/AGROVOC/submissions/61  (11,591,385)
  http://data.bioontology.org/ontologies/NCBITAXON/submissions/26  (9,649,015)
  http://data.bioontology.org/ontologies/PR/submissions/10  (5,454,437)
  http://data.bioontology.org/ontologies/GACS/submissions/2  (3,339,408)
  http://data.bioontology.org/ontologies/EPPO/submissions/1  (2,363,483)
  http://data.bioontology.org/ontologies/KASSU/submissions/1  (2,212,668)
  http://data.bioontology.org/ontologies/EFO/submissions/99  (1,697,935)
  http://data.bioontology.org/ontologies/AGROVOC-PT-BR/submissions/1  (1,557,598)
  http://data.bioontology.org/ontologies/NALT/submissions/12  (1,416,303)
  http://data.bioontology.org/ontologies/E-PHY/submissions/2  (998,093)
  http://data.bioontology.org/ontologies/FOODEX2/submissions/2  (997,752)
  http://data.bioontology.org/ontologies/OBA/submissions/12  (876,924)

A content graph IRI is `.../ontologies/{ACRONYM}/submissions/{ID}`, and is the
same IRI as the submission record. To query an ontology's concepts you must
first resolve which submission is current.

## Idioms that are easy to get wrong

**Current submission** — this is the trap that bites hardest. Excluding
ARCHIVED is necessary but not sufficient: 8 ontologies carry more
than one non-archived submission, so the filter alone double-counts. Pair it
with a "no newer live sibling" check to get exactly one row per ontology:

    FILTER NOT EXISTS { ?sub meta:submissionStatus status:ARCHIVED }
    FILTER NOT EXISTS {
      ?other meta:ontology ?ont ; meta:submissionId ?id2 .
      FILTER NOT EXISTS { ?other meta:submissionStatus status:ARCHIVED }
      FILTER (?id2 > ?id)
    }

Do not reach for MAX(submissionId) instead: ids are not contiguous (AGROVOC has 58 submissions but a latest id of 61),
so it reads as if it were picking an arbitrary version.

**Ontology size** — use the Metrics graph, not the `omv:numberOf*` fields on
the submission. Many current submissions omit the omv fields while their
archived predecessors carry them, so a query over omv either finds nothing or
silently reports a stale figure. Follow `meta:metrics` into the Metrics graph
and read `meta:classes`, `meta:properties`, `meta:individuals`.

**Who made an ontology** — `omv:hasCreator` does not give you a name. It gives
an agent IRI in the `foaf:Agent` graph; join there for `foaf:name`, and on to
`adms:identifier` → `skos:notation` for an ORCID or ROR.

**Ontology identity** — `omv:acronym` is the short code (AGROVOC),
`omv:name` the display name. There is no `dcterms:title` and no `rdfs:label`
on these records.

**Submission to ontology** — `?sub meta:ontology ?ont` points from the
submission record to the ontology record, which lives in a *different* graph.

## Predicates by graph

### Ontology — `<http://data.bioontology.org/metadata/Ontology>`

One record per ontology — the catalogue entry. Identity only; descriptive metadata lives on the submission.

| predicate | uses |
|---|---|
| `omv:hasDomain` | 877 |
| `meta:administeredBy` | 475 |
| `meta:group` | 453 |
| `omv:name` | 315 |
| `omv:acronym` | 315 |
| `rdf:type` | 315 |
| `meta:viewingRestriction` | 315 |
| `meta:ontologyType` | 315 |
| `meta:summaryOnly` | 297 |
| `meta:viewOf` | 52 |
| `meta:acl` | 50 |
| `mod:sampleQueries` | 10 |

### OntologySubmission — `<http://data.bioontology.org/metadata/OntologySubmission>`

One record per version. Almost all descriptive metadata is here. Reach the ontology with meta:ontology.

| predicate | uses |
|---|---|
| `schema:includedInDataCatalog` | 5980 |
| `meta:submissionStatus` | 4601 |
| `omv:naturalLanguage` | 3785 |
| `omv:hasContributor` | 3705 |
| `omv:useImports` | 2495 |
| `meta:contact` | 2438 |
| `omv:hasCreator` | 2117 |
| `nkos:ontologyRelatedTo` | 2031 |
| `voaf:metadataVoc` | 1992 |
| `meta:submissionId` | 1825 |
| `meta:released` | 1825 |
| `omv:status` | 1824 |
| `nkos:isAlignedTo` | 1823 |
| `rdf:type` | 1823 |
| `omv:hasOntologyLanguage` | 1823 |
| `omv:creationDate` | 1822 |
| `omv:description` | 1821 |
| `meta:ontology` | 1821 |
| `meta:uploadFilePath` | 1820 |
| `void:dataDump` | 1770 |
| `void:openSearchDescription` | 1766 |
| `owl:deprecated` | 1744 |
| `omv:isOfType` | 1742 |
| `meta:csvDump` | 1734 |
| `void:uriLookupEndpoint` | 1733 |
| `omv:URI` | 1703 |
| `omv:version` | 1685 |
| `omv:hasDomain` | 1651 |
| `sd:endpoint` | 1643 |
| `meta:metrics` | 1611 |
| `dcterms:source` | 1591 |
| `idot:exampleIdentifier` | 1565 |
| `meta:prefLabelProperty` | 1561 |
| `meta:definitionProperty` | 1556 |
| `meta:authorProperty` | 1556 |
| `meta:synonymProperty` | 1556 |
| `omv:hasFormalityLevel` | 1534 |
| `omv:hasLicense` | 1471 |
| `vann:preferredNamespacePrefix` | 1436 |
| `meta:pullLocation` | 1404 |
| `omv:hasOntologySyntax` | 1395 |
| `foaf:homepage` | 1380 |
| `omv:documentation` | 1365 |
| `meta:diffFilePath` | 1269 |
| `omv:notes` | 1258 |
| `omv:hasPriorVersion` | 1181 |
| `omv:numberOfClasses` | 1120 |
| `omv:numberOfProperties` | 1119 |
| `omv:numberOfIndividuals` | 1118 |
| `meta:classesWithMoreThan25Children` | 1096 |
| `meta:classesWithNoDefinition` | 1095 |
| `meta:maxDepth` | 1095 |
| `meta:averageChildCount` | 1095 |
| `meta:classesWithOneChild` | 1094 |
| `meta:maxChildCount` | 1094 |
| `dcterms:publisher` | 1064 |
| `dcterms:identifier` | 1049 |
| `omv:endorsedBy` | 965 |
| `omv:usedOntologyEngineeringTool` | 963 |
| `vann:preferredNamespaceUri` | 947 |
| `doap:repository` | 852 |
| `omv:modificationDate` | 842 |
| `owl:versionIRI` | 833 |
| `doap:bugDatabase` | 825 |
| `omv:keywords` | 797 |
| `meta:publication` | 788 |
| `meta:obsoleteProperty` | 772 |
| `meta:modifiedProperty` | 771 |
| `meta:createdProperty` | 771 |
| `meta:homepage` | 749 |
| `meta:hierarchyProperty` | 741 |
| `omv:knownUsage` | 736 |
| `meta:obsoleteParent` | 678 |
| `foaf:fundedBy` | 587 |
| `dcterms:abstract` | 583 |
| `void:uriRegexPattern` | 579 |
| `foaf:logo` | 547 |
| `cc:morePermissions` | 483 |
| `nkos:comesFromTheSameDomain` | 462 |
| `doap:mailingList` | 370 |
| `dcterms:alternative` | 366 |
| `foaf:depiction` | 357 |
| `pav:curatedBy` | 339 |
| `dcterms:isFormatOf` | 303 |
| `meta:missingImports` | 293 |
| `omv:designedForOntologyTask` | 280 |
| `omv:keyClasses` | 276 |
| `schema:copyrightHolder` | 266 |
| `cc:useGuidelines` | 249 |
| `meta:downloadCsv` | 239 |
| `dcterms:hasPart` | 225 |
| `omv:usedOntologyEngineeringMethodology` | 225 |
| `voaf:usedBy` | 199 |
| `prov:wasGeneratedBy` | 165 |
| `dcterms:accrualMethod` | 156 |
| `dcterms:accrualPeriodicity` | 155 |
| `dcterms:coverage` | 153 |
| `dcterms:audience` | 119 |
| `dcterms:accrualPolicy` | 114 |
| `vann:example` | 107 |
| `dcterms:hasFormat` | 104 |
| `omv:isBackwardCompatibleWith` | 93 |
| `nkos:explanationEvolution` | 92 |
| `voaf:toDoList` | 78 |
| `meta:masterFileName` | 71 |
| `dcterms:valid` | 63 |
| `schema:translator` | 62 |
| `omv:conformsToKnowledgeRepresentationParadigm` | 59 |
| `mod:competencyQuestion` | 50 |
| `omv:numberOfAxioms` | 46 |
| `<http://www.isibang.ac.in/ns/mod#competencyQuestion>` | 34 |
| `pav:curatedOn` | 33 |
| `voaf:generalizes` | 30 |
| `skos:hiddenLabel` | 29 |
| `schema:award` | 29 |
| `nkos:similarTo` | 27 |
| `schema:associatedMedia` | 27 |
| `schema:workTranslation` | 8 |
| `void:entities` | 8 |
| `nkos:hasDisparateModelling` | 7 |

### Metrics — `<http://data.bioontology.org/metadata/Metrics>`

Size statistics per submission, reached via meta:metrics. Prefer these over the omv:numberOf* fields, which many current submissions omit.

| predicate | uses |
|---|---|
| `meta:maxDepth` | 1861 |
| `meta:averageChildCount` | 1860 |
| `meta:classesWithNoDefinition` | 1859 |
| `meta:classesWithMoreThan25Children` | 1859 |
| `meta:properties` | 1859 |
| `meta:classes` | 1859 |
| `rdf:type` | 1859 |
| `meta:classesWithOneChild` | 1859 |
| `meta:individuals` | 1859 |
| `meta:created` | 1859 |
| `meta:maxChildCount` | 1859 |

### foaf:Agent — `<http://xmlns.com/foaf/0.1/Agent>`

People and organizations. omv:hasCreator, dcterms:publisher and schema:copyrightHolder point here. foaf:agentType is 'person' or 'organization'.

| predicate | uses |
|---|---|
| `foaf:name` | 1322 |
| `foaf:agentType` | 1244 |
| `foaf:creator` | 1244 |
| `rdf:type` | 1244 |
| `dcterms:created` | 1090 |
| `adms:identifier` | 796 |
| `org:memberOf` | 519 |
| `foaf:homepage` | 338 |
| `skos:altLabel` | 292 |
| `foaf:mbox` | 177 |

### adms:Identifier — `<http://www.w3.org/ns/adms#Identifier>`

ORCID and ROR identifiers, reached from an agent via adms:identifier. The value sits on skos:notation.

| predicate | uses |
|---|---|
| `skos:notation` | 852 |
| `adms:creator` | 852 |
| `adms:schemaAgency` | 852 |
| `rdf:type` | 852 |

### Project — `<http://data.bioontology.org/metadata/Project>`

Projects registered on the portal. meta:ontologyUsed links a project to the ontologies it uses.

| predicate | uses |
|---|---|
| `meta:ontologyUsed` | 529 |
| `meta:creator` | 108 |
| `meta:name` | 92 |
| `meta:updated` | 92 |
| `rdf:type` | 92 |
| `meta:description` | 92 |
| `meta:homePage` | 92 |
| `meta:created` | 92 |
| `meta:acronym` | 92 |
| `meta:institution` | 86 |
| `meta:contacts` | 81 |

### Contact — `<http://data.bioontology.org/metadata/Contact>`

Submission contact names and emails, reached via meta:contact.

| predicate | uses |
|---|---|
| `meta:name` | 542 |
| `meta:email` | 542 |
| `rdf:type` | 542 |

### Review — `<http://data.bioontology.org/metadata/Review>`

User reviews with per-axis ratings, linked by meta:ontologyReviewed.

| predicate | uses |
|---|---|
| `meta:body` | 3 |
| `meta:documentationRating` | 3 |
| `meta:formalityRating` | 3 |
| `meta:ontologyReviewed` | 3 |
| `meta:updated` | 3 |
| `meta:usabilityRating` | 3 |
| `meta:coverageRating` | 3 |
| `rdf:type` | 3 |
| `meta:qualityRating` | 3 |
| `meta:created` | 3 |
| `meta:correctnessRating` | 3 |
| `meta:creator` | 3 |

### MappingProcess — `<http://data.bioontology.org/metadata/MappingProcess>`

Term-to-term mappings between ontologies. Large — constrain by meta:source or a specific term before querying.

| predicate | uses |
|---|---|
| `meta:relation` | 426029 |
| `meta:name` | 426027 |
| `meta:date` | 426027 |
| `rdf:type` | 426027 |
| `meta:creator` | 426027 |
| `meta:comment` | 425997 |
| `meta:source` | 425976 |
| `meta:source_name` | 425973 |
| `meta:object_source_id` | 3 |
| `meta:source_contact_info` | 3 |
| `meta:subject_source_id` | 3 |

### Category — `<http://data.bioontology.org/metadata/Category>`

Subject categories. An ontology links to these with omv:hasDomain.

| predicate | uses |
|---|---|
| `meta:name` | 43 |
| `meta:created` | 43 |
| `meta:acronym` | 43 |
| `rdf:type` | 42 |
| `meta:description` | 42 |
| `meta:parentCategory` | 14 |

### Group — `<http://data.bioontology.org/metadata/Group>`

Ontology groups, linked with meta:group.

| predicate | uses |
|---|---|
| `meta:name` | 12 |
| `rdf:type` | 12 |
| `meta:description` | 12 |
| `meta:created` | 12 |
| `meta:acronym` | 12 |

## Categories

Agricultural engineering (`AG-ENG`), Agricultural products (`AGRI-PROD`), Agricultural research (`AG-RES`), Agriculture (`AGRI`), Agronomy (`AGRO`), Animal husbandry (`HUSB`), Animals (`ANIM`), Biodiversity (`BIODIV`), Biology (`BIO`), Biotechnology (`BIOTECH`), Botany (`BOTA`), Cultivation (`CULT`), Earth sciences (`EARTH`), Ecology (`ECO`), Economics (`ECONOM`), Ecosystems (`ECOSYS`), Entomology (`ENTOM`), Environment (`ENV`), Fisheries (`FISH`), Food (`FOOD`), Food technology (`FOODTECH`), Forestry (`FOREST`), Genetics (`GENE`), Geography (`GEO`), Government (`GOVT`), Health (`HEALTH`), Horticulture (`HORTI`), Law (`LAW`), Life sciences (`LIFE`), Natural resources (`NAT-RES`), Nutrition (`NUT`), Observation (`OBS`), Phenotyping (`PHENO`), Physics (`PHYS`), Physiology (`PHYSIO`), Plant diseases (`PLANT-DIS`), Plant physiology (`PLANT-PHY`), Plants (`PLANT`), Rural development (`RURAL`), Soil (`SOIL`), Technology (`TECH`), Zoology (`ZOO`), mmm (`AGGGj`)

## Groups

Caliper - Statistical Classifications in a Linked Open World (`CALIPER`), Common Agriculture Vocabulary (`CAVOC`), Consortium of Agricultural Biological Databases (`AGBIODATA`), Crop Ontology Curation Tool (`CROP`), Data to Knowledge in Agronomy and Biodiversity (`D2KAB`), Embrapa's Agrotermos conceptual space (`AGROTERMOS`), GDR SemanDiv (`SEMANDIV`), National research institute for agriculture, food and the environment (`INRAE`), OBO Foundry (`OBO-FOUNDRY`), Planteome (`PLANTEOME`), Resources exclusively on AgroPortal (`EXCLU`), Wheat Data Interoperability working group (`WHEAT`)
