import { createBrowserRouter } from 'react-router';
import Home from '../pages/home.jsx';
import NotFound from '../pages/not-found.jsx';

export const router = createBrowserRouter([
  { path: '/', element: <Home /> },
  { path: '*', element: <NotFound /> },
]);
