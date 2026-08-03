import { memo } from "react";
import type { FlowStep, StepMeta } from "@/types/flow";

/**
 * Steps that DO something to the page read at full strength; the passive ones
 * (viewport, scroll, waits) are dimmed. No per-type colours: a column of twelve
 * different hues is decoration, and it leaves nothing for a failed step to
 * stand out against.
 */
const PASSIVE = new Set([
  "setViewport",
  "scroll",
  "waitForExpression",
  "waitForElement",
  "keyUp",
]);

/** The most human-readable selector a step carries: aria > text > first. */
function label(step: FlowStep): string {
  if (step.type === "navigate") return step.url ?? "";
  if (step.type === "setViewport") return `${step.width}×${step.height}`;
  if (step.type === "keyDown" || step.type === "keyUp") return step.key ?? "";
  if (step.type === "scroll") return `y=${step.y ?? 0}`;
  if (step.type === "waitForExpression") return step.expression ?? "";
  if (step.type === "wheel" || step.type === "drag") {
    const flat = (step.selectors ?? []).map((g) => g[0]).filter(Boolean);
    const aria = flat.find((s) => s.startsWith("aria/"));
    const name = aria ? aria.slice(5) : (flat[0] ?? "element");
    if (step.type === "wheel") return `Δ${step.deltaY ?? 0} on ${name}`;
    const end = step.path?.[step.path.length - 1];
    return `→ (${end?.x ?? 0}, ${end?.y ?? 0}) on ${name}`;
  }
  const flat = (step.selectors ?? []).map((group) => group[0]).filter(Boolean);
  const aria = flat.find((s) => s.startsWith("aria/"));
  if (aria) return aria.slice(5);
  const text = flat.find((s) => s.startsWith("text/"));
  if (text) return `"${text.slice(5)}"`;
  return flat[0] ?? "—";
}

/**
 * A structural CSS/XPath path shown whole is a wall of `div:nth-of-type(2) >`
 * that says nothing about the element and pushes everything else off the row.
 * The TAIL is the part that identifies it, so lead with an ellipsis and keep
 * the last couple of hops. The full path stays on the row's `title`.
 */
function displayLabel(text: string): string {
  if (text.length <= 72) return text;
  const parts = text.split(" > ");
  if (parts.length > 3) return `… > ${parts.slice(-2).join(" > ")}`;
  return text;
}

export type StepStatus = "pending" | "running" | "pass" | "fail" | "skipped";

const DOT: Record<StepStatus, string> = {
  pending: "bg-zinc-200 dark:bg-zinc-800",
  running: "bg-zinc-900 tf-live dark:bg-zinc-100",
  pass: "bg-emerald-500",
  fail: "bg-red-500",
  skipped: "bg-zinc-200 dark:bg-zinc-800",
};

/** Only the states worth finding without reading get a tint. */
const ROW: Partial<Record<StepStatus, string>> = {
  running: "bg-zinc-50 dark:bg-zinc-900/60",
  fail: "bg-red-50/70 dark:bg-red-950/20",
  skipped: "opacity-45",
};

/**
 * One row, memoized.
 *
 * During a replay the list re-renders twice per step (running -> outcome).
 * Without this, every re-render re-runs label() and rebuilds the chips for ALL
 * rows, so painting one step's result costs O(steps) — the longer the flow, the
 * slower every step gets. Memoized on scalar props, only the row whose
 * status/error/note actually changed re-renders; the rest are skipped.
 */
