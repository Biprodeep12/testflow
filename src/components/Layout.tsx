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
 * House style: semantic surfaces (`bg-surface`, `border-line`) rather than
 * literal `zinc-200 dark:zinc-800` pairs, hairlines carrying a single soft
 * elevation, 8–12px radii, 13px chrome, and colour reserved for state (a
 * failed step, a live recording). The neutral ramp does the rest — a tool
 * that is decorative everywhere has nothing left to say when something
 * goes wrong.
 * ------------------------------------------------------------------ */

/** Shared by every control that can take focus, so the whole chrome springs alike. */
const PRESS = "transition-all duration-150 ease-out active:translate-y-px";

/**
 * The one solid, high-commitment surface: ink in light, paper in dark. Exported
 * because `Button` is a <button> and some of these are <Link>s — the style has
 * to be reachable without the element, or the two drift.
 */
export const SOLID =
  "tf-sheen bg-zinc-900 text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white";

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
    primary: SOLID,
    secondary:
      "tf-elev-1 border border-line bg-raised text-muted hover:border-line-strong hover:text-ink",
    ghost: "text-muted hover:bg-line-soft hover:text-ink",
    danger:
      "tf-elev-1 border border-line bg-raised text-red-600 hover:border-red-400/60 hover:bg-red-500/8 dark:text-red-400",
  }[variant];

  const sizing = size === "sm" ? "h-7 gap-1.5 px-2.5" : "h-8 gap-1.5 px-3";

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center rounded-lg text-[13px] font-medium whitespace-nowrap disabled:pointer-events-none disabled:opacity-40 ${PRESS} ${sizing} ${styles} ${className}`}
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
      className={`h-9 w-full rounded-lg border border-line bg-surface px-3 text-[13px] text-ink outline-none transition-colors duration-150 placeholder:text-faint focus:border-line-strong ${
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
      <span className="tf-label text-faint">{label}</span>
      {children}
      {hint && <span className="text-xs text-muted">{hint}</span>}
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
      className={`tf-elev-2 rounded-xl border border-line bg-surface ${className}`}
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
    <div className="flex h-10 items-center gap-3 border-b border-line-soft px-3.5">
      <h2 className="tf-label shrink-0 text-muted">{title}</h2>
      <span
        aria-hidden="true"
        className="tf-ticks h-1.5 min-w-6 flex-1 text-faint opacity-45"
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
        {eyebrow && <div className="tf-label mb-2.5 text-faint">{eyebrow}</div>}
        {/* Tight and large: the one place the type is allowed to be loud.
            Leading stays above 1 — `truncate` clips overflow, and leading-none
            cuts the descenders off titles like "Recording…". */}
        <h1 className="truncate text-[28px] leading-[1.15] font-semibold tracking-[-0.035em]">
          {title}
        </h1>
        {description && (
          <div className="mt-2.5 max-w-2xl text-[13px] leading-relaxed text-muted">
            {description}
          </div>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {actions}
        </div>
      )}
    </div>
  );
}

/**
 * No outer margin: spacing between siblings belongs to whatever is laying them
 * out, not to the sibling. Baking `mt-3` in here meant an alert added its own
 * gap on top of the page's, so the rhythm moved depending on whether anything
 * had gone wrong.
 */
export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="tf-rise flex items-start gap-2.5 rounded-lg border border-red-500/25 bg-red-500/8 px-3 py-2.5 text-[13px] text-red-800 dark:text-red-300"
    >
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />
      <span className="min-w-0 flex-1">{message}</span>
    </div>
  );
}

