/**
 * Firebase client SDK — auth only. Browser-side twin of firebase-admin.ts.
 *
 * Auth is OPTIONAL and off until configured. With no NEXT_PUBLIC_FIREBASE_*
 * vars the dashboard runs exactly as it did before: no sign-in wall, flows
 * unscoped. That is deliberate — this is a local developer tool first, and
 * making it unusable until someone provisions an auth project would be a
 * worse default than leaving a single-user machine unauthenticated.
 *
 * The same signal gates the SERVER (see auth-server.ts), so the two can never
 * disagree about whether a request should have carried a token.
 */

import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";

/**
 * Read as whole literals, never `process.env[key]`: Next inlines
 * NEXT_PUBLIC_* at build time by matching the static text, so a computed
 * lookup silently yields undefined in the browser bundle.
 */
const config = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

/** Everything auth needs. appId is optional for auth-only use. */
export const authConfigured = Boolean(
  config.apiKey && config.authDomain && config.projectId,
);

export function missingAuthVars(): string[] {
  return (
    [
      ["NEXT_PUBLIC_FIREBASE_API_KEY", config.apiKey],
      ["NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", config.authDomain],
      ["NEXT_PUBLIC_FIREBASE_PROJECT_ID", config.projectId],
    ] as const
  )
    .filter(([, value]) => !value)
    .map(([name]) => name);
}

let cachedAuth: Auth | null = null;

/** null when auth is not configured — every caller must handle that. */
export function firebaseAuth(): Auth | null {
  if (!authConfigured) return null;
  if (cachedAuth) return cachedAuth;
  const app: FirebaseApp =
    getApps().length > 0 ? getApp() : initializeApp(config);
  cachedAuth = getAuth(app);
  return cachedAuth;
}
