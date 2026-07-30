import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { Button, Card, ErrorNote, Layout } from "@/components/Layout";
import { FlowStepList, type StepStatus } from "@/components/FlowStepList";
import { apiFetch, del } from "@/lib/client";
import { usePoll } from "@/hooks/usePoll";
import { flowToPlaywright } from "@/codegen/fromFlow";
import {
  DEFAULT_TIMEOUT_MS,
  exportSteps,
  type AgentMessage,
  type FlowDoc,
  type FlowStep,
  type HubMessage,
} from "@/types/flow";

type View = "steps" | "json" | "playwright";
type RunState = "idle" | "connecting" | "running" | "done";
type Speed = "fast" | "recorded";

const STEP_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 20000;
/** "As recorded" honours your pauses, but a coffee break shouldn't stall a run. */
const MAX_RECORDED_PAUSE_MS = 10000;
/** Fallback pacing for flows saved before timestamps existed. */
const LEGACY_PAUSE_MS = 800;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
  const [statuses, setStatuses] = useState<StepStatus[]>([]);
  const [stepErrors, setStepErrors] = useState<(string | undefined)[]>([]);
  // Resolvers the message listener completes: ready/settled handshakes + step results.
  const waiters = useRef<{
    ready?: () => void;
    settled?: () => void;
    /** counters de-race settle: `load` may fire before the waiter is armed */
    readyCount: number;
    settledCount: number;
    result: Map<number, (r: { ok: boolean; error?: string }) => void>;
  }>({ readyCount: 0, settledCount: 0, result: new Map() });

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

  // One listener for the whole replay conversation, relayed by the extension bridge.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as AgentMessage | undefined;
      if (!data || data.source !== "tf-agent") return;
      if (data.kind === "ready") {
        waiters.current.readyCount++;
        waiters.current.ready?.();
        waiters.current.ready = undefined;
      }
      if (data.kind === "settled") {
        waiters.current.settledCount++;
        waiters.current.settled?.();
        waiters.current.settled = undefined;
      }
      if (data.kind === "stepResult") {
        const resolve = waiters.current.result.get(data.id);
        if (resolve) {
          waiters.current.result.delete(data.id);
          resolve({ ok: data.ok, error: data.error });
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const waitReady = (timeoutMs: number) =>
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        waiters.current.ready = undefined;
        resolve(false);
      }, timeoutMs);
      waiters.current.ready = () => {
        clearTimeout(timer);
        resolve(true);
      };
    });

  /**
   * After a navigation/redirect: give the page up to the flow's timeout (default 5s)
   * to fully load before the next step. Resolves early the moment `load` fires — a
   * state-tied wait, not a fixed sleep — and applies in BOTH speeds.
   */
  const waitSettled = (timeoutMs: number) =>
    new Promise<void>((resolve) => {
      // The latest page already reported full load — nothing to wait for.
      if (waiters.current.settledCount >= waiters.current.readyCount) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        waiters.current.settled = undefined;
        resolve();
      }, timeoutMs);
      waiters.current.settled = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const sendStep = (stepId: number, step: FlowStep) =>
    new Promise<{ ok: boolean; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        waiters.current.result.delete(stepId);
        resolve({ ok: false, error: `no response after ${STEP_TIMEOUT_MS / 1000}s` });
      }, STEP_TIMEOUT_MS);
      waiters.current.result.set(stepId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
      sendHub({ source: "tf-hub", kind: "runStep", id: stepId, step });
    });

  const runInTab = async () => {
    if (!flow) return;
    const steps = flow.steps;
    const nav = steps.find((step) => step.type === "navigate");
    if (!nav?.url) {
      setError("This flow has no navigate step to start from.");
      return;
    }

    setError(null);
    setRunState("connecting");
    setStatuses(steps.map(() => "pending"));
    setStepErrors(steps.map(() => undefined));

    // The extension opens the tab in replay mode; the first cs-ready is our go.
    waiters.current.readyCount = 0;
    waiters.current.settledCount = 0;
    const flowTimeout = flow.timeout ?? DEFAULT_TIMEOUT_MS;
    const readyPromise = waitReady(CONNECT_TIMEOUT_MS);
    sendHub({ source: "tf-hub", kind: "openForReplay", url: nav.url });
    const connected = await readyPromise;
    if (!connected) {
      setError(
        "The extension never reported the tab ready. Is the TestFlow extension loaded? (chrome://extensions → Load unpacked → extension/dist)",
      );
      setRunState("idle");
      return;
    }
    // Let the first page finish loading (up to the flow timeout) before step one.
    await waitSettled(flowTimeout);

    setRunState("running");
    const mark = (index: number, status: StepStatus, message?: string) => {
      setStatuses((previous) =>
        previous.map((s, i) => (i === index ? status : s)),
      );
      if (message) {
        setStepErrors((previous) =>
          previous.map((e, i) => (i === index ? message : e)),
        );
      }
    };

    // "As recorded": wait the same gap you left between interactions while
    // recording (capped), so timing-sensitive UI (debounces, animations,
    // dropdowns) behaves like it did for you.
    let previousTs: number | null = null;
    const paceFor = (step: FlowStep): number => {
      if (speed !== "recorded") return 0;
      const ts = step.timestamp;
      if (typeof ts !== "number") return LEGACY_PAUSE_MS;
      const gap = previousTs === null ? 0 : ts - previousTs;
      previousTs = ts;
      return Math.min(Math.max(gap, 0), MAX_RECORDED_PAUSE_MS);
    };

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];

      // Opening the tab already satisfied the first navigation; a tab can't
      // resize itself, so setViewport is informational.
      if (
        step.type === "setViewport" ||
        (step.type === "navigate" && step.url === nav.url && i <= 1)
      ) {
        // Skipped steps still anchor the clock so the first real step's gap is honest.
        if (typeof step.timestamp === "number") previousTs = step.timestamp;
        mark(i, "skipped");
        continue;
      }

      const pause = paceFor(step);
      if (pause > 0) await sleep(pause);

      mark(i, "running");
      // Per-step wait budget rides on the step itself — the native DevTools field.
      const timedStep: FlowStep = { ...step, timeout: step.timeout ?? flowTimeout };

      if (step.type === "navigate") {
        // The page unloads on navigation; the fresh page's ready is the outcome.
        void sendStep(i, timedStep);
        const ok = await waitReady(STEP_TIMEOUT_MS);
        if (ok) await waitSettled(flowTimeout); // redirect settle — both speeds
        mark(i, ok ? "pass" : "fail", ok ? undefined : "navigation timed out");
        if (!ok) break;
        continue;
      }

      const result = await sendStep(i, timedStep);

      if (!result.ok && step.assertedEvents?.some((e) => e.type === "navigation")) {
        // The click killed the document before it could reply ("tab did not
        // respond") — the reload's ready handshake is the real outcome.
        const ok = await waitReady(STEP_TIMEOUT_MS);
        if (ok) await waitSettled(flowTimeout);
        mark(i, ok ? "pass" : "fail", ok ? undefined : result.error);
        if (!ok) break;
        continue;
      }

      mark(i, result.ok ? "pass" : "fail", result.error);
      if (!result.ok) break;

      if (step.assertedEvents?.some((e) => e.type === "navigation")) {
        // Successful reply with a navigation still coming — wait for the reload
        // AND its full settle before the next step races a dying document.
        await waitReady(STEP_TIMEOUT_MS);
        await waitSettled(flowTimeout);
      }
    }

    setRunState("done");
  };

  const stopRun = () => {
    sendHub({ source: "tf-hub", kind: "closeReplay" });
    setRunState("idle");
  };

  const download = () => {
    if (!flow) return;
    // exportSteps strips TestFlow-only fields (timestamps) — pure DevTools format.
    const json = JSON.stringify(
      {
        title: flow.title,
        timeout: flow.timeout ?? DEFAULT_TIMEOUT_MS,
        steps: exportSteps(flow.steps),
      },
      null,
      4,
    );
    const blob = new Blob([json], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${flow.title.replace(/[^\w-]+/g, "-")}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
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
        <ErrorNote message={error} />
        <p className="text-sm text-zinc-500">Loading…</p>
      </Layout>
    );
  }

  const passed = statuses.filter((s) => s === "pass").length;
  const failed = statuses.filter((s) => s === "fail").length;

  return (
    <Layout title={flow.title}>
      <ErrorNote message={error} />

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">
            {flow.title}
          </h1>
          <p className="mt-1 truncate font-mono text-sm text-zinc-500">
            {flow.sourceUrl}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
            Speed
            <select
              value={speed}
              onChange={(event) => setSpeed(event.target.value as Speed)}
              disabled={runState === "running" || runState === "connecting"}
              className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-sm outline-none dark:border-zinc-700 dark:bg-zinc-950"
              title="As recorded replays with the same pauses you left between interactions (capped at 10s)"
            >
              <option value="fast">Fast</option>
              <option value="recorded">As recorded</option>
            </select>
          </label>
          {runState === "running" || runState === "connecting" ? (
            <Button variant="danger" onClick={stopRun}>
              Stop
            </Button>
          ) : (
            <Button onClick={runInTab}>Run in tab</Button>
          )}
          <Button variant="secondary" onClick={download}>
            Download JSON
          </Button>
          <Button variant="danger" onClick={remove}>
            Delete
          </Button>
        </div>
      </div>

      {runState === "connecting" && (
        <Card className="mt-4 p-4 text-sm text-zinc-600 dark:text-zinc-400">
          Opening a replay tab through the extension…
        </Card>
      )}
      {runState === "done" && (
        <Card
          className={`mt-4 p-4 text-sm font-medium ${
            failed === 0
              ? "text-emerald-700 dark:text-emerald-300"
              : "text-red-700 dark:text-red-300"
          }`}
        >
          {failed === 0
            ? `✓ All ${passed} steps passed`
            : `✗ Failed — ${passed} passed, ${failed} failed`}
        </Card>
      )}

      <div className="mt-6 flex gap-1">
        {(["steps", "json", "playwright"] as View[]).map((v) => (
          <button
            key={v}
            onClick={() => setView(v)}
            className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
              view === v
                ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {v === "steps" ? "Steps" : v === "json" ? "JSON" : "Playwright"}
          </button>
        ))}
      </div>

      <Card className="mt-3 overflow-hidden">
        {view === "steps" && (
          <div className="max-h-160 overflow-y-auto">
            <FlowStepList
              steps={flow.steps}
              statuses={runState === "idle" ? undefined : statuses}
              errors={stepErrors}
            />
          </div>
        )}
        {view === "json" && (
          <pre className="max-h-160 overflow-auto p-4 font-mono text-xs leading-5">
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
          <pre className="max-h-160 overflow-auto p-4 font-mono text-xs leading-5">
            {flowToPlaywright({ title: flow.title, steps: flow.steps })}
          </pre>
        )}
      </Card>
    </Layout>
  );
}
