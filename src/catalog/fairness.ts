/**
 * An ontology's FAIRness, as O'FAIRe assesses it from the portal's metadata
 * record: what the portal's FAIR score section shows.
 *
 *   total 295 / 478 (61%)
 *     Findable 77 / 113          ← category: obtained, missed, not supported yet
 *       F1 21 / 41               ← principle
 *         F1Q2 0 / 11  "External identifier is absent."  dct:identifier: []
 *
 * O'FAIRe matches acronyms case-sensitively, so the catalog resolves the exact
 * one first: a model asking for "webvoc" means WEBVOC.
 */

import {
  AssessmentOutcome,
  type Assessment,
  type OfaireClient,
  type Principle,
  type Question,
} from "../fairness/ofaire.js";
import type { Catalog } from "./catalog.js";

const METHODOLOGY = "O'FAIRe";

/**
 * A property's value, as far as anyone reads it. The name says what to fill;
 * the value can be 24 KB (AGROVOC's mod:ontologyInUse lists every project).
 */
const MAX_VALUE_CHARS = 160;

export interface FairReport extends Assessment {
  ontology: string;
  name: string;
  /** The ontology's page, whose FAIR score section shows the same assessment. */
  portalUrl?: string;
  methodology: string;
}

export enum FairnessOutcome {
  Ok = "ok",
  UnknownOntology = "unknown-ontology",
  Unavailable = "unavailable",
}

export type FairnessResult =
  | { outcome: FairnessOutcome.Ok; report: FairReport }
  | { outcome: FairnessOutcome.UnknownOntology }
  | { outcome: FairnessOutcome.Unavailable; message: string };

function clip(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS - 1)}…` : value;
}

/** The assessment with every property value clipped. */
function clipped(assessment: Assessment): Assessment {
  return {
    ...assessment,
    categories: assessment.categories.map((category) => ({
      ...category,
      principles: category.principles.map((principle) => ({
        ...principle,
        questions: principle.questions.map((question) => ({
          ...question,
          properties: Object.fromEntries(
            Object.entries(question.properties).map(([name, value]) => [name, clip(value)]),
          ),
        })),
      })),
    })),
  };
}

/**
 * A question that cost credits the portal could have awarded: something to fix.
 * Some questions are alternatives: F3Q1 scores 0 / 21 when F3Q2 and F3Q3 already
 * fill F3's 21, so a full principle misses nothing.
 */
function isMissed(question: Question, principle: Principle): boolean {
  return question.assessable && question.score < question.maxCredits && principle.score < principle.maxCredits;
}

export class FairnessService {
  constructor(
    private readonly catalog: Catalog,
    private readonly ofaire: OfaireClient,
  ) {}

  async assess(term: string): Promise<FairnessResult> {
    const wanted = term.trim().toLowerCase();
    const ontology = (await this.catalog.findOntology(term)).find(
      (match) => match.acronym.toLowerCase() === wanted,
    );
    if (!ontology) {
      return { outcome: FairnessOutcome.UnknownOntology };
    }

    const result = await this.ofaire.assess(ontology.acronym);
    if (result.outcome === AssessmentOutcome.UnknownOntology) {
      return { outcome: FairnessOutcome.UnknownOntology };
    }
    if (result.outcome === AssessmentOutcome.Unavailable) {
      return { outcome: FairnessOutcome.Unavailable, message: result.message };
    }

    return {
      outcome: FairnessOutcome.Ok,
      report: {
        ontology: ontology.acronym,
        name: ontology.name,
        portalUrl: ontology.portalUrl,
        methodology: METHODOLOGY,
        ...clipped(result.assessment),
      },
    };
  }
}

/**
 * What the model reads: the scores, and every missed question with the
 * property it checked. The full report, every question and its possible
 * answers, goes to the view.
 */
export function summarize(report: FairReport) {
  return {
    ontology: report.ontology,
    name: report.name,
    portalUrl: report.portalUrl,
    methodology: report.methodology,
    score: report.score,
    maxCredits: report.maxCredits,
    percent: report.percent,
    categories: report.categories.map((category) => ({
      name: category.name,
      score: category.score,
      maxCredits: category.maxCredits,
      notSupportedYet: category.maxCredits - category.portalMaxCredits,
      percent: category.percent,
      principles: category.principles.map(({ id, label, score, maxCredits, percent }) => ({
        id,
        label,
        score,
        maxCredits,
        percent,
      })),
    })),
    missed: report.categories.flatMap((category) =>
      category.principles.flatMap((principle) =>
        principle.questions.filter((question) => isMissed(question, principle)).map((question) => ({
          principle: principle.id,
          question: question.text,
          score: question.score,
          maxCredits: question.maxCredits,
          explanation: question.explanation,
          properties: question.properties,
        })),
      ),
    ),
  };
}
