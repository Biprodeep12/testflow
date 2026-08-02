import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import { Button, Card, ErrorNote, Layout } from "@/components/Layout";
import { FlowStepList } from "@/components/FlowStepList";
import { post } from "@/lib/client";
import {
  BUNDLE_EXTENSION,
  exportSteps,
  toBundle,
  type AgentMessage,
  type EnvRecord,
  type FlowStep,
  type HubMessage,
  type StepMeta,
} from "@/types/flow";

type Phase = "form" | "waiting" | "recording" | "stopped";

function defaultTitle(): string {
  const now = new Date();
  return `Recording ${now.toLocaleDateString()} at ${now.toLocaleTimeString()}`;
}

function sendHub(message: HubMessage): void {
  window.postMessage(message, window.location.origin);
}

export default function RecordPage() {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [steps, setSteps] = useState<FlowStep[]>([]);
  // Sidecars, kept index-aligned with `steps`: where each step ran, and the
  // environment it ran in. Without these a saved flow can be re-performed but not
  // reproduced.
  const [meta, setMeta] = useState<StepMeta[]>([]);
  const [env, setEnv] = useState<EnvRecord | undefined>(undefined);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [extensionReady, setExtensionReady] = useState<boolean | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  // The whole conversation with the extension happens on this listener. The bridge
  // content script (extension) relays between here and the service worker.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as AgentMessage | undefined;
      if (!data || data.source !== "tf-agent") return;

      switch (data.kind) {
        case "bridge-ready":
          setExtensionReady(true);
          break;
        case "snapshot":
          // Full state from the SW — also how a dashboard reload rejoins a
          // recording already in progress.
          setExtensionReady(true);
          // A recording that lost a step must not look complete when it is saved.
          if (data.error) setError(data.error);
          if (data.recording || data.steps.length > 0) {
            setSteps(data.steps);
            setMeta(data.meta);
            if (data.env) setEnv(data.env);
            setPhase((current) =>
              data.recording
                ? "recording"
                : current === "recording" || current === "waiting"
                  ? "stopped"
                  : current,
            );
            setTitle((current) => current || defaultTitle());
          }
          break;
        case "step":
          setSteps((previous) => [...previous, data.step]);
          setMeta((previous) => [...previous, data.meta]);
          break;
        case "stopped":
          setPhase((current) =>
            current === "recording" || current === "waiting" ? "stopped" : current,
          );
          break;
        default:
          break;
      }
    };

    window.addEventListener("message", onMessage);
    // The bridge announces on load; ping covers the case where it loaded first.
    sendHub({ source: "tf-hub", kind: "ping" });
    const probe = setTimeout(() => {
      setExtensionReady((current) => (current === null ? false : current));
    }, 1200);
    return () => {
      window.removeEventListener("message", onMessage);
      clearTimeout(probe);
    };
  }, []);

  useEffect(() => {
    // "auto", not "smooth": steps arrive faster than a smooth scroll can finish, so
    // the animations queue up and the list lags further behind the longer you record.
    bottom.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [steps.length]);

  const start = (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    const target = url.trim();
    if (!/^https?:\/\//i.test(target)) {
      setError("Enter a full http(s) URL, e.g. https://example.com");
      return;
    }
    setSteps([]);
    setMeta([]);
    setEnv(undefined);
    setTitle(defaultTitle());
    setPhase("waiting");
    // The EXTENSION opens the tab and starts recording — no popup blockers, no
    // opener dependency, survives every navigation.
    sendHub({ source: "tf-hub", kind: "openAndRecord", url: target });
  };

  const stop = () => sendHub({ source: "tf-hub", kind: "stop" });

  const discard = () => {
    setSteps([]);
    setMeta([]);
    setEnv(undefined);
    setPhase("form");
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const data = await post<{ flowId: string }>("/api/flows", {
        title: title.trim() || defaultTitle(),
        sourceUrl: url.trim() || undefined,
        timeout: 5000, // native flow-level wait budget (selectors, redirects, loads)
        steps,
        meta,
        env,
      });
      await router.push(`/flows/${data.flowId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  };

  const save2 = (json: string, suffix: string) => {
    const blob = new Blob([json], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${(title || "recording").replace(/[^\w-]+/g, "-")}${suffix}`;
    link.click();
    URL.revokeObjectURL(link.href);
  };

  const download = () => {
    // Timestamps stay in saved flows (they drive "as recorded" replay speed) but are
    // stripped from downloads so the JSON is byte-compatible with DevTools.
    save2(
      JSON.stringify(
        { title: title.trim() || defaultTitle(), timeout: 5000, steps: exportSteps(steps) },
        null,
        4,
      ),
      ".json",
    );
  };

  // The full recording, runnable by `npm run flow` without Firebase in the loop.
  const downloadBundle = () => {
    save2(
      toBundle({ title: title.trim() || defaultTitle(), timeout: 5000, steps, meta, env }),
      BUNDLE_EXTENSION,
    );
  };

  const interactionCount = steps.filter(
    (step) => step.type !== "setViewport" && step.type !== "navigate",
  ).length;

  return (
    <Layout>
      <h1 className="text-2xl font-semibold tracking-tight">Record a flow</h1>
      <p className="mt-1 text-sm text-zinc-500">
        The extension opens the site in a new tab and records every interaction —
        any site, across navigations. Nothing is stored until you save.
      </p>

      <ErrorNote message={error} />

      {extensionReady === false && (
        <Card className="mt-6 border-amber-300 p-5 text-sm dark:border-amber-900/60">
          <h2 className="font-semibold text-amber-700 dark:text-amber-300">
            Extension not detected
          </h2>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-zinc-600 dark:text-zinc-400">
            <li>
              Build it once: <code className="font-mono">npm run build:ext</code>
            </li>
            <li>
              Open <code className="font-mono">chrome://extensions</code>, enable
              Developer mode
            </li>
            <li>
              <b>Load unpacked</b> → select{" "}
              <code className="font-mono">extension/dist</code>
            </li>
            <li>Reload this page</li>
          </ol>
        </Card>
      )}

      {phase === "form" && (
        <Card className="mt-6 p-6">
          <form onSubmit={start} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Website URL</span>
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://example.com"
                required
                className="rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-300"
              />
            </label>
            <div className="flex items-center gap-3">
              <Button type="submit" disabled={extensionReady !== true}>
                Start Session
              </Button>
              <button
                type="button"
                onClick={() =>
                  setUrl(`${window.location.origin}/demo.html`)
                }
                className="text-xs text-zinc-500 underline-offset-2 hover:underline"
              >
                try the demo page
              </button>
              <span className="text-xs text-zinc-500">
                You can also hit ⏺ Record in the extension popup on any tab.
              </span>
            </div>
          </form>
        </Card>
      )}

      {phase !== "form" && (
        <>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {phase === "waiting" && (
              <span className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
                <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
                Opening the tab…
              </span>
            )}
            {phase === "recording" && (
              <span className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                Recording — interact with the tab
              </span>
            )}
            {phase === "stopped" && (
              <span className="text-sm font-medium text-zinc-500">■ Stopped</span>
            )}
            <span
              data-testid="tf-step-count"
              className="rounded-full bg-zinc-100 px-2.5 py-1 font-mono text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            >
              {steps.length} steps
            </span>
            <span className="flex-1" />
            {phase !== "stopped" && (
              <Button variant="danger" onClick={stop}>
                Stop recording
              </Button>
            )}
          </div>

          {phase === "stopped" && (
            <Card className="mt-4 p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
                <label className="flex flex-1 flex-col gap-1.5">
                  <span className="text-sm font-medium">Flow name</span>
                  <input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    className="rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-900 dark:border-zinc-700 dark:bg-zinc-950 dark:focus:border-zinc-300"
                  />
                </label>
                <div className="flex gap-2">
                  <Button onClick={save} disabled={saving || interactionCount === 0}>
                    {saving ? "Saving…" : "Save flow"}
                  </Button>
                  <Button variant="secondary" onClick={downloadBundle}>
                    Download bundle
                  </Button>
                  <Button variant="secondary" onClick={download}>
                    Download JSON
                  </Button>
                  <Button variant="secondary" onClick={discard}>
                    Discard
                  </Button>
                </div>
              </div>
              {interactionCount === 0 && (
                <p className="mt-3 text-xs text-zinc-500">
                  No interactions were recorded — nothing worth saving yet.
                </p>
              )}
            </Card>
          )}

          <Card className="mt-4 overflow-hidden">
            <div className="border-b border-zinc-100 px-5 py-3 dark:border-zinc-800">
              <h2 className="text-sm font-semibold">Steps</h2>
            </div>
            {steps.length === 0 ? (
              <p className="px-6 py-12 text-center text-sm text-zinc-500">
                Nothing yet — interact with the opened tab.
              </p>
            ) : (
              <div className="max-h-128 overflow-y-auto">
                {/* Live view: this re-renders on every captured step, so the drawn
                    list is bounded. The recording keeps everything. */}
                <FlowStepList steps={steps} maxRendered={150} />
                <div ref={bottom} />
              </div>
            )}
          </Card>
        </>
      )}
    </Layout>
  );
}
