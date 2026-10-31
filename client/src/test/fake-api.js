import { delay, http, HttpResponse } from 'msw';
import { SELF } from './mail-fixtures.js';

// A stand-in for the auth routes with the same status codes and error codes as
// the real server. Tests read and change its state directly.
export function fakeAuthApi({ users = [{ email: 'semab@sift.example', password: 'correct-horse', name: 'Semab' }] } = {}) {
  const accounts = new Map(users.map((u) => [u.email, u]));
  const state = { signedIn: null, meStatus: null, loginDelay: 0 };
  const calls = [];

  const record = (request) => calls.push(`${request.method} ${new URL(request.url).pathname}`);
  const publicUser = (email) => ({ id: `id-${email}`, email, name: accounts.get(email).name });
  const unauthorized = (code) => HttpResponse.json({ error: 'not authenticated', code }, { status: 401 });

  const handlers = [
    http.get('/api/auth/me', ({ request }) => {
      record(request);
      if (state.meStatus) return HttpResponse.json({ error: 'something went wrong', code: 'internal' }, { status: state.meStatus });
      return state.signedIn ? HttpResponse.json({ user: publicUser(state.signedIn) }) : unauthorized('not_authenticated');
    }),

    http.post('/api/auth/refresh', ({ request }) => {
      record(request);
      return unauthorized('no_refresh_token');
    }),

    http.post('/api/auth/login', async ({ request }) => {
      record(request);
      const { email, password } = await request.json();
      if (state.loginDelay) await delay(state.loginDelay);
      const account = accounts.get(String(email).toLowerCase());
      if (!account || account.password !== password) {
        return HttpResponse.json({ error: 'email or password is wrong', code: 'bad_credentials' }, { status: 401 });
      }
      state.signedIn = account.email;
      return HttpResponse.json({ user: publicUser(account.email) });
    }),

    http.post('/api/auth/register', async ({ request }) => {
      record(request);
      const { email, password, name } = await request.json();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email ?? '')) {
        return HttpResponse.json(
          { error: 'validation failed', code: 'invalid_body', fields: { email: 'invalid email address' } },
          { status: 400 },
        );
      }
      const key = email.toLowerCase();
      if (accounts.has(key)) {
        return HttpResponse.json({ error: 'an account with that email already exists', code: 'email_taken' }, { status: 409 });
      }
      accounts.set(key, { email: key, password, name });
      state.signedIn = key;
      return HttpResponse.json({ user: publicUser(key) }, { status: 201 });
    }),

    http.post('/api/auth/logout', ({ request }) => {
      record(request);
      state.signedIn = null;
      return new HttpResponse(null, { status: 204 });
    }),

    http.get('/health', ({ request }) => {
      record(request);
      return HttpResponse.json({ ok: true, mongo: 'connected', uptime: 1 });
    }),
  ];

  return { handlers, state, count: (call) => calls.filter((c) => c === call).length };
}

const HIDDEN_FROM_LABELS = ['trash', 'spam'];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const swapFolder = (folders, from, to) => [...new Set(folders.map((f) => (f === from ? to : f)))];

// Each action as the server applies it. `body` is the request, for the bucket
// setBucket names. A fixture's `modelBucket` is what resetBucket goes back to.
const THREAD_ACTIONS = {
  setBucket: (t, body) => ({ ...t, bucket: body.bucket, bucketSource: 'user', modelBucket: t.modelBucket ?? (t.bucketSource === 'model' ? t.bucket : null) }),
  resetBucket: (t) => (t.bucketSource === 'user' ? { ...t, bucket: t.modelBucket ?? null, bucketSource: t.modelBucket ? 'model' : null } : t),
  markRead: (t) => ({ ...t, hasUnread: false }),
  star: (t) => ({ ...t, isStarred: true }),
  unstar: (t) => ({ ...t, isStarred: false }),
  archive: (t) => ({ ...t, folders: swapFolder(t.folders, 'inbox', 'archive') }),
  moveToInbox: (t) => ({ ...t, folders: swapFolder(t.folders, 'archive', 'inbox') }),
};

