/* dnsite loader -- reads a site out of DNS TXT records and renders it. See ../SPEC.md */
(() => {
"use strict";

const params = new URLSearchParams(location.search);
const HOST = (params.get("host") || location.hostname).toLowerCase();
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
const DOH = params.get("doh") || (LOCAL ? "/dns-query" : "https://cloudflare-dns.com/dns-query");
const $app = document.getElementById("app");
const $status = document.getElementById("status");
const $prog = document.getElementById("prog");

/* ---------- DNS ---------- */
async function resolveTXT(name) {
  const r = await fetch(`${DOH}?name=${encodeURIComponent(name)}&type=TXT`, { headers: { accept: "application/dns-json" } });
  if (!r.ok) throw new Error(`resolver answered ${r.status} for ${name}`);
  const j = await r.json();
  if (!j.Answer) return null;
  const parts = [];
  for (const a of j.Answer) {
    if (a.type !== 16) continue;
    // data is one or more quoted strings: "abc" "def"  (escapes: \" and \\)
    // Cloudflare quotes each string; Google's resolver returns the text bare. Accept both.
    const re = /"((?:[^"\\]|\\.)*)"/g; let m, any = false;
    while ((m = re.exec(a.data))) { parts.push(m[1].replace(/\\(.)/g, "$1")); any = true; }
    if (!any && a.data) parts.push(a.data);
  }
  return parts.length ? parts.join("") : null;
}

let done = 0, total = 1, txtChars = 0;
const tick = () => { done++; if ($prog) $prog.style.width = Math.min(100, 100 * done / total) + "%"; };

async function loadBlob(prefix, n, host = HOST) {
  if (!n) return null;
  const chunks = await Promise.all(Array.from({ length: n }, (_, i) => resolveTXT(`${prefix}${i}.${host}`).then(v => { tick(); return v; })));
  const missing = chunks.findIndex(c => c == null);
  if (missing >= 0) throw new Error(`record ${prefix}${missing}.${host} is missing -- the zone may be half published`);
  const b64 = chunks.join("");
  txtChars += b64.length;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseManifest(s) {
  const m = {}; for (const kv of s.trim().split(/\s+/)) { const [k, v] = kv.split("="); m[k] = v; }
  if (m.v !== "1") throw new Error(`unknown dnsite format version "${m.v}"`);
  return { site: +m.site || 0, db: +m.db || 0, map: +m.map || 0, sha: m.sha || "" };
}

/* ---------- site language ---------- */
function parseSite(text) {
  const props = {}, blocks = [];
  let cur = null, inHead = true;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || /^\s*\/\//.test(line)) continue;
    if (cur && /^\s+\S/.test(line)) {                       // indented: option of the open block
      const m = line.trim().match(/^([\w-]+):\s*(.*)$/);
      if (m) cur.opts[m[1]] = m[2]; continue;
    }
    cur = null;
    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) { inHead = false; blocks.push({ kind: "heading", level: h[1].length, text: h[2] }); continue; }
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) { blocks.push({ kind: "text", text: line }); continue; }
    const [, key, val] = kv;
    if (inHead && !["text", "chart", "number", "image", "divider"].includes(key)) { props[key] = val; continue; }
    inHead = false;
    if (key === "chart" || key === "number" || key === "image") { cur = { kind: key, type: val, opts: {} }; blocks.push(cur); }
    else if (key === "divider") blocks.push({ kind: "divider" });
    else if (key === "text") blocks.push({ kind: "text", text: val });
    else blocks.push({ kind: "text", text: line });
  }
  return { props, blocks };
}

/* ---------- markdown-lite (whitelist, never raw HTML) ---------- */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function md(s) {
  let h = esc(s);
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" rel="noopener">${t}</a>`);
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/\*([^*]+)\*/g, "<i>$1</i>");
  return h;
}

