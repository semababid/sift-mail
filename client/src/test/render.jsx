import { StrictMode } from 'react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../app/routes.jsx';

// Mounts the real routes in a memory router with a cache of its own, so no test
// sees another's data. Retries are off, so a failure shows up straight away.
// StrictMode as in main.jsx: effects run twice, so one that sends a request
// twice fails its test here rather than in the browser.
export function renderApp(path = '/') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const router = createMemoryRouter(routes, { initialEntries: [path] });

  const view = render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  );

  return { ...view, router, queryClient, user: userEvent.setup() };
}
