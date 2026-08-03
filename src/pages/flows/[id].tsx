import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import Link from "next/link";
import {
  Button,
  Card,
  Dot,
  ErrorNote,
  Layout,
  PageBody,
  PageHeader,
  ProgressBar,
  Segmented,
  Stat,
  Toggle,
} from "@/components/Layout";
import { FlowStepList, type StepStatus } from "@/components/FlowStepList";
import { apiFetch, del, relativeTime } from "@/lib/client";
import { usePoll } from "@/hooks/usePoll";
import { flowToPlaywright } from "@/codegen/fromFlow";
import {
  BUNDLE_EXTENSION,
  DEFAULT_TIMEOUT_MS,
  exportSteps,
  toBundle,
  type AgentMessage,
  type FlowDoc,
  type HubMessage,
} from "@/types/flow";

type View = "steps" | "json" | "playwright";
type RunState = "idle" | "connecting" | "running" | "done";
type Speed = "fast" | "recorded";

/**
 * How long to wait for the extension to acknowledge a run before concluding it
 * is not installed. The run itself is orchestrated by the extension's service
 * worker — this page only starts it and renders the progress it streams back.
 * The loop cannot live here: this tab is hidden the moment the replay tab takes
 * focus, and Chrome throttles a hidden page's timers, which distorted "as
 * recorded" pacing and killed runs on reload.
 */
const CONNECT_TIMEOUT_MS = 20000;

/**
 * How tall the reading panel gets: everything the viewport has left after the
 * chrome and the console above it, with a floor so a short window still shows
 * a usable run of steps.
 *
 * It was a flat 40rem, which is one specific monitor's answer. On a tall screen
 * that left a band of empty page under a list that was still scrolling; on a
 * laptop it pushed the last rows under the fold. `dvh` rather than `vh` so a
 * mobile browser's collapsing toolbar does not crop it.
 */
const PANEL = "max-h-[max(26rem,calc(100dvh-23rem))]";

function sendHub(message: HubMessage): void {
  window.postMessage(message, window.location.origin);
}

