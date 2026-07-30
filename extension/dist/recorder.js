"use strict";
(() => {
  // extension/src/content/recorder.ts
  var mode = "off";
  var stepCount = 0;
  var badge = null;
  var send = (msg) => {
    try {
      void chrome.runtime.sendMessage(msg);
    } catch {
    }
  };
  var cssEsc = window.CSS && CSS.escape ? CSS.escape : (v) => v.replace(/([^\w-])/g, "\\$1");
  var norm = (t) => (t ?? "").replace(/\s+/g, " ").trim();
  function accName(el) {
    const aria = el.getAttribute("aria-label");
    if (norm(aria)) return norm(aria);
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text2 = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
      if (norm(text2)) return norm(text2);
    }
    const labels = el.labels;
    if (labels?.length) {
      const text2 = norm(labels[0].textContent);
      if (text2) return text2;
    }
    for (const attr of ["alt", "title", "placeholder"]) {
      const value = el.getAttribute(attr);
      if (norm(value)) return norm(value);
    }
    const text = norm(el.textContent);
    return text && text.length <= 60 ? text : "";
  }
  function cssFor(el) {
    if (el.classList.length > 0) {
      const classes = Array.from(el.classList).slice(0, 3).map(cssEsc);
      const short = `${el.tagName.toLowerCase()}.${classes.join(".")}`;
      try {
        if (document.querySelectorAll(short).length === 1) return short;
      } catch {
      }
    }
    if (el.id) {
      const byId = `#${cssEsc(el.id)}`;
      try {
        if (document.querySelectorAll(byId).length === 1) return byId;
      } catch {
      }
    }
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.body) {
      if (node.id) {
        parts.unshift(`#${cssEsc(node.id)}`);
        break;
      }
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(
          (child) => child.tagName === node.tagName
        );
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }
  function xpathFor(el) {
    const parts = [];
    let node = el;
    let anchor = "";
    while (node && node.nodeType === 1) {
      if (node.id) {
        anchor = `//*[@id="${node.id}"]`;
        break;
      }
      const parent = node.parentElement;
      let segment = node.tagName.toLowerCase();
      if (parent) {
        const same = Array.from(parent.children).filter(
          (child) => child.tagName === node.tagName
        );
        if (same.length > 1) segment += `[${same.indexOf(node) + 1}]`;
      }
      parts.unshift(segment);
      node = parent;
    }
    return anchor ? anchor + (parts.length ? `/${parts.join("/")}` : "") : `/${parts.join("/")}`;
  }
  var attrEsc = (value) => value.replace(/["\\]/g, "\\$&");
  function isUnique(selector) {
    try {
      return document.querySelectorAll(selector).length === 1;
    } catch {
      return false;
    }
  }
  var TESTID_ATTRS = ["data-testid", "data-test", "data-test-id", "data-cy", "data-qa"];
  function selectorsFor(el) {
    const out = [];
    const push = (selector) => {
      if (isUnique(selector)) out.push([selector]);
    };
    for (const attr of TESTID_ATTRS) {
      const value = el.getAttribute(attr);
      if (value) {
        push(`[${attr}="${attrEsc(value)}"]`);
        break;
      }
    }
    const name = accName(el);
    if (name) out.push([`aria/${name}`]);
    const tag = el.tagName.toLowerCase();
    const nameAttr = el.getAttribute("name");
    if (nameAttr && (tag === "input" || tag === "select" || tag === "textarea" || tag === "button")) {
      push(`${tag}[name="${attrEsc(nameAttr)}"]`);
    }
    const placeholder = el.getAttribute("placeholder");
    if (placeholder) push(`${tag}[placeholder="${attrEsc(placeholder)}"]`);
    if (tag === "a") {
      const href = el.getAttribute("href");
      if (href && href !== "#") push(`a[href="${attrEsc(href)}"]`);
    }
    const title = el.getAttribute("title");
    if (title) push(`[title="${attrEsc(title)}"]`);
    const css = cssFor(el);
    if (css) out.push([css]);
    const xp = xpathFor(el);
    if (xp) out.push([`xpath/${xp}`]);
    if (css) out.push([`pierce/${css}`]);
    const text = norm(el.textContent);
    if (text && text.length <= 60 && el.children.length === 0) {
      out.push([`text/${text.slice(0, 25)}`]);
    }
    return out;
  }
  var SPECIAL_KEYS = ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
  function targetOf(event) {
    const path = event.composedPath?.();
    const el = path && path.length > 0 ? path[0] : event.target;
    return el instanceof Element ? el : null;
  }
  function record(step) {
    stepCount++;
    updateBadge();
    send({ type: "cs-step", step });
  }
  var DRAG_THRESHOLD_PX = 5;
  var DRAG_SAMPLE_MS = 40;
  var DRAG_MAX_POINTS = 40;
  var dragState = null;
  var suppressClickUntil = 0;
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (mode !== "record" || !event.isTrusted || event.button !== 0) return;
      const el = targetOf(event);
      if (!el || el.closest("#__tf_badge")) return;
      dragState = {
        el,
        startClientX: event.clientX,
        startClientY: event.clientY,
        offsetX: event.offsetX,
        offsetY: event.offsetY,
        path: [],
        moved: false,
        startedAt: Date.now(),
        lastSampleAt: 0
      };
    },
    true
  );
  document.addEventListener(
    "pointermove",
    (event) => {
      if (!dragState || !event.isTrusted) return;
      const dx = event.clientX - dragState.startClientX;
      const dy = event.clientY - dragState.startClientY;
      if (!dragState.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      dragState.moved = true;
      const now = Date.now();
      if (now - dragState.lastSampleAt >= DRAG_SAMPLE_MS && dragState.path.length < DRAG_MAX_POINTS) {
        dragState.lastSampleAt = now;
        dragState.path.push({ x: Math.round(dx), y: Math.round(dy) });
      }
    },
    true
  );
  document.addEventListener(
    "pointerup",
    (event) => {
      const drag = dragState;
      dragState = null;
      if (!drag || !drag.moved || mode !== "record" || !event.isTrusted) return;
      const dx = Math.round(event.clientX - drag.startClientX);
      const dy = Math.round(event.clientY - drag.startClientY);
      const last = drag.path[drag.path.length - 1];
      if (!last || last.x !== dx || last.y !== dy) drag.path.push({ x: dx, y: dy });
      flushWheel();
      record({
        type: "drag",
        target: "main",
        selectors: selectorsFor(drag.el),
        offsetX: drag.offsetX,
        offsetY: drag.offsetY,
        path: drag.path,
        duration: Date.now() - drag.startedAt
      });
      suppressClickUntil = Date.now() + 200;
    },
    true
  );
  document.addEventListener("pointercancel", () => dragState = null, true);
  document.addEventListener(
    "click",
    (event) => {
      if (mode !== "record" || !event.isTrusted) return;
      if (Date.now() < suppressClickUntil) return;
      const el = targetOf(event);
      if (!el || el.closest("#__tf_badge")) return;
      flushWheel();
      record({
        type: "click",
        target: "main",
        selectors: selectorsFor(el),
        offsetX: event.offsetX,
        offsetY: event.offsetY
      });
    },
    true
  );
  document.addEventListener(
    "contextmenu",
    (event) => {
      if (mode !== "record" || !event.isTrusted) return;
      const el = targetOf(event);
      if (!el || el.closest("#__tf_badge")) return;
      record({
        type: "click",
        target: "main",
        button: "secondary",
        selectors: selectorsFor(el),
        offsetX: event.offsetX,
        offsetY: event.offsetY
      });
    },
    true
  );
  document.addEventListener(
    "dblclick",
    (event) => {
      if (mode !== "record" || !event.isTrusted) return;
      const el = targetOf(event);
      if (!el) return;
      record({
        type: "doubleClick",
        target: "main",
        selectors: selectorsFor(el),
        offsetX: event.offsetX,
        offsetY: event.offsetY
      });
    },
    true
  );
  document.addEventListener(
    "change",
    (event) => {
      if (mode !== "record" || !event.isTrusted) return;
      const el = targetOf(event);
      if (!el) return;
      const tag = el.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      if (["checkbox", "radio", "file", "button", "submit", "reset"].includes(type))
        return;
      record({
        type: "change",
        target: "main",
        // Passwords are recorded with an empty value — the secret never leaves the page.
        value: type === "password" ? "" : String(el.value ?? ""),
        selectors: selectorsFor(el),
        // Playwright codegen needs this: fill() throws on <select>. Stripped on export.
        tagName: tag.toLowerCase()
      });
    },
    true
  );
  var MODIFIER_KEYS = ["Control", "Alt", "Meta", "Shift"];
  var openModifiers = /* @__PURE__ */ new Set();
  var openKeys = /* @__PURE__ */ new Set();
  function isRecordableKey(event) {
    if (SPECIAL_KEYS.includes(event.key)) return true;
    return event.ctrlKey || event.altKey || event.metaKey;
  }
  function emitHeldModifiers(event) {
    const active = [
      ["Control", event.ctrlKey],
      ["Alt", event.altKey],
      ["Meta", event.metaKey],
      ["Shift", event.shiftKey]
    ];
    for (const [key, held] of active) {
      if (held && !openModifiers.has(key)) {
        openModifiers.add(key);
        record({ type: "keyDown", target: "main", key });
      }
    }
  }
  document.addEventListener(
    "keydown",
    (event) => {
      if (mode !== "record" || !event.isTrusted) return;
      if (MODIFIER_KEYS.includes(event.key)) return;
      if (!isRecordableKey(event)) return;
      emitHeldModifiers(event);
      openKeys.add(event.key);
      record({ type: "keyDown", target: "main", key: event.key });
    },
    true
  );
  document.addEventListener(
    "keyup",
    (event) => {
      if (mode !== "record" || !event.isTrusted) return;
      if (MODIFIER_KEYS.includes(event.key)) {
        if (openModifiers.delete(event.key)) {
          record({ type: "keyUp", target: "main", key: event.key });
        }
        return;
      }
      if (openKeys.delete(event.key)) {
        record({ type: "keyUp", target: "main", key: event.key });
      }
    },
    true
  );
  var SCROLL_KEYS = [" ", "PageDown", "PageUp", "Home", "End", "ArrowDown", "ArrowUp"];
  var userScrollIntentUntil = 0;
  var bumpIntent = (ms) => {
    userScrollIntentUntil = Math.max(userScrollIntentUntil, Date.now() + ms);
  };
  var lastScrollEventAt = 0;
  var wheelAcc = null;
  function flushWheel() {
    if (!wheelAcc) return;
    const acc = wheelAcc;
    clearTimeout(acc.timer);
    wheelAcc = null;
    if (mode !== "record") return;
    if (lastScrollEventAt >= acc.startedAt) return;
    record({
      type: "wheel",
      target: "main",
      selectors: selectorsFor(acc.el),
      deltaX: Math.round(acc.deltaX),
      deltaY: Math.round(acc.deltaY),
      offsetX: acc.offsetX,
      offsetY: acc.offsetY
    });
  }
  window.addEventListener(
    "wheel",
    (event) => {
      if (!event.isTrusted) return;
      bumpIntent(250);
      if (mode !== "record") return;
      const el = targetOf(event);
      if (!el || el.closest("#__tf_badge")) return;
      if (wheelAcc && wheelAcc.el !== el) flushWheel();
      if (wheelAcc) {
        clearTimeout(wheelAcc.timer);
        wheelAcc.deltaX += event.deltaX;
        wheelAcc.deltaY += event.deltaY;
        wheelAcc.offsetX = event.offsetX;
        wheelAcc.offsetY = event.offsetY;
        wheelAcc.timer = setTimeout(flushWheel, 400);
      } else {
        wheelAcc = {
          el,
          deltaX: event.deltaX,
          deltaY: event.deltaY,
          offsetX: event.offsetX,
          offsetY: event.offsetY,
          startedAt: Date.now(),
          timer: setTimeout(flushWheel, 400)
        };
      }
    },
    { capture: true, passive: true }
  );
  window.addEventListener(
    "touchmove",
    (event) => {
      if (event.isTrusted) bumpIntent(250);
    },
    { capture: true, passive: true }
  );
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.isTrusted && SCROLL_KEYS.includes(event.key)) bumpIntent(700);
    },
    true
  );
  var scrollTimer = null;
  var pendingScrollTargets = /* @__PURE__ */ new Set();
  document.addEventListener(
    "scroll",
    (event) => {
      if (!event.isTrusted) return;
      lastScrollEventAt = Date.now();
      if (mode !== "record") return;
      if (Date.now() > userScrollIntentUntil) return;
      pendingScrollTargets.add(
        event.target instanceof Element ? event.target : null
      );
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        scrollTimer = null;
        if (mode !== "record") {
          pendingScrollTargets.clear();
          return;
        }
        for (const target of pendingScrollTargets) {
          if (target) {
            record({
              type: "scroll",
              target: "main",
              selectors: selectorsFor(target),
              x: Math.round(target.scrollLeft),
              y: Math.round(target.scrollTop)
            });
          } else {
            record({
              type: "scroll",
              target: "main",
              x: Math.round(window.scrollX),
              y: Math.round(window.scrollY)
            });
          }
        }
        pendingScrollTargets.clear();
      }, 350);
    },
    { capture: true, passive: true }
  );
  var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function deepQuery(selector, root = document) {
    try {
      const direct = root.querySelector(selector);
      if (direct) return direct;
    } catch {
      return null;
    }
    const all = root.querySelectorAll("*");
    for (const node of all) {
      if (node.shadowRoot) {
        const found = deepQuery(selector, node.shadowRoot);
        if (found) return found;
      }
    }
    return null;
  }
  function byAria(name) {
    const nodes = document.querySelectorAll(
      "button,a,input,select,textarea,summary,label,[role],[aria-label],[tabindex],h1,h2,h3,h4,svg,img"
    );
    for (const node of nodes) if (accName(node) === name) return node;
    return null;
  }
  function byText(prefix) {
    let best = null;
    const all = document.body.getElementsByTagName("*");
    for (const node of all) {
      const text = norm(node.textContent);
      if (text && text.startsWith(prefix)) {
        if (!best || (node.textContent ?? "").length < (best.textContent ?? "").length) {
          best = node;
        }
      }
    }
    return best;
  }
  function resolveOne(selector) {
    try {
      if (selector.startsWith("aria/")) return byAria(selector.slice(5));
      if (selector.startsWith("xpath/"))
        return document.evaluate(
          selector.slice(6),
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue;
      if (selector.startsWith("pierce/")) return deepQuery(selector.slice(7));
      if (selector.startsWith("text/")) return byText(selector.slice(5));
      return document.querySelector(selector);
    } catch {
      return null;
    }
  }
  function voteResolve(groups) {
    const buckets = [];
    groups.forEach((group, index) => {
      const el = group[0] ? resolveOne(group[0]) : null;
      if (!el) return;
      const related = buckets.find(
        (bucket) => bucket.el === el || bucket.el.contains(el) || el.contains(bucket.el)
      );
      if (related) {
        related.votes++;
        if (related.el.contains(el) && related.el !== el) related.el = el;
      } else {
        buckets.push({ el, votes: 1, firstIndex: index });
      }
    });
    if (buckets.length === 0) return null;
    buckets.sort((a, b) => b.votes - a.votes || a.firstIndex - b.firstIndex);
    return buckets[0].el;
  }
  function resolveEl(groups, timeoutMs) {
    const started = Date.now();
    return new Promise((resolve) => {
      const poll = () => {
        const el = voteResolve(groups);
        if (el) return resolve(el);
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(poll, 120);
      };
      poll();
    });
  }
  function fire(el, Ctor, type, init) {
    try {
      el.dispatchEvent(
        new Ctor(type, { bubbles: true, cancelable: true, composed: true, ...init })
      );
    } catch {
    }
  }
  function clickPoint(el, step) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + (typeof step.offsetX === "number" && step.offsetX <= rect.width ? step.offsetX : rect.width / 2);
    const cy = rect.top + (typeof step.offsetY === "number" && step.offsetY <= rect.height ? step.offsetY : rect.height / 2);
    return { cx, cy };
  }
  async function doClick(el, step, dbl) {
    try {
      el.scrollIntoView({ block: "center", inline: "center" });
    } catch {
    }
    await sleep(80);
    const { cx, cy } = clickPoint(el, step);
    const PE = window.PointerEvent ?? MouseEvent;
    const hoverInit = { clientX: cx, clientY: cy, view: window };
    fire(el, PE, "pointerover", hoverInit);
    fire(el, MouseEvent, "mouseover", hoverInit);
    fire(el, MouseEvent, "mousemove", hoverInit);
    if (step.button === "secondary") {
      const init2 = { clientX: cx, clientY: cy, button: 2, detail: 1, view: window };
      fire(el, PE, "pointerdown", init2);
      fire(el, MouseEvent, "mousedown", init2);
      fire(el, PE, "pointerup", init2);
      fire(el, MouseEvent, "mouseup", init2);
      fire(el, MouseEvent, "contextmenu", init2);
      return;
    }
    const init = { clientX: cx, clientY: cy, button: 0, detail: 1, view: window };
    fire(el, PE, "pointerdown", init);
    fire(el, MouseEvent, "mousedown", init);
    try {
      el.focus?.();
    } catch {
    }
    fire(el, PE, "pointerup", init);
    fire(el, MouseEvent, "mouseup", init);
    fire(el, MouseEvent, "click", init);
    if (dbl) fire(el, MouseEvent, "dblclick", { ...init, detail: 2 });
  }
  async function doDrag(el, step) {
    const { cx, cy } = clickPoint(el, step);
    const PE = window.PointerEvent ?? MouseEvent;
    const path = step.path?.length ? step.path : [{ x: 0, y: 0 }];
    const gap = Math.min(
      Math.max((step.duration ?? 300) / path.length, 5),
      40
    );
    fire(el, PE, "pointerover", { clientX: cx, clientY: cy, view: window });
    fire(el, MouseEvent, "mouseover", { clientX: cx, clientY: cy, view: window });
    const downInit = { clientX: cx, clientY: cy, button: 0, view: window };
    fire(el, PE, "pointerdown", downInit);
    fire(el, MouseEvent, "mousedown", downInit);
    let lastX = cx;
    let lastY = cy;
    for (const point of path) {
      lastX = cx + point.x;
      lastY = cy + point.y;
      const moveInit = { clientX: lastX, clientY: lastY, button: 0, view: window };
      fire(el, PE, "pointermove", moveInit);
      fire(el, MouseEvent, "mousemove", moveInit);
      await sleep(gap);
    }
    const upInit = { clientX: lastX, clientY: lastY, button: 0, view: window };
    fire(el, PE, "pointerup", upInit);
    fire(el, MouseEvent, "mouseup", upInit);
  }
  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, value);
    else el.value = value;
  }
  var heldKeys = /* @__PURE__ */ new Set();
  var KEY_INFO = {
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
    Meta: { code: "MetaLeft", keyCode: 91 }
  };
  function keyInfo(key) {
    const known = KEY_INFO[key];
    if (known) return known;
    if (/^[a-zA-Z]$/.test(key)) {
      const upper = key.toUpperCase();
      return { code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
    }
    if (/^[0-9]$/.test(key)) {
      return { code: `Digit${key}`, keyCode: 48 + Number(key) };
    }
    if (/^F([1-9]|1[0-2])$/.test(key)) {
      return { code: key, keyCode: 111 + Number(key.slice(1)) };
    }
    return { code: key, keyCode: 0 };
  }
  function budgetOf(step) {
    const t = typeof step.timeout === "number" ? step.timeout : 5e3;
    return Math.min(Math.max(t, 500), 3e4);
  }
  async function execStep(step) {
    switch (step.type) {
      case "setViewport":
        return { ok: true };
      // a tab can't resize itself — informational
      case "navigate":
        if (norm(location.href) !== norm(step.url ?? "")) {
          location.assign(step.url ?? "");
        }
        return { ok: true };
      case "scroll": {
        if (step.selectors?.length) {
          const el = await resolveEl(step.selectors, budgetOf(step));
          if (!el) return { ok: false, error: "scroll container not found" };
          el.scrollTo({ left: step.x ?? 0, top: step.y ?? 0 });
        } else {
          window.scrollTo(step.x ?? 0, step.y ?? 0);
        }
        return { ok: true };
      }
      case "keyDown":
      case "keyUp": {
        const key = step.key ?? "";
        if (step.type === "keyDown") heldKeys.add(key);
        else heldKeys.delete(key);
        const info = keyInfo(key);
        try {
          window.dispatchEvent(
            new CustomEvent("__tf_kbd", {
              detail: JSON.stringify({
                type: step.type === "keyDown" ? "keydown" : "keyup",
                key,
                code: info.code,
                keyCode: info.keyCode,
                ctrlKey: heldKeys.has("Control"),
                altKey: heldKeys.has("Alt"),
                metaKey: heldKeys.has("Meta"),
                shiftKey: heldKeys.has("Shift")
              })
            })
          );
        } catch {
        }
        return { ok: true };
      }
      case "wheel": {
        const el = await resolveEl(step.selectors ?? [], budgetOf(step));
        if (!el) return { ok: false, error: "wheel target not found" };
        const rect = el.getBoundingClientRect();
        const cx = rect.left + (typeof step.offsetX === "number" && step.offsetX <= rect.width ? step.offsetX : rect.width / 2);
        const cy = rect.top + (typeof step.offsetY === "number" && step.offsetY <= rect.height ? step.offsetY : rect.height / 2);
        fire(el, MouseEvent, "mousemove", { clientX: cx, clientY: cy, view: window });
        const total = { x: step.deltaX ?? 0, y: step.deltaY ?? 0 };
        const chunks = Math.max(
          1,
          Math.ceil(Math.max(Math.abs(total.x), Math.abs(total.y)) / 120)
        );
        for (let i = 0; i < chunks; i++) {
          fire(el, WheelEvent, "wheel", {
            clientX: cx,
            clientY: cy,
            deltaX: total.x / chunks,
            deltaY: total.y / chunks,
            deltaMode: 0,
            view: window
          });
          await sleep(40);
        }
        return { ok: true };
      }
      case "waitForElement": {
        const el = await resolveEl(step.selectors ?? [], budgetOf(step));
        return el ? { ok: true } : { ok: false, error: "element never appeared" };
      }
      case "click":
      case "doubleClick": {
        const el = await resolveEl(step.selectors ?? [], budgetOf(step));
        if (!el) return { ok: false, error: "no selector matched" };
        await doClick(el, step, step.type === "doubleClick");
        return { ok: true };
      }
      case "drag": {
        const el = await resolveEl(step.selectors ?? [], budgetOf(step));
        if (!el) return { ok: false, error: "drag target not found" };
        await doDrag(el, step);
        return { ok: true };
      }
      case "change": {
        const el = await resolveEl(step.selectors ?? [], budgetOf(step));
        if (!el) return { ok: false, error: "no selector matched" };
        try {
          el.focus?.();
        } catch {
        }
        setNativeValue(el, step.value ?? "");
        fire(el, Event, "input", {});
        fire(el, Event, "change", {});
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  }
  chrome.runtime.onMessage.addListener(
    (message, _sender, sendResponse) => {
      if (message.type === "cs-set-mode") {
        mode = message.mode;
        if (mode === "off") removeBadge();
        else installBadge();
        sendResponse({ ok: true });
        return false;
      }
      if (message.type === "cs-run") {
        void execStep(message.step).then((result) => sendResponse(result));
        return true;
      }
      return false;
    }
  );
  function updateBadge() {
    if (!badge) return;
    badge.textContent = mode === "replay" ? "\u25B6 replaying\u2026" : `\u25CF REC \xB7 ${stepCount} steps`;
  }
  function installBadge() {
    if (window.top !== window) return;
    if (badge || !document.body) return;
    badge = document.createElement("div");
    badge.id = "__tf_badge";
    badge.setAttribute(
      "style",
      "position:fixed;bottom:16px;right:16px;z-index:2147483647;pointer-events:none;background:rgba(17,17,17,.92);color:#fff;font:12px/1.4 ui-monospace,Menlo,monospace;padding:8px 12px;border-radius:999px;box-shadow:0 2px 12px rgba(0,0,0,.35)"
    );
    document.body.appendChild(badge);
    updateBadge();
  }
  function removeBadge() {
    badge?.remove();
    badge = null;
  }
  function announce() {
    if (window.top !== window) return;
    send({
      type: "cs-ready",
      url: location.href,
      title: document.title,
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio || 1
    });
    if (mode !== "off") installBadge();
    const settle = () => send({ type: "cs-settled", url: location.href });
    if (document.readyState === "complete") settle();
    else window.addEventListener("load", settle, { once: true });
  }
  void chrome.runtime.sendMessage({ type: "cs-get-mode" }).then((reply) => {
    mode = reply?.mode ?? "off";
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", announce);
    } else {
      announce();
    }
  }).catch(() => {
  });
})();
