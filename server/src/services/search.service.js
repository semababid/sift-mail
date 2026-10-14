import { Message, Thread } from '../models/index.js';
import { HIDDEN_FROM_LABELS } from '../lib/constants.js';
import { logger } from '../config/logger.js';
import { getAi } from './ai/index.js';
import { vectorSearchMessages } from './vector-search.js';

const log = logger.child({ service: 'search' });

// How many matching messages get ranked before they are grouped into
// conversations. Search returns the best few conversations, not every match:
// relevance ranking stops meaning much a few pages down, and scoring an
// unbounded number of hits for a common word is the expensive part.
const MESSAGE_POOL = 200;

// Matching messages for one user, best first. It stays at the message level,
// like the vector search, and searchThreads groups both into conversations.
// Mongo's $text matches any of the words by default, and quoted phrases and
// -negated words work as Mongo defines them.
export async function keywordSearchMessages(userId, query, { limit = MESSAGE_POOL } = {}) {
  return Message.find(
    // Trash and spam stay out, as in Gmail. Drafts, archive and sent stay in.
    { userId, $text: { $search: query }, folder: { $nin: HIDDEN_FROM_LABELS } },
    { score: { $meta: 'textScore' }, threadId: 1, subject: 1, snippet: 1, from: 1, sentAt: 1, folder: 1 },
  )
    .sort({ score: { $meta: 'textScore' }, _id: -1 })
    .limit(limit)
    .lean();
}

// The constant in reciprocal rank fusion. Each list gives a conversation
// 1 / (RRF_K + its rank there), so being near the top of a list matters, but
// the difference between first and fifth is small next to being found by
// both. 60 is the value the method was published with, and the usual choice.
export const RRF_K = 60;

// Each conversation's place in one ranked list of messages. A conversation
// takes the rank of its best message, which is the first of its messages in
// the list. Adding up every match would let a long thread outrank a short one
// that matches better, just by having more replies.
export function threadRanks(hits) {
  const ranks = new Map();
  for (const hit of hits) {
    const id = String(hit.threadId);
    if (!ranks.has(id)) ranks.set(id, { rank: ranks.size + 1, hit });
  }
  return ranks;
}

// Reciprocal rank fusion: a conversation scores the sum of 1 / (k + rank) over
// the lists that found it. It needs no common scale between the lists, which
// matters here: a text score and a vector score measure different things and
// cannot be added. Ties go to the conversation with the better single rank,
// then to keyword search, whose matches contain the words that were typed.
export function fuseRankings({ keyword, vector }, k = RRF_K) {
  const ids = new Set([...keyword.keys(), ...vector.keys()]);
  return [...ids]
    .map((id) => {
      const k1 = keyword.get(id)?.rank;
      const v1 = vector.get(id)?.rank;
      const score = (k1 ? 1 / (k + k1) : 0) + (v1 ? 1 / (k + v1) : 0);
      return { id, score, best: Math.min(k1 ?? Infinity, v1 ?? Infinity), keywordRank: k1 ?? Infinity };
    })
    .sort((a, b) => b.score - a.score || a.best - b.best || a.keywordRank - b.keywordRank)
    .map(({ id, score }) => ({ id, score }));
}

// The vectors of recent questions, so searching the same words again, or
// paging back to a search, skips the model. Kept in memory and nowhere else:
// what people search for is not written to the database.
//
// Each user has their own entries. Shared ones would answer a question
// someone else asked recently faster than a new one, and timing a search
// would tell whether anyone had searched for those words.
const QUESTION_CACHE_SIZE = 500;
const questionVectors = new Map();

