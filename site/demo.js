/* Inklayer showcase: the pretend teammates and every section's demo.
 *
 * Nothing here talks to a server. Each section is a "scene": a script that runs while the section is on screen, pauses
 * when it scrolls away, and loops. Cursors, selections and marks are drawn the way the extension draws them
 * (client/packages/overlay/src/presence.ts and overlay.ts), anchored to elements so they follow layout changes.
 * With prefers-reduced-motion, each scene jumps straight to its end state once.
 */
(() => {
  "use strict";

  const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const CANCEL = Symbol("cancel");
  const SVG_NS = "http://www.w3.org/2000/svg";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const PEOPLE = {
    john: { name: "John", role: "Design", c: "#f59e0b" },
    michael: { name: "Michael", role: "Dev", c: "#3b82f6" },
    rosie: { name: "Rosie", role: "QA", c: "#ef4444" },
    leo: { name: "Leo", role: "PM", c: "#10b981" },
  };
  const YOU = "#8b5cf6";

  const ARROW = `<svg width="20" height="22" viewBox="0 0 20 22" aria-hidden="true"><path d="M2.5 1.8 L2.5 17.6 L6.6 13.7 L9.4 20.1 L12.4 18.8 L9.6 12.5 L15.4 12.5 Z" fill="var(--c)" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  };
  const svg = (tag) => document.createElementNS(SVG_NS, tag);
  const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  // ---------------------------------------------------------------- scenes

  /** One run of a scene's script. Cancelled when the scene restarts or stops. */
  class Ctx {
    constructor(scene) {
      this.scene = scene;
      this.alive = true;
    }
    chk() {
      if (!this.alive) throw CANCEL;
    }
    async visible() {
      while (!this.scene.visible) {
        this.chk();
        await this.scene.until();
      }
      this.chk();
    }
    async sleep(ms) {
      if (RM) return this.chk();
      let left = ms;
      while (left > 0) {
        await this.visible();
        const step = Math.min(left, 80);
        await new Promise((r) => setTimeout(r, step));
        left -= step;
      }
      this.chk();
    }
    /** Calls f with an eased 0..1 over dur ms of on-screen time. */
    async animate(dur, f, curve = ease) {
      if (RM) {
        f(1);
        return this.chk();
      }
      let t = 0;
      let last = performance.now();
      while (t < dur) {
        if (!this.scene.visible) {
          await this.visible();
          last = performance.now();
        }
        await raf();
        this.chk();
        const now = performance.now();
        t += Math.min(now - last, 50);
        last = now;
        f(curve(Math.min(1, t / dur)));
      }
      this.chk();
    }
  }

  const scenes = new Map();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const sc = scenes.get(e.target);
      if (!sc) continue;
      sc.visible = e.isIntersecting;
      if (sc.visible) sc.wake();
    }
  }, { threshold: 0.12 });

  function scene(name, script, { reset, gap = 2400, once = false } = {}) {
    const root = document.querySelector(`[data-scene="${name}"]`);
    if (!root) return null;
    const sc = {
      root, visible: false, waiters: [], ctx: null,
      until: () => new Promise((r) => sc.waiters.push(r)),
      wake: () => sc.waiters.splice(0).forEach((f) => f()),
      stop() {
        if (sc.ctx) sc.ctx.alive = false;
        sc.wake();
      },
      start() {
        sc.stop();
        const ctx = new Ctx(sc);
        sc.ctx = ctx;
        (async () => {
          try {
            do {
              await ctx.visible();
              await script(ctx);
              if (RM || once) break;
              await ctx.sleep(gap);
              reset?.();
            } while (true);
          } catch (err) {
            if (err !== CANCEL) console.debug("[inklayer demo]", err);
          }
        })();
      },
    };
    scenes.set(root, sc);
    io.observe(root);
    sc.start();
    return sc;
  }

  // ---------------------------------------------------------------- drawing layer

  const layers = new Set();
  (function loop() {
    for (const layer of layers) if (layer.isOnScreen()) layer.render();
    requestAnimationFrame(loop);
  })();

  function relRect(stage, r) {
    const s = stage.getBoundingClientRect();
    return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height };
  }
  function boxOf(stage, node) {
    if (!node || !node.isConnected) return null;
    const r = node.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    return relRect(stage, r);
  }
  /** A point on the stage: {x, y}, {el, fx, fy}, or a function returning a point. */
  function pt(stage, t) {
    if (typeof t === "function") return t();
    if (t.el) {
      const b = boxOf(stage, t.el) || { x: 0, y: 0, w: 0, h: 0 };
      return { x: b.x + b.w * (t.fx ?? 0.5), y: b.y + b.h * (t.fy ?? 0.5) };
    }
    return t;
  }
  function rangePoint(stage, range, which = "end") {
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
    const r = rects.length ? (which === "start" ? rects[0] : rects[rects.length - 1]) : range.getBoundingClientRect();
    const b = relRect(stage, r);
    return { x: which === "start" ? b.x : b.x + b.w, y: b.y + b.h * 0.65 };
  }
  function textRange(root, phrase) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const i = node.data.indexOf(phrase);
      if (i >= 0) {
        const r = document.createRange();
        r.setStart(node, i);
        r.setEnd(node, i + phrase.length);
        return r;
      }
    }
    return null;
  }

  /** Marks, highlights and other people's selections over a stage, re-placed every frame so they follow their elements. */
  class Layer {
    constructor(stage) {
      this.stage = stage;
      if (getComputedStyle(stage).position === "static") stage.style.position = "relative";
      this.svg = svg("svg");
      this.svg.classList.add("marks");
      stage.append(this.svg);
      this.items = [];
      this.onRender = null;
      layers.add(this);
    }
    isOnScreen() {
      const r = this.stage.getBoundingClientRect();
      return r.bottom > -50 && r.top < innerHeight + 50;
    }
    add(m) {
      m.color = m.color || (m.person && m.person.c) || YOU;
      if (m.kind !== "sel" && m.kind !== "text") {
        m.g = svg("g");
        m.g.style.setProperty("--c", m.color);
        if (m.kind === "box" || m.kind === "element" || m.kind === "hover") {
          m.shape = svg("rect");
          m.shape.setAttribute("class", m.kind === "box" ? "rect" : m.kind === "hover" ? "hover" : "outline");
          m.shape.setAttribute("rx", 3);
          m.g.append(m.shape);
        } else if (m.kind === "arrow") {
          m.line = svg("line");
          m.line.setAttribute("class", "arrow");
          m.head = svg("polygon");
          m.head.setAttribute("class", "arrowhead");
          m.g.append(m.line, m.head);
        } else if (m.kind === "ink") {
          m.shape = svg("polyline");
          m.shape.setAttribute("class", "inkline");
          m.g.append(m.shape);
        }
        this.svg.append(m.g);
      }
      if (m.kind === "text" || m.kind === "sel") m.rects = [];
      if (m.n != null) {
        m.badge = el("div", "mark-badge" + (m.kind === "pin" ? " pin" : ""), String(m.n));
        m.badge.style.setProperty("--c", m.color);
        this.stage.append(m.badge);
      }
      this.items.push(m);
      this.render();
      return m;
    }
    remove(m) {
      m.g?.remove();
      m.badge?.remove();
      m.rects?.forEach((r) => r.remove());
      this.items = this.items.filter((x) => x !== m);
    }
    clear() {
      for (const m of [...this.items]) this.remove(m);
    }
    select(n) {
      for (const m of this.items) {
        const on = n != null && m.n === n;
        m.g?.classList.toggle("selected", on);
        m.badge?.classList.toggle("selected", on);
        m.rects?.forEach((r) => (r.style.boxShadow = on ? `0 0 0 2px ${m.color}` : ""));
      }
    }
    #rects(m, range, cls) {
      const rects = range ? Array.from(range.getClientRects()).filter((r) => r.width > 0.5) : [];
      while (m.rects.length < rects.length) {
        const d = el("div", cls);
        d.style.setProperty("--c", m.color);
        if (m.kind === "sel" && m.rects.length === 0) {
          d.classList.add("first");
          d.append(el("span", "flag", esc(m.person.name)));
        }
        this.stage.append(d);
        m.rects.push(d);
      }
      m.rects.forEach((d, i) => {
        const r = rects[i];
        if (!r) {
          d.style.display = "none";
          return;
        }
        const b = relRect(this.stage, r);
        d.style.display = "";
        d.style.transform = `translate(${b.x}px, ${b.y}px)`;
        d.style.width = `${b.w}px`;
        d.style.height = `${b.h}px`;
      });
      return rects.length ? relRect(this.stage, rects[0]) : null;
    }
    render() {
      for (const m of this.items) {
        let badgeAt = null;
        let b = null;
        if (m.kind === "text" || m.kind === "sel") {
          const first = this.#rects(m, m.range, m.kind === "sel" ? "fake-sel" : "hl");
          if (first) badgeAt = { x: first.x, y: first.y };
        } else {
          b = boxOf(this.stage, m.el);
          const orphan = !b;
          if (b) m.last = b;
          else b = m.last;
          if (!b) {
            if (m.badge) m.badge.style.display = "none";
            continue;
          }
          if (m.orphan !== orphan) {
            m.orphan = orphan;
            m.g?.classList.toggle("orphan", orphan);
            if (m.badge) {
              m.badge.querySelector(".moved")?.remove();
              if (orphan) m.badge.append(el("span", "moved", "moved"));
            }
          }
          const P = (fx, fy) => ({ x: b.x + b.w * fx, y: b.y + b.h * fy });
          if (m.kind === "pin") badgeAt = P(m.fx, m.fy);
          else if (m.kind === "element" || m.kind === "hover") {
            setRect(m.shape, b.x - 3, b.y - 3, b.w + 6, b.h + 6);
            badgeAt = { x: b.x - 3, y: b.y - 3 };
          } else if (m.kind === "box") {
            const a = P(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1));
            const c = P(Math.max(m.x0, m.x1), Math.max(m.y0, m.y1));
            setRect(m.shape, a.x, a.y, c.x - a.x, c.y - a.y);
            badgeAt = a;
          } else if (m.kind === "arrow") {
            const a = P(m.x0, m.y0);
            const c = P(m.x1, m.y1);
            const ang = Math.atan2(c.y - a.y, c.x - a.x);
            const len = Math.hypot(c.x - a.x, c.y - a.y);
            const back = Math.min(14, len);
            const end = { x: c.x - Math.cos(ang) * back * 0.6, y: c.y - Math.sin(ang) * back * 0.6 };
            m.line.setAttribute("x1", a.x);
            m.line.setAttribute("y1", a.y);
            m.line.setAttribute("x2", end.x);
            m.line.setAttribute("y2", end.y);
            const w = 0.45;
            m.head.setAttribute("points", [
              [c.x, c.y],
              [c.x - Math.cos(ang - w) * back, c.y - Math.sin(ang - w) * back],
              [c.x - Math.cos(ang + w) * back, c.y - Math.sin(ang + w) * back],
            ].map((p) => p.join(",")).join(" "));
            m.head.style.display = len > 4 ? "" : "none";
            badgeAt = a;
          } else if (m.kind === "ink") {
            m.shape.setAttribute("points", m.points.map(([fx, fy]) => { const p = P(fx, fy); return `${p.x},${p.y}`; }).join(" "));
            if (m.points.length) badgeAt = P(m.points[0][0], m.points[0][1]);
          }
        }
        if (m.badge && badgeAt) {
          m.badge.style.display = "";
          m.badge.style.left = `${badgeAt.x}px`;
          m.badge.style.top = `${badgeAt.y}px`;
        }
      }
      this.onRender?.();
    }
  }
  function setRect(r, x, y, w, h) {
    r.setAttribute("x", x);
    r.setAttribute("y", y);
    r.setAttribute("width", Math.max(0, w));
    r.setAttribute("height", Math.max(0, h));
  }
  function toFrac(stage, node, p) {
    const b = boxOf(stage, node);
    return [(p.x - b.x) / b.w, (p.y - b.y) / b.h];
  }

  // ---------------------------------------------------------------- cursors

  class Cursor {
    constructor(stage, person, start = { x: 40, y: 40 }) {
      this.stage = stage;
      this.person = person;
      if (getComputedStyle(stage).position === "static") stage.style.position = "relative";
      this.node = el("div", "fake-cursor faded", ARROW);
      this.node.style.setProperty("--c", person.c);
      this.node.append(el("span", "name", esc(person.name)));
      stage.append(this.node);
      this.place(start);
    }
    place(p) {
      this.x = p.x;
      this.y = p.y;
      this.node.style.transform = `translate(${p.x}px, ${p.y}px)`;
    }
    show() {
      this.node.classList.remove("faded");
    }
    hide() {
      this.node.classList.add("faded");
    }
    async move(ctx, target, dur = 900) {
      this.show();
      const from = { x: this.x, y: this.y };
      // A slight curve, like a hand moving a mouse.
      const bend = rand(-0.18, 0.18);
      await ctx.animate(dur, (t) => {
        const to = pt(this.stage, target);
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const k = Math.sin(Math.PI * t) * bend;
        this.place({ x: from.x + dx * t - dy * k, y: from.y + dy * t + dx * k });
      });
    }
    async click(ctx, pressEl) {
      this.node.classList.remove("click");
      void this.node.offsetWidth;
      this.node.classList.add("click");
      pressEl?.classList.add("press");
      await ctx.sleep(260);
      pressEl?.classList.remove("press");
    }
  }

  async function typeInto(ctx, node, text, cps = 26) {
    const tn = document.createTextNode("");
    node.append(tn);
    if (RM) {
      tn.data = text;
      return tn;
    }
    for (const ch of text) {
      tn.data += ch;
      await ctx.sleep(ch === " " ? 1000 / cps * 1.6 : 1000 / cps * rand(0.6, 1.4));
    }
    return tn;
  }

  async function selectGrow(ctx, layer, cursor, root, phrase, dur = 900) {
    const full = textRange(root, phrase);
    if (!full) return null;
    const node = full.startContainer;
    const s = full.startOffset;
    const e = full.endOffset;
    const r = document.createRange();
    r.setStart(node, s);
    r.setEnd(node, s);
    await cursor.move(ctx, () => rangePoint(layer.stage, full, "start"), 800);
    const m = layer.add({ kind: "sel", range: r, person: cursor.person });
    await ctx.animate(dur, (t) => {
      r.setEnd(node, s + Math.round((e - s) * t));
      cursor.place(rangePoint(layer.stage, r, "end"));
    }, (t) => t);
    return m;
  }

  function faces(container, people, more = 0) {
    container.innerHTML = "";
    if (more) container.append(Object.assign(el("span", "face more", `+${more}`)));
    for (const p of [...people].reverse()) {
      const f = el("span", "face", p.name[0]);
      f.style.setProperty("--c", p.c);
      f.title = `${p.name} · ${p.role}`;
      container.append(f);
    }
  }

  function commentItem({ n, color, name, body, address, time = "just now" }) {
    const li = el("li", "item");
    li.dataset.n = n;
    li.innerHTML = `<div class="meta"><span class="badge" style="--c:${color}">${n}</span><b>${esc(name)}</b><span>· ${time}</span></div>`
      + `<p class="body">${esc(body)}</p>` + (address ? `<div class="address">${esc(address)}</div>` : "");
    return li;
  }

  // ---------------------------------------------------------------- nav, reveal, downloads, toggle

  const toggle = $("#people-toggle");
  if (localStorage.getItem("inklayer-demo-people") === "off") toggle.checked = false;
  const applyToggle = () => {
    document.body.classList.toggle("no-people", !toggle.checked);
    localStorage.setItem("inklayer-demo-people", toggle.checked ? "on" : "off");
  };
  toggle.addEventListener("change", applyToggle);
  applyToggle();

  const reveal = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      e.target.classList.add("in");
      reveal.unobserve(e.target);
    }
  }, { threshold: 0.08 });
  $$(".reveal").forEach((n) => reveal.observe(n));

  const progress = $("#progress");
  const navLinks = $$(".nav-links a");
  const onScroll = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    progress.style.width = `${(scrollY / Math.max(1, max)) * 100}%`;
    let current = null;
    for (const a of navLinks) {
      const target = document.querySelector(a.getAttribute("href"));
      if (target && target.getBoundingClientRect().top < innerHeight * 0.4) current = a;
    }
    navLinks.forEach((a) => a.classList.toggle("on", a === current));
  };
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // The latest release's zips, straight from GitHub. The buttons already point at the release page if this fails.
  fetch("https://api.github.com/repos/KanyeS/inklayer/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : Promise.reject()))
    .then((rel) => {
      const find = (k) => rel.assets?.find((a) => a.name.includes(`extension-${k}`))?.browser_download_url;
      const chrome = find("chrome");
      const firefox = find("firefox");
      if (chrome) $("#dl-chrome").href = chrome;
      if (firefox) $("#dl-firefox").href = firefox;
      if (chrome || firefox) {
        $("#dl-note").innerHTML = `${esc(rel.tag_name)} · Chrome, Edge, Brave and Firefox. Unzip and load it, then connect it to your own Inklayer server. <a href="https://github.com/KanyeS/inklayer#browser-extension">How to install</a>`;
      }
    })
    .catch(() => {});

  // ---------------------------------------------------------------- hero

  {
    const stage = $("#hero .wrap");
    const layer = new Layer(stage);
    const w = () => stage.clientWidth;
    const [J, M, R, L] = ["john", "michael", "rosie", "leo"].map((k, i) => new Cursor(stage, PEOPLE[k], { x: w() * (0.3 + i * 0.18), y: 520 + i * 10 }));
    faces($("#hero-faces"), Object.values(PEOPLE), 2);
    const badge = $("#hero-badge");
    const bump = (n) => {
      badge.textContent = n;
      badge.style.display = n ? "" : "none";
    };
    bump(0);

    scene("hero", async (ctx) => {
      const ink = $("#hero-title .ink");
      await Promise.all([
        (async () => {
          await ctx.sleep(200);
          const s = await selectGrow(ctx, layer, L, ink, "any web page", 900);
          await ctx.sleep(1800);
          await L.move(ctx, { el: $("#hero-c3"), fx: 0.6, fy: 0.5 }, 1600);
          await ctx.sleep(1200);
          layer.remove(s);
          await L.move(ctx, { el: $("#hero-c2"), fx: 0.3, fy: 0.7 }, 1400);
        })(),
        (async () => {
          await ctx.sleep(900);
          const btn = $("#hero-btn");
          await M.move(ctx, { el: btn, fx: 0.7, fy: 0.55 }, 1500);
          await M.click(ctx);
          layer.add({ kind: "pin", el: btn, fx: 0.7, fy: 0.55, person: PEOPLE.michael, n: 1 });
          bump(1);
          await ctx.sleep(900);
          await M.move(ctx, { el: $("#hero-c1"), fx: 0.5, fy: 0.4 }, 1300);
        })(),
        (async () => {
          await ctx.sleep(1700);
          const shot = $("#hero-shot");
          await R.move(ctx, { el: shot, fx: -0.06, fy: -0.08 }, 1500);
          const m = layer.add({ kind: "box", el: shot, x0: -0.06, y0: -0.08, x1: -0.06, y1: -0.08, person: PEOPLE.rosie, n: 2 });
          await ctx.animate(800, (t) => {
            m.x1 = -0.06 + 1.12 * t;
            m.y1 = -0.08 + 1.16 * t;
            R.place(pt(stage, { el: shot, fx: m.x1, fy: m.y1 }));
          });
          bump(2);
          await ctx.sleep(700);
          await R.move(ctx, { el: $("#hero-p"), fx: 0.9, fy: 1.6 }, 1200);
        })(),
        (async () => {
          await ctx.sleep(3000);
          const p = $("#hero-p");
          const s = await selectGrow(ctx, layer, J, p, "40% off", 600);
          await ctx.sleep(400);
          layer.remove(s);
          layer.add({ kind: "text", range: textRange(p, "40% off"), person: PEOPLE.john, n: 3 });
          bump(3);
          await ctx.sleep(600);
          await J.move(ctx, { el: $("#hero-h3"), fx: 1.1, fy: 0.2 }, 1500);
        })(),
      ]);
      await ctx.sleep(4500);
    }, {
      gap: 600,
      reset: () => {
        layer.clear();
        bump(0);
      },
    });
  }

  // ---------------------------------------------------------------- tools

  {
    const stage = $(".tools-stage");
    const shop = $("#shop");
    const layer = new Layer(stage);
    const list = $("#tool-list");
    const chips = $$("#tool-chips .tool");
    const swatches = $$("#tool-colors .swatch");
    const hint = $("#tool-hint");
    const draft = $("#tool-draft");
    const ta = $("#tool-ta");
    const save = $("#tool-save");
    const HINTS = {
      select: "Click a mark to find its comment.",
      pin: "Click to pin a comment to a point.",
      element: "Click an element to outline it.",
      text: "Select text to highlight it.",
      box: "Drag to draw a box.",
      arrow: "Drag to draw an arrow.",
      draw: "Draw freehand. Pen pressure works too.",
    };
    const cursors = Object.fromEntries(Object.keys(PEOPLE).map((k, i) => [k, new Cursor(stage, PEOPLE[k], { x: 120 + i * 140, y: 420 })]));
    let n = 0;
    const setTool = (tool) => {
      chips.forEach((c) => c.classList.toggle("active", c.dataset.tool === tool));
      hint.textContent = HINTS[tool];
    };
    const setColor = (c) => swatches.forEach((s) => s.classList.toggle("active", s.style.getPropertyValue("--c").trim() === c));
    const chip = (tool) => chips.find((c) => c.dataset.tool === tool);
    const reset = () => {
      layer.clear();
      list.innerHTML = "";
      draft.hidden = true;
      ta.textContent = "";
      n = 0;
      setTool("select");
      setColor("#f59e0b");
    };

    const STEPS = [
      {
        tool: "pin", who: "rosie", text: "Show the sale price in red, like the card on the home page.",
        act: async (ctx, c, color, num) => {
          const price = $("#shop-price");
          await c.move(ctx, { el: price, fx: 0.22, fy: 0.45 }, 1000);
          await c.click(ctx);
          return layer.add({ kind: "pin", el: price, fx: 0.22, fy: 0.45, color, n: num });
        },
      },
      {
        tool: "element", who: "john", text: "Make this full width on mobile.",
        act: async (ctx, c, color, num) => {
          const cart = $("#shop-cart");
          await c.move(ctx, { el: $("#shop-sizes"), fx: 0.5, fy: 0.5 }, 800);
          const hover = layer.add({ kind: "hover", el: $("#shop-sizes") });
          await ctx.sleep(350);
          hover.el = cart;
          await c.move(ctx, { el: cart, fx: 0.6, fy: 0.5 }, 600);
          await ctx.sleep(300);
          await c.click(ctx);
          layer.remove(hover);
          return layer.add({ kind: "element", el: cart, color, n: num });
        },
      },
      {
        tool: "text", who: "leo", text: "Is this still right for orders to Australia?",
        act: async (ctx, c, color, num) => {
          const desc = $("#shop-desc");
          const s = await selectGrow(ctx, layer, c, desc, "ships in 3–5 days", 800);
          layer.remove(s);
          return layer.add({ kind: "text", range: textRange(desc, "ships in 3–5 days"), color, n: num });
        },
      },
      {
        tool: "box", who: "michael", text: "Size 11 wraps onto two lines in Safari.",
        act: async (ctx, c, color, num) => {
          const sizes = $("#shop-sizes");
          await c.move(ctx, { el: sizes, fx: -0.03, fy: -0.2 }, 1000);
          const m = layer.add({ kind: "box", el: sizes, x0: -0.03, y0: -0.2, x1: -0.03, y1: -0.2, color, n: num });
          await ctx.animate(900, (t) => {
            m.x1 = -0.03 + 1.06 * t;
            m.y1 = -0.2 + 1.4 * t;
            c.place(pt(stage, { el: sizes, fx: m.x1, fy: m.y1 }));
          });
          return m;
        },
      },
      {
        tool: "arrow", who: "john", text: "Swap in the new colourway photo here.",
        act: async (ctx, c, color, num) => {
          const photo = $("#shop-photo");
          const from = [1.18, 1.22];
          const to = [0.78, 0.82];
          await c.move(ctx, { el: photo, fx: from[0], fy: from[1] }, 1000);
          const m = layer.add({ kind: "arrow", el: photo, x0: from[0], y0: from[1], x1: from[0], y1: from[1], color, n: num });
          await ctx.animate(700, (t) => {
            m.x1 = from[0] + (to[0] - from[0]) * t;
            m.y1 = from[1] + (to[1] - from[1]) * t;
            c.place(pt(stage, { el: photo, fx: m.x1, fy: m.y1 }));
          });
          return m;
        },
      },
      {
        tool: "draw", who: "rosie", text: "The stars sit 2px lower than the review count.",
        act: async (ctx, c, color, num) => {
          const stars = $("#shop-stars");
          const pts = [];
          const N = 46;
          for (let i = 0; i <= N; i++) {
            const a = -0.5 + (i / N) * (Math.PI * 2 + 0.5);
            const j = 1 + Math.sin(i * 1.7) * 0.03;
            pts.push([0.5 + Math.cos(a) * 0.56 * j, 0.5 + Math.sin(a) * 0.95 * j]);
          }
          await c.move(ctx, { el: stars, fx: pts[0][0], fy: pts[0][1] }, 1000);
          const m = layer.add({ kind: "ink", el: stars, points: [pts[0]], color, n: num });
          await ctx.animate(1100, (t) => {
            const k = Math.max(1, Math.round(t * N));
            m.points = pts.slice(0, k + 1);
            c.place(pt(stage, { el: stars, fx: pts[k][0], fy: pts[k][1] }));
          }, (t) => t);
          return m;
        },
      },
    ];

    const sc = scene("tools", async (ctx) => {
      reset();
      for (const step of STEPS) {
        const c = cursors[step.who];
        const color = c.person.c;
        await c.move(ctx, { el: chip(step.tool), fx: 0.5, fy: 0.55 }, 900);
        await c.click(ctx, chip(step.tool));
        setTool(step.tool);
        setColor(color);
        const num = ++n;
        await step.act(ctx, c, color, num);
        draft.hidden = false;
        ta.textContent = "";
        ta.classList.add("caret");
        await ctx.sleep(250);
        await typeInto(ctx, ta, step.text, 34);
        ta.classList.remove("caret");
        await c.move(ctx, { el: save, fx: 0.5, fy: 0.6 }, 700);
        await c.click(ctx, save);
        draft.hidden = true;
        list.append(commentItem({ n: num, color, name: c.person.name, body: step.text }));
        setTool("select");
        await ctx.sleep(500);
        c.move(ctx, { x: rand(40, stage.clientWidth * 0.5), y: rand(40, 300) }, 1500).catch(() => {});
        await ctx.sleep(300);
      }
      // Select: click a comment to find its mark.
      const m = cursors.michael;
      for (const num of [2, 5]) {
        const item = list.querySelector(`[data-n="${num}"]`);
        await m.move(ctx, { el: item, fx: 0.4, fy: 0.5 }, 900);
        await m.click(ctx);
        $$(".item", list).forEach((i) => i.classList.toggle("selected", i === item));
        layer.select(num);
        await ctx.sleep(1500);
      }
      await ctx.sleep(2500);
    }, { reset, gap: 400 });

    // ---- You drive: the visitor tries the tools themselves. Nothing is saved.
    let tool = null;
    let color = YOU;
    let drag = null;
    let hover = null;
    const startDriving = (t) => {
      if (!tool) {
        sc.stop();
        reset();
        Object.values(cursors).forEach((c) => c.hide());
      }
      tool = t;
      setTool(t);
      setColor(color);
      shop.className = shop.className.replace(/\bt-\w+/g, "").trim();
      shop.classList.add("drive", `t-${t}`);
      if (hover) layer.remove(hover);
      hover = null;
    };
    const stopDriving = () => {
      tool = null;
      shop.classList.remove("drive");
      shop.className = shop.className.replace(/\bt-\w+/g, "").trim();
      reset();
      sc.start();
    };
    chips.forEach((c) => c.addEventListener("click", () => startDriving(c.dataset.tool)));
    swatches.forEach((s) => s.addEventListener("click", () => {
      color = s.style.getPropertyValue("--c").trim();
      if (tool) setColor(color);
    }));
    $("#resume-demo").addEventListener("click", stopDriving);
    const myComment = (num) => {
      const li = commentItem({ n: num, color, name: "You", body: "", time: "not saved" });
      const body = li.querySelector(".body");
      body.contentEditable = "true";
      body.dataset.ph = "Type your comment…";
      list.append(li);
      list.scrollTop = list.scrollHeight;
      requestAnimationFrame(() => body.focus({ preventScroll: true }));
    };
    const targetAt = (x, y) => {
      const hit = document.elementFromPoint(x, y);
      return hit && shop.contains(hit) && hit !== shop && !hit.closest(".drive-note") ? hit : null;
    };
    const stagePoint = (e) => {
      const s = stage.getBoundingClientRect();
      return { x: e.clientX - s.left, y: e.clientY - s.top };
    };
    shop.addEventListener("pointermove", (e) => {
      if (!tool) return;
      if (tool === "element") {
        const t = targetAt(e.clientX, e.clientY);
        if (!t) return;
        if (!hover) hover = layer.add({ kind: "hover", el: t });
        hover.el = t;
      }
      if (!drag) return;
      const [fx, fy] = toFrac(stage, shop, stagePoint(e));
      if (drag.kind === "box" || drag.kind === "arrow") {
        drag.x1 = fx;
        drag.y1 = fy;
      } else if (drag.kind === "ink") drag.points.push([fx, fy]);
    });
    shop.addEventListener("pointerleave", () => {
      if (hover) layer.remove(hover);
      hover = null;
    });
    shop.addEventListener("pointerdown", (e) => {
      if (!tool || e.button !== 0 || e.target.closest(".drive-note")) return;
      if (tool === "pin" || tool === "element") {
        const t = targetAt(e.clientX, e.clientY);
        if (!t) return;
        e.preventDefault();
        const num = ++n;
        if (tool === "pin") {
          const [fx, fy] = toFrac(stage, t, stagePoint(e));
          layer.add({ kind: "pin", el: t, fx, fy, color, n: num });
        } else layer.add({ kind: "element", el: t, color, n: num });
        myComment(num);
      } else if (tool === "box" || tool === "arrow" || tool === "draw") {
        e.preventDefault();
        shop.setPointerCapture(e.pointerId);
        const [fx, fy] = toFrac(stage, shop, stagePoint(e));
        drag = tool === "draw"
          ? layer.add({ kind: "ink", el: shop, points: [[fx, fy]], color })
          : layer.add({ kind: tool, el: shop, x0: fx, y0: fy, x1: fx, y1: fy, color });
      }
    });
    shop.addEventListener("pointerup", () => {
      if (!drag) return;
      const m = drag;
      drag = null;
      const b = boxOf(stage, shop);
      const size = m.kind === "ink" ? m.points.length : Math.hypot((m.x1 - m.x0) * b.w, (m.y1 - m.y0) * b.h);
      if (size < 6) return layer.remove(m);
      const num = ++n;
      m.n = num;
      m.badge = el("div", "mark-badge", String(num));
      m.badge.style.setProperty("--c", m.color);
      stage.append(m.badge);
      myComment(num);
    });
    shop.addEventListener("mouseup", () => {
      if (tool !== "text") return;
      const s = getSelection();
      if (!s.rangeCount || s.isCollapsed) return;
      const r = s.getRangeAt(0);
      if (!shop.contains(r.commonAncestorContainer)) return;
      const num = ++n;
      layer.add({ kind: "text", range: r.cloneRange(), color, n: num });
      s.removeAllRanges();
      myComment(num);
    });
    list.addEventListener("click", (e) => {
      const item = e.target.closest(".item");
      if (!item || e.target.isContentEditable) return;
      $$(".item", list).forEach((i) => i.classList.toggle("selected", i === item));
      layer.select(Number(item.dataset.n));
    });
  }

  // ---------------------------------------------------------------- anchors

  {
    const card = $(".anchor-stage");
    const layer = new Layer(card);
    const mini = $("#mini");
    const promo = $("#mini-promo");
    const dl = $("#anchor-readout");
    const relayout = $("#relayout");
    const removeBtn = $("#remove-promo");
    const INFO = {
      1: { css: ".grid > .tile:nth-child(1) > .buy", xpath: "/html/body/main/div[3]/div[1]/span", text: "\"Buy\"" },
      2: { css: ".grid > .tile:nth-child(1) > h4", xpath: "/html/body/main/div[3]/div[1]/h4", text: "\"Trail Runner 2\"" },
      3: { css: "body > main > .promo", xpath: "/html/body/main/div[2]", text: "\"Free shipping on orders over $80…\"" },
      4: { css: ".grid > .tile:nth-child(2) > p", xpath: "/html/body/main/div[3]/div[2]/p", text: "\"Water-resistant\"" },
    };
    let selected = 1;
    let marks = [];
    const show = (num) => {
      selected = num;
      layer.select(num);
    };
    layer.onRender = () => {
      const m = marks.find((x) => x.n === selected);
      if (!m) return;
      const info = INFO[selected];
      const mb = boxOf(card, mini);
      let pos = "";
      const at = m.kind === "text" ? (m.rects[0] && boxOf(card, m.rects[0])) : m.last;
      if (at && mb) pos = `x ${((at.x - mb.x) / mb.w).toFixed(2)} · y ${((at.y - mb.y) / mb.w).toFixed(2)} of page width`;
      const html = `<dt>css</dt><dd>${esc(info.css)}</dd><dt>xpath</dt><dd>${esc(info.xpath)}</dd><dt>text</dt><dd>${esc(info.text)}</dd><dt>position</dt><dd>${pos}</dd>`
        + (m.orphan ? `<dt>status</dt><dd style="color:#b45309">element gone, shown where it was: “moved”</dd>` : "");
      if (dl.innerHTML !== html) dl.innerHTML = html;
    };
    const setAlt = (on) => {
      mini.classList.toggle("alt", on);
      relayout.textContent = on ? "Change it back" : "Change the layout";
    };
    const setGone = (on) => {
      promo.classList.toggle("gone", on);
      removeBtn.textContent = on ? "Bring the banner back" : "Remove the banner";
    };
    relayout.addEventListener("click", () => setAlt(!mini.classList.contains("alt")));
    removeBtn.addEventListener("click", () => setGone(!promo.classList.contains("gone")));

    scene("anchors", async (ctx) => {
      layer.clear();
      setAlt(false);
      setGone(false);
      marks = [];
      const add = async (m) => {
        marks.push(layer.add(m));
        await ctx.sleep(350);
      };
      await add({ kind: "pin", el: $("#mini-buy"), fx: 0.5, fy: 0.5, person: PEOPLE.michael, n: 1 });
      await add({ kind: "element", el: $("#mini-h1"), person: PEOPLE.john, n: 2 });
      await add({ kind: "box", el: promo, x0: -0.01, y0: -0.12, x1: 1.01, y1: 1.12, person: PEOPLE.rosie, n: 3 });
      await add({ kind: "text", range: textRange($("#mini-p2"), "Water-resistant"), person: PEOPLE.leo, n: 4 });
      show(1);
      await ctx.sleep(1800);
      setAlt(true);
      await ctx.sleep(2200);
      show(2);
      await ctx.sleep(1600);
      setAlt(false);
      await ctx.sleep(1800);
      show(4);
      await ctx.sleep(1200);
      setAlt(true);
      await ctx.sleep(1800);
      show(3);
      await ctx.sleep(900);
      setGone(true);
      await ctx.sleep(3200);
      setAlt(false);
      await ctx.sleep(2400);
      setGone(false);
      await ctx.sleep(1800);
    }, { gap: 300 });
  }

  // ---------------------------------------------------------------- presence

  {
    const stage = $("#presence-stage");
    const layer = new Layer(stage);
    faces($("#presence-faces"), Object.values(PEOPLE), 2);
    const blocks = ["#pr-h", "#pr-p1", "#pr-h4", "#pr-p2", "#pr-p3"].map((s) => $(s));
    const PHRASES = [
      ["#pr-h", "fastest known time"],
      ["#pr-p1", "the trailhead is silent"],
      ["#pr-p1", "that knot is the only thing you'll still trust"],
      ["#pr-p2", "salted potatoes"],
      ["#pr-p2", "The Ridge 30L carried all of it"],
      ["#pr-p3", "the whole valley opened up below us"],
    ];
    const busy = new Set();
    const cursors = Object.values(PEOPLE).map((p, i) => new Cursor(stage, p, { x: 80 + i * 120, y: 140 + i * 50 }));
    scene("presence", async (ctx) => {
      await Promise.all(cursors.map(async (c, i) => {
        await ctx.sleep(i * 500);
        const end = performance.now() + (RM ? 0 : 22000);
        do {
          if (Math.random() < 0.3) {
            const options = PHRASES.filter(([s]) => !busy.has(s));
            if (options.length) {
              const [s, phrase] = pick(options);
              busy.add(s);
              const m = await selectGrow(ctx, layer, c, $(s), phrase, 900);
              await ctx.sleep(rand(1800, 3200));
              if (m) layer.remove(m);
              busy.delete(s);
              continue;
            }
          }
          if (c.person === PEOPLE.leo && Math.random() < 0.25) {
            // Leo walks away from the desk: after a while still, a cursor fades.
            await ctx.sleep(10000);
            c.hide();
            await ctx.sleep(2500);
          }
          await c.move(ctx, { el: pick(blocks), fx: rand(0.05, 0.95), fy: rand(0.1, 0.9) }, rand(1100, 2200));
          await ctx.sleep(rand(300, 1800));
        } while (performance.now() < end);
      }));
      if (RM) await selectGrow(ctx, layer, cursors[0], $("#pr-p3"), "the whole valley opened up below us", 1);
    }, { gap: 200 });
  }

  // ---------------------------------------------------------------- bug context

  {
    const card = $("#checkout-card");
    const layer = new Layer(card);
    const log = $("#log");
    const btn = $("#place-order");
    const err = $("#order-error");
    const shot = $("#details-shot");

    const env = () => {
      const ua = navigator.userAgent;
      const browser = (/Edg\/([\d]+)/.exec(ua) && `Edge ${RegExp.$1}`)
        || (/Firefox\/([\d]+)/.exec(ua) && `Firefox ${RegExp.$1}`)
        || (/Chrome\/([\d]+)/.exec(ua) && `Chrome ${RegExp.$1}`)
        || (/Version\/([\d.]+).*Safari/.exec(ua) && `Safari ${RegExp.$1}`) || "Unknown";
      const os = /Windows NT/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? (/iPhone|iPad/.test(ua) ? "iOS" : "macOS")
        : /Android/.test(ua) ? "Android" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "Unknown";
      $("#env").innerHTML = `<dt>Browser</dt><dd>${browser}</dd><dt>OS</dt><dd>${os}</dd><dt>Window</dt><dd>${innerWidth} × ${innerHeight}</dd><dt>Pixel ratio</dt><dd>${devicePixelRatio}</dd>`;
    };
    env();
    addEventListener("resize", env, { passive: true });

    const takeShot = () => {
      shot.querySelector(".mini")?.remove();
      const clone = $("#checkout").cloneNode(true);
      clone.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
      clone.removeAttribute("id");
      clone.querySelectorAll("input").forEach((i) => i.setAttribute("tabindex", "-1"));
      const wrap = el("div", "mini card checkout");
      wrap.setAttribute("aria-hidden", "true");
      wrap.style.width = `${card.clientWidth}px`;
      wrap.append(clone);
      shot.prepend(wrap);
      // The area around the comment, scaled into the thumbnail, with the comment's pin on it.
      const cw = card.clientWidth;
      const ch = card.clientHeight;
      const top = ch * 0.5;
      const scale = Math.min(shot.clientWidth / cw, shot.clientHeight / (ch - top));
      wrap.style.left = `${(shot.clientWidth - cw * scale) / 2}px`;
      wrap.style.transform = `scale(${scale}) translateY(-${top}px)`;
      const pin = boxOf(card, err);
      if (pin) {
        const b = el("div", "mark-badge pin", "7");
        b.style.cssText = `--c:${PEOPLE.rosie.c};left:${pin.x + pin.w * 0.15}px;top:${pin.y + pin.h * 0.5}px;animation:none`;
        wrap.append(b);
      }
      const f = shot.querySelector(".flash");
      f.classList.remove("go");
      void f.offsetWidth;
      f.classList.add("go");
    };
    const addLog = (cls, html) => {
      log.querySelector(".placeholder")?.remove();
      const li = el("li", cls, html);
      log.prepend(li);
      while (log.children.length > 5) log.lastChild.remove();
    };

    let clicked = false;
    async function placeOrder() {
      err.classList.remove("on");
      if (!clicked) console.info("Inklayer demo: the Place order button fails on purpose, so the extension has real errors to attach to a comment.");
      clicked = true;
      console.warn("[checkout] Payment intent took 3.2s, retrying (1/3)");
      addLog("warn", "warn · [checkout] Payment intent took 3.2s, retrying (1/3)<span class='live'>live</span>");
      const t0 = performance.now();
      let status = 0;
      try {
        const r = await fetch("api/orders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ total: 218 }) });
        status = r.status;
      } catch {
        status = 0;
      }
      const ms = Math.round(performance.now() - t0);
      addLog("net", `POST ${esc(new URL("api/orders", location.href).pathname)} → ${status || "failed"} · ${ms} ms<span class='live'>live</span>`);
      const order = {};
      try {
        void order.summary.total;
      } catch (e) {
        console.error(e);
        addLog("error", `error · ${esc(`${e.name}: ${e.message}`)}<span class='live'>live</span>`);
      }
      err.classList.add("on");
    }
    btn.addEventListener("click", () => {
      void placeOrder().then(takeShot);
    });

    scene("bug", async (ctx) => {
      const r = new Cursor(card, PEOPLE.rosie, { x: card.clientWidth * 0.8, y: 30 });
      await ctx.sleep(400);
      await r.move(ctx, { el: btn, fx: 0.55, fy: 0.5 }, 1300);
      await r.click(ctx);
      if (!clicked) await placeOrder();
      await ctx.sleep(700);
      await r.move(ctx, { el: err, fx: 0.15, fy: 0.5 }, 700);
      await r.click(ctx);
      layer.add({ kind: "pin", el: err, fx: 0.15, fy: 0.5, person: PEOPLE.rosie, n: 7 });
      await ctx.sleep(300);
      takeShot();
      await ctx.sleep(1500);
      await r.move(ctx, { x: card.clientWidth * 0.75, y: card.clientHeight * 0.25 }, 1500);
      await ctx.sleep(2000);
      r.hide();
    }, { once: true });
  }

  // ---------------------------------------------------------------- address

  {
    const card = $(".addr");
    const bar = $("#urlbar");
    const paramsBox = $("#params");
    const stored = $("#stored");
    const BASE = "shop.example/products/trail-runner";
    const PARTS = [
      { key: "colour", val: "blue", keep: true },
      { key: "size", val: "10", keep: false },
      { key: "utm_source", val: "newsletter", keep: false },
      { key: "fbclid", val: "IwAR2xZk81_qA", keep: false },
      { key: "#reviews", val: "", keep: false, hash: true },
    ];
    paramsBox.innerHTML = PARTS.map((p, i) => `<label><input type="checkbox" data-i="${i}"${p.keep ? " checked" : ""}>${p.hash ? p.key : `${p.key}=${p.val.slice(0, 10)}`}</label>`).join("");
    const exact = () => $('input[name="scope"][value="exact"]').checked;
    const render = () => {
      const ex = exact();
      $$("input", paramsBox).forEach((c) => (c.disabled = !ex));
      paramsBox.style.opacity = ex ? 1 : 0.45;
      const kept = PARTS.filter((p, i) => ex && $(`input[data-i="${i}"]`, paramsBox).checked);
      let html = `<span class="keep">https://${BASE}</span>`;
      let first = true;
      for (const [i, p] of PARTS.entries()) {
        const on = ex && $(`input[data-i="${i}"]`, paramsBox).checked;
        const text = p.hash ? p.key : `${first ? "?" : "&"}${p.key}=${p.val}`;
        if (!p.hash) first = false;
        html += `<span class="${on ? "keep" : "drop"}">${esc(text)}</span>`;
      }
      bar.innerHTML = html;
      const q = kept.filter((p) => !p.hash).map((p) => `${p.key}=${p.val}`).join("&");
      const h = kept.find((p) => p.hash);
      stored.textContent = BASE + (q ? `?${q}` : "") + (h ? h.key : "");
    };
    render();
    let userTouched = false;
    card.addEventListener("change", (e) => {
      if (e.isTrusted && !userTouched) {
        userTouched = true;
        sc.stop();
        leo.hide();
      }
      render();
    });
    const leo = new Cursor(card, PEOPLE.leo, { x: 300, y: 260 });
    const clickInput = async (ctx, input) => {
      await leo.move(ctx, { el: input, fx: 0.5, fy: 0.5 }, 900);
      await leo.click(ctx);
      if (input.type === "radio") input.checked = true;
      else input.checked = !input.checked;
      render();
      await ctx.sleep(1300);
    };
    const sc = scene("address", async (ctx) => {
      await ctx.sleep(600);
      await clickInput(ctx, $('input[data-i="1"]', paramsBox));
      await clickInput(ctx, $('input[data-i="4"]', paramsBox));
      await clickInput(ctx, $('input[name="scope"][value="all"]'));
      await clickInput(ctx, $('input[name="scope"][value="exact"]'));
      await clickInput(ctx, $('input[data-i="1"]', paramsBox));
      await clickInput(ctx, $('input[data-i="4"]', paramsBox));
      await leo.move(ctx, { el: stored, fx: 0.8, fy: 1.6 }, 1000);
      await ctx.sleep(2000);
    }, { gap: 1000 });
  }

  // ---------------------------------------------------------------- threads

  {
    const panel = $("#thread-panel");
    const ta = $("#thread-ta");
    const replies = $("#thread-replies");
    const send = $("#thread-send");
    const bell = $("#bell");
    const toasts = $("#toasts");
    const initialToasts = toasts.innerHTML;
    const leo = new Cursor(panel, PEOPLE.leo, { x: 250, y: 300 });
    const toast = (who, html, where) => {
      const t = el("div", "card toast new", `<span class="face" style="--c:${who.c}">${who.name[0]}</span><div>${html}<p>${esc(where)}</p></div><time>now</time>`);
      toasts.prepend(t);
      while (toasts.children.length > 2) toasts.lastChild.remove();
    };
    const reset = () => {
      replies.innerHTML = "";
      ta.innerHTML = "";
      bell.classList.remove("on");
      bell.querySelector(".bb")?.remove();
      toasts.innerHTML = initialToasts;
    };
    scene("threads", async (ctx) => {
      reset();
      await leo.move(ctx, { el: ta, fx: 0.3, fy: 0.5 }, 1000);
      await leo.click(ctx);
      ta.classList.add("caret");
      await typeInto(ctx, ta, "Thanks Rosie. ");
      const at = await typeInto(ctx, ta, "@Mi", 8);
      const pop = el("div", "mention-pop",
        `<div class="on"><span class="face" style="--c:${PEOPLE.michael.c}">M</span>Michael<small>Dev</small></div>`
        + `<div><span class="face" style="--c:#8b5cf6">M</span>Mia Alvarez<small>Marketing</small></div>`);
      const pr = boxOf(panel, ta);
      pop.style.left = `${pr.x + 10}px`;
      pop.style.top = `${pr.y + pr.h + 2}px`;
      panel.append(pop);
      await ctx.sleep(500);
      await leo.move(ctx, { el: pop.firstChild, fx: 0.4, fy: 0.5 }, 600);
      await leo.click(ctx);
      pop.remove();
      at.remove();
      ta.append(el("span", "mention", "@Michael"));
      await typeInto(ctx, ta, " can you take this one? Looks like a z-index fight with the banner.");
      ta.classList.remove("caret");
      await leo.move(ctx, { el: send, fx: 0.5, fy: 0.5 }, 700);
      await leo.click(ctx, send);
      const reply = el("div", "", `<b>Leo</b> Thanks Rosie. <span class="mention">@Michael</span> can you take this one? Looks like a z-index fight with the banner.`);
      replies.append(reply);
      ta.innerHTML = "";
      await ctx.sleep(500);
      toast(PEOPLE.leo, `<b>Leo</b> mentioned you: “can you take this one?”`, "shop.example/checkout · to Michael");
      await leo.move(ctx, { x: panel.clientWidth * 0.75, y: 40 }, 1200);
      await ctx.sleep(1800);
      replies.append(el("div", "", `<b>Michael</b> On it. The banner is fixed with z-index 1000.`));
      bell.classList.add("on");
      bell.append(el("span", "bb", "1"));
      toast(PEOPLE.michael, `<b>Michael</b> replied in a thread you're in`, "shop.example/checkout · to Leo and Rosie");
      await ctx.sleep(4000);
    }, { reset, gap: 800 });
  }

  // ---------------------------------------------------------------- issues

  {
    const stage = $(".issue-stage");
    const card = $("#issue-card");
    const create = $("#create-issue");
    const link = $("#issue-link");
    const status = $("#issue-status");
    const reply = $("#issue-reply");
    const comment = $("#issue-comment");
    const sync = $("#sync svg");
    const tabs = $$("#tracker-tabs span");
    const TRACKERS = [
      { id: "github", name: "GitHub", key: "#482", open: "Open", closed: "Closed", close: "Close issue", by: "Rosie opened this via Inklayer" },
      { id: "jira", name: "Jira", key: "NW-118", open: "To Do", closed: "Done", close: "Move to Done", by: "Reporter: Rosie · Bug · created via Inklayer" },
      { id: "linear", name: "Linear", key: "ENG-231", open: "Todo", closed: "Done", close: "Mark as Done", by: "Created by Rosie via Inklayer" },
    ];
    let ti = 0;
    const rosie = new Cursor(stage, PEOPLE.rosie, { x: 60, y: 260 });
    const michael = new Cursor(stage, PEOPLE.michael, { x: 700, y: 330 });
    const pulse = () => {
      sync.classList.remove("pulse");
      void sync.getBoundingClientRect();
      sync.classList.add("pulse");
    };
    const reset = () => {
      card.className = "card issue empty";
      card.textContent = "No issue yet";
      create.hidden = false;
      link.hidden = true;
      reply.hidden = true;
      status.innerHTML = "";
      comment.classList.remove("resolved");
    };
    scene("issues", async (ctx) => {
      reset();
      const t = TRACKERS[ti++ % TRACKERS.length];
      tabs.forEach((s) => s.classList.toggle("on", s.dataset.t === t.id));
      await ctx.sleep(500);
      await rosie.move(ctx, { el: create, fx: 0.5, fy: 0.5 }, 1100);
      await rosie.click(ctx, create);
      pulse();
      await ctx.sleep(500);
      card.className = `card issue ${t.id}`;
      card.innerHTML = `<div class="ihead"><h4>Checkout button hidden behind cookie banner <span>${t.key}</span></h4></div>
        <div class="imeta"><span class="state" id="istate">${t.open}</span> ${esc(t.by)}</div>
        <div class="ibody">
          <p>Checkout button is hidden behind the cookie banner on iPhone SE.</p>
          <p><b>Michael:</b> On it, looks like a z-index fight.</p>
          <table>
            <tr><td>Page</td><td>shop.example/checkout</td></tr>
            <tr><td>Browser</td><td>Safari 17 · iOS 17.4</td></tr>
            <tr><td>Window</td><td>375 × 667 @3x</td></tr>
            <tr><td>Console</td><td>TypeError: banner.offsetHeight is undefined</td></tr>
            <tr><td>Inklayer</td><td>Open comment #4 ↗</td></tr>
          </table>
        </div>
        <div class="row" style="margin-top:12px"><span class="pbtn" id="iclose">${t.close}</span></div>`;
      create.hidden = true;
      link.hidden = false;
      link.textContent = `${t.name} ${t.key} ↗`;
      status.innerHTML = `<span class="warn">${t.open}</span>`;
      await rosie.move(ctx, { x: 60, y: stage.clientHeight - 20 }, 1200);
      await ctx.sleep(1200);
      const close = $("#iclose");
      await michael.move(ctx, { el: close, fx: 0.5, fy: 0.5 }, 1300);
      await michael.click(ctx, close);
      const st = $("#istate");
      st.classList.add("closed");
      st.textContent = t.closed;
      await ctx.sleep(400);
      pulse();
      await ctx.sleep(500);
      comment.classList.add("resolved");
      status.innerHTML = `<span class="ok">Resolved</span>`;
      reply.hidden = false;
      reply.innerHTML = `<b>Inklayer</b> ${t.name} ${t.key} was closed, so this comment was resolved.`;
      await michael.move(ctx, { x: stage.clientWidth - 60, y: stage.clientHeight - 10 }, 1200);
      await ctx.sleep(3500);
    }, { gap: 400, reset });
  }

  // ---------------------------------------------------------------- history

  {
    const tl = $("#timeline");
    const act = $("#activity");
    const edLeo = $("#ed-leo");
    const edJohn = $("#ed-john");
    const resLeo = $("#res-leo");
    const resJohn = $("#res-john");
    const face = (p) => `<span class="face" style="--c:${p.c}">${p.name[0]}</span>`;
    const REVS = [
      [PEOPLE.rosie, "09:58", "<b>Rosie</b> commented", "Checkout button hidden on iPhone"],
      [PEOPLE.rosie, "10:03", "<b>Rosie</b> edited", "Checkout button <del>hidden</del> <ins>is hidden behind the cookie banner</ins> on iPhone<ins> SE</ins>"],
      [PEOPLE.michael, "11:20", "<b>Michael</b> created GitHub issue #482", null],
      [PEOPLE.michael, "14:02", "<b>Michael</b> resolved", null],
      [PEOPLE.rosie, "14:30", "<b>Rosie</b> reopened", "Still happens in landscape."],
      [PEOPLE.michael, "15:05", "<b>Michael</b> resolved", null],
    ];
    const ACT = [
      [PEOPLE.michael, "resolved #4", "/checkout", "2m"],
      [PEOPLE.rosie, "reopened #4", "/checkout", "37m"],
      [PEOPLE.john, "commented #1", "/summer-sale", "1h"],
      [PEOPLE.leo, "edited #2", "/summer-sale", "2h"],
    ];
    const BASE = "Checkout button is hidden behind the cookie banner on iPhone SE.";
    const revItem = ([p, time, what, diff]) => el("li", "", `${face(p)}<div class="what">${what} <time>${time}</time></div>${diff ? `<div class="diff">${diff}</div>` : ""}`);
    const actItem = ([p, what, where, time]) => el("li", "", `${face(p)}<span><b>${p.name}</b> ${what} <span class="where">${where}</span></span><time>${time}</time>`);
    const reset = () => {
      tl.innerHTML = "";
      act.innerHTML = "";
      ACT.forEach((a) => act.append(actItem(a)));
      edLeo.textContent = BASE;
      edJohn.textContent = BASE;
      resLeo.className = "res";
      resJohn.className = "res";
    };
    reset();
    scene("history", async (ctx) => {
      reset();
      for (const r of REVS) {
        tl.append(revItem(r));
        await ctx.sleep(700);
      }
      await ctx.sleep(400);
      await Promise.all([
        (async () => {
          edLeo.classList.add("caret");
          await typeInto(ctx, edLeo, " Also on Pixel 4a.", 18);
        })(),
        (async () => {
          await ctx.sleep(400);
          await typeInto(ctx, edJohn, " Blocks release.", 16);
        })(),
      ]);
      await ctx.sleep(400);
      resLeo.className = "res ok";
      resLeo.textContent = "Saved as revision 7.";
      tl.append(revItem([PEOPLE.leo, "15:41", "<b>Leo</b> edited", "on iPhone SE.<ins> Also on Pixel 4a.</ins>"]));
      act.prepend(actItem([PEOPLE.leo, "edited #4", "/checkout", "now"]));
      await ctx.sleep(900);
      resJohn.className = "res no";
      resJohn.textContent = "Not saved: Leo changed this comment while you were editing. Your text is kept so you can merge it.";
      await ctx.sleep(5000);
    }, { gap: 400, reset });
  }

  // ---------------------------------------------------------------- share

  {
    const stage = $(".share-stage");
    const icon = $("#share-icon");
    const slot = $("#share-slot");
    const url = $("#guest-url");
    const views = $("#views");
    const leo = new Cursor(stage, PEOPLE.leo, { x: 200, y: 260 });
    const TOKEN = "https://inklayer.your-company.com/s/q7Zr4mX2vLp9TfK3";
    const reset = () => {
      slot.innerHTML = "";
      icon.classList.remove("on");
      url.textContent = "inklayer.your-company.com/s/…";
      views.textContent = "0 views";
    };
    scene("share", async (ctx) => {
      reset();
      await ctx.sleep(500);
      await leo.move(ctx, { el: icon, fx: 0.5, fy: 0.5 }, 1100);
      await leo.click(ctx);
      icon.classList.add("on");
      slot.innerHTML = `<div class="shared-box"><div class="row" style="justify-content:space-between"><b style="font-weight:600">Read-only link</b><span style="color:var(--muted-foreground);font-size:12px">Open comments · 30 days</span></div>
        <div class="row"><span class="share-url">${TOKEN}</span><span class="pbtn" id="copy">Copy</span></div></div>`;
      await ctx.sleep(600);
      const copy = $("#copy");
      await leo.move(ctx, { el: copy, fx: 0.5, fy: 0.5 }, 700);
      await leo.click(ctx, copy);
      copy.textContent = "Copied";
      await ctx.sleep(600);
      url.textContent = TOKEN.replace("https://", "");
      await leo.move(ctx, { el: views, fx: 0.3, fy: 2.2 }, 1500);
      for (let v = 1; v <= 3; v++) {
        await ctx.sleep(900);
        views.textContent = `${v} view${v > 1 ? "s" : ""}`;
      }
      await ctx.sleep(3000);
    }, { gap: 600, reset });
  }

  // ---------------------------------------------------------------- docs

  {
    const l1 = $("#doc-l1");
    const l2 = $("#doc-l2");
    const gsvg = $("#graph-svg");
    const NODES = {
      qa: { x: 200, y: 165, label: "QA notes", type: "me" },
      banner: { x: 85, y: 85, label: "Cookie banner" },
      spec: { x: 315, y: 70, label: "Checkout spec" },
      ds: { x: 340, y: 205, label: "Design system" },
      c4: { x: 95, y: 235, label: "#4 Rosie", type: "c" },
      c5: { x: 190, y: 300, label: "#5 Leo", type: "c" },
      tco: { x: 200, y: 45, label: "#checkout", type: "t" },
      tmo: { x: 45, y: 160, label: "#mobile", type: "t" },
      rel: { x: 330, y: 290, label: "Release checklist", hidden: true },
    };
    const EDGES = [["qa", "banner"], ["qa", "c4"], ["qa", "tco"], ["qa", "tmo"], ["banner", "c4"], ["spec", "tco"], ["spec", "ds"], ["qa", "spec"], ["c5", "spec"], ["banner", "tmo"], ["qa", "rel", true], ["rel", "c5", true]];
    const edgeEls = EDGES.map(([a, b, late]) => {
      const l = svg("line");
      l.setAttribute("class", "edge");
      l.dataset.late = late ? "1" : "";
      l.dataset.a = a;
      l.dataset.b = b;
      gsvg.append(l);
      return l;
    });
    const nodeEls = Object.entries(NODES).map(([k, n]) => {
      const g = svg("g");
      g.setAttribute("class", `node ${n.type || ""}`);
      const c = svg("circle");
      c.setAttribute("r", n.type === "me" ? 9 : 7);
      const t = svg("text");
      t.textContent = n.label;
      t.setAttribute("x", 12);
      t.setAttribute("y", 4);
      g.append(c, t);
      gsvg.append(g);
      n.g = g;
      n.k = k;
      n.phase = Math.random() * 6;
      return n;
    });
    const showLate = (on) => {
      NODES.rel.hidden = !on;
      edgeEls.forEach((l) => l.dataset.late && l.classList.toggle("hot", on));
    };
    const graphRoot = $("#graph");
    (function frame(t) {
      const r = graphRoot.getBoundingClientRect();
      if (r.bottom > 0 && r.top < innerHeight) {
        const s = RM ? 0 : t / 1000;
        for (const n of nodeEls) {
          n.cx = n.x + Math.sin(s * 0.7 + n.phase) * 4;
          n.cy = n.y + Math.cos(s * 0.6 + n.phase) * 4;
          n.g.setAttribute("transform", `translate(${n.cx},${n.cy})`);
          n.g.style.display = n.hidden ? "none" : "";
        }
        for (const l of edgeEls) {
          const a = NODES[l.dataset.a];
          const b = NODES[l.dataset.b];
          l.setAttribute("x1", a.cx);
          l.setAttribute("y1", a.cy);
          l.setAttribute("x2", b.cx);
          l.setAttribute("y2", b.cy);
          l.style.display = a.hidden || b.hidden ? "none" : "";
        }
      }
      requestAnimationFrame(frame);
    })(0);

    const caret = (p) => {
      const c = el("span", "typing-caret", `<b>${p.name}</b>`);
      c.style.setProperty("--c", p.c);
      return c;
    };
    const typeBefore = async (ctx, node, c, text, cps) => {
      const tn = document.createTextNode("");
      node.insertBefore(tn, c);
      for (const ch of RM ? [text] : text) {
        tn.data += ch;
        await ctx.sleep(1000 / cps * rand(0.6, 1.5));
      }
    };
    const reset = () => {
      l1.innerHTML = "";
      l2.innerHTML = "";
      showLate(false);
    };
    reset();
    scene("docs", async (ctx) => {
      reset();
      const cj = caret(PEOPLE.john);
      const cr = caret(PEOPLE.rosie);
      l1.append(cj);
      l2.append(cr);
      await Promise.all([
        (async () => {
          await typeBefore(ctx, l1, cj, "Fix: lift the banner above the safe area and give the pay button 24 px of clearance. Tracked in ", 24);
          l1.insertBefore(el("span", "wl", "[[Release checklist]]"), cj);
          showLate(true);
          await typeBefore(ctx, l1, cj, ".", 10);
        })(),
        (async () => {
          await ctx.sleep(1800);
          await typeBefore(ctx, l2, cr, "Retest on iPhone SE, Pixel 4a and a 320 px window, then ", 20);
          l2.insertBefore(el("span", "mention", "@Michael"), cr);
          await typeBefore(ctx, l2, cr, " can ship it.", 18);
        })(),
      ]);
      await ctx.sleep(1500);
      cj.remove();
      cr.remove();
      await ctx.sleep(4000);
    }, { gap: 400, reset });
  }

  // ---------------------------------------------------------------- MCP

  {
    const term = $("#term");
    const SERVER = "https://inklayer.your-company.com/api/mcp";
    const set = (id, html, show = true) => {
      const n = $(id);
      n.innerHTML = html;
      n.hidden = !show;
    };
    const reset = () => {
      term.innerHTML = "";
      for (const k of [4, 5]) {
        $(`#mcp-c${k}`).classList.remove("resolved", "selected");
        set(`#mcp-s${k}`, "");
        set(`#mcp-r${k}`, "", false);
      }
    };
    const line = (html = "") => {
      const d = el("div", "", html);
      term.append(d);
      return d;
    };
    const typed = async (ctx, prefix, text, cls = "usr") => {
      const d = line(prefix);
      const s = el("span", cls);
      const cur = el("span", "cur");
      d.append(s, cur);
      for (const ch of RM ? [text] : text) {
        s.textContent += ch;
        await ctx.sleep(rand(18, 55));
      }
      cur.remove();
    };
    scene("mcp", async (ctx) => {
      reset();
      await ctx.sleep(400);
      await typed(ctx, `<span class="p">$</span> `, `claude mcp add --transport http inklayer ${SERVER}`);
      await ctx.sleep(500);
      line(`<span class="okc">Added HTTP MCP server inklayer</span>`);
      await ctx.sleep(500);
      await typed(ctx, `<span class="p">$</span> `, "claude");
      await ctx.sleep(500);
      await typed(ctx, `<span class="p">&gt;</span> `, "fix the open Inklayer comments on the checkout page");
      await ctx.sleep(700);
      line(`<span class="tool">⏺ inklayer · list_open_comments</span><span class="dim">(page: "shop.example/checkout")</span>`);
      await ctx.sleep(600);
      line(`<span class="dim">  ⎿  2 open: #4 Rosie “button hidden behind cookie banner”, #5 Leo “total doesn't update”</span>`);
      $("#mcp-c4").classList.add("selected");
      await ctx.sleep(800);
      line(`<span class="tool">⏺ inklayer · get_comment_screenshot</span><span class="dim">(comment: 4)</span>`);
      await ctx.sleep(600);
      line(`<span class="dim">  ⎿  [image 1170 × 2532, iPhone SE, Safari 17]</span>`);
      await ctx.sleep(900);
      line(`⏺ The banner is <span class="usr">position: fixed</span> with z-index 1000 and covers the pay button.`);
      await ctx.sleep(700);
      line(`<span class="tool">⏺ Update</span><span class="dim">(src/checkout/CookieBanner.tsx)  +3 −1</span>`);
      await ctx.sleep(500);
      line(`<span class="tool">⏺ Update</span><span class="dim">(src/cart/useTotals.ts)  +5 −2</span>`);
      await ctx.sleep(700);
      line(`<span class="tool">⏺ inklayer · reply_to_comment</span><span class="dim">(comment: 4, "Fixed: banner sits above the safe area…")</span>`);
      set("#mcp-r4", `<b>Michael</b> Fixed: the banner now sits above the safe area and leaves room for the pay button.`);
      await ctx.sleep(600);
      line(`<span class="tool">⏺ inklayer · set_comment_status</span><span class="dim">(comment: 4, status: "resolved")</span>`);
      $("#mcp-c4").classList.add("resolved");
      $("#mcp-c4").classList.remove("selected");
      set("#mcp-s4", `<span class="ok">Resolved</span>`);
      await ctx.sleep(700);
      $("#mcp-c5").classList.add("selected");
      line(`<span class="tool">⏺ inklayer · reply_to_comment</span><span class="dim">(comment: 5, "Totals now recalculate when a coupon is removed.")</span>`);
      set("#mcp-r5", `<b>Michael</b> Totals now recalculate when a coupon is removed.`);
      await ctx.sleep(600);
      line(`<span class="tool">⏺ inklayer · set_comment_status</span><span class="dim">(comment: 5, status: "resolved")</span>`);
      $("#mcp-c5").classList.add("resolved");
      $("#mcp-c5").classList.remove("selected");
      set("#mcp-s5", `<span class="ok">Resolved</span>`);
      await ctx.sleep(700);
      line(`<span class="okc">⏺ Both comments fixed, replied to and resolved.</span>`);
      await ctx.sleep(6000);
    }, { gap: 300, reset });
  }
})();