/* ---------- SQL ---------- */
let db = null, SQLMod = null;
async function ensureSQL() { return SQLMod || (SQLMod = await initSqlJs({ locateFile: f => "vendor/" + f })); }
function query(sql) {
  if (!db) throw new Error("this chart needs a database but the site has none");
  const res = db.exec(sql);
  if (!res.length) return { columns: [], rows: [] };
  const { columns, values } = res[0];
  return { columns, rows: values.map(v => Object.fromEntries(columns.map((c, i) => [c, v[i]]))) };
}
const sqlLit = v => typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`;

/* ---------- number formatting ---------- */
function formatter(spec) {
  if (!spec || spec === ",") return v => v == null ? "" : new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(v);
  if (spec === "%") return v => v == null ? "" : new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format(v);
  if (spec === "k") return v => v == null ? "" : new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v);
  const dec = (spec.split(".")[1] || "").length;
  return v => v == null ? "" : new Intl.NumberFormat("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(v);
}

/* ---------- SVG helpers ---------- */
const NS = "http://www.w3.org/2000/svg";
function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}
const txt = (parent, x, y, s, attrs = {}) => { const t = el("text", { x, y, ...attrs }, parent); t.textContent = s; return t; };
const title = (node, s) => { const t = el("title", {}, node); t.textContent = s; };
const lin = (d0, d1, r0, r1) => v => d0 === d1 ? (r0 + r1) / 2 : r0 + (v - d0) / (d1 - d0) * (r1 - r0);
function ticks(lo, hi, n = 5) {
  if (lo === hi) return [lo];
  const span = hi - lo, step0 = Math.pow(10, Math.floor(Math.log10(span / n)));
  const err = span / n / step0, step = step0 * (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1);
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + step / 1e6; v += step) out.push(+v.toFixed(10));
  return out;
}
const COLORS = ["--c1", "--c2", "--c3", "--c4", "--c5", "--c6", "--c7", "--c8"].map(v => `var(${v})`);
const seriesOf = rows => [...new Set(rows.map(r => r.series ?? ""))];
const accentRGB = () => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#1f6feb";

/* ---------- charts ---------- */
const charts = {};

charts.bars = (fig, rows, o) => {
  const fmt = formatter(o.format), W = 640, mL = 48, mR = 8, mT = 22, n = rows.length || 1;
  const longest = Math.max(0, ...rows.map(r => String(r.label ?? "").length)), bw0 = (W - mL - mR) / n, tilt = n > 8 || longest * 6.5 > bw0;
  const mB = tilt ? 40 + Math.min(longest, 22) * 4 : 40;
  const vals = rows.map(r => +r.value || 0), max = Math.max(0, ...vals), H = 260 + mB;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, fig);
  const y = lin(0, max || 1, H - mB, mT), bw = bw0, gap = Math.min(bw * .25, 10);
  const g = el("g", { class: "grid" }, svg);
  for (const t of ticks(0, max || 1, 4)) { el("line", { x1: mL, x2: W - mR, y1: y(t), y2: y(t) }, g); txt(g, mL - 6, y(t) + 4, fmt(t), { class: "lbl", "text-anchor": "end" }); }
  rows.forEach((r, i) => {
    const x = mL + i * bw + gap / 2, v = +r.value || 0;
    const rect = el("rect", { class: "bar", x, y: y(v), width: bw - gap, height: Math.max(0, y(0) - y(v)), rx: 2, fill: r.color }, svg);
    title(rect, `${r.label}: ${fmt(v)}`);
    txt(svg, x + (bw - gap) / 2, y(v) - 4, fmt(v), { class: "val", "text-anchor": "middle" });
    const lbl = String(r.label ?? ""), short = tilt && lbl.length > 22 ? lbl.slice(0, 21) + "…" : lbl;
    const t = txt(svg, x + (bw - gap) / 2, H - mB + 14, short, { class: "lbl", "text-anchor": tilt ? "end" : "middle" });
    if (tilt) t.setAttribute("transform", `rotate(-35 ${x + (bw - gap) / 2} ${H - mB + 14})`);
  });
};

charts.hbars = (fig, rows, o) => {
  const fmt = formatter(o.format), W = 640, rowH = 26, mR = 70, H = rows.length * rowH + 8;
  const mL = Math.min(260, Math.max(90, 14 + 6.4 * Math.max(0, ...rows.map(r => String(r.label ?? "").length))));   // room for the longest label
  const max = Math.max(0, ...rows.map(r => +r.value || 0)) || 1;
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, fig);
  const x = lin(0, max, mL, W - mR);
  rows.forEach((r, i) => {
    const yy = 4 + i * rowH, v = +r.value || 0;
    txt(svg, mL - 8, yy + 16, String(r.label ?? ""), { class: "lbl", "text-anchor": "end", style: "font-size:12px" });
    const rect = el("rect", { class: "bar", x: mL, y: yy + 3, width: Math.max(0, x(v) - mL), height: rowH - 8, rx: 2, fill: r.color }, svg);
    title(rect, `${r.label}: ${fmt(v)}`);
    txt(svg, x(v) + 6, yy + 16, fmt(v), { class: "val" });
  });
};

function xyChart(fig, rows, o, area) {
  const fmt = formatter(o.format), W = 640, H = 300, mL = 50, mR = 14, mT = 14, mB = 34;
  const series = seriesOf(rows), xs = [...new Set(rows.map(r => +r.x))].sort((a, b) => a - b);
  const ymax = Math.max(0, ...rows.map(r => +r.y || 0)) || 1, ymin = Math.min(0, ...rows.map(r => +r.y || 0));
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, fig);
  const x = lin(xs[0], xs[xs.length - 1], mL, W - mR), y = lin(ymin, ymax, H - mB, mT);
  const g = el("g", { class: "grid" }, svg);
  for (const t of ticks(ymin, ymax, 4)) { el("line", { x1: mL, x2: W - mR, y1: y(t), y2: y(t) }, g); txt(g, mL - 6, y(t) + 4, fmt(t), { class: "lbl", "text-anchor": "end" }); }
  const ax = el("g", { class: "axis" }, svg);
  for (const t of ticks(xs[0], xs[xs.length - 1], 6)) txt(ax, x(t), H - mB + 16, String(t), { "text-anchor": "middle" });
  series.forEach((s, si) => {
    const pts = rows.filter(r => (r.series ?? "") === s).sort((a, b) => a.x - b.x);
    const d = pts.map((p, i) => `${i ? "L" : "M"}${x(+p.x).toFixed(1)} ${y(+p.y || 0).toFixed(1)}`).join(" ");
    const color = pts[0].color || COLORS[si % COLORS.length];
    if (area) el("path", { d: `${d} L${x(+pts[pts.length - 1].x).toFixed(1)} ${y(0)} L${x(+pts[0].x).toFixed(1)} ${y(0)} Z`, fill: color, opacity: .18 }, svg);
    const path = el("path", { class: "series", d, stroke: color }, svg); title(path, s || o.title || "");
    for (const p of pts) { const c = el("circle", { class: "dot", cx: x(+p.x), cy: y(+p.y || 0), r: 3.2, fill: color }, svg); title(c, `${s ? s + " · " : ""}${p.x}: ${fmt(+p.y)}`); }
  });
  if (series.length > 1 || series[0]) legend(fig, series.map((s, i) => [s, rows.find(r => (r.series ?? "") === s).color || COLORS[i % COLORS.length]]));
}
charts.line = (f, r, o) => xyChart(f, r, o, false);
charts.area = (f, r, o) => xyChart(f, r, o, true);

charts.scatter = (fig, rows, o) => {
  const fmt = formatter(o.format), W = 640, H = 340, mL = 50, mR = 14, mT = 14, mB = 34;
  const xs = rows.map(r => +r.x), ys = rows.map(r => +r.y);
  const x = lin(Math.min(...xs), Math.max(...xs), mL, W - mR), y = lin(Math.min(0, ...ys), Math.max(...ys), H - mB, mT);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, fig);
  const g = el("g", { class: "grid" }, svg);
  for (const t of ticks(Math.min(0, ...ys), Math.max(...ys), 4)) { el("line", { x1: mL, x2: W - mR, y1: y(t), y2: y(t) }, g); txt(g, mL - 6, y(t) + 4, fmt(t), { class: "lbl", "text-anchor": "end" }); }
  for (const t of ticks(Math.min(...xs), Math.max(...xs), 6)) txt(svg, x(t), H - mB + 16, String(t), { class: "lbl", "text-anchor": "middle" });
  rows.forEach((r, i) => { const c = el("circle", { class: "dot", cx: x(+r.x), cy: y(+r.y), r: 5, fill: r.color || COLORS[0], opacity: .8 }, svg); title(c, `${r.label ?? ""} (${r.x}, ${fmt(+r.y)})`); if (r.label && rows.length <= 30) txt(svg, x(+r.x) + 7, y(+r.y) + 4, r.label, { class: "lbl" }); });
};

charts.bignumber = (fig, rows, o) => {
  const fmt = formatter(o.format), d = document.createElement("div"); d.className = "bignumber";
  for (const r of rows) { const n = document.createElement("div"); n.innerHTML = `<div class="n">${esc(fmt(+r.value))}</div><div class="l">${md(r.label ?? "")}</div>`; d.appendChild(n); }
  fig.appendChild(d);
};

charts.table = (fig, rows, o, cols) => { const w = document.createElement("div"); w.className = "tbl"; w.appendChild(table(rows, cols, formatter(o.format))); fig.appendChild(w); };

charts.slope = (fig, rows, o) => {
  const fmt = formatter(o.format), W = 640, H = 360, mL = 190, mR = 190, mT = 24, mB = 24;
  const xs = [...new Set(rows.map(r => +r.x))].sort((a, b) => a - b), x0 = xs[0], x1 = xs[xs.length - 1];
  const ymax = Math.max(...rows.map(r => +r.y || 0)) || 1, y = lin(0, ymax, H - mB, mT);
  const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, role: "img" }, fig);
  txt(svg, mL, 14, String(x0), { class: "lbl", "text-anchor": "middle" }); txt(svg, W - mR, 14, String(x1), { class: "lbl", "text-anchor": "middle" });
  el("line", { x1: mL, x2: mL, y1: mT, y2: H - mB, class: "grid", stroke: "var(--rule)" }, svg); el("line", { x1: W - mR, x2: W - mR, y1: mT, y2: H - mB, stroke: "var(--rule)" }, svg);
  const spread = items => { // nudge labels apart so they never overlap (min 13px)
    items.sort((p, q) => p.y - q.y); for (let i = 1; i < items.length; i++) if (items[i].y - items[i - 1].y < 13) items[i].y = items[i - 1].y + 13;
    const over = items.length ? items[items.length - 1].y - (H - 8) : 0;           // keep the stack inside the chart
    if (over > 0) for (let i = items.length - 1; i >= 0; i--) items[i].y = Math.min(items[i].y - over, i < items.length - 1 ? items[i + 1].y - 13 : Infinity);
    return items;
  };
  const left = [], right = [];
  seriesOf(rows).forEach((s, i) => {
    const a = rows.find(r => (r.series ?? "") === s && +r.x === x0), b = rows.find(r => (r.series ?? "") === s && +r.x === x1);
    if (!a || !b) return;
    const color = a.color || COLORS[i % COLORS.length];
    const p = el("path", { class: "series", d: `M${mL} ${y(+a.y)} L${W - mR} ${y(+b.y)}`, stroke: color }, svg); title(p, `${s}: ${fmt(+a.y)} → ${fmt(+b.y)}`);
    left.push({ y: y(+a.y), t: `${s} ${fmt(+a.y)}` }); right.push({ y: y(+b.y), t: `${fmt(+b.y)} ${s}` });
  });
  for (const l of spread(left)) txt(svg, mL - 8, l.y + 4, l.t, { class: "lbl", "text-anchor": "end" });
  for (const r of spread(right)) txt(svg, W - mR + 8, r.y + 4, r.t, { class: "lbl" });
};

charts.waffle = (fig, rows, o) => {
  const fmt = formatter(o.format), total = rows.reduce((s, r) => s + (+r.value || 0), 0) || 1, w = document.createElement("div"); w.className = "waffle";
  let acc = 0; const cells = [];
  rows.forEach((r, i) => { acc += (+r.value || 0) / total * 100; const color = r.color || COLORS[i % COLORS.length]; while (cells.length < Math.round(acc) && cells.length < 100) cells.push(color); });
  for (let i = 0; i < 100; i++) { const c = document.createElement("i"); if (cells[i]) c.style.background = cells[i]; w.appendChild(c); }
  fig.appendChild(w); legend(fig, rows.map((r, i) => [`${r.label} ${fmt(+r.value)}`, r.color || COLORS[i % COLORS.length]]));
};

charts.timeline = (fig, rows) => {
  const ul = document.createElement("ul"); ul.className = "timeline";
  for (const r of rows) { const li = document.createElement("li"); li.innerHTML = `<b>${esc(r.x ?? "")}</b><div>${md(r.label ?? "")}</div>${r.note ? `<div class="note">${md(r.note)}</div>` : ""}`; ul.appendChild(li); }
  fig.appendChild(ul);
};

/* maps */
let mapSVG = null, centroids = {};
async function ensureMap(customText) {
  const [mapText, cents] = await Promise.all([
    customText || fetch("assets/world.svg").then(r => r.ok ? r.text() : null).catch(() => null),
    fetch("assets/centroids.json").then(r => r.ok ? r.json() : {}).catch(() => ({})),
  ]);
  if (mapText) { try { mapSVG = cleanSVG(mapText); } catch (e) { console.warn("map:", e); } }
  centroids = cents || {};
}
function mapClone(fig) {
  const svg = mapSVG.cloneNode(true); svg.classList.add("map"); svg.setAttribute("role", "img");
  for (const p of svg.querySelectorAll("#countries path")) { p.classList.add("land"); title(p, p.dataset.name || p.id); }
  for (const p of svg.querySelectorAll("#graticule path")) p.classList.add("graticule");
  fig.appendChild(svg); return svg;
}
function mixColor(t) { // light rule colour -> accent
  const a = accentRGB().match(/\w\w/g).map(h => parseInt(h, 16));
  const r = a.map(c => Math.round(c + (236 - c) * (1 - t)));   // 236 ≈ pale end
  return `rgb(${r.join(",")})`;
}
charts.choropleth = (fig, rows, o) => {
  const fmt = formatter(o.format), svg = mapClone(fig), vals = rows.map(r => +r.value || 0), max = Math.max(...vals) || 1;
  const scale = o.scale === "linear" ? v => v / max : v => Math.log1p(v) / Math.log1p(max);
  for (const r of rows) { const p = svg.querySelector(`#countries path[id="${CSS.escape(String(r.iso2))}"]`); if (!p) continue; p.style.fill = mixColor(.15 + .85 * scale(+r.value || 0)); p.querySelector("title").textContent = `${p.dataset.name || r.iso2}: ${fmt(+r.value)}`; }
  const vb = svg.viewBox.baseVal, g = el("g", { class: "ramp" }, svg), rw = 140, rx = vb.width - rw - 10, ry = vb.height - 22;
  for (let i = 0; i < 20; i++) el("rect", { x: rx + i * rw / 20, y: ry, width: rw / 20 + .5, height: 8, fill: mixColor(.15 + .85 * i / 19) }, g);
  txt(g, rx, ry - 4, "fewer", { class: "lbl" }); txt(g, rx + rw, ry - 4, fmt(max), { class: "lbl", "text-anchor": "end" });
};
charts.flowmap = (fig, rows, o) => {
  const fmt = formatter(o.format), svg = mapClone(fig), from = centroids[(o.from || "").toUpperCase()];
  if (!from) { fig.appendChild(Object.assign(document.createElement("p"), { className: "note", textContent: `flowmap: unknown origin "${o.from}"` })); return; }
  const top = +o.top || 30, data = rows.filter(r => centroids[String(r.iso2).toUpperCase()] && +r.value > 0).sort((a, b) => b.value - a.value).slice(0, top);
  const max = Math.max(...data.map(r => +r.value)) || 1;
  const nameOf = r => svg.querySelector(`#countries path[id="${CSS.escape(String(r.iso2))}"]`)?.dataset.name || r.dest || r.iso2;

  // focus: crop the view to a region -- a preset name or a list of ISO codes (bbox of their centroids, padded)
  const PRESETS = { europe: "IS,NO,SE,FI,GB,IE,PT,ES,FR,DE,PL,IT,GR,CY,TR,UA,BY,RO,BG", americas: "CA,US,MX,BR,AR,CL,PE,CO,VE", world: "" };
  const focus = o.focus ? (PRESETS[o.focus.toLowerCase()] ?? o.focus) : "";
  let vb = svg.viewBox.baseVal, scale = 1;
  if (focus) {
    const pts = focus.split(/[,\s]+/).map(c => centroids[c.toUpperCase()]).filter(Boolean);
    if (pts.length) {
      const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), pad = 18;
      const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad, w = Math.max(...xs) - x0 + pad, h = Math.max(...ys) - y0 + pad;
      svg.setAttribute("viewBox", `${x0.toFixed(1)} ${y0.toFixed(1)} ${w.toFixed(1)} ${h.toFixed(1)}`);
      vb = { x: x0, y: y0, width: w, height: h }; scale = w / 1000;          // sizes shrink with the crop
      svg.querySelector("#graticule")?.remove();
    }
  }
  const S = Math.max(.25, scale), R = v => (1.5 + 9 * Math.sqrt(v / max)) * S;

  // tint the destination countries so the clustered ones still read where arcs pile up
  for (const r of data) { const p = svg.querySelector(`#countries path[id="${CSS.escape(String(r.iso2))}"]`); if (!p) continue; p.style.fill = mixColor(.08 + .55 * Math.pow(Math.log1p(+r.value) / Math.log1p(max), 2)); p.querySelector("title").textContent = `${nameOf(r)}: ${fmt(+r.value)}`; }

  const g = el("g", {}, svg);
  for (const r of data) {
    const [x1, y1] = centroids[String(r.iso2).toUpperCase()], dx = x1 - from[0], dy = y1 - from[1], dist = Math.hypot(dx, dy) || 1;
    const bulge = dist * .22, nx = -dy / dist, ny = dx / dist, sgn = ny < 0 ? 1 : -1;   // always bow upward (north)
    const cx = (from[0] + x1) / 2 + nx * bulge * sgn, cy = (from[1] + y1) / 2 + ny * bulge * sgn;
    const p = el("path", { class: "arc", d: `M${from[0]} ${from[1]} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${x1} ${y1}`, "stroke-width": ((.5 + 6 * Math.sqrt(+r.value / max)) * S).toFixed(2) }, g);
    title(p, `${nameOf(r)}: ${fmt(+r.value)}`);
  }
  for (const r of data) { const [x1, y1] = centroids[String(r.iso2).toUpperCase()]; const c = el("circle", { class: "node", cx: x1, cy: y1, r: R(+r.value).toFixed(2) }, g); title(c, `${nameOf(r)}: ${fmt(+r.value)}`); }
  el("circle", { class: "node origin", cx: from[0], cy: from[1], r: (4 * S).toFixed(2) }, g);

  // labels for the largest destinations, nudged apart, kept inside the view
  const nLab = o.labels == null ? 8 : +o.labels, fs = 13 * S, labs = [];
  for (const r of data.slice(0, nLab)) {
    const [x1, y1] = centroids[String(r.iso2).toUpperCase()], right = x1 >= from[0] || x1 + 70 * S < vb.x + vb.width;
    labs.push({ r, x: x1 + (right ? 1 : -1) * (R(+r.value) + 3 * S), y: y1 + fs * .35, anchor: right ? "start" : "end", text: `${nameOf(r)} ${fmt(+r.value)}` });
  }
  labs.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labs.length; i++) if (labs[i].y - labs[i - 1].y < fs * 1.15 && Math.abs(labs[i].x - labs[i - 1].x) < 90 * S) labs[i].y = labs[i - 1].y + fs * 1.15;
  const lg = el("g", { class: "labels" }, svg);
  for (const l of labs) {
    const y = Math.min(Math.max(l.y, vb.y + fs), vb.y + vb.height - 2);
    const t = txt(lg, l.x, y, l.text, { class: "maplbl", "text-anchor": l.anchor, "font-size": fs.toFixed(1), "paint-order": "stroke", stroke: "var(--card)", "stroke-width": (3 * S).toFixed(1), "stroke-linejoin": "round" });
    t.style.fill = "var(--ink)";
  }

  // size key, bottom-left
  const key = el("g", { class: "key" }, svg), kx = vb.x + 12 * S, ky = vb.y + vb.height - 10 * S;
  for (const v of [max, max / 10]) { const rr = R(v); el("circle", { class: "node", cx: kx + R(max), cy: ky - rr, r: rr.toFixed(2), opacity: .35 }, key); const t = txt(key, kx + R(max) * 2 + 4 * S, ky - 2 * rr + fs * .35, fmt(v), { class: "maplbl" }); t.style.cssText = `font-size:${(10 * S).toFixed(1)}px;font-weight:400;fill:var(--muted)`; }
};

