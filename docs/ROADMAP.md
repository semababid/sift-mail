# Roadmap

Ten stages, each split into steps that end in one commit. Roughly forty commits total, which is about right for a repo someone will actually scroll through.

The order matters. The plain mail client comes first and fast, because every AI feature after it needs real messages in a real schema to work against.

Rough budget on evenings and a weekend day: six to eight weeks. Stages 1 to 4 are the two thirds of the work nobody will ask you about in an interview. Stages 5 to 9 are the third they will.

Commit messages below are suggestions. I stage the work and stop; you write the commit.

---

## Stage 1: Model and auth

Design the schema before writing a single route.

**1.1** Server boots. Express, ESM, config loader that reads `.env` and fails loudly on a missing key, health route, Mongoose connection with retry.
`add express server and mongo connection`

**1.2** The four models: `users`, `messages`, `threads`, `labels`. Two decisions to make deliberately, because an interviewer will ask about both. Threads as their own collection rather than grouped at query time, because the inbox list is read far more often than mail arrives. Embeddings on the message document rather than a separate vector collection, because Atlas filters and returns in one query that way.
`add mongoose models`

**1.3** Indexes: compound on `{ userId, folder, lastMessageAt }`, text index on subject and body, unique on user email.
`add indexes`

**1.4** Register and login. Argon2 hashing, JWT access plus refresh in httpOnly cookies, auth middleware, refresh rotation. Skip password reset. Nobody is grading that.
`add jwt auth`

**1.5** Error handler, request validation with zod, rate limit on the auth routes.
`add validation and error handling`

Done when you can register, log in, and hit a protected route.

---

## Stage 2: Mail core

The unglamorous part. Move fast here.

**2.1** Seed script that generates a few thousand plausible messages across a handful of pretend senders. Build this before the endpoints so you have something to page through.
`add seed script`

**2.2** List a folder with cursor pagination, open a thread with its messages.
`add message list and thread endpoints`

**2.3** Send and drafts. Sending is internal for now: a message to another Sift user lands in their inbox.
`add send and draft endpoints`

**2.4** Star, archive, trash, mark read, and the same four as bulk operations on a selection.
`add message actions`

**2.5** Labels: create, rename, delete, assign to messages, filter the list by one.
`add labels`

**2.6** Keyword search on the text index, so there is something to compare stage 5 against.
`add keyword search`

Done when you can page through a thousand seeded messages without the list getting slow.

---

## Stage 3: The client

Keyboard first. A mail client that needs a mouse feels wrong.

**3.1** Vite, Tailwind, router, TanStack Query set up, axios instance that refreshes on a 401.
`scaffold react client`

**3.2** Login and register screens, auth context, protected routes.
`add auth screens`

**3.3** Three panes: folder sidebar, message list, reading pane. Virtualise the list.
`add three pane layout`

**3.4** Keyboard: `j` and `k` to move, `e` to archive, `r` to reply, `x` to select, `/` to search, `⌘K` for a command palette.
`add keyboard shortcuts`

**3.5** Compose modal, reply and reply-all with quoting, draft autosave.
`add compose`

**3.6** Optimistic updates on star and archive, with rollback on failure. Skeleton and empty states.
`add optimistic updates`

Done when it is pleasant to triage a hundred seeded messages by keyboard.

---

## Stage 4: Real mail in

Where most clones stop and stay a toy.

**4.1** Outbound over SMTP with Nodemailer, from a real address. Send yourself a message and read it in a real client.
`add smtp sending`

**4.2** Inbound webhook. Point a Mailgun or Postmark route at your server, verify the signature, parse the MIME with `mailparser`, store it.
`add inbound mail webhook`

**4.3** Attachments: store to disk or S3, stream on download, cap the size.
`add attachments`

**4.4** Threading. Group by `Message-ID`, `In-Reply-To` and `References`, fall back to normalised subject plus participants when the headers are missing, which is often.
`add rfc threading`

**4.5** Optional, and the honest version of ingestion: IMAP sync with `imapflow`, headers first, bodies backfilled in the background, a UID watermark so a restart resumes instead of refetching.
`add imap sync`

Done when a message you sent from your phone shows up in Sift without you touching anything.

---

## Stage 5: Semantic search

The part that makes the project yours.

