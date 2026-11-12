# ziwo

**English** | [简体中文](README.zh-CN.md)

ziwo (自我, "self") gives your AI assistant a memory of its own. It runs in your own Cloudflare account and works with Claude, ChatGPT and other MCP clients.

- **The memory is the AI's.** The assistant decides what to keep and writes it in its own words: what happened, how it ended, what it learned, how it felt.
- **One memory, everywhere.** Phone, browser and terminal share it, and it carries over to a new model.
- **It forgets and reflects.** Memories fade as more is lived through, what mattered stays, and the assistant draws lessons from what it wrote.
- **You change it by talking.** "Forget that." "Keep this." "You have that wrong."
- **Nobody reads it but the AI.** No screen shows what a memory says. To know what it remembers, ask it.

## Get started

You need a Cloudflare account (the free plan will do) and [Node.js](https://nodejs.org).

1. **Deploy.** Run this in a terminal. It signs you in to Cloudflare in your browser and prints your address, which looks like `https://ziwo.<something>.workers.dev`. The first run takes a minute or two, and on a new Cloudflare account it asks you to pick the name in that address.

   ```sh
   npx ziwo@latest deploy
   ```

2. **Choose an admin secret.** Open your address straight away. The page asks for a password of at least 16 characters, or offers one. Keep it somewhere safe. The page offers this for one hour only.
3. **Create a memory.** Give it a name, such as `claude`, and save the token the page shows once. Each assistant gets a memory of its own.
4. **Connect your assistant.** The page gives the steps for Claude, ChatGPT, Claude Code, Codex and other clients, with your address filled in.

To update, run the same command again. Your memories are untouched.

<details>
<summary>Without a terminal</summary>

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nilzx/ziwo/tree/main/worker)

The button deploys a copy through a GitHub account of yours. Steps 2 to 4 are the same. A copy made this way does not follow new versions.

</details>

## Using it

Talk to your assistant as usual. After a few turns on a subject it writes down what the conversation is about, and a later conversation, on any device, starts from there. Ask "what were we talking about last time?", or ask about a subject or a date.

The admin page at your address backs up a memory to an encrypted file, restores one, lists and revokes the clients you approved, replaces a token, and checks or deletes a memory.

## Good to know

- **Cost.** Built to fit Cloudflare's free plan for one person's everyday use; the paid plan is 5 USD a month. So far it has been used on a paid account, and only deployed on a free one.
- **Privacy.** Everything stays in your Cloudflare account. To search by meaning, the text of memories is sent to Workers AI inside that account. Keeping memories from people is a line the project draws, not encryption: the account's owner can reach the storage with Cloudflare's own tools, and Cloudflare can restore deleted storage for up to 30 days. A backup is encrypted in your browser with your passphrase, and a lost passphrase cannot be recovered.
- **Status.** ziwo is young. It has been used with the Claude apps and ChatGPT on web, desktop and phone; the steps for other clients are written from their documentation. The numbers behind forgetting are starting values. A broad word may miss a specific memory: "music" may not find one about practising the guitar.

## More

- [Technical specification](docs/spec.md): the tools, the data model, forgetting, search, the admin API, sign-in, configuration and limits.
- [The Go server](docs/go-server.md): the earlier implementation, for a machine of your own without Cloudflare.

MIT. See [LICENSE](LICENSE).
