import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api-client.js';
import { useLogout } from '../features/auth/session.js';
import { useSignedInUser } from '../features/auth/guards.jsx';

// A placeholder until the inbox exists in 3.3.
export default function Home() {
  const user = useSignedInUser();
  const logout = useLogout();
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => (await api.get('/health')).data,
  });

  const apiStatus = health.isPending ? 'checking' : health.isError ? 'unreachable' : 'reachable';

  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 p-6 text-stone-900">
      <div className="w-full max-w-sm rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Sift</h1>
        <p className="mt-1 text-sm text-stone-500">
          Signed in as {user.name} ({user.email})
        </p>
        <dl className="mt-6 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-stone-500">API</dt>
            <dd>{apiStatus}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-stone-500">Database</dt>
            <dd>{health.data?.mongo ?? 'unknown'}</dd>
          </div>
        </dl>
        <button
          type="button"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          className="mt-6 w-full rounded-md border border-stone-300 px-3 py-2 text-sm font-medium hover:bg-stone-100 disabled:opacity-60"
        >
          Sign out
        </button>
      </div>
    </main>
  );
}
