import { NavLink } from 'react-router';
import { useSignedInUser } from '../auth/guards.jsx';
import { useLogout } from '../auth/session.js';
import { FOLDERS } from './folders.js';
import { useLabels } from './queries.js';

const linkClass = ({ isActive }) =>
  `flex items-center gap-3 rounded-md px-3 py-1.5 text-sm ${
    isActive ? 'bg-sky-100 font-medium text-sky-900' : 'text-stone-700 hover:bg-stone-200/60'
  }`;

export default function Sidebar() {
  const user = useSignedInUser();
  const logout = useLogout();
  const labels = useLabels();

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r border-stone-200 bg-stone-50">
      <p className="px-5 pt-5 pb-4 text-lg font-semibold tracking-tight">Sift</p>

      <nav aria-label="Mailbox" className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <ul>
          {FOLDERS.map((folder) => (
            <li key={folder.id}>
              <NavLink to={`/${folder.id}`} className={linkClass}>
                {folder.name}
              </NavLink>
            </li>
          ))}
        </ul>

        <h2 className="mt-6 mb-1 px-3 text-xs font-medium tracking-wide text-stone-500 uppercase">Labels</h2>
        <LabelLinks labels={labels} />
      </nav>

      <section aria-label="Signed in" className="border-t border-stone-200 p-4 text-sm">
        <p className="truncate font-medium">{user.name}</p>
        <p className="truncate text-stone-500">{user.email}</p>
        <button
          type="button"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          className="mt-3 w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 font-medium hover:bg-stone-100 disabled:opacity-60"
        >
          Sign out
        </button>
      </section>
    </aside>
  );
}

function LabelLinks({ labels }) {
  if (labels.isPending) return null;
  if (labels.isError) return <p className="px-3 text-sm text-stone-500">Labels could not be loaded.</p>;
  if (labels.data.length === 0) return <p className="px-3 text-sm text-stone-500">No labels yet.</p>;

  return (
    <ul>
      {labels.data.map((label) => (
        <li key={label.id}>
          <NavLink
            to={`/label/${label.id}`}
            aria-label={label.unreadCount > 0 ? `${label.name}, ${label.unreadCount} unread` : label.name}
            className={linkClass}
          >
            <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ backgroundColor: label.color }} />
            <span className="min-w-0 flex-1 truncate">{label.name}</span>
            {label.unreadCount > 0 && <span className="text-xs text-stone-500">{label.unreadCount}</span>}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}
