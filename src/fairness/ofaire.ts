/**
 * Driver layer: the only module that speaks to O'FAIRe, the portal's FAIRness
 * assessment service. Everything above works with Assessment and
 * AssessmentOutcome, never its URL, JSON or charset.
 *
 *   GET {fairnessUrl}&ontologies=WEBVOC
 *     { ontologies: { WEBVOC: {
 *         Findable: { F1: { label, results: { F1Q1: { question, score, ... } } }, ..., score, maxCredits },
 *         Accessible: ..., Interoperable: ..., Reusable: ...,
 *         score: 295, normalizedScore: 61, maxCredits: 478 } },
 *       status: { success: true } }
 *
 * An unknown acronym is a 200 too, with success false and "not found".
 * Acronyms are case-sensitive: "webvoc" is not found.
 */

const HTTP_OK = 200;

/** One assessment takes 2 to 5 s; the service caches. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** What fetch throws when our own deadline fires. */
const DEADLINE_ERRORS = ["TimeoutError", "AbortError"];

/**
 * The service declares ISO-8859-1 and means it: AGROVOC's contacts carry Latin-1
 * bytes. fetch's text() decodes UTF-8 whatever the header says.
 */
const CHARSET = /charset=([\w-]+)/i;
const DEFAULT_CHARSET = "utf-8";

const NOT_FOUND = "not found";

/** O'FAIRe's answer for a question the portal's metadata cannot settle yet. */
const NOT_ASSESSABLE = "cannot be evaluated";

/** In FAIR order. */
const CATEGORIES = ["Findable", "Accessible", "Interoperable", "Reusable"] as const;

export enum AssessmentOutcome {
  Ok = "ok",
  UnknownOntology = "unknown-ontology",
  /** Network failure, a non-200, a body that is not O'FAIRe's, or our deadline. */
  Unavailable = "unavailable",
}

export interface Question {
  /** e.g. "F1Q2". */
  id: string;
  text: string;
  score: number;
  maxCredits: number;
  explanation: string;
  /** The metadata properties the answer read, e.g. { "dct:identifier": "[]" }. */
  properties: Record<string, string>;
  /** False when the portal cannot assess it yet: its credits count as not supported. */
  assessable: boolean;
}

export interface Principle {
  /** e.g. "F1", "A1.1". */
  id: string;
  label: string;
  score: number;
  maxCredits: number;
  /** As O'FAIRe rounds it. */
  percent: number;
  questions: Question[];
}

export interface Category {
  name: (typeof CATEGORIES)[number];
  score: number;
  maxCredits: number;
  /** The credits the portal can award; the rest are not supported yet. */
  portalMaxCredits: number;
  percent: number;
  principles: Principle[];
}

export interface Assessment {
  score: number;
  maxCredits: number;
  percent: number;
  categories: Category[];
}

export type AssessmentResult =
  | { outcome: AssessmentOutcome.Ok; assessment: Assessment }
  | { outcome: AssessmentOutcome.UnknownOntology }
  | { outcome: AssessmentOutcome.Unavailable; message: string };

export interface OfaireOptions {
  /** The service with its portal parameter, e.g. https://services.agroportal.eu/ofaire/?portal=agroportal */
  url: string;
  timeoutMs?: number;
}

// --- O'FAIRe's JSON, as far as we read it -----------------------------------------

interface RawQuestion {
  question?: string;
  score?: number;
  maxCredits?: number;
  explanation?: string;
  properties?: Record<string, unknown>;
}

interface RawPrinciple {
  label?: string;
  results?: Record<string, RawQuestion>;
  score?: number;
  normalizedScore?: number;
  maxCredits?: number;
}

/** Principles by id, beside the category's own totals. */
type RawCategory = Record<string, RawPrinciple | number | undefined>;

type RawOntology = Partial<Record<(typeof CATEGORIES)[number], RawCategory>> & {
  score?: number;
  normalizedScore?: number;
  maxCredits?: number;
};

