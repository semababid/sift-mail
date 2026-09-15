import Dialog from '../../components/dialog.jsx';
import { MOD_LABEL } from '../../lib/shortcuts.js';

export const SHORTCUTS = [
  { keys: ['j'], description: 'Open the next conversation' },
  { keys: ['k'], description: 'Open the previous conversation' },
  { keys: ['x'], description: 'Select or unselect the open conversation' },
  { keys: ['e'], description: 'Archive the selection, or the open conversation' },
  { keys: ['z'], description: 'Undo the last archive' },
  { keys: ['c'], description: 'Write a new message' },
  { keys: ['r'], description: 'Reply to the open conversation' },
  { keys: ['a'], description: 'Reply to everyone on it' },
  { keys: [MOD_LABEL, 'Enter'], description: 'Send the message being written' },
  { keys: ['/'], description: 'Search mail' },
  { keys: ['Esc'], description: 'Clear the selection, then close the conversation' },
  { keys: [MOD_LABEL, 'K'], description: 'Open the command palette' },
  { keys: ['?'], description: 'Show these shortcuts' },
];

export default function ShortcutHelp({ onClose }) {
  return (
    <Dialog labelledBy="shortcut-help-title" onClose={onClose} className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
      <div className="flex items-center justify-between">
        <h2 id="shortcut-help-title" className="text-lg font-semibold">
          Keyboard shortcuts
        </h2>
        <button
          type="button"
          autoFocus
          onClick={onClose}
          className="rounded-md border border-stone-300 px-2.5 py-1 text-sm hover:bg-stone-100"
        >
          Close
        </button>
      </div>
      <dl className="mt-5 space-y-2.5 text-sm">
        {SHORTCUTS.map(({ keys, description }) => (
          <div key={description} className="flex items-center gap-4">
            <dt className="flex w-24 shrink-0 gap-1">
              {keys.map((key) => (
                <kbd key={key} className="min-w-6 rounded border border-stone-300 bg-stone-50 px-1.5 text-center text-xs">
                  {key}
                </kbd>
              ))}
            </dt>
            <dd className="text-stone-700">{description}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
