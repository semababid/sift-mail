import { delay, http, HttpResponse } from 'msw';

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

// A stand-in for the mail routes the mailbox reads, filtering the way the real
// list does. The cursor is simply the position the next page starts at.
export function fakeMailApi({ threads = [], messages = {}, labels = [], pageSize = 50 } = {}) {
  const state = { threads, messages, labels, listStatus: null, nextPageStatus: null, batches: [] };
  const calls = [];

  const record = (request) => {
    const url = new URL(request.url);
    calls.push({ call: `${request.method} ${url.pathname}`, url });
  };
  const failure = (status) => HttpResponse.json({ error: 'something went wrong', code: 'internal' }, { status });

  const inView = (thread, folder, label) => {
    if (!label) return thread.folders.includes(folder ?? 'inbox');
    if (!thread.labelIds.includes(label)) return false;
    return folder ? thread.folders.includes(folder) : thread.folders.some((f) => !HIDDEN_FROM_LABELS.includes(f));
  };

  const handlers = [
    http.get('/api/threads', ({ request }) => {
      record(request);
      const params = new URL(request.url).searchParams;
      const cursor = params.get('cursor');
      const status = cursor ? state.nextPageStatus : state.listStatus;
      if (status) return failure(status);

      const matching = state.threads
        .filter((thread) => inView(thread, params.get('folder'), params.get('label')))
        .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
      const start = cursor ? Number(cursor) : 0;
      const end = start + pageSize;
      return HttpResponse.json({
        threads: matching.slice(start, end),
        nextCursor: end < matching.length ? String(end) : null,
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
      if (state.batchStatus) return failure(state.batchStatus);

      const actions = {
        markRead: (t) => ({ ...t, hasUnread: false }),
        archive: (t) => ({ ...t, folders: [...new Set(t.folders.map((f) => (f === 'inbox' ? 'archive' : f)))] }),
      };
      const change = actions[body.action];
      if (!change) return failure(400);

      state.threads = state.threads.map((t) => (body.ids.includes(t.id) ? change(t) : t));
      return HttpResponse.json({ threads: state.threads.filter((t) => body.ids.includes(t.id)) });
    }),

    // Matches the words anywhere in the subject or snippet, and leaves out
    // trash and spam as the real search does. The snippet it sends back is
    // marked, so a test can tell it apart from the thread's own.
    http.get('/api/search', ({ request }) => {
      record(request);
      const q = (new URL(request.url).searchParams.get('q') ?? '').trim().toLowerCase();
      if (!q) return HttpResponse.json({ error: 'validation failed', code: 'invalid_body' }, { status: 400 });

      const results = state.threads
        .filter((t) => t.folders.some((f) => !HIDDEN_FROM_LABELS.includes(f)))
        .filter((t) => `${t.subject} ${t.snippet}`.toLowerCase().includes(q))
        .map((thread) => ({
          thread,
          match: {
            messageId: `match-${thread.id}`,
            subject: thread.subject,
            snippet: `Match: ${thread.snippet}`,
            from: thread.participants[0],
            sentAt: thread.lastMessageAt,
            folder: thread.folders[0],
            score: 1,
          },
        }));
      return HttpResponse.json({ results });
    }),

    http.get('/api/labels', ({ request }) => {
      record(request);
      return HttpResponse.json({ labels: state.labels });
    }),
  ];

  return {
    handlers,
    state,
    count: (call) => calls.filter((c) => c.call === call).length,
    // The cursor of every list request so far, null for a first page.
    cursors: () => calls.filter((c) => c.call === 'GET /api/threads').map((c) => c.url.searchParams.get('cursor')),
  };
}
