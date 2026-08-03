import Link from "next/link";
import Head from "next/head";
import { useRouter } from "next/router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { authErrorMessage, useAuth } from "@/lib/auth";
import { missingAuthVars } from "@/lib/firebase-client";
import { useTheme, type ThemeChoice } from "@/lib/theme";

/* ------------------------------------------------------------------ *
 * Primitives
 *
 * House style: hairline borders instead of shadows, 6px radii, 13px chrome,
 * and colour reserved for state (a failed step, a live recording). The neutral
 * ramp does the rest — a tool that is decorative everywhere has nothing left
 * to say when something goes wrong.
 * ------------------------------------------------------------------ */

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  size = "md",
  type = "button",
  title,
  className = "",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  type?: "button" | "submit";
  /** hover text — used where two buttons differ in a way the label cannot carry */
  title?: string;
  className?: string;
}) {
  const styles = {
    primary:
      "bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white",
    secondary:
      "border border-zinc-200 text-zinc-700 hover:border-zinc-300 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-300 dark:hover:border-zinc-700 dark:hover:bg-zinc-900",
    ghost:
      "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100",
    danger:
      "border border-zinc-200 text-red-600 hover:border-red-300 hover:bg-red-50 dark:border-zinc-800 dark:text-red-400 dark:hover:border-red-900 dark:hover:bg-red-950/30",
  }[variant];

  const sizing = size === "sm" ? "h-7 gap-1.5 px-2.5" : "h-8 gap-1.5 px-3";

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center rounded-md text-[13px] font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-40 ${sizing} ${styles} ${className}`}
    >
      {children}
    </button>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  required,
  mono,
  label,
  type = "text",
  autoComplete,
  className = "",
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  /** URLs and ids read better in mono — a misplaced character is visible */
  mono?: boolean;
  /** accessible name when the field has no visible <label> */
  label?: string;
  type?: "text" | "email" | "password";
  autoComplete?: string;
  className?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      autoComplete={autoComplete}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      required={required}
      aria-label={label}
      className={`h-8 w-full rounded-md border border-zinc-200 bg-white px-2.5 text-[13px] text-zinc-900 outline-none transition-colors placeholder:text-zinc-400 focus:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100 dark:placeholder:text-zinc-600 dark:focus:border-zinc-600 ${
        mono ? "font-mono" : ""
      } ${className}`}
    />
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium tracking-wider text-zinc-500 uppercase">
        {label}
      </span>
      {children}
      {hint && <span className="text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-lg border border-zinc-200 bg-white dark:border-zinc-800/90 dark:bg-zinc-950/70 ${className}`}
    >
      {children}
    </div>
  );
}

/**
 * Panel header: a silkscreen label, a rail of ruler ticks filling the dead
 * space, then whatever the panel wants on the right. The ticks are what stop
 * an empty strip from reading as unfinished — they are the instrument face.
 */
