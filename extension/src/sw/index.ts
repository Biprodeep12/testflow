/**
 * Service worker — owns sessions and routes everything.
 *
 * MV3 workers are evicted after ~30s idle, so ALL session state lives in
 * chrome.storage.session (survives eviction, dies with the browser — right lifetime
 * for an unsaved recording). Steps are seeded exactly like DevTools: setViewport +
 * navigate(assertedEvents) on the first page ready, assertedEvents pinned onto the
 * causing step on later loads.
 */

import {
  frameKey,
  frameSignature,
  ROOT_TARGET,
  type AgentMessage,
  type CsToSw,
  type EnvRecord,
  type FlowStep,
  type FrameLink,
  type HubMessage,
  type StepMeta,
  type LocateResult,
  type TabMode,
  type TargetId,
} from "../shared/flow";
import * as cdp from "./cdp";

/** A frame that has announced itself, and where to reach it. */
type FrameEntry = {
  tabId: number;
  frameId: number;
  /** index path, e.g. "" (main) or "0/2" */
  key: string;
  /** iframe-element selector path — survives frame reordering, unlike the indices */
  signature: string;
};

type Session = {
  /** "stopped" keeps the steps around for popup Download until a new session starts */
  mode: "record" | "replay" | "stopped";
  /** every tab participating (popups the flow opened join automatically) */
  tabIds: number[];
  /**
   * Logical tab identity. Real tab ids differ every run, so steps reference "t0",
   * "t1"… and replay re-binds those to whatever tab ids it gets, in the order the
   * flow opened them.
   */
  targets: Record<number, TargetId>;
  /** first URL seen per logical target — DevTools' `target` field for popups */
  targetUrls: Record<string, string>;
  nextTarget: number;
  /**
   * Steps do NOT live here.
   *
   * They are stored one key per step (see STEP_PREFIX). Keeping them in the session
   * object meant every recorded step rewrote the entire recording — a linear write
   * per step, quadratic over a session, and measurably slower the longer you record.
   * The session now holds only bookkeeping, so its writes are a constant size.
   */
  stepCount: number;
  /** the step a dialog or download attaches itself to */
  lastStepId: number;
  /** set when a step could not be stored — the recording is no longer complete */
  storageError?: string;
  /** monotonic within a session — pairs each step with its sidecar entry */
  nextStepId: number;
  env?: EnvRecord;
  startedAt: number;
  sourceUrl: string;
};

const KEY = "tf-session";
const FRAMES_KEY = "tf-frames";
/** One storage key per recorded step: `tf-s-<id>` -> { step, meta }. */
const STEP_PREFIX = "tf-s-";

type StoredStep = { step: FlowStep; meta: StepMeta };

/** Every recorded step, in order. O(n) — for snapshots and saves, never per step. */
async function getRecorded(): Promise<{ steps: FlowStep[]; meta: StepMeta[] }> {
  const all = await chrome.storage.session.get(null);
  const rows: [number, StoredStep][] = [];
  for (const [key, value] of Object.entries(all)) {
    if (key.startsWith(STEP_PREFIX)) {
      rows.push([Number(key.slice(STEP_PREFIX.length)), value as StoredStep]);
    }
  }
  rows.sort((a, b) => a[0] - b[0]);
  return {
    steps: rows.map(([, row]) => row.step),
    meta: rows.map(([, row]) => row.meta),
  };
}

/** Reads one step for in-place amendment (a dialog answer, a download filename). */
async function getStep(id: number): Promise<StoredStep | undefined> {
  const key = STEP_PREFIX + id;
  return (await chrome.storage.session.get(key))[key] as StoredStep | undefined;
}

async function putStep(id: number, row: StoredStep): Promise<void> {
  await chrome.storage.session.set({ [STEP_PREFIX + id]: row });
}

async function clearRecorded(): Promise<void> {
  const all = await chrome.storage.session.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(STEP_PREFIX));
  if (keys.length > 0) await chrome.storage.session.remove(keys);
}

/* ---------------------------------------------------------------- *
 * Session state (storage-backed, eviction-safe)
 * ---------------------------------------------------------------- */

