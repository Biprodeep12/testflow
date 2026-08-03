import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  Input,
  Layout,
  PageHeader,
} from "@/components/Layout";
import { apiFetch, relativeTime } from "@/lib/client";
import { usePoll } from "@/hooks/usePoll";

type FlowSummary = {
  id: string;
  title: string;
  sourceUrl: string;
  stepCount: number;
  updatedAt: number;
};

/** Host only — the full URL is already on the row, and it never fits twice. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export default function FlowsPage() {
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ flows: FlowSummary[] }>("/api/flows");
      setFlows(data.flows);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoaded(true);
    }
  }, []);

  usePoll(load, null);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return flows;
    return flows.filter(
      (flow) =>
        flow.title.toLowerCase().includes(needle) ||
        flow.sourceUrl.toLowerCase().includes(needle),
    );
  }, [flows, query]);

  return (
    <Layout title="Flows">
      <PageHeader
        title="Flows"
        description="Saved recordings in Chrome DevTools Recorder format — replayable in the browser or with Playwright."
        actions={
          <Link
            href="/"
            className="inline-flex h-8 items-center rounded-md bg-zinc-900 px-3 text-[13px] font-medium text-white transition-colors hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            New recording
          </Link>
        }
      />

      <ErrorNote message={error} />

      {/* Search earns its place only once scanning stops being instant. */}
      {flows.length > 5 && (
        <div className="mt-5 max-w-xs">
          <Input
            value={query}
            onChange={setQuery}
            placeholder="Filter by name or URL"
            label="Filter flows"
          />
        </div>
      )}

      <Card className="mt-5 overflow-hidden">
        {!loaded ? (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {[0, 1, 2].map((row) => (
              <li key={row} className="flex items-center gap-4 px-3 py-2.5">
                <span className="tf-shimmer h-3.5 flex-1 rounded bg-zinc-100 text-zinc-400 dark:bg-zinc-900" />
                <span className="tf-shimmer h-3.5 w-16 rounded bg-zinc-100 text-zinc-400 dark:bg-zinc-900" />
              </li>
            ))}
          </ul>
        ) : shown.length === 0 ? (
          <EmptyState
            title={flows.length === 0 ? "No saved flows" : "No matches"}
            hint={
              flows.length === 0
                ? "Record a flow and save it — it will show up here."
                : "Try a different name or URL."
            }
          />
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {shown.map((flow) => (
              <li key={flow.id}>
                <Link
                  href={`/flows/${flow.id}`}
                  className="group flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900/60"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">
                      {flow.title}
                    </span>
                    <span className="mt-0.5 block truncate font-mono text-[11px] text-zinc-500">
                      {hostOf(flow.sourceUrl)}
                    </span>
                  </span>
                  <Badge>{flow.stepCount} steps</Badge>
                  <span className="hidden w-20 shrink-0 text-right font-mono text-[11px] text-zinc-400 sm:block">
                    {relativeTime(flow.updatedAt)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Layout>
  );
}