export default function FlowPage() {
  const router = useRouter();
  const id = typeof router.query.id === "string" ? router.query.id : null;

  const [flow, setFlow] = useState<FlowDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("steps");
  const [runState, setRunState] = useState<RunState>("idle");
  const [speed, setSpeed] = useState<Speed>("fast");
  // A visible pointer that glides to each target before the click. Costs a little
  // time per step, which is why it can be turned off.
  const [showCursor, setShowCursor] = useState(true);
  const [statuses, setStatuses] = useState<StepStatus[]>([]);
  const [stepErrors, setStepErrors] = useState<(string | undefined)[]>([]);
  // Steps that ran, but not as recorded — e.g. synthetic events because real input
  // was unavailable. Shown, never swallowed.
  const [stepNotes, setStepNotes] = useState<(string | undefined)[]>([]);
  // The run this page started (or rejoined). Events for any other run are
  // ignored, so a stale runDone from a superseded run can't clobber a new one.
  const runIdRef = useRef<number | null>(null);
  // True once any step reported — decides whether an aborted run shows results.
  const sawProgress = useRef(false);
  // Armed at start, cleared by the first word about the run; firing means the
  // extension never answered — almost always "not installed".
  const connectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const data = await apiFetch<{ flow: FlowDoc }>(`/api/flows/${id}`);
      setFlow(data.flow);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [id]);

  usePoll(load, null, id);

  // The run lives in the extension's service worker; this listener only renders
  // what it streams back — and rejoins a live run after a page reload.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as AgentMessage | undefined;
      if (!data || data.source !== "tf-agent") return;

      if (data.kind === "snapshot") {
        // A run is live in the worker and this page knows nothing of it — a
        // dashboard reload mid-run. Adopt its id and statuses and keep watching.
        if (
          data.run &&
          runIdRef.current === null &&
          (!data.run.flowId || data.run.flowId === id)
        ) {
          runIdRef.current = data.run.runId;
          sawProgress.current = true;
          setRunState("running");
          setStatuses(data.run.statuses.map((s) => s.status));
          setStepErrors(data.run.statuses.map((s) => s.error));
          setStepNotes(data.run.statuses.map((s) => s.note));
        }
        return;
      }

      if (data.kind === "runProgress") {
        if (runIdRef.current === null || data.runId !== runIdRef.current)
          return;
        if (connectTimer.current) {
          clearTimeout(connectTimer.current);
          connectTimer.current = null;
        }
        sawProgress.current = true;
        setRunState((state) => (state === "connecting" ? "running" : state));
        setStatuses((prev) =>
          prev.map((s, i) => (i === data.index ? data.status : s)),
        );
        setStepErrors((prev) =>
          prev.map((e, i) => (i === data.index ? data.error : e)),
        );
        setStepNotes((prev) =>
          prev.map((n, i) => (i === data.index ? data.note : n)),
        );
        return;
      }

      if (data.kind === "runDone") {
        if (runIdRef.current === null || data.runId !== runIdRef.current)
          return;
        if (connectTimer.current) {
          clearTimeout(connectTimer.current);
          connectTimer.current = null;
        }
        runIdRef.current = null;
        // A run that never reported a step (the tab never opened) has no results
        // worth a verdict card — return to idle with the error alone.
        setRunState(sawProgress.current ? "done" : "idle");
        if (data.error) setError(data.error);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [id]);

  const runInTab = () => {
    if (!flow) return;
    const nav = flow.steps.find((step) => step.type === "navigate");
    if (!nav?.url) {
      setError("This flow has no navigate step to start from.");
      return;
    }

    setError(null);
    setRunState("connecting");
    setStatuses(flow.steps.map(() => "pending"));
    setStepErrors(flow.steps.map(() => undefined));
    setStepNotes(flow.steps.map(() => undefined));

    const runId = Date.now();
    runIdRef.current = runId;
    sawProgress.current = false;
    // The whole flow crosses the bridge once; the worker runs it and streams
    // progress back. Speed and cursor ride along — they are run inputs now.
    sendHub({
      source: "tf-hub",
      kind: "startReplay",
      runId,
      flowId: flow.id,
      flow: {
        title: flow.title,
        steps: flow.steps,
        timeout: flow.timeout,
        env: flow.env,
        meta: flow.meta,
      },
      options: { speed, cursor: showCursor },
    });

    if (connectTimer.current) clearTimeout(connectTimer.current);
    connectTimer.current = setTimeout(() => {
      connectTimer.current = null;
      if (runIdRef.current !== runId) return;
      runIdRef.current = null;
      setRunState("idle");
      setError(
        "The extension never picked up the run. Is the TestFlow extension loaded? (chrome://extensions → Load unpacked → extension/dist)",
      );
    }, CONNECT_TIMEOUT_MS);
  };

  const stopRun = () => {
    // closeReplay aborts the worker-side run before closing its tabs; dropping
    // our runId first means the resulting runDone is ignored as stale.
    sendHub({ source: "tf-hub", kind: "closeReplay" });
    if (connectTimer.current) {
      clearTimeout(connectTimer.current);
      connectTimer.current = null;
    }
    runIdRef.current = null;
    setRunState("idle");
  };

  const save = (json: string, suffix: string) => {
    if (!flow) return;
    const blob = new Blob([json], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${flow.title.replace(/[^\w-]+/g, "-")}${suffix}`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  // Interoperable export: exactly what DevTools would have written.
  const download = () => {
    if (!flow) return;
    save(
      JSON.stringify(
        {
          title: flow.title,
          timeout: flow.timeout ?? DEFAULT_TIMEOUT_MS,
          steps: exportSteps(flow.steps),
        },
        null,
        4,
      ),
      ".json",
    );
  };

  // Full recording: the same steps PLUS the sidecars, which is what the Playwright
  // runner needs to reproduce the session rather than just repeat the actions.
  const downloadBundle = () => {
    if (!flow) return;
    save(toBundle(flow), BUNDLE_EXTENSION);
  };

  const remove = async () => {
    if (!id) return;
    try {
      await del(`/api/flows/${id}`);
      await router.push("/flows");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (!flow) {
    return (
      <Layout title="Flow">
        {/* Mirrors the real page's shape — title, source, console, panel — so
            the layout does not jump when the flow lands. */}
        <div className="space-y-3">
          <div className="tf-shimmer h-7 w-64 rounded-lg bg-line-soft text-muted" />
          <div className="tf-shimmer h-3.5 w-96 rounded bg-line-soft text-muted" />
        </div>
        <PageBody>
          <ErrorNote message={error} />
          <div className="tf-shimmer h-28 rounded-xl bg-line-soft text-muted" />
          <div className="tf-shimmer h-96 rounded-xl bg-line-soft text-muted" />
        </PageBody>
      </Layout>
    );
  }

  const busy = runState === "running" || runState === "connecting";
  const passed = statuses.filter((s) => s === "pass").length;
  const failed = statuses.filter((s) => s === "fail").length;
  const skipped = statuses.filter((s) => s === "skipped").length;
  // Settled = every step that will not change again. Drives the progress bar.
  const settled = passed + failed + skipped;
  const runningIndex = statuses.findIndex((s) => s === "running");

  return (
    <Layout title={flow.title} signal={busy ? "run" : null}>
      <PageHeader
        eyebrow={
          <span className="flex items-center gap-1.5">
            <Link href="/flows" className="transition-colors hover:text-ink">
              Flows
            </Link>
            <span className="text-line-strong">/</span>
          </span>
        }
        title={flow.title}
        description={
          <a
            href={flow.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex max-w-full items-center gap-1.5 truncate font-mono text-[12px] text-muted underline decoration-line-strong underline-offset-4 transition-colors hover:text-ink"
          >
            <span className="truncate">{flow.sourceUrl}</span>
            <svg
              viewBox="0 0 16 16"
              aria-hidden="true"
              className="h-3 w-3 shrink-0"
            >
              <path
                d="M6.2 3.5h6.3v6.3M12.5 3.5 7 9M11 9.5v3h-8v-8h3"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </a>
        }
      />

      <PageBody>
        <ErrorNote message={error} />

        {/*
        The console: what this flow IS, what will happen when you run it, and
        what happened when you did — one panel, three bands.

        These were three separate cards stacked down the page, which read as
        three unrelated things and cost a band of empty page between each. They
        are one thing: the run you are about to start is configured by the row
        above it and reported by the row below it, so the progress bar can sit
        on the panel's own bottom edge instead of floating on a card of its own.
      */}
        <section className="tf-elev-2 overflow-hidden rounded-xl border border-line bg-surface">
          {/* Facts, and the exports that act on them. */}
          <div className="flex flex-wrap items-center gap-x-7 gap-y-4 px-4 py-3.5">
            <Stat label="Steps" value={flow.steps.length} />
            <Stat
              label="Timeout"
              value={`${(flow.timeout ?? DEFAULT_TIMEOUT_MS) / 1000}s`}
            />
            <Stat label="Updated" value={relativeTime(flow.updatedAt)} />
            <Stat
              label="Viewport"
              value={
                flow.env ? (
                  `${flow.env.viewport.width}×${flow.env.viewport.height}`
                ) : (
                  <span className="text-faint">—</span>
                )
              }
            />
            <span className="flex-1" />
            <div className="flex flex-wrap items-center gap-1.5">
              <Button
                size="sm"
                variant="secondary"
                onClick={downloadBundle}
                title="Full recording — what `npm run flow` replays"
              >
                Download bundle
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={download}
                title="Interoperable Chrome DevTools Recorder JSON"
              >
                Download JSON
              </Button>
              <Button size="sm" variant="danger" onClick={remove}>
                Delete
              </Button>
            </div>
          </div>

          {/*
          The replay controls live on the page, next to the progress they
          produce and the step list they act on — not in the nav bar. Nav chrome
          is for things that are true everywhere; speed and cursor only mean
          anything on this flow.
        */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line-soft bg-sunken px-4 py-3">
            <span className="tf-label shrink-0 text-muted">Replay</span>
            <Segmented<Speed>
              value={speed}
              onChange={setSpeed}
              disabled={busy}
              label="Replay speed"
              options={[
                {
                  value: "fast",
                  label: "Fast",
                  title:
                    "Compresses your pauses: input timing (key holds, double-click spacing) is kept exactly, think time is scaled down.",
                },
                {
                  value: "recorded",
                  label: "As recorded",
                  title:
                    "Keeps every pause you left, capped at 10s. Both speeds pace against deadlines, so a slow page never snowballs the run.",
                },
              ]}
            />
            <Toggle
              checked={showCursor}
              onChange={setShowCursor}
              disabled={busy}
              label="Cursor"
              title="Glides a visible pointer to each target before acting. Adds a moment per step."
            />
            <span className="flex-1" />
            {busy ? (
              <Button variant="danger" onClick={stopRun}>
                Stop
              </Button>
            ) : (
              <Button onClick={runInTab}>Run in tab</Button>
            )}
          </div>

          {runState !== "idle" && (
            <div className="tf-rise border-t border-line-soft">
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
                {runState === "connecting" && (
                  <span className="flex items-center gap-2 text-[13px] text-muted">
                    <Dot tone="warning" live />
                    Opening replay tab…
                  </span>
                )}
                {runState === "running" && (
                  <span className="flex items-center gap-2 text-[13px] font-medium">
                    <Dot tone="active" live />
                    {runningIndex >= 0
                      ? `Step ${runningIndex + 1} of ${flow.steps.length}`
                      : "Running"}
                  </span>
                )}
                {runState === "done" && (
                  <span
                    className={`flex items-center gap-2 rounded-md border px-2 py-1 text-[13px] font-medium ${
                      failed === 0
                        ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                        : "border-red-500/25 bg-red-500/10 text-red-700 dark:text-red-400"
                    }`}
                  >
                    <Dot tone={failed === 0 ? "success" : "danger"} />
                    {failed === 0
                      ? `${passed} passed`
                      : `${failed} failed, ${passed} passed`}
                  </span>
                )}
                <span className="flex-1" />
                <div className="flex items-center gap-3 font-mono text-[11px] text-muted">
                  {passed > 0 && (
                    <span className="flex items-center gap-1.5">
                      <Dot tone="success" /> {passed}
                    </span>
                  )}
                  {failed > 0 && (
                    <span className="flex items-center gap-1.5">
                      <Dot tone="danger" /> {failed}
                    </span>
                  )}
                  {skipped > 0 && (
                    <span className="flex items-center gap-1.5">
                      <Dot /> {skipped} skipped
                    </span>
                  )}
                </div>
              </div>
              {/* Flush to the panel's bottom edge — a progress bar reads as the
                edge of the thing making progress, not as a rule under it. */}
              <ProgressBar
                value={flow.steps.length ? settled / flow.steps.length : 0}
                tone={
                  failed > 0
                    ? "danger"
                    : runState === "done"
                      ? "success"
                      : "active"
                }
              />
            </div>
          )}
        </section>

        {/*
        The reading panel, with its tabs docked to its own top edge. Detached
        above the card, the tabs read as page furniture; attached, they are
        visibly a control FOR this panel — and it costs a row of page instead
        of a row plus a gap.
      */}
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line-soft px-3 py-2.5">
            <Segmented<View>
              value={view}
              onChange={setView}
              label="View"
              options={[
                { value: "steps", label: "Steps" },
                { value: "json", label: "JSON" },
                { value: "playwright", label: "Playwright" },
              ]}
            />
            {view !== "steps" && (
              <span className="text-xs text-muted">
                {view === "json"
                  ? "Byte-compatible with Chrome DevTools Recorder."
                  : "Generated from the steps and their sidecars."}
              </span>
            )}
          </div>
          {view === "steps" && (
            <div className={`tf-scroll overflow-y-auto ${PANEL}`}>
              <FlowStepList
                steps={flow.steps}
                statuses={runState === "idle" ? undefined : statuses}
                errors={stepErrors}
                notes={stepNotes}
                meta={flow.meta}
              />
            </div>
          )}
          {view === "json" && (
            <pre
              className={`tf-scroll overflow-auto bg-sunken p-4 font-mono text-xs leading-5 text-muted ${PANEL}`}
            >
              {JSON.stringify(
                {
                  title: flow.title,
                  timeout: flow.timeout ?? DEFAULT_TIMEOUT_MS,
                  steps: exportSteps(flow.steps),
                },
                null,
                4,
              )}
            </pre>
          )}
          {view === "playwright" && (
            <pre
              className={`tf-scroll overflow-auto bg-sunken p-4 font-mono text-xs leading-5 text-muted ${PANEL}`}
            >
              {flowToPlaywright({
                title: flow.title,
                steps: flow.steps,
                // The sidecars are what make the export reproduce the session:
                // env drives test.use(), meta drives frame and tab targeting.
                meta: flow.meta,
                env: flow.env,
              })}
            </pre>
          )}
        </Card>
      </PageBody>
    </Layout>
  );
}