interface RawResponse {
  ontologies?: Record<string, RawOntology>;
  status?: { success?: boolean; message?: string };
}

function isPrinciple(value: RawPrinciple | number | undefined): value is RawPrinciple {
  return typeof value === "object" && value !== null && "results" in value;
}

function total(category: RawCategory, key: string): number {
  const value = category[key];
  return typeof value === "number" ? value : 0;
}

function question(id: string, raw: RawQuestion): Question {
  const explanation = raw.explanation ?? "";
  return {
    id,
    text: raw.question ?? "",
    score: raw.score ?? 0,
    maxCredits: raw.maxCredits ?? 0,
    explanation,
    properties: Object.fromEntries(
      Object.entries(raw.properties ?? {}).map(([name, value]) => [name, String(value)]),
    ),
    assessable: !explanation.includes(NOT_ASSESSABLE),
  };
}

function principle(id: string, raw: RawPrinciple): Principle {
  return {
    id,
    label: (raw.label ?? "").trim(),
    score: raw.score ?? 0,
    maxCredits: raw.maxCredits ?? 0,
    percent: raw.normalizedScore ?? 0,
    questions: Object.entries(raw.results ?? {}).map(([key, value]) => question(key, value)),
  };
}

function assessment(raw: RawOntology): Assessment {
  return {
    score: raw.score ?? 0,
    maxCredits: raw.maxCredits ?? 0,
    percent: raw.normalizedScore ?? 0,
    categories: CATEGORIES.map((name) => {
      const category = raw[name] ?? {};
      return {
        name,
        score: total(category, "score"),
        maxCredits: total(category, "maxCredits"),
        portalMaxCredits: total(category, "portalMaxCredits"),
        percent: total(category, "normalizedScore"),
        principles: Object.entries(category).flatMap(([id, value]) =>
          isPrinciple(value) ? [principle(id, value)] : [],
        ),
      };
    }),
  };
}

function decode(bytes: ArrayBuffer, contentType: string): string {
  const charset = CHARSET.exec(contentType)?.[1] ?? DEFAULT_CHARSET;
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // An unknown label: the bytes are more likely UTF-8 than nothing.
    return new TextDecoder(DEFAULT_CHARSET).decode(bytes);
  }
}

export class OfaireClient {
  private readonly url: string;
  private readonly timeoutMs: number;

  constructor(options: OfaireOptions) {
    this.url = options.url;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Assess one ontology by its exact acronym. Never throws: an outage is a result. */
  async assess(acronym: string): Promise<AssessmentResult> {
    const target = new URL(this.url);
    target.searchParams.set("ontologies", acronym);

    let response: Response;
    let body: string;
    try {
      response = await fetch(target, { signal: AbortSignal.timeout(this.timeoutMs) });
      body = decode(await response.arrayBuffer(), response.headers.get("content-type") ?? "");
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (DEADLINE_ERRORS.includes(name)) {
        return { outcome: AssessmentOutcome.Unavailable, message: `no answer within ${this.timeoutMs / 1000} s` };
      }
      return { outcome: AssessmentOutcome.Unavailable, message: error instanceof Error ? error.message : String(error) };
    }

    if (response.status !== HTTP_OK) {
      return { outcome: AssessmentOutcome.Unavailable, message: `HTTP ${response.status}: ${body.slice(0, 200)}` };
    }

    let payload: RawResponse;
    try {
      payload = JSON.parse(body);
    } catch {
      return { outcome: AssessmentOutcome.Unavailable, message: `not JSON: ${body.slice(0, 200)}` };
    }

    const raw = payload.ontologies?.[acronym];
    if (payload.status?.success && raw) {
      return { outcome: AssessmentOutcome.Ok, assessment: assessment(raw) };
    }

    const message = payload.status?.message ?? "no assessment in the answer";
    if (message.includes(NOT_FOUND)) {
      return { outcome: AssessmentOutcome.UnknownOntology };
    }
    return { outcome: AssessmentOutcome.Unavailable, message };
  }
}
