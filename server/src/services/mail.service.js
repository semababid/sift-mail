import crypto from 'node:crypto';
import { User, Thread, Message } from '../models/index.js';
import { refreshThread } from './thread-summary.js';
import { makeSnippet, normalizeSubject, stripReplyPrefix } from '../lib/text.js';
import { badRequest, notFound } from '../lib/errors.js';

// Internal mail never leaves the server yet, so it gets an RFC Message-ID of
// its own making. Having one now means replies thread through the same
// References lookup that real mail will use from stage 4.
const newRfcMessageId = () => `<${crypto.randomUUID()}@sift.local>`;

// References grow by one id per reply. Threading only needs the recent end,
// and mail clients commonly trim the chain around this length.
const MAX_REFERENCES = 20;

// Lowercases and deduplicates across all three lists. An address given twice
// keeps its most visible place: to over cc, cc over bcc.
function collectRecipients({ to = [], cc = [], bcc = [] }) {
  const seen = new Set();
  const keep = (list) => {
    const out = [];
    for (const raw of list) {
      const address = raw.toLowerCase();
      if (seen.has(address)) continue;
      seen.add(address);
      out.push(address);
    }
    return out;
  };
  return { to: keep(to), cc: keep(cc), bcc: keep(bcc) };
}

const ownAddress = (user) => ({ name: user.name, address: user.email });
const asAddresses = (list) => list.map((address) => ({ address }));
// A reply to mail with no subject keeps no subject. "Re: " on its own is
// what a client shows when this is not handled.
function replySubject(thread) {
  const bare = stripReplyPrefix(thread.subject);
  return bare ? `Re: ${bare}` : '';
}

async function findOwnThread(user, threadId) {
  const thread = await Thread.findOne({ _id: threadId, userId: user._id });
  if (!thread) throw notFound('thread not found');
  return thread;
}

// Whether a message in this thread would be a reply, and which earlier message
// its headers should point at. Those can differ: seeded mail and self-sent
// copies carry no Message-ID, so the newest message is not always one a
// References chain can name.
async function replyContext(thread, excludeId) {
  if (!thread) return { isReply: false, parent: null };

  const filter = { threadId: thread._id, isDraft: false };
  // The draft being sent is already unmarked by the time this runs, so without
  // this it would count as the newest message in its own thread. Drafts carry
  // no Message-ID today, which makes that harmless. Drafts synced from a real
  // mailbox in stage 4 do carry one, and would end up replying to themselves.
  if (excludeId) filter._id = { $ne: excludeId };

  const recent = await Message.find(filter)
    .sort({ sentAt: -1, _id: -1 })
    .limit(MAX_REFERENCES)
    .select('rfcMessageId references')
    .lean();

  return { isReply: recent.length > 0, parent: recent.find((m) => m.rfcMessageId) ?? null };
}

// The recipient's side of the conversation: whichever of their threads holds a
// message this one refers to. Failing that, the conversation is new to them.
async function recipientThreadId(recipient, { inReplyTo, references, subject, sentAt }) {
  const ids = [...references, inReplyTo].filter(Boolean);
  if (ids.length > 0) {
    const earlier = await Message.findOne({ userId: recipient._id, rfcMessageId: { $in: ids } })
      .sort({ sentAt: -1 })
      .select('threadId');
    if (earlier) return earlier.threadId;
  }

  const thread = await Thread.create({
    userId: recipient._id,
    subject,
    normalizedSubject: normalizeSubject(subject),
    lastMessageAt: sentAt,
  });
  return thread._id;
}

export async function sendMessage(sender, input, { draft } = {}) {
  const lists = collectRecipients(input);
  const everyone = [...lists.to, ...lists.cc, ...lists.bcc];
  if (everyone.length === 0) throw badRequest('add at least one recipient', 'no_recipients');

  const users = await User.find({ email: { $in: everyone } }).select('name email');
  const byAddress = new Map(users.map((u) => [u.email, u]));
  const named = (address) => ({ name: byAddress.get(address)?.name, address });
  const to = lists.to.map(named);
  const cc = lists.cc.map(named);
  const bcc = lists.bcc.map(named);

  const threadId = draft?.threadId ?? input.threadId;
  let thread = threadId ? await findOwnThread(sender, threadId) : null;
  const { isReply, parent } = await replyContext(thread, draft?._id);

  const subject = input.subject ?? (isReply ? replySubject(thread) : '');
  const bodyText = input.bodyText ?? '';
  const sentAt = new Date();
  const rfcMessageId = newRfcMessageId();
  const inReplyTo = parent?.rfcMessageId ?? null;
  const references = parent
    ? [...parent.references, parent.rfcMessageId].slice(-MAX_REFERENCES)
    : [];

  const shared = {
    from: ownAddress(sender),
    to,
    cc,
    subject,
    bodyText,
    snippet: makeSnippet(bodyText),
    sentAt,
    inReplyTo,
    references,
  };

  if (!thread) {
    thread = await Thread.create({
      userId: sender._id,
      subject,
      normalizedSubject: normalizeSubject(subject),
      lastMessageAt: sentAt,
    });
  }

  // trashedFrom is cleared in case this was a draft sent from inside a trashed
  // conversation, so a later trash and restore returns it to sent.
  const sentCopy = {
    ...shared,
    bcc,
    rfcMessageId,
    folder: 'sent',
    isDraft: false,
    isRead: true,
    trashedFrom: null,
  };
  let message;
  if (draft) {
    draft.set(sentCopy);
    message = await draft.save();
  } else {
    message = await Message.create({ ...sentCopy, userId: sender._id, threadId: thread._id });
  }
  const senderThread = await refreshThread(thread._id);

  // One inbox copy per Sift user on the message, each filed in that user's own
  // thread. Addresses without an account stay on the sent copy, where stage 4
  // will pick them up for SMTP.
  for (const recipient of users) {
    const isSelf = recipient._id.equals(sender._id);
    const recipientThread = isSelf
      ? thread._id
      : await recipientThreadId(recipient, { inReplyTo, references, subject, sentAt });

    await Message.create({
      ...shared,
      // A bcc recipient sees their own address and nobody else's. Everyone
      // else sees no bcc at all. The sender's copy is the only full list.
      bcc: bcc.filter((b) => b.address === recipient.email),
      // Mail to yourself puts both copies under one user, and the per-user
      // unique index on rfcMessageId would refuse the second. The sent copy
      // keeps the id, which is all a later reply needs to find the thread.
      rfcMessageId: isSelf ? null : rfcMessageId,
      userId: recipient._id,
      threadId: recipientThread,
      folder: 'inbox',
      isRead: false,
    });
    await refreshThread(recipientThread);
  }

  return { message, thread: senderThread };
}

