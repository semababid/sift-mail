import { QueryClient } from '@tanstack/react-query';

// A 4xx will not change on a second try, and a 401 has already been through
// the refresh in the api client by the time a query sees it. Network failures
// and 5xx get two more attempts.
export function shouldRetry(failureCount, error) {
  const status = error?.response?.status;
  if (status >= 400 && status < 500) return false;
  return failureCount < 2;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: shouldRetry,
    },
  },
});
