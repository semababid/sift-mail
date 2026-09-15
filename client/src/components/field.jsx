// A labelled input with room for one line underneath: the error when there is
// one, otherwise the hint. Either is tied to the input for screen readers.
export default function Field({ label, name, error, hint, ...inputProps }) {
  const noteId = `${name}-note`;
  const note = error || hint;

  return (
    <div>
      <label htmlFor={name} className="block text-sm font-medium text-stone-700">
        {label}
      </label>
      <input
        id={name}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={note ? noteId : undefined}
        className={`mt-1 block w-full rounded-md border px-3 py-2 text-sm shadow-sm outline-none focus:ring-2 ${
          error ? 'border-red-400 focus:ring-red-100' : 'border-stone-300 focus:ring-sky-100'
        }`}
        {...inputProps}
      />
      {note && (
        <p id={noteId} className={`mt-1 text-sm ${error ? 'text-red-600' : 'text-stone-500'}`}>
          {note}
        </p>
      )}
    </div>
  );
}
