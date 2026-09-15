import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api-client.js';

// A placeholder until the inbox exists. It shows that the pieces are joined up:
// the request goes through the dev proxy and TanStack Query, and the page is
// styled by Tailwind.
export default function Home() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => (await api.get('/health')).data,
  });

  const apiStatus = health.isPending ? 'checking' : health.isError ? 'unreachable' : 'reachable';
  const database = health.data?.mongo ?? 'unknown';

  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 p-6 text-stone-900">
      <div className="w-full max-w-sm rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
        <h1 className="text-2xl font-semibold tracking-tight">Sift</h1>
        <p className="mt-1 text-sm text-stone-500">A mail client that reads your inbox before you do.</p>
        <dl className="mt-6 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-stone-500">API</dt>
            <dd data-testid="api-status">{apiStatus}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-stone-500">Database</dt>
            <dd data-testid="db-status">{database}</dd>
          </div>
        </dl>
      </div>
    </main>
  );
}
