/**
 * Real input, from the extension.
 *
 * The whole reason this exists: a dispatchEvent() from a content script produces an
 * event with `isTrusted: false`, no real hover, no `:focus-visible`, and no native
 * scrolling. Playwright's input has none of those limitations, so the same flow
 * genuinely means two different things in the two replay engines. Driving Chrome's
 * Input domain over chrome.debugger closes that gap — it is the same channel
 * Playwright uses.
 *
 * Cost, stated plainly: attaching shows Chrome's "started debugging this browser"
 * infobar. It is attached for REPLAY ONLY and detached the moment the run ends, so
 * recording is never affected — and the infobar would otherwise shrink the viewport
 * being recorded, which is a fidelity bug in itself.
 *
 * When attach fails (DevTools open, another debugger, user policy), replay falls
 * back to synthetic events and SAYS SO. A silent downgrade would be the worst
 * outcome: the run passes and nobody knows it proved less than it appears to.
 */

const PROTOCOL_VERSION = "1.3";

/** Tabs we currently hold a debugger session on. */
const attached = new Set<number>();

export function isAttached(tabId: number): boolean {
  return attached.has(tabId);
}

export async function attach(tabId: number): Promise<boolean> {
  if (attached.has(tabId)) return true;
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
    attached.add(tabId);
    return true;
  } catch {
    // Already-attached (Playwright, DevTools) or blocked by policy.
    return false;
  }
}

export async function detach(tabId: number): Promise<void> {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    /* the tab is already gone — nothing to release */
  }
}

export async function detachAll(): Promise<void> {
  await Promise.all(Array.from(attached).map((tabId) => detach(tabId)));
}

// Chrome drops the session when a tab closes or the user clicks "Cancel" on the
// infobar; forget it so the next attach is attempted rather than assumed.
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId !== undefined) attached.delete(source.tabId);
});

async function send(
  tabId: number,
  method: string,
  params: Record<string, unknown>,
): Promise<void> {
  await chrome.debugger.sendCommand({ tabId }, method, params);
}

/* ---------------------------------------------------------------- *
 * Expressions
 * ---------------------------------------------------------------- */

/**
 * Evaluates an expression against the page — WITHOUT eval.
 *
 * Almost every real site ships a Content-Security-Policy without `unsafe-eval`, so
 * the page's own world cannot run `new Function(...)` at all: the browser refuses it
 * outright. The debugger protocol is not page script and is not subject to the page's
 * CSP, so this works where evaluating in the page cannot.
 *
 * Evaluates in the MAIN frame's context. Recorded route assertions come from the top
 * frame, so that is the right scope for them; an expression belonging to a subframe
 * is left to the content script, which can reach it.
 */
export async function evaluate(tabId: number, expression: string): Promise<boolean> {
  const result = (await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
    // Coerced here so a truthy non-boolean (an element, a non-empty string) means
    // the same thing it would in an `if`.
    expression: `!!(${expression})`,
    returnByValue: true,
    // A page that throws should read as "not true yet", not as a crashed run.
    silent: true,
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (result.exceptionDetails) return false;
  return result.result?.value === true;
}

/* ---------------------------------------------------------------- *
 * Mouse
 * ---------------------------------------------------------------- */

type Button = "left" | "right" | "middle";

const BUTTON_MASK: Record<Button, number> = { left: 1, right: 2, middle: 4 };

export async function mouseMove(tabId: number, x: number, y: number): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, buttons: 0 });
}

export async function click(
  tabId: number,
  x: number,
  y: number,
  button: Button,
  clickCount: number,
): Promise<void> {
  // The hover pair first: menus and tooltips that open on mouseover need the cursor
  // to arrive before the press, exactly as a real one would.
  await mouseMove(tabId, x, y);
  for (let n = 1; n <= clickCount; n++) {
    const common = { x, y, button, buttons: BUTTON_MASK[button], clickCount: n };
    await send(tabId, "Input.dispatchMouseEvent", { ...common, type: "mousePressed" });
    await send(tabId, "Input.dispatchMouseEvent", {
      ...common,
      type: "mouseReleased",
      buttons: 0,
    });
  }
}