async function embedQuestion(userId, query, ai) {
  const key = `${userId}\n${ai.embeddingModel}\n${query}`;
  if (questionVectors.has(key)) {
    const vector = questionVectors.get(key);
    // Moved to the end, so the cache forgets the question asked longest ago.
    questionVectors.delete(key);
    questionVectors.set(key, vector);
    return vector;
  }
  const [vector] = await ai.embed([query], { purpose: 'query' });
  questionVectors.set(key, vector);
  if (questionVectors.size > QUESTION_CACHE_SIZE) questionVectors.delete(questionVectors.keys().next().value);
  return vector;
}

export const forgetQuestionVectors = () => questionVectors.clear();

// Whether the last vector search failed, so a model or database that is down
// is reported once, not on every search.
let vectorDown = false;

// Messages nearest the meaning of the question, or none, with the reason, when
// that cannot be done: the model is not running, or the database is not Atlas.
// Search then works on keywords alone rather than failing.
async function meaningSearch(userId, query, { ai, vectorSearch }) {
  try {
    const vector = await embedQuestion(userId, query, ai);
    const hits = await vectorSearch(userId, vector, { model: ai.embeddingModel });
    if (vectorDown) log.info('vector search works again');
    vectorDown = false;
    return { hits };
  } catch (err) {
    if (!vectorDown) log.warn({ err: err.message }, 'vector search failed, searching by keyword alone until it works again');
    vectorDown = true;
    return { hits: [], unavailable: err.code ?? err.codeName ?? err.name };
  }
}

const round = (value, places) => Math.round(value * 10 ** places) / 10 ** places;

// Conversations matching a question, best first, found by keyword and by
// meaning together and fused into one ranking.
//
// Answers { results, mode }. Each result is { thread, match }, where match is
// the message that put the conversation where it is: of the conversation's
// best keyword hit and best vector hit, the one ranked higher. `mode` says
// which searches took part: "hybrid", or "keyword" when vector search could
// not run. With `debug`, each result also carries both ranks and both scores,
// and the answer says why vector search was left out.
//
// `use` restricts the search to one side, for comparing them. `ai` and
// `vectorSearch` can be replaced, for tests.
export async function searchThreads(
  userId,
  query,
  { limit, debug = false, use = 'hybrid', ai = getAi(), vectorSearch = vectorSearchMessages } = {},
) {
  const [keywordHits, meaning] = await Promise.all([
    use === 'vector' ? [] : keywordSearchMessages(userId, query),
    use === 'keyword' ? { hits: [], unavailable: 'not asked for' } : meaningSearch(userId, query, { ai, vectorSearch }),
  ]);

  const rankings = { keyword: threadRanks(keywordHits), vector: threadRanks(meaning.hits) };
  const fused = fuseRankings(rankings).slice(0, limit);

  // Scoped by user again. Each search already is, and this one costs nothing.
  const threads = await Thread.find({ _id: { $in: fused.map((entry) => entry.id) }, userId });
  const byId = new Map(threads.map((thread) => [String(thread._id), thread]));

  const results = fused
    .filter(({ id }) => byId.has(id))
    .map(({ id, score }) => {
      const found = [rankings.keyword.get(id), rankings.vector.get(id)].filter(Boolean);
      const { hit } = found.sort((a, b) => a.rank - b.rank)[0];
      const result = {
        thread: byId.get(id).toJSON(),
        match: {
          messageId: String(hit._id),
          subject: hit.subject,
          snippet: hit.snippet,
          from: hit.from,
          sentAt: hit.sentAt,
          folder: hit.folder,
          score: round(score, 5),
        },
      };
      if (debug) {
        const side = (entry) => entry && { rank: entry.rank, score: round(entry.hit.score, 4) };
        result.debug = { keyword: side(rankings.keyword.get(id)) ?? null, vector: side(rankings.vector.get(id)) ?? null };
      }
      return result;
    });

  const mode = meaning.unavailable ? 'keyword' : use === 'hybrid' ? 'hybrid' : use;
  return debug && meaning.unavailable && use !== 'keyword'
    ? { results, mode, vectorUnavailable: meaning.unavailable }
    : { results, mode };
}