async function getSession(): Promise<Session | null> {
  const data = await chrome.storage.session.get(KEY);
  return (data[KEY] as Session | undefined) ?? null;
}

async function setSession(session: Session | null): Promise<void> {
  if (session) await chrome.storage.session.set({ [KEY]: session });
  else await chrome.storage.session.remove(KEY);
}

/* ---------------------------------------------------------------- *
 * Frame registry — the map from "where the step happened" to "which frame to send
 * it to". Storage-backed like the session, because an MV3 worker can be evicted
 * between the frame's announcement and the step that targets it.
 * ---------------------------------------------------------------- */

async function getFrames(): Promise<FrameEntry[]> {
  const data = await chrome.storage.session.get(FRAMES_KEY);
  return (data[FRAMES_KEY] as FrameEntry[] | undefined) ?? [];
}

async function registerFrame(entry: FrameEntry): Promise<void> {
  const frames = await getFrames();
  const rest = frames.filter(
    (f) => !(f.tabId === entry.tabId && f.frameId === entry.frameId),
  );
  rest.push(entry);
  // Bounded: a page that churns frames must not grow this without limit.
  await chrome.storage.session.set({ [FRAMES_KEY]: rest.slice(-300) });
}

async function forgetTabFrames(tabId: number): Promise<void> {
  const frames = await getFrames();
  await chrome.storage.session.set({
    [FRAMES_KEY]: frames.filter((f) => f.tabId !== tabId),
  });
}

/**
 * Which frame should run this step.
 *
 * The iframe-element signature first, because it survives the frame reordering
 * (ad slots, lazy mounts) that invalidates indices; the native index path is the
 * fallback. Same precedence as the Playwright runner's frameFor() — the two
 * executors must pick the same frame or the flow means two different things.
 *
 * Never a broadcast: sending a step to every frame and taking the fastest reply is
 * how a step lands in the wrong document.
 */
async function resolveFrameId(
  tabId: number,
  chain: FrameLink[] | undefined,
): Promise<{ frameId: number; how: "index" | "signature" | "main" } | null> {
  if (!chain || chain.length === 0) return { frameId: 0, how: "main" };
  const frames = (await getFrames()).filter((f) => f.tabId === tabId);
  const bySig = frames.find((f) => f.signature === frameSignature(chain));
  if (bySig) return { frameId: bySig.frameId, how: "signature" };
  const byIndex = frames.find((f) => f.key === frameKey(chain));
  if (byIndex) return { frameId: byIndex.frameId, how: "index" };
  return null;
}

/* ---------------------------------------------------------------- *
 * Bridge ports (dashboard tabs) — live connections, re-established by the bridge
 * content script on every dashboard load, so eviction only drops them momentarily.
 * ---------------------------------------------------------------- */

const bridges = new Set<chrome.runtime.Port>();

function broadcast(message: AgentMessage): void {
  for (const port of bridges) {
    try {
      port.postMessage(message);
    } catch {
      bridges.delete(port);
    }
  }
}

async function snapshotOf(session: Session | null): Promise<AgentMessage> {
  // O(n), but only on connect and on the rare events that amend an existing step —
  // never once per recorded step, which is what used to make long flows crawl.
  const recorded = session ? await getRecorded() : { steps: [], meta: [] };
  return {
    source: "tf-agent",
    kind: "snapshot",
    recording: session?.mode === "record",
    steps: recorded.steps,
    meta: recorded.meta,
    env: session?.env,
    error: session?.storageError,
  };
}

async function broadcastSnapshot(session: Session): Promise<void> {
  broadcast(await snapshotOf(session));
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "tf-bridge") return;
  bridges.add(port);
  port.onDisconnect.addListener(() => bridges.delete(port));
  port.onMessage.addListener((message: HubMessage) => {
    void handleHub(message);
  });
  // A dashboard connecting mid-recording gets the full state — a dashboard reload
  // no longer loses the recording.
  void getSession().then(async (session) => port.postMessage(await snapshotOf(session)));
});

/* ---------------------------------------------------------------- *
 * Dashboard commands
 * ---------------------------------------------------------------- */

async function setTabMode(tabId: number, mode: TabMode): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: "cs-set-mode", mode });
  } catch {
    // Tab not ready yet — the content script will ask via cs-get-mode on load.
  }
}

