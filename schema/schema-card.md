# AgroPortal SPARQL schema card

316 ontologies, 1853 submissions
(333 not archived).

## Graph layout

Metadata and ontology content live in different named graphs. Choosing the
wrong one returns **zero rows with no error**, so always scope with GRAPH.

Two metadata graphs sit outside the `data.bioontology.org/metadata/` namespace:
agents are in `<http://xmlns.com/foaf/0.1/Agent>` and their ORCID / ROR
identifiers in `<http://www.w3.org/ns/adms#Identifier>`.

| graph | holds | subjects |
|---|---|---|
| `meta:Ontology` | One record per ontology — the catalogue entry. Identity only; descriptive metadata lives on the submission. | 316 |
| `meta:OntologySubmission` | One record per version. Almost all descriptive metadata is here. Reach the ontology with meta:ontology. | 2,957 |
| `meta:Metrics` | Size statistics per submission, reached via meta:metrics. Prefer these over the omv:numberOf* fields, which many current submissions omit. | 1,888 |
| `foaf:Agent` | People and organizations. omv:hasCreator, dcterms:publisher and schema:copyrightHolder point here. foaf:agentType is 'person' or 'organization'. | 1,323 |
| `adms:Identifier` | ORCID and ROR identifiers, reached from an agent via adms:identifier. The value sits on skos:notation. | 852 |
| `meta:Project` | Projects registered on the portal. meta:ontologyUsed links a project to the ontologies it uses. | 92 |
| `meta:Contact` | Submission contact names and emails, reached via meta:contact. | 542 |
| `meta:Review` | User reviews with per-axis ratings, linked by meta:ontologyReviewed. | 3 |
| `meta:MappingProcess` | How a batch of mappings was made: source ontology (meta:source), relation, creator, date. Holds no terms; the term pairs are in RestBackupMapping. Large — constrain by meta:source before querying. | 426,027 |
| `meta:RestBackupMapping` | The mappings stored on the portal, one record per term pair: two meta:class_urns, each "urn:ACRONYM:termIRI" (or "ext:..." for a vocabulary outside the portal), and meta:process to its MappingProcess. class_urns are not strings: wrap them in STR() before STRSTARTS. Large — filter on one ontology's urn prefix. | 424,234 |
| `meta:MappingCount` | Mapping totals per ontology pair: two meta:ontologies acronyms as plain strings, and meta:count. Use it for "how many mappings between X and Y" instead of counting RestBackupMapping. Counts linger for deleted ontologies: join meta:Ontology on omv:acronym to keep live ones. | 19,985 |
| `meta:Category` | Subject categories. An ontology links to these with omv:hasDomain. | 43 |
| `meta:Group` | Ontology groups, linked with meta:group. | 12 |

    CONTENT (large, plain SKOS/OWL — one graph per submission)
  http://data.bioontology.org/ontologies/AGROVOC/submissions/61  (11,591,385)
  http://data.bioontology.org/ontologies/NCBITAXON/submissions/26  (9,649,015)
  http://data.bioontology.org/ontologies/PR/submissions/11  (5,454,444)
  http://data.bioontology.org/ontologies/GACS/submissions/2  (3,339,408)
  http://data.bioontology.org/ontologies/EPPO/submissions/1  (2,363,483)
  http://data.bioontology.org/ontologies/KASSU/submissions/1  (2,212,668)
  http://data.bioontology.org/ontologies/EFO/submissions/99  (1,697,935)
  http://data.bioontology.org/ontologies/AGROVOC-PT-BR/submissions/1  (1,557,598)
  http://data.bioontology.org/ontologies/NALT/submissions/12  (1,416,303)
  http://data.bioontology.org/ontologies/E-PHY/submissions/2  (998,093)
  http://data.bioontology.org/ontologies/FOODEX2/submissions/2  (997,752)
  http://data.bioontology.org/ontologies/OBA/submissions/13  (908,083)

A content graph IRI is `.../ontologies/{ACRONYM}/submissions/{ID}`, and is the
same IRI as the submission record. To query an ontology's concepts you must
first resolve which submission is current.

## Idioms that are easy to get wrong

**Current submission** — this is the trap that bites hardest. Excluding
ARCHIVED is necessary but not sufficient: 9 ontologies carry more
than one non-archived submission, so the filter alone double-counts. Pair it
with a "no newer live sibling" check to get exactly one row per ontology:

    FILTER NOT EXISTS { ?sub meta:submissionStatus status:ARCHIVED }
    FILTER NOT EXISTS {
      ?other meta:ontology ?ont ; meta:submissionId ?id2 .
      FILTER NOT EXISTS { ?other meta:submissionStatus status:ARCHIVED }
      FILTER (?id2 > ?id)
    }

