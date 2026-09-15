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
