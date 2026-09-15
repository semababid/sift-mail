import { createContext, useContext } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import Splash from '../../components/splash.jsx';
import { safeRedirect, useSession } from './session.js';

const SignedInUserContext = createContext(null);

// Pages that need someone signed in. A visitor without a session goes to the
// login page, carrying the address they asked for so they can come back to it.
export function RequireSession() {
  const session = useSession();
  const location = useLocation();

  if (session.isPending) return <Splash label="Checking your session" />;
  if (session.data) {
    return (
      <SignedInUserContext.Provider value={session.data}>
        <Outlet />
      </SignedInUserContext.Provider>
    );
  }
  if (session.isError) {
    return (
      <Splash label="Sift could not check your session.">
        <button
          type="button"
          onClick={() => session.refetch()}
          className="mt-3 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 hover:bg-stone-100"
        >
          Try again
        </button>
      </Splash>
    );
  }
  return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
}

// Login and registration. Someone already signed in has no use for them.
export function PublicOnly() {
  const session = useSession();
  const location = useLocation();

  if (session.isPending) return <Splash label="Checking your session" />;
  if (session.data) return <Navigate to={safeRedirect(location.state?.from)} replace />;
  return <Outlet />;
}

// The signed-in user, for any page behind RequireSession. Pages read it here
// rather than from the session query. On sign-out that query turns to null,
// and a page reading it directly can re-render with the null before the guard
// has taken the page away, which crashed the first version of the home page.
// This value only changes when the guard renders, so a page that is on its way
// out still sees the user it was showing.
export function useSignedInUser() {
  const user = useContext(SignedInUserContext);
  if (!user) throw new Error('useSignedInUser only works on pages behind RequireSession');
  return user;
}