export function CardHeader({
  title,
  right,
}: {
  title: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex h-9 items-center gap-3 border-b border-zinc-200 px-3 dark:border-zinc-800/90">
      <h2 className="tf-label shrink-0 text-zinc-500">{title}</h2>
      <span
        aria-hidden="true"
        className="tf-ticks h-1.5 min-w-6 flex-1 text-zinc-300 opacity-40 dark:text-zinc-700"
      />
      {right}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 flex-1">
        {eyebrow && (
          <div className="tf-label mb-2 text-zinc-400 dark:text-zinc-600">
            {eyebrow}
          </div>
        )}
        {/* Tight and large: the one place the type is allowed to be loud.
            Leading stays above 1 — `truncate` clips overflow, and leading-none
            cuts the descenders off titles like "Recording…". */}
        <h1 className="truncate text-[26px] leading-[1.15] font-semibold tracking-[-0.03em]">
          {title}
        </h1>
        {description && (
          <div className="mt-2.5 max-w-2xl text-[13px] leading-relaxed text-zinc-500 dark:text-zinc-400">
            {description}
          </div>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">{actions}</div>
      )}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mt-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800 dark:border-red-900/70 dark:bg-red-950/30 dark:text-red-300"
    >
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 bg-red-500" />
      <span className="min-w-0 flex-1">{message}</span>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
}: {
  title: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="text-[13px] text-zinc-600 dark:text-zinc-400">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

/**
 * Segmented control — mutually exclusive options, all visible. A <select>
 * hides the alternatives behind a click; for a choice that changes what a run
 * MEANS (speed), showing both is the point.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; title?: string }[];
  disabled?: boolean;
  label?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="inline-flex h-8 items-center rounded-md border border-zinc-200 p-0.5 dark:border-zinc-800"
    >
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            disabled={disabled}
            title={option.title}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`h-7 rounded-sm px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-40 ${
              active
                ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-800 dark:text-zinc-100"
                : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** A checkbox that reads as a setting. Real input underneath, so it is focusable. */
export function Toggle({
  checked,
  onChange,
  label,
  title,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  title?: string;
  disabled?: boolean;
}) {
  return (
    <label
      title={title}
      className={`inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-[13px] font-medium transition-colors select-none ${
        disabled
          ? "border-zinc-200 opacity-40 dark:border-zinc-800"
          : "cursor-pointer border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900"
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3.5 w-3.5 cursor-pointer appearance-none rounded-[3px] border border-zinc-300 transition-colors checked:border-zinc-900 checked:bg-zinc-900 disabled:cursor-default dark:border-zinc-700 dark:checked:border-zinc-100 dark:checked:bg-zinc-100"
      />
      {label}
    </label>
  );
}

export type Tone = "neutral" | "success" | "danger" | "warning" | "active";

const BADGE_TONE: Record<Tone, string> = {
  neutral:
    "border-zinc-200 text-zinc-600 dark:border-zinc-800 dark:text-zinc-400",
  active: "border-zinc-300 text-zinc-900 dark:border-zinc-700 dark:text-zinc-100",
  success:
    "border-emerald-200 text-emerald-700 dark:border-emerald-900 dark:text-emerald-400",
  danger: "border-red-200 text-red-700 dark:border-red-900 dark:text-red-400",
  warning:
    "border-amber-200 text-amber-700 dark:border-amber-900 dark:text-amber-500",
};

export function Badge({
  children,
  tone = "neutral",
  testId,
}: {
  children: ReactNode;
  tone?: Tone;
  testId?: string;
}) {
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 font-mono text-[11px] ${BADGE_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

const DOT_TONE: Record<Tone, string> = {
  neutral: "bg-zinc-400",
  active: "bg-zinc-900 dark:bg-zinc-100",
  success: "bg-emerald-500",
  danger: "bg-red-500",
  warning: "bg-amber-500",
};

/** A 6px square. `live` blinks it — the only motion that carries information. */
export function Dot({ tone = "neutral", live }: { tone?: Tone; live?: boolean }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 ${DOT_TONE[tone]} ${
        live ? "tf-live" : ""
      }`}
    />
  );
}

export function ProgressBar({
  value,
  tone = "active",
}: {
  /** 0–1 */
  value: number;
  tone?: Tone;
}) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value * 100)}
      className="h-0.5 w-full overflow-hidden bg-zinc-100 dark:bg-zinc-900"
    >
      <div
        className={`h-full transition-[width] duration-200 ease-out ${DOT_TONE[tone]}`}
        style={{ width: `${Math.min(Math.max(value, 0), 1) * 100}%` }}
      />
    </div>
  );
}

/**
 * An instrument readout: the value large in mono, the engraved label under it.
 * Value first because that is what you came to read; the label only has to be
 * findable once.
 */
export function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[17px] leading-none tracking-tight tabular-nums">
        {value}
      </span>
      <span className="tf-label text-zinc-400 dark:text-zinc-600">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

const NAV = [
  { href: "/", label: "Record" },
  { href: "/flows", label: "Flows" },
];

