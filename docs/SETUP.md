# What you need before stage 1

I checked this machine. Most of it is already there.

## Already installed

| | |
|---|---|
| Apple M5, 16 GB RAM, 191 GB free | enough for everything below |
| Docker Desktop | installed, daemon not running, just open the app |
| Ollama | installed, 6.1 GB of models, `qwen3.5` already pulled |
| Git | fine |

## Missing, and needed

**Node 24.** Not installed at all, so nothing in this project runs yet.

```bash
brew install node@24
```

**An embedding model.** You have a chat model but no embedder, and stage 5 cannot start without one. A 1.2 GB download. It is bge-m3 rather than the smaller nomic-embed-text because most of this mailbox is German, and in a comparison on the seeded mail only bge-m3 found German mail from questions asked in English (`npm run eval:embeddings --workspace=server`).

```bash
ollama pull bge-m3
```

**Mongo and Redis running locally.** Open Docker Desktop first, then from the project root:

```bash
docker compose up -d
```

Redis is only used for the job queue from stage 6 onward. Nothing breaks before then if it is not up.

## Accounts to create

All free. None of them need a card.

**MongoDB Atlas**, needed from stage 5. The local Mongo container cannot do vector search, so the embeddings work has to run against Atlas. The free M0 tier does support Atlas Vector Search, and 512 MB holds a few thousand messages with their embeddings without trouble. Create it early so the cluster is warm when you get there.

**An inbound mail route**, needed at stage 4. Two options and the cheaper one is not the obvious one. Mailgun and Postmark both changed their free tiers and now want a card or a verified domain for anything real. The path with no cost and no domain is a throwaway Gmail account with 2FA on and an app password: IMAP in, SMTP out, both free, and the IMAP version is the more interesting thing to have built anyway.

**Fly or Railway, and Vercel**, needed at stage 10 only. Both have free tiers that fit this.

**A hosted model key**, also stage 10 only, because Ollama will not run on a free deployment tier. This is the one line item that can cost money, and it is small: the whole project only calls a model for classification, summaries and chat answers.

## Worth knowing

16 GB is comfortable but not unlimited. Ollama, Mongo, Redis, Vite and a browser at once will get tight if you also load an 8B model. Keep the chat model at 3B or 4B while developing and save the bigger one for checking output quality.

`gh` is not installed either. Not required, but it makes pushing this to GitHub less annoying:

```bash
brew install gh
```

## Running the tests

```bash
npm test
```

The suite starts its own MongoDB in memory, so Docker does not need to be running. The first run downloads a mongod binary of about 65 MB into `~/.cache/mongodb-binaries`, and after that the whole suite finishes in a few seconds. Each test file gets its own database, so files run side by side without stepping on each other.

`npm run test:watch --workspace=server` reruns whatever a change touches.
