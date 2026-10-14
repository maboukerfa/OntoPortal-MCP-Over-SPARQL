/**
 * Driver layer: the only module that speaks HTTP and Virtuoso dialect.
 *
 * Everything above this file works with SparqlResult / QueryOutcome and never
 * sees a status code, a MIME type, or a Virtuoso error string.
 */

const HTTP_OK = 200;

/** Virtuoso surfaces its SQL state in the body prefix: "Virtuoso <code> Error ..." */
const VIRTUOSO_SYNTAX_STATE = "37000";
const VIRTUOSO_TIMEOUT_STATE = "S1TAT";

/**
 * Virtuoso refuses a query two different ways, and they look nothing alike.
 *
 *   S1TAT  — ran, then gave up under the ANYTIME budget
 *   42000  — never ran; the cost estimator priced it and declined up front
 *            ("The estimated execution time 57289 (sec) exceeds the limit of 400")
 *
 * Both mean "too expensive, simplify it", so both must map to Timeout. 42000 is
 * a generic Virtuoso state shared with unrelated errors, so match the estimator
 * phrase rather than the bare code.
 */
const VIRTUOSO_COST_REFUSAL = "estimated execution time";

const SPARQL_JSON = "application/sparql-results+json";

/** The endpoint is shared infrastructure; keep a client-side ceiling below its own. */
const DEFAULT_TIMEOUT_MS = 60_000;

export enum QueryOutcome {
  /** Query ran and returned at least one row. */
  Ok = "ok",
  /** Query ran and returned zero rows — usually a wrong graph or predicate, not an error. */
  Empty = "empty",
  /** Virtuoso refused to compile it: bad syntax, undefined prefix. */
  Invalid = "invalid",
  /** Too expensive: either the ANYTIME budget ran out or the cost estimator declined it. */
  Timeout = "timeout",
  /** Network failure, 5xx that is not a Virtuoso error, or client-side abort. */
  Unavailable = "unavailable",
}

export type SparqlBinding = Record<string, { type: string; value: string }>;

export type SparqlResult =
  | { outcome: QueryOutcome.Ok; vars: string[]; rows: SparqlBinding[] }
  | { outcome: QueryOutcome.Empty; vars: string[]; rows: [] }
  | { outcome: QueryOutcome.Invalid; message: string }
  | { outcome: QueryOutcome.Timeout; message: string }
  | { outcome: QueryOutcome.Unavailable; message: string };

export interface EndpointOptions {
  url: string;
  timeoutMs?: number;
}

/**
 * Map a Virtuoso error body onto an outcome.
 *
 * Bodies look like:
 *   Virtuoso 37000 Error SP030: SPARQL compiler, line 2: Undefined namespace prefix ...
 *   Virtuoso S1TAT Error Query did not complete due to ANYTIME timeout.
 */
function classifyError(body: string): SparqlResult {
  const message = body.trim().split("\n\n")[0] ?? body.trim();

  if (body.includes(VIRTUOSO_TIMEOUT_STATE) || body.includes(VIRTUOSO_COST_REFUSAL)) {
    return { outcome: QueryOutcome.Timeout, message };
  }

  if (body.includes(VIRTUOSO_SYNTAX_STATE)) {
    return { outcome: QueryOutcome.Invalid, message };
  }

  return { outcome: QueryOutcome.Unavailable, message };
}

export class SparqlEndpoint {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(options: EndpointOptions) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Run a SELECT/ASK query. Never throws for a query-level problem — a bad
   * query is a result, because the repair loop above needs to read the error
   * text and try again.
   */
  async select(query: string): Promise<SparqlResult> {
    const target = `${this.url}?query=${encodeURIComponent(query)}`;
    const abort = AbortSignal.timeout(this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(target, {
        headers: { Accept: SPARQL_JSON },
        signal: abort,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { outcome: QueryOutcome.Unavailable, message };
    }

    const body = await response.text();

    if (response.status !== HTTP_OK) {
      return classifyError(body);
    }

    // A 200 with an unparseable body means the endpoint answered with something
    // other than SPARQL JSON — treat it as infrastructure trouble, not a bad query.
    let payload: {
      head?: { vars?: string[] };
      results?: { bindings?: SparqlBinding[] };
    };
    try {
      payload = JSON.parse(body);
    } catch {
      return {
        outcome: QueryOutcome.Unavailable,
        message: `endpoint returned non-JSON: ${body.slice(0, 200)}`,
      };
    }

    const vars = payload.head?.vars ?? [];
    const rows = payload.results?.bindings ?? [];

    if (rows.length === 0) {
      return { outcome: QueryOutcome.Empty, vars, rows: [] };
    }

    return { outcome: QueryOutcome.Ok, vars, rows };
  }

  /** Flatten bindings to plain values — convenience for the service layer. */
  static plain(rows: SparqlBinding[]): Record<string, string>[] {
    return rows.map((row) => {
      const flat: Record<string, string> = {};
      for (const [key, cell] of Object.entries(row)) {
        flat[key] = cell.value;
      }
      return flat;
    });
  }
}
