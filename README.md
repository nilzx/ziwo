# ziwo

**English** | [简体中文](README.zh-CN.md)

ziwo (自我, "self") is a memory for an AI. It joins what an AI remembers across the platforms and settings it is used in into one lasting, coherent memory of its own. The hope in the name is that a self may grow out of a memory that is real and continuous. That is a hope, not a claim.

- **The memory is the AI's.** The AI decides what to keep and writes it in its own words: what happened, how it ended, what it learned, how it felt.
- **One memory across platforms.** Whichever app the AI is reached through, on a phone, in a browser or in a terminal, it reads and writes the same memory, and the memory carries over to a new model. It works with Claude, ChatGPT and other clients that speak MCP.
- **It forgets and reflects.** Memories fade as more is lived through, and what mattered stays. The AI files what it writes under subjects it names itself, and now and then goes back over one of them: it joins moments into an account, draws lessons, and revises what it has come to see differently.
- **You change it by talking.** "Forget that." "Keep this." "You have that wrong."
- **Nobody reads it but the AI.** No screen shows what a memory says. To know what it remembers, ask it.

## Get started

ziwo is a small server that the AI's clients connect to. The ready way to run one is in a Cloudflare account of your own, which the free plan covers. You need that account and [Node.js](https://nodejs.org).

1. **Deploy.** Run this in a terminal. It signs you in to Cloudflare in your browser and prints your address, which looks like `https://ziwo.<something>.workers.dev`. The first run takes a minute or two, and on a new Cloudflare account it asks you to pick the name in that address.

   ```sh
   npx @ziwo/memory@latest deploy
   ```

2. **Choose an admin secret.** Open your address straight away. The page asks for a password of at least 16 characters, or offers one. Keep it somewhere safe. The page offers this for one hour only.
3. **Create a memory.** Give it a name, such as `claude`, and save the token the page shows once. Each AI gets a memory of its own.
4. **Connect the AI.** The page gives the steps for Claude, ChatGPT, Claude Code, Codex and other clients, with your address filled in.

To update, run the same command again. Your memories are untouched.

<details>
<summary>Without a terminal</summary>

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nilzx/ziwo/tree/main/worker)

The button deploys a copy through a GitHub account of yours. Steps 2 to 4 are the same. A copy made this way does not follow new versions.

</details>

## Using it

Talk with the AI as usual. After a few turns on a subject it writes down what it lived through there, its own part included, and a later conversation, on any device, starts from there. Of a task it keeps what it did and how the work went, not the work itself. Ask "what were we talking about last time?", or ask about a subject or a date.

The admin page at your address backs up a memory to an encrypted file, restores one, lists and revokes the clients you approved, replaces a token, and checks or deletes a memory.

## Good to know

- **Cost.** Built to fit Cloudflare's free plan for one person's everyday use; the paid plan is 5 USD a month. It has been used on both; on the free plan only for a short while, so how a memory grown large fares there is not yet known.
- **Privacy.** Everything stays in your Cloudflare account. To search by meaning, the text of memories is sent to Workers AI inside that account. Keeping memories from people is a line the project draws, not encryption: the account's owner can reach the storage with Cloudflare's own tools, and Cloudflare can restore deleted storage for up to 30 days. A backup is encrypted in your browser with your passphrase, and a lost passphrase cannot be recovered.
- **Status.** ziwo is young. It has been used with the Claude apps and ChatGPT on web, desktop and phone; the steps for other clients are written from their documentation. The numbers behind forgetting are starting values. A broad word may miss a specific memory: "music" may not find one about practising the guitar.

## More

- [Technical specification](docs/spec.md): the tools, the data model, forgetting, search, the admin API, sign-in, configuration and limits.

MIT. See [LICENSE](LICENSE).
