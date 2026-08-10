/**
 * The Playwright runner — an INTERPRETER over the recorded flow, not generated code.
 *
 * Generated code is an export artifact: readable, editable, and necessarily a second
 * implementation of replay semantics. This is the first one. It reads the same flow
 * the browser replayer reads, resolves elements with the same shared resolver, and
 * drives real CDP input through page.mouse/page.keyboard so the page sees trusted
 * events with real hover and focus — the closest match to what the recorder saw.
 *
 * Determinism rules it follows, without exception:
 *   - no selector guessing (consensus resolution, or a named failure)
 *   - no blind sleeps (every wait is tied to page state; pacing is recorded gaps)
 *   - no action outside the recorded (target, frame)
 */

import { chromium, type Browser, type BrowserContext, type Frame, type Page } from "playwright";
import {
  alignmentProblems,
  DEFAULT_TIMEOUT_MS,
  metaResolver,
  ROOT_TARGET,
  type FlowJson,
  type FlowStep,
  type StepMeta,
} from "../types/flow";
import { installDeterminism } from "./determinism";
import { pageExpr } from "../shared/resolve";
import { isRouteExpression } from "../shared/expressions";
import { contextOptionsFrom, launchOptionsFrom, pinClock, verifyEnv } from "./env";
import { frameFor, resolveHandle, restoreScroll, type FrameHow } from "./locate";
import {
  CAUSE,
  MAX_RECORDED_PAUSE_MS,
  type CauseCode,
  type RunOptions,
  type RunReport,
  type StepResult,
} from "./types";

type Ctx = {
  context: BrowserContext;
  /** logical target -> the page currently bound to it */
  targets: Map<string, Page>;
  flow: FlowJson;
  opts: Required<Pick<RunOptions, "speed" | "timeout" | "clock">>;
  /** secrets by name, from RunOptions plus TESTFLOW_SECRET_* in the environment */
  secrets: Record<string, string>;
};

/**
 * Secrets never live in a flow. They come from the runner's options or the process
 * environment, so a recording can be committed and shared without leaking anything.
 */
function collectSecrets(explicit: Record<string, string> | undefined): Record<string, string> {
  const secrets: Record<string, string> = { ...explicit };
  const PREFIX = "TESTFLOW_SECRET_";
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(PREFIX) && value !== undefined) {
      secrets[key.slice(PREFIX.length)] = value;
    }
  }
  return secrets;
}

const EMPTY_META: StepMeta = { targetId: ROOT_TARGET, frameChain: [], tMono: 0 };

/** Native per-step budget, clamped exactly like @puppeteer/replay. */
const budgetOf = (step: FlowStep, fallback: number): number =>
  Math.min(Math.max(step.timeout ?? fallback, 500), 30_000);

class StepFailure extends Error {
  constructor(
    readonly code: CauseCode,
    message: string,
  ) {
    super(message);
  }
}

/* ------------------------------------------------------------------ *
 * Targets — logical tabs, re-bound to real pages in the order the flow opens them.
 * ------------------------------------------------------------------ */

/** The order popups appear in the recording; "t0" is the starting tab. */
function recordedTargetOrder(flow: FlowJson): string[] {
  const seen: string[] = [ROOT_TARGET];
  for (const meta of flow.meta ?? []) {
    if (!seen.includes(meta.targetId)) seen.push(meta.targetId);
  }
  return seen;
}

/**
 * Waits for the window a step belongs to.
 *
 * Binding happens as popups OPEN (see the context "page" handler), in the order the
 * recording opened them — not when a step first asks for one. Asking-order binding
 * looks equivalent and is not: a flow that opens two popups and then acts on the
 * second one first would attach that step to the first window.
 */
async function pageFor(ctx: Ctx, targetId: string, timeoutMs: number): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const bound = ctx.targets.get(targetId);
    if (bound && !bound.isClosed()) return bound;
    if (Date.now() >= deadline) break;
    // The step that opens a popup finishes before the browser has created it.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new StepFailure(
    CAUSE.TARGET_MISSING,
    `target ${targetId} never opened — the step that opens it may have failed`,
  );
}

/* ------------------------------------------------------------------ *
 * Step execution
 * ------------------------------------------------------------------ */

/**
 * The recorded click point, in viewport coordinates.
 *
 * boundingBox() is relative to the MAIN frame's viewport even for elements inside
 * iframes, which is exactly what page.mouse needs — so an iframe click lands at the
 * same physical point it did during recording.
 */
