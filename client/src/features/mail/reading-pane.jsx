import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useSignedInUser } from '../auth/guards.jsx';
import { messageDate, personName } from '../../lib/format.js';
import { useMarkRead, useThread } from './queries.js';

export default function ReadingPane({ threadId, closeTo }) {
  if (!threadId) return <PaneNote>Select a conversation to read it.</PaneNote>;
  // Keyed by thread, so opening another one starts at the top.
  return <Conversation key={threadId} threadId={threadId} closeTo={closeTo} />;
}

function Conversation({ threadId, closeTo }) {
  const user = useSignedInUser();
  const conversation = useThread(threadId);
  const { mutate: markRead } = useMarkRead();
  const thread = conversation.data?.thread;

  // Opening an unread conversation marks it read. The marker includes the time
  // of the newest message, so a reply arriving while it is open gets marked
  // too, and it is checked before sending, so React running this effect twice
  // in development still sends one request.
  const marked = useRef(null);
  const unreadMarker = thread?.hasUnread ? `${thread.id}@${thread.lastMessageAt}` : null;
  useEffect(() => {
    if (!unreadMarker || marked.current === unreadMarker) return;
    marked.current = unreadMarker;
    markRead(threadId);
  }, [unreadMarker, threadId, markRead]);

  if (conversation.isPending) return <PaneNote role="status">Loading conversation</PaneNote>;

  if (conversation.isError) {
    const gone = conversation.error.response?.status === 404;
    return (
      <PaneNote>
        <p>{gone ? 'This conversation is not here. It may have been deleted.' : 'Sift could not load this conversation.'}</p>
        {gone ? (
          <Link to={closeTo} className="text-sky-700 underline">
            Back to the list
          </Link>
        ) : (
          <button type="button" onClick={() => conversation.refetch()} className="text-sky-700 underline">
            Try again
          </button>
        )}
      </PaneNote>
    );
  }

  return (
    <section aria-labelledby="thread-subject" className="h-full min-h-0 overflow-y-auto">
      <header className="border-b border-stone-200 bg-white px-8 pt-5 pb-4">
        <Link to={closeTo} className="mb-2 inline-block text-sm text-sky-700 lg:hidden">
          Back to the list
        </Link>
        <h2 id="thread-subject" className="text-xl font-semibold break-words">
          {thread.subject || '(no subject)'}
        </h2>
      </header>
      <ol className="space-y-4 px-8 py-6">
        {conversation.data.messages.map((message) => (
          <li key={message.id}>
            <MessageView message={message} selfAddress={user.email} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function MessageView({ message, selfAddress }) {
  const sender = personName(message.from, selfAddress);
  const recipients = [...message.to, ...message.cc].map((person) => personName(person, selfAddress)).join(', ');

  return (
    <article aria-label={`From ${sender}`} className="rounded-lg border border-stone-200 bg-white p-5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <p className="font-medium">{sender}</p>
        <p className="min-w-0 flex-1 truncate text-sm text-stone-500">{message.from.address}</p>
        {message.isDraft && <p className="rounded bg-amber-100 px-1.5 text-xs text-amber-900">Draft</p>}
        <time dateTime={message.sentAt} className="text-sm text-stone-500">
          {messageDate(message.sentAt)}
        </time>
      </div>
      {recipients && <p className="mt-0.5 text-sm text-stone-500">to {recipients}</p>}
      <MessageBody message={message} />
    </article>
  );
}

// Plain text only for now. React inserts it as text, so markup inside a message
// shows as characters and never becomes elements. The HTML version needs a
// sanitiser before it can be shown, and that is a step of its own.
function MessageBody({ message }) {
  if (message.bodyText) {
    return <div className="mt-4 text-sm leading-relaxed break-words whitespace-pre-wrap">{message.bodyText}</div>;
  }
  const note = message.bodyHtml
    ? 'This message only has a formatted version, which Sift cannot show yet.'
    : 'This message has no text.';
  return <p className="mt-4 text-sm text-stone-500 italic">{note}</p>;
}

function PaneNote({ children, ...props }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-sm text-stone-500" {...props}>
      {children}
    </div>
  );
}
