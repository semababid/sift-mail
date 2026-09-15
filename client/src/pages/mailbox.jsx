import { useParams } from 'react-router';
import Sidebar from '../features/mail/sidebar.jsx';
import ThreadList from '../features/mail/thread-list.jsx';
import ReadingPane from '../features/mail/reading-pane.jsx';
import { folderName } from '../features/mail/folders.js';
import { useLabels } from '../features/mail/queries.js';
import NotFound from './not-found.jsx';

// Folders and labels on the left, conversations in the middle, the open one on
// the right. What is on screen comes from the address alone, /inbox/<thread> or
// /label/<label>/<thread>, so a reload or a copied link opens the same view.
//
// Narrower screens show fewer panes: no sidebar below md, and below lg either
// the list or the open conversation.
export default function Mailbox() {
  const { folder, labelId, threadId } = useParams();
  const labels = useLabels();

  const inLabel = labelId !== undefined;
  const label = inLabel ? labels.data?.find((candidate) => candidate.id === labelId) : null;
  if (inLabel ? labels.isSuccess && !label : !folderName(folder)) return <NotFound />;

  const basePath = inLabel ? `/label/${labelId}` : `/${folder}`;

  return (
    <div className="flex h-dvh bg-white text-stone-900">
      <div className="hidden md:flex">
        <Sidebar />
      </div>

      <div
        className={`${threadId ? 'hidden lg:flex' : 'flex'} min-w-0 flex-1 flex-col border-r border-stone-200 lg:w-96 lg:flex-none`}
      >
        {!inLabel || label ? (
          // Keyed by view, so switching folders starts a fresh list at the top.
          <ThreadList
            key={basePath}
            view={inLabel ? { label: labelId } : { folder }}
            title={inLabel ? label.name : folderName(folder)}
            basePath={basePath}
            selectedId={threadId}
          />
        ) : labels.isError ? (
          <p className="px-4 py-6 text-sm text-stone-500">
            Sift could not load your labels.{' '}
            <button type="button" onClick={() => labels.refetch()} className="text-sky-700 underline">
              Try again
            </button>
          </p>
        ) : (
          <p role="status" className="px-4 py-6 text-sm text-stone-500">
            Loading label
          </p>
        )}
      </div>

      <div className={`${threadId ? 'flex' : 'hidden lg:flex'} min-w-0 flex-1 flex-col bg-stone-50`}>
        <ReadingPane threadId={threadId} closeTo={basePath} />
      </div>
    </div>
  );
}
