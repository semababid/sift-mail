import { useEffect, useRef, useState } from 'react';

// A modal panel over the page. Escape or a click outside closes it, and focus
// goes back to wherever it was before. Each dialog in Sift has a single control
// to focus, so keeping Tab inside means Tab does nothing.
export default function Dialog({ labelledBy, onClose, className, children }) {
  // Read while rendering, before an autoFocus inside the dialog moves focus.
  const [returnTo] = useState(() => document.activeElement);
  const panel = useRef(null);

  useEffect(() => {
    const node = panel.current;
    return () => {
      // Strict mode runs this cleanup once on a dialog that stays open, with
      // the panel still in the page. Focus moves back only once it is gone.
      if (!node.isConnected && returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    };
  }, [returnTo]);

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'Tab') {
      event.preventDefault();
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-stone-900/30 px-4 pt-[15vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={labelledBy} onKeyDown={onKeyDown} className={className}>
        {children}
      </div>
    </div>
  );
}