const StepRow = memo(function StepRow({
  step,
  index,
  status,
  error,
  note,
  degraded,
}: {
  step: FlowStep;
  index: number;
  /** undefined = not replaying: no status dot column */
  status?: StepStatus;
  error?: string;
  note?: string;
  /**
   * The recorder already knows this step cannot replay faithfully. Shown as a
   * chip because it is a property of the RECORDING, not of any particular run —
   * it is true before you press Run, and that is when it is worth knowing.
   */
  degraded?: string;
}) {
  const text = label(step);
  return (
    <li
      data-testid="tf-step"
      className={`group flex items-start gap-2.5 px-3 py-1.5 text-[13px] transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/60 ${
        (status && ROW[status]) ?? ""
      }`}
    >
      <span className="w-7 shrink-0 pt-px text-right font-mono text-[11px] tabular-nums text-zinc-400 dark:text-zinc-600">
        {index + 1}
      </span>
      {status && (
        <span className="grid h-4.5 w-1.5 shrink-0 place-items-center">
          <span className={`h-1.5 w-1.5 ${DOT[status]}`} aria-label={status} />
        </span>
      )}
      <span
        className={`w-26 shrink-0 truncate font-mono text-[11px] leading-4.5 ${
          PASSIVE.has(step.type)
            ? "text-zinc-400 dark:text-zinc-600"
            : "text-zinc-500 dark:text-zinc-400"
        }`}
      >
        {step.type}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span
            title={text}
            className={`min-w-0 truncate leading-4.5 ${
              PASSIVE.has(step.type)
                ? "text-zinc-500 dark:text-zinc-500"
                : "text-zinc-800 dark:text-zinc-200"
            }`}
          >
            {displayLabel(text)}
          </span>
          {degraded === "positional-only" && (
            <span
              title="Only a positional selector was available — no test id, label or stable text. The first markup change breaks this step."
              className="shrink-0 rounded border border-amber-300 px-1 font-mono text-[10px] tracking-wide text-amber-700 uppercase dark:border-amber-900 dark:text-amber-500"
            >
              fragile
            </span>
          )}
          {degraded === "upload-truncated" && (
            <span
              title="The file was too large to carry inside the flow — only its name was kept."
              className="shrink-0 rounded border border-amber-300 px-1 font-mono text-[10px] tracking-wide text-amber-700 uppercase dark:border-amber-900 dark:text-amber-500"
            >
              file truncated
            </span>
          )}
        </span>
        {step.type === "change" && (
          <span className="mt-0.5 block truncate font-mono text-xs text-zinc-500">
            {step.value === "" ? "(empty — masked or cleared)" : step.value}
          </span>
        )}
        {step.assertedEvents?.[0]?.url && step.type !== "navigate" && (
          <span className="mt-0.5 flex items-center gap-1 truncate font-mono text-xs text-amber-600 dark:text-amber-500">
            <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0" aria-hidden="true">
              <path
                fill="currentColor"
                d="M6 3.5 10.5 8 6 12.5 4.9 11.4 8.3 8 4.9 4.6z"
              />
            </svg>
            <span className="truncate">{step.assertedEvents[0].url}</span>
          </span>
        )}
        {error && (
          <span className="mt-1 block border-l-2 border-red-400 pl-2 text-xs text-red-700 dark:border-red-800 dark:text-red-400">
            {error}
          </span>
        )}
        {note && (
          <span
            title={note}
            className="mt-1 block truncate border-l-2 border-amber-400 pl-2 text-xs text-amber-700 dark:border-amber-800 dark:text-amber-500"
          >
            {note}
          </span>
        )}
      </span>
    </li>
  );
});

export function FlowStepList({
  steps,
  statuses,
  errors,
  notes,
  meta,
  maxRendered,
}: {
  steps: FlowStep[];
  /** replay mode: one status per step, same index */
  statuses?: StepStatus[];
  errors?: (string | undefined)[];
  /** the step ran, but not the way it was recorded — a difference worth seeing */
  notes?: (string | undefined)[];
  /** sidecars, same index — read only for the recorder's own `degraded` flags */
  meta?: StepMeta[];
  /**
   * Render at most this many, most recent last.
   *
   * While recording, this list re-renders on every captured step. Rendering the
   * whole history each time makes a long session progressively slower to record —
   * the cost of watching grows with what you have already watched. Older rows are
   * summarised instead; nothing is dropped from the flow itself.
   */
  maxRendered?: number;
}) {
  const offset =
    maxRendered && steps.length > maxRendered ? steps.length - maxRendered : 0;
  const shown = offset > 0 ? steps.slice(offset) : steps;

  return (
    <ol className="divide-y divide-zinc-100 dark:divide-zinc-900">
      {offset > 0 && (
        <li className="px-3 py-1.5 text-center font-mono text-[11px] text-zinc-500">
          {offset} earlier {offset === 1 ? "step" : "steps"} hidden — all saved,
          latest {maxRendered} drawn
        </li>
      )}
      {shown.map((step, shownIndex) => {
        const index = shownIndex + offset;
        return (
          <StepRow
            key={index}
            step={step}
            index={index}
            status={statuses ? (statuses[index] ?? "pending") : undefined}
            error={errors?.[index]}
            note={notes?.[index]}
            degraded={meta?.[index]?.degraded}
          />
        );
      })}
    </ol>
  );
}
