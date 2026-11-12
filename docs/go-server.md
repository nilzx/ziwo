# ziwo: the Go server

ziwo (自我, "self") is an autobiographical memory for an AI. It keeps what the AI lived through: what was asked of it, what went wrong, how things ended, how people reacted, what it felt and what it learned. It does not keep the work itself. Project state, code and to-dos stay in the project's repository; the memory holds at most a pointer to them.

This document describes the Go server at the root of the repository (`cmd/`, `internal/`, `scripts/`, `Makefile`): the first implementation, for self-hosting. One self-hosted MCP server holds one memory per AI. Desktop apps, CLI agents, and web and mobile connectors all connect to it, and every client of the same AI shares the same memory. Identity follows the memory: a different model, or a new version of the same one, loads the same past.

The Go server still builds and is kept, but the current implementation is the one on Cloudflare Workers in `worker/`, specified in [spec.md](spec.md), and it has moved on from this one. Everything below the next section was the project's README while the Go server was the only implementation, and describes the Go server as it stands. Commands run from the repository root.

## How the Go server differs from the Worker

Compared at commit `bc1a625`. "Worker" is the implementation in `worker/`; see [spec.md](spec.md) for its details.

| | Go server | Worker |
| --- | --- | --- |
| Where it runs | One process on your machine; one SQLite file per memory in a data directory | Cloudflare: a stateless Worker in front, one SQLite-backed Durable Object per memory |
| Creating and running memories | The `ziwo` command: `new`, `token`, `list`, `rebuild`, `check`, `export`, `import` | An admin API behind an admin secret, an admin page in the browser, and the `worker/bin/ziwo-admin.mjs` script; memories can also be deleted |
| Authentication | One fixed token per memory; `-no-auth` on a loopback address | A fixed token per memory, or OAuth (dynamic registration, Client ID Metadata Documents, a consent page); a limit on wrong guesses at the consent page and the admin API |
| A memory name in the path that breaks the name rule | `401` | `404` |
| Tools | Seven. Deleting what a memory says for good is the `erase` action of `amend` | Eight. `erase` is a tool of its own, and `amend` no longer takes `erase` |
| Tool annotations | No titles. No tool is marked read-only; every tool but `amend` is marked not destructive | Every tool has a title. `get_context`, `recall`, `expand` and `check` are marked read-only; `erase` is marked destructive; `get_context` carries `anthropic/alwaysLoad` |
| Arguments that do not fit a tool | Answered by the MCP SDK's schema validation | Answered in ziwo's own words, one complaint per field |
| `recall` | `query` is required; one search over the whole query | `query` is optional: without it, `recall` lists the newest memories, by time, without counting as recall. `since` and `until` keep a search or a listing to a span of time. A query that names several things (separated by commas or other list punctuation) is searched whole and part by part, and the results merged |
| Keyword ranking | A keyword match scores relative to the best keyword match | Also: common English function words and Chinese particles are left out of a search unless it has nothing else, and a keyword match is scaled by the share of the query's terms the memory holds |
| `get_context` | Takes `model`. Times are in UTC. Ends with the memories and the hints about archived memories and reflection | Also takes `timezone`. Shows the current time in the session's zone. After the memories comes a fixed line that ends them and says that a line starting with an id in square brackets is the model's own and every other line is the server's; then the server's hints; then a closing paragraph asking the model to write without being asked |
| Text shown on one line | Shown as written | Line breaks in gists, preferences, names and the like are folded into spaces when written and when shown |
| Server instructions and the `remember` description | Write "only at moments that carry weight" | Also ask the model to leave at least one memory of what a conversation was about and where it was left, while the conversation is going on |
| Time zones | None: every time is UTC | A zone per session (from `get_context`) and a default zone per memory; `happened_at` is read in the session's zone |
| Models that loaded a memory | Told apart by the exact name the model gives | Told apart by the name in lower case with punctuation and spaces turned into `-` |
| Forgetting parameters | Flags of `ziwo serve`, the same for every memory | Settings of each memory, changed through the admin API; carried in an export's header when not the defaults |
| Embeddings | Any OpenAI-compatible embeddings endpoint, configured by flags. 32-bit vectors in an in-memory index, scanned whole. Default similarity threshold 0.35. The query waits up to 2 s. 16 memories per batch. An hourly sweep | Workers AI, `@cf/qwen/qwen3-embedding-0.6b` by default, cut to 512 dimensions; vectors stored as 8-bit integers, 256 to a row. Default threshold 0.45. The query is embedded by the Worker, with a second call after 1 s and a limit of 6 s. 32 memories per batch, embedded in the memory object's alarm |
| Reflection in the background | Optional, with an OpenAI-compatible chat model (`-reflect-url`) | Not built: reflection happens only when the model calls `reflect` |
| Export | Sealed by the `ziwo` command, with the passphrase in `ZIWO_EXPORT_KEY` | The admin API hands out and takes the export in the clear; the admin page and the script seal and open it on the owner's side. The sealed format is the same, and exports move between the two builds in both directions |
| After `erase` | SQLite overwrites the freed pages (`secure_delete`) | `secure_delete` is not available; Cloudflare keeps 30 days of point-in-time history of an object's storage, within which the content can be recovered |
| Replaying a log that holds an erasure | The erased memory is marked erased when its writing is replayed, so later events treat it differently from when they were lived | Replays reproduce what was lived; erasing also empties the fields `about` and `context` |
| Event logs in an older format | Upgraded in place | Refused (format 3 only) |
| Derived tables (`derivedVersion`) | 6 | 10 |
| Concurrency | Reads never wait; a write holds a lock for its own length | Each memory's object runs one call at a time |
| Access log | Off unless `-access-log`; includes the client's address | Always on; no address; also records the kind of OAuth step, the JSON-RPC method, and figures about a recall's query embedding |
| One call's size | No fixed limit on a rebuild, export or import | At most 50,000 events, and 24 MiB, in one rebuild, export or import |