/**
 * Is the target actually the thing at that pixel?
 *
 * Real input goes wherever the pixel points, so a sticky header, cookie bar or chat
 * widget over the target absorbs the click — and the step "succeeds" having done
 * nothing. That is the worst failure this system can have: a green step that did not
 * happen, with the consequence surfacing somewhere else entirely, or never.
 *
 * `locator.click()` checks this; raw mouse input does not, so it is done here.
 * Runs in the element's OWN frame, in that frame's coordinates.
 */
async function hitTest(
  handle: import("playwright").ElementHandle<Element>,
  step: FlowStep,
): Promise<{ ok: boolean; blocker?: string }> {
  // NO nested function declarations in here. A function handed to evaluate() is
  // serialized by source, and the compiler wraps nested declarations in a `__name`
  // helper that does not exist in the page — see pageExpr() for the same trap.
  return (await handle.evaluate((el, offsets) => {
    const rect = el.getBoundingClientRect();
    const ox = offsets.x;
    const oy = offsets.y;
    const x =
      rect.left + (typeof ox === "number" && ox >= 0 && ox <= rect.width ? ox : rect.width / 2);
    const y =
      rect.top + (typeof oy === "number" && oy >= 0 && oy <= rect.height ? oy : rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit) return { ok: false, blocker: "nothing (the point is outside the viewport)" };
    // A hit on a child still reaches the target by bubbling, and a hit on an
    // ancestor means the target is not painted there — both count as "the same
    // element" for the purposes of a click, matching how the resolver treats nesting.
    if (hit === el || el.contains(hit) || hit.contains(el)) return { ok: true };
    const id = hit.id ? `#${hit.id}` : "";
    const cls = hit.classList.length ? `.${Array.from(hit.classList)[0]}` : "";
    return { ok: false, blocker: `${hit.tagName.toLowerCase()}${id}${cls}` };
  }, { x: step.offsetX, y: step.offsetY })) as { ok: boolean; blocker?: string };
}

async function pointOf(
  handle: import("playwright").ElementHandle<Element>,
  step: FlowStep,
  page: Page,
  notes: string[],
): Promise<{ x: number; y: number }> {
  let box = await handle.boundingBox();
  const viewport = page.viewportSize();
  const offscreen =
    !box ||
    box.y + box.height < 0 ||
    (viewport ? box.y > viewport.height : false) ||
    box.x + box.width < 0 ||
    (viewport ? box.x > viewport.width : false);
  if (offscreen) {
    // The recorded scroll state should have placed it in view; that it did not is
    // worth reporting, because the pixels around it will differ.
    await handle.scrollIntoViewIfNeeded().catch(() => {});
    notes.push("element was outside the recorded viewport and had to be scrolled to");
    box = await handle.boundingBox();
  }
  if (!box) throw new StepFailure(CAUSE.NO_MATCH, "element has no layout box");

  // Occlusion, checked before the input is sent. One retry after scrolling, because
  // a sticky header often stops covering the target once it is centred — that is
  // what locator.click() does, and it resolves most real cases.
  let hit = await hitTest(handle, step);
  if (!hit.ok) {
    await handle.scrollIntoViewIfNeeded().catch(() => {});
    box = (await handle.boundingBox()) ?? box;
    hit = await hitTest(handle, step);
  }
  if (!hit.ok) {
    throw new StepFailure(
      CAUSE.OCCLUDED,
      `${hit.blocker} is on top of the target, so the input would land on that instead`,
    );
  }

  // The recorded offset, or the element's centre when it no longer fits — the same
  // rule the in-browser replayer applies, so both land on the same pixel.
  const withinBox = (value: number | undefined, size: number): number =>
    typeof value === "number" && value >= 0 && value <= size ? value : size / 2;
  return {
    x: box.x + withinBox(step.offsetX, box.width),
    y: box.y + withinBox(step.offsetY, box.height),
  };
}

/**
 * "No selector matched" has one cause that no amount of better selectors can fix.
 *
 * A CLOSED shadow root is invisible to everything outside it — the recorder could
 * not describe what is in there, and no engine can reach in. Custom elements whose
 * `shadowRoot` reads null while they clearly render something are the signature.
 * Reported as a hint, because it turns an hour of selector debugging into a fact.
 */
