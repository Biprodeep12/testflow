import type { FlowStep } from "@/types/flow";

const CHIP: Record<string, string> = {
  click: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  doubleClick: "bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300",
  change: "bg-violet-100 text-violet-800 dark:bg-violet-950/60 dark:text-violet-300",
  keyDown: "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
  keyUp: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-500",
  navigate: "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  setViewport: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-500",
  scroll: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-500",
  wheel: "bg-teal-100 text-teal-800 dark:bg-teal-950/60 dark:text-teal-300",
  drag: "bg-indigo-100 text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300",
};

/** The most human-readable selector a step carries: aria > text > first. */
function label(step: FlowStep): string {
  if (step.type === "navigate") return step.url ?? "";
  if (step.type === "setViewport") return `${step.width}×${step.height}`;
  if (step.type === "keyDown" || step.type === "keyUp") return step.key ?? "";
  if (step.type === "scroll") return `y=${step.y ?? 0}`;
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

export type StepStatus = "pending" | "running" | "pass" | "fail" | "skipped";

const DOT: Record<StepStatus, string> = {
  pending: "bg-zinc-300 dark:bg-zinc-600",
  running: "animate-pulse bg-blue-500",
  pass: "bg-emerald-500",
  fail: "bg-red-500",
  skipped: "bg-zinc-300 dark:bg-zinc-600",
};

export function FlowStepList({
  steps,
  statuses,
  errors,
}: {
  steps: FlowStep[];
  /** replay mode: one status per step, same index */
  statuses?: StepStatus[];
  errors?: (string | undefined)[];
}) {
  return (
    <ol className="divide-y divide-zinc-100 dark:divide-zinc-800">
      {steps.map((step, index) => (
        <li
          key={index}
          data-testid="tf-step"
          className="flex items-start gap-3 px-4 py-2.5 text-sm"
        >
          <span className="w-6 shrink-0 pt-0.5 text-right font-mono text-xs text-zinc-400">
            {index + 1}
          </span>
          {statuses && (
            <span
              className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${DOT[statuses[index] ?? "pending"]}`}
            />
          )}
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] ${
              CHIP[step.type] ??
              "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            }`}
          >
            {step.type}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-zinc-800 dark:text-zinc-200">
              {label(step)}
            </span>
            {step.type === "change" && (
              <span className="mt-0.5 block truncate font-mono text-xs text-zinc-500">
                {step.value === "" ? "(empty — masked or cleared)" : step.value}
              </span>
            )}
            {step.assertedEvents?.[0]?.url && step.type !== "navigate" && (
              <span className="mt-0.5 block truncate font-mono text-xs text-amber-600 dark:text-amber-500">
                → {step.assertedEvents[0].url}
              </span>
            )}
            {errors?.[index] && (
              <span className="mt-0.5 block truncate text-xs text-red-600 dark:text-red-400">
                {errors[index]}
              </span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}