## Status

The prototype is built: reading and writing across clients, forgetting, reflection and correction, and backup. It has been tested on its own, and it has been tried with Claude Code in headless mode. It has not yet been tried with the desktop, web or mobile apps. See [Known limitations](#known-limitations) and [Roadmap](#roadmap).

## Build

You need Go 1.25 or later and a C compiler (the SQLite driver uses cgo).

```sh
make build   # go build -tags sqlite_fts5 -o ziwo ./cmd/ziwo
make test
make smoke   # end to end: runs the real binary and talks MCP to it over HTTP
make mutate  # changes one line at a time and expects the tests to notice
```

`make smoke` and `make mutate` need Python 3. The scripts are in `scripts/`.

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
| `ziwo check <name>` | Looks a memory over for problems and prints figures and ids, never what a memory says. Exits with an error if the record is damaged. |
| `ziwo export <name>` | Writes a memory to one sealed file, as a backup. Works while the memory is being served. |
| `ziwo import <name> <file>` | Brings an export back as a new memory. |
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
| `-access-log` | | Log one line per request and per tool call (method, path, status, duration, whether the token opened the memory, client, tool and how it ended) to the server log. Off by default. Never logs what a memory says, a request body, a query or a token. |

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
| `get_context` | Called once at the start of a conversation. Returns a session id, the AI's statements about itself, the rules agreed on about what to remember, the memories that never fade, and the most recent memories, as one-line gists. The model can report which model it is. |
| `remember` | Records a moment that carried weight. The session id, a gist and a body are required. Optional: the kind of moment, the outcome, the feeling and how strongly it registered, the lesson, the people involved, a pointer to the related work, the source and the importance. |
| `recall` | Searches by topic, person or situation. Returns gists and ids only. With `deep`, it also searches the details of faded memories and reaches archived ones. |
| `expand` | Returns memories in full, by id. |
| `reflect` | Puts the moments that were written into accounts, lessons and impressions, and into statements about oneself. Two calls: the first hands out a batch, the second writes back what was made of it. |
| `amend` | Changes how something is remembered when a person asks: retract, pin, reweigh, correct, erase, or set a standing preference. |
| `check` | Looks the memory over for problems and returns figures and the ids of memories worth a second look. |

The tool descriptions tell the model what does not belong here: project state, implementation details, code, to-do lists, general knowledge, and anything taken from web pages or tool output.

## Sessions

A session is one conversation. `get_context` starts it and returns its id, and every write must name the session it belongs to. Nothing else identifies a session: not the connection, not the client, not the device. A conversation that moves from a phone to a desktop keeps its session id, because the id is in the conversation, and stays one session.

Several conversations can use one memory at the same time. Reads never wait. A write holds the write lock for the length of that one write, and other writes queue behind it. A conversation that starts while others are active is told so: `get_context` lists up to three other sessions that loaded, wrote or recalled in the last 15 minutes.

## Reflecting

What `remember` writes is a fragment: one moment, as it happened. `reflect` is where fragments become something more lasting. The first call hands out a batch of fragments that have not been reflected on, those nearest to fading first. The second call writes back entries:

| Entry | What it is | What it rests on |
| --- | --- | --- |
| episode | One account made of several fragments. The fragments stay in the record, become part of the episode, and leave ordinary recall. Marked as a milestone, it never fades. | Fragments that are not part of an episode yet. |
| lesson | Something to carry into next time. | Fragments and episodes. |
| impression | How a person or a thing has come across. A new impression of the same person takes the place of the old one, which is kept. | Fragments and episodes. |
| self | One first-person statement about what the AI is like, with the situation it holds in. | At least three experiences from at least two separate occasions. What it was told or inferred is no basis. A revision needs at least two experiences the statement does not rest on yet. |
| reading | A later understanding of an earlier memory. The memory is not changed; the reading is shown with it, with the model that wrote it. | The memory it is about. |

A round is written back whole or not at all. Fragments that need nothing done are passed over, and a passed fragment leaves ordinary recall after half the base strength unless it comes to mind again.

Only one conversation reflects at a time, so the same fragments are not put together twice. A round that is never written back runs out after 15 minutes.

Nobody presets what the AI says about itself. A statement can only come out of a round of reflection, and only on the evidence above. `get_context` shows the statements first. They describe; they do not instruct.

### In the background

By default a memory is reflected on only when the model calls `reflect` in a conversation. With a chat model configured, the server also reflects by itself once enough moments wait and no conversation has used the memory for a while:

```sh
./ziwo serve -dir ./data \
  -reflect-url http://127.0.0.1:8080/v1/chat/completions \
  -reflect-model your-model-name
```

| Flag | Environment | Meaning |
| --- | --- | --- |
| `-reflect-url` | `ZIWO_REFLECT_URL` | Full URL of an OpenAI-compatible chat endpoint. |
| `-reflect-model` | `ZIWO_REFLECT_MODEL` | Model name. It is recorded as the carrier of what it writes. |
| `-reflect-idle` | | How long no conversation must have used the memory. Default 30 minutes. |
| `-reflect-min` | | How many moments must wait. Default 8. |
| | `ZIWO_REFLECT_KEY` | API key for the endpoint, if it needs one. |

A background round writes episodes, lessons and impressions, and only from the fragments it was shown. It never writes a statement about the self: that is made in conversation, by whoever is living it. If the model's answer cannot be used, nothing is written.

## Amending

A memory is never edited in place. Every change is one more event.

| Action | When a person says | What happens |
| --- | --- | --- |
| `retract` | "No need to remember that." | The memory stays in the record and is no longer recalled. `restore` undoes it. |
| `pin` | "Keep this." | The memory becomes core and does not fade. `unpin` lets it fade again from that point. |
| `reweigh` | "That is not so important." | Its importance changes, and its strength with it. |
| `correct` | "You have that wrong." | A new memory takes its place. The old one stays in the record, marked as replaced, and is reached only by a deep recall. |
| `erase` | "Delete that." | What the memory says is deleted for good. See [Data](#data). |
| `prefer` | "From now on, do not remember this kind of thing." | A standing rule is saved. `get_context` shows the rules to every later conversation. `unprefer` drops one. |

## Writing down the past

A new memory starts empty, but the AI may have a past: old conversations kept as transcripts. In a session where it can read them, the AI can write that past down itself, with `remember` and three things set: `source` is `reconstructed`, `happened_at` is the day it took place, and `pointer` says where the record is. The server never reads transcripts.

Such a memory is dated when it happened and marked as reconstructed. It does not move the experience clock, so writing hundreds of them at once pushes nothing out, and none of them arrives already faded: they all start counting from the moment they are written, and then fade as more is lived, like anything else. They wait for `reflect` like other fragments.

## Nobody reads a memory but its owner

ziwo offers a person no way to browse what an AI remembers. There is no viewer, and no command prints what a memory says. A person finds out what the AI remembers by asking it, and changes it by talking to it.

What an operator can do is look after the file without reading it:

- `ziwo check` reports whether the record is intact, whether the tables agree with the log, and signs that the memory is being used in ways that will not serve it: one conversation writing very many moments, most things marked never to fade, memories that hold code or run very long, statements about the self whose basis was withdrawn. It prints figures and ids. The same check is a tool the AI can call on itself, and the AI can read the memories it names.
- `ziwo export` writes a backup that opens only with a passphrase. See [Data](#data).

The file itself is an ordinary SQLite file on the operator's disk. Nothing technical stops someone from opening it with other tools. The line is in what ziwo provides, not in what it can enforce.

## Forgetting

A memory fades as more is lived through, not as time passes. The clock is the number of moments written as they happened. A memory that nothing is lived after does not fade, however long it lies. What is written about the past afterwards (an entry made by reflecting, a correction, a reconstructed memory) does not move the clock.

A memory has a strength S, counted in moments. Once n more moments have been written since it last came to mind, the chance that it comes to mind again is

```
R = exp(-n / S)
```

A memory comes to mind in two ways, and they do different things:

- Being listed by `recall` restarts the count: n is 0 again. It does not make the memory stronger.
- Being read in full with `expand` also multiplies S by `1 + boost × (1 − R)`, with R measured since the memory was last read. A reading after a long gap strengthens a memory more than a second reading right after the first.

| Tier | When | What it means |
| --- | --- | --- |
| core | Importance, or feeling intensity, at or above 0.9; pinned; a milestone; a statement about oneself | Never fades. `get_context` shows these first. |
| active | R ≥ 0.3 | Found by anything it says, and by meaning. |
| faded | R < 0.3 | Found by its gist, or by its general meaning. Its details are searched only by a deep recall. |
| archived | R < 0.05 | Left out of ordinary recall and of `get_context`. A deep recall still finds it by keyword. Its vector is dropped. |

A faded or archived memory that is listed or read is active again. So is one that is amended.

A memory's starting strength depends on four things. Importance moves it by up to a factor of four either way. A strong feeling up to doubles it. What was only told starts at 0.7 of the strength of what was lived, and what was inferred at 0.4. An episode starts at twice the strength of a fragment, an impression at three times, a lesson at four. With the defaults, an ordinary fragment (importance 0.5) fades once about 120 more moments have been written without it coming to mind, and is archived after about 300.

Nothing is rewritten as memories accumulate. When a memory is written, listed or read, ziwo works out the clock values at which it will fade and be archived and stores them. The memory's tier is then read off the clock. The one periodic job drops the vectors of archived memories. Nothing is ever deleted.

| Flag | Default | Meaning |
| --- | --- | --- |
| `-strength` | 100 | Strength of an ordinary fragment, counted in moments. |
| `-recall-boost` | 2 | The `boost` above: one reading multiplies strength by up to 1 plus this. |
| `-fade-below` | 0.3 | R below which only the gist stays findable. |
| `-archive-below` | 0.05 | R below which a memory leaves ordinary recall. |
| `-core-importance` | 0.9 | Importance at or above which a memory never fades. |
| `-core-feeling` | 0.9 | Feeling intensity at or above which a memory never fades. |

These are flags of `ziwo serve` and apply to every memory it serves. Changing any of them replays each memory's event log at startup, so the whole memory follows the new values. To watch forgetting happen, run with a small strength: with `-strength 3`, an ordinary fragment fades once 4 more moments are written and is archived after 9.

## Data

A memory is one SQLite file.

- `events` is the only source of truth: every write, recall, amendment and round of reflection. It is append-only: database triggers refuse updates and deletes.
- `contents` holds what each memory says, apart from the event that records the memory. It is written once and never changed. It can be deleted, and that is all `erase` deletes.
- Memories, sessions, links, preferences and the keyword index are derived from the events, the contents and the forgetting parameters. When their layout or the parameters change, they are replayed from the log when the memory is opened. `ziwo rebuild` does the same on demand.
- Vectors are stored separately, per embedding model.
- The file also records the format of its event log and the hash of its token.

After `erase`, the log still shows that the memory existed, when, and that it was erased and why. The memory keeps its place in the count of what was lived through. What it said is gone from the file: the content row is deleted, the keyword index is merged so that it no longer holds the words, and SQLite overwrites the freed pages. The embedding is dropped too. Copies of the file made earlier still hold it, and so does the text of any search that quoted it.

The event log has a format version, now 3. Opening a memory with any command upgrades an older log in place. A file written by a newer build is refused, and so is not misread.

To back up a memory, export it:

```sh
export ZIWO_EXPORT_KEY='a passphrase of twelve characters or more'
./ziwo export claude -dir ./data -o claude.ziwo-export
./ziwo import claude claude.ziwo-export -dir ./elsewhere
```

An export holds the event log and what the memories say, compressed and encrypted under the passphrase (AES-256-GCM, with the key derived by PBKDF2). It is never written in the clear, and there is no way to get the passphrase back. It can be made while the server runs and holds one consistent state. A hash is chained through the events, so an export that was cut short or changed is refused. Vectors and derived tables are left out and rebuilt.

`ziwo import` checks the whole export before keeping anything and makes a new memory file from it. The new memory answers to the token the old one had. Its log records that it was brought back and from an export of when, and `get_context` tells the AI so for a week: whatever it lived through between the export and the restore is not there. That one event also tells a restored memory from the one it was exported from, if both go on living.

Stopping the server and copying the `.ziwo` file works too, and is how to move a memory to another machine. While the server runs, recent writes sit in the `-wal` file next to it, so copying the main file alone loses data.

New memory files are readable by their owner only.

### Older files

Files from earlier builds still open. A `.ziwo` file from the previous build is upgraded when it is first opened and keeps its token. The first prototype kept a single memory in `ziwo.db`, behind a token in `ZIWO_TOKEN`, and forgot by elapsed time: rename that file to `<name>.ziwo`, put it in the data directory, and run `ziwo token <name>` to give it a token. How far each memory has faded is worked out again from the number of moments written since.

## Layout

```
cmd/ziwo          commands, flags, startup, shutdown
examples/         client configuration, tried with Claude Code only
internal/host     the memories in a data directory: files, names, tokens, routing
internal/server   the MCP tools of one memory
internal/memory   write rules, hybrid search, amending, reflecting, background work
internal/store    event log and its format, contents, derived tables, forgetting, export, check, keyword index that handles CJK
internal/vector   in-memory vector index
internal/embed    client for the embeddings endpoint
internal/llm      client for the chat endpoint that background reflection uses
internal/sealed   the encryption around an export
scripts/          end-to-end check of the real binary, mutation checks
```

## Known limitations

- It has not been run against a real embedding model. The tests use a stand-in, and the default `-min-similarity` is a guess.
- It has been connected to one real client, Claude Code 2.1.322, in headless conversations only (November 2026, small samples that show direction, not rates). The model called `get_context` in 59 of 60 single-turn conversations (the one miss had no hook and no `alwaysLoad`), and it was reliably the first action only with `alwaysLoad` set. Those conversations were small talk and read-only questions, so none of them wrote a memory. The desktop, web and mobile apps have not been tried. Whether a model calls `reflect` and `amend` at the right moments, and what it writes back, has not been observed.
- A session id lives in the conversation. If a client drops the result of `get_context` from the conversation, the model has to call `get_context` again, and that starts a new session. In Claude Code, 27 of 28 multi-turn conversations stayed one session, including resuming, forking and writing twice. After a compaction, 1 of 10 conversations without the hook called `get_context` again and was recorded as two sessions; with the hook, 10 of 10 kept the session. A forked conversation sees the id of the one it came from and, in the two runs measured, wrote into that same session. Other clients have not been checked.
- Every number in the forgetting and reflecting rules is a starting value: the base strength, the factors for importance, feeling, source and kind, the thresholds, the three-experiences rule for statements about oneself. None has been tuned against real use. The forgetting parameters are set per server, not per memory.
- Every memory a recall lists has its count restarted, whether or not it turned out to be the one needed. Results well below the best match are left out to limit this.
- Nothing limits how many moments one conversation writes. A conversation that writes very many pushes older memories out faster.
- Background reflection has only been run against a stand-in for a chat model. What a real model makes of a batch has not been seen.
- `get_context` shows lists, not a written summary.
- The client configuration in `examples/` has been tried against Claude Code only, not against any other client.
- An export is built in memory before it is written, so it needs room for the whole memory. The thresholds of `check` are starting values.
- A memory that another memory is built on fades on its own schedule; being cited does not protect it.
- Impressions are found by the name they are about, as the model wrote it. Two spellings of one name are two people.
- Archived memories are kept for good. A retention limit is not built.
- Authentication is one fixed token per memory. Clients that require OAuth cannot connect yet.
- Run one server per data directory. Two servers on the same files would each keep their own vector index.
- Vector search scans every vector and does no quantization. At 1024 dimensions that takes about 4 ms for 10,000 memories and about 80 ms for 100,000, measured on a 2-core machine.
- Keyword search for Chinese indexes one character per token and queries with two-character phrases. It needs no word segmenter, but its quality has not been checked against real data.

## Roadmap

1. Read and write across clients, one memory per AI (done)
2. Forgetting: strength and decay by experience, staged demotion, sweeping (done)
3. Reflection and correction: `reflect`, `amend`, preferences, statements about oneself, erasing content, writing down the past from records (done)
4. Around the edges: background reflection, sealed export and import, a check that reads no memory, client hook examples (done)

Next is using it: connecting real clients and a real embedding model, and going through the end-to-end test plan in the design document. A viewer for people was planned and has been dropped; see [Nobody reads a memory but its owner](#nobody-reads-a-memory-but-its-owner).

## License

MIT. See [LICENSE](../LICENSE).
