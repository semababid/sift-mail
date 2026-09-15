// A grey placeholder shape while something loads. Hidden from screen readers,
// which get the loading text beside it instead.
export default function Skeleton({ className = '' }) {
  return <span aria-hidden="true" className={`block animate-pulse rounded bg-stone-200 ${className}`} />;
}
