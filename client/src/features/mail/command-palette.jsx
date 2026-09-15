import { useState } from 'react';
import Dialog from '../../components/dialog.jsx';

// Every word typed has to appear somewhere in the title, in any order, so
// "sent go" finds "Go to Sent".
export function filterCommands(commands, query) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((command) => words.every((word) => command.title.toLowerCase().includes(word)));
}

export default function CommandPalette({ commands, onRun, onClose }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);

  const matches = filterCommands(commands, query);
  const current = matches[Math.min(active, matches.length - 1)];

  function onKeyDown(event) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (matches.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((matches.indexOf(current) + step + matches.length) % matches.length);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (current) onRun(current);
    }
  }

  return (
    <Dialog
      labelledBy="command-palette-title"
      onClose={onClose}
      className="w-full max-w-lg overflow-hidden rounded-xl bg-white shadow-xl"
    >
      <h2 id="command-palette-title" className="sr-only">
        Command palette
      </h2>
      <input
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-label="Command"
        aria-expanded="true"
        aria-controls="command-palette-options"
        aria-autocomplete="list"
        aria-activedescendant={current ? `command-${current.id}` : undefined}
        placeholder="Type a command"
        className="w-full border-b border-stone-200 px-4 py-3 text-sm outline-none"
      />
      {matches.length === 0 ? (
        <p className="px-4 py-6 text-sm text-stone-500">No commands match.</p>
      ) : (
        <ul id="command-palette-options" role="listbox" aria-label="Commands" className="max-h-80 overflow-y-auto py-1">
          {matches.map((command) => (
            <li
              key={command.id}
              id={`command-${command.id}`}
              role="option"
              aria-selected={command === current}
              // Keeps focus in the input when an option is clicked.
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => setActive(matches.indexOf(command))}
              onClick={() => onRun(command)}
              className={`flex cursor-pointer items-center justify-between px-4 py-2 text-sm ${
                command === current ? 'bg-sky-100 text-sky-900' : 'text-stone-700'
              }`}
            >
              {command.title}
              {command.keys && (
                <kbd className="rounded border border-stone-300 bg-stone-50 px-1.5 text-xs text-stone-500">{command.keys}</kbd>
              )}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
