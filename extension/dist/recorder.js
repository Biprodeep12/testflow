"use strict";
(() => {
  // src/types/flow.ts
  var MAX_UPLOAD_BYTES = 256 * 1024;

  // extension/src/content/frames.ts
  var ASK_INTERVAL_MS = 200;
  var ASK_TIMEOUT_MS = 4e3;
  var hooks = null;
  var cached = window.top === window ? [] : null;
  var pending = null;
  var nextId = 1;
  function initFrames(config) {
    hooks = config;
    const frameElementFor = (source) => {
      const frames = Array.from(document.querySelectorAll("iframe, frame"));
      const index = frames.findIndex(
        (el) => el.contentWindow === source
      );
      return index < 0 ? null : { el: frames[index], index };
    };
    window.addEventListener("message", (event) => {
      const where = event.data;
      if (where && where.__tf === "whereami" && typeof where.id === "number") {
        if (!hooks?.isActive()) return;
        const source2 = event.source;
        if (!source2) return;
        const found2 = frameElementFor(source2);
        if (!found2) return;
        void myViewportOffset().then((mine) => {
          const rect = found2.el.getBoundingClientRect();
          const style = getComputedStyle(found2.el);
          const inset = {
            left: parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
            top: parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop)
          };
          source2.postMessage(
            {
              __tf: "youareat",
              id: where.id,
              x: mine.x + rect.left + (inset.left || 0),
              y: mine.y + rect.top + (inset.top || 0)
            },
            "*"
          );
        });
        return;
      }
      const data = event.data;
      if (!data || data.__tf !== "whoami" || typeof data.id !== "number") return;
      if (!hooks?.isActive()) return;
      const source = event.source;
      if (!source) return;
      const found = frameElementFor(source);
      if (!found) return;
      const { el, index } = found;
      void myFrameChain().then((parentChain) => {
        const link = {
          index,
          selectors: hooks?.selectorsFor(el),
          url: el.getAttribute("src") ?? void 0,
          name: el.getAttribute("name") ?? void 0
        };
        const reply = { __tf: "youare", id: data.id, chain: [...parentChain, link] };
        source.postMessage(reply, "*");
      });
    });
  }
  function myViewportOffset() {
    if (window.top === window) return Promise.resolve({ x: 0, y: 0 });
    return new Promise((resolve) => {
      const id = nextId++;
      const parent = window.parent;
      const timer = setTimeout(() => {
        window.removeEventListener("message", onReply);
        resolve({ x: 0, y: 0 });
      }, 1e3);
      function onReply(event) {
        const data = event.data;
        if (!data || data.__tf !== "youareat" || data.id !== id) return;
        if (event.source !== parent) return;
        clearTimeout(timer);
        window.removeEventListener("message", onReply);
        resolve({ x: data.x, y: data.y });
      }
      window.addEventListener("message", onReply);
      parent.postMessage({ __tf: "whereami", id }, "*");
    });
  }
  function myFrameChain() {
    if (cached) return Promise.resolve(cached);
    if (pending) return pending;
    pending = new Promise((resolve) => {
      const id = nextId++;
      const parent = window.parent;
      let timer = null;
      let deadline = null;
      const done = (chain) => {
        if (timer) clearInterval(timer);
        if (deadline) clearTimeout(deadline);
        window.removeEventListener("message", onReply);
        cached = chain;
        resolve(chain);
      };
      function onReply(event) {
        const data = event.data;
        if (!data || data.__tf !== "youare" || data.id !== id) return;
        if (event.source !== parent) return;
        done(Array.isArray(data.chain) ? data.chain : []);
      }
      window.addEventListener("message", onReply);
      const ask = () => parent.postMessage({ __tf: "whoami", id }, "*");
      ask();
      timer = setInterval(ask, ASK_INTERVAL_MS);
      deadline = setTimeout(() => done([]), ASK_TIMEOUT_MS);
    });
    return pending;
  }

  // extension/src/content/cursor.ts
  var SVG_NS = "http://www.w3.org/2000/svg";
  var ID = "__tf_cursor";
  var root = null;
  var ripple = null;
  var guard = null;
  var at = { x: -100, y: -100 };
  function build() {
    if (!document.body) return null;
    const container = document.createElement("div");
    container.id = ID;
    const style = container.style;
    style.position = "fixed";
    style.left = "0";
    style.top = "0";
    style.zIndex = "2147483647";
    style.pointerEvents = "none";
    style.width = "0";
    style.height = "0";
    style.transform = `translate(${at.x}px, ${at.y}px)`;
    style.willChange = "transform";
    style.visibility = "hidden";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "24");
    svg.setAttribute("height", "24");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.style.position = "absolute";
    svg.style.left = "-2px";
    svg.style.top = "-2px";
    svg.style.filter = "drop-shadow(0 1px 2px rgba(0,0,0,.4))";
    const arrow = document.createElementNS(SVG_NS, "path");
    arrow.setAttribute("d", "M5 3 L5 19 L9.2 15 L11.8 20.6 L14.8 19.2 L12.2 13.8 L18 13.6 Z");
    arrow.setAttribute("fill", "#ffffff");
    arrow.setAttribute("stroke", "#111111");
    arrow.setAttribute("stroke-width", "1.4");
    arrow.setAttribute("stroke-linejoin", "round");
    svg.appendChild(arrow);
    const pulse = document.createElement("div");
    const pulseStyle = pulse.style;
    pulseStyle.position = "absolute";
    pulseStyle.left = "-11px";
    pulseStyle.top = "-11px";
    pulseStyle.width = "22px";
    pulseStyle.height = "22px";
    pulseStyle.borderRadius = "50%";
    pulseStyle.border = "2px solid rgba(37, 99, 235, .9)";
    pulseStyle.background = "rgba(37, 99, 235, .18)";
    pulseStyle.opacity = "0";
    pulseStyle.transform = "scale(.3)";
    container.appendChild(pulse);
    container.appendChild(svg);
    document.body.appendChild(container);
    ripple = pulse;
    return container;
  }
  function ensure() {
    if (root && root.isConnected) return root;
    root = build();
    if (root && !guard) {
      guard = new MutationObserver(() => {
        if (root && !root.isConnected && document.body) document.body.appendChild(root);
      });
      try {
        guard.observe(document.body, { childList: true });
      } catch {
        guard = null;
      }
    }
    return root;
  }
  function installCursor() {
    if (ensure()) return;
    document.addEventListener("DOMContentLoaded", () => void ensure(), { once: true });
  }
  function placeCursor(x, y) {
    const el = ensure();
    at = { x, y };
    if (!el) return;
    el.style.transition = "none";
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.style.visibility = "visible";
  }
  function moveCursorTo(x, y, durationMs) {
    const el = ensure();
    if (!el) {
      at = { x, y };
      return Promise.resolve();
    }
    const distance = Math.hypot(x - at.x, y - at.y);
    const duration = distance < 4 ? 0 : Math.min(durationMs, Math.max(120, distance * 1.1));
    at = { x, y };
    el.style.transition = duration > 0 ? `transform ${Math.round(duration)}ms cubic-bezier(.22,.61,.36,1)` : "none";
    el.style.transform = `translate(${x}px, ${y}px)`;
    el.style.visibility = "visible";
    if (duration === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        el.removeEventListener("transitionend", done);
        resolve();
      };
      el.addEventListener("transitionend", done);
      setTimeout(done, duration + 80);
    });
  }
  function pulseCursor() {
    const el = ensure();
    if (!el || !ripple) return;
    const style = ripple.style;
    style.transition = "none";
    style.opacity = "1";
    style.transform = "scale(.3)";
    requestAnimationFrame(() => {
      style.transition = "transform 380ms ease-out, opacity 380ms ease-out";
      style.opacity = "0";
      style.transform = "scale(2.2)";
    });
  }
  function removeCursor() {
    guard?.disconnect();
    guard = null;
    root?.remove();
    root = null;
    ripple = null;
    at = { x: -100, y: -100 };
  }
  function cursorPosition() {
    return at;
  }

  // src/shared/resolve.ts
  function resolveInPage(payload) {
    const norm2 = (t) => (t ?? "").replace(/\s+/g, " ").trim();
    const accName2 = (el) => {
      const aria = el.getAttribute("aria-label");
      if (norm2(aria)) return norm2(aria);
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const text2 = labelledBy.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
        if (norm2(text2)) return norm2(text2);
      }
      const labels = el.labels;
      if (labels && labels.length > 0) {
        const text2 = norm2(labels[0].textContent);
        if (text2) return text2;
      }
      for (const attr of ["alt", "title", "placeholder"]) {
        const value = el.getAttribute(attr);
        if (norm2(value)) return norm2(value);
      }
      const text = norm2(el.textContent);
      return text && text.length <= 60 ? text : "";
    };
    const deepQuery = (selector, root2) => {
      try {
        const direct = root2.querySelector(selector);
        if (direct) return direct;
      } catch {
        return null;
      }
      const all = root2.querySelectorAll("*");
      for (const node of all) {
        if (node.shadowRoot) {
          const found = deepQuery(selector, node.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    };
    const byAria = (name) => {
      const nodes = document.querySelectorAll(
        "button,a,input,select,textarea,summary,label,[role],[aria-label],[tabindex],h1,h2,h3,h4,svg,img"
      );
      for (const node of nodes) if (accName2(node) === name) return node;
      return null;
    };
    const byText = (prefix) => {
      let best = null;
      const all = document.body ? document.body.getElementsByTagName("*") : [];
      for (const node of all) {
        const text = norm2(node.textContent);
        if (text && text.startsWith(prefix)) {
          if (!best || (node.textContent ?? "").length < (best.textContent ?? "").length) {
            best = node;
          }
        }
      }
      return best;
    };
    const resolveOne = (selector) => {
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
        if (selector.startsWith("pierce/")) return deepQuery(selector.slice(7), document);
        if (selector.startsWith("text/")) return byText(selector.slice(5));
        return document.querySelector(selector);
      } catch {
        return null;
      }
    };
    const buckets = [];
    (payload.selectors || []).forEach((group, index) => {
      const el = group && group[0] ? resolveOne(group[0]) : null;
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

  // src/shared/env.ts
  async function capturePermissions() {
    const candidates = [
      "geolocation",
      "notifications",
      "camera",
      "microphone",
      "clipboard-read"
    ];
    const granted = [];
    for (const name of candidates) {
      try {
        const status = await navigator.permissions.query({
          name
        });
        if (status.state === "granted") granted.push(name);
      } catch {
      }
    }
    return granted;
  }
  function captureEnv() {
    const probeStrings = ["MMMMMMMMWWWWiiiil", "Hamburgefonstiv"];
    const familiesInUse = () => {
      const found = /* @__PURE__ */ new Set();
      const nodes = document.querySelectorAll("body, body *");
      let seen = 0;
      for (const node of nodes) {
        if (seen++ > 400) break;
        const family = getComputedStyle(node).fontFamily.split(",")[0];
        const clean = family.replace(/["']/g, "").trim();
        if (clean) found.add(clean);
        if (found.size >= 12) break;
      }
      return Array.from(found);
    };
    const probeFonts = () => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      if (!ctx) return [];
      return familiesInUse().map((family) => {
        const widths = probeStrings.map((text) => {
          ctx.font = `16px "${family}", sans-serif`;
          return Math.round(ctx.measureText(text).width * 100) / 100;
        });
        let loaded = false;
        try {
          loaded = document.fonts.check(`16px "${family}"`);
        } catch {
        }
        return { family, loaded, widths };
      });
    };
    const webgl = () => {
      try {
        const canvas = document.createElement("canvas");
        const gl = canvas.getContext("webgl");
        if (!gl) return void 0;
        const info = gl.getExtension("WEBGL_debug_renderer_info");
        if (!info) return void 0;
        return {
          vendor: String(gl.getParameter(info.UNMASKED_VENDOR_WEBGL)),
          renderer: String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL))
        };
      } catch {
        return void 0;
      }
    };
    const ua = navigator.userAgent;
    const match = /(Chrome|Firefox|Edg|Safari)\/([\d.]+)/.exec(ua);
    const uaData = navigator.userAgentData;
    const media = (query) => {
      try {
        return window.matchMedia(query).matches;
      } catch {
        return false;
      }
    };
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      layoutWidth: document.documentElement.clientWidth,
      // Classic vs overlay scrollbars shift every centered element by ~7-8px.
      scrollbarWidth: window.innerWidth - document.documentElement.clientWidth,
      deviceScaleFactor: window.devicePixelRatio || 1,
      screen: {
        width: window.screen.width,
        height: window.screen.height,
        availHeight: window.screen.availHeight
      },
      userAgent: ua,
      platform: uaData?.platform ?? navigator.platform,
      browser: { name: match ? match[1] : "unknown", version: match ? match[2] : "0" },
      locale: navigator.language,
      languages: Array.from(navigator.languages ?? [navigator.language]),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timeOrigin: performance.timeOrigin,
      colorScheme: media("(prefers-color-scheme: dark)") ? "dark" : "light",
      reducedMotion: media("(prefers-reduced-motion: reduce)"),
      forcedColors: media("(forced-colors: active)"),
      isMobile: uaData?.mobile ?? /Mobi|Android/i.test(ua),
      hasTouch: "ontouchstart" in window || navigator.maxTouchPoints > 0,
      maxTouchPoints: navigator.maxTouchPoints ?? 0,
      fonts: probeFonts(),
      webgl: webgl()
    };
  }

  // src/shared/expressions.ts
  var FORMS = [
    {
      pattern: /^location\.pathname \+ location\.hash === ("(?:[^"\\]|\\.)*")$/,
      actual: () => location.pathname + location.hash
    },
    {
      pattern: /^location\.pathname === ("(?:[^"\\]|\\.)*")$/,
      actual: () => location.pathname
    },
    {
      pattern: /^location\.href === ("(?:[^"\\]|\\.)*")$/,
      actual: () => location.href
    }
  ];
  function evaluateKnownExpression(expression, read) {
    const value = (index) => {
      if (!read) return FORMS[index].actual();
      if (index === 0) return read("pathname") + read("hash");
      if (index === 1) return read("pathname");
      return read("href");
    };
    for (let i = 0; i < FORMS.length; i++) {
      const match = FORMS[i].pattern.exec(expression.trim());
      if (!match) continue;
      try {
        return value(i) === JSON.parse(match[1]);
      } catch {
        return void 0;
      }
    }
    return void 0;
  }

  // extension/src/content/recorder.ts
  var CURSOR_GLIDE_MS = 420;
  var mode = "off";
  var stepCount = 0;
  var badge = null;
  var chainReady = Promise.resolve([]);
  var monoNow = () => performance.timeOrigin + performance.now();
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
    if (el.childElementCount > 8) return "";
    const text = norm(el.textContent);
    return text && text.length <= 60 ? text : "";
  }
  function nthOfType(node) {
    const parent = node.parentElement;
    if (!parent) return 0;
    let count = 0;
    let index = 0;
    for (const child of parent.children) {
      if (child.tagName !== node.tagName) continue;
      count++;
      if (child === node) index = count;
    }
    return count > 1 ? index : 0;
  }
  function ancestorPath(el) {
    const path = [];
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.id) {
        path.push({ tag: node.tagName.toLowerCase(), nth: 0, id: node.id });
        break;
      }
      path.push({ tag: node.tagName.toLowerCase(), nth: nthOfType(node), id: "" });
      node = node.parentElement;
    }
    return path;
  }
  function cssFrom(el, path) {
    if (el.classList.length > 0) {
      const classes = Array.from(el.classList).slice(0, 3).map(cssEsc);
      const short = `${el.tagName.toLowerCase()}.${classes.join(".")}`;
      if (resolvesTo(short, el)) return short;
    }
    if (el.id) {
      const byId = `#${cssEsc(el.id)}`;
      if (resolvesTo(byId, el)) return byId;
    }
    const parts = [];
    for (const node of path) {
      if (node.id) {
        parts.unshift(`#${cssEsc(node.id)}`);
        break;
      }
      if (node.tag === "body" || node.tag === "html") break;
      parts.unshift(node.nth > 0 ? `${node.tag}:nth-of-type(${node.nth})` : node.tag);
    }
    return parts.join(" > ") || el.tagName.toLowerCase();
  }
  function xpathFrom(path) {
    const parts = [];
    let anchor = "";
    for (const node of path) {
      if (node.id) {
        anchor = `//*[@id="${node.id}"]`;
        break;
      }
      parts.unshift(node.nth > 0 ? `${node.tag}[${node.nth}]` : node.tag);
    }
    return anchor ? anchor + (parts.length ? `/${parts.join("/")}` : "") : `/${parts.join("/")}`;
  }
  var attrEsc = (value) => value.replace(/["\\]/g, "\\$&");
  function resolvesTo(selector, el) {
    try {
      return document.querySelector(selector) === el;
    } catch {
      return false;
    }
  }
  var TESTID_ATTRS = ["data-testid", "data-test", "data-test-id", "data-cy", "data-qa"];
  var selectorMs = 0;
  var SLOW_STEP_MS = 120;
  function selectorsFor(el) {
    const started = performance.now();
    const out = describeElement(el);
    selectorMs += performance.now() - started;
    return out;
  }
  function describeElement(el) {
    const out = [];
    const push = (selector) => {
      if (resolvesTo(selector, el)) out.push([selector]);
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
    const path = ancestorPath(el);
    const css = cssFrom(el, path);
    if (css) out.push([css]);
    const xp = xpathFrom(path);
    if (xp) out.push([`xpath/${xp}`]);
    if (css) out.push([`pierce/${css}`]);
    if (el.childElementCount === 0) {
      const text = norm(el.textContent);
      if (text && text.length <= 60) out.push([`text/${text.slice(0, 25)}`]);
    }
    return out;
  }
  var SPECIAL_KEYS = ["Enter", "Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
  function targetOf(event) {
    const path = event.composedPath?.();
    const el = path && path.length > 0 ? path[0] : event.target;
    return el instanceof Element ? el : null;
  }
  var scrolledContainers = /* @__PURE__ */ new Set();
  var describeCache = /* @__PURE__ */ new WeakMap();
  function describe(el) {
    const cached2 = describeCache.get(el);
    if (cached2) {
      const check = cached2.find((group) => {
        const selector = group[0];
        return selector && !selector.startsWith("aria/") && !selector.startsWith("text/") && !selector.startsWith("xpath/") && !selector.startsWith("pierce/");
      })?.[0];
      if (check && resolvesTo(check, el)) return cached2;
    }
    const fresh = selectorsFor(el);
    describeCache.set(el, fresh);
    return fresh;
  }
  function anchorFor(container) {
    const box = container.getBoundingClientRect();
    const border = parseFloat(getComputedStyle(container).borderTopWidth) || 0;
    const contentTop = box.top + border;
    const rows = container.children.length === 1 && container.firstElementChild.children.length > 1 ? Array.from(container.firstElementChild.children) : Array.from(container.children);
    for (const child of rows) {
      const rect = child.getBoundingClientRect();
      if (rect.bottom > contentTop) {
        const selectors = describe(child);
        if (selectors.length === 0) return void 0;
        return { selectors, offsetY: Math.round(contentTop - rect.top) };
      }
    }
    return void 0;
  }
  function captureScrollState() {
    const out = [];
    if (window.scrollX !== 0 || window.scrollY !== 0) {
      out.push({
        selectors: null,
        x: Math.round(window.scrollX),
        y: Math.round(window.scrollY)
      });
    }
    for (const el of scrolledContainers) {
      if (!el.isConnected) {
        scrolledContainers.delete(el);
        continue;
      }
      if (el.scrollTop === 0 && el.scrollLeft === 0) continue;
      out.push({
        selectors: describe(el),
        x: Math.round(el.scrollLeft),
        y: Math.round(el.scrollTop),
        anchor: anchorFor(el)
      });
    }
    return out;
  }
  function isPositionalOnly(selectors) {
    return selectors.every((group) => {
      const selector = group[0] ?? "";
      return !selector.startsWith("aria/") && !selector.startsWith("text/") && !selector.startsWith("[data-") && !selector.includes("[name=") && !selector.includes("[placeholder=");
    });
  }
  function record(step, el, extra) {
    stepCount++;
    updateBadge();
    const describeMs = selectorMs;
    selectorMs = 0;
    const started = performance.now();
    const rect = el?.getBoundingClientRect();
    const selectors = step.selectors ?? [];
    const meta = {
      frameChain: [],
      // filled in below, once this frame knows where it is
      tMono: monoNow(),
      rect: rect ? {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      } : void 0,
      scrollState: captureScrollState(),
      ...selectors.length > 0 && isPositionalOnly(selectors) ? { degraded: "positional-only" } : {},
      ...extra
    };
    const stateMs = performance.now() - started;
    if (describeMs + stateMs > SLOW_STEP_MS) {
      console.warn(
        `[TestFlow] recording this ${step.type} took ${Math.round(describeMs + stateMs)}ms (describing the element ${Math.round(describeMs)}ms, scroll state ${Math.round(stateMs)}ms). The page will feel sluggish while recording.`
      );
    }
    void chainReady.then((frameChain) => {
      send({ type: "cs-step", step, meta: { ...meta, frameChain } });
    });
  }
  var DRAG_THRESHOLD_PX = 5;
  var DRAG_SAMPLE_MS = 40;
  var DRAG_MAX_POINTS = 40;
  var dragState = null;
  var suppressClickUntil = 0;
  var pendingNativeDrag = null;
  document.addEventListener(
    "dragstart",
    () => {
      if (mode !== "record") return;
      pendingNativeDrag = { types: [] };
      if (dragState) dragState.moved = true;
    },
    true
    // capture: this must happen whatever the page does with the event
  );
  document.addEventListener(
    "dragstart",
    (event) => {
      if (mode !== "record" || !pendingNativeDrag) return;
      pendingNativeDrag.types = Array.from(
        event.dataTransfer?.types ?? []
      );
    },
    false
  );
  document.addEventListener(
    "drag",
    (event) => {
      if (!dragState || !event.isTrusted) return;
      if (event.clientX === 0 && event.clientY === 0) return;
      const dx = event.clientX - dragState.startClientX;
      const dy = event.clientY - dragState.startClientY;
      const now = Date.now();
      if (now - dragState.lastSampleAt >= DRAG_SAMPLE_MS && dragState.path.length < DRAG_MAX_POINTS) {
        dragState.lastSampleAt = now;
        dragState.path.push({ x: Math.round(dx), y: Math.round(dy) });
      }
    },
    true
  );
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
  function finishDrag(endX, endY) {
    const drag = dragState;
    dragState = null;
    const native = pendingNativeDrag;
    pendingNativeDrag = null;
    if (!drag || !drag.moved || mode !== "record") return;
    const dx = Math.round(endX - drag.startClientX);
    const dy = Math.round(endY - drag.startClientY);
    const last = drag.path[drag.path.length - 1];
    if (!last || last.x !== dx || last.y !== dy) drag.path.push({ x: dx, y: dy });
    flushWheel();
    record(
      {
        type: "drag",
        selectors: selectorsFor(drag.el),
        offsetX: drag.offsetX,
        offsetY: drag.offsetY,
        path: drag.path,
        duration: Date.now() - drag.startedAt
      },
      drag.el,
      native ? { nativeDrag: native } : void 0
    );
    suppressClickUntil = Date.now() + 200;
  }
  document.addEventListener(
    "pointerup",
    (event) => {
      if (!event.isTrusted) {
        dragState = null;
        return;
      }
      finishDrag(event.clientX, event.clientY);
    },
    true
  );
  document.addEventListener(
    "dragend",
    (event) => {
      if (mode !== "record" || !event.isTrusted) return;
      finishDrag(event.clientX, event.clientY);
    },
    true
  );
  document.addEventListener(
    "pointercancel",
    () => {
      if (pendingNativeDrag) return;
      dragState = null;
    },
    true
  );
  document.addEventListener(
    "click",
    (event) => {
      if (mode !== "record" || !event.isTrusted) return;
      if (Date.now() < suppressClickUntil) return;
      const el = targetOf(event);
      if (!el || el.closest("#__tf_badge")) return;
      flushWheel();
      const download = downloadFor(el);
      record(
        {
          type: "click",
          selectors: selectorsFor(el),
          offsetX: event.offsetX,
          offsetY: event.offsetY
        },
        el,
        download ? { download } : void 0
      );
    },
    true
  );
  document.addEventListener(
    "contextmenu",
    (event) => {
      if (mode !== "record" || !event.isTrusted) return;
      const el = targetOf(event);
      if (!el || el.closest("#__tf_badge")) return;
      record(
        {
          type: "click",
          button: "secondary",
          selectors: selectorsFor(el),
          offsetX: event.offsetX,
          offsetY: event.offsetY
        },
        el
      );
    },
    true
  );
  document.addEventListener(
    "dblclick",
    (event) => {
      if (mode !== "record" || !event.isTrusted) return;
      const el = targetOf(event);
      if (!el) return;
      record(
        {
          type: "doubleClick",
          selectors: selectorsFor(el),
          offsetX: event.offsetX,
          offsetY: event.offsetY
        },
        el
      );
    },
    true
  );
  function downloadFor(el) {
    const anchor = el.closest("a[download]");
    if (!anchor) return void 0;
    const explicit = anchor.getAttribute("download");
    if (explicit) return { filename: explicit };
    try {
      const name = new URL(anchor.href, location.href).pathname.split("/").pop();
      return name ? { filename: name } : void 0;
    } catch {
      return void 0;
    }
  }
  function secretNameFor(el) {
    const name = el.getAttribute("name") || el.getAttribute("id") || accName(el) || "password";
    return name.replace(/[^\w]+/g, "_").toUpperCase().slice(0, 40);
  }
  async function recordUpload(input) {
    const files = Array.from(input.files ?? []);
    const selectors = selectorsFor(input);
    if (files.length === 0) return;
    let truncated = false;
    const encoded = [];
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        truncated = true;
        encoded.push({ name: file.name, mimeType: file.type, base64: "" });
        continue;
      }
      const base64 = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? "");
          resolve(result.slice(result.indexOf(",") + 1));
        };
        reader.onerror = () => resolve("");
        reader.readAsDataURL(file);
      });
      encoded.push({ name: file.name, mimeType: file.type, base64 });
    }
    record(
      { type: "change", value: "", selectors, tagName: "input" },
      input,
      {
        upload: { files: encoded, truncated },
        ...truncated ? { degraded: "upload-truncated" } : {}
      }
    );
  }
  document.addEventListener(
    "change",
    (event) => {
      if (mode !== "record") return;
      const el = targetOf(event);
      if (!el) return;
      const tag = el.tagName;
      if (tag !== "INPUT" && tag !== "TEXTAREA" && tag !== "SELECT") return;
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      if (["checkbox", "radio", "button", "submit", "reset"].includes(type)) return;
      if (type === "file") {
        void recordUpload(el);
        return;
      }
      if (!event.isTrusted) return;
      record(
        {
          type: "change",
          // Passwords are recorded with an empty value — the secret never leaves the page.
          value: type === "password" ? "" : String(el.value ?? ""),
          selectors: selectorsFor(el),
          // Playwright codegen needs this: fill() throws on <select>. Stripped on export.
          tagName: tag.toLowerCase()
        },
        el,
        // A password step carries a NAME, not a value: replay supplies the secret and
        // says which one is missing if it cannot, instead of typing "" and passing.
        type === "password" ? { secretRef: secretNameFor(el) } : void 0
      );
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
        record({ type: "keyDown", key });
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
      record({ type: "keyDown", key: event.key });
    },
    true
  );
  document.addEventListener(
    "keyup",
    (event) => {
      if (mode !== "record" || !event.isTrusted) return;
      if (MODIFIER_KEYS.includes(event.key)) {
        if (openModifiers.delete(event.key)) {
          record({ type: "keyUp", key: event.key });
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
    record(
      {
        type: "wheel",
        selectors: selectorsFor(acc.el),
        deltaX: Math.round(acc.deltaX),
        deltaY: Math.round(acc.deltaY),
        offsetX: acc.offsetX,
        offsetY: acc.offsetY
      },
      acc.el
    );
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
      if (event.target instanceof Element) scrolledContainers.add(event.target);
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
            record(
              {
                type: "scroll",
                selectors: selectorsFor(target),
                x: Math.round(target.scrollLeft),
                y: Math.round(target.scrollTop)
              },
              target
            );
          } else {
            record({
              type: "scroll",
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
  function resolveEl(groups, timeoutMs) {
    const started = Date.now();
    return new Promise((resolve) => {
      const poll = () => {
        const el = resolveInPage({ selectors: groups });
        if (el) return resolve(el);
        if (Date.now() - started > timeoutMs) return resolve(null);
        setTimeout(poll, 120);
      };
      poll();
    });
  }
  function restoreScrollState(state) {
    for (const entry of state ?? []) {
      if (!entry.selectors) {
        window.scrollTo(entry.x, entry.y);
        continue;
      }
      const el = resolveInPage({ selectors: entry.selectors });
      if (el) el.scrollTo(entry.x, entry.y);
    }
  }
  function waitForExpression(expression, timeoutMs) {
    let seq = 0;
    const evaluate = () => new Promise((resolve) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        window.removeEventListener("__tf_expr_result", onResult);
        resolve({ ok: false, value: false, error: "main world did not answer" });
      }, 1e3);
      function onResult(event) {
        try {
          const detail = event.detail;
          if (typeof detail !== "string") return;
          const payload = JSON.parse(detail);
          if (payload.id !== id) return;
          clearTimeout(timer);
          window.removeEventListener("__tf_expr_result", onResult);
          resolve(payload);
        } catch {
        }
      }
      window.addEventListener("__tf_expr_result", onResult);
      window.dispatchEvent(
        new CustomEvent("__tf_expr", { detail: JSON.stringify({ id, expression }) })
      );
    });
    const started = Date.now();
    return new Promise((resolve) => {
      const poll = async () => {
        const known = evaluateKnownExpression(expression);
        const result = known === void 0 ? await evaluate() : { ok: true, value: known, error: void 0 };
        if (result.ok && result.value) return resolve({ ok: true });
        if (Date.now() - started > timeoutMs) {
          const cspBlocked = (result.error ?? "").includes("unsafe-eval");
          return resolve({
            ok: false,
            error: cspBlocked ? "this page's Content-Security-Policy forbids evaluating expressions, and this one is not a recorded route assertion. Replay it in Playwright, or run it in a tab the extension can attach its debugger to." : result.error ?? "expression never became true"
          });
        }
        setTimeout(() => void poll(), 120);
      };
      void poll();
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
  async function execStep(step, meta) {
    if (meta?.scrollState?.length && step.type !== "scroll") {
      restoreScrollState(meta.scrollState);
    }
    if (meta?.dialog) armDialog(meta.dialog);
    if (meta?.upload) {
      return {
        ok: false,
        error: "file uploads cannot be replayed in-browser \u2014 run this flow in Playwright"
      };
    }
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
      case "waitForExpression":
        return waitForExpression(step.expression ?? "true", budgetOf(step));
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
        if (meta?.secretRef) {
          return {
            ok: false,
            error: `this step needs the secret "${meta.secretRef}", which is not stored in the flow \u2014 replay it in Playwright: npm run flow -- <file> --secret ${meta.secretRef}=\u2026`
          };
        }
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
  async function locate(step, meta, pointOnly) {
    if (!pointOnly) {
      if (meta?.scrollState?.length && step.type !== "scroll") {
        restoreScrollState(meta.scrollState);
      }
      if (meta?.dialog) armDialog(meta.dialog);
    }
    const el = await resolveEl(step.selectors ?? [], pointOnly ? 350 : budgetOf(step));
    if (!el) return { ok: false, error: "no selector matched" };
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return { ok: false, error: "element has no layout box" };
    }
    const outside = rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
    if (outside) {
      try {
        el.scrollIntoView({ block: "center", inline: "center" });
      } catch {
      }
      await sleep(60);
    }
    const box = el.getBoundingClientRect();
    const within = (value, size) => typeof value === "number" && value >= 0 && value <= size ? value : size / 2;
    const localX = box.left + within(step.offsetX, box.width);
    const localY = box.top + within(step.offsetY, box.height);
    const hit = pointOnly ? null : document.elementFromPoint(localX, localY);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) {
      const id = hit.id ? `#${hit.id}` : "";
      const cls = hit.classList.length ? `.${hit.classList[0]}` : "";
      return {
        ok: false,
        error: `${hit.tagName.toLowerCase()}${id}${cls} is on top of the target, so the input would land on that instead`
      };
    }
    const offset = await myViewportOffset();
    const x = offset.x + localX;
    const y = offset.y + localY;
    return {
      ok: true,
      x: Math.round(x),
      y: Math.round(y),
      // Drag paths are recorded relative to the start point, so they need no
      // conversion beyond the origin the caller already has.
      path: step.path
    };
  }
  function setMode(next) {
    const wasOff = mode === "off";
    mode = next;
    if (mode === "off") {
      removeBadge();
      removeCursor();
      return;
    }
    if (wasOff) chainReady = myFrameChain();
    if (mode === "replay") armDialog(void 0);
    installBadge();
    if (mode === "replay" && window.top === window) installCursor();
  }
  initFrames({ isActive: () => mode !== "off", selectorsFor });
  chrome.runtime.onMessage.addListener(
    (message, _sender, sendResponse) => {
      if (message.type === "cs-set-mode") {
        setMode(message.mode);
        sendResponse({ ok: true });
        return false;
      }
      if (message.type === "cs-run") {
        void execStep(message.step, message.meta).then((result) => sendResponse(result));
        return true;
      }
      if (message.type === "cs-locate") {
        void locate(message.step, message.meta, message.pointOnly).then(
          (result) => sendResponse(result)
        );
        return true;
      }
      if (message.type === "cs-cursor") {
        if (window.top !== window) {
          sendResponse({ ok: true });
          return false;
        }
        if (message.action === "hide") {
          removeCursor();
          sendResponse({ ok: true });
          return false;
        }
        if (message.action === "pulse") {
          pulseCursor();
          sendResponse({ ok: true });
          return false;
        }
        if (message.action === "install") {
          installCursor();
          sendResponse({ ok: true, ...cursorPosition() });
          return false;
        }
        if (message.action === "place") {
          placeCursor(message.x ?? 0, message.y ?? 0);
          sendResponse({ ok: true });
          return false;
        }
        void moveCursorTo(
          message.x ?? 0,
          message.y ?? 0,
          message.durationMs ?? CURSOR_GLIDE_MS
        ).then(() => sendResponse({ ok: true }));
        return true;
      }
      return false;
    }
  );
  var lastRouteUrl = location.href;
  window.addEventListener("__tf_dialog", (event) => {
    if (mode !== "record") return;
    try {
      const detail = event.detail;
      if (typeof detail !== "string") return;
      send({ type: "cs-dialog", dialog: JSON.parse(detail) });
    } catch {
    }
  });
  function armDialog(dialog) {
    try {
      window.dispatchEvent(
        new CustomEvent("__tf_dialog_answer", {
          detail: JSON.stringify({
            replay: true,
            accept: dialog?.accept,
            promptText: dialog?.promptText
          })
        })
      );
    } catch {
    }
  }
  window.addEventListener("__tf_route", (event) => {
    if (mode !== "record") return;
    if (window.top !== window) return;
    try {
      const detail = event.detail;
      if (typeof detail !== "string") return;
      const payload = JSON.parse(detail);
      if (payload.url === lastRouteUrl) return;
      lastRouteUrl = payload.url;
      send({
        type: "cs-route",
        url: payload.url,
        title: payload.title,
        tMono: monoNow()
      });
    } catch {
    }
  });
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
    const isTop = window.top === window;
    void chainReady.then(async (frameChain) => {
      let env = isTop && mode !== "off" ? captureEnv() : void 0;
      if (env) {
        env = { ...env, permissions: await capturePermissions() };
      }
      send({
        type: "cs-ready",
        url: location.href,
        title: document.title,
        width: window.innerWidth,
        height: window.innerHeight,
        dpr: window.devicePixelRatio || 1,
        frameChain,
        tMono: monoNow(),
        env
      });
    });
    if (mode !== "off") installBadge();
    if (!isTop) return;
    if (mode === "replay") installCursor();
    lastRouteUrl = location.href;
    const settle = () => send({ type: "cs-settled", url: location.href });
    if (document.readyState === "complete") settle();
    else window.addEventListener("load", settle, { once: true });
  }
  void chrome.runtime.sendMessage({ type: "cs-get-mode" }).then((reply) => {
    setMode(reply?.mode ?? "off");
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", announce);
    } else {
      announce();
    }
  }).catch(() => {
  });
})();
