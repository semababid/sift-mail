import Root from './root.jsx';
import { PublicOnly, RequireSession } from '../features/auth/guards.jsx';
import Home from '../pages/home.jsx';
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
        children: [{ path: '/', element: <Home /> }],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
];