Do not reach for MAX(submissionId) instead: ids are not contiguous (AGROVOC has 59 submissions but a latest id of 62),
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
| `omv:hasDomain` | 881 |
| `meta:administeredBy` | 476 |
| `meta:group` | 453 |
| `omv:name` | 316 |
| `omv:acronym` | 316 |
| `rdf:type` | 316 |
| `meta:viewingRestriction` | 316 |
| `meta:ontologyType` | 316 |
| `meta:summaryOnly` | 298 |
| `meta:viewOf` | 52 |
| `meta:acl` | 51 |
| `mod:sampleQueries` | 10 |

### OntologySubmission — `<http://data.bioontology.org/metadata/OntologySubmission>`

One record per version. Almost all descriptive metadata is here. Reach the ontology with meta:ontology.

| predicate | uses |
|---|---|
| `schema:includedInDataCatalog` | 6095 |
| `meta:submissionStatus` | 4639 |
| `omv:naturalLanguage` | 3864 |
| `omv:hasContributor` | 3840 |
| `omv:useImports` | 2599 |
| `meta:contact` | 2481 |
| `omv:hasCreator` | 2159 |
| `nkos:ontologyRelatedTo` | 2128 |
| `voaf:metadataVoc` | 2076 |
| `nkos:isAlignedTo` | 1858 |
| `meta:submissionId` | 1853 |
| `meta:released` | 1853 |
| `omv:status` | 1852 |
| `rdf:type` | 1851 |
| `omv:hasOntologyLanguage` | 1851 |
| `omv:creationDate` | 1850 |
| `omv:description` | 1849 |
| `meta:ontology` | 1849 |
| `meta:uploadFilePath` | 1848 |
| `void:dataDump` | 1798 |
| `void:openSearchDescription` | 1794 |
| `owl:deprecated` | 1772 |
| `omv:isOfType` | 1769 |
| `meta:csvDump` | 1762 |
| `void:uriLookupEndpoint` | 1761 |
| `omv:URI` | 1731 |
| `omv:version` | 1712 |
| `sd:endpoint` | 1673 |
| `omv:hasDomain` | 1659 |
| `dcterms:source` | 1649 |
| `meta:metrics` | 1637 |
| `idot:exampleIdentifier` | 1592 |
| `meta:prefLabelProperty` | 1589 |
| `meta:definitionProperty` | 1584 |
| `meta:authorProperty` | 1584 |
| `meta:synonymProperty` | 1584 |
| `omv:hasFormalityLevel` | 1557 |
| `omv:hasLicense` | 1497 |
| `vann:preferredNamespacePrefix` | 1464 |
| `meta:pullLocation` | 1427 |
| `omv:hasOntologySyntax` | 1415 |
| `foaf:homepage` | 1392 |
| `omv:documentation` | 1379 |
| `meta:diffFilePath` | 1296 |
| `omv:notes` | 1292 |
| `omv:hasPriorVersion` | 1194 |
| `omv:numberOfClasses` | 1120 |
| `omv:numberOfProperties` | 1119 |
| `omv:numberOfIndividuals` | 1118 |
| `meta:classesWithMoreThan25Children` | 1096 |
| `meta:classesWithNoDefinition` | 1095 |
| `meta:maxDepth` | 1095 |
| `meta:averageChildCount` | 1095 |
| `meta:classesWithOneChild` | 1094 |
| `meta:maxChildCount` | 1094 |
| `dcterms:publisher` | 1085 |
| `dcterms:identifier` | 1053 |
| `omv:usedOntologyEngineeringTool` | 980 |
| `vann:preferredNamespaceUri` | 974 |
| `omv:endorsedBy` | 973 |
| `doap:repository` | 869 |
| `omv:modificationDate` | 860 |
| `owl:versionIRI` | 851 |
| `doap:bugDatabase` | 842 |
| `omv:keywords` | 802 |
| `meta:obsoleteProperty` | 800 |
| `meta:modifiedProperty` | 799 |
| `meta:createdProperty` | 799 |
| `meta:publication` | 795 |
| `meta:hierarchyProperty` | 766 |
| `omv:knownUsage` | 752 |
| `meta:homepage` | 749 |
| `meta:obsoleteParent` | 688 |
| `void:uriRegexPattern` | 606 |
| `dcterms:abstract` | 595 |
| `foaf:fundedBy` | 593 |
| `foaf:logo` | 547 |
| `cc:morePermissions` | 485 |
| `nkos:comesFromTheSameDomain` | 466 |
| `doap:mailingList` | 373 |
| `dcterms:alternative` | 368 |
| `foaf:depiction` | 361 |
| `pav:curatedBy` | 342 |
| `meta:missingImports` | 306 |
| `dcterms:isFormatOf` | 305 |
| `omv:designedForOntologyTask` | 282 |
| `omv:keyClasses` | 277 |
| `schema:copyrightHolder` | 267 |
| `cc:useGuidelines` | 250 |
| `meta:downloadCsv` | 239 |
| `dcterms:hasPart` | 228 |
| `omv:usedOntologyEngineeringMethodology` | 227 |
| `prov:wasGeneratedBy` | 209 |
| `voaf:usedBy` | 207 |
| `dcterms:accrualMethod` | 157 |
| `dcterms:accrualPeriodicity` | 156 |
| `dcterms:coverage` | 154 |
| `dcterms:audience` | 122 |
| `dcterms:accrualPolicy` | 115 |
| `vann:example` | 107 |
| `dcterms:hasFormat` | 104 |
| `omv:isBackwardCompatibleWith` | 101 |
| `nkos:explanationEvolution` | 97 |
| `voaf:toDoList` | 80 |
| `meta:masterFileName` | 72 |
| `dcterms:valid` | 63 |
| `schema:translator` | 62 |
| `omv:conformsToKnowledgeRepresentationParadigm` | 60 |
| `mod:competencyQuestion` | 50 |
| `omv:numberOfAxioms` | 46 |
| `<http://www.isibang.ac.in/ns/mod#competencyQuestion>` | 34 |
| `pav:curatedOn` | 33 |
| `nkos:similarTo` | 31 |
| `skos:hiddenLabel` | 30 |
| `voaf:generalizes` | 30 |
| `schema:award` | 29 |
| `schema:associatedMedia` | 28 |
| `schema:workTranslation` | 9 |
| `void:entities` | 8 |
| `nkos:hasDisparateModelling` | 7 |

