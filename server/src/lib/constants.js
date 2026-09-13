export const FOLDERS = ['inbox', 'sent', 'drafts', 'archive', 'trash', 'spam'];

// The four triage buckets. Stage 6 classifies into these; until then every
// message carries the default and the UI ignores the field.
export const INTENTS = ['needs_reply', 'waiting_on_them', 'do_at_a_time', 'read_only'];

export const INTENT_SOURCES = ['model', 'user', 'default'];

// nomic-embed-text output width. Changing the embedding model means changing
// this and rebuilding the Atlas index, so it lives in one place.
export const EMBEDDING_DIMS = 768;

// Conversations that sit entirely in these folders stay out of label views and
// label counts, the way Gmail keeps trash out of its label lists.
export const HIDDEN_FROM_LABELS = ['trash', 'spam'];

// Batch actions that take a labelId.
export const LABEL_ACTIONS = ['addLabel', 'removeLabel'];
