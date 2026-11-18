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
  /** The web UI people browse, which answers get linked to. No trailing slash. */
  uiUrl: string;
  /** The O'FAIRe assessment service, with its portal parameter; the ontology is appended. */
  fairnessUrl: string;
}

const DEFAULT_NAME = "AgroPortal";
const DEFAULT_SPARQL_URL = "https://sparql.agroportal.eu/sparql";
const DEFAULT_UI_URL = "https://agroportal.eu";
const DEFAULT_FAIRNESS_URL = "https://services.agroportal.eu/ofaire/?portal=agroportal";

export function portalFromEnv(): Portal {
  return {
    name: process.env.PORTAL_NAME ?? DEFAULT_NAME,
    sparqlUrl: process.env.PORTAL_SPARQL_URL ?? DEFAULT_SPARQL_URL,
    uiUrl: (process.env.PORTAL_UI_URL ?? DEFAULT_UI_URL).replace(/\/+$/, ""),
    fairnessUrl: process.env.PORTAL_FAIRNESS_URL ?? DEFAULT_FAIRNESS_URL,
  };
}