/* shared bits */
function legend(fig, items) { const l = document.createElement("div"); l.className = "legend"; for (const [name, color] of items) { const s = document.createElement("span"); s.innerHTML = `<i style="background:${esc(color)}"></i>${esc(name)}`; l.appendChild(s); } fig.appendChild(l); }
function table(rows, cols, fmt) {
  const t = document.createElement("table"), numeric = c => rows.length && rows.every(r => r[c] == null || typeof r[c] === "number");
  t.innerHTML = `<thead><tr>${cols.map(c => `<th class="${numeric(c) ? "num" : ""}">${esc(c)}</th>`).join("")}</tr></thead>`;
  const tb = document.createElement("tbody");
  const plain = c => /^(year|x)$/i.test(c);   // years and x positions are not quantities: no thousands separators
  for (const r of rows) tb.innerHTML += `<tr>${cols.map(c => `<td class="${numeric(c) ? "num" : ""}">${esc(typeof r[c] === "number" && !plain(c) ? fmt(r[c]) : r[c] ?? "")}</td>`).join("")}</tr>`;
  t.appendChild(tb); return t;
}

function renderChart(b) {
  const fig = document.createElement("figure"), o = b.opts, type = b.kind === "number" ? "bignumber" : b.type;
  if (o.title) { const c = document.createElement("figcaption"); c.textContent = o.title; fig.appendChild(c); }
  const body = document.createElement("div");
  let stops = null, $out = null;
  if (o.slider) {
    const stopsSql = o.stops || (() => { const m = (o.query || "").match(/\bfrom\s+([\w.]+)/i); return m ? `SELECT DISTINCT ${o.slider} FROM ${m[1]} ORDER BY 1` : null; })();
    try { stops = stopsSql ? query(stopsSql).rows.map(r => Object.values(r)[0]) : null; } catch (e) { stops = null; }
    if (stops && stops.length) {
      const s = document.createElement("div"); s.className = "slider";
      s.innerHTML = `<span>${esc(o.slider)}</span><input type="range" min="0" max="${stops.length - 1}" value="${stops.length - 1}" step="1" aria-label="${esc(o.slider)}"><output></output>`;
      fig.appendChild(s); $out = s.querySelector("output");
      s.querySelector("input").addEventListener("input", e => draw(stops[+e.target.value]));
    }
  }
  fig.appendChild(body);
  let last = null;
  function draw(stop) {
    body.replaceChildren();
    if ($out) $out.value = String(stop);
    let sql = o.query || "";
    if (stop != null) sql = sql.replace(new RegExp(`\\{${o.slider}\\}`, "g"), sqlLit(stop));
    let res;
    try { res = sql ? query(sql) : { columns: [], rows: [] }; } catch (e) { body.innerHTML = `<p class="note">query failed: ${esc(e.message)}</p>`; return; }
    last = res;
    try { (charts[type] || charts.table)(body, res.rows, o, res.columns); } catch (e) { body.innerHTML = `<p class="note">${esc(type)}: ${esc(e.message)}</p>`; }
  }
  draw(stops ? stops[stops.length - 1] : null);
  if (o.note) { const n = document.createElement("p"); n.className = "note"; n.innerHTML = md(o.note); fig.appendChild(n); }
  if (type !== "table" && o.query) {
    const tools = document.createElement("div"); tools.className = "tools";
    const btn = document.createElement("button"); btn.type = "button"; btn.textContent = "Show table"; let open = false, wrap = null;
    btn.onclick = () => { open = !open; btn.textContent = open ? "Hide table" : "Show table"; if (open) { wrap = document.createElement("div"); wrap.className = "tbl"; wrap.appendChild(table(last.rows, last.columns, formatter(o.format))); fig.appendChild(wrap); } else wrap?.remove(); };
    tools.appendChild(btn); fig.appendChild(tools);
  }
  return fig;
}

