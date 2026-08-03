import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/router";
import {
  AuthConfigNote,
  Badge,
  Button,
  Card,
  CardHeader,
  Dot,
  EmptyState,
  ErrorNote,
  Field,
  Input,
  Layout,
  PageHeader,
} from "@/components/Layout";
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

/** Inline code — commands and paths, so they are copyable by eye. */
function Mono({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded border border-zinc-200 px-1 font-mono text-[12px] text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
      {children}
    </code>
  );
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
    <Layout
      signal={phase === "recording" || phase === "waiting" ? "record" : null}
      actions={
        extensionReady !== null && (
          <Badge tone={extensionReady ? "success" : "warning"}>
            <Dot tone={extensionReady ? "success" : "warning"} />
            {extensionReady ? "extension ready" : "no extension"}
          </Badge>
        )
      }
    >
      <PageHeader
        title="Record a flow"
        description="The extension opens the URL in a new tab and captures every interaction — across navigations, iframes and popups. Nothing is stored until you save."
      />

      <AuthConfigNote />
      <ErrorNote message={error} />

      {extensionReady === false && (
        <Card className="mt-5 p-4">
          <h2 className="flex items-center gap-2 text-[13px] font-medium">
            <Dot tone="warning" />
            Extension not loaded
          </h2>
          <ol className="mt-2.5 space-y-1 text-[13px] text-zinc-500 dark:text-zinc-400">
            <li>
              1. <Mono>npm run build:ext</Mono>
            </li>
            <li>
              2. <Mono>chrome://extensions</Mono> → enable Developer mode
            </li>
            <li>
              3. Load unpacked → <Mono>extension/dist</Mono>
            </li>
            <li>4. Reload this page</li>
          </ol>
        </Card>
      )}

      {phase === "form" && (
        <Card className="tf-rise mt-5 overflow-hidden">
          <CardHeader title="New session" />
          <form onSubmit={start} className="flex flex-col gap-3 p-4">
            {/*
              A command bar rather than a labelled field: the URL is the input
              to an instrument, and the engraved prefix carries the label so the
              row reads as one control instead of a form.
            */}
            <div className="flex gap-2">
              <div className="flex h-9 flex-1 items-center rounded-md border border-zinc-200 bg-white transition-colors focus-within:border-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:focus-within:border-zinc-600">
                <span className="tf-label shrink-0 self-center border-r border-zinc-200 px-2.5 py-1 text-zinc-400 dark:border-zinc-800 dark:text-zinc-600">
                  URL
                </span>
                <input
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder="https://example.com"
                  required
                  aria-label="Target URL"
                  className="h-full min-w-0 flex-1 bg-transparent px-2.5 font-mono text-[13px] outline-none placeholder:text-zinc-400 dark:placeholder:text-zinc-600"
                />
              </div>
              <Button
                type="submit"
                disabled={extensionReady !== true}
                className="h-9 px-4"
              >
                Start Session
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
              <button
                type="button"
                onClick={() => setUrl(`${window.location.origin}/demo.html`)}
                className="underline underline-offset-4 hover:text-zinc-900 dark:hover:text-zinc-100"
              >
                use the demo page
              </button>
              <span className="text-zinc-300 dark:text-zinc-700">·</span>
              <span>Or hit Record in the extension popup on any tab.</span>
            </div>
          </form>
        </Card>
      )}

      {phase !== "form" && (
        <>
          {/* Sticky: Stop must stay reachable however far the step list has
              scrolled — a recording left running keeps capturing. */}
          <div className="sticky top-12.5 z-30 -mx-5 mt-5 border-y border-zinc-200 bg-(--tf-bg)/92 px-5 py-2 backdrop-blur-sm dark:border-zinc-800/90">
            <div className="flex flex-wrap items-center gap-3">
              {phase === "waiting" && (
                <span className="flex items-center gap-2 text-[13px] text-zinc-500">
                  <Dot tone="warning" live />
                  Opening tab…
                </span>
              )}
              {phase === "recording" && (
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  <Dot tone="danger" live />
                  Recording
                </span>
              )}
              {phase === "stopped" && (
                <span className="flex items-center gap-2 text-[13px] text-zinc-500">
                  <Dot />
                  Stopped
                </span>
              )}
              <Badge testId="tf-step-count">{steps.length} steps</Badge>
              {interactionCount > 0 && (
                <span className="font-mono text-[11px] text-zinc-500">
                  {interactionCount} interaction{interactionCount === 1 ? "" : "s"}
                </span>
              )}
              <span className="flex-1" />
              {phase !== "stopped" && (
                <Button variant="danger" onClick={stop}>
                  Stop recording
                </Button>
              )}
            </div>
          </div>

          {phase === "stopped" && (
            <Card className="mt-5 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-end">
                <div className="flex-1">
                  <Field label="Flow name">
                    <Input value={title} onChange={setTitle} />
                  </Field>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <Button onClick={save} disabled={saving || interactionCount === 0}>
                    {saving ? "Saving…" : "Save flow"}
                  </Button>
                  <Button variant="secondary" onClick={downloadBundle}>
                    Download bundle
                  </Button>
                  <Button variant="secondary" onClick={download}>
                    Download JSON
                  </Button>
                  <Button variant="ghost" onClick={discard}>
                    Discard
                  </Button>
                </div>
              </div>
              {interactionCount === 0 && (
                <p className="mt-2 text-xs text-zinc-500">
                  No interactions recorded — nothing to save.
                </p>
              )}
            </Card>
          )}

          <Card className="mt-5 overflow-hidden">
            <CardHeader
              title="Steps"
              right={
                phase === "recording" ? (
                  <span className="flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
                    <Dot tone="danger" live />
                    live
                  </span>
                ) : undefined
              }
            />
            {steps.length === 0 ? (
              <EmptyState
                title="No steps yet"
                hint="Interact with the opened tab — clicks, typing, scrolling and navigations land here as they happen."
              />
            ) : (
              <div className="tf-scroll max-h-128 overflow-y-auto">
                {/* Live view: this re-renders on every captured step, so the drawn
                    list is bounded. The recording keeps everything. */}
                <FlowStepList steps={steps} meta={meta} maxRendered={150} />
                <div ref={bottom} />
              </div>
            )}
          </Card>
        </>
      )}
    </Layout>
  );
}