async function closedShadowHint(frame: Frame): Promise<string> {
  try {
    const count = (await frame.evaluate(`(() => {
      let n = 0;
      for (const el of document.querySelectorAll("*")) {
        if (el.tagName.includes("-") && !el.shadowRoot && el.childElementCount === 0
            && el.getBoundingClientRect().height > 0) n++;
      }
      return n;
    })()`)) as number;
    return count > 0
      ? ` — note: ${count} custom element(s) here appear to use a CLOSED shadow root, whose contents no selector can reach`
      : "";
  } catch {
    return "";
  }
}

const BUTTON: Record<string, "left" | "right" | "middle"> = {
  primary: "left",
  secondary: "right",
  auxiliary: "middle",
};

async function execStep(
  ctx: Ctx,
  step: FlowStep,
  meta: StepMeta,
  page: Page,
  frame: Frame,
  notes: string[],
): Promise<void> {
  const timeout = budgetOf(step, ctx.opts.timeout);

  const need = async (): Promise<import("playwright").ElementHandle<Element>> => {
    const handle = await resolveHandle(frame, step.selectors, timeout);
    if (!handle) {
      throw new StepFailure(
        CAUSE.NO_MATCH,
        `no selector group resolved: ${(step.selectors ?? []).map((g) => g[0]).join(" | ")}` +
          (await closedShadowHint(frame)),
      );
    }
    return handle;
  };

  switch (step.type) {
    case "setViewport":
      // The context already carries the recorded viewport; a mid-flow resize would
      // contradict the environment record. Divergence is reported, not applied.
      if (step.width && page.viewportSize()?.width !== step.width) {
        notes.push(
          `step viewport ${step.width}x${step.height} differs from the session viewport`,
        );
      }
      return;

    case "navigate": {
      await page.goto(step.url ?? "", { waitUntil: "load", timeout });
      return;
    }

    case "click":
    case "doubleClick": {
      const handle = await need();
      const point = await pointOf(handle, step, page, notes);
      const button = BUTTON[step.button ?? "primary"] ?? "left";
      // Real input, not element.click(): hover states, :focus-visible and native
      // scrolling only happen for trusted events, and the recording captured those.
      await page.mouse.move(point.x, point.y);
      await page.mouse.click(point.x, point.y, {
        button,
        clickCount: step.type === "doubleClick" ? 2 : 1,
      });
      await handle.dispose();
      return;
    }

    case "change": {
      const handle = await need();
      if (meta.upload) {
        if (meta.upload.truncated) {
          throw new StepFailure(
            CAUSE.DEGRADED,
            `upload "${meta.upload.files.map((f) => f.name).join(", ")}" exceeded the capture cap, so its bytes were never recorded`,
          );
        }
        await handle.setInputFiles(
          meta.upload.files.map((file) => ({
            name: file.name,
            mimeType: file.mimeType || "application/octet-stream",
            buffer: Buffer.from(file.base64, "base64"),
          })),
        );
      } else if (meta.secretRef) {
        // The recorder never captured this value. Supply it by name or fail saying
        // which one — typing "" here would "pass" and log in as nobody.
        const secret = ctx.secrets[meta.secretRef];
        if (secret === undefined) {
          throw new StepFailure(
            CAUSE.SECRET_MISSING,
            `this step needs the secret "${meta.secretRef}" — pass it in RunOptions.secrets or set TESTFLOW_SECRET_${meta.secretRef}`,
          );
        }
        await handle.fill(secret);
      } else if (step.tagName === "select") {
        await handle.selectOption(step.value ?? "");
      } else {
        await handle.fill(step.value ?? "");
      }
      await handle.dispose();
      return;
    }

    case "keyDown":
      await page.keyboard.down(step.key ?? "Enter");
      return;
    case "keyUp":
      await page.keyboard.up(step.key ?? "Enter");
      return;

    case "scroll": {
      if (step.selectors?.length) {
        const handle = await need();
        await handle.evaluate((el, pos) => el.scrollTo(pos.x, pos.y), {
          x: step.x ?? 0,
          y: step.y ?? 0,
        });
        await handle.dispose();
      } else {
        await frame.evaluate(
          ([x, y]) => window.scrollTo(x, y),
          [step.x ?? 0, step.y ?? 0] as const,
        );
      }
      return;
    }

    case "wheel": {
      const handle = await need();
      const point = await pointOf(handle, step, page, notes);
      await page.mouse.move(point.x, point.y);
      // Chunked at ±120 exactly like the in-browser replayer: map libraries clamp a
      // single huge delta to one zoom notch, so one big event under-zooms.
      const total = { x: step.deltaX ?? 0, y: step.deltaY ?? 0 };
      const chunks = Math.max(
        1,
        Math.ceil(Math.max(Math.abs(total.x), Math.abs(total.y)) / 120),
      );
      for (let i = 0; i < chunks; i++) {
        await page.mouse.wheel(total.x / chunks, total.y / chunks);
        await page.waitForTimeout(40);
      }
      await handle.dispose();
      return;
    }

    case "drag": {
      const handle = await need();
      const start = await pointOf(handle, step, page, notes);
      const path = step.path?.length ? step.path : [{ x: 0, y: 0 }];
      const gap = Math.min(Math.max((step.duration ?? 300) / path.length, 5), 40);
      if (meta.nativeDrag) {
        // Chrome starts its drag machinery from REAL mouse input, which is exactly
        // what page.mouse produces — the same retrace therefore performs a genuine
        // HTML5 drag, dataTransfer and all. Extra intermediate moves because the
        // drag threshold and dragover cadence both need them.
        notes.push(
          `native HTML5 drag (${meta.nativeDrag.types.join(", ") || "no data types"})`,
        );
      }
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      for (const point of path) {
        await page.mouse.move(start.x + point.x, start.y + point.y, {
          steps: meta.nativeDrag ? 8 : 3,
        });
        await page.waitForTimeout(gap);
      }
      await page.mouse.up();
      await handle.dispose();
      return;
    }

    case "waitForElement": {
      const handle = await resolveHandle(frame, step.selectors, timeout);
      if (!handle) throw new StepFailure(CAUSE.NO_MATCH, "element never appeared");
      await handle.dispose();
      return;
    }

    case "waitForExpression": {
      // How SPA route changes replay — a state-tied wait, never a sleep.
      try {
        await frame.waitForFunction(step.expression ?? "true", undefined, { timeout });
      } catch {
        throw new StepFailure(
          CAUSE.EXPRESSION,
          `expression never became true within ${timeout}ms: ${step.expression}`,
        );
      }
      return;
    }
  }
}

