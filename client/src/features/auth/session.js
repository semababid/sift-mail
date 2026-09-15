import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api-client.js';

export const sessionKey = ['session'];

async function fetchSession() {
  try {
    return (await api.get('/api/auth/me')).data.user;
  } catch (error) {
    // Nobody signed in, or a session that could not be renewed. Either way the
    // answer is "no user", not an error to put on screen.
    if (error.response?.status === 401) return null;
    throw error;
  }
}

export function useSession() {
  return useQuery({ queryKey: sessionKey, queryFn: fetchSession, staleTime: 5 * 60_000 });
}

// Sets who is signed in. The previous user's cached data is dropped separately,
// in Root, once the pages that were showing it are gone.
export function setSession(queryClient, user) {
  queryClient.setQueryData(sessionKey, user);
}

// Removes everything cached except the session. The session query is only ever
// overwritten, never removed: Root and the login page are watching it, and a
// watched query that is removed gets fetched straight back, which right after
// signing out means asking the server about a session that has just ended.
export function forgetCachedData(queryClient) {
  queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== sessionKey[0] });
}

function useSessionStart(mutationFn) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn, onSuccess: (user) => setSession(queryClient, user) });
}

export const useLogin = () =>
  useSessionStart(async (credentials) => (await api.post('/api/auth/login', credentials)).data.user);

export const useRegister = () =>
  useSessionStart(async (details) => (await api.post('/api/auth/register', details)).data.user);

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/api/auth/logout'),
    // Signed out on this device even if the request failed. Leaving the old
    // session on screen because the network dropped would be the worse outcome.
    onSettled: () => setSession(queryClient, null),
  });
}

// Only a path inside this app. `from` comes from router state rather than the
// URL, but a value that begins with // or /\ is read by browsers as another
// site, and should never become the target.
export function safeRedirect(from) {
  return typeof from === 'string' && /^\/(?![/\\])/.test(from) ? from : '/';
}

const capitalise = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// Turns a failed sign-in or registration into what the form shows: a message
// for the whole form, errors for single fields, or both.
export function readAuthError(error) {
  const response = error?.response;
  if (!response) return { message: 'Sift could not be reached. Check your connection and try again.', fields: {} };

  const { status, data } = response;
  if (status === 429) return { message: 'Too many attempts. Wait a few minutes, then try again.', fields: {} };
  if (data?.code === 'bad_credentials') return { message: 'That email and password do not match an account.', fields: {} };
  if (data?.code === 'email_taken') return { message: null, fields: { email: 'An account with this email already exists.' } };
  if (data?.code === 'invalid_body') {
    const fields = Object.fromEntries(Object.entries(data.fields ?? {}).map(([name, text]) => [name, capitalise(text)]));
    return { message: null, fields };
  }
  return { message: 'Something went wrong. Please try again.', fields: {} };
}
