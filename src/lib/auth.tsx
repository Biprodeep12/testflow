/**
 * Auth state for the dashboard.
 *
 * Holds the current user and hands out a fresh ID token to the API client.
 * `onIdTokenChanged` rather than `onAuthStateChanged`: it also fires on token
 * REFRESH (hourly), which is what keeps a long-lived tab — one left open while
 * you record a 40-minute session — from suddenly sending an expired token.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  GoogleAuthProvider,
  createUserWithEmailAndPassword,
  onIdTokenChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
  type User,
} from "firebase/auth";
import { authConfigured, firebaseAuth } from "./firebase-client";
import { setTokenProvider } from "./client";

export type AuthUser = {
  uid: string;
  email: string | null;
  displayName: string | null;
  photoURL: string | null;
};

type AuthContextValue = {
  /** false when the app runs unauthenticated by design (no Firebase auth env) */
  configured: boolean;
  user: AuthUser | null;
  /** true until the SDK has reported the initial state — render nothing decisive */
  loading: boolean;
  signInWithGoogle: () => Promise<void>;
  signInWithPassword: (email: string, password: string) => Promise<void>;
  registerWithPassword: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  configured: false,
  user: null,
  loading: false,
  signInWithGoogle: async () => {},
  signInWithPassword: async () => {},
  registerWithPassword: async () => {},
  signOut: async () => {},
});

function toAuthUser(user: User): AuthUser {
  return {
    uid: user.uid,
    email: user.email,
    displayName: user.displayName,
    photoURL: user.photoURL,
  };
}

/**
 * Firebase's error codes are accurate and unreadable. Only the ones a user can
 * actually act on are translated; anything else keeps its code so it stays
 * searchable rather than being flattened into "something went wrong".
 */
export function authErrorMessage(err: unknown): string {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : "";
  switch (code) {
    case "auth/invalid-email":
      return "That email address is not valid.";
    case "auth/missing-password":
      return "Enter a password.";
    case "auth/weak-password":
      return "Password must be at least 6 characters.";
    case "auth/email-already-in-use":
      return "That email already has an account — sign in instead.";
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Wrong email or password.";
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "";
    case "auth/popup-blocked":
      return "The sign-in popup was blocked — allow popups for this site and try again.";
    case "auth/unauthorized-domain":
      return "This domain is not in the Firebase console's authorised domains for sign-in.";
    case "auth/operation-not-allowed":
      return "That sign-in provider is not enabled in the Firebase console.";
    default:
      return err instanceof Error ? err.message : String(err);
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(authConfigured);

  useEffect(() => {
    const auth = firebaseAuth();
    if (!auth) return; // unauthenticated by design — nothing to subscribe to

    // Every API call asks for the token through this, so it is always the
    // CURRENT one; caching a string here is how you ship a stale-token bug.
    setTokenProvider(async () => {
      const current = auth.currentUser;
      return current ? current.getIdToken() : null;
    });

    return onIdTokenChanged(auth, (next) => {
      setUser(next ? toAuthUser(next) : null);
      setLoading(false);
    });
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const auth = firebaseAuth();
    if (!auth) return;
    await signInWithPopup(auth, new GoogleAuthProvider());
  }, []);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    const auth = firebaseAuth();
    if (!auth) return;
    await signInWithEmailAndPassword(auth, email, password);
  }, []);

  const registerWithPassword = useCallback(
    async (email: string, password: string) => {
      const auth = firebaseAuth();
      if (!auth) return;
      await createUserWithEmailAndPassword(auth, email, password);
    },
    [],
  );

  const signOut = useCallback(async () => {
    const auth = firebaseAuth();
    if (!auth) return;
    await fbSignOut(auth);
  }, []);

  const value = useMemo(
    () => ({
      configured: authConfigured,
      user,
      loading,
      signInWithGoogle,
      signInWithPassword,
      registerWithPassword,
      signOut,
    }),
    [user, loading, signInWithGoogle, signInWithPassword, registerWithPassword, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
