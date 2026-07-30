import { useCallback, useState } from "react";
import Link from "next/link";
import { Card, ErrorNote, Layout } from "@/components/Layout";
import { apiFetch, relativeTime } from "@/lib/client";
import { usePoll } from "@/hooks/usePoll";

type FlowSummary = {
  id: string;
  title: string;
  sourceUrl: string;
  stepCount: number;
  updatedAt: number;
};

export default function FlowsPage() {
  const [flows, setFlows] = useState<FlowSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

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

  return (
    <Layout title="Flows">
      <h1 className="text-2xl font-semibold tracking-tight">Flows</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Saved recordings in Chrome DevTools Recorder format.
      </p>

      <ErrorNote message={error} />

      <Card className="mt-6 overflow-hidden">
        {!loaded ? (
          <p className="px-6 py-10 text-center text-sm text-zinc-500">Loading…</p>
        ) : flows.length === 0 ? (
          <p className="px-6 py-10 text-center text-sm text-zinc-500">
            Nothing saved yet — record a flow and hit{" "}
            <span className="font-medium">Save</span>.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {flows.map((flow) => (
              <li key={flow.id}>
                <Link
                  href={`/flows/${flow.id}`}
                  className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/50"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {flow.title}
                    </span>
                    <span className="block truncate font-mono text-xs text-zinc-500">
                      {flow.sourceUrl}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-zinc-500">
                    {flow.stepCount} steps
                  </span>
                  <span className="w-20 shrink-0 text-right text-xs text-zinc-400">
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
