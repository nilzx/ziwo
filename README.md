# ziwo

ziwo (自我, "self") is an autobiographical memory for an AI. It keeps what the AI lived through: what was asked of it, what went wrong, how things ended, how people reacted, what it felt and what it learned. It does not keep the work itself. Project state, code and to-dos stay in the project's repository; the memory holds at most a pointer to them.

One self-hosted MCP server holds the memory. Desktop apps, CLI agents, and web and mobile connectors all connect to it and share the same store. Identity follows the memory: a different model, or a new version of the same one, loads the same past.

## Status

Two steps of the prototype are built: reading and writing across clients, and forgetting. Consolidation and the self-description are designed but not built. See [Roadmap](#roadmap).

## Build

You need Go 1.25 or later and a C compiler (the SQLite driver uses cgo).

```sh
make build   # go build -tags sqlite_fts5 -o ziwo ./cmd/ziwo
make test
```

The `sqlite_fts5` build tag is required. Without it the server stops at startup with `no such module: fts5`.

## Run

```sh
ZIWO_TOKEN=a-long-random-string ./ziwo -db ziwo.db
```

The server listens on `127.0.0.1:8377`. The MCP endpoint is `/mcp` (Streamable HTTP), and `/healthz` answers liveness checks. Every MCP request must carry `Authorization: Bearer <token>`.

| Flag | Environment | Meaning |
| --- | --- | --- |
| `-addr` | `ZIWO_ADDR` | Address to listen on. Default `127.0.0.1:8377`. |
| `-db` | `ZIWO_DB` | Database file. Default `ziwo.db`. |
| | `ZIWO_TOKEN` | Access token. Read from the environment only. |
| `-no-auth` | | Serve without a token. Allowed only on a loopback address. |
| `-behind-proxy` | | Set this when a reverse proxy on the same machine terminates TLS. Without it, requests that carry the public host name are refused as DNS rebinding. |
| `-rebuild` | | Rebuild the derived tables from the event log, then exit. |

Web and mobile clients need to reach the server over HTTPS, so put a reverse proxy in front of it and pass `-behind-proxy`.

### Semantic search (optional)

With no embedding server configured, search is by keyword only. Point ziwo at an OpenAI-compatible embeddings endpoint (llama.cpp, Ollama, vLLM and others provide one) and it searches by keyword and by meaning in parallel:

```sh
ZIWO_TOKEN=... ./ziwo -db ziwo.db \
  -embed-url http://127.0.0.1:8080/v1/embeddings \
  -embed-model your-model-name
```

| Flag | Environment | Meaning |
| --- | --- | --- |
| `-embed-url` | `ZIWO_EMBED_URL` | Full URL of the embeddings endpoint. |
| `-embed-model` | `ZIWO_EMBED_MODEL` | Model name. After a change, old vectors are ignored and new ones are computed in the background. |
| `-embed-query-prefix` | `ZIWO_EMBED_QUERY_PREFIX` | Prefix the model expects before a query, such as `query: `. |
| `-embed-passage-prefix` | `ZIWO_EMBED_PASSAGE_PREFIX` | Prefix the model expects before stored text, such as `passage: `. |
| `-min-similarity` | | Lowest cosine similarity that counts as a match. Default 0.35. Tune it for your model. |
| | `ZIWO_EMBED_KEY` | API key for the embeddings endpoint, if it needs one. |

Embedding runs in the background and never delays a write. If the embedding server is down, search falls back to keywords. For Chinese, Japanese or Korean text, use a multilingual model.

## Tools

| Tool | What it does |
| --- | --- |
| `get_context` | Called once at the start of a conversation. Returns a session id, the memories that never fade, and the most recent memories, as one-line gists. The model can report which model it is. |
| `remember` | Records a moment that carried weight. A gist and a body are required. Optional: the kind of moment, the outcome, the feeling and how strongly it registered, the lesson, the people involved, a pointer to the related work, the source and the importance. |
| `recall` | Searches by topic, person or situation. Returns gists and ids only. With `deep`, it also searches the details of faded memories and reaches archived ones. Every memory it returns is strengthened. |
| `expand` | Returns memories in full, by id. Reading a memory in full strengthens it too. |

The tool descriptions tell the model what does not belong here: project state, implementation details, code, to-do lists, general knowledge, and anything taken from web pages or tool output.

## Forgetting

A memory has a strength S, in days. After t days without being recalled, the chance that it comes to mind is

```
R = exp(-t / S)
```

Recalling it resets t and multiplies S by `1 + boost × (1 − R)`, so a recall after a long gap strengthens a memory more than a second recall right after the first.

| Tier | When | What it means |
| --- | --- | --- |
| core | Importance, or feeling intensity, at or above 0.9 | Never fades. `get_context` shows these first. |
| active | R ≥ 0.3 | Found by anything it says, and by meaning. |
| faded | R < 0.3 | Found by its gist, or by its general meaning. Its details are searched only by a deep recall. |
| archived | R < 0.05 | Left out of ordinary recall and of `get_context`. A deep recall still finds it by keyword. Its vector is dropped. |

Being returned by `recall` or read with `expand` counts as a recall. The memory is strengthened, and if it had faded or been archived it is active again.

A memory's starting strength depends on three things. Importance moves it by up to a factor of four either way. A strong feeling up to doubles it. What was only told starts at 0.7 of the strength of what was lived, and what was inferred at 0.4. With the defaults, an ordinary memory (importance 0.5) fades after about 36 days without recall and is archived after about 90.

Nothing is rewritten as time passes. When a memory is written or recalled, ziwo works out the moments at which it will fade and be archived and stores them. The memory's tier is then read off the clock. The one periodic job drops the vectors of archived memories. Nothing is ever deleted.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-strength-days` | 30 | Strength of an ordinary memory, in days. |
| `-recall-boost` | 2 | The `boost` above: one recall multiplies strength by up to 1 plus this. |
| `-fade-below` | 0.3 | R below which only the gist stays findable. |
| `-archive-below` | 0.05 | R below which a memory leaves ordinary recall. |
| `-core-importance` | 0.9 | Importance at or above which a memory never fades. |
| `-core-feeling` | 0.9 | Feeling intensity at or above which a memory never fades. |

Changing any of these replays the event log at startup, so the whole memory follows the new values. To watch forgetting happen, run with a tiny strength: with `-strength-days 0.0007`, an ordinary memory fades after about 70 seconds and is archived after about three minutes.

## Data

Everything lives in one SQLite file.

- `events` is the only source of truth. It is append-only: database triggers refuse updates and deletes.
- Memories, sessions and the keyword index are derived from the events and the forgetting parameters. When their layout or the parameters change, they are replayed from the log at startup. `-rebuild` does the same on demand.
- Vectors are stored separately, per embedding model.

To back up, stop the server and copy the database file. While the server runs, recent writes sit in the `-wal` file, so copying the main file alone loses data. Online backup and export are not built yet.

## Layout

```
cmd/ziwo          flags, startup, shutdown
internal/store    event log, derived tables, the forgetting curve, keyword index that handles CJK
internal/vector   in-memory vector index
internal/embed    client for the embeddings endpoint
internal/memory   write rules, session attribution, hybrid search, background work
internal/server   MCP tools and authentication
```

## Known limitations

- It has not been run against a real embedding model. The tests use a stand-in, and the default `-min-similarity` is a guess.
- It has not been connected to a real client application. The tests use the official MCP SDK client and raw HTTP requests.
- The forgetting parameters are starting values. None of them has been tuned against real use.
- Every memory a recall returns is strengthened, whether or not it turned out to be the one needed. Results well below the best match are left out to limit this.
- Archived memories are kept for good. A retention limit, and deleting a memory's content, are not built yet.
- Authentication is a single fixed token. Clients that require OAuth cannot connect yet.
- Vector search scans every vector and does no quantization. At 1024 dimensions that takes about 4 ms for 10,000 memories and about 80 ms for 100,000, measured on a 2-core machine.
- Keyword search for Chinese indexes one character per token and queries with two-character phrases. It needs no word segmenter, but its quality has not been checked against real data.

## Roadmap

1. Read and write across clients (done)
2. Forgetting: strength and decay, staged demotion, sweeping (done)
3. Consolidation and correction: `reflect`, `amend`, memory preferences, the self-description, deleting content
4. Around the edges: client hooks, background consolidation, import and export, online backup
5. A read-only viewer

## License

MIT. See [LICENSE](LICENSE).
