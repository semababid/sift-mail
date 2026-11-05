# Sift

A mail client that reads your inbox before you do.

Sift is a full MERN application, but it is not another Gmail skin with a folder list and a compose box. Displaying email is easy. Working out which of it deserves your attention is the hard part, so that is where the code went. Every message is embedded, sorted by what it asks of you, and searchable by meaning as well as by keyword.

**Status:** stages 1 to 6 of 10 are built: the mail client, real mail over IMAP and SMTP, semantic search, and intent triage with a correction loop. Thread digests, the inbox chat and the follow-up radar come next. [docs/ROADMAP.md](docs/ROADMAP.md) has the build order.

## What works now

### Search by meaning

Search for "flat deposit" in English and the German thread about the Kaution comes back first, though it shares no words with the query. Each message is embedded with bge-m3 (1,024 dimensions), and the vector lives on the message document itself, queried with MongoDB Atlas Vector Search. The same query also runs against a normal text index with German stemming, and the two rankings are merged with reciprocal rank fusion (k = 60), so an exact term still wins when it should.

- bge-m3 was picked over nomic-embed-text by an eval script (`npm run eval:embeddings`). It ranked the right answer first for 12 of 18 test questions against 10, and answered three of five English questions about German mail where the other model found nothing.
- The user filter is part of the vector index and applies before the nearest neighbours are chosen. Another user's mail cannot appear in the results, and it cannot crowd your own mail out of them either.
- A debug toggle in the search bar shows each result's rank in both lists, so you can see why something came up.
- Embeddings are cached by a hash of the text, and the backfill runs in chunks and resumes where it stopped.

### Triage by intent

Gmail gives you Primary, Social and Promotions. Sift sorts by what a message asks of you: *needs a reply*, *waiting on them*, *to do* and *read only*. That is closer to how anyone actually works through a backlog.

- A local model (qwen3.5:9b through Ollama) sorts each received message in the background as it arrives, so storing mail never waits for it. The answer is held to a JSON schema at temperature 0.
- The confidence shown is the probability the model gave its bucket, read from the token log-probabilities, rather than a number the model was asked to make up.
- Mailing-list headers (List-Id, List-Unsubscribe, Precedence) are passed to the model, so a newsletter that ends with a question is still treated as a newsletter.
- In the inbox, each bucket is a tab. Move a conversation by dragging it onto a tab or pressing 1 to 4, and undo the move if you change your mind. Sift never overrides a bucket you chose.

**It learns from corrections without retraining.** Every move is stored as a correction. When the next message is sorted, the corrections most like it go into the prompt as examples. "Most like it" means close by embedding (0.7 or closer), or from the same mailing list. The 0.7 cut-off was measured on this mailbox: below it, two messages share a bucket no more often than chance. The mailing-list rule is there because a list's messages can each be about something different and still be the same kind of mail. In a test on the real mailbox, moving three Indeed job alerts to *to do* was enough for all 35 other alerts from that sender to land there when they were sorted again.

Triage is measured against 200 messages labelled by hand, scored zero-shot and again after 10, 25 and 50 corrections (`npm run eval:triage`). The numbers will be added here once labelling is finished.

### A mail client underneath

- Real mail in and out: IMAP sync with imapflow (headers first, bodies fetched in a second pass, a UID watermark so a restart picks up where it stopped) and SMTP sending with Nodemailer.
- Threading from Message-ID, In-Reply-To and References, falling back to subject and participants when the headers are missing.
- Folders, labels, stars, drafts with autosave, reply and reply-all with quoting, and attachments up to a size cap.
- Keyboard first: `j` and `k` to move, `e` to archive, `r` to reply, `x` to select, `/` to search, `⌘K` for a command palette. Archive, star and bucket moves show at once and roll back if the server refuses them.
- Auth with Argon2 password hashes, JWT access and refresh tokens in httpOnly cookies with refresh rotation, zod validation, and rate limits on the auth routes.

The reading pane shows the plain text of a message. Mail that only has an HTML version is not shown yet; that waits until the HTML can be sanitised (stage 10).

## Coming next

- **Thread digests:** a long thread summarised as it streams in, with commitments such as "send the contract by Friday" listed separately.
- **Ask the inbox:** a chat panel that answers from your retrieved mail, cites the messages it used, and says so when nothing relevant came back.
- **Follow-up radar:** mail you sent that never got a reply.

## Stack

- MongoDB Atlas with Mongoose, using Atlas Vector Search
- Express 5 on Node 24, ESM throughout
- React with Vite, TanStack Query, TanStack Virtual and Tailwind
- Ollama for embeddings and chat, behind a provider interface so a hosted model can replace it
- Vitest throughout: supertest and an in-memory MongoDB on the server, Testing Library and MSW on the client

## Tests

548 tests on the server and 220 on the client, run on every step. When a test exists to guard a particular bug, the code was broken on purpose to check that the test fails.

## Running it

[docs/SETUP.md](docs/SETUP.md) covers Atlas, Ollama, the seed data, IMAP and the backfills.
