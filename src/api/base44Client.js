// Single shared Base44 client for the dashboard SPA.
// App ID comes from .env (VITE_BASE44_APP_ID) — see SETUP.md.
import { createClient } from "@base44/sdk";

export const base44 = createClient({
  appId: import.meta.env.VITE_BASE44_APP_ID,
});

/** Auth gate helper: resolves the current user or redirects to Base44 login. */
export async function requireUser() {
  try {
    const user = await base44.auth.me();
    if (user?.email) return user;
  } catch {
    /* not logged in */
  }
  base44.auth.redirectToLogin(window.location.href);
  return null;
}
