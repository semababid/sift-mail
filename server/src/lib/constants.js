export const FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam'];

// The four triage buckets. Stage 6 classifies into these; until then every
// message carries the default and the UI ignores the field.
export const INTENTS = ['needs_reply', 'waiting_on_them', 'do_at_a_time', 'read_only'];

export const INTENT_SOURCES = ['model', 'user', 'default'];

// The size of a bge-m3 vector. Changing the embedding model means changing
// this and rebuilding the Atlas index, so it lives in one place.
//
// bge-m3 was picked over nomic-embed-text by running the stage 2.6 questions
// through both (npm run eval:embeddings). It found 12 of 18 answers first
// against 10, and three of the five English questions about German mail
// where nomic-embed-text found none. It is 2.5 times slower to embed with,
// which only matters for the one-off backfill.
export const EMBEDDING_DIMS = 1024;

// Conversations that sit entirely in these folders stay out of label views and
// label counts, the way Gmail keeps trash out of its label lists.
export const HIDDEN_FROM_LABELS = ['trash', 'spam'];

// Batch actions that take a labelId.
export const LABEL_ACTIONS = ['addLabel', 'removeLabel'];