export async function createDraft(user, input) {
  const now = new Date();
  let thread;
  let subject = input.subject;

  if (input.threadId) {
    thread = await findOwnThread(user, input.threadId);
    subject ??= replySubject(thread);
  } else {
    subject ??= '';
    thread = await Thread.create({
      userId: user._id,
      subject,
      normalizedSubject: normalizeSubject(subject),
      lastMessageAt: now,
    });
  }

  const lists = collectRecipients(input);
  const bodyText = input.bodyText ?? '';
  const draft = await Message.create({
    userId: user._id,
    threadId: thread._id,
    from: ownAddress(user),
    to: asAddresses(lists.to),
    cc: asAddresses(lists.cc),
    bcc: asAddresses(lists.bcc),
    subject,
    bodyText,
    snippet: makeSnippet(bodyText),
    folder: 'drafts',
    isDraft: true,
    isRead: true,
    // For a draft, sentAt is when it was last saved.
    sentAt: now,
  });

  await refreshThread(thread._id);
  return draft;
}

export async function updateDraft(user, draftId, patch) {
  const current = await Message.findOne({ _id: draftId, userId: user._id, isDraft: true });
  if (!current) throw notFound('draft not found');

  const existing = (field) => current[field].map((a) => a.address);
  const lists = collectRecipients({
    to: patch.to ?? existing('to'),
    cc: patch.cc ?? existing('cc'),
    bcc: patch.bcc ?? existing('bcc'),
  });

  const changes = {
    to: asAddresses(lists.to),
    cc: asAddresses(lists.cc),
    bcc: asAddresses(lists.bcc),
    sentAt: new Date(),
  };
  if (patch.subject !== undefined) changes.subject = patch.subject;
  if (patch.bodyText !== undefined) {
    changes.bodyText = patch.bodyText;
    changes.snippet = makeSnippet(patch.bodyText);
  }

  // Conditional on still being a draft. An autosave that lands just after the
  // draft was sent must not rewrite the message that went out.
  const draft = await Message.findOneAndUpdate(
    { _id: current._id, isDraft: true },
    { $set: changes },
    { new: true },
  );
  if (!draft) throw notFound('draft not found');

  await refreshThread(draft.threadId);
  return draft;
}

export async function deleteDraft(user, draftId) {
  const draft = await Message.findOneAndDelete({ _id: draftId, userId: user._id, isDraft: true });
  if (!draft) throw notFound('draft not found');
  await refreshThread(draft.threadId);
}

export async function sendDraft(user, draftId) {
  const draft = await Message.findOne({ _id: draftId, userId: user._id, isDraft: true });
  if (!draft) throw notFound('draft not found');
  if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
    throw badRequest('add at least one recipient', 'no_recipients');
  }

  // Claimed in one atomic write, so a double click or two open tabs cannot
  // deliver the same draft twice. The loser gets the same 404 as a draft that
  // never existed.
  const claimed = await Message.findOneAndUpdate(
    { _id: draft._id, isDraft: true },
    { $set: { isDraft: false } },
    { new: true },
  );
  if (!claimed) throw notFound('draft not found');

  try {
    return await sendMessage(
      user,
      {
        to: claimed.to.map((a) => a.address),
        cc: claimed.cc.map((a) => a.address),
        bcc: claimed.bcc.map((a) => a.address),
        subject: claimed.subject,
        bodyText: claimed.bodyText,
      },
      { draft: claimed },
    );
  } catch (err) {
    // Only reachable before the draft was turned into the sent copy, so it is
    // still sitting in drafts and can go back to being editable.
    await Message.updateOne({ _id: claimed._id, folder: 'drafts' }, { $set: { isDraft: true } });
    throw err;
  }
}
