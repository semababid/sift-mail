import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import Field from '../components/field.jsx';
import AuthLayout from '../features/auth/auth-layout.jsx';
import { readAuthError, useRegister } from '../features/auth/session.js';

const MIN_PASSWORD = 10;

export default function Register() {
  const registerAccount = useRegister();
  const location = useLocation();
  const [values, setValues] = useState({ name: '', email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);

  const update = (event) => setValues((current) => ({ ...current, [event.target.name]: event.target.value }));

  async function onSubmit(event) {
    event.preventDefault();
    const found = {};
    if (!values.name.trim()) found.name = 'Enter your name.';
    if (!values.email.trim()) found.email = 'Enter your email address.';
    if (values.password.length < MIN_PASSWORD) found.password = `Use at least ${MIN_PASSWORD} characters.`;
    setErrors(found);
    setFormError(null);
    if (Object.keys(found).length > 0) return;

    try {
      await registerAccount.mutateAsync({
        name: values.name.trim(),
        email: values.email.trim(),
        password: values.password,
      });
    } catch (error) {
      const { message, fields } = readAuthError(error);
      setErrors(fields);
      setFormError(message);
    }
  }

  return (
    <AuthLayout title="Create an account" subtitle="Your inbox, sorted by what it asks of you.">
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {formError && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {formError}
          </p>
        )}
        <Field label="Name" name="name" autoComplete="name" value={values.name} onChange={update} error={errors.name} />
        <Field label="Email" name="email" type="email" autoComplete="email" value={values.email} onChange={update} error={errors.email} />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          hint={`At least ${MIN_PASSWORD} characters.`}
          value={values.password}
          onChange={update}
          error={errors.password}
        />
        <button
          type="submit"
          disabled={registerAccount.isPending}
          className="w-full rounded-md bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
        >
          {registerAccount.isPending ? 'Creating account' : 'Create account'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-stone-500">
        Already have an account?{' '}
        <Link to="/login" state={location.state} className="font-medium text-stone-900 underline">
          Sign in
        </Link>
      </p>
    </AuthLayout>
  );
}
