/**
 * Theme: light, dark, or follow the OS.
 *
 * The class on <html> is applied by the boot script in _document BEFORE first
 * paint — this module only keeps React in sync with it and handles changes.
 * Doing it here instead would mean one frame of the wrong theme on every page
 * load, which is the flash every themed app is judged by.
 *
 * The stored choice is read through useSyncExternalStore rather than copied
 * into state: localStorage IS the store, it can change in another tab, and
 * React's own primitive for "subscribe to something outside React" keeps the
 * server snapshot and the client snapshot explicit instead of reconciling them
 * with an effect.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

export type ThemeChoice = "light" | "dark" | "system";

export const THEME_KEY = "tf-theme";

/** Inlined in <head>, before anything renders. Kept in sync with apply() below. */
export const THEME_BOOT_SCRIPT = `(function(){try{var c=localStorage.getItem(${JSON.stringify(
  THEME_KEY,
)});var d=c==="dark"||((c===null||c==="system")&&matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);}catch(e){}})();`;

const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Same-tab notifications — the `storage` event only fires in OTHER tabs. */
const listeners = new Set<() => void>();

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  const media = window.matchMedia(DARK_QUERY);
  media.addEventListener("change", onChange);
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    media.removeEventListener("change", onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(THEME_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    /* storage blocked (private mode, embedded) — "system" is a fine default */
  }
  return "system";
}

function readSystemDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

/**
 * The server cannot know either value, and neither can the first client render
 * without causing a hydration mismatch. Both default to the same thing the boot
 * script already handled visually.
 */
const serverChoice = (): ThemeChoice => "system";
const serverDark = (): boolean => false;

function applyToDocument(choice: ThemeChoice): void {
  const dark = choice === "dark" || (choice === "system" && readSystemDark());
  document.documentElement.classList.toggle("dark", dark);
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  // No provider state: every consumer subscribes to the same external store, so
  // there is nothing to keep in sync and nothing to get stale.
  return <>{children}</>;
}

export function useTheme(): {
  choice: ThemeChoice;
  setChoice: (choice: ThemeChoice) => void;
  /** what the choice currently resolves to — "system" is not an appearance */
  resolved: "light" | "dark";
} {
  const choice = useSyncExternalStore(subscribe, readChoice, serverChoice);
  const systemDark = useSyncExternalStore(subscribe, readSystemDark, serverDark);

  const setChoice = useCallback((next: ThemeChoice) => {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* the theme still applies for this session */
    }
    applyToDocument(next);
    for (const listener of listeners) listener();
  }, []);

  // Keep the class in step with whatever the store now says: the OS flipped
  // mid-session (sunset), or another tab changed the choice.
  //
  // This MUST be an effect, not a render-phase write. During hydration
  // useSyncExternalStore serves the SERVER snapshot — choice "system",
  // systemDark false — which describes nobody's actual settings. Correcting the
  // DOM from those values stripped the class the boot script had just set, so a
  // stored "dark" on a light OS reverted to light on every single load. Effects
  // run after hydration, where both snapshots are the real ones.
  useEffect(() => {
    applyToDocument(choice);
  }, [choice, systemDark]);

  return useMemo(
    () => ({
      choice,
      setChoice,
      resolved:
        choice === "system" ? (systemDark ? "dark" : "light") : choice,
    }),
    [choice, setChoice, systemDark],
  );
}
