import axios from 'axios';

// Routes where a 401 is the real answer rather than an expired session: they
// are how a session starts, ends or renews itself.
const AUTH_ROUTES = ['/api/auth/login', '/api/auth/register', '/api/auth/refresh', '/api/auth/logout'];

const isAuthRoute = (url = '') => AUTH_ROUTES.some((route) => url.startsWith(route));

// An axios instance that renews the session when the access token expires and
// retries the request that ran into it, once. `adapter` exists for tests.
export function createApi({ baseURL = '', onSessionExpired = () => {}, adapter } = {}) {
  const api = axios.create({ baseURL, withCredentials: true, ...(adapter ? { adapter } : {}) });

  // Every request that hits a 401 while a refresh is running waits on that same
  // refresh. The server spends a refresh token the moment it is used, so a
  // second refresh sent in parallel would carry a token that is already gone.
  let pending = null;
  const refresh = () => {
    pending ??= api.post('/api/auth/refresh').finally(() => {
      pending = null;
    });
    return pending;
  };

  api.interceptors.response.use(undefined, async (error) => {
    const { config, response } = error;
    if (response?.status !== 401 || !config || config.retriedAfterRefresh || isAuthRoute(config.url)) {
      throw error;
    }

    try {
      await refresh();
    } catch (refreshError) {
      // Another tab refreshed first. Its new cookie is already in the browser,
      // so the request can go again as though this refresh had worked.
      if (refreshError.response?.data?.code !== 'stale_refresh_token') {
        onSessionExpired(refreshError);
        throw error;
      }
    }

    return api.request({ ...config, retriedAfterRefresh: true });
  });

  return api;
}