export function EmptyState({
  title,
  hint,
  icon,
}: {
  title: ReactNode;
  hint?: ReactNode;
  /** optional glyph — a framed mark reads as "nothing here yet", not "still loading" */
  icon?: ReactNode;
}) {
  return (
    <div className="px-4 py-12 text-center">
      {icon && (
        <div className="mx-auto mb-3.5 grid h-9 w-9 place-items-center rounded-lg border border-line-soft bg-sunken text-faint">
          {icon}
        </div>
      )}
      <p className="text-[13px] font-medium text-ink">{title}</p>
      {hint && (
        <p className="mx-auto mt-1.5 max-w-md text-xs leading-relaxed text-muted">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * Segmented control — mutually exclusive options, all visible. A <select>
 * hides the alternatives behind a click; for a choice that changes what a run
 * MEANS (speed), showing both is the point.
 *
 * The selection is a single raised chip that SLIDES between options rather
 * than a background that blinks on and off, so the eye follows the choice it
 * just made instead of re-finding it. Measured rather than fractional because
 * the options are natural width — "Fast" should not be as wide as
 * "As recorded" just to keep the arithmetic simple.
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
  const wrap = useRef<HTMLDivElement>(null);
  const [chip, setChip] = useState<{ left: number; width: number } | null>(
    null,
  );
  // Identity-stable dep: `options` is a fresh array literal on every render, so
  // depending on it directly would re-run the effect forever via setChip.
  const shape = options.map((option) => option.value).join(" ");

  useEffect(() => {
    const measure = (): void => {
      const active = wrap.current?.querySelector<HTMLElement>(
        '[data-active="true"]',
      );
      if (!active) return;
      const next = { left: active.offsetLeft, width: active.offsetWidth };
      setChip((current) =>
        current && current.left === next.left && current.width === next.width
          ? current
          : next,
      );
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [value, shape]);

  return (
    <div
      ref={wrap}
      role="group"
      aria-label={label}
      className="relative inline-flex h-8 items-center rounded-lg border border-line bg-sunken p-0.5"
    >
      {/* The chip. Hidden until measured, so it never flashes at x=0. */}
      <span
        aria-hidden="true"
        className={`tf-elev-1 pointer-events-none absolute top-0.5 bottom-0.5 rounded-md border border-line bg-raised transition-all duration-200 ease-out ${
          chip ? "opacity-100" : "opacity-0"
        }`}
        style={{ left: chip?.left ?? 0, width: chip?.width ?? 0 }}
      />
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            data-active={active}
            disabled={disabled}
            title={option.title}
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={`relative h-7 rounded-md px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 disabled:pointer-events-none disabled:opacity-40 ${
              active ? "text-ink" : "text-muted hover:text-ink"
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
      className={`inline-flex h-8 items-center gap-2 rounded-lg border px-2.5 text-[13px] font-medium select-none ${PRESS} ${
        disabled
          ? "border-line opacity-40"
          : `tf-elev-1 cursor-pointer border-line bg-raised hover:border-line-strong ${
              checked ? "text-ink" : "text-muted"
            }`
      }`}
    >
      <span className="relative grid h-3.5 w-3.5 place-items-center">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
          className="peer h-3.5 w-3.5 cursor-pointer appearance-none rounded border border-line-strong transition-colors duration-150 checked:border-zinc-900 checked:bg-zinc-900 disabled:cursor-default dark:checked:border-zinc-100 dark:checked:bg-zinc-100"
        />
        {/* Drawn, not a glyph: a real tick lands on the pixel grid at 14px,
            where "✓" renders soft and sits off-centre. */}
        <svg
          viewBox="0 0 14 14"
          aria-hidden="true"
          className="pointer-events-none absolute h-2.5 w-2.5 scale-75 text-white opacity-0 transition-all duration-150 peer-checked:scale-100 peer-checked:opacity-100 dark:text-zinc-900"
        >
          <path
            d="M2.5 7.2 5.6 10.3 11.5 4.4"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      {label}
    </label>
  );
}

export type Tone = "neutral" | "success" | "danger" | "warning" | "active";

/**
 * Tinted fills, not outlines alone. A hairline-only badge disappears against a
 * panel that is itself outlined in hairlines; a wash of its own colour is what
 * separates a status chip from the furniture around it.
 */
const BADGE_TONE: Record<Tone, string> = {
  neutral: "border-line bg-line-soft text-muted",
  active: "border-line-strong bg-raised text-ink",
  success:
    "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  danger: "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400",
  warning:
    "border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-500",
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
      className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 font-mono text-[11px] ${BADGE_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

const DOT_TONE: Record<Tone, string> = {
  neutral: "bg-faint",
  active: "bg-zinc-900 dark:bg-zinc-100",
  success: "bg-emerald-500",
  danger: "bg-red-500",
  warning: "bg-amber-500",
};

/** Ring of its own colour — a lit lamp has a halo, a printed dot does not. */
const DOT_GLOW: Record<Tone, string> = {
  neutral: "",
  active: "shadow-[0_0_0_3px] shadow-zinc-900/12 dark:shadow-zinc-100/15",
  success: "shadow-[0_0_0_3px] shadow-emerald-500/18",
  danger: "shadow-[0_0_0_3px] shadow-red-500/20",
  warning: "shadow-[0_0_0_3px] shadow-amber-500/20",
};

/** A 6px lamp. `live` blinks it — the only motion that carries information. */
export function Dot({
  tone = "neutral",
  live,
}: {
  tone?: Tone;
  live?: boolean;
}) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${DOT_TONE[tone]} ${
        live ? `tf-live ${DOT_GLOW[tone]}` : ""
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
      className="h-1 w-full overflow-hidden bg-sunken"
    >
      <div
        className={`h-full rounded-r-full transition-[width] duration-300 ease-out ${DOT_TONE[tone]}`}
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
    <div className="flex flex-col gap-1.5">
      <span className="font-mono text-[18px] leading-none tracking-tight tabular-nums">
        {value}
      </span>
      <span className="tf-label text-faint">{label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Page structure
 * ------------------------------------------------------------------ */

/**
 * The width every page shares. Wider than the usual reading measure on
 * purpose: the step list is a four-column table whose target column holds full
 * URLs and CSS paths, and every 100px it does not get is another row that ends
 * in an ellipsis. Prose inside still caps itself (see PageHeader).
 */
const SHELL = "mx-auto w-full max-w-7xl px-5";

/**
 * The body of a page: one rhythm, declared once.
 *
 * Pages were spacing themselves with a mix of `mt-5` and `mt-3` chosen per
 * element, so the gaps encoded nothing — two unrelated panels could sit closer
 * than two halves of the same control. Now there are exactly two distances:
 * this one BETWEEN regions, and whatever a region uses inside itself.
 */
export function PageBody({ children }: { children: ReactNode }) {
  return <div className="mt-6 space-y-3">{children}</div>;
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
        <path
          d="M5.5 13.5h5"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
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
      className={`grid h-8 w-8 place-items-center rounded-lg text-muted hover:bg-line-soft hover:text-ink ${PRESS}`}
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
        className={`tf-elev-1 grid h-7 w-7 place-items-center rounded-full border border-line bg-raised text-[11px] font-semibold text-muted hover:border-line-strong hover:text-ink ${PRESS}`}
      >
        {initial}
      </button>
      {open && (
        <div
          role="menu"
          className="tf-elev-pop tf-rise absolute right-0 z-50 mt-2 w-60 rounded-xl border border-line bg-raised p-1.5"
        >
          <div className="px-2 py-1.5">
            <div className="truncate text-[13px] font-medium">
              {user.displayName ?? "Signed in"}
            </div>
            {user.email && (
              <div className="truncate font-mono text-[11px] text-muted">
                {user.email}
              </div>
            )}
          </div>
          <div className="my-1 h-px bg-line-soft" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
            className="w-full rounded-lg px-2 py-1.5 text-left text-[13px] text-muted transition-colors duration-150 hover:bg-line-soft hover:text-ink"
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
  const { signInWithGoogle, signInWithPassword, registerWithPassword } =
    useAuth();
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
    <div className="mx-auto flex min-h-[70vh] max-w-sm flex-col justify-center">
      <div className="tf-rise">
        <div className="mb-5 flex justify-center">
          <Mark />
        </div>
        <Card className="p-6">
          <h1 className="text-lg font-semibold tracking-tight">Sign in</h1>
          <p className="mt-1 text-[13px] text-muted">
            Recordings are saved to your account.
          </p>

          {error && (
            <div className="mt-4">
              <ErrorNote message={error} />
            </div>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() => void run(signInWithGoogle)}
            className={`tf-elev-1 mt-5 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-line bg-raised text-[13px] font-medium hover:border-line-strong disabled:opacity-40 ${PRESS}`}
          >
            <svg viewBox="0 0 18 18" className="h-4 w-4" aria-hidden="true">
              <path
                fill="#4285F4"
                d="M17.6 9.2c0-.6-.1-1.3-.2-1.9H9v3.5h4.8a4.1 4.1 0 01-1.8 2.7v2.3h2.9c1.7-1.6 2.7-3.9 2.7-6.6z"
              />
              <path
                fill="#34A853"
                d="M9 18c2.4 0 4.5-.8 6-2.2l-2.9-2.3c-.8.6-1.9.9-3.1.9-2.4 0-4.4-1.6-5.1-3.8H.9v2.3A9 9 0 009 18z"
              />
              <path
                fill="#FBBC05"
                d="M3.9 10.6a5.4 5.4 0 010-3.4V4.9H.9a9 9 0 000 8.1l3-2.4z"
              />
              <path
                fill="#EA4335"
                d="M9 3.6c1.3 0 2.5.5 3.4 1.3l2.6-2.6A9 9 0 00.9 4.9l3 2.3C4.6 5.1 6.6 3.6 9 3.6z"
              />
            </svg>
            Continue with Google
          </button>

          <div className="my-5 flex items-center gap-3">
            <span className="h-px flex-1 bg-line-soft" />
            <span className="tf-label text-faint">or</span>
            <span className="h-px flex-1 bg-line-soft" />
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
            <Button type="submit" disabled={busy} className="mt-1 h-9 w-full">
              {mode === "signin" ? "Sign in" : "Create account"}
            </Button>
          </form>
        </Card>

        <button
          type="button"
          onClick={() => {
            setMode(mode === "signin" ? "register" : "signin");
            setError(null);
          }}
          className="mt-4 w-full text-center text-xs text-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink"
        >
          {mode === "signin"
            ? "No account? Create one"
            : "Already have an account? Sign in"}
        </button>
      </div>
    </div>
  );
}

function Mark() {
  return (
    <span className="flex items-center gap-2">
      <span className="tf-elev-1 grid h-6 w-6 place-items-center rounded-[7px] bg-linear-to-b from-zinc-700 to-zinc-950 dark:from-zinc-100 dark:to-zinc-400">
        <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden="true">
          <path
            d="M6.2 4.4v7.2l5.6-3.6z"
            className="fill-white dark:fill-zinc-900"
          />
        </svg>
      </span>
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
   * "record" pulses red; "run" is a steady ink line. Visible from anywhere on
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
      <div className="tf-canvas min-h-screen text-ink">
        <header className="sticky top-0 z-40 border-b border-line bg-canvas/72 backdrop-blur-xl">
          <div
            aria-hidden="true"
            className={`h-0.5 w-full transition-colors ${
              signal === "record"
                ? "tf-rail-live bg-red-500 text-red-500"
                : signal === "run"
                  ? "bg-zinc-900 dark:bg-zinc-100"
                  : "bg-transparent"
            }`}
          />
          <div className={`flex h-13 items-center gap-3 sm:gap-5 ${SHELL}`}>
            <Link
              href="/"
              className="shrink-0 transition-opacity hover:opacity-70"
            >
              <Mark />
            </Link>
            {!gated && (
              <nav className="flex items-center gap-1">
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
                      className={`rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-all duration-150 ${
                        active
                          ? "tf-elev-1 border border-line bg-raised text-ink"
                          : "border border-transparent text-muted hover:bg-line-soft hover:text-ink"
                      }`}
                    >
                      {item.label}
                    </Link>
                  );
                })}
              </nav>
            )}
            <div className="ml-auto flex min-w-0 items-center gap-1.5">
              {!gated && actions}
              <span
                aria-hidden="true"
                className="mx-0.5 hidden h-4 w-px bg-line-soft sm:block"
              />
              <ThemeToggle />
              <UserMenu />
            </div>
          </div>
        </header>
        <main className={`py-8 ${SHELL}`}>
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