const THEMES: { value: ThemeChoice; label: string; icon: ReactNode }[] = [
  {
    value: "light",
    label: "Light",
    icon: (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
        <circle cx="8" cy="8" r="3.1" fill="currentColor" />
        <g stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
          <path d="M8 1.6v1.6M8 12.8v1.6M1.6 8h1.6M12.8 8h1.6M3.5 3.5l1.1 1.1M11.4 11.4l1.1 1.1M12.5 3.5l-1.1 1.1M4.6 11.4l-1.1 1.1" />
        </g>
      </svg>
    ),
  },
  {
    value: "dark",
    label: "Dark",
    icon: (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
        <path
          fill="currentColor"
          d="M13.2 9.6A5.6 5.6 0 016.4 2.8a5.6 5.6 0 106.8 6.8z"
        />
      </svg>
    ),
  },
  {
    value: "system",
    label: "System",
    icon: (
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
        <rect
          x="1.8"
          y="2.8"
          width="12.4"
          height="8.4"
          rx="1.2"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
        />
        <path d="M5.5 13.5h5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
    ),
  },
];

function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  const index = THEMES.findIndex((entry) => entry.value === choice);
  const current = THEMES[index] ?? THEMES[2];
  const next = THEMES[(index + 1) % THEMES.length] ?? THEMES[0];

  return (
    <button
      type="button"
      onClick={() => setChoice(next.value)}
      title={`Theme: ${current.label} — switch to ${next.label}`}
      aria-label={`Theme: ${current.label}. Switch to ${next.label}.`}
      className="grid h-7 w-7 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
    >
      {current.icon}
    </button>
  );
}

function UserMenu() {
  const { configured, user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!configured || !user) return null;

  const name = user.displayName || user.email || "Account";
  const initial = name.trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="relative" ref={box}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={name}
        className="grid h-7 w-7 place-items-center rounded-full border border-zinc-200 bg-zinc-50 text-[11px] font-medium text-zinc-600 transition-colors hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
      >
        {initial}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-50 mt-1.5 w-56 rounded-md border border-zinc-200 bg-white p-1 dark:border-zinc-800 dark:bg-zinc-950"
        >
          <div className="border-b border-zinc-100 px-2 py-1.5 dark:border-zinc-900">
            <div className="truncate text-[13px] font-medium">
              {user.displayName ?? "Signed in"}
            </div>
            {user.email && (
              <div className="truncate font-mono text-[11px] text-zinc-500">
                {user.email}
              </div>
            )}
          </div>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="mt-1 w-full rounded px-2 py-1.5 text-left text-[13px] text-zinc-700 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-900"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Sign-in
 * ------------------------------------------------------------------ */

function SignIn() {
  const { signInWithGoogle, signInWithPassword, registerWithPassword } = useAuth();
  const [mode, setMode] = useState<"signin" | "register">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (work: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      // "" is a deliberate cancel (popup closed) — not worth an error line.
      const message = authErrorMessage(err);
      if (message) setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center px-5">
      <Mark />
      <h1 className="mt-5 text-lg font-semibold tracking-tight">Sign in</h1>
      <p className="mt-1 text-[13px] text-zinc-500">
        Recordings are saved to your account.
      </p>

      <ErrorNote message={error} />

      <button
        type="button"
        disabled={busy}
        onClick={() => void run(signInWithGoogle)}
        className="mt-4 inline-flex h-9 items-center justify-center gap-2 rounded-md border border-zinc-200 text-[13px] font-medium transition-colors hover:bg-zinc-50 disabled:opacity-40 dark:border-zinc-800 dark:hover:bg-zinc-900"
      >
        <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true">
          <path fill="#4285F4" d="M17.6 9.2c0-.6-.1-1.3-.2-1.9H9v3.5h4.8a4.1 4.1 0 01-1.8 2.7v2.3h2.9c1.7-1.6 2.7-3.9 2.7-6.6z" />
          <path fill="#34A853" d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.3c-.8.6-1.9.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 009 18z" />
          <path fill="#FBBC05" d="M3.9 10.6a5.4 5.4 0 010-3.4V4.9H.9a9 9 0 000 8.1l3-2.4z" />
          <path fill="#EA4335" d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 00.9 4.9l3 2.3C4.6 5.1 6.6 3.6 9 3.6z" />
        </svg>
        Continue with Google
      </button>

      <div className="my-4 flex items-center gap-3 text-[11px] tracking-wider text-zinc-400 uppercase">
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
        or
        <span className="h-px flex-1 bg-zinc-200 dark:bg-zinc-800" />
      </div>

      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run(() =>
            mode === "signin"
              ? signInWithPassword(email, password)
              : registerWithPassword(email, password),
          );
        }}
      >
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={setEmail}
            placeholder="you@example.com"
            autoComplete="email"
            required
            mono
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={setPassword}
            autoComplete={
              mode === "signin" ? "current-password" : "new-password"
            }
            required
          />
        </Field>
        <Button type="submit" disabled={busy} className="h-9 w-full">
          {mode === "signin" ? "Sign in" : "Create account"}
        </Button>
      </form>

      <button
        type="button"
        onClick={() => {
          setMode(mode === "signin" ? "register" : "signin");
          setError(null);
        }}
        className="mt-3 self-start text-xs text-zinc-500 underline underline-offset-4 hover:text-zinc-900 dark:hover:text-zinc-100"
      >
        {mode === "signin"
          ? "No account? Create one"
          : "Already have an account? Sign in"}
      </button>
    </div>
  );
}

