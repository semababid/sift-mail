import { useCallback, useState } from 'react';

const read = (key) => {
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
};

// An on/off setting kept in this browser, for a preference that should
// outlive a reload. Storage can be blocked, in a private window for one, and
// then the setting lasts until the tab closes and starts off again next time.
export function useStoredFlag(key) {
  const [on, setOn] = useState(() => read(key));

  const set = useCallback(
    (next) => {
      const value = typeof next === 'function' ? next(on) : next;
      setOn(value);
      try {
        if (value) window.localStorage.setItem(key, '1');
        else window.localStorage.removeItem(key);
      } catch {
        // Kept for this tab only.
      }
    },
    [key, on],
  );

  return [on, set];
}