/* ---------- SVG sanitising (maps and inline images are data, not code) ---------- */
function cleanSVG(text) {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg") throw new Error("not an SVG");
  for (const bad of root.querySelectorAll("script,foreignObject,iframe,use[href^='http'],use[*|href^='http'],a")) bad.remove();
  for (const e of root.querySelectorAll("*")) for (const a of [...e.attributes]) {
    if (/^on/i.test(a.name) || (/href$/i.test(a.name) && !a.value.startsWith("#")) || /url\((?!['"]?#)/.test(a.value)) e.removeAttribute(a.name);
  }
  return document.importNode(root, true);
}

/* ---------- page ---------- */
function render(site, manifest, stats, root = $app, host = HOST) {
  const { props, blocks } = site;
  (root === $app ? document.documentElement : root).dataset.theme = props.theme || "paper";
  if (props.accent && /^#[0-9a-f]{3,8}$/i.test(props.accent)) (root === $app ? document.documentElement : root).style.setProperty("--accent", props.accent);
  if (root === $app) document.title = props.site || host;
  if (props.lang) document.documentElement.lang = props.lang;
  root.replaceChildren();
  const head = document.createElement("header"); head.className = "site";
  head.innerHTML = `<h1>${md(props.site || host)}</h1>${props.tagline ? `<p class="tagline">${md(props.tagline)}</p>` : ""}${props.by || props.date ? `<p class="byline">${[props.by, props.date].filter(Boolean).map(md).join(" · ")}</p>` : ""}`;
  root.appendChild(head);
  let section = null; const sec = () => section || (section = root.appendChild(document.createElement("section")));
  for (const b of blocks) {
    let node;
    if (b.kind === "heading") { if (b.level === 1) { section = document.createElement("section"); root.appendChild(section); } node = document.createElement(b.level === 1 ? "h2" : "h3"); node.innerHTML = md(b.text); }
    else if (b.kind === "text") { node = document.createElement("p"); node.innerHTML = md(b.text); }
    else if (b.kind === "divider") node = document.createElement("hr");
    else if (b.kind === "image") {
      node = document.createElement("div"); node.className = "svgimg";
      try { const r = query(`SELECT body FROM svg WHERE name=${sqlLit(b.type)}`).rows[0]; if (!r) throw new Error(`no svg named "${b.type}"`); node.appendChild(cleanSVG(r.body)); if (b.opts.alt) node.firstChild.setAttribute("aria-label", b.opts.alt); }
      catch (e) { node.innerHTML = `<p class="note">image: ${esc(e.message)}</p>`; }
    }
    else node = renderChart(b);
    node.classList.add("reveal"); sec().appendChild(node);
  }
  const foot = document.createElement("footer"); foot.className = "site";
  foot.innerHTML = `${props.source ? `<p>Source: ${md(props.source)}</p>` : ""}<p>This site is served from DNS. ${stats.records} TXT records (${(stats.chars / 1024).toFixed(1)} KB of text) unpack to ${(stats.bytes / 1024).toFixed(0)} KB, rendered in your browser${db ? " with SQLite" : ""}. Read it yourself: <code>dig TXT _dnsite.${esc(host)}</code></p>`;
  root.appendChild(foot);
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" });
  root.querySelectorAll(".reveal").forEach(n => io.observe(n));
}

function fail(msg) {
  $status.className = "status err";
  $status.innerHTML = `<p><b>Couldn't load a site for <code>${esc(HOST)}</code>.</b></p><p>${esc(msg)}</p><p>A dnsite needs a manifest record:</p><code>dig TXT _dnsite.${esc(HOST)}</code>`;
}

/* the same code powers the builder page (make.html): it sets data-noboot and drives this API */
window.DNSite = {
  parseSite, render, cleanSVG, resolveTXT, loadBlob, parseManifest, ensureMap,
  chartTypes: () => Object.keys(charts),
  async setDatabase(bytes) { const SQL = await ensureSQL(); if (db) db.close(); db = bytes ? new SQL.Database(bytes) : null; return db; },
  async newDatabase() { const SQL = await ensureSQL(); return new SQL.Database(); },
  getDatabase: () => db,
  useDatabase(d) { if (db && db !== d) db.close(); db = d; },
  query,
};
if (!document.body.dataset.noboot) (async () => {
  try {
    const manifestTxt = await resolveTXT(`_dnsite.${HOST}`);
    if (!manifestTxt) return fail("No _dnsite TXT record was found at this name.");
    const man = parseManifest(manifestTxt);
    total = man.site + man.db + man.map + 1; tick();
    const [siteBytes, dbBytes, mapBytes, SQL] = await Promise.all([
      loadBlob("s", man.site), loadBlob("d", man.db), loadBlob("m", man.map),
      man.db ? ensureSQL() : null,
    ]);
    if (!siteBytes) return fail("The manifest lists no site document.");
    const site = parseSite(new TextDecoder().decode(siteBytes));
    if (dbBytes) db = new SQL.Database(dbBytes);
    // the built-in world map is only fetched when a chart needs it, so text-only sites stay tiny
    const needsMap = mapBytes || site.blocks.some(b => b.kind === "chart" && /^(choropleth|flowmap)$/.test(b.type));
    if (needsMap) await ensureMap(mapBytes ? new TextDecoder().decode(mapBytes) : null);
    const bytes = (siteBytes?.length || 0) + (dbBytes?.length || 0) + (mapBytes?.length || 0);
    render(site, man, { records: total, bytes, chars: txtChars });
  } catch (e) { console.error(e); fail(e.message); }
})();
})();
