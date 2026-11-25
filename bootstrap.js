/* ScreenZot - Zotero 7-10 plugin
 * Button in the reader toolbar + shortcut Ctrl/Cmd+Shift+S.
 * Drag a rectangle on the PDF and choose: Copy, Save PNG, Note.
 */

var Snap = {
  id: null,
  handler: null,
  buttons: new Set(),
  keyHooks: [], // {win, fn}
  hookedWins: new WeakSet(),
  timers: new Set(),
  _lastReq: 0,
  btnReader: new WeakMap(),
  pointerWins: new WeakSet(),
  log(msg) {
    try { Zotero.debug("[PDF Snapshot] " + msg); } catch (e) {}
  },
  PREF_NATIVE: "extensions.pdf-snapshot.nativeNotifications",

  // Timers are attached to the main window because bootstrap-scoped setTimeout is not guaranteed.
  later(fn, ms) {
    const w = Zotero.getMainWindow();
    const id = w.setTimeout(() => {
      this.timers.delete(id);
      try {
        fn();
      } catch (e) {
        Zotero.logError(e);
      }
    }, ms);
    this.timers.add(id);
    return id;
  },

  // ---------- lifecycle ----------
  init(id) {
    this.id = id;
    this.handler = (event) => this.onRenderToolbar(event);
    Zotero.Reader.registerEventListener("renderToolbar", this.handler, id);
    // Second entry point: context menu item on right-click over PDF
    // Second entry point: menu item shown when right-clicking the PDF.
    try {
      this.ctxHandler = (event) => {
        const { reader, append } = event;
        if (!this.isPDF(reader)) return;
        append({
          label: "Cattura area del PDF… (Ctrl+Maiusc+S)",
          onCommand: () => {
            this.log("voce di menu contestuale scelta");
            this.requestCapture(reader);
          },
        });
      };
      Zotero.Reader.registerEventListener("createViewContextMenu", this.ctxHandler, id);
    } catch (e) {
      this.log("menu contestuale non registrato: " + e);
    }
    // Hook the shortcut for readers that are already open.
    try {
      for (const reader of Zotero.Reader._readers || []) this.hookShortcut(reader);
    } catch (e) {
      Zotero.logError(e);
    }
    // Already open readers: at least hook the shortcut
    try {
      for (const reader of Zotero.Reader._readers || []) this.hookShortcut(reader);
    } catch (e) {
      Zotero.logError(e);
    }
  },

  shutdown() {
    try {
      Zotero.Reader.unregisterEventListener("renderToolbar", this.handler);
    } catch (e) {}
    try {
      if (this.ctxHandler) Zotero.Reader.unregisterEventListener("createViewContextMenu", this.ctxHandler);
    } catch (e) {}
    for (const b of this.buttons) {
      try { b.remove(); } catch (e) {}
    }
    this.buttons.clear();
    for (const entry of this.keyHooks) {
      try { entry.win.removeEventListener(entry.type || "keydown", entry.fn, true); } catch (e) {}
    }
    this.keyHooks = [];
    try {
      const w = Zotero.getMainWindow();
      for (const t of this.timers) w.clearTimeout(t);
    } catch (e) {}
    this.timers.clear();
  },

  // ---------- reader integration ----------
  isPDF(reader) {
    return reader && reader._item && reader._item.attachmentContentType === "application/pdf";
  },

  onRenderToolbar({ reader, doc, append }) {
    if (!this.isPDF(reader)) return;

    const btn = doc.createElement("button");
    btn.className = "toolbarButton";
    btn.tabIndex = -1;
    // no title attribute: native tooltip might absorb first click
    btn.setAttribute("aria-label", "Capture PDF area (Ctrl/Cmd+Shift+S)");
    btn.append(this.makeIcon(doc));
    this.log("Button created in toolbar");
    const go = (e) => {
      this.log("Event " + e.type + " on button (button=" + e.button + ", connected=" + btn.isConnected + ")");
      if (e.type !== "click" && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.requestCapture(reader);
    };
    btn.addEventListener("pointerenter", () => {
      this.log("pointerenter on button -> focus reader");
      try {
        doc.defaultView.focus();
        btn.focus({ preventScroll: true });
      } catch (e) {}
    });
    btn.addEventListener("pointerdown", go, true);
    btn.addEventListener("mousedown", go, true);
    btn.addEventListener("click", go, true);
    append(btn);
    this.buttons.add(btn);
    this.btnReader.set(btn, reader);
    this.hookPointer(doc.defaultView);

    this.hookShortcut(reader);
  },

  makeIcon(doc) {
    // Choose an explicit color based on the reader's actual background.
    let dark = false;
    try {
      const win = doc.defaultView;
      const bg = win.getComputedStyle(doc.body).backgroundColor || "";
      const m = bg.match(/[\d.]+/g);
      if (m && m.length >= 3 && (m.length < 4 || parseFloat(m[3]) > 0.5)) {
        dark = 0.299 * m[0] + 0.587 * m[1] + 0.114 * m[2] < 128;
      } else {
        dark = win.matchMedia("(prefers-color-scheme: dark)").matches;
      }
    } catch (e) {}
    const color = dark ? "#f1f3f4" : "#202124";

    const NS = "http://www.w3.org/2000/svg";
    const svg = doc.createElementNS(NS, "svg");
    svg.setAttribute("width", "16");
    svg.setAttribute("height", "16");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", color);
    svg.setAttribute("stroke-width", "1.8");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.style.opacity = "1";
    svg.style.color = color;
    // Selection frame corners and a filled center point.
    const p = doc.createElementNS(NS, "path");
    p.setAttribute("d", "M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5");
    const c = doc.createElementNS(NS, "circle");
    c.setAttribute("cx", "8");
    c.setAttribute("cy", "8");
    c.setAttribute("r", "1.7");
    c.setAttribute("fill", color);
    c.setAttribute("stroke", "none");
    svg.append(p, c);
    return svg;
  },

  hookPointer(win) {
    if (!win || this.pointerWins.has(win)) return;
    this.pointerWins.add(win);
    const fn = (e) => {
      if (e.button !== 0) return;
      for (const b of this.buttons) {
        if (!b.isConnected || b.ownerDocument !== win.document) continue;
        const r = b.getBoundingClientRect();
        if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
          const reader = this.btnReader.get(b);
          if (reader) this.requestCapture(reader);
          return;
        }
      }
    };
    for (const type of ["pointerdown", "mousedown", "click"]) {
      win.addEventListener(type, fn, true);
      this.keyHooks.push({ win, fn, type });
    }
  },

  getViewWindow(reader) {
    try {
      const w = reader._internalReader?._primaryView?._iframeWindow;
      if (w && w.document) return w;
    } catch (e) {}
    try {
      const f = reader._iframeWindow?.document.querySelector("iframe");
      if (f && f.contentWindow) return f.contentWindow;
    } catch (e) {}
    return null;
  },

  hookShortcut(reader) {
    if (!this.isPDF(reader)) return;
    let tries = 0;
    const attempt = () => {
      const wins = [reader._iframeWindow, this.getViewWindow(reader)].filter(Boolean);
      for (const win of wins) {
        if (this.hookedWins.has(win)) continue;
        const fn = (e) => {
          if (
            (e.ctrlKey || e.metaKey) &&
            e.shiftKey &&
            !e.altKey &&
            e.code === "KeyS"
          ) {
            e.preventDefault();
            e.stopPropagation();
            this.requestCapture(reader);
          }
        };
        win.addEventListener("keydown", fn, true);
        this.hookedWins.add(win);
        this.keyHooks.push({ win, fn });
      }
      // internal view may appear after toolbar: retry for a few seconds
      // The internal view may appear after the toolbar; retry for a few seconds.
      if (!this.getViewWindow(reader) && tries++ < 20) {
        this.later(attempt, 500);
      }
    };
    attempt();
  },

  // ---------- selection ----------
  // ---------- selection ----------
  // Single entry point that prevents duplicate requests and retries if the PDF
  // window is not ready when the first capture attempt starts.
  requestCapture(reader) {
    const now = Date.now();
    if (now - this._lastReq < 400) {
      this.log("Request ignored (deduplicate)");
      return;
    }
    this._lastReq = now;
    const attempt = (n) => {
      let ok = false;
      this.log("Opening, attempt " + n);
      try {
        ok = this.startCapture(reader, n < 3);
        this.log("Attempt " + n + " -> " + (ok ? "overlay opened" : "failed"));
      } catch (e) {
        Zotero.logError(e);
        Zotero.debug("[PDF Snapshot] error opening, attempt " + n + ": " + e);
        if (n >= 3) this.notify("Error: " + (e && e.message ? e.message : e));
      }
      if (!ok && n < 3) this.later(() => attempt(n + 1), 150);
    };
    attempt(0);
  },

  shape: "rect", // Last used shape: "rect" | "ellipse" | "free" | "poly".

  startCapture(reader, quiet) {
    const win = this.getViewWindow(reader);
    const doc = win && win.document;
    this.log("startCapture: view=" + !!win + ", canvas=" + (doc ? this.pageCanvases(doc).length : "n/a") +
      ", overlay already present=" + !!(doc && doc.getElementById("pdf-snapshot-overlay")));
    if (!doc || !this.pageCanvases(doc).length) {
      this.log("No pages available (view: " + !!win + ")");
      if (!quiet) this.notify("No PDF pages visible to capture.");
      return false;
    }
    if (doc.getElementById("pdf-snapshot-overlay")) return true;

    const MIN = 12; // minimum selection size (px)
    const TOL = 8; // tolerance for grabbing edges/corners (px)
    const BLUE = "#0a84ff";
    const SVGNS = "http://www.w3.org/2000/svg";
    const clamp = (v, a, b) => Math.min(Math.max(v, a), b);

    const overlay = doc.createElement("div");
    overlay.id = "pdf-snapshot-overlay";
    overlay.tabIndex = -1;
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483000;cursor:crosshair;" +
      "background:rgba(0,0,0,.18);user-select:none;-moz-user-select:none;";

    // rectangle/ellipse box: giant shadow darkens outside
    const box = doc.createElement("div");
    box.style.cssText =
      "position:fixed;display:none;box-sizing:border-box;pointer-events:none;" +
      `border:2px dashed ${BLUE};box-shadow:0 0 0 9999px rgba(0,0,0,.35);`;
    overlay.append(box);

    // 8 resize handles (graphics only: hit-test is manual)
    const handles = [];
    for (const d of ["nw", "n", "ne", "e", "se", "s", "sw", "w"]) {
      const h = doc.createElement("div");
      const left = d.includes("w") ? "-6px" : d.includes("e") ? "calc(100% - 4px)" : "calc(50% - 5px)";
      const top = d.includes("n") ? "-6px" : d.includes("s") ? "calc(100% - 4px)" : "calc(50% - 5px)";
      h.style.cssText =
        `position:absolute;left:${left};top:${top};width:10px;height:10px;` +
        `box-sizing:border-box;background:#fff;border:2px solid ${BLUE};border-radius:2px;display:none;`;
      box.append(h);
      handles.push(h);
    }

    // SVG layer for freehand/polygon (with outside darkening via evenodd)
    const svg = doc.createElementNS(SVGNS, "svg");
    svg.setAttribute("width", "100%");
    svg.setAttribute("height", "100%");
    svg.style.cssText = "position:fixed;inset:0;pointer-events:none;display:none;";
    const path = doc.createElementNS(SVGNS, "path");
    path.setAttribute("fill-rule", "evenodd");
    path.setAttribute("fill", "rgba(0,0,0,.35)");
    path.setAttribute("stroke", BLUE);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linejoin", "round");
    path.setAttribute("stroke-dasharray", "7 5");
    svg.append(path);
    // vertex markers for polygon
    const vgroup = doc.createElementNS(SVGNS, "g");
    vgroup.setAttribute("fill", "#fff");
    vgroup.setAttribute("stroke", BLUE);
    vgroup.setAttribute("stroke-width", "2");
    svg.append(vgroup);
    overlay.append(svg);

    // state
    let shape = this.shape || "rect";
    let rect = null; // bounding box {l,t,r,b} (for all shapes)
    let pts = null; // freehand points [{x,y}]
    let locked = false; // selection confirmed (action bar visible)
    let mode = null; // "draw" | "move" | "resize"
    let dir = "";
    let sx = 0, sy = 0, orig = null, origPts = null, dragIdx = -1;
    let finished = false;

    const vw = () => win.innerWidth;
    const vh = () => win.innerHeight;
    const asRect = () => ({
      left: rect.l,
      top: rect.t,
      right: rect.r,
      bottom: rect.b,
      width: rect.r - rect.l,
      height: rect.b - rect.t,
    });
    const bboxOf = (p) => {
      let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
      for (const q of p) {
        l = Math.min(l, q.x); t = Math.min(t, q.y);
        r = Math.max(r, q.x); b = Math.max(b, q.y);
      }
      return { l, t, r, b };
    };
    const inPoly = (x, y, p) => {
      let inside = false;
      for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
        const a = p[i], b = p[j];
        if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
      }
      return inside;
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cleanup();
      } else if (locked && (e.key === "Enter" || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c"))) {
        e.preventDefault();
        e.stopPropagation();
        choose("copy");
      }
    };
    const cleanup = () => {
      this.log("Overlay closed by: " + (new Error().stack || "").split("\n").slice(1, 4).join(" | "));
      finished = true;
      doc.removeEventListener("keydown", onKey, true);
      overlay.remove();
    };
    const choose = async (action) => {
      if (finished || !rect) return;
      if (shape === "poly" && (!pts || pts.length < 3)) return;
      const r = asRect();
      const shapeInfo = {
        type: shape,
        points: (shape === "free" || shape === "poly") && pts ? pts.map((p) => ({ x: p.x, y: p.y })) : null,
      };
      cleanup();
      await this.run(action, reader, doc, r, shapeInfo);
    };

    const bar = this.makeActionBar(doc, choose, cleanup);
    overlay.append(bar);
    bar.addEventListener("mousedown", (e) => e.stopPropagation());
    bar.addEventListener("mouseup", (e) => e.stopPropagation());

    // ----- shape toolbar + close button
    const tools = doc.createElement("div");
    tools.style.cssText =
      "position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;" +
      "align-items:center;gap:2px;padding:4px;border-radius:8px;background:#202124;" +
      "box-shadow:0 2px 10px rgba(0,0,0,.4);font:13px system-ui,sans-serif;z-index:2;";
    tools.addEventListener("mousedown", (e) => e.stopPropagation());
    tools.addEventListener("mouseup", (e) => e.stopPropagation());
    const toolBtns = {};
    const setShape = (name) => {
      if (name === shape && rect) return;
      const toFree = name === "free" || name === "poly";
      const fromFree = shape === "free" || shape === "poly";
      shape = name;
      this.shape = name;
      if (toFree || fromFree) {
        rect = null;
        pts = null;
        locked = false;
      }
      render();
    };
    for (const [name, label, tip] of [
      ["rect", "▭ Rectangle", "Rectangular area"],
      ["ellipse", "◯ Ellipse", "Elliptical area"],
      ["poly", "⬡ Polygon", "Click to add vertices"],
      ["free", "✎ Freehand", "Draw a freehand outline"],
    ]) {
      const b = doc.createElement("button");
      b.textContent = label;
      b.title = tip;
      b.style.cssText = "all:unset;cursor:pointer;padding:5px 10px;border-radius:5px;color:#fff;";
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        setShape(name);
      });
      tools.append(b);
      toolBtns[name] = b;
    }
    const tip = doc.createElement("span");
    tip.style.cssText = "color:#9aa0a6;padding:0 8px 0 10px;font-size:12px;";
    tools.append(tip);
    // close button (X) always visible, next to the tools
    const closeBtn = doc.createElement("button");
    closeBtn.textContent = "✕";
    closeBtn.title = "Cancel (Esc)";
    closeBtn.style.cssText =
      "all:unset;cursor:pointer;width:28px;height:28px;border-radius:5px;color:#fff;" +
      "display:flex;align-items:center;justify-content:center;margin-left:4px;";
    closeBtn.addEventListener("mouseenter", () => (closeBtn.style.background = "#5f6368"));
    closeBtn.addEventListener("mouseleave", () => (closeBtn.style.background = ""));
    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cleanup();
    });
    tools.append(closeBtn);
    overlay.append(tools);

    const updateTip = () => {
      tip.textContent = shape === "poly" ? "Click to add vertices, click first vertex to close" : "Esc to cancel";
    };
    updateTip();
    const render = () => {
      for (const [n, b] of Object.entries(toolBtns)) {
        b.style.background = n === shape ? "#0a84ff" : "";
      }
      overlay.style.background = rect ? "transparent" : "rgba(0,0,0,.18)";
      updateTip();

      if (!rect) {
        box.style.display = "none";
        svg.style.display = "none";
        bar.style.display = "none";
        return;
      }
      if (shape === "free" || shape === "poly") {
        box.style.display = "none";
        svg.style.display = "block";
        const W = vw(), H = vh();
        let d = `M0 0H${W}V${H}H0Z`;
        if (shape === "free" && pts && pts.length > 1) d += " M" + pts.map((p) => `${p.x} ${p.y}`).join(" L") + " Z";
        else if (shape === "poly" && pts && pts.length > 1) {
          d += " M" + pts.map((p) => `${p.x} ${p.y}`).join(" L");
          if (pts.length > 2) d += " Z";
        }
        path.setAttribute("d", d);
        // draw vertex markers for polygon
        while (vgroup.firstChild) vgroup.removeChild(vgroup.firstChild);
        if (shape === "poly" && pts && pts.length) {
          for (let i = 0; i < pts.length; i++) {
            const p = pts[i];
            const c = doc.createElementNS(SVGNS, "circle");
            c.setAttribute("cx", p.x);
            c.setAttribute("cy", p.y);
            c.setAttribute("r", i === 0 ? 6 : 4);
            if (i === 0) c.setAttribute("stroke-dasharray", "3 2");
            vgroup.append(c);
          }
        }
      } else {
        svg.style.display = "none";
        box.style.display = "block";
        box.style.borderRadius = shape === "ellipse" ? "50%" : "0";
        Object.assign(box.style, {
          left: rect.l + "px",
          top: rect.t + "px",
          width: rect.r - rect.l + "px",
          height: rect.b - rect.t + "px",
        });
        for (const h of handles) h.style.display = locked ? "block" : "none";
      }
      if (locked) {
        bar.style.display = "flex";
        this.positionBar(bar, asRect(), win);
      } else {
        bar.style.display = "none";
      }
    };

    // what is under mouse? handle/border, interior, or nothing
    // what is under mouse? handle/border, interior, or nothing
    const hitTest = (x, y) => {
      if (!rect || !locked) return null;
      if (shape === "free") {
        return inPoly(x, y, pts) ? { type: "move" } : null;
      }
      if (shape === "poly") {
        return inPoly(x, y, pts) ? { type: "move" } : null;
      }
      const inX = x >= rect.l - TOL && x <= rect.r + TOL;
      const inY = y >= rect.t - TOL && y <= rect.b + TOL;
      const v =
        inX && Math.abs(y - rect.t) <= TOL ? "n" :
        inX && Math.abs(y - rect.b) <= TOL ? "s" : "";
      const hz =
        inY && Math.abs(x - rect.l) <= TOL ? "w" :
        inY && Math.abs(x - rect.r) <= TOL ? "e" : "";
      if (v || hz) return { type: "resize", dir: v + hz };
      if (x > rect.l && x < rect.r && y > rect.t && y < rect.b) return { type: "move" };
      return null;
    };
    const CURSORS = {
      n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize",
      ne: "nesw-resize", sw: "nesw-resize", nw: "nwse-resize", se: "nwse-resize",
    };
    const updateCursor = (x, y) => {
      const h = hitTest(x, y);
      overlay.style.cursor = !h ? "crosshair" : h.type === "move" ? "move" : CURSORS[h.dir];
    };

    doc.addEventListener("keydown", onKey, true);

    overlay.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const x = clamp(e.clientX, 0, vw());
      const y = clamp(e.clientY, 0, vh());
      const h = hitTest(x, y);
      if (shape === "poly" && pts && pts.length >= 3) {
        const first = pts[0];
        if (Math.hypot(x - first.x, y - first.y) <= TOL + 4) {
          // close polygon by clicking near first vertex
          locked = true;
          mode = null;
          render();
          return;
        }
        // drag a vertex
        let idx = -1;
        for (let i = 0; i < pts.length; i++) {
          if (Math.hypot(x - pts[i].x, y - pts[i].y) <= TOL + 4) { idx = i; break; }
        }
        if (idx >= 0) {
          mode = "drag";
          dragIdx = idx;
          sx = x; sy = y;
          origPts = pts.map((p) => ({ x: p.x, y: p.y }));
          return;
        }
      }
      if (h && h.type === "resize") {
        mode = "resize";
        dir = h.dir;
      } else if (h && h.type === "move") {
        mode = "move";
      } else if (shape === "poly" && pts && !locked) {
        // add a vertex to the existing polygon (or start it on first click)
        mode = "draw";
        locked = false;
        pts.push({ x, y });
        rect = bboxOf(pts);
        sx = x;
        sy = y;
        origPts = pts.map((p) => ({ x: p.x, y: p.y }));
        render();
        return;
      } else {
        // new selection
        mode = "draw";
        locked = false;
        if (shape === "free" || shape === "poly") {
          pts = [{ x, y }];
          rect = { l: x, t: y, r: x, b: y };
        } else {
          rect = { l: x, t: y, r: x, b: y };
        }
      }
      sx = x;
      sy = y;
      orig = { ...rect };
      origPts = pts ? pts.map((p) => ({ x: p.x, y: p.y })) : null;
      render();
    });

    overlay.addEventListener("mousemove", (e) => {
      const x = clamp(e.clientX, 0, vw());
      const y = clamp(e.clientY, 0, vh());
      if (!mode) {
        updateCursor(x, y);
        return;
      }
      // while drawing a polygon, show "pointer" when hovering the first vertex (to close)
      if (mode === "draw" && shape === "poly" && pts && pts.length >= 3) {
        const first = pts[0];
        overlay.style.cursor = Math.hypot(x - first.x, y - first.y) <= TOL + 4 ? "pointer" : "crosshair";
      }
      const dx = x - sx;
      const dy = y - sy;
      if (mode === "draw") {
        if (shape === "free") {
          const last = pts[pts.length - 1];
          if (Math.hypot(x - last.x, y - last.y) >= 2) pts.push({ x, y });
          rect = bboxOf(pts);
        } else if (shape === "poly") {
          // preview line from last vertex to cursor is drawn via SVG path (last point = cursor)
          pts[pts.length - 1] = { x, y };
          rect = bboxOf(pts);
        } else {
          rect = { l: Math.min(sx, x), t: Math.min(sy, y), r: Math.max(sx, x), b: Math.max(sy, y) };
        }
      } else if (mode === "move") {
        const w = orig.r - orig.l;
        const h = orig.b - orig.t;
        const l = clamp(orig.l + dx, 0, vw() - w);
        const t = clamp(orig.t + dy, 0, vh() - h);
        rect = { l, t, r: l + w, b: t + h };
        if (shape === "free" && origPts) {
          const ex = l - orig.l, ey = t - orig.t;
          pts = origPts.map((p) => ({ x: p.x + ex, y: p.y + ey }));
        } else if (shape === "poly" && origPts) {
          const ex = l - orig.l, ey = t - orig.t;
          pts = origPts.map((p) => ({ x: p.x + ex, y: p.y + ey }));
        }
      } else if (mode === "drag") {
        pts[dragIdx] = { x: clamp(x, 0, vw()), y: clamp(y, 0, vh()) };
        rect = bboxOf(pts);
      } else if (mode === "resize") {
        let { l, t, r, b } = orig;
        if (dir.includes("w")) l = clamp(orig.l + dx, 0, orig.r - MIN);
        if (dir.includes("e")) r = clamp(orig.r + dx, orig.l + MIN, vw());
        if (dir.includes("n")) t = clamp(orig.t + dy, 0, orig.b - MIN);
        if (dir.includes("s")) b = clamp(orig.b + dy, orig.t + MIN, vh());
        rect = { l, t, r, b };
      }
      render();
    });

    overlay.addEventListener("mouseup", (e) => {
      if (!mode) return;
      if (mode === "draw") {
        if (shape === "poly") {
          // vertex already committed on mousedown; just reset mode
          mode = null;
          render();
          return;
        }
        const tooSmall = rect.r - rect.l < MIN || rect.b - rect.t < MIN;
        const tooFew = shape === "free" && (!pts || pts.length < 3);
        if (tooSmall || tooFew) {
          // click without drag: restart
          rect = null;
          pts = null;
          locked = false;
        } else {
          locked = true;
        }
      }
      mode = null;
      render();
      if (rect) updateCursor(clamp(e.clientX, 0, vw()), clamp(e.clientY, 0, vh()));
    });

    render();
    doc.body.append(overlay);
    overlay.focus();
    return true;
  },

  makeActionBar(doc, onAction, onCancel) {
    const bar = doc.createElement("div");
    bar.style.cssText =
      "position:fixed;display:none;gap:4px;padding:4px;border-radius:8px;" +
      "background:#202124;box-shadow:0 2px 10px rgba(0,0,0,.4);" +
      "font:13px system-ui,sans-serif;z-index:1;";
    const mk = (label, action) => {
      const b = doc.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "all:unset;cursor:pointer;padding:5px 10px;border-radius:5px;color:#fff;";
      b.addEventListener("mouseenter", () => (b.style.background = "#3c4043"));
      b.addEventListener("mouseleave", () => (b.style.background = ""));
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (action) onAction(action);
        else onCancel();
      });
      return b;
    };
    bar.append(
      mk("Copy", "copy"),
      mk("Save PNG…", "save"),
      mk("Note", "note"),
      mk("✕", null)
    );
    return bar;
  },

  positionBar(bar, r, win) {
    const vw = win.innerWidth;
    const vh = win.innerHeight;
    const bw = bar.offsetWidth || 260;
    const bh = bar.offsetHeight || 36;
    const x = Math.min(Math.max(r.right - bw, 8), Math.max(8, vw - bw - 8));
    let y = r.bottom + 8; // below selection
    if (y + bh > vh - 8) y = r.top - bh - 8; // otherwise above
    if (y < 8) y = Math.max(8, r.bottom - bh - 8); // otherwise inside
    bar.style.left = x + "px";
    bar.style.top = y + "px";
  },

  // ---------- capture ----------
  pageCanvases(doc) {
    let list = [...doc.querySelectorAll(".canvasWrapper canvas")];
    if (!list.length) list = [...doc.querySelectorAll(".page canvas")];
    return list;
  },

  async capture(doc, r, shape) {
    const parts = [];
    for (const c of this.pageCanvases(doc)) {
      const cr = c.getBoundingClientRect();
      const x1 = Math.max(r.left, cr.left);
      const y1 = Math.max(r.top, cr.top);
      const x2 = Math.min(r.right, cr.right);
      const y2 = Math.min(r.bottom, cr.bottom);
      if (x2 <= x1 || y2 <= y1 || !cr.width || !cr.height) continue;
      parts.push({ c, cr, x1, y1, x2, y2, sx: c.width / cr.width, sy: c.height / cr.height });
    }
    if (!parts.length) return null;

    const scale = Math.max(...parts.map((p) => p.sx)); // Includes devicePixelRatio and zoom.
    const out = doc.createElement("canvas");
    out.width = Math.max(1, Math.round(r.width * scale));
    out.height = Math.max(1, Math.round(r.height * scale));
    const ctx = out.getContext("2d");
    ctx.save();
      if (shape.type === "ellipse") {
        ctx.beginPath();
        ctx.ellipse(out.width / 2, out.height / 2, out.width / 2, out.height / 2, 0, 0, Math.PI * 2);
        ctx.clip();
      } else if (shape.type === "free" && shape.points && shape.points.length > 2) {
        ctx.beginPath();
        shape.points.forEach((p, i) => {
          const X = (p.x - r.left) * scale;
          const Y = (p.y - r.top) * scale;
          if (i) ctx.lineTo(X, Y);
          else ctx.moveTo(X, Y);
        });
        ctx.closePath();
        ctx.clip();
      } else if (shape.type === "poly" && shape.points && shape.points.length >= 3) {
        ctx.beginPath();
        shape.points.forEach((p, i) => {
          const X = (p.x - r.left) * scale;
          const Y = (p.y - r.top) * scale;
          if (i) ctx.lineTo(X, Y);
          else ctx.moveTo(X, Y);
        });
        ctx.closePath();
        ctx.clip();
      }
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, out.width, out.height);

    for (const p of parts) {
      ctx.drawImage(
        p.c,
        (p.x1 - p.cr.left) * p.sx,
        (p.y1 - p.cr.top) * p.sy,
        (p.x2 - p.x1) * p.sx,
        (p.y2 - p.y1) * p.sy,
        (p.x1 - r.left) * scale,
        (p.y1 - r.top) * scale,
        (p.x2 - p.x1) * scale,
        (p.y2 - p.y1) * scale
      );
    }
    ctx.restore();
    const blob = await new Promise((res) => out.toBlob(res, "image/png"));
    return blob;
  },

};

// ---------- hook bootstrap Zotero ----------
function install() {}

async function startup({ id, rootURI }) {
  await Zotero.initializationPromise;
  const baseURI = typeof rootURI === "string" ? Services.io.newURI(rootURI) : rootURI;
  Services.scriptloader.loadSubScript(baseURI.resolve("output.js"), globalThis);
  Snap.init(id);
}

function shutdown() {
  Snap.shutdown();
}

function uninstall() {}

function onMainWindowLoad() {}
function onMainWindowUnload() {}
