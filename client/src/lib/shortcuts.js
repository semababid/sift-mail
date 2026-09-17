import { useEffect, useRef } from 'react';

export const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl';

// Names a key press the way bindings are written: "j", "?", "Escape", or
// "mod+k" for Command on a Mac and Control elsewhere. A press with any other
// modifier gets no name, so browser and system shortcuts pass straight through.
//
// A letter typed without Shift is lowercased, so Caps Lock does not turn every
// shortcut off. With Shift held, the key stays as it is: "?" needs Shift, and
// "J" is not "j".
export function keyName(event, { mac = IS_MAC } = {}) {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  if (event.altKey || other) return null;
  const key = event.key.length === 1 && !event.shiftKey ? event.key.toLowerCase() : event.key;
  return mod ? `mod+${key.toLowerCase()}` : key;
}

const NOT_TEXT = ['checkbox', 'radio', 'button', 'submit', 'reset'];

function isTyping(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  return target.tagName === 'INPUT' && !NOT_TEXT.includes(target.type);
}

// Page-wide single-key shortcuts. They stay quiet while someone types in a text
// field, where "j" is a letter; only mod combinations work there. `enabled`
// turns everything off except the names in `always`, and a held key repeats
// only for the names in `repeat`.
export function useShortcuts(bindings, { enabled = true, always = [], repeat = [] } = {}) {
  const latest = useRef(null);
  useEffect(() => {
    latest.current = { bindings, enabled, always, repeat };
  });

  useEffect(() => {
    function onKeyDown(event) {
      if (event.defaultPrevented || event.isComposing || !latest.current) return;
      const name = keyName(event);
      const current = latest.current;
      const run = name && current.bindings[name];
      if (!run) return;
      if (!current.enabled && !current.always.includes(name)) return;
      if (isTyping(event.target) && !name.startsWith('mod+')) return;
      if (event.repeat && !current.repeat.includes(name)) return;

      event.preventDefault();
      run(event);
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
