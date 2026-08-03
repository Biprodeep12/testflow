/**
 * Firestore Admin singleton. Server-only — never import this from a component.
 *
 * Next.js hot-reloads modules in dev, so the initialised app is cached on globalThis
 * to avoid "app already exists" on every save.
 */

import { cert, getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

const globalCache = globalThis as unknown as {
  __testflowFirebaseApp?: App;
  __testflowDb?: Firestore;
};

function readPrivateKey(): string | undefined {
  const raw = process.env.FIREBASE_PRIVATE_KEY;
  if (!raw) return undefined;
  // .env files store the key with escaped newlines; the SDK needs real ones.
  return raw.replace(/\\n/g, "\n").replace(/^"|"$/g, "");
}

export function firebaseConfigStatus(): {
  configured: boolean;
  missing: string[];
} {
  const required = [
    "FIREBASE_PROJECT_ID",
    "FIREBASE_CLIENT_EMAIL",
    "FIREBASE_PRIVATE_KEY",
  ];
  const missing = required.filter((key) => !process.env[key]);
  return { configured: missing.length === 0, missing };
}

export class FirebaseNotConfiguredError extends Error {
  constructor(missing: string[]) {
    super(
      `Firebase is not configured. Missing env var(s): ${missing.join(", ")}. ` +
        `Copy .env.example to .env.local and fill in your service account — see SETUP.md.`,
    );
    this.name = "FirebaseNotConfiguredError";
  }
}

/**
 * The initialised Admin app — shared by Firestore and by ID-token verification.
 *
 * Both need the same credentials and the same singleton; initialising twice is
 * what produces "app already exists" on hot reload.
 */
export function adminApp(): App {
  if (globalCache.__testflowFirebaseApp) return globalCache.__testflowFirebaseApp;

  const { configured, missing } = firebaseConfigStatus();
  if (!configured) throw new FirebaseNotConfiguredError(missing);

  const app =
    getApps().length > 0
      ? getApps()[0]
      : initializeApp({
          credential: cert({
            projectId: process.env.FIREBASE_PROJECT_ID,
            clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
            privateKey: readPrivateKey(),
          }),
        });

  globalCache.__testflowFirebaseApp = app;
  return app;
}

export function getDb(): Firestore {
  if (globalCache.__testflowDb) return globalCache.__testflowDb;

  const app = adminApp();
  const db = getFirestore(app);
  try {
    db.settings({ ignoreUndefinedProperties: true });
  } catch {
    // settings() throws if the instance has already been used — harmless on hot reload.
  }

  globalCache.__testflowDb = db;
  return db;
}