export async function drag(
  tabId: number,
  start: { x: number; y: number },
  path: { x: number; y: number }[],
  durationMs: number,
): Promise<void> {
  await mouseMove(tabId, start.x, start.y);
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: start.x,
    y: start.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  const points = path.length > 0 ? path : [{ x: 0, y: 0 }];
  const gap = Math.min(Math.max(durationMs / points.length, 5), 40);
  let last = start;
  for (const point of points) {
    last = { x: start.x + point.x, y: start.y + point.y };
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: last.x,
      y: last.y,
      button: "left",
      buttons: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, gap));
  }
  await send(tabId, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: last.x,
    y: last.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
}

export async function wheel(
  tabId: number,
  x: number,
  y: number,
  deltaX: number,
  deltaY: number,
): Promise<void> {
  await mouseMove(tabId, x, y);
  // Chunked at ±120 like a physical wheel: map libraries clamp one huge delta to a
  // single zoom notch, so an unchunked event under-zooms. Same rule as the
  // synthetic path and the Playwright runner — three engines, one behaviour.
  const chunks = Math.max(1, Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) / 120));
  for (let i = 0; i < chunks; i++) {
    await send(tabId, "Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: deltaX / chunks,
      deltaY: deltaY / chunks,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
}

/* ---------------------------------------------------------------- *
 * Keyboard
 * ---------------------------------------------------------------- */

/** Keys currently held, so a combo carries the right modifier bitmask. */
const held = new Set<string>();

const MODIFIER_BIT: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const KEY_INFO: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  Delete: { code: "Delete", keyCode: 46 },
  " ": { code: "Space", keyCode: 32 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
  Home: { code: "Home", keyCode: 36 },
  End: { code: "End", keyCode: 35 },
  PageUp: { code: "PageUp", keyCode: 33 },
  PageDown: { code: "PageDown", keyCode: 34 },
  Control: { code: "ControlLeft", keyCode: 17 },
  Shift: { code: "ShiftLeft", keyCode: 16 },
  Alt: { code: "AltLeft", keyCode: 18 },
  Meta: { code: "MetaLeft", keyCode: 91 },
};

function keyInfo(key: string): { code: string; keyCode: number } {
  const known = KEY_INFO[key];
  if (known) return known;
  if (/^[a-zA-Z]$/.test(key)) {
    const upper = key.toUpperCase();
    return { code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
  }
  if (/^[0-9]$/.test(key)) return { code: `Digit${key}`, keyCode: 48 + Number(key) };
  if (/^F([1-9]|1[0-2])$/.test(key)) return { code: key, keyCode: 111 + Number(key.slice(1)) };
  return { code: key, keyCode: 0 };
}

export function resetKeys(): void {
  held.clear();
}

export async function key(tabId: number, down: boolean, name: string): Promise<void> {
  if (down) held.add(name);
  else held.delete(name);

  let modifiers = 0;
  for (const [modifier, bit] of Object.entries(MODIFIER_BIT)) {
    if (held.has(modifier)) modifiers |= bit;
  }

  const info = keyInfo(name);
  // A printable key under Ctrl/Alt/Meta must NOT produce text, or the shortcut also
  // types a character. Bare printable keys do.
  const printable = name.length === 1 && !(modifiers & (MODIFIER_BIT.Control | MODIFIER_BIT.Alt | MODIFIER_BIT.Meta));
  await send(tabId, "Input.dispatchKeyEvent", {
    type: down ? (printable ? "keyDown" : "rawKeyDown") : "keyUp",
    key: name,
    code: info.code,
    windowsVirtualKeyCode: info.keyCode,
    nativeVirtualKeyCode: info.keyCode,
    modifiers,
    ...(down && printable ? { text: name } : {}),
  });
}
