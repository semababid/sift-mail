export default function Splash({ label, children }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-stone-50 p-6 text-sm text-stone-500">
      <p role="status">{label}</p>
      {children}
    </main>
  );
}
