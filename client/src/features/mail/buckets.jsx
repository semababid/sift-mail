import { Link } from 'react-router';

// The triage buckets, in the order the tabs show them, with the key that moves
// a conversation into each. A tab shows how many conversations its bucket
// holds when that is worth knowing, for the ones that ask something of the
// user. Read only is most of a mailbox, and its count says nothing.
export const BUCKETS = [
  { id: 'needs_reply', name: 'Needs reply', key: '1', counted: true },
  { id: 'waiting_on_them', name: 'Waiting', key: '2', counted: true },
  { id: 'do_at_a_time', name: 'To do', key: '3', counted: true },
  { id: 'read_only', name: 'Read only', key: '4', counted: false },
];

export const bucketName = (id) => BUCKETS.find((bucket) => bucket.id === id)?.name ?? null;

// What a dragged row carries: the ids of the conversations being moved.
export const DRAG_TYPE = 'application/x-sift-threads';

const draggingThreads = (event) => event.dataTransfer?.types?.includes(DRAG_TYPE);

// The inbox's tabs: everything, then each bucket, with how many conversations
// are in it where that is counted. Each bucket tab takes conversations
// dropped on it.
export function BucketTabs({ basePath, active, counts, onDrop }) {
  const tab = (id, name, count) => {
    const current = (active ?? null) === id;
    const to = id ? `${basePath}?bucket=${id}` : basePath;
    const dropTarget = id
      ? {
          onDragOver: (event) => {
            if (!draggingThreads(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            event.currentTarget.dataset.over = 'true';
          },
          onDragLeave: (event) => delete event.currentTarget.dataset.over,
          onDrop: (event) => {
            delete event.currentTarget.dataset.over;
            if (!draggingThreads(event)) return;
            event.preventDefault();
            const ids = JSON.parse(event.dataTransfer.getData(DRAG_TYPE) || '[]');
            if (ids.length > 0) onDrop(ids, id);
          },
        }
      : {};
    return (
      <li key={id ?? 'all'}>
        <Link
          to={to}
          aria-current={current ? 'page' : undefined}
          className={`flex items-center gap-1 rounded-md px-1.5 py-1 whitespace-nowrap data-[over=true]:bg-sky-100 data-[over=true]:ring-2 data-[over=true]:ring-sky-300 ${
            current ? 'bg-stone-900 text-white' : 'text-stone-600 hover:bg-stone-100'
          }`}
          {...dropTarget}
        >
          {name}
          {count !== undefined && <span className={current ? 'text-stone-300' : 'text-stone-400'}>{count}</span>}
        </Link>
      </li>
    );
  };

  return (
    <nav aria-label="Buckets" className="border-b border-stone-200 px-2 py-1.5">
      <ul className="flex gap-0.5 overflow-x-auto text-xs">
        {tab(null, 'All')}
        {BUCKETS.map((bucket) => tab(bucket.id, bucket.name, bucket.counted ? counts?.[bucket.id] : undefined))}
      </ul>
    </nav>
  );
}

// A conversation's bucket as a small label on its row.
export function BucketBadge({ bucket }) {
  const name = bucketName(bucket);
  if (!name) return null;
  return <span className="mr-1.5 rounded bg-stone-100 px-1 py-px text-[11px] font-normal text-stone-600">{name}</span>;
}

const RECEIVED = ['inbox', 'archive'];

// Why the open conversation is in its bucket, under its subject: the model's
// reason and how sure it was, or that the user put it there.
export function BucketNote({ thread, messages }) {
  if (!thread.bucket) return null;
  const decided = messages.filter((m) => RECEIVED.includes(m.folder) && !m.isDraft && m.intent?.label).at(-1);
  const name = bucketName(thread.bucket);

  let why;
  if (thread.bucketSource === 'user') {
    why = 'You put it here.';
  } else if (decided?.intent.label === 'needs_reply' && thread.bucket === 'waiting_on_them') {
    why = 'Sift said it needed a reply, and you have replied since.';
  } else if (decided?.intent.reason) {
    const sure = decided.intent.confidence == null ? '' : ` (${Math.round(decided.intent.confidence * 100)}% sure)`;
    why = `Sift: ${decided.intent.reason}${sure}`;
  }

  return (
    <p className="mt-1.5 flex items-baseline gap-2 text-sm text-stone-500">
      <span className="shrink-0 rounded bg-stone-100 px-1.5 text-xs text-stone-700">{name}</span>
      {why && <span>{why}</span>}
    </p>
  );
}