async function startSession(
  mode: "record" | "replay",
  url: string,
): Promise<void> {
  const existing = await getSession();
  if (existing) await stopSession(); // one session at a time, by design

  const tab = await chrome.tabs.create({ url, active: true });
  await chrome.storage.session.remove(FRAMES_KEY);
  await clearRecorded(); // a new session starts from an empty recording
  if (mode === "replay") {
    // Replay only. Attaching during a RECORDING would add Chrome's debugging
    // infobar to the very viewport being measured, which is a fidelity bug.
    cdp.resetKeys();
    await cdp.attach(tab.id!);
  }
  await setSession({
    mode,
    tabIds: [tab.id!],
    targets: { [tab.id!]: ROOT_TARGET },
    targetUrls: { [ROOT_TARGET]: url },
    nextTarget: 1,
    stepCount: 0,
    lastStepId: 0,
    nextStepId: 1,
    startedAt: Date.now(),
    sourceUrl: url,
  });
}

async function stopSession(): Promise<void> {
  const session = await getSession();
  if (!session) return;
  await cdp.detachAll(); // release the debugger infobar the moment the run ends
  for (const tabId of session.tabIds) {
    cursorAt.delete(tabId);
    void setTabMode(tabId, "off");
    void chrome.action.setBadgeText({ tabId, text: "" });
  }
  await setSession(null);
  broadcast({ source: "tf-agent", kind: "stopped" });
}

/** How long a step will wait for the popup it is meant to run in. */
const TARGET_WAIT_MS = 5000;

/**
 * The tab currently bound to a logical target, waiting for it to appear.
 *
 * Reads the session fresh each poll, because the tab it is waiting for is bound by
 * the tabs.onCreated handler — a different task on the same queue.
 */
async function findTarget(
  wantTarget: TargetId,
  timeoutMs: number,
): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const session = await getSession();
    const tabId = Object.keys(session?.targets ?? {})
      .map(Number)
      .find((id) => session!.targets[id] === wantTarget);
    if (tabId !== undefined) return tabId;
    if (Date.now() >= deadline) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Steps that are physical input, and therefore worth dispatching for real. */
function isInputStep(step: FlowStep): boolean {
  return (
    step.type === "click" ||
    step.type === "doubleClick" ||
    step.type === "drag" ||
    step.type === "wheel" ||
    step.type === "keyDown" ||
    step.type === "keyUp"
  );
}

/**
 * Drives the visible replay cursor in a tab's top frame.
 *
 * Never fatal: a missing cursor is cosmetic, and a run must not fail because an
 * animation could not be delivered.
 */
/**
 * Where each tab's cursor was last put.
 *
 * A navigation destroys the page and the cursor with it, and the content script's
 * own memory of the position goes too — it is a new document. Holding it out here is
 * what lets the cursor come back where it was instead of flying in from the corner
 * on every page load.
 */
const cursorAt = new Map<number, { x: number; y: number }>();

async function cursor(
  tabId: number,
  action: "install" | "place" | "move" | "pulse" | "hide",
  point?: { x: number; y: number },
): Promise<void> {
  if (point && action !== "pulse") cursorAt.set(tabId, point);
  if (action === "hide") cursorAt.delete(tabId);
  try {
    await chrome.tabs.sendMessage(
      tabId,
      { type: "cs-cursor", action, x: point?.x, y: point?.y },
      { frameId: 0 },
    );
  } catch {
    /* no content script yet, or the page is mid-navigation */
  }
}

/**
 * Puts the cursor back after a page load, so it survives navigation visibly.
 *
 * With nowhere to return to — the first page of a run — it starts at the middle of
 * the viewport, which is where a real pointer plausibly is and reads far better than
 * appearing out of a corner.
 */
async function restoreCursor(
  tabId: number,
  viewport: { width: number; height: number },
): Promise<void> {
  const point =
    cursorAt.get(tabId) ??
    { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) };
  await cursor(tabId, "place", point);
}

