# Sift

A mail client that reads your inbox before you do.

Sift is a full MERN application, but it is not another Gmail skin with a folder list and a compose box. Displaying email is easy. Working out which of it deserves your attention is the part that takes real work, so that is where the code went. Every message gets embedded, classified by what it asks of you, and made searchable by meaning rather than by keyword.

## What it does that a normal clone does not

Search works on meaning. Type "the email about the flat deposit" and the right thread comes back even when the words "flat" and "deposit" appear nowhere in it. Embeddings live on the message document itself and get queried with MongoDB Atlas Vector Search, then fused with a normal text index so exact terms still win when they should.

Triage sorts by intent instead of by sender. Gmail gives you Primary, Social and Promotions. Sift gives you *needs a reply*, *waiting on them*, *do at a time* and *read only*, which is closer to how anyone actually works through a backlog. Move a message to a different bucket and that correction gets stored and fed back as an example, so the classifier drifts toward your habits instead of a generic prior.

Long threads collapse into a digest. Twenty messages of scheduling back and forth become a summary that streams in as it is generated, with commitments pulled out separately. If you said you would send something by Friday, it shows up as its own line.

There is a chat panel scoped to your own mail. It answers from retrieved messages and cites which ones it used, so you can click through and check whether it made anything up.

Follow-up radar surfaces anything you sent that never got a reply. Small feature, does more real work than most of the rest.

## Stack

- MongoDB (Atlas, for vector search) with Mongoose
- Express on Node, ESM throughout
- React with Vite, TanStack Query, Tailwind
- Socket.IO for new mail and for streaming summaries
- Ollama locally for embeddings and generation, behind a provider interface so a hosted model can be dropped in

## Status

Scaffolding only. [docs/ROADMAP.md](docs/ROADMAP.md) has the build order.
