import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { server } from '../../test/server.js';
import { fakeAuthApi, fakeMailApi } from '../../test/fake-api.js';
import { renderApp } from '../../test/render.jsx';
import { safeRedirect } from './session.js';

let api;
let mail;

beforeEach(() => {
  api = fakeAuthApi();
  mail = fakeMailApi();
  server.use(...api.handlers, ...mail.handlers);
});

const pathOf = (router) => `${router.state.location.pathname}${router.state.location.search}`;

async function signInThroughForm(user, email = 'semab@sift.example', password = 'correct-horse') {
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Password'), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

// The mailbox is on screen, with this person signed in.
async function expectSignedInAs(name) {
  expect(await screen.findByRole('region', { name: 'Signed in' })).toHaveTextContent(name);
}

describe('signing in', () => {
  it('sends a visitor without a session to the login page', async () => {
    const { router } = renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(pathOf(router)).toBe('/login');
  });

  it('signs in and returns to the page first asked for', async () => {
    const { router, user } = renderApp('/sent?page=2');
    await screen.findByRole('heading', { name: 'Sign in' });

    await signInThroughForm(user);
    await expectSignedInAs('Semab');
    expect(pathOf(router)).toBe('/sent?page=2');
  });

  it('explains a wrong password, clears it, and keeps the email', async () => {
    const { user } = renderApp('/login');
    await screen.findByRole('heading', { name: 'Sign in' });

    await signInThroughForm(user, 'semab@sift.example', 'not-the-password');
    expect(await screen.findByRole('alert')).toHaveTextContent('That email and password do not match an account.');
    expect(screen.getByLabelText('Email')).toHaveValue('semab@sift.example');
    expect(screen.getByLabelText('Password')).toHaveValue('');
  });

  it('checks for empty fields before sending anything', async () => {
    const { user } = renderApp('/login');
    await screen.findByRole('heading', { name: 'Sign in' });

    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Enter your email address.');
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Enter your password.');
    expect(api.count('POST /api/auth/login')).toBe(0);
  });

  it('disables the button while the sign-in is on its way', async () => {
    api.state.loginDelay = 150;
    const { user } = renderApp('/login');
    await screen.findByRole('heading', { name: 'Sign in' });

    await signInThroughForm(user);
    expect(await screen.findByRole('button', { name: 'Signing in' })).toBeDisabled();
    await expectSignedInAs('Semab');
  });

  it('sends someone already signed in away from the login page', async () => {
    api.state.signedIn = 'semab@sift.example';
    const { router } = renderApp('/login');
    await expectSignedInAs('Semab');
    expect(pathOf(router)).toBe('/inbox');
  });

  it('offers to try again when the session cannot be checked', async () => {
    api.state.meStatus = 500;
    const { user } = renderApp('/');
    expect(await screen.findByText('Sift could not check your session.')).toBeInTheDocument();

    api.state.meStatus = null;
    api.state.signedIn = 'semab@sift.example';
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await expectSignedInAs('Semab');
  });
});

describe('creating an account', () => {
  async function fillRegistration(user, { name = 'Mara Klein', email = 'mara@sift.example', password = 'lange-passphrase' } = {}) {
    if (name) await user.type(screen.getByLabelText('Name'), name);
    if (email) await user.type(screen.getByLabelText('Email'), email);
    if (password) await user.type(screen.getByLabelText('Password'), password);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
  }

  it('creates the account and signs the new user in', async () => {
    const { router, user } = renderApp('/register');
    await screen.findByRole('heading', { name: 'Create an account' });

    await fillRegistration(user);
    await expectSignedInAs('Mara Klein');
    expect(pathOf(router)).toBe('/inbox');
  });

  it('points at the email field when the address is already taken', async () => {
    const { user } = renderApp('/register');
    await screen.findByRole('heading', { name: 'Create an account' });

    await fillRegistration(user, { email: 'semab@sift.example' });
    await waitFor(() =>
      expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('An account with this email already exists.'),
    );
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });

  it('shows the field errors the server sends back', async () => {
    const { user } = renderApp('/register');
    await screen.findByRole('heading', { name: 'Create an account' });

    await fillRegistration(user, { email: 'not-an-email' });
    await waitFor(() => expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Invalid email address'));
  });

  it('asks for a longer password before sending anything', async () => {
    const { user } = renderApp('/register');
    await screen.findByRole('heading', { name: 'Create an account' });

    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('At least 10 characters.');
    await fillRegistration(user, { password: 'kurz' });
    expect(screen.getByLabelText('Password')).toHaveAccessibleDescription('Use at least 10 characters.');
    expect(api.count('POST /api/auth/register')).toBe(0);
  });

  it('keeps where the visitor was headed when they switch from signing in to registering', async () => {
    const { router, user } = renderApp('/sent');
    await screen.findByRole('heading', { name: 'Sign in' });

    await user.click(screen.getByRole('link', { name: 'Create an account' }));
    await screen.findByRole('heading', { name: 'Create an account' });
    await fillRegistration(user);
    await expectSignedInAs('Mara Klein');
    expect(pathOf(router)).toBe('/sent');
  });
});

describe('leaving', () => {
  it('signs out, returns to login, and forgets what was cached', async () => {
    api.state.signedIn = 'semab@sift.example';
    const { router, user, queryClient } = renderApp('/inbox');
    await expectSignedInAs('Semab');
    const inbox = ['threads', { folder: 'inbox' }];
    await waitFor(() => expect(queryClient.getQueryData(inbox)).toBeDefined());
    await waitFor(() => expect(queryClient.getQueryData(['labels'])).toBeDefined());
    const listLoads = mail.count('GET /api/threads');
    const labelLoads = mail.count('GET /api/labels');
    const sessionChecks = api.count('GET /api/auth/me');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(pathOf(router)).toBe('/login');
    expect(queryClient.getQueryData(inbox)).toBeUndefined();
    expect(queryClient.getQueryData(['labels'])).toBeUndefined();
    expect(api.count('POST /api/auth/logout')).toBe(1);
    // Nothing fetched the mailbox's data back after it was dropped, and nothing
    // asked the server about the session that had just ended.
    expect(mail.count('GET /api/threads')).toBe(listLoads);
    expect(mail.count('GET /api/labels')).toBe(labelLoads);
    expect(api.count('GET /api/auth/me')).toBe(sessionChecks);
  });

  it('goes back to login when the session ends on the server, and stops asking', async () => {
    api.state.signedIn = 'semab@sift.example';
    const { router, queryClient } = renderApp('/');
    await expectSignedInAs('Semab');

    // The session ends elsewhere. The next check fails, the refresh is refused,
    // and the api client reports the session as expired.
    api.state.signedIn = null;
    await queryClient.invalidateQueries({ queryKey: ['session'] });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeInTheDocument();
    expect(pathOf(router)).toBe('/login');

    // Nothing keeps checking once the visitor is on the login page.
    const checks = api.count('GET /api/auth/me');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(api.count('GET /api/auth/me')).toBe(checks);
  });
});

describe('where sign-in may send someone', () => {
  it.each([
    ['/', '/'],
    ['/sent?page=2', '/sent?page=2'],
    ['/inbox/abc', '/inbox/abc'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['', '/'],
    [undefined, '/'],
    [42, '/'],
  ])('%s leads to %s', (from, to) => {
    expect(safeRedirect(from)).toBe(to);
  });
});
