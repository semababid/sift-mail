import { useEffect, useRef, useState } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const OVERLAY = {
  center: 'items-start justify-center px-4 pt-[15vh]',
  left: 'items-stretch justify-start',
};

// A modal over the page: a panel in the middle, or a drawer from the left.
// Escape or a click outside closes it. Focus moves in when it opens, Tab cycles
// through its controls without leaving, and focus goes back to wherever it was
// once it closes.
export default function Dialog({ label, labelledBy, side = 'center', onClose, className, children }) {
  // Read while rendering, before an autoFocus inside the dialog moves focus.
  const [returnTo] = useState(() => document.activeElement);
  const panel = useRef(null);

  useEffect(() => {
    const node = panel.current;
    // Unless something inside, such as an autoFocus input, already has it.
    if (!node.contains(document.activeElement)) node.querySelector(FOCUSABLE)?.focus();
    // Strict mode runs this cleanup once on a dialog that stays open. The
    // effect then runs again, and the line above moves focus back in.
    return () => {
      if (returnTo instanceof HTMLElement && returnTo.isConnected) returnTo.focus();
    };
  }, [returnTo]);

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const items = [...panel.current.querySelectorAll(FOCUSABLE)];
    const first = items[0];
    const last = items.at(-1);
    if (!first) {
      event.preventDefault();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div
      className={`fixed inset-0 z-40 flex bg-stone-900/30 ${OVERLAY[side]}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        aria-labelledby={labelledBy}
        onKeyDown={onKeyDown}
        className={className}
      >
        {children}
      </div>
    </div>
  );
}
