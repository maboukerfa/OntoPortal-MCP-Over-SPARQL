# agroportal-sparql-mcp

An [MCP](https://modelcontextprotocol.io) server that lets any MCP host —
Claude Code, Claude Desktop, an IDE — query the SPARQL endpoint of
[AgroPortal](https://agroportal.eu), the vocabulary and ontology repository
for agronomy and related domains, without hallucinating its vocabulary.

## Example

Ask your host *"Which three ontologies in AgroPortal have the most classes?"*
The tool description and schema card point the model at the Metrics graph,
and the query they lead to returns (live data, 2026-10-14):

| ontology | classes |
|---|---|
| NCBITAXON | 722,299 |
| PR | 332,990 |
| TAXREF-LD | 310,008 |

The obvious query, over `omv:numberOfClasses`, answers GR-TAX with 58,598.
Nothing about it looks wrong. That gap is what this server exists to close.

## Requirements

- Node.js 20 or later
- Network access to `https://sparql.agroportal.eu/sparql`

## Install

```bash
npm install
npm run build
```

Register with Claude Code:

```bash
claude mcp add agroportal -s user -- \
  node /absolute/path/to/sparql_mcp/dist/src/mcp/server.js
```

Use `-s user` rather than the default `local` scope, or the server binds to
whichever directory you happened to run the command in. Restart the host
afterwards — servers load at startup.

Or in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "agroportal": {
      "command": "node",
      "args": ["/absolute/path/to/sparql_mcp/dist/src/mcp/server.js"]
    }
  }
}
```

## Configuration

| variable | default | purpose |
|---|---|---|
| `AGROPORTAL_SPARQL_URL` | `https://sparql.agroportal.eu/sparql` | Query another OntoPortal deployment. |

The server reads no `.env` file. Set variables in the host's `env` block:

```json
"agroportal": {
  "command": "node",
  "args": ["/absolute/path/to/sparql_mcp/dist/src/mcp/server.js"],
  "env": { "AGROPORTAL_SPARQL_URL": "https://example.org/sparql" }
}
```

### Over HTTP

For hosts that connect to a running server instead of launching one:

```bash
node dist/src/mcp/server.js --transport http        # http://127.0.0.1:8080/mcp
claude mcp add -s user --transport http agroportal http://127.0.0.1:8080/mcp
```

`--host` and `--port` move it. It binds to loopback unless told otherwise and
has no authentication, so expose it only through a proxy that terminates TLS.
Stateless: no session outlives its request, so replicas need no sticky routing.
Browser requests from origins other than this machine get 403.

## Surface

**Tools**

| name | purpose |
|---|---|
| `get_schema_card` | Every metadata graph with its predicates and usage counts, the graph layout, categories, groups, and worked idioms. Call once per conversation before writing SPARQL. |
| `resolve_ontology` | Name or acronym → real IRI + the named graph holding its current content. |
| `run_sparql` | Guarded read-only execution. Returns rows, or a failure with repair advice. |
| `list_terms` | The subject categories or groups, with IRIs. |

**Resources** — `agroportal://schema-card`, `agroportal://examples`, for hosts
that attach context without a tool call.

**Prompt** — `query_agroportal(question)`, a ready-made framing with the card,
idioms and prefixes preloaded.

## Guardrails

`run_sparql` rejects writes and unscoped triple patterns, caps `LIMIT` at 1000,
appends a default `LIMIT 100` when one is missing, and truncates results to 50
rows. Rejections come back as MCP tool errors so the model treats them as
something to fix; empty results come back as *success* with a warning, because
on this endpoint zero rows nearly always means the query was wrong.

## Architecture

The host owns the model and the loop. There is no LLM SDK here and no
orchestration code: repair happens because `run_sparql` returns actionable
advice on failure and the host model calls it again.

    host model  ──calls──▶  tools (src/mcp/server.ts)
                                │
                  Catalog / QueryService / guards
                                │
                        SparqlEndpoint  ──HTTP──▶  Virtuoso

Each layer talks only to the one below it.

### Why a schema card and not RAG

The corpus that matters is small enough to fit in context: about 200 predicates
across 13 metadata graphs, plus categories and groups — about 4k tokens all in.
Retrieval over something that already fits can only lose the predicate you
needed.

The failures that actually happen here are vocabulary hallucination
(`dcterms:title` does not exist; it is `omv:name`), graph misrouting (returns
zero rows and *no error*), Virtuoso's two cost refusals, and the
current-submission trap. Those are fixed by a complete predicate list, entity
grounding, guardrails and a repair loop — not by nearest-neighbour search.

### What the card covers

AgroPortal is not one flat metadata model. It is a small graph of record types
that reference each other, and most real questions cross two or three of them.

| graph | holds |
|---|---|
| `meta:Ontology` | catalogue entry — identity only |
| `meta:OntologySubmission` | one per version; nearly all descriptive metadata |
| `meta:Metrics` | size statistics, via `meta:metrics` |
| `foaf:Agent` | people and organizations |
| `adms:Identifier` | ORCID and ROR identifiers |
| `meta:Project` | projects, via `meta:ontologyUsed` |
| `meta:Contact` | submission contacts |
| `meta:Review` | user reviews with ratings |
| `meta:MappingProcess` | how a batch of mappings was made: source, relation, date |
| `meta:RestBackupMapping` | the mapped term pairs stored on the portal |
| `meta:MappingCount` | mapping totals per ontology pair |
| `meta:Category` | subject categories |
| `meta:Group` | ontology groups |