// A stand-in for the mail routes the mailbox reads and writes, filtering the
// way the real list does. The cursor is simply the position the next page
// starts at.
//
// Thread actions collect in `state.batches` as they arrive and in
// `state.answered` as they are answered, so a test can tell a change shown
// before the server replied from one shown after. `failFor` refuses any action
// on those thread ids, after `failDelay`.
//
// Drafts live in `state.drafts`, sent messages collect in `state.sent`, and
// `state.draftLog` records every draft call in order with what it carried.
export function fakeMailApi({ threads = [], messages = {}, labels = [], drafts = [], pageSize = 50 } = {}) {
  const state = {
    threads,
    messages,
    labels,
    listStatus: null,
    nextPageStatus: null,
    batches: [],
    answered: [],
    failFor: new Set(),
    drafts: new Map(drafts.map((draft) => [draft.id, draft])),
    sent: [],
    draftLog: [],
  };
  const calls = [];
  let draftCount = 0;
  let attachmentCount = 0;

  const record = (request) => {
    const url = new URL(request.url);
    calls.push({ call: `${request.method} ${url.pathname}`, url });
  };
  const failure = (status) => HttpResponse.json({ error: 'something went wrong', code: 'internal' }, { status });
  const draftNotFound = () => HttpResponse.json({ error: 'draft not found', code: 'not_found' }, { status: 404 });
  const people = (addresses) => addresses.map((address) => ({ address }));

  const inView = (thread, folder, label) => {
    if (!label) return thread.folders.includes(folder ?? 'inbox');
    if (!thread.labelIds.includes(label)) return false;
    return folder ? thread.folders.includes(folder) : thread.folders.some((f) => !HIDDEN_FROM_LABELS.includes(f));
  };

  // The answer the server's validation gives, naming the first bad address.
  function refuseBadAddress(body) {
    for (const list of ['to', 'cc', 'bcc']) {
      const index = (body[list] ?? []).findIndex((address) => !EMAIL.test(address));
      if (index !== -1) {
        return HttpResponse.json(
          { error: 'validation failed', code: 'invalid_body', fields: { [`${list}.${index}`]: 'invalid email address' } },
          { status: 400 },
        );
      }
    }
    return null;
  }

  // Logged before any delay, so a test sees a call the moment it is made.
  async function logDraftCall(request, body) {
    const call = `${request.method} ${new URL(request.url).pathname}`;
    state.draftLog.push(body === undefined ? { call } : { call, body });
    if (state.draftDelay) await delay(state.draftDelay);
  }

  const handlers = [
    // The page is read from the state before the delay, as a real server runs
    // its query and then takes a while to deliver it. A slow response can so
    // arrive carrying data that is out of date by the time it lands.
    http.get('/api/threads', async ({ request }) => {
      record(request);
      const params = new URL(request.url).searchParams;
      const cursor = params.get('cursor');
      const status = cursor ? state.nextPageStatus : state.listStatus;

      const matching = state.threads
        .filter((thread) => inView(thread, params.get('folder'), params.get('label')))
        .filter((thread) => !params.get('bucket') || thread.bucket === params.get('bucket'))
        .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
      const start = cursor ? Number(cursor) : 0;
      const end = start + pageSize;
      const page = { threads: matching.slice(start, end), nextCursor: end < matching.length ? String(end) : null };

      if (state.listDelay) await delay(state.listDelay);
      if (status) return failure(status);
      return HttpResponse.json(page);
    }),

    http.get('/api/threads/buckets', ({ request }) => {
      record(request);
      const folder = new URL(request.url).searchParams.get('folder') ?? 'inbox';
      const inFolder = state.threads.filter((t) => t.folders.includes(folder));
      const count = (bucket) => inFolder.filter((t) => t.bucket === bucket).length;
      return HttpResponse.json({
        buckets: { needs_reply: count('needs_reply'), waiting_on_them: count('waiting_on_them'), do_at_a_time: count('do_at_a_time'), read_only: count('read_only') },
      });
    }),

    http.get('/api/threads/:id', ({ request, params }) => {
      record(request);
      const thread = state.threads.find((t) => t.id === params.id);
      if (!thread) return HttpResponse.json({ error: 'thread not found', code: 'not_found' }, { status: 404 });
      return HttpResponse.json({ thread, messages: state.messages[thread.id] ?? [] });
    }),

    http.post('/api/threads/batch', async ({ request }) => {
      record(request);
      const body = await request.json();
      state.batches.push(body);

      const failing = Boolean(state.batchStatus) || body.ids.some((id) => state.failFor.has(id));
      const wait = failing ? (state.failDelay ?? state.batchDelay) : state.batchDelay;
      if (wait) await delay(wait);
      state.answered.push(failing ? `${body.action}:failed` : body.action);
      if (failing) return failure(state.batchStatus ?? 500);

      const change = THREAD_ACTIONS[body.action];
      if (!change) return failure(400);
      state.threads = state.threads.map((t) => (body.ids.includes(t.id) ? change(t, body) : t));
      return HttpResponse.json({ threads: state.threads.filter((t) => body.ids.includes(t.id)) });
    }),

    // Matches the words anywhere in the subject or snippet, and leaves out
    // trash and spam as the real search does. The snippet it sends back is
    // marked, so a test can tell it apart from the thread's own. It searches
    // by keyword and meaning unless `state.searchMode` says "keyword", and
    // with debug=true gives each result made-up ranks: every one found by
    // keyword, and all but the first by meaning too.
    http.get('/api/search', async ({ request }) => {
      record(request);
      const params = new URL(request.url).searchParams;
      const q = (params.get('q') ?? '').trim().toLowerCase();
      if (!q) return HttpResponse.json({ error: 'validation failed', code: 'invalid_body' }, { status: 400 });
      if (state.searchDelay) await delay(state.searchDelay);
      const debug = params.get('debug') === 'true';
      const mode = state.searchMode ?? 'hybrid';

      const results = state.threads
        .filter((t) => t.folders.some((f) => !HIDDEN_FROM_LABELS.includes(f)))
        .filter((t) => `${t.subject} ${t.snippet}`.toLowerCase().includes(q))
        .map((thread, i) => ({
          thread,
          match: {
            messageId: `match-${thread.id}`,
            subject: thread.subject,
            snippet: `Match: ${thread.snippet}`,
            from: thread.participants[0],
            sentAt: thread.lastMessageAt,
            folder: thread.folders[0],
            score: 1 / (61 + i),
          },
          ...(debug && {
            debug: {
              keyword: { rank: i + 1, score: 3 - i * 0.5 },
              vector: mode === 'hybrid' && i > 0 ? { rank: i, score: 0.9 - i * 0.01 } : null,
            },
          }),
        }));
      return HttpResponse.json({
        results,
        mode,
        ...(debug && mode === 'keyword' && { vectorUnavailable: 'unavailable' }),
      });
    }),

    // Answers with the bytes in `state.files`, keyed "messageId/attachmentId".
    http.get('/api/messages/:id/attachments/:attachmentId', ({ request, params }) => {
      record(request);
      const file = state.files?.[`${params.id}/${params.attachmentId}`];
      if (!file) return HttpResponse.json({ error: 'attachment not found', code: 'not_found' }, { status: 404 });
      if (state.fileStatus) return failure(state.fileStatus);
      return new HttpResponse(file, { headers: { 'Content-Type': 'application/octet-stream' } });
    }),

    http.get('/api/labels', ({ request }) => {
      record(request);
      return HttpResponse.json({ labels: state.labels });
    }),

    http.post('/api/drafts', async ({ request }) => {
      record(request);
      const body = await request.json();
      await logDraftCall(request, body);
      if (state.draftStatus) return failure(state.draftStatus);
      const refused = refuseBadAddress(body);
      if (refused) return refused;

      draftCount += 1;
      const draft = {
        id: `draft-${draftCount}`,
        threadId: body.threadId ?? `thread-of-draft-${draftCount}`,
        from: SELF,
        to: people(body.to ?? []),
        cc: people(body.cc ?? []),
        bcc: people(body.bcc ?? []),
        subject: body.subject ?? '',
        bodyText: body.bodyText ?? '',
        bodyHtml: '',
        attachments: [],
        isDraft: true,
        folder: 'drafts',
        sentAt: new Date().toISOString(),
      };
      state.drafts.set(draft.id, draft);
      return HttpResponse.json({ draft }, { status: 201 });
    }),

    http.patch('/api/drafts/:id', async ({ request, params }) => {
      record(request);
      const body = await request.json();
      await logDraftCall(request, body);
      if (state.draftStatus) return failure(state.draftStatus);
      const current = state.drafts.get(params.id);
      if (!current) return draftNotFound();
      const refused = refuseBadAddress(body);
      if (refused) return refused;

      const draft = {
        ...current,
        ...(body.to && { to: people(body.to) }),
        ...(body.cc && { cc: people(body.cc) }),
        ...(body.bcc && { bcc: people(body.bcc) }),
        ...(body.subject !== undefined && { subject: body.subject }),
        ...(body.bodyText !== undefined && { bodyText: body.bodyText }),
      };
      state.drafts.set(draft.id, draft);
      return HttpResponse.json({ draft });
    }),

    // The raw file as the body, its name and type in the query string. Refuses
    // with `state.uploadStatus` when set, after `state.uploadDelay`.
    http.post('/api/drafts/:id/attachments', async ({ request, params }) => {
      record(request);
      const url = new URL(request.url);
      const bytes = new Uint8Array(await request.arrayBuffer());
      state.uploads = [...(state.uploads ?? []), {
        draftId: params.id,
        filename: url.searchParams.get('filename'),
        type: url.searchParams.get('type'),
        contentType: request.headers.get('content-type'),
        text: new TextDecoder().decode(bytes),
      }];
      if (state.uploadDelay) await delay(state.uploadDelay);
      if (state.uploadStatus === 413) {
        return HttpResponse.json(
          { error: 'attachments can add up to 25 MB per message', code: 'attachment_too_large' },
          { status: 413 },
        );
      }
      if (state.uploadStatus) return failure(state.uploadStatus);
      const draft = state.drafts.get(params.id);
      if (!draft) return draftNotFound();

      attachmentCount += 1;
      const attachment = {
        id: `att-${attachmentCount}`,
        filename: url.searchParams.get('filename'),
        contentType: url.searchParams.get('type') ?? 'application/octet-stream',
        size: bytes.length,
        stored: true,
      };
      state.files = { ...state.files, [`${draft.id}/${attachment.id}`]: bytes };
      const updated = { ...draft, attachments: [...(draft.attachments ?? []), attachment] };
      state.drafts.set(draft.id, updated);
      return HttpResponse.json({ draft: updated }, { status: 201 });
    }),

    http.delete('/api/drafts/:id/attachments/:attachmentId', ({ request, params }) => {
      record(request);
      state.removals = [...(state.removals ?? []), params.attachmentId];
      const draft = state.drafts.get(params.id);
      if (!draft?.attachments?.some((a) => a.id === params.attachmentId)) {
        return HttpResponse.json({ error: 'attachment not found', code: 'not_found' }, { status: 404 });
      }
      const updated = { ...draft, attachments: draft.attachments.filter((a) => a.id !== params.attachmentId) };
      state.drafts.set(draft.id, updated);
      return HttpResponse.json({ draft: updated });
    }),

    http.delete('/api/drafts/:id', async ({ request, params }) => {
      record(request);
      await logDraftCall(request);
      if (!state.drafts.delete(params.id)) return draftNotFound();
      return new HttpResponse(null, { status: 204 });
    }),

    http.post('/api/drafts/:id/send', async ({ request, params }) => {
      record(request);
      await logDraftCall(request);
      if (state.sendDelay) await delay(state.sendDelay);
      if (state.sendStatus) return failure(state.sendStatus);
      const draft = state.drafts.get(params.id);
      if (!draft) return draftNotFound();
      if (draft.to.length + draft.cc.length + draft.bcc.length === 0) {
        return HttpResponse.json({ error: 'add at least one recipient', code: 'no_recipients' }, { status: 400 });
      }

      state.drafts.delete(draft.id);
      const message = { ...draft, isDraft: false, folder: 'sent' };
      state.sent.push(message);
      return HttpResponse.json({ message, thread: { id: draft.threadId } }, { status: 201 });
    }),
  ];

  return {
    handlers,
    state,
    count: (call) => calls.filter((c) => c.call === call).length,
    // The cursor of every list request so far, null for a first page.
    cursors: () => calls.filter((c) => c.call === 'GET /api/threads').map((c) => c.url.searchParams.get('cursor')),
    // The query of every search so far.
    searches: () => calls.filter((c) => c.call === 'GET /api/search').map((c) => Object.fromEntries(c.url.searchParams)),
  };
}