function Mark() {
  return (
    <span className="flex items-center gap-2">
      <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
        <rect
          x="0.9"
          y="0.9"
          width="14.2"
          height="14.2"
          rx="3.2"
          className="fill-zinc-900 dark:fill-zinc-100"
        />
        <path d="M6.2 4.6v6.8l5.2-3.4z" className="fill-white dark:fill-zinc-900" />
      </svg>
      <span className="font-mono text-[13px] font-medium tracking-tight">
        testflow
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Shell
 * ------------------------------------------------------------------ */

export function Layout({
  children,
  title,
  actions,
  signal,
}: {
  children: ReactNode;
  title?: string;
  /** header-right slot — connection state, page-level controls */
  actions?: ReactNode;
  /**
   * The device's status lamp, as a rail across the top of the chrome.
   * "record" blinks red; "run" is a steady ink line. Visible from anywhere on
   * the page, including behind a scrolled step list — a session you forgot is
   * running is the failure mode this exists to prevent.
   */
  signal?: "record" | "run" | null;
}) {
  const { pathname } = useRouter();
  const { configured, user, loading } = useAuth();

  // Auth off (no NEXT_PUBLIC_FIREBASE_* vars) means the dashboard runs exactly
  // as it did before it existed: no gate, flows unscoped. See firebase-client.ts.
  const gated = configured && !user;

  return (
    <>
      <Head>
        <title>{title ? `${title} · testflow` : "testflow"}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </Head>
      <div className="tf-grid min-h-screen text-zinc-900 dark:text-zinc-100">
        <header className="sticky top-0 z-40 border-b border-zinc-200 bg-(--tf-bg)/92 backdrop-blur-sm dark:border-zinc-800/90">
          <div
            aria-hidden="true"
            className={`h-0.5 w-full transition-colors ${
              signal === "record"
                ? "tf-live bg-red-500"
                : signal === "run"
                  ? "bg-zinc-900 dark:bg-zinc-100"
                  : "bg-transparent"
            }`}
          />
          <div className="mx-auto flex h-12 max-w-6xl items-center gap-5 px-5">
            <Link href="/" className="shrink-0 transition-opacity hover:opacity-70">
              <Mark />
            </Link>
            {!gated && (
              <nav className="flex items-center gap-0.5">
                {NAV.map((item) => {
                  const active =
                    item.href === "/"
                      ? pathname === "/"
                      : pathname.startsWith(item.href);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`rounded-md px-2.5 py-1 text-[13px] font-medium transition-colors ${
                        active
                          ? "bg-zinc-100 text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100"
                          : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            )}
            <div className="ml-auto flex items-center gap-1.5">
              {!gated && actions}
              <ThemeToggle />
              <UserMenu />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-5 py-7">
          {/* Nothing decisive until the SDK has reported: rendering the sign-in
              screen first and then swapping it for the app is a worse flicker
              than a blank frame. */}
          {loading ? null : gated ? <SignIn /> : children}
        </main>
      </div>
    </>
  );
}

/** Shown on the Record page when auth is configured but misconfigured-looking. */
export function AuthConfigNote() {
  const missing = missingAuthVars();
  if (missing.length === 0 || missing.length === 3) return null;
  return (
    <ErrorNote
      message={`Auth is partially configured — missing ${missing.join(", ")}. Set all three or none.`}
    />
  );
}
