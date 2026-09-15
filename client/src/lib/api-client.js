import { createApi } from './api.js';

export const SESSION_EXPIRED = 'sift:session-expired';

// The one instance the app uses. In development the API sits behind the Vite
// proxy on the same origin, so the base URL is empty. A deployed client sets
// VITE_API_URL to the API's address instead.
export const api = createApi({
  baseURL: import.meta.env.VITE_API_URL ?? '',
  onSessionExpired: () => window.dispatchEvent(new Event(SESSION_EXPIRED)),
});
