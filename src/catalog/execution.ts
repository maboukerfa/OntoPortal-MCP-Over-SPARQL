/**
 * Guarded query execution.
 *
 * This is where the repair loop actually lives: every failure mode becomes a
 * sentence the model can act on. An empty result is reported as a *problem*
 * rather than an answer, because against this endpoint zero rows almost always
 * means a wrong graph or a hallucinated predicate — not "nothing matches".
 */

import { GuardVerdict, guard } from "../guards/guards.js";
import { QueryOutcome, SparqlEndpoint } from "../sparql/endpoint.js";

/** Rows returned to the model. Beyond this it is summarising, not reading. */
const MAX_ROWS_TO_MODEL = 50;

export interface ExecutionReport {
  outcome: QueryOutcome | "rejected";
  /** The query as actually sent, after guard normalisation. */
  executed?: string;
  vars?: string[];
  rows?: Record<string, string>[];
  rowCount?: number;
  truncated?: boolean;
  advice?: string;
}

const EMPTY_ADVICE =
  "Zero rows. On this endpoint that usually means the GRAPH is wrong or a " +
  "predicate does not exist, not that nothing matches. Check the predicate " +
  "against the schema card, and confirm you are in the metadata graph rather " +
  "than a content graph (or the reverse). Try relaxing one clause at a time. " +
  "If the query matches text, the data may be in another language: retry with " +
  "the term translated (French, Spanish, ...) and drop any LANG() filter.";

const TIMEOUT_ADVICE =
  "The endpoint refused this query as too expensive — it either exhausted the " +
  "ANYTIME budget or was declined up front by the cost estimator. The endpoint " +
  "is healthy; the query is the problem. Scope it to a single GRAPH, put a more " +
  "selective pattern first, drop any self-join over a large content graph, or " +
  "aggregate with COUNT instead of returning rows.";

export class QueryService {
  constructor(private readonly endpoint: SparqlEndpoint) {}

  async run(query: string): Promise<ExecutionReport> {
    const checked = guard(query);

    if (checked.verdict === GuardVerdict.Rejected) {
      return { outcome: "rejected", advice: checked.reason };
    }

    const result = await this.endpoint.select(checked.query);

    if (result.outcome === QueryOutcome.Invalid) {
      return {
        outcome: result.outcome,
        executed: checked.query,
        advice: `The endpoint rejected this query: ${result.message}`,
      };
    }

    if (result.outcome === QueryOutcome.Timeout) {
      return {
        outcome: result.outcome,
        executed: checked.query,
        advice: TIMEOUT_ADVICE,
      };
    }

    if (result.outcome === QueryOutcome.Unavailable) {
      return {
        outcome: result.outcome,
        executed: checked.query,
        advice: `The endpoint could not be reached: ${result.message}. Do not retry more than once.`,
      };
    }

    if (result.outcome === QueryOutcome.Empty) {
      return {
        outcome: result.outcome,
        executed: checked.query,
        vars: result.vars,
        rows: [],
        rowCount: 0,
        advice: EMPTY_ADVICE,
      };
    }

    const all = SparqlEndpoint.plain(result.rows);
    const shown = all.slice(0, MAX_ROWS_TO_MODEL);

    return {
      outcome: result.outcome,
      executed: checked.query,
      vars: result.vars,
      rows: shown,
      rowCount: all.length,
      truncated: shown.length < all.length,
    };
  }
}
