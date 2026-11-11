# ziwo

ziwo (自我, "self") is an autobiographical memory for an AI. It keeps what the AI lived through: what was asked of it, what went wrong, how things ended, how people reacted, what it felt and what it learned. It does not keep the work itself. Project state, code and to-dos stay in the project's repository; the memory holds at most a pointer to them.

One self-hosted MCP server holds the memory. Desktop apps, CLI agents, and web and mobile connectors all connect to it and share the same store. Identity follows the memory: a different model, or a new version of the same one, loads the same past.

## Status

This is the first step of a prototype: reading and writing work across clients. Forgetting, consolidation and the self-description are designed but not built. See [Roadmap](#roadmap).

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
| `get_context` | Called once at the start of a conversation. Returns a session id and the most recent memories as one-line gists. The model can report which model it is. |
| `remember` | Records a moment that carried weight. A gist and a body are required. Optional: the kind of moment, the outcome, the feeling, the lesson, the people involved, a pointer to the related work, the source and the importance. |
| `recall` | Searches by topic, person or situation. Returns gists and ids only. |
| `expand` | Returns memories in full, by id. |

The tool descriptions tell the model what does not belong here: project state, implementation details, code, to-do lists, general knowledge, and anything taken from web pages or tool output.

## Data

Everything lives in one SQLite file.

- `events` is the only source of truth. It is append-only: database triggers refuse updates and deletes.
- Memories, sessions and the keyword index are derived from the events. When their layout changes, they are replayed from the log at startup. `-rebuild` does the same on demand.
- Vectors are stored separately, per embedding model.

To back up, stop the server and copy the database file. While the server runs, recent writes sit in the `-wal` file, so copying the main file alone loses data. Online backup and export are not built yet.

## Layout

```
cmd/ziwo          flags, startup, shutdown
internal/store    event log, derived tables, keyword index that handles CJK
internal/vector   in-memory vector index
internal/embed    client for the embeddings endpoint
internal/memory   write rules, session attribution, hybrid search, background work
internal/server   MCP tools and authentication
```

## Known limitations

- It has not been run against a real embedding model. The tests use a stand-in, and the default `-min-similarity` is a guess.
- It has not been connected to a real client application. The tests use the official MCP SDK client and raw HTTP requests.
- Authentication is a single fixed token. Clients that require OAuth cannot connect yet.
- Vector search scans every vector and does no quantization. At 1024 dimensions that takes about 4 ms for 10,000 memories and about 80 ms for 100,000, measured on a 2-core machine.
- Keyword search for Chinese indexes one character per token and queries with two-character phrases. It needs no word segmenter, but its quality has not been checked against real data.

## Roadmap

1. Read and write across clients (done)
2. Forgetting: strength and decay, sweeping, staged demotion
3. Consolidation and correction: `reflect`, `amend`, memory preferences, the self-description
4. Around the edges: client hooks, background consolidation, import and export, online backup
5. A read-only viewer

## License

MIT. See [LICENSE](LICENSE).
