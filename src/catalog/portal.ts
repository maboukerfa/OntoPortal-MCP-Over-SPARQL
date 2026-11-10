/**
 * The OntoPortal deployment this server fronts.
 *
 * Every OntoPortal portal shares the data.bioontology.org vocabulary, so
 * switching portals is configuration, not code. The defaults are AgroPortal's
 * because the worked examples and the snapshot card were verified there.
 */

export interface Portal {
  /** What the model calls the portal in tool descriptions, e.g. "AgroPortal". */
  name: string;
  sparqlUrl: string;
}

const DEFAULT_NAME = "AgroPortal";
const DEFAULT_SPARQL_URL = "https://sparql.agroportal.eu/sparql";

export function portalFromEnv(): Portal {
  return {
    name: process.env.PORTAL_NAME ?? DEFAULT_NAME,
    sparqlUrl: process.env.PORTAL_SPARQL_URL ?? DEFAULT_SPARQL_URL,
  };
}
