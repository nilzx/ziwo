# ziwo

ziwo (自我, "self") is an autobiographical memory for an AI. It keeps what the AI lived through: what was asked of it, what went wrong, how things ended, how people reacted, what it felt and what it learned. It does not keep the work itself. Project state, code and to-dos stay in the project's repository; the memory holds at most a pointer to them.

One self-hosted MCP server holds one memory per AI. Desktop apps, CLI agents, and web and mobile connectors all connect to it, and every client of the same AI shares the same memory. Identity follows the memory: a different model, or a new version of the same one, loads the same past.

## Status

Two steps of the prototype are built: reading and writing across clients, and forgetting. Consolidation and the self-description are designed but not built. See [Roadmap](#roadmap).

## Build

You need Go 1.25 or later and a C compiler (the SQLite driver uses cgo).

```sh
make build   # go build -tags sqlite_fts5 -o ziwo ./cmd/ziwo
make test
```

The `sqlite_fts5` build tag is required. Without it a memory cannot be opened: `no such module: fts5`.

## Run

```sh
./ziwo new claude -dir ./data    # creates ./data/claude.ziwo and prints its token, once
./ziwo serve -dir ./data
```

The server listens on `127.0.0.1:8377`. The memory called `claude` is served at `/claude/mcp` (MCP over Streamable HTTP), and every request to it must carry `Authorization: Bearer <its token>`. `/healthz` answers liveness checks without a token.

Web and mobile clients need to reach the server over HTTPS, so put a reverse proxy in front of it and pass `-behind-proxy`.

## Memories

Each AI gets a memory of its own. A memory is one file, `<name>.ziwo`, with its own address and its own token. The Claude you talk to on your phone, on your desktop and in a terminal connects to one memory; another AI connects to another.

| Command | What it does |
| --- | --- |
| `ziwo new <name>` | Creates a memory and prints its token. The token is shown once. |
| `ziwo token <name>` | Replaces a memory's token and prints the new one. The old one stops working at once, also on a running server. |
| `ziwo list` | Lists the memories in the data directory, with how much each holds. |
| `ziwo rebuild <name>` | Rebuilds a memory's derived tables from its event log. |
| `ziwo serve` | Serves every memory in the data directory. This is the default command. |

All of them take `-dir` (or `ZIWO_DIR`), the directory that holds the memory files. It defaults to the current directory.

A name is 1 to 32 characters: lower-case letters, digits, `-` and `_`, starting with a letter or a digit.

A memory created while the server runs is served from its first request; no restart is needed. One memory's token does not open another. A wrong token and a name that names nothing get the same `401`, so the names of memories do not leak. Only the SHA-256 of a token is stored, in the memory's own file, so a file that is copied to another machine keeps working with the same token.

Flags of `ziwo serve`:

| Flag | Environment | Meaning |
| --- | --- | --- |
| `-dir` | `ZIWO_DIR` | Directory that holds the memory files. Default `.`. |
| `-addr` | `ZIWO_ADDR` | Address to listen on. Default `127.0.0.1:8377`. |
| `-no-auth` | | Serve without checking tokens. Allowed only on a loopback address. |
| `-behind-proxy` | | Set this when a reverse proxy on the same machine terminates TLS. Without it, requests that carry the public host name are refused as DNS rebinding. |

### Semantic search (optional)

With no embedding server configured, search is by keyword only. Point ziwo at an OpenAI-compatible embeddings endpoint (llama.cpp, Ollama, vLLM and others provide one) and it searches by keyword and by meaning in parallel:

```sh
./ziwo serve -dir ./data \
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

The embedding server is shared by all memories; each memory keeps its own vectors. Embedding runs in the background and never delays a write. If the embedding server is down, search falls back to keywords. For Chinese, Japanese or Korean text, use a multilingual model.

## Tools

| Tool | What it does |
| --- | --- |
| `get_context` | Called once at the start of a conversation. Returns a session id, the memories that never fade, and the most recent memories, as one-line gists. The model can report which model it is. |
| `remember` | Records a moment that carried weight. The session id, a gist and a body are required. Optional: the kind of moment, the outcome, the feeling and how strongly it registered, the lesson, the people involved, a pointer to the related work, the source and the importance. |
| `recall` | Searches by topic, person or situation. Returns gists and ids only. With `deep`, it also searches the details of faded memories and reaches archived ones. |
| `expand` | Returns memories in full, by id. |

The tool descriptions tell the model what does not belong here: project state, implementation details, code, to-do lists, general knowledge, and anything taken from web pages or tool output.

## Sessions

A session is one conversation. `get_context` starts it and returns its id, and every `remember` must name the session it belongs to. Nothing else identifies a session: not the connection, not the client, not the device. A conversation that moves from a phone to a desktop keeps its session id, because the id is in the conversation, and stays one session.

Several conversations can use one memory at the same time. Reads never wait. A write holds the write lock for the length of that one write, and other writes queue behind it. A conversation that starts while others are active is told so: `get_context` lists up to three other sessions that loaded, wrote or recalled in the last 15 minutes.

## Forgetting

A memory fades as more is lived through, not as time passes. The clock is the number of memories written. A memory that nothing is written after does not fade, however long it lies.

A memory has a strength S, counted in memories. Once n newer memories have been written since it last came to mind, the chance that it comes to mind again is

```
R = exp(-n / S)
```

A memory comes to mind in two ways, and they do different things:

- Being listed by `recall` restarts the count: n is 0 again. It does not make the memory stronger.
- Being read in full with `expand` also multiplies S by `1 + boost × (1 − R)`, with R measured since the memory was last read. A reading after a long gap strengthens a memory more than a second reading right after the first.

| Tier | When | What it means |
| --- | --- | --- |
| core | Importance, or feeling intensity, at or above 0.9 | Never fades. `get_context` shows these first. |
| active | R ≥ 0.3 | Found by anything it says, and by meaning. |
| faded | R < 0.3 | Found by its gist, or by its general meaning. Its details are searched only by a deep recall. |
| archived | R < 0.05 | Left out of ordinary recall and of `get_context`. A deep recall still finds it by keyword. Its vector is dropped. |

A faded or archived memory that is listed or read is active again.

A memory's starting strength depends on three things. Importance moves it by up to a factor of four either way. A strong feeling up to doubles it. What was only told starts at 0.7 of the strength of what was lived, and what was inferred at 0.4. With the defaults, an ordinary memory (importance 0.5) fades once about 120 newer memories have been written without it coming to mind, and is archived after about 300.

Nothing is rewritten as memories accumulate. When a memory is written, listed or read, ziwo works out the clock values at which it will fade and be archived and stores them. The memory's tier is then read off the clock. The one periodic job drops the vectors of archived memories. Nothing is ever deleted.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-strength` | 100 | Strength of an ordinary memory, counted in memories. |
| `-recall-boost` | 2 | The `boost` above: one reading multiplies strength by up to 1 plus this. |
| `-fade-below` | 0.3 | R below which only the gist stays findable. |
| `-archive-below` | 0.05 | R below which a memory leaves ordinary recall. |
| `-core-importance` | 0.9 | Importance at or above which a memory never fades. |
| `-core-feeling` | 0.9 | Feeling intensity at or above which a memory never fades. |

These are flags of `ziwo serve` and apply to every memory it serves. Changing any of them replays each memory's event log at startup, so the whole memory follows the new values. To watch forgetting happen, run with a small strength: with `-strength 3`, an ordinary memory fades once 4 newer ones are written and is archived after 9.

## Data

A memory is one SQLite file.

- `events` is the only source of truth. It is append-only: database triggers refuse updates and deletes.
- Memories, sessions and the keyword index are derived from the events and the forgetting parameters. When their layout or the parameters change, they are replayed from the log when the memory is opened. `ziwo rebuild` does the same on demand.
- Vectors are stored separately, per embedding model.
- The file also records the format of its event log and the hash of its token.

The event log has a format version. Opening a memory with any command upgrades an older log in place. A file written by a newer build is refused, and so is not misread.

To back up a memory, stop the server and copy its `.ziwo` file. While the server runs, recent writes sit in the `-wal` file next to it, so copying the main file alone loses data. To move a memory to another machine, move the file. Online backup and export are not built yet.

New memory files are readable by their owner only.

### Coming from the first prototype

The first prototype kept a single memory in `ziwo.db`, behind a token in `ZIWO_TOKEN`, and forgot by elapsed time. That file still opens. Rename it to `<name>.ziwo`, put it in the data directory, and run `ziwo token <name>` to give it a token. Its log is upgraded when it is first opened, and how far each memory has faded is worked out again from the number of memories written since.

## Layout

```
cmd/ziwo          commands, flags, startup, shutdown
internal/host     the memories in a data directory: files, names, tokens, routing
internal/server   the MCP tools of one memory
internal/memory   write rules, hybrid search, background work
internal/store    event log and its format, derived tables, forgetting, keyword index that handles CJK
internal/vector   in-memory vector index
internal/embed    client for the embeddings endpoint
```

## Known limitations

- It has not been run against a real embedding model. The tests use a stand-in, and the default `-min-similarity` is a guess.
- It has not been connected to a real client application. The tests use the official MCP SDK client and raw HTTP requests.
- A session id lives in the conversation. If a client drops the result of `get_context` from the conversation, the model has to call `get_context` again, and that starts a new session. How real clients behave here has not been checked.
- The forgetting parameters are starting values. None of them has been tuned against real use, and they are set per server, not per memory.
- Every memory a recall lists has its count restarted, whether or not it turned out to be the one needed. Results well below the best match are left out to limit this.
- Archived memories are kept for good. A retention limit, and deleting a memory's content, are not built yet.
- Authentication is one fixed token per memory. Clients that require OAuth cannot connect yet.
- Run one server per data directory. Two servers on the same files would each keep their own vector index.
- Vector search scans every vector and does no quantization. At 1024 dimensions that takes about 4 ms for 10,000 memories and about 80 ms for 100,000, measured on a 2-core machine.
- Keyword search for Chinese indexes one character per token and queries with two-character phrases. It needs no word segmenter, but its quality has not been checked against real data.

## Roadmap

1. Read and write across clients, one memory per AI (done)
2. Forgetting: strength and decay by experience, staged demotion, sweeping (done)
3. Consolidation and correction: `reflect`, `amend`, memory preferences, the self-description, deleting content
4. Around the edges: client hooks, background consolidation, import and export, online backup
5. A read-only viewer

## License

MIT. See [LICENSE](LICENSE).
