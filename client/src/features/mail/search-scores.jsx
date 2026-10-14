// What search shows about itself: a note when it is running on keywords alone,
// and, behind a toggle, how each result was scored. Hybrid search merges two
// rankings by rank alone, and the scores are how to see why a result landed
// where it did.

// A row with scores has one more line of text than a plain row.
export const SCORED_ROW_HEIGHT = 104;

// Why search by meaning was left out, from the code the server gave.
const WHY_NO_MEANING = {
  unavailable: 'the model is not running',
  timeout: 'the model took too long to answer',
  model_missing: 'the embedding model is not installed',
  not_configured: 'no model is set up',
};

export function SearchNote({ mode, vectorUnavailable, showScores }) {
  if (!mode) return null;
  if (mode === 'hybrid') {
    if (!showScores) return null;
    return (
      <Note>
        Keyword and meaning search, merged by rank (RRF, k = 60). Each row shows its merged score and where each search
        ranked it.
      </Note>
    );
  }
  const why = WHY_NO_MEANING[vectorUnavailable] ?? vectorUnavailable;
  return (
    <Note tone="warn">
      Keyword matches only. Search by meaning is unavailable right now{showScores && why ? `: ${why}` : ''}.
    </Note>
  );
}

function Note({ tone, children }) {
  const colours = tone === 'warn' ? 'bg-amber-50 text-amber-900' : 'bg-stone-50 text-stone-600';
  return (
    <p role="note" className={`border-b border-stone-200 px-4 py-2 text-xs ${colours}`}>
      {children}
    </p>
  );
}

export function ScoresToggle({ on, onToggle }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onToggle}
      className={`rounded-md border px-2 py-0.5 text-xs ${
        on ? 'border-sky-300 bg-sky-50 text-sky-800' : 'border-stone-300 text-stone-600 hover:bg-stone-100'
      }`}
    >
      Scores
    </button>
  );
}

const place = (side, digits) => (side ? `#${side.rank} (${side.score.toFixed(digits)})` : 'no match');

// One line under a result. `keyword` and `vector` are missing, rather than
// null, while scores are still loading after the toggle was switched on.
export function ScoreLine({ found }) {
  if (!found) return null;
  return (
    // Inline rather than flex, so a line too long for the row ends in an
    // ellipsis before the star button instead of running under it.
    <span className="truncate pr-6 font-mono text-[11px] text-stone-500 [&>span+span]:ml-3">
      <span>rrf {found.score.toFixed(4)}</span>
      {found.keyword !== undefined && <span>keyword {place(found.keyword, 2)}</span>}
      {found.vector !== undefined && <span>meaning {place(found.vector, 3)}</span>}
    </span>
  );
}

// The same, as words for a screen reader, where the row is read as one phrase.
export function spokenScores(found) {
  if (!found) return null;
  const side = (name, entry) => (entry === undefined ? null : entry ? `${name} rank ${entry.rank}` : `no ${name} match`);
  return [`score ${found.score.toFixed(4)}`, side('keyword', found.keyword), side('meaning', found.vector)]
    .filter(Boolean)
    .join(', ');
}