/** Where a step's cursor should go, without performing any of the step's effects. */
async function pointFor(
  tabId: number,
  step: FlowStep,
  meta: StepMeta | undefined,
): Promise<{ x: number; y: number } | null> {
  if (!step.selectors?.length) return null;
  const frame = await resolveFrameId(tabId, meta?.frameChain);
  if (!frame) return null;
  try {
    const located = (await chrome.tabs.sendMessage(
      tabId,
      { type: "cs-locate", step, meta, pointOnly: true },
      { frameId: frame.frameId },
    )) as LocateResult | undefined;
    return located?.ok ? { x: located.x, y: located.y } : null;
  } catch {
    return null;
  }
}

/** Polls an expression over the debugger until it holds, or the budget runs out. */
async function runExpressionStep(
  tabId: number,
  step: FlowStep,
): Promise<{ ok: boolean; error?: string }> {
  const expression = step.expression ?? "true";
  const budget = Math.min(Math.max(step.timeout ?? 5000, 500), 30000);
  const deadline = Date.now() + budget;
  for (;;) {
    try {
      if (await cdp.evaluate(tabId, expression)) return { ok: true };
    } catch (err) {
      // The tab navigated out from under the evaluation, or the session dropped.
      if (Date.now() >= deadline) {
        return { ok: false, error: err instanceof Error ? err.message : "evaluation failed" };
      }
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        error: `expression never became true within ${budget}ms: ${expression}`,
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

const CDP_BUTTON: Record<string, "left" | "right" | "middle"> = {
  primary: "left",
  secondary: "right",
  auxiliary: "middle",
};

/**
 * Two phases: the frame resolves the element and reports where to aim (in top-frame
 * coordinates), then Chrome's Input domain delivers the event. Nothing the page can
 * observe distinguishes it from a human.
 */
async function runInputStep(
  tabId: number,
  step: FlowStep,
  meta: StepMeta | undefined,
  showCursor: boolean,
): Promise<{ ok: boolean; error?: string; note?: string }> {
  try {
    // Keyboard needs no target: it goes to whatever has focus, as on a real keyboard.
    if (step.type === "keyDown" || step.type === "keyUp") {
      await cdp.key(tabId, step.type === "keyDown", step.key ?? "Enter");
      return { ok: true };
    }

    const frame = await resolveFrameId(tabId, meta?.frameChain);
    if (!frame) {
      return {
        ok: false,
        error: `frame ${frameSignature(meta?.frameChain)} never loaded in this tab`,
      };
    }
    const located = (await chrome.tabs.sendMessage(
      tabId,
      { type: "cs-locate", step, meta },
      { frameId: frame.frameId },
    )) as LocateResult | undefined;
    if (!located?.ok) {
      return { ok: false, error: located?.error ?? "tab did not respond" };
    }

    // The glide happens BEFORE the input, and is awaited: the point of a visible
    // cursor is that you see it arrive at the thing it is about to click.
    if (showCursor) await cursor(tabId, "move", located);

    switch (step.type) {
      case "click":
      case "doubleClick":
        if (showCursor) void cursor(tabId, "pulse");
        await cdp.click(
          tabId,
          located.x,
          located.y,
          CDP_BUTTON[step.button ?? "primary"] ?? "left",
          step.type === "doubleClick" ? 2 : 1,
        );
        return { ok: true };
      case "drag": {
        const path = located.path ?? [];
        if (showCursor) {
          // Retrace the drag with the cursor as the mouse moves, so the gesture is
          // legible rather than a jump from start to end.
          void (async () => {
            const gap = Math.min(Math.max((step.duration ?? 300) / (path.length || 1), 5), 40);
            for (const point of path) {
              await cursor(tabId, "move", {
                x: located.x + point.x,
                y: located.y + point.y,
              });
              await new Promise((resolve) => setTimeout(resolve, gap));
            }
          })();
        }
        await cdp.drag(tabId, located, path, step.duration ?? 300);
        return { ok: true };
      }
      case "wheel":
        await cdp.wheel(tabId, located.x, located.y, step.deltaX ?? 0, step.deltaY ?? 0);
        return { ok: true };
      default:
        return { ok: false, error: `not an input step: ${step.type}` };
    }
  } catch (err) {
    // The step navigated the page away mid-dispatch, or the session dropped.
    return { ok: false, error: err instanceof Error ? err.message : "input failed" };
  }
}

async function handleHub(message: HubMessage): Promise<void> {
  switch (message.kind) {
    case "ping":
      broadcast({ source: "tf-agent", kind: "bridge-ready" });
      return;
    // Session lifecycle goes on the queue: starting a session while the previous
    // one's last page event is still in flight would let that event write the old
    // session back over the new one. runStep deliberately does NOT — it waits for a
    // tab that a queued task binds, and queueing it would deadlock on itself.
    case "openAndRecord":
      await enqueue(() => startSession("record", message.url));
      return;
    case "openForReplay":
      await enqueue(() => startSession("replay", message.url));
      return;
    case "stop":
      await enqueue(() => stopSession());
      return;
    case "closeReplay":
      await enqueue(async () => {
        const session = await getSession();
        if (session?.mode !== "replay") return;
        await cdp.detachAll();
        for (const tabId of session.tabIds) {
          void chrome.tabs.remove(tabId).catch(() => {});
        }
        await setSession(null);
      });
      return;
    case "runStep": {
      const session = await getSession();
      if (session?.mode !== "replay") {
        broadcast({
          source: "tf-agent",
          kind: "stepResult",
          id: message.id,
          ok: false,
          error: "no replay tab — Run opens one first",
        });
        return;
      }
      // Logical target -> the tab currently bound to it. Popups bind in the order
      // the flow opened them, so "t1" is the same window it was during recording.
      const wantTarget = message.meta?.targetId ?? ROOT_TARGET;
      // The step that opens a popup finishes before the browser has created it, so
      // the very next step naturally arrives too early. Wait for it rather than
      // reporting a missing target that is about to exist.
      const tabId = await findTarget(wantTarget, TARGET_WAIT_MS);
      if (tabId === undefined) {
        broadcast({
          source: "tf-agent",
          kind: "stepResult",
          id: message.id,
          ok: false,
          error: `target ${wantTarget} is not open — the step that opens it may have failed`,
        });
        return;
      }
      // Real input where possible. Everything else (fill, scroll, waits) stays in
      // the content script, exactly as Playwright splits it.
      const showCursor = message.cursor !== false;

      if (cdp.isAttached(tabId) && isInputStep(message.step)) {
        const result = await runInputStep(tabId, message.step, message.meta, showCursor);
        broadcast({ source: "tf-agent", kind: "stepResult", id: message.id, ...result });
        return;
      }

      // Expressions go over the debugger too, because a page's CSP forbids the page
      // from evaluating a string — and virtually every real site ships one. Only for
      // the main frame: a subframe expression needs a context the content script has
      // and this does not.
      if (
        cdp.isAttached(tabId) &&
        message.step.type === "waitForExpression" &&
        !message.meta?.frameChain?.length
      ) {
        const result = await runExpressionStep(tabId, message.step);
        broadcast({ source: "tf-agent", kind: "stepResult", id: message.id, ...result });
        return;
      }

      const frame = await resolveFrameId(tabId, message.meta?.frameChain);
      if (!frame) {
        broadcast({
          source: "tf-agent",
          kind: "stepResult",
          id: message.id,
          ok: false,
          error: `frame ${frameSignature(message.meta?.frameChain)} never loaded in this tab`,
        });
        return;
      }
      // A step that SHOULD have been real input but could not be. Never silent: the
      // run proves less than it appears to, and that is the user's call to make.
      const note = isInputStep(message.step)
        ? "synthetic events — real input was unavailable (DevTools open, or another debugger attached). Pages that check isTrusted, :focus-visible or native scrolling may behave differently."
        : undefined;

      // Steps the content script runs itself (fill, and the synthetic-input
      // fallback) still get a cursor — resolved without side effects, since the
      // step is about to resolve the same element and perform them properly.
      if (showCursor && message.step.selectors?.length) {
        const point = await pointFor(tabId, message.step, message.meta);
        if (point) {
          await cursor(tabId, "move", point);
          if (isInputStep(message.step)) void cursor(tabId, "pulse");
        }
      }

      try {
        const result = (await chrome.tabs.sendMessage(
          tabId,
          {
            type: "cs-run",
            id: message.id,
            step: message.step,
            meta: message.meta,
          },
          { frameId: frame.frameId },
        )) as { ok: boolean; error?: string } | undefined;
        broadcast({
          source: "tf-agent",
          kind: "stepResult",
          id: message.id,
          ok: result?.ok ?? false,
          error: result?.error,
          note,
        });
      } catch (err) {
        // The step navigated the page — the receiving document died before replying.
        // The fresh page's cs-ready becomes the signal; report a soft failure the
        // player already knows how to interpret.
        broadcast({
          source: "tf-agent",
          kind: "stepResult",
          id: message.id,
          ok: false,
          error: err instanceof Error ? err.message : "tab did not respond",
        });
      }
      return;
    }
  }
}

/* ---------------------------------------------------------------- *
 * Content-script events
 * ---------------------------------------------------------------- */

// Handlers are serialized: two rapid cs-step messages would otherwise both read the
// same stored session, each push one step, and the second write would erase the first.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Runs work against the session one at a time.
 *
 * EVERYTHING that touches the session goes through here — messages, tab events,
 * download events. They all do read-modify-write on one storage key, so two
 * overlapping handlers means the second one writes a session it read before the
 * first one's change, and that change is simply gone. A popup joining the session
 * at the same moment its first page announces itself is exactly that collision.
 */
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => undefined);
  return next;
}

chrome.runtime.onMessage.addListener(
  (message: CsToSw, sender, sendResponse: (r: unknown) => void) => {
    void enqueue(() => handleCs(message, sender)).then(sendResponse, () =>
      sendResponse({ ok: false }),
    );
    return true; // always responds async
  },
);

/**
 * Appends a step and its sidecar together — they are indexed in lockstep, so there
 * is exactly one place that may push to either.
 *
 * The native DevTools fields are derived here, from one source of truth: `target`
 * ("main" or the popup's URL) and `frame` (the index path) both come out of the
 * meta the frame reported.
 */
async function pushStep(
  session: Session,
  step: FlowStep,
  meta: StepMeta,
): Promise<FlowStep> {
  const path = meta.frameChain.map((link) => link.index);
  // The step and its sidecar are stamped with the same id here, in the one place
  // allowed to append to either. Everything downstream can then check the pairing
  // instead of trusting that no array was ever filtered or sorted.
  const id = session.nextStepId++;
  session.stepCount++;
  session.lastStepId = id;
  const stored: FlowStep = {
    ...step,
    id,
    target:
      meta.targetId === ROOT_TARGET
        ? "main"
        : (session.targetUrls[meta.targetId] ?? meta.targetId),
    ...(path.length > 0 ? { frame: path } : {}),
    timestamp: Date.now(),
  };
  // One key, one small write — the cost of recording a step does not depend on how
  // many steps came before it.
  //
  // A failure here (storage full, most likely) means this step does not exist. It is
  // recorded on the session so the dashboard can say so BEFORE the user saves a flow
  // that looks complete and is not.
  try {
    await putStep(id, { step: stored, meta: { ...meta, stepId: id } });
  } catch (err) {
    session.stepCount--;
    session.storageError =
      `A step could not be stored, so this recording is incomplete: ` +
      `${err instanceof Error ? err.message : "storage write failed"}. ` +
      `Stop and save what you have, or start again.`;
    throw err;
  }
  return stored;
}

async function handleCs(
  message: CsToSw,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  const session = await getSession();
  const tabId = sender.tab?.id;
  const frameId = sender.frameId ?? 0;

      if (message.type === "cs-get-mode") {
        const mode: TabMode =
          session &&
          session.mode !== "stopped" &&
          tabId !== undefined &&
          session.tabIds.includes(tabId)
            ? session.mode
            : "off";
        return { mode };
      }

      if (
        tabId === undefined ||
        !session ||
        session.mode === "stopped" ||
        !session.tabIds.includes(tabId)
      ) {
        return { ok: false };
      }

      const targetId = session.targets[tabId] ?? ROOT_TARGET;

      if (message.type === "cs-ready") {
        // Every frame registers itself — this is what makes replay addressable
        // per-frame instead of a broadcast race.
        await registerFrame({
          tabId,
          frameId,
          key: frameKey(message.frameChain),
          signature: frameSignature(message.frameChain),
        });
        // Make sure the (possibly re-injected) content script knows its mode.
        void setTabMode(tabId, session.mode);

        const isTopFrame = frameId === 0;
        if (isTopFrame && !session.targetUrls[targetId]) {
          session.targetUrls[targetId] = message.url;
        }
        // First environment record wins: it describes the session's starting
        // conditions, which is what replay has to reproduce.
        if (message.env && !session.env) session.env = message.env;

        if (session.mode === "record" && isTopFrame) {
          const meta: StepMeta = { targetId, frameChain: [], tMono: message.tMono };
          if (session.stepCount === 0) {
            // Seed the flow exactly the way DevTools does.
            await pushStep(
              session,
              {
                type: "setViewport",
                width: message.width,
                height: message.height,
                deviceScaleFactor: message.dpr,
                isMobile: message.env?.isMobile ?? false,
                hasTouch: message.env?.hasTouch ?? false,
                isLandscape: message.width > message.height,
              },
              meta,
            );
            await pushStep(
              session,
              {
                type: "navigate",
                url: message.url,
                assertedEvents: [
                  { type: "navigation", url: message.url, title: message.title },
                ],
              },
              meta,
            );
          } else {
            // A later load = navigation caused by the last interaction. Read and
            // rewrite that ONE step rather than the whole recording.
            const row = await getStep(session.lastStepId);
            const last = row?.step;
            if (
              last &&
              (last.type === "click" ||
                last.type === "doubleClick" ||
                last.type === "keyDown") &&
              !last.assertedEvents
            ) {
              last.assertedEvents = [
                { type: "navigation", url: message.url, title: message.title },
              ];
              await putStep(session.lastStepId, row!);
            }
          }
          await setSession(session);
          await broadcastSnapshot(session);
          void chrome.action.setBadgeText({
            tabId,
            text: String(session.stepCount),
          });
        } else {
          await setSession(session);
        }

        // A fresh document has no cursor — put it back where the run left it.
        if (session.mode === "replay" && isTopFrame) {
          void restoreCursor(tabId, { width: message.width, height: message.height });
        }

        // Both modes: tell the dashboard a page finished loading.
        broadcast({
          source: "tf-agent",
          kind: "ready",
          url: message.url,
          title: message.title,
          width: message.width,
          height: message.height,
          dpr: message.dpr,
          targetId,
        });
        return { ok: true };
      }

      if (message.type === "cs-settled") {
        broadcast({ source: "tf-agent", kind: "settled", url: message.url });
        return { ok: true };
      }

      if (message.type === "cs-step" && session.mode === "record") {
        const meta: StepMeta = { ...message.meta, targetId };
        let stored: FlowStep;
        try {
          stored = await pushStep(session, message.step, meta);
        } catch {
          await setSession(session); // keeps storageError
          await broadcastSnapshot(session);
          return { ok: false };
        }
        await setSession(session);
        void chrome.action.setBadgeText({
          tabId,
          text: String(session.stepCount),
        });
        broadcast({
          source: "tf-agent",
          kind: "step",
          step: stored,
          meta: { ...meta, stepId: stored.id },
        });
        return { ok: true };
      }

      if (message.type === "cs-dialog" && session.mode === "record") {
        // Interactions are captured on the capture phase, so the step that opened
        // the dialog is already the last one recorded.
        const row = session.stepCount > 0 ? await getStep(session.lastStepId) : undefined;
        if (row && !row.meta.dialog) {
          row.meta.dialog = message.dialog;
          await putStep(session.lastStepId, row);
          await broadcastSnapshot(session);
        }
        return { ok: true };
      }

      if (message.type === "cs-route" && session.mode === "record") {
        // An SPA route change is a navigation with no page load. Recorded as a
        // NATIVE waitForExpression so the flow model stays pure DevTools and both
        // replay engines already know how to execute it — no new step type, no
        // sleep, no guessing.
        if (session.stepCount === 0) return { ok: true }; // pre-first-step redirect
        const lastRow = await getStep(session.lastStepId);
        const last = lastRow?.step;
        if (!last) return { ok: true };
        if (
          (last.type === "click" ||
            last.type === "doubleClick" ||
            last.type === "keyDown" ||
            last.type === "change") &&
          !last.assertedEvents
        ) {
          last.assertedEvents = [
            { type: "navigation", url: message.url, title: message.title },
          ];
          await putStep(session.lastStepId, lastRow!);
        }
        // Query strings carry session tokens and cache-busters that differ every
        // run; pathname + hash is the part of the route that is actually asserted.
        const route = new URL(message.url);
        const expression = `location.pathname + location.hash === ${JSON.stringify(
          route.pathname + route.hash,
        )}`;
        if (last.type !== "waitForExpression" || last.expression !== expression) {
          await pushStep(
            session,
            { type: "waitForExpression", expression },
            { targetId, frameChain: [], tMono: message.tMono },
          );
        }
        await setSession(session);
        await broadcastSnapshot(session);
        void chrome.action.setBadgeText({
          tabId,
          text: String(session.stepCount),
        });
        return { ok: true };
      }

      return { ok: false };
}

/* ---------------------------------------------------------------- *
 * Multi-tab: a popup opened from a session tab joins the session — the thing the
 * v2 opener-based design fundamentally could not do.
 * ---------------------------------------------------------------- */

chrome.tabs.onCreated.addListener((tab) => {
  void enqueue(async () => {
    const session = await getSession();
    if (!session || tab.id === undefined) return;
    if (tab.openerTabId === undefined || !session.tabIds.includes(tab.openerTabId)) return;

    session.tabIds.push(tab.id);
    // Popups are numbered in the order the flow opens them — the same order
    // during recording and replay, which is what re-binds "t1" to the right
    // window without depending on tab ids that change every run.
    session.targets[tab.id] = `t${session.nextTarget++}`;
    await setSession(session);

    if (session.mode === "replay") {
      // EVERY tab in a replay gets real input, not just the first one.
      //
      // A synthetic click carries no user activation, and Chrome's popup blocker
      // refuses target="_blank" and window.open() without it — so a popup driven
      // by synthetic events silently never opens, while same-tab navigation from
      // the identical click works fine. That asymmetry is the whole bug.
      await cdp.attach(tab.id);
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueue(async () => {
    void forgetTabFrames(tabId);
    void cdp.detach(tabId);
    const session = await getSession();
    if (!session || !session.tabIds.includes(tabId)) return;
    session.tabIds = session.tabIds.filter((id) => id !== tabId);
    delete session.targets[tabId];
    if (session.tabIds.length === 0) {
      // Last session tab closed = the user is done. Recording stays in storage
      // until saved or a new session starts? No — closing every tab ends it.
      await setSession(null);
      broadcast({ source: "tf-agent", kind: "stopped" });
    } else {
      await setSession(session);
    }
  });
});

/* ---------------------------------------------------------------- *
 * Downloads.
 *
 * A click that produces a file leaves no trace in the DOM, so the step alone cannot
 * express what it did — and a replay where the download silently fails still passes
 * every assertion. Recorded against the step that caused it, exactly like dialogs.
 * ---------------------------------------------------------------- */

chrome.downloads.onCreated.addListener((item) => {
  void enqueue(async () => {
    const session = await getSession();
    if (session?.mode !== "record") return;
    // A link with a `download` attribute already recorded the exact name from the
    // page itself; this listener exists for the JS-initiated case it cannot see.
    if (session.stepCount === 0) return;
    const row = await getStep(session.lastStepId);
    if (!row || row.meta.download) return;

    // item.filename is a full path once Chrome has decided one; the URL is only a
    // usable fallback when it actually has a path (a data: URI does not).
    let name = item.filename ? item.filename.split(/[\\/]/).pop() : "";
    if (!name) {
      try {
        name = new URL(item.url).pathname.split("/").pop() ?? "";
      } catch {
        name = "";
      }
    }
    if (!name) return; // no honest name to record — better absent than invented

    row.meta.download = { filename: name };
    await putStep(session.lastStepId, row);
    await broadcastSnapshot(session);
  });
});

chrome.action.setBadgeBackgroundColor({ color: "#dc2626" });
