export default function AuthLayout({ title, subtitle, children }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-stone-50 p-6 text-stone-900">
      <div className="w-full max-w-sm">
        <p className="mb-8 text-center text-lg font-semibold tracking-tight">Sift</p>
        <div className="rounded-xl border border-stone-200 bg-white p-6 shadow-sm">
          <h1 className="text-xl font-semibold">{title}</h1>
          <p className="mt-1 mb-6 text-sm text-stone-500">{subtitle}</p>
          {children}
        </div>
      </div>
    </main>
  );
}
