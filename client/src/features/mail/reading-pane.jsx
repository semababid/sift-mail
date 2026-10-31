import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { useSignedInUser } from '../auth/guards.jsx';
import Skeleton from '../../components/skeleton.jsx';
import StarButton from '../../components/star-button.jsx';
import { messageDate, personName } from '../../lib/format.js';
import { replyRecipients } from '../compose/reply.js';
import Attachments from './attachments.jsx';
import { BucketNote } from './buckets.jsx';
import { useMarkRead, useThread } from './queries.js';

// `onReply(message, { all })`, `onContinueDraft(draft)` and `onToggleStar(thread)`
// are handled by the mailbox page, which owns compose and the thread actions.
export default function ReadingPane({ threadId, closeTo, ...actions }) {
  if (!threadId) {
    return (
      <PaneNote>
        <p>Select a conversation to read it.</p>
        <p className="text-xs text-stone-400">Or press j to open the first one.</p>
      </PaneNote>
    );
  }
  // Keyed by thread, so opening another one starts at the top.
  return <Conversation key={threadId} threadId={threadId} closeTo={closeTo} {...actions} />;
}

function Conversation({ threadId, closeTo, onReply, onContinueDraft, onToggleStar }) {
  const user = useSignedInUser();
  const conversation = useThread(threadId);
  const { mutate: markRead } = useMarkRead();
  const thread = conversation.data?.thread;

  // Opening an unread conversation marks it read. The marker includes the time
  // of the newest message, so a reply arriving while it is open gets marked
  // too, and it is checked before sending, so React running this effect twice
  // in development still sends one request. A refused mark, which turns the
  // conversation unread again, is not retried in a loop for the same reason.
  const marked = useRef(null);
  const unreadMarker = thread?.hasUnread ? `${thread.id}@${thread.lastMessageAt}` : null;
  useEffect(() => {
    if (!unreadMarker || marked.current === unreadMarker) return;
    marked.current = unreadMarker;
    markRead({ ids: [threadId] });
  }, [unreadMarker, threadId, markRead]);

  if (conversation.isPending) {
    return (
      <div role="status" className="space-y-4 px-8 py-6">
        <span className="sr-only">Loading conversation</span>
        <Skeleton className="h-6 w-2/3" />
        {[0, 1].map((index) => (
          <div key={index} className="space-y-3 rounded-lg border border-stone-200 bg-white p-5">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        ))}
      </div>
    );
  }

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
        <div className="flex items-start gap-3">
          <h2 id="thread-subject" className="min-w-0 flex-1 text-xl font-semibold break-words">
            {thread.subject || '(no subject)'}
          </h2>
          <StarButton
            label="Star conversation"
            starred={thread.isStarred}
            onClick={() => onToggleStar(thread)}
            className="text-xl"
          />
        </div>
        <BucketNote thread={thread} messages={conversation.data.messages} />
      </header>
      <ol className="space-y-4 px-8 py-6">
        {conversation.data.messages.map((message) => (
          <li key={message.id}>
            <MessageView message={message} selfAddress={user.email} onReply={onReply} onContinueDraft={onContinueDraft} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function MessageView({ message, selfAddress, onReply, onContinueDraft }) {
  const sender = personName(message.from, selfAddress);
  const recipients = [...message.to, ...message.cc].map((person) => personName(person, selfAddress)).join(', ');

  // Reply all only shows when it would reach more people than Reply does.
  const count = ({ to, cc }) => to.length + cc.length;
  const canReplyAll =
    !message.isDraft &&
    count(replyRecipients(message, selfAddress, { all: true })) > count(replyRecipients(message, selfAddress));

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
      <Attachments message={message} />

      <div className="mt-4 flex gap-2 text-sm">
        {message.isDraft ? (
          <MessageAction onClick={() => onContinueDraft(message)}>Continue draft</MessageAction>
        ) : (
          <>
            <MessageAction onClick={() => onReply(message)}>Reply</MessageAction>
            {canReplyAll && <MessageAction onClick={() => onReply(message, { all: true })}>Reply all</MessageAction>}
          </>
        )}
      </div>
    </article>
  );
}

function MessageAction({ onClick, children }) {
  return (
    <button type="button" onClick={onClick} className="rounded-md border border-stone-300 px-3 py-1 hover:bg-stone-100">
      {children}
    </button>
  );
}

// Plain text only for now. React inserts it as text, so markup inside a message
// shows as characters and never becomes elements. The HTML version needs a
// sanitiser before it can be shown, and that is a step of its own.
function MessageBody({ message }) {
  // Imported mail arrives in two passes, headers first.
  if (message.bodyStatus === 'pending') {
    return <p className="mt-4 text-sm text-stone-500 italic">The text of this message is still being fetched.</p>;
  }
  if (message.bodyText) {
    return <div className="mt-4 text-sm leading-relaxed break-words whitespace-pre-wrap">{message.bodyText}</div>;
  }
  const note =
    message.bodyStatus === 'unavailable'
      ? 'The text of this message could not be fetched from the mail server.'
      : message.bodyHtml
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