### Metrics — `<http://data.bioontology.org/metadata/Metrics>`

Size statistics per submission, reached via meta:metrics. Prefer these over the omv:numberOf* fields, which many current submissions omit.

| predicate | uses |
|---|---|
| `meta:maxDepth` | 1887 |
| `meta:averageChildCount` | 1886 |
| `meta:classesWithNoDefinition` | 1885 |
| `meta:classesWithMoreThan25Children` | 1885 |
| `meta:properties` | 1885 |
| `meta:classes` | 1885 |
| `rdf:type` | 1885 |
| `meta:classesWithOneChild` | 1885 |
| `meta:individuals` | 1885 |
| `meta:created` | 1885 |
| `meta:maxChildCount` | 1885 |

### foaf:Agent — `<http://xmlns.com/foaf/0.1/Agent>`

People and organizations. omv:hasCreator, dcterms:publisher and schema:copyrightHolder point here. foaf:agentType is 'person' or 'organization'.

| predicate | uses |
|---|---|
| `foaf:name` | 1328 |
| `foaf:agentType` | 1250 |
| `foaf:creator` | 1250 |
| `rdf:type` | 1250 |
| `dcterms:created` | 1096 |
| `adms:identifier` | 796 |
| `org:memberOf` | 520 |
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

How a batch of mappings was made: source ontology (meta:source), relation, creator, date. Holds no terms; the term pairs are in RestBackupMapping. Large — constrain by meta:source before querying.

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

### RestBackupMapping — `<http://data.bioontology.org/metadata/RestBackupMapping>`

The mappings stored on the portal, one record per term pair: two meta:class_urns, each "urn:ACRONYM:termIRI" (or "ext:..." for a vocabulary outside the portal), and meta:process to its MappingProcess. class_urns are not strings: wrap them in STR() before STRSTARTS. Large — filter on one ontology's urn prefix.

| predicate | uses |
|---|---|
| `meta:class_urns` | 848468 |
| `rdf:type` | 424234 |
| `meta:uuid` | 424234 |
| `meta:process` | 424232 |

### MappingCount — `<http://data.bioontology.org/metadata/MappingCount>`

Mapping totals per ontology pair: two meta:ontologies acronyms as plain strings, and meta:count. Use it for "how many mappings between X and Y" instead of counting RestBackupMapping. Counts linger for deleted ontologies: join meta:Ontology on omv:acronym to keep live ones.

| predicate | uses |
|---|---|
| `meta:ontologies` | 39683 |
| `meta:count` | 19985 |
| `rdf:type` | 19985 |
| `meta:pair_count` | 19984 |

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
