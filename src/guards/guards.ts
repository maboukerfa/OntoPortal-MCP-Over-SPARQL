/**
 * Cost and safety guardrails for model-generated SPARQL.
 *
 * These run before the query reaches the endpoint. The point is not to be a
 * SPARQL parser — it is to catch the three shapes that reliably melt a shared
 * Virtuoso instance, and to keep the agent read-only. A rejection is returned
 * to the model as text so it can repair, which is why every message says what
 * to do rather than just what is wrong.
 */

const MAX_LIMIT = 1000;
const DEFAULT_LIMIT = 100;

/** Verbs that mutate the store. The agent holds a read-only contract. */
const WRITE_VERBS = [
  "INSERT",
  "DELETE",
  "DROP",
  "CLEAR",
  "CREATE",
  "LOAD",
  "COPY",
  "MOVE",
  "ADD",
];

export enum GuardVerdict {
  Allowed = "allowed",
  Rejected = "rejected",
}

export type GuardResult =
  | { verdict: GuardVerdict.Allowed; query: string }
  | { verdict: GuardVerdict.Rejected; reason: string };

/**
 * Strings, IRIs and comments, matched in one left-to-right pass so whichever
 * comes first hides the others. Stripped one kind after another, the `#` in
 * <...core#prefLabel> read as a comment and swallowed the LIMIT after it.
 */
const OPAQUE = /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|<[^>\s]*>|#[^\n]*/g;

/** Strip strings, IRIs and comments so keyword checks cannot be fooled by literals. */
function skeleton(query: string): string {
  return query.replace(OPAQUE, (token) => {
    if (token.startsWith("#")) {
      return " ";
    }
    if (token.startsWith("<")) {
      return "<>";
    }
    return token.startsWith("'") ? "''" : '""';
  });
}

function hasWriteVerb(bare: string): string | null {
  const upper = bare.toUpperCase();
  for (const verb of WRITE_VERBS) {
    if (new RegExp(`\\b${verb}\\b`).test(upper)) {
      return verb;
    }
  }
  return null;
}

/**
 * An unbounded triple pattern with no graph scope walks every content graph —
 * tens of millions of triples. Virtuoso answers with an ANYTIME timeout, which
 * costs a full round trip to learn nothing.
 */
function isUnscoped(bare: string): boolean {
  const hasGraphScope = /\bGRAPH\b/i.test(bare) || /\bFROM\b/i.test(bare);
  if (hasGraphScope) {
    return false;
  }

  // A lone `?s ?p ?o` with every term a variable and nothing to anchor it.
  return /\?\w+\s+\?\w+\s+\?\w+/.test(bare);
}

function readLimit(bare: string): number | null {
  const match = bare.match(/\bLIMIT\s+(\d+)/i);
  if (!match?.[1]) {
    return null;
  }
  return Number(match[1]);
}

/**
 * Validate and normalise. Returns the query to actually run — a missing LIMIT
 * is appended rather than rejected, because that round trip teaches the model
 * nothing and the user still wants their answer.
 */
export function guard(query: string): GuardResult {
  const trimmed = query.trim();
  if (!trimmed) {
    return { verdict: GuardVerdict.Rejected, reason: "empty query" };
  }

  const bare = skeleton(trimmed);

  const writeVerb = hasWriteVerb(bare);
  if (writeVerb) {
    return {
      verdict: GuardVerdict.Rejected,
      reason: `${writeVerb} is not allowed — this endpoint is read-only. Use SELECT, ASK, CONSTRUCT or DESCRIBE.`,
    };
  }

  if (isUnscoped(bare)) {
    return {
      verdict: GuardVerdict.Rejected,
      reason:
        "Unscoped triple pattern. Wrap the pattern in GRAPH <...> { } — an " +
        "unscoped ?s ?p ?o scans every ontology's content graph and will time out.",
    };
  }

  const limit = readLimit(bare);

  if (limit === null) {
    // ASK returns a boolean and takes no LIMIT.
    if (/\bASK\b/i.test(bare)) {
      return { verdict: GuardVerdict.Allowed, query: trimmed };
    }
    return {
      verdict: GuardVerdict.Allowed,
      query: `${trimmed}\nLIMIT ${DEFAULT_LIMIT}`,
    };
  }

  if (limit > MAX_LIMIT) {
    return {
      verdict: GuardVerdict.Rejected,
      reason: `LIMIT ${limit} exceeds the ${MAX_LIMIT} row ceiling. Aggregate with COUNT/GROUP BY instead of pulling rows.`,
    };
  }

  return { verdict: GuardVerdict.Allowed, query: trimmed };
}
