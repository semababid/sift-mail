import { Navigate } from 'react-router';
import Root from './root.jsx';
import { PublicOnly, RequireSession } from '../features/auth/guards.jsx';
import Mailbox from '../pages/mailbox.jsx';
import Login from '../pages/login.jsx';
import Register from '../pages/register.jsx';
import NotFound from '../pages/not-found.jsx';

// Kept apart from the browser router so tests can mount the same routes in a
// memory router.
export const routes = [
  {
    element: <Root />,
    children: [
      {
        element: <PublicOnly />,
        children: [
          { path: '/login', element: <Login /> },
          { path: '/register', element: <Register /> },
        ],
      },
      {
        element: <RequireSession />,
        children: [
          { path: '/', element: <Navigate to="/inbox" replace /> },
          // "search" and "label" are fixed segments, so these rank above the
          // folder route.
          { path: '/search/:threadId?', element: <Mailbox mode="search" /> },
          { path: '/label/:labelId/:threadId?', element: <Mailbox mode="label" /> },
          // Any other single segment lands here; the mailbox shows a 404 for
          // one that is not a folder.
          { path: '/:folder/:threadId?', element: <Mailbox mode="folder" /> },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
];
