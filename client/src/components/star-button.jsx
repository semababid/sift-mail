// The label stays the same and aria-pressed carries whether it is on, so a
// screen reader announces "Star Mietvertrag, pressed" rather than a label that
// flips between two actions.
export default function StarButton({ label, starred, onClick, className = '' }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={starred}
      onClick={onClick}
      className={`rounded px-1 leading-none ${starred ? 'text-amber-500' : 'text-stone-300 hover:text-stone-500'} ${className}`}
    >
      <span aria-hidden="true">{starred ? '★' : '☆'}</span>
    </button>
  );
}
