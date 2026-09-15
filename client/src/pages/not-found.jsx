import { Link } from 'react-router';

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-3 bg-stone-50 text-stone-900">
      <p className="text-sm text-stone-500">404</p>
      <h1 className="text-xl font-semibold">Nothing here</h1>
      <Link to="/" className="text-sm text-sky-700 underline">
        Back to Sift
      </Link>
    </main>
  );
}
