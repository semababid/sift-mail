import { useState } from 'react';
import { useNavigate } from 'react-router';
import { MOD_LABEL } from '../../lib/shortcuts.js';

export default function SearchBox({ inputRef, query, onOpenPalette, onOpenMenu }) {
  const navigate = useNavigate();
  const [text, setText] = useState(query);

  // The box follows the address: opening a search shows its words, and moving
  // to a folder empties it.
  const [shownQuery, setShownQuery] = useState(query);
  if (shownQuery !== query) {
    setShownQuery(query);
    setText(query);
  }

  function submit(event) {
    event.preventDefault();
    const words = text.trim();
    if (!words) return;
    navigate(`/search?q=${encodeURIComponent(words)}`);
    // Out of the box, so j and k work on the results straight away.
    inputRef.current?.blur();
  }

  return (
    <div className="flex h-14 shrink-0 items-center gap-2 border-b border-stone-200 px-3">
      {/* Below md the sidebar is hidden, and this is the way to it. */}
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Open menu"
        className="shrink-0 rounded-md p-1.5 text-stone-600 hover:bg-stone-100 md:hidden"
      >
        <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" className="size-5">
          <path d="M3 5h14M3 10h14M3 15h14" />
        </svg>
      </button>
      <form role="search" onSubmit={submit} className="min-w-0 flex-1">
        <label htmlFor="mail-search" className="sr-only">
          Search mail
        </label>
        <input
          ref={inputRef}
          id="mail-search"
          type="search"
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
          placeholder="Search mail"
          className="w-full rounded-md border border-stone-300 bg-stone-50 px-3 py-1.5 text-sm outline-none focus:border-sky-400 focus:bg-white focus:ring-2 focus:ring-sky-100"
        />
      </form>
      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="Open command palette"
        title={`Commands (${MOD_LABEL} K)`}
        className="shrink-0 rounded-md border border-stone-300 px-2 py-1 text-xs text-stone-600 hover:bg-stone-100"
      >
        {MOD_LABEL} K
      </button>
    </div>
  );
}
