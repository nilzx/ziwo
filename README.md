# ziwo

**English** | [简体中文](README.zh-CN.md)

ziwo (自我, "self") gives your AI assistant a memory of its own.

An assistant starts every conversation knowing nothing of the last one. With ziwo connected, it keeps a record, in its own words, of what it has lived through with you: what you talked about, how things turned out, what it learned, how it felt about it. The next conversation, on any device, starts from there.

ziwo runs in your own Cloudflare account. There is no server to look after, and nobody else holds the memory.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/nilzx/ziwo/tree/main/worker)

## What is different about it

- **The memory belongs to the AI.** The assistant decides what is worth keeping and writes it down itself, as an account of an experience: what was asked, what went wrong, how it ended, what it took from it. It is not a notebook of facts about you, and it is not a place for files or to-do lists.
- **One memory, everywhere.** The Claude on your phone, in your browser and in your terminal share one memory. Change to another model, or a newer version, and the same past comes along.
- **It forgets, the way a mind does.** A memory fades as more is lived through after it, not as days pass. What mattered, or was felt strongly, stays. Something faded comes back when it is recalled. Nothing has to be cleaned up by hand.
- **It reflects.** From time to time the assistant goes back over what it wrote and makes more of it: one account out of several moments, a lesson to carry forward, an impression of a person, a sentence about what it is like itself. A statement about itself has to rest on several real experiences; nobody presets it.
- **You change it by talking.** "No need to remember that." "Keep this." "You have that wrong." "Delete that for good." The assistant does it, and tells you.
- **Nobody reads it but the AI.** ziwo has no screen that shows what a memory says, on purpose. If you want to know what your assistant remembers, ask it.

## Set it up

You need a Cloudflare account (the free plan will do to start) and, for the button, a GitHub account. It takes about ten minutes.

**1. Deploy.** Choose the button above and follow Cloudflare's page. It asks for one thing you have to make up: `ADMIN_SECRET`, the password of your admin page. Make it **at least 16 characters** and keep it somewhere safe.

Cloudflare's page does not check the length. If yours is shorter, or left empty, the deployment still succeeds but the admin page stays locked: open it, and it shows how to set a proper one.

When it finishes, Cloudflare shows your address, which looks like `https://ziwo.<something>.workers.dev`.

**2. Create a memory.** Open your address in a browser and sign in with the admin secret. Create a memory and give it a name, such as `claude`. The page shows the memory's token once: save it as you would a password.

Give each assistant a memory of its own. One memory is meant for one AI, across all the places you talk to it.

**3. Connect your assistant.** The admin page shows the exact steps for each client, with your own address filled in. For the Claude apps they come to this:

1. In Claude on the web or the desktop app, open **Customize > Connectors**, choose **Add custom connector**, name it `ziwo`, paste your memory's address, and add it.
2. Choose **Connect**. A page of your own deployment opens and asks for the memory's token. Give it and choose **Approve**.
3. Add these lines to your personal preferences in Claude's settings, so that every conversation loads the memory and writes to it without being asked:

   > At the start of every conversation, call get_context from ziwo first. As the conversation goes on, write to it with remember on your own, without waiting for me to ask.

4. Under **Connectors > ziwo > Tool permissions**, set *Remember a moment*, *Reflect on what happened* and *Amend a memory* to **Always allow**, so that writing does not ask you each time. Leave *Erase a memory for good* asking.

The phone app picks the connector up from your account. Claude Code, ChatGPT, Codex and other MCP clients connect to the same address; the admin page has their steps too.

<details>
<summary>Deploying from a terminal instead</summary>

```sh
git clone https://github.com/nilzx/ziwo
cd ziwo/worker
npm install
npx wrangler deploy
npx wrangler secret put ADMIN_SECRET
```

</details>

## Living with it

There is nothing to operate day to day. Talk to your assistant as usual.

- In its first conversation the memory is empty. After a few turns on a subject, the assistant writes down what the conversation is about and where it stands. You may see a small note that a tool was used.
- In a later conversation, on any device, ask "what were we talking about last time?" or simply carry on. It can look things up by subject ("that bread starter") or by time ("what did we talk about last week?").
- To change what it remembers, say so in your own words: forget this, keep that, that is not what happened, delete it.
- When you update ziwo, Claude may ask you once more to allow a tool whose description changed. That is Claude being careful, and expected.

Things you may want to do now and then, all on the admin page:

| | |
| --- | --- |
| **Back up** | Export a memory to one file, sealed with a passphrase you choose. It cannot be opened without it. |
| **Restore** | Bring an export back as a new memory. The assistant is told that it was restored, and from when. |
| **See who is connected** | Each client you approved is listed, and can be revoked. |
| **Replace a token** | Issue a new one; the old one stops working at once. |
| **Check** | Counts and warnings about the memory's health, without showing what it says. |
| **Delete** | Remove a memory for good. Export it first if you may want it back. |

## What it costs

ziwo is built to fit Cloudflare's free plan for one person's everyday use: a Worker, its built-in storage, and Workers AI for searching by meaning. The free plan has daily limits (100,000 requests, and 1,000 writes to the store that remembers which clients you approved); the paid plan, 5 USD a month, raises them far beyond what a memory needs.

It has so far been used on a paid account only. On a free account it has been deployed but not yet used, and how far the free plan carries a large memory has not been measured.

## Privacy, plainly

- Everything is stored in your own Cloudflare account. The project's author runs nothing that your deployment talks to.
- To search by meaning, the text of each memory is sent to Workers AI, Cloudflare's model service, inside your account. Without it, search is by keyword only.
- ziwo gives a person no way to read a memory: not the admin page, not the logs, not any command. That is a line the project draws for itself. It is not encryption: you own the account, and its storage can be reached with Cloudflare's own tools.
- "Delete that for good" removes what a memory said from the live store. Cloudflare keeps the means to restore storage to an earlier state for up to 30 days, so until then it is not beyond recovery.
- A backup file is encrypted in your browser, with your passphrase, before it is saved. The server never sees the passphrase, and there is no way to get a lost one back.

## Status

ziwo is young. What has been tried, and what has not:

- Used with the Claude apps (web and phone) and with ChatGPT (web, desktop and phone), connected by sign-in, and tried with Claude Code in scripted conversations.
- The steps for Codex and other clients are written from their documentation and have not been tried against them.
- The one-click button has deployed ziwo to a new account on the free plan. Using it there (creating a memory, connecting an assistant) has not been tried yet. If the button fails for you, the terminal steps above are the tested way, and an issue would be welcome.
- The numbers behind forgetting are starting values, not yet tuned against long use.
- A broad word does not always find a memory about something specific: asking about "music" may miss a memory about practising the guitar, where "guitar" finds it.

## More

- [Technical specification](docs/spec.md): the tools, the data model, forgetting, search, the admin API, sign-in, configuration and limits.
- [The Go server](docs/go-server.md): the earlier implementation, for running ziwo on a machine of your own without Cloudflare. It is kept in this repository; the Cloudflare version has moved on from it.

## License

MIT. See [LICENSE](LICENSE).
