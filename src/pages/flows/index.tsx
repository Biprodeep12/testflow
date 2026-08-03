import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import {
  Badge,
  Card,
  EmptyState,
  ErrorNote,
  Input,
  Layout,
  PageBody,
  PageHeader,
  SOLID,
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
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-[13px] font-medium transition-all duration-150 ease-out active:translate-y-px ${SOLID}`}
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
              <circle cx="8" cy="8" r="3.4" fill="currentColor" />
            </svg>
            New recording
          </Link>
        }
      />

      <PageBody>
        <ErrorNote message={error} />

        {/* Search earns its place only once scanning stops being instant. */}
        {flows.length > 5 && (
          <div className="max-w-xs">
            <Input
              value={query}
              onChange={setQuery}
              placeholder="Filter by name or URL"
              label="Filter flows"
            />
          </div>
        )}

        <Card className="overflow-hidden">
          {!loaded ? (
            <ul className="divide-y divide-line-soft">
              {[0, 1, 2].map((row) => (
                <li key={row} className="flex items-center gap-4 px-3.5 py-3">
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="tf-shimmer h-3.5 w-1/3 rounded bg-line-soft text-muted" />
                    <span className="tf-shimmer h-2.5 w-1/5 rounded bg-line-soft text-muted" />
                  </span>
                  <span className="tf-shimmer h-4 w-16 rounded bg-line-soft text-muted" />
                </li>
              ))}
            </ul>
          ) : shown.length === 0 ? (
            <EmptyState
              icon={
                <svg viewBox="0 0 16 16" className="h-4 w-4" aria-hidden="true">
                  <circle
                    cx="8"
                    cy="8"
                    r="5.6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.3"
                  />
                  <circle cx="8" cy="8" r="1.8" fill="currentColor" />
                </svg>
              }
              title={flows.length === 0 ? "No saved flows" : "No matches"}
              hint={
                flows.length === 0
                  ? "Record a flow and save it — it will show up here."
                  : "Try a different name or URL."
              }
            />
          ) : (
            <ul className="divide-y divide-line-soft">
              {shown.map((flow) => (
                <li key={flow.id}>
                  <Link
                    href={`/flows/${flow.id}`}
                    className="group flex items-center gap-3 px-3.5 py-3 transition-colors duration-150 hover:bg-sunken"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium">
                        {flow.title}
                      </span>
                      <span className="mt-0.5 block truncate font-mono text-[11px] text-muted">
                        {hostOf(flow.sourceUrl)}
                      </span>
                    </span>
                    <Badge>{flow.stepCount} steps</Badge>
                    <span className="hidden w-20 shrink-0 text-right font-mono text-[11px] text-faint sm:block">
                      {relativeTime(flow.updatedAt)}
                    </span>
                    {/* Reveals on hover: the row is a link, and a chevron says so
                      without printing an arrow on every row of a long list. */}
                    <svg
                      viewBox="0 0 16 16"
                      aria-hidden="true"
                      className="h-3.5 w-3.5 shrink-0 -translate-x-1 text-faint opacity-0 transition-all duration-150 group-hover:translate-x-0 group-hover:opacity-100"
                    >
                      <path
                        d="M6 3.5 10.5 8 6 12.5"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </PageBody>
    </Layout>
  );
}
