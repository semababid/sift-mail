import { useEffect, useRef } from 'react';
import { Outlet } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { SESSION_EXPIRED } from '../lib/api-client.js';
import { forgetCachedData, setSession, useSession } from '../features/auth/session.js';

// Wraps every route. It sets the session to nobody when the api client gives up
// on renewing it, and drops the cached data of a user who is no longer signed in.
export default function Root() {
  const queryClient = useQueryClient();
  const userId = useSession().data?.id ?? null;
  const previousUserId = useRef(userId);

  useEffect(() => {
    const onExpired = () => setSession(queryClient, null);
    window.addEventListener(SESSION_EXPIRED, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED, onExpired);
  }, [queryClient]);

  // An effect runs after React has put the change on screen, so by now the
  // signed-in pages are gone and nothing is watching their queries. Removing a
  // query while a mounted page watches it makes that page fetch it straight
  // back, which left the old user's data in the cache after signing out.
  useEffect(() => {
    if (previousUserId.current && previousUserId.current !== userId) forgetCachedData(queryClient);
    previousUserId.current = userId;
  }, [userId, queryClient]);

  return <Outlet />;
}
