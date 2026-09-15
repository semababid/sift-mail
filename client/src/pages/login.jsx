import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import Field from '../components/field.jsx';
import AuthLayout from '../features/auth/auth-layout.jsx';
import { readAuthError, useLogin } from '../features/auth/session.js';

export default function Login() {
  const login = useLogin();
  const location = useLocation();
  const [values, setValues] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);

  const update = (event) => setValues((current) => ({ ...current, [event.target.name]: event.target.value }));

  async function onSubmit(event) {
    event.preventDefault();
    const missing = {};
    if (!values.email.trim()) missing.email = 'Enter your email address.';
    if (!values.password) missing.password = 'Enter your password.';
    setErrors(missing);
    setFormError(null);
    if (Object.keys(missing).length > 0) return;

    // On success there is nothing to do here: the session changes, and the
    // route guard moves the visitor on to wherever they were headed.
    try {
      await login.mutateAsync({ email: values.email.trim(), password: values.password });
    } catch (error) {
      const { message, fields } = readAuthError(error);
      setErrors(fields);
      setFormError(message);
      if (error.response?.data?.code === 'bad_credentials') {
        setValues((current) => ({ ...current, password: '' }));
      }
    }
  }

  return (
    <AuthLayout title="Sign in" subtitle="Welcome back to Sift.">
      {/* noValidate: the browser's own bubbles would compete with these messages. */}
      <form onSubmit={onSubmit} noValidate className="space-y-4">
        {formError && (
          <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
            {formError}
          </p>
        )}
        <Field label="Email" name="email" type="email" autoComplete="email" value={values.email} onChange={update} error={errors.email} />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={values.password}
          onChange={update}
          error={errors.password}
        />
        <button
          type="submit"
          disabled={login.isPending}
          className="w-full rounded-md bg-stone-900 px-3 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-60"
        >
          {login.isPending ? 'Signing in' : 'Sign in'}
        </button>
      </form>
      <p className="mt-6 text-center text-sm text-stone-500">
        New to Sift?{' '}
        <Link to="/register" state={location.state} className="font-medium text-stone-900 underline">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  );
}