**5.1** Provider interface with two methods, embed and generate. Implement it for Ollama, leave a stub for a hosted model. Everything after this depends on it, so get the shape right.
`add ai provider interface`

**5.2** Embed on write. Subject plus the first stretch of body, batched, cached by content hash so re-running never pays twice.
`embed messages on ingest`

**5.3** Backfill script that runs in chunks and can resume from where it stopped.
`add embedding backfill script`

**5.4** Atlas vector index on the embedding field with `userId` as a filter. A vector search that can return another user's mail is a security bug, not a feature.
`add atlas vector index`

**5.5** Hybrid search. Run the vector query and the text query, fuse the rankings with reciprocal rank fusion, return one list. Keep a debug flag that shows both scores, because you will need to see it to trust it and it looks good in a demo.
`add hybrid search with rrf`

**5.6** Wire it to the search bar with the debug panel behind a toggle.
`wire search ui`

Done when you can find a message by describing it, and cannot find someone else's.

---

## Stage 6: Intent triage

**6.1** Zero-shot classify into four buckets: needs a reply, waiting on them, do at a time, read only. Strict prompt, JSON schema out, retry once on a parse failure.
`add zero shot intent classifier`

**6.2** Classify on ingest in the background, store the label with the model's confidence, never block the write.
`classify messages on ingest`

**6.3** Bucket tabs in the client, drag or keyboard to move a message between them.
`add triage ui`

**6.4** The loop that makes it interesting. Store every correction. On the next classification, retrieve the nearest few corrections by embedding and include them in the prompt as examples. The classifier adapts to one person's mail without anything being retrained.
`add correction feedback loop`

**6.5** An eval set of a couple of hundred hand-labelled messages and a script that prints accuracy per bucket. Being able to say "76% zero shot, 89% after fifty corrections" is worth more in an interview than the feature itself.
`add triage eval script`

Done when the numbers move after you correct it.

---

## Stage 7: Thread digest

**7.1** Summarise a thread, streamed over the socket so text appears as it is generated rather than after eight seconds of nothing.
`add streaming thread summary`

**7.2** Extract commitments separately: who owes what, by when.
`extract commitments from threads`

**7.3** Cache against a hash of the thread's message ids, so reopening is instant and only a new reply invalidates it.
`cache thread digests`

Done when a twenty message thread reads in ten seconds.

---

## Stage 8: Ask the inbox

**8.1** Retrieval endpoint. Embed the question, pull the top matches filtered to the user, assemble the context within a token budget.
`add rag retrieval endpoint`

**8.2** Answer with citations to message ids, and instructions to use only what it was given. Refusing when nothing relevant came back is a feature. Make it do that, and say so in the README.
`add grounded answers with citations`

**8.3** Chat panel with streaming and citation chips that open the thread.
`add inbox chat panel`

Done when it answers "when did the landlord say the deposit would come back" and links to the message.

---

## Stage 9: Follow-up radar

**9.1** Scheduled job that finds messages you sent more than a few days ago in threads where nobody replied. Pure query work, no model needed.
`add follow up detection job`

**9.2** A panel for them, with snooze and dismiss.
`add follow up panel`

Ships in an evening and is the feature people actually like.

---

## Stage 10: Make it presentable

**10.1** Fill the gaps in the test suite. It has run on every step since 2.1, so by now the job is the parts that were awkward to test at the time: search fusion, triage output parsing, the streaming paths. Do not chase coverage.
`add missing tests`

**10.2** Sanitise incoming mail HTML with DOMPurify before it reaches the reading pane, block remote images by default, rate limit the AI routes. Rendering untrusted mail HTML is the obvious hole in every clone. Say in the README that you closed it.
`sanitise mail html and rate limit ai routes`

**10.3** Swap the provider to a hosted model for production, because Ollama will not run on a free tier. This is the whole reason it was an interface.
`add hosted model provider`

**10.4** Deploy. API on Fly or Railway, client on Vercel, Mongo on Atlas.
`add deployment config`

**10.5** A two minute screen capture: semantic search, then a correction changing the triage, then a digest streaming in. Put it at the top of the README as a GIF. Most people will never clone the repo.
`add demo gif and readme`

---

## What to leave out

Calendar. Contacts. Multiple accounts. A mobile app. A settings page with more than four options. Each costs a week and demonstrates nothing that stages 5 to 9 do not demonstrate better.