**Two of these hide outside the portal's namespace.** Agents live in
`<http://xmlns.com/foaf/0.1/Agent>` and their identifiers in
`<http://www.w3.org/ns/adms#Identifier>` — named for the vocabulary class they
hold rather than for AgroPortal. Anything that enumerates graphs by namespace
prefix misses them silently.

The graph list in `src/catalog/introspect.ts` is therefore explicit and
hand-maintained, not discovered: enumerating graphs on this endpoint trips the
ANYTIME budget anyway. **When AgroPortal adds a graph, add it to `PROFILED`.**

The card is generated, not written. The server builds it from the live
endpoint on first request and keeps it for an hour, so its counts are current.
`schema/schema-card.md` is the snapshot it falls back to, flagged as such, when
the endpoint does not answer within 30 s. A partial live build is discarded for
the snapshot.

## Usage log

Each tool call is one JSON line on stderr, and each client one more as it
connects:

    {"ts":"…","event":"session","session":"7f3c…","client":"claude-code","version":"2.1.4"}
    {"ts":"…","event":"tool","session":"7f3c…","tool":"run_sparql","args":{"query":"…"},"ms":842,"outcome":"empty","rows":0}

`outcome` is run_sparql's own; the other tools log `ok`, `empty` (zero
results) or `error`. A session is one stdio process, or one HTTP client: the
server hands it an `Mcp-Session-Id` on its first response and stores nothing
under it. A stdio server's log stays on the user's machine, wherever its host
puts stderr.

```bash
grep '^{' server.log > events.jsonl
duckdb -c "SELECT tool, outcome, count(*) n, quantile_cont(ms, .5) p50,
  quantile_cont(ms, .95) p95 FROM read_json_auto('events.jsonl')
  WHERE event = 'tool' GROUP BY ALL ORDER BY n DESC"
```

No IP address or account is logged, but queries show what someone is
researching: keep them no longer than you need.

## Known data quirks

**Ontology size never comes from `omv:numberOf*`.** Most current submissions
omit those fields even though their archived predecessors carry them, so a query
over omv drops the large ontologies without a word. Follow `meta:metrics` into
the Metrics graph and read `meta:classes` — see the [example](#example).

**`omv:hasCreator` does not give you a name.** It gives an opaque agent IRI.
Two more hops get you a person: `foaf:name` in the `foaf:Agent` graph, then
`adms:identifier` → `skos:notation` for an ORCID or ROR. `foaf:agentType`
separates `"person"` from `"organization"`.

**Excluding `ARCHIVED` is not enough to get one row per ontology.** A few
ontologies keep several non-archived submissions (NCBITAXON has 6). Use the
nested `NOT EXISTS` idiom the card teaches.

**Virtuoso refuses expensive queries two ways.** `S1TAT` means it ran and gave
up under the ANYTIME budget; `42000` with *"estimated execution time … exceeds
the limit"* means the cost estimator declined before running. Both map to
`timeout`. Reading the second as `unavailable` tells the model the endpoint is
down and to stop retrying, which is backwards.

**Smaller ones.** Submission ids are not contiguous, so never guess one.
Metric values are untyped literals, so sort them with `xsd:integer` or 9
outranks 722299. Category `AGGGj` ("mmm") is test junk in the live catalogue.

## Development

```bash
npm run dev                                     # run from source
npm run typecheck
npm run smoke                                   # service layers + the idioms the card teaches
npx tsx scripts/mcp-smoke.ts                    # the protocol, over a real stdio client
npx tsx scripts/mcp-smoke.ts --transport http   # the same, over HTTP
npm run schema:gen                              # regenerate the snapshot card
```

`mcp-smoke.ts` deliberately launches the server from a *different* working
directory, because that is what a host does — it catches the classic MCP bug
where a data file resolves against cwd and silently vanishes in production.

Regenerate the snapshot now and then and commit the diff — it doubles as a
readable changelog of AgroPortal's metadata. The generator refuses to write a
card with an empty graph, so a network failure leaves the last good one in
place.

### Three rules if you edit this

**Never write to stdout.** It is the MCP transport; a stray `console.log`
corrupts the session. Log to stderr.

**Run any new example before adding it.** An example that returns zero rows
teaches the model to write queries that return zero rows. Worse, an example that
returns the *wrong* rows teaches the model to be confidently wrong — the
`omv:numberOfClasses` example did exactly that until a Metrics-graph regression
test caught it.

**Put facts in the card, rules in the tool description.** An MCP server cannot
count on the host injecting its resources; the model may call `run_sparql`
having never read the card. Tool descriptions are always in context, so the few
facts that prevent the most expensive mistakes live in `ORIENTATION`. Everything
else stays behind `get_schema_card`, because description text is resent on every
request.
