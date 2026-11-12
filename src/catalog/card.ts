/**
 * The schema card, built from the live endpoint when a host asks for it.
 *
 * The committed card drifted between regenerations — it said 315 ontologies
 * while the endpoint held 316 — and the model takes the card's numbers as
 * fact. Introspection costs about 3 s and 29 small queries: cheap enough to
 * run on demand instead of on a weekly schedule.
 *
 *   current() ──▶ built under an hour ago? ──yes──▶ cached card
 *                      │ no
 *                      ▼
 *                 buildSchemaCard ──▶ endpoint ──complete within 30 s──▶ fresh card, cached
 *                      │ failed, partial or late
 *                      ▼
 *                 schema/schema-card.md, flagged as a snapshot
 *
 * A partial card is worse than an old one. The card says its predicate list
 * is complete, so a graph whose profile query failed would read as "nothing
 * here". Such a build is discarded and the snapshot served instead.
 *
 * profiles() hands the same build to the predicate check. The snapshot is
 * Markdown only, so without a live build it returns null and the check is
 * skipped rather than run against nothing.
 */

import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

import type { SparqlEndpoint } from "../sparql/endpoint.js";
import {
  buildSchemaCard,
  emptyGraphs,
  renderSchemaCard,
  type GraphProfile,
} from "./introspect.js";

/** One build serves a whole conversation, and counts stay within the hour. */
const CARD_TTL_MS = 60 * 60 * 1000;

/** A healthy build takes about 3 s; past this the endpoint is sick and the host is waiting. */
const BUILD_DEADLINE_MS = 30_000;

const SNAPSHOT_NOTE =
  "> The endpoint did not answer, so this is the committed snapshot from " +
  "`npm run schema:gen`. Predicates and idioms rarely change; counts may be out of date.";

function log(message: string): void {
  process.stderr.write(`schema card: ${message}\n`);
}

interface CachedCard {
  markdown: string;
  graphs: GraphProfile[];
  builtAt: number;
}

export class CardService {
  private cached: CachedCard | null = null;
  private building: Promise<CachedCard | null> | null = null;

  /** `locateSnapshot` may throw when there is no snapshot; it only runs once the endpoint has failed. */
  constructor(
    private readonly endpoint: SparqlEndpoint,
    private readonly portal: string,
    private readonly locateSnapshot: () => string,
  ) {}

  /** The card as Markdown: live when the endpoint answers in time, the snapshot otherwise. */
  async current(): Promise<string> {
    const live = await this.live();
    if (live) {
      return live.markdown;
    }

    log("no complete live build; serving the snapshot");
    return `${SNAPSHOT_NOTE}\n\n${readFileSync(this.locateSnapshot(), "utf8")}`;
  }

  /** Every metadata graph with all its predicates, or null when no live build is available. */
  async profiles(): Promise<GraphProfile[] | null> {
    const live = await this.live();
    return live?.graphs ?? null;
  }

  /** The cached build while fresh, else a new one if it lands before the deadline. */
  private async live(): Promise<CachedCard | null> {
    if (this.cached && Date.now() - this.cached.builtAt < CARD_TTL_MS) {
      return this.cached;
    }

    // Race the build against the deadline, then cancel the deadline's timer.
    const cancel = new AbortController();
    const expired = sleep(BUILD_DEADLINE_MS, null, { signal: cancel.signal }).catch(() => null);
    const live = await Promise.race([this.build(), expired]);
    cancel.abort();

    return live;
  }

  /** One build at a time. A build that outlives the deadline still fills the cache for the next call. */
  private build(): Promise<CachedCard | null> {
    this.building ??= this.introspect()
      .catch((error: unknown) => {
        log(`build failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      })
      .finally(() => {
        this.building = null;
      });

    return this.building;
  }

  private async introspect(): Promise<CachedCard | null> {
    const card = await buildSchemaCard(this.endpoint);

    const empty = emptyGraphs(card);
    if (empty.length > 0) {
      log(`no predicates for ${empty.join(", ")}`);
      return null;
    }

    const markdown = renderSchemaCard(card, this.portal);
    this.cached = { markdown, graphs: card.graphs, builtAt: Date.now() };
    return this.cached;
  }
}