/* ------------------------------------------------------------------ *
 * The run
 * ------------------------------------------------------------------ */

export async function runFlow(flow: FlowJson, options: RunOptions = {}): Promise<RunReport> {
  const startedAt = Date.now();
  const opts = {
    speed: options.speed ?? "fast",
    timeout: options.timeout ?? flow.timeout ?? DEFAULT_TIMEOUT_MS,
    clock: options.clock ?? ("recorded" as const),
    routeWaits: options.routeWaits ?? true,
  };

  const browser: Browser =
    options.reuseBrowser ??
    (await chromium.launch(launchOptionsFrom(flow.env, options)));
  const ownsBrowser = !options.reuseBrowser;

  const sealed = options.har?.mode === "replay";
  const context = await browser.newContext({
    ...contextOptionsFrom(flow.env),
    // A HAR is written when the context closes, so recording one costs a live run
    // and nothing else. `content: "embed"` keeps the archive self-contained.
    ...(options.har?.mode === "record"
      ? { recordHar: { path: options.har.path, content: "embed" as const } }
      : {}),
  });

  // Same seed every run, so a flow that depends on Math.random is reproducible
  // rather than intermittently different for reasons nobody can see.
  //
  // Passed as SOURCE, not as a function: addInitScript serializes a function the
  // same way evaluate() does, and this one has nested declarations that the
  // compiler wraps in a `__name` helper the page has never heard of. As a function
  // it throws on every page load — silently, because init scripts are not awaited.
  await context.addInitScript({
    content: pageExpr(installDeterminism, {
      seed: options.seed ?? 0x5f3759df,
      instantScroll: true,
      // Default on in sealed mode only: pausing autoplay is right for a
      // reproducible run and wrong for a flow whose subject IS the video.
      pauseMedia: options.pauseMedia ?? sealed,
    }),
  });

  // Replay cannot click a native permission bubble, so whatever the recording
  // already held is granted up front instead of prompting mid-run.
  if (flow.env?.permissions?.length) {
    await context
      .grantPermissions(flow.env.permissions.filter((name) => name !== "clipboard-read"))
      .catch(() => {
        /* a name this browser does not know — the delta report covers it */
      });
  }

  const unmatched: string[] = [];
  // Reset per step, so a drifted request is attributed to the step that caused it
  // rather than to the run as a whole.
  let stepUnmatched: string[] = [];
  if (sealed) {
    // notFound: "abort" is the point of sealed mode. Falling through to the network
    // would quietly mix recorded and live content, and the run would no longer be a
    // function of the archive.
    await context.routeFromHAR(options.har!.path, { notFound: "abort" });
    context.on("requestfailed", (request) => {
      if (unmatched.length < 50) unmatched.push(request.url());
      if (stepUnmatched.length < 5) stepUnmatched.push(request.url());
    });
  }

  const page = await context.newPage();

  const ctx: Ctx = {
    context,
    targets: new Map([[ROOT_TARGET, page]]),
    flow,
    opts,
    secrets: collectSecrets(options.secrets),
  };

  // Bind popups to logical targets in the order they OPEN, matching the order the
  // recording opened them — the same rule the extension uses. Binding when a step
  // first asks instead would misattach a flow that opens two windows and then acts
  // on the second one first.
  const popupTargets = recordedTargetOrder(flow).slice(1); // t0 is the starting tab
  let openedCount = 0;
  context.on("page", (opened) => {
    const id = popupTargets[openedCount] ?? `t${openedCount + 1}`;
    openedCount++;
    ctx.targets.set(id, opened);
  });

  const results: StepResult[] = [];
  const report: RunReport = {
    ok: false,
    title: flow.title,
    mode: sealed ? "sealed" : "live",
    startedAt,
    durationMs: 0,
    env: { recorded: flow.env, deltas: [] },
    steps: results,
  };

  // Checked once, up front. A flow whose sidecars have drifted out of step still
  // runs, but every "which tab / which frame" answer in it is suspect — and that is
  // worth knowing before reading the results, not after.
  const misaligned = alignmentProblems(flow);
  if (misaligned.length > 0) report.warnings = misaligned;
  const metaAt = metaResolver(flow);

  try {
    // The first navigate has to happen before the environment can be measured —
    // an about:blank page has no fonts and no layout.
    const firstNav = flow.steps.find((step) => step.type === "navigate");
    if (firstNav?.url) {
      await page.goto(firstNav.url, { waitUntil: "load", timeout: opts.timeout });
    }
    if (flow.env) {
      report.env.deltas = await verifyEnv(page, flow.env);
      report.blockedBy = report.env.deltas.find((delta) => delta.blocksParity);
    }

    let previousTMono: number | null = null;
    let navigatedOnce = false;

    for (let index = 0; index < flow.steps.length; index++) {
      const step = flow.steps[index];
      const meta = metaAt(index) ?? EMPTY_META;
      const began = Date.now();
      const notes: string[] = [];
      stepUnmatched = [];

      // "As recorded" replays the gaps the user actually left, measured on a
      // monotonic clock. Capped, because a coffee break is not part of the flow.
      if (opts.speed === "recorded" && meta.tMono) {
        const gap = previousTMono === null ? 0 : meta.tMono - previousTMono;
        previousTMono = meta.tMono;
        if (gap > 0) await page.waitForTimeout(Math.min(gap, MAX_RECORDED_PAUSE_MS));
      } else if (meta.tMono) {
        previousTMono = meta.tMono;
      }

      // The opening navigate was already performed to measure the environment.
      if (step.type === "navigate" && step.url === firstNav?.url && !navigatedOnce) {
        navigatedOnce = true;
        results.push({
          index,
          type: step.type,
          status: "skipped",
          targetId: meta.targetId,
          durationMs: Date.now() - began,
        });
        continue;
      }

      // Route waits turned off. Only the recorder's OWN location assertions — a
      // hand-written expression in an imported flow is the point of that flow.
      // Skipped rather than passed: the report must not claim the flow reached the
      // recorded route when nothing checked.
      if (
        step.type === "waitForExpression" &&
        !opts.routeWaits &&
        isRouteExpression(step.expression)
      ) {
        results.push({
          index,
          type: step.type,
          status: "skipped",
          targetId: meta.targetId,
          durationMs: Date.now() - began,
          notes: ["route waits are off — the expression was not evaluated"],
        });
        continue;
      }

      let status: StepResult["status"] = "pass";
      let code: CauseCode | undefined;
      let error: string | undefined;
      let frameHow: FrameHow | undefined;

      try {
        // Dates come from the recording's timeline, so "2 minutes ago" and any
        // date-formatted content render exactly as they did.
        if (opts.clock === "recorded" && meta.tMono) {
          await pinClock(context, meta.tMono);
        }

        const target = await pageFor(ctx, meta.targetId, opts.timeout);
        await target.bringToFront().catch(() => {});

        const located = await frameFor(target, meta.frameChain, opts.timeout);
        if (!located.frame) {
          throw new StepFailure(
            CAUSE.FRAME_MISSING,
            `iframe chain hop ${located.missing} never loaded in ${meta.targetId}`,
          );
        }
        frameHow = located.how;
        if (located.how === "index" && meta.frameChain.length > 0) {
          notes.push(
            "frame matched by index only — the recorded iframe selector no longer resolves",
          );
        }

        if (step.type !== "scroll" && meta.scrollState?.length) {
          notes.push(...(await restoreScroll(located.frame, meta.scrollState, opts.timeout)));
        }

        if (meta.degraded === "positional-only") {
          notes.push(
            "recorded with positional selectors only — the next markup change breaks this step",
          );
        }
        // Armed before the action, because the dialog opens inside it. Playwright
        // dismisses unhandled dialogs, so an unrecorded one cannot hang the run —
        // but a RECORDED one must get the answer the user gave, or the app takes a
        // different branch from here on.
        if (meta.dialog) {
          const recorded = meta.dialog;
          target.once("dialog", (dialog) => {
            void (recorded.accept
              ? dialog.accept(recorded.promptText).catch(() => {})
              : dialog.dismiss().catch(() => {}));
          });
        }

        // A step that downloaded a file has to be awaited from BEFORE the action:
        // the event fires during it, and Playwright does not buffer.
        const downloadPromise = meta.download
          ? target
              .waitForEvent("download", { timeout: opts.timeout })
              .catch(() => null)
          : null;

        await execStep(ctx, step, meta, target, located.frame, notes);

        if (meta.download) {
          const download = await downloadPromise;
          if (!download) {
            throw new StepFailure(
              CAUSE.DOWNLOAD_MISSING,
              `the recording downloaded "${meta.download.filename}" here; this run downloaded nothing`,
            );
          }
          const actual = download.suggestedFilename();
          if (actual !== meta.download.filename) {
            notes.push(
              `downloaded "${actual}", recorded as "${meta.download.filename}"`,
            );
          }
        }

        // A step whose recording caused a navigation must not race the next step
        // against a dying document.
        if (step.assertedEvents?.some((event) => event.type === "navigation")) {
          await target
            .waitForLoadState("load", { timeout: opts.timeout })
            .catch(() => notes.push("navigation did not reach load within the budget"));
        }
      } catch (err) {
        status = "fail";
        if (err instanceof StepFailure) {
          code = err.code;
          error = err.message;
        } else {
          code = CAUSE.ACTION_FAILED;
          error = err instanceof Error ? err.message : String(err);
        }
      }

      if (stepUnmatched.length > 0) {
        // Sealed mode: name the step that asked for something the archive lacks.
        // A run-level list says drift happened; this says where.
        notes.push(
          `${CAUSE.CONTENT_DRIFT}: ${stepUnmatched.length} request(s) not in the archive (${stepUnmatched[0]})`,
        );
      }

      results.push({
        index,
        type: step.type,
        status,
        targetId: meta.targetId,
        frameHow,
        durationMs: Date.now() - began,
        code,
        error,
        notes: notes.length ? notes : undefined,
      });

      if (status === "fail" && !options.continueOnError) break;
    }

    report.ok = results.every((result) => result.status !== "fail");
    if (sealed && unmatched.length > 0) {
      // Not a failure by itself: a request the archive cannot serve may be an
      // analytics beacon nobody cares about. It IS the explanation when the page
      // then renders differently, so it is always reported.
      report.unmatchedRequests = unmatched;
    }
  } finally {
    report.durationMs = Date.now() - startedAt;
    await context.close().catch(() => {});
    if (ownsBrowser) await browser.close().catch(() => {});
  }

  return report;
}
