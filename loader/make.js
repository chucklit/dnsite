/* DNSite builder: blocks on the left, the real site on the right. The text form is the source of truth;
   the block list, forms, data and image tabs all edit the same {props, blocks} object and re-serialize it. */
(() => {
"use strict";
const D = window.DNSite;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $src = $("src"), $preview = $("preview"), $state = $("state"), $host = $("host");

/* ---------- state ---------- */
let site = { props: {}, blocks: [] };
let db = null;                     // sql.js Database shared with the loader (D.useDatabase)
const tables = new Map();          // name -> { rows, cols }
let sel = -1;                      // selected block index
let timer = null;

const EXAMPLE = `site: My first DNSite
tagline: A page that lives in DNS
theme: paper
accent: #1d5fc2

text: This page is stored in TXT records and rendered in your browser. Edit it on the left and watch it change.

post: Hello
  date: ${new Date().toISOString().slice(0, 10)}
text: Posts get an index and a permanent link automatically. Add a CSV on the **Data** tab, then insert a chart and point it at your table.
divider:
text: When it looks right, open **Publish** to get the records.
`;

/* ---------- persistence (per-browser convenience only) ---------- */
function save() {
  try {
    localStorage.setItem("dnsite.make.src", D.serializeSite(site)); localStorage.setItem("dnsite.make.host", $host.value);
    const bytes = db ? db.export() : null;
    if (bytes && bytes.length < 1.5e6) localStorage.setItem("dnsite.make.db", b64(bytes)); else localStorage.removeItem("dnsite.make.db");
  } catch (e) {}
}
function b64(bytes) { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function unb64(s) { const bin = atob(s), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }

/* ---------- tabs ---------- */
for (const b of document.querySelectorAll(".tabs [role=tab]")) b.onclick = () => showTab(b.dataset.tab);
function showTab(name) {
  for (const x of document.querySelectorAll(".tabs [role=tab]")) x.setAttribute("aria-selected", x.dataset.tab === name);
  for (const p of document.querySelectorAll(".pane")) p.classList.toggle("on", p.id === "pane-" + name);
  if (name === "text") $src.value = D.serializeSite(site);
  if (name === "publish") updatePublish();
  if (name === "assets") renderAssets();
}
$src.addEventListener("input", () => { site = D.parseSite($src.value); sel = -1; changed(false); });

/* one place every edit goes through */
function changed(rebuildList = true) {
  save(); if (rebuildList) renderList();
  clearTimeout(timer); timer = setTimeout(render, 120);
}

/* ---------- database ---------- */
async function ensureDb() { if (!db) { db = await D.newDatabase(); D.useDatabase(db); } return db; }
function refreshTables() {
  tables.clear();
  if (!db) return renderTables();
  for (const r of D.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('assets','svg')").rows)
    tables.set(r.name, { rows: D.query(`SELECT COUNT(*) AS n FROM "${r.name}"`).rows[0].n, cols: D.query(`PRAGMA table_info("${r.name}")`).rows.map(c => c.name) });
  renderTables();
}
function parseCSV(text) {
  const rows = [], sep = text.indexOf("\t") >= 0 && text.indexOf(",") < 0 ? "\t" : ",";
  let row = [], cell = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === sep) { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += c;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim() !== ""));
}
const ident = s => { const t = String(s).trim().replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase(); return /^[a-z_]/.test(t) ? t : "c_" + t; };
const isNum = v => v !== "" && v != null && !isNaN(v) && !isNaN(parseFloat(v));
async function addTable(name, text) {
  const grid = parseCSV(text);
  if (grid.length < 2) throw new Error(`${name}: needs a header row and at least one data row`);
  const cols = grid[0].map(ident), body = grid.slice(1);
  const numeric = cols.map((_, i) => body.every(r => r[i] === "" || r[i] == null || isNum(r[i])));
  const d = await ensureDb(), t = ident(name.replace(/\.(csv|tsv|txt)$/i, ""));
  d.run(`DROP TABLE IF EXISTS "${t}"`);
  d.run(`CREATE TABLE "${t}" (${cols.map((c, i) => `"${c}" ${numeric[i] ? "REAL" : "TEXT"}`).join(", ")})`);
  const st = d.prepare(`INSERT INTO "${t}" VALUES (${cols.map(() => "?").join(",")})`);
  for (const r of body) st.run(cols.map((_, i) => r[i] == null || r[i] === "" ? null : numeric[i] ? +r[i] : r[i]));
  st.free();
  refreshTables(); changed();
}
function renderTables() {
  const box = $("tables"); box.replaceChildren();
  if (!tables.size) { box.innerHTML = `<p class="hint">No tables yet. A site without data works fine; charts need tables.</p>`; return; }
  for (const [name, t] of tables) {
    const card = document.createElement("div"); card.className = "tbl-card";
    card.innerHTML = `<div class="row"><span><b>${esc(name)}</b> · ${t.rows} rows</span><button class="btn small" type="button">remove</button></div><div class="cols">${t.cols.map(esc).join(", ")}</div>`;
    card.querySelector("button").onclick = () => { db.run(`DROP TABLE IF EXISTS "${name}"`); refreshTables(); changed(); };
    box.appendChild(card);
  }
}
$("csv").onchange = e => { for (const f of e.target.files) f.text().then(t => addTable(f.name, t)).catch(err => { $state.textContent = err.message; }); e.target.value = ""; };
dropZone($("drop"), files => { for (const f of files) f.text().then(t => addTable(f.name, t)).catch(err => { $state.textContent = err.message; }); });
function dropZone(el, fn) {
  el.ondragover = e => { e.preventDefault(); el.classList.add("over"); };
  el.ondragleave = () => el.classList.remove("over");
  el.ondrop = e => { e.preventDefault(); el.classList.remove("over"); fn([...e.dataTransfer.files]); };
}
$("runSql").onclick = () => {
  const out = $("sqlOut"), msg = $("sqlMsg");
  try {
    const res = D.query($("sql").value);
    out.hidden = false; out.innerHTML = `<table><thead><tr>${res.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${res.rows.slice(0, 200).map(r => `<tr>${res.columns.map(c => `<td class="${typeof r[c] === "number" ? "num" : ""}">${esc(r[c] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    msg.textContent = `${res.rows.length} row${res.rows.length === 1 ? "" : "s"}${res.rows.length > 200 ? " (showing 200)" : ""}`;
  } catch (e) { out.hidden = true; msg.textContent = e.message; }
};

/* ---------- images (assets table) ---------- */
function assetList() { try { return D.query("SELECT name, type, length(data) AS size FROM assets ORDER BY name").rows; } catch (e) { return []; } }
async function ensureAssets() { const d = await ensureDb(); d.run("CREATE TABLE IF NOT EXISTS assets(name TEXT PRIMARY KEY, type TEXT, data BLOB)"); return d; }
function cleanSvgText(text) {
  const svg = D.cleanSVG(text);                                              // scripts, handlers, external refs gone
  for (const n of svg.querySelectorAll("metadata, title, desc, defs:empty")) n.remove();
  const out = new XMLSerializer().serializeToString(svg).replace(/<!--[\s\S]*?-->/g, "").replace(/(\d+\.\d{2})\d+/g, "$1").replace(/\s+/g, " ");
  return out;
}
async function addAsset(file) {
  const d = await ensureAssets(), name = ident(file.name.replace(/\.[^.]+$/, ""));
  let type = file.type, bytes;
  if (/svg/.test(type) || /\.svg$/i.test(file.name)) { type = "image/svg+xml"; bytes = new TextEncoder().encode(cleanSvgText(await file.text())); }
  else {
    const maxw = +$("maxw").value || 800, q = +$("quality").value || .8, bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxw / bmp.width), c = document.createElement("canvas"); c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    const blob = await new Promise(r => c.toBlob(r, "image/webp", q));
    if (blob && blob.type === "image/webp") { type = "image/webp"; bytes = new Uint8Array(await blob.arrayBuffer()); }
    else { bytes = new Uint8Array(await file.arrayBuffer()); }                // browser can't encode WebP: keep the original
  }
  d.run("INSERT OR REPLACE INTO assets VALUES (?,?,?)", [name, type, bytes]);
  renderAssets(); changed();
  return name;
}
const recordsFor = bytes => Math.ceil(bytes * 1.37 * 0.9 / 1000);            // rough: base64 growth, modest gzip gain on images
function renderAssets() {
  const box = $("assets"); box.replaceChildren();
  const rows = assetList();
  if (!rows.length) { box.innerHTML = `<p class="hint">No images yet.</p>`; return; }
  for (const a of rows) {
    const el = document.createElement("div"); el.className = "asset";
    const r = D.query(`SELECT type, data FROM assets WHERE name='${a.name.replace(/'/g, "''")}'`).rows[0];
    const thumb = /svg/.test(r.type) ? cleanSvgText(typeof r.data === "string" ? r.data : new TextDecoder().decode(r.data)) : `<img src="${URL.createObjectURL(new Blob([r.data], { type: r.type }))}" alt="">`;
    el.innerHTML = `<div class="thumb">${thumb}</div><div><b>${esc(a.name)}</b><div class="meta">${esc(a.type.replace("image/", ""))} · ${(a.size / 1024).toFixed(1)} KB · about ${recordsFor(a.size)} record${recordsFor(a.size) === 1 ? "" : "s"}</div></div><div class="toolbar"><button class="btn small" type="button" data-use>Use</button><button class="btn small" type="button" data-del>Delete</button></div>`;
    el.querySelector("[data-use]").onclick = () => { addBlock({ kind: "image", type: a.name, opts: { alt: "", width: "", align: "center" } }); showTab("blocks"); };
    el.querySelector("[data-del]").onclick = () => { db.run("DELETE FROM assets WHERE name=?", [a.name]); renderAssets(); changed(); };
    box.appendChild(el);
  }
}
$("afile").onchange = e => { for (const f of e.target.files) addAsset(f).catch(err => { $state.textContent = err.message; }); e.target.value = ""; };
dropZone($("adrop"), files => { for (const f of files) addAsset(f).catch(err => { $state.textContent = err.message; }); });

/* ---------- site settings ---------- */
const SETTINGS = [["site", "Title", "text"], ["tagline", "Tagline", "text"], ["by", "By", "text"], ["date", "Date line", "text"], ["theme", "Theme", "select", ["paper", "ink", "slate", "journal", "newsroom", "fieldnotes"]], ["accent", "Accent", "color"], ["source", "Source line (footer)", "text"]];
function renderSettings() {
  const body = $("settingsBody"); body.replaceChildren();
  for (const [key, label, kind, opts] of SETTINGS) {
    const f = document.createElement("div"); f.className = "field";
    const v = site.props[key] ?? "";
    f.innerHTML = `<label>${label}</label>` + (kind === "select" ? `<select class="field-in">${opts.map(o => `<option ${o === v ? "selected" : ""}>${o}</option>`).join("")}</select>` : kind === "color" ? `<div class="toolbar"><input type="color" value="${/^#[0-9a-f]{6}$/i.test(v) ? v : "#1d5fc2"}"><input type="text" value="${esc(v)}" placeholder="#1d5fc2"></div>` : `<input type="text" value="${esc(v)}">`);
    const ins = f.querySelectorAll("input,select");
    for (const i of ins) i.oninput = () => { const val = i.type === "color" ? i.value : i.value; site.props[key] = val; if (kind === "color") for (const j of ins) if (j !== i && j.type !== i.type) j.value = val; changed(false); };
    body.appendChild(f);
  }
}

/* ---------- block list ---------- */
const KIND_LABEL = { heading: "Heading", text: "Text", post: "Post", posts: "Post index", chart: "Chart", number: "Number", image: "Image", embed: "Embed", quote: "Quote", math: "Equation", abstract: "Abstract", authors: "Authors", ref: "Reference", references: "Reference list", footnotes: "Footnotes", divider: "Divider" };
function summary(b) {
  if (b.kind === "heading") return "#".repeat(b.level) + " " + b.text;
  if (b.kind === "text") return b.text;
  if (b.kind === "divider") return "———";
  if (b.kind === "posts") return "list of posts, newest first";
  if (b.kind === "chart") return `${b.type}${b.opts.title ? " · " + b.opts.title : ""}`;
  if (b.kind === "number") return b.opts.title || b.opts.query || "big number";
  if (b.kind === "post") return `${b.type}${b.opts.date ? " · " + b.opts.date : ""}`;
  if (b.kind === "ref") return `[@${b.type}] ${b.opts.text || ""}`;
  if (b.kind === "references") return "numbered list of the ref blocks, in order of citation";
  if (b.kind === "footnotes") return "the [^footnotes] from the text";
  return b.type || "";
}
function renderList() {
  const box = $("blocks"); box.replaceChildren();
  site.blocks.forEach((b, i) => {
    const el = document.createElement("div"); el.className = "blk" + (i === sel ? " sel" : ""); el.draggable = true; el.dataset.i = i;
    el.innerHTML = `<span class="kind ${b.kind}">${KIND_LABEL[b.kind] || b.kind}</span><span class="what">${esc(summary(b))}</span><span class="acts"><button type="button" title="Move up" data-a="up">↑</button><button type="button" title="Move down" data-a="down">↓</button><button type="button" title="Duplicate" data-a="dup">⧉</button><button type="button" title="Delete" data-a="del">✕</button></span>`;
    el.onclick = e => { const a = e.target.closest("[data-a]")?.dataset.a; if (a) return act(a, i); select(i); };
    el.ondragstart = e => { e.dataTransfer.setData("text/plain", i); el.classList.add("drag"); };
    el.ondragend = () => el.classList.remove("drag");
    el.ondragover = e => e.preventDefault();
    el.ondrop = e => { e.preventDefault(); const from = +e.dataTransfer.getData("text/plain"); if (isNaN(from) || from === i) return; const [m] = site.blocks.splice(from, 1); site.blocks.splice(i, 0, m); sel = i; changed(); };
    box.appendChild(el);
  });
  if (!site.blocks.length) box.innerHTML = `<p class="hint">No blocks yet. Add one below.</p>`;
}
function act(a, i) {
  const bs = site.blocks;
  if (a === "del") { bs.splice(i, 1); sel = Math.min(sel, bs.length - 1); if (sel === i) sel = -1; }
  if (a === "dup") { bs.splice(i + 1, 0, JSON.parse(JSON.stringify(bs[i]))); sel = i + 1; }
  if (a === "up" && i > 0) { [bs[i - 1], bs[i]] = [bs[i], bs[i - 1]]; sel = i - 1; }
  if (a === "down" && i < bs.length - 1) { [bs[i + 1], bs[i]] = [bs[i], bs[i + 1]]; sel = i + 1; }
  changed(); renderForm();
}
function select(i) { sel = i; renderList(); renderForm(); const n = $preview.querySelector(`[data-block="${i}"]`); for (const h of $preview.querySelectorAll(".hl")) h.classList.remove("hl"); if (n) { n.classList.add("hl"); n.scrollIntoView({ behavior: "smooth", block: "center" }); } }
const NEW = {
  heading: () => ({ kind: "heading", level: 1, text: "New section" }),
  text: () => ({ kind: "text", text: "A paragraph. **bold**, *italic*, [a link](https://example.com)." }),
  post: () => ({ kind: "post", type: "New post", opts: { date: new Date().toISOString().slice(0, 10) } }),
  posts: () => ({ kind: "posts" }),
  chart: () => ({ kind: "chart", type: "bars", opts: { title: "", format: "," } }),
  number: () => ({ kind: "number", type: "", opts: { format: "," } }),
  image: () => ({ kind: "image", type: "", opts: { alt: "", align: "center" } }),
  embed: () => ({ kind: "embed", type: "", opts: {} }),
  quote: () => ({ kind: "quote", type: "Something worth repeating.", opts: { by: "" } }),
  math: () => ({ kind: "math", type: "E = mc^2", opts: { label: "" } }),
  abstract: () => ({ kind: "abstract", type: "One paragraph on what was done, what was found, and why it matters.", opts: { keywords: "" } }),
  authors: () => ({ kind: "authors", type: "A. Author (University of Somewhere); B. Author (Institute of Things)", opts: { doi: "", contact: "" } }),
  ref: () => ({ kind: "ref", type: "key" + (site.blocks.filter(b => b.kind === "ref").length + 1), opts: { text: "Author, A. (2026). Title. Journal, 1(2), 3–4.", url: "", doi: "" } }),
  references: () => ({ kind: "references" }),
  footnotes: () => ({ kind: "footnotes" }),
  divider: () => ({ kind: "divider" }),
};
for (const k of Object.keys(NEW)) { const b = document.createElement("button"); b.className = "btn small"; b.type = "button"; b.textContent = KIND_LABEL[k]; b.onclick = () => addBlock(NEW[k]()); $("addrow").appendChild(b); }
function addBlock(b) { const at = sel >= 0 ? sel + 1 : site.blocks.length; site.blocks.splice(at, 0, b); sel = at; changed(); renderForm(); }

/* ---------- block forms ---------- */
const CHART_COLS = {
  bars: [["label", "Label"], ["value", "Value"], ["err", "± error (optional)"], ["lo", "Low (optional)"], ["hi", "High (optional)"]], hbars: [["label", "Label"], ["value", "Value"]], waffle: [["label", "Label"], ["value", "Value"]], bignumber: [["label", "Label"], ["value", "Value"]],
  line: [["x", "X (time)"], ["y", "Y"], ["series", "Series (optional)"], ["err", "± error (optional)"], ["lo", "Low (optional)"], ["hi", "High (optional)"]], area: [["x", "X (time)"], ["y", "Y"], ["series", "Series (optional)"]],
  scatter: [["x", "X"], ["y", "Y"], ["label", "Label (optional)"], ["err", "± error (optional)"]], slope: [["x", "X (two values)"], ["y", "Y"], ["series", "Series"]],
  histogram: [["value", "Value"]], boxplot: [["label", "Group"], ["value", "Value"]], heatmap: [["x", "Column"], ["y", "Row"], ["value", "Value"]],
  timeline: [["x", "When"], ["label", "What"], ["note", "Note (optional)"]], table: [],
  choropleth: [["iso2", "Country code (ISO2)"], ["value", "Value"]], flowmap: [["iso2", "Country code (ISO2)"], ["value", "Value"], ["dest", "Name (optional)"]],
};
const EXTRA = { flowmap: [["from", "From (ISO2)", "GR"], ["focus", "Focus (europe, americas, or ISO2 list)", ""], ["labels", "Labels", "8"], ["top", "Top N", "30"]], choropleth: [["scale", "Scale (log or linear)", "log"]],
  histogram: [["bins", "Bins", "20"]], scatter: [["fit", "Fit line (linear or none)", ""]], line: [["annotate", "Annotations (x=2010 | Label; x=2015 | Label)", ""], ["ymin", "Y axis starts at (number, or data)", "0"]], area: [["annotate", "Annotations (x=2010 | Label; …)", ""], ["ymin", "Y axis starts at (number, or data)", "0"]] };
const LOG_OK = ["bars", "line", "area", "scatter", "boxplot"];
const parsePick = s => Object.fromEntries(String(s || "").split(";").map(x => x.trim()).filter(Boolean).map(x => { const i = x.indexOf("="); return [x.slice(0, i).trim(), x.slice(i + 1).trim()]; }));
const joinPick = o => Object.entries(o).filter(([, v]) => v !== "" && v != null).map(([k, v]) => `${k}=${v}`).join("; ");
function sqlFromPick(p, type) {
  if (!p.table) return "";
  const q = c => `"${String(c).replace(/"/g, '""')}"`, cols = CHART_COLS[type] || [];
  const sel = type === "table" ? ["*"] : cols.filter(([k]) => p[k]).map(([k]) => p[k] === k ? q(k) : `${q(p[k])} AS ${k}`);
  if (!sel.length) return "";
  let sql = `SELECT ${sel.join(", ")} FROM ${q(p.table)}`;
  if (p.wcol && p.wval !== undefined && p.wval !== "") { const op = ["=", "!=", ">", "<", ">=", "<="].includes(p.wop) ? p.wop : "="; const v = isNum(p.wval) ? p.wval : `'${String(p.wval).replace(/'/g, "''")}'`; sql += ` WHERE ${q(p.wcol)} ${op} ${v}`; }
  if (p.slider) sql += (sql.includes(" WHERE ") ? " AND " : " WHERE ") + `${q(p.slider)} = {${p.slider}}`;
  if (p.order) sql += ` ORDER BY ${/^\d+$/.test(p.order) ? p.order : q(p.order)} ${p.dir === "asc" ? "ASC" : "DESC"}`;
  if (p.limit) sql += ` LIMIT ${parseInt(p.limit, 10) || 20}`;
  return sql;
}
function field(label, inner) { return `<div class="field"><label>${label}</label>${inner}</div>`; }
const inp = (name, v, ph = "", type = "text") => `<input type="${type}" data-f="${name}" value="${esc(v ?? "")}" placeholder="${esc(ph)}">`;
const selIn = (name, v, opts) => `<select class="field-in" data-f="${name}">${opts.map(o => Array.isArray(o) ? `<option value="${esc(o[0])}" ${o[0] === v ? "selected" : ""}>${esc(o[1])}</option>` : `<option ${o === v ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;

function renderForm() {
  const f = $("form"), b = site.blocks[sel];
  if (!b) { f.hidden = true; return; }
  f.hidden = false; const o = b.opts || (b.opts = {});
  let h = `<h3>${KIND_LABEL[b.kind]}</h3>`;
  if (b.kind === "heading") h += `<div class="grid2">${field("Level", selIn("level", String(b.level), [["1", "Section (big)"], ["2", "Subheading"], ["3", "Small heading"]]))}${field("Text", inp("text", b.text))}</div>`;
  else if (b.kind === "text") h += field("Paragraph (markdown-lite: **bold**, *italic*, `code`, [link](https://…))", `<textarea data-f="text" rows="4">${esc(b.text)}</textarea>`);
  else if (b.kind === "post") h += `<div class="grid2">${field("Title", inp("type", b.type))}${field("Date", inp("date", o.date, "", "date"))}</div><p class="hint">Everything after this block, up to the next post, belongs to it. The index lists posts newest first.</p>`;
  else if (b.kind === "posts") h += `<p class="hint">Lists every post with its date and first line. Without this block, an index is placed before the first post automatically.</p>`;
  else if (b.kind === "quote") h += field("Quote", `<textarea data-f="type" rows="2">${esc(b.type)}</textarea>`) + field("Attribution", inp("by", o.by));
  else if (b.kind === "math") h += field("LaTeX", `<textarea data-f="type" rows="2">${esc(b.type)}</textarea>`) + field("Equation number (optional)", inp("label", o.label, "1")) + `<p class="hint">Inline math goes in any text as <code>$…$</code>. Rendered with Temml to MathML, which every current browser displays natively.</p>`;
  else if (b.kind === "abstract") h += field("Abstract", `<textarea data-f="type" rows="5">${esc(b.type)}</textarea>`) + field("Keywords", inp("keywords", o.keywords));
  else if (b.kind === "authors") h += field("Authors, separated by ; with the affiliation in parentheses", `<textarea data-f="type" rows="3">${esc(b.type)}</textarea>`) + `<div class="grid2">${field("DOI", inp("doi", o.doi, "10.1000/xyz123"))}${field("Contact line", inp("contact", o.contact, "Correspondence: a.author@…"))}</div>`;
  else if (b.kind === "ref") h += `<div class="grid2">${field("Key (cite it in text as [@key])", inp("type", b.type))}${field("DOI (optional)", inp("doi", o.doi))}</div>` + field("Reference text", `<textarea data-f="text" rows="2">${esc(o.text)}</textarea>`) + field("URL (optional)", inp("url", o.url, "", "url"));
  else if (b.kind === "references") h += `<p class="hint">Numbered in order of first citation; uncited references come last. Add <b>Reference</b> blocks anywhere; they only show here.</p>`;
  else if (b.kind === "footnotes") h += `<p class="hint">Write footnotes inline as <code>[^the note text]</code>; they are numbered and listed here. Without this block they appear before the footer.</p>`;
  else if (b.kind === "embed") h += field("Link (YouTube, Vimeo, Apple Music, Spotify, SoundCloud, Bandcamp, CodePen)", inp("type", b.type, "https://www.youtube.com/watch?v=…", "url")) + `<p class="hint">Bandcamp: on the album, click Share / Embed and paste the <code>bandcamp.com/EmbeddedPlayer/…</code> address from the embed code.</p>` + `<div class="grid2">${field("Caption", inp("caption", o.caption))}${field("Shape", selIn("ratio", o.ratio || "wide", [["wide", "Automatic"], ["square", "Square"], ["tall", "Vertical"], ["music", "Music player (tall)"], ["track", "Music player (one track)"]]))}</div>` + (b.type && !D.embedFor(b.type) ? `<p class="msg bad">That link isn't from a supported site.</p>` : "");
  else if (b.kind === "image") {
    const names = assetList().map(a => a.name);
    const isUrl = /^https?:\/\//.test(b.type || ""), src = isUrl ? "url" : (b.type || (names[0] ?? "url"));
    h += field("Source", selIn("_src", src, [...names.map(n => [n, "stored image: " + n]), ["url", "an https:// URL (not stored in DNS)"]]));
    if (src === "url" || isUrl) h += field("URL", inp("type", isUrl ? b.type : "", "https://…", "url")) + `<div class="toolbar">${field("SHA-256 (optional: the site refuses a swapped image)", inp("sha256", o.sha256, ""))}<button class="btn small" type="button" data-hash>Compute</button></div><p class="hint">Readers' browsers fetch this from that host, which can see their visit.</p>`;
    h += field("Alt text (what the image shows)", inp("alt", o.alt)) + field("Caption", inp("caption", o.caption)) + `<div class="grid2">${field("Width (e.g. 320px or 60%)", inp("width", o.width))}${field("Placement", selIn("align", o.align || "center", [["center", "Centred"], ["full", "Full width"], ["left", "Float left"], ["right", "Float right"]]))}</div>`;
    h += `<div class="grid2">${field("Credit (photographer, source)", inp("credit", o.credit))}${field("Figure label (numbered; cite as [@label])", inp("figure", o.figure))}</div>`;
  }
  else if (b.kind === "chart" || b.kind === "number") {
    const type = b.kind === "number" ? "bignumber" : b.type, pick = parsePick(o.pick), simple = o.mode !== "sql" && (!o.query || o.pick), tnames = [...tables.keys()];
    if (b.kind === "chart") h += field("Type", selIn("type", b.type, D.chartTypes().filter(t => t !== "bignumber")));
    h += `<div class="grid2">${field("Title", inp("title", o.title))}${field("Number format", selIn("format", o.format || ",", [[",", "1,234"], ["k", "1.2K"], ["%", "12.3%"], ["0.0", "1234.5"], ["0.00", "1234.56"]]))}</div>`;
    h += `<div class="toolbar"><span class="seg"><button type="button" data-mode="simple" aria-pressed="${simple}">Pick columns</button><button type="button" data-mode="sql" aria-pressed="${!simple}">Write SQL</button></span></div>`;
    if (simple) {
      if (!tnames.length) h += `<p class="hint">Add a table on the Data tab first.</p>`;
      else {
        const cols = tables.get(pick.table || tnames[0])?.cols || [];
        h += field("Table", selIn("p.table", pick.table || tnames[0], tnames));
        h += `<div class="grid2">` + (CHART_COLS[type] || []).map(([k, lbl]) => field(lbl, selIn("p." + k, pick[k] || "", [["", "—"], ...cols.map(c => [c, c])]))).join("") + `</div>`;
        h += `<div class="grid3">${field("Only rows where", selIn("p.wcol", pick.wcol || "", [["", "—"], ...cols.map(c => [c, c])]))}${field("is", selIn("p.wop", pick.wop || "=", ["=", "!=", ">", "<", ">=", "<="]))}${field("value", inp("p.wval", pick.wval))}</div>`;
        h += `<div class="grid3">${field("Sort by", selIn("p.order", pick.order || "", [["", "—"], ...cols.map(c => [c, c])]))}${field("Direction", selIn("p.dir", pick.dir || "desc", [["desc", "Largest first"], ["asc", "Smallest first"]]))}${field("Limit", inp("p.limit", pick.limit, "", "number"))}</div>`;
        h += field("Year slider on column (optional)", selIn("p.slider", pick.slider || "", [["", "—"], ...cols.map(c => [c, c])]));
        h += `<p class="hint">SQL: <code>${esc(sqlFromPick({ table: tnames[0], ...pick }, type) || "—")}</code></p>`;
      }
    } else h += field("Query", `<textarea data-f="query" rows="3">${esc(o.query)}</textarea>`) + field("Slider column (optional; use {column} in the query)", inp("slider", o.slider));
    for (const [k, lbl, dflt] of EXTRA[type] || []) h += field(lbl, inp(k, o[k], dflt));
    h += `<div class="grid2">${field("Figure label (numbered; cite it as [@label])", inp("figure", o.figure, "fig1"))}${LOG_OK.includes(type) ? field("Y axis", selIn("yscale", o.yscale || "linear", [["linear", "Linear"], ["log", "Logarithmic"]])) : ""}</div>`;
    h += field("Note under the chart", inp("note", o.note));
  }
  f.innerHTML = h;
  f.querySelectorAll("[data-f]").forEach(el => el.oninput = () => onField(b, el.dataset.f, el.value));
  f.querySelectorAll("[data-mode]").forEach(el => el.onclick = () => { if (el.dataset.mode === "sql") { if (o.pick) { o.query = sqlFromPick({ table: [...tables.keys()][0], ...parsePick(o.pick) }, b.kind === "number" ? "bignumber" : b.type); } o.mode = "sql"; delete o.pick; } else { o.mode = ""; delete o.mode; o.pick = o.pick || ""; o.query = ""; } changed(); renderForm(); });
  f.querySelector("[data-hash]")?.addEventListener("click", async e => { e.target.textContent = "…"; try { const buf = await (await fetch(b.type, { mode: "cors" })).arrayBuffer(); o.sha256 = await D.sha256hex(buf); changed(); renderForm(); } catch (err) { e.target.textContent = "that host doesn't allow it"; } });
}
function onField(b, name, value) {
  const o = b.opts || (b.opts = {});
  if (name === "level") b.level = +value;
  else if (name === "text" && b.kind === "ref") o.text = value;
  else if (name === "text" && b.kind !== "quote") b.text = value;
  else if (name === "type") { b.type = value; if (b.kind === "chart") { delete o.mode; renderForm(); } }
  else if (name === "_src") { if (value === "url") { b.type = ""; } else b.type = value; renderForm(); }
  else if (name.startsWith("p.")) {
    const pick = parsePick(o.pick); pick[name.slice(2)] = value; if (name === "p.table") { for (const k of Object.keys(pick)) if (k !== "table") delete pick[k]; }
    o.pick = joinPick(pick); const type = b.kind === "number" ? "bignumber" : b.type;
    o.query = sqlFromPick(pick, type); o.slider = pick.slider || ""; if (!o.slider) delete o.slider;
    if (name === "p.table" || name === "p.slider") renderForm(); else { const c = $("form").querySelector(".hint code"); if (c) c.textContent = o.query || "—"; }
  }
  else o[name] = value;
  changed(false); const el = $("blocks").children[sel]; if (el) el.querySelector(".what").textContent = summary(b);
}

/* ---------- live preview ---------- */
let mapReady = false;
async function render() {
  if (!mapReady && site.blocks.some(b => b.kind === "chart" && /^(choropleth|flowmap)$/.test(b.type))) { await D.ensureMap(); mapReady = true; }
  let stats = { records: 0, bytes: 0, chars: 0 };
  try { const b = await buildRecords(); stats = { records: b.recs.length, bytes: b.siteBytes + b.dbBytes, chars: b.chars }; } catch (e) {}
  try { D.render(site, null, stats, $preview, $host.value.trim() || "example.com"); }
  catch (e) { $preview.innerHTML = `<p class="status err">${esc(e.message)}</p>`; }
  for (const n of $preview.querySelectorAll(".reveal")) n.classList.add("in");
  if (sel >= 0) $preview.querySelector(`[data-block="${sel}"]`)?.classList.add("hl");
  $state.textContent = `${stats.records} records`;
}

/* ---------- publish: the same encoding as publish.py, in the browser ---------- */
async function gzipB64(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return b64(new Uint8Array(await new Response(stream).arrayBuffer()));
}
const chunks = (s, n) => { const a = []; for (let i = 0; i < s.length; i += n) a.push(s.slice(i, i + n)); return a; };
const strings = (s, w = 255) => chunks(s, w);
const quote = ss => ss.map(x => '"' + x.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(" ");
async function buildRecords() {
  const host = ($host.value.trim().toLowerCase().replace(/\.$/, "") || "example.com"), n = +$("chunk").value || 1000;
  const siteBytes = new TextEncoder().encode(D.serializeSite(site));
  const hasData = db && (tables.size || assetList().length);
  const dbBytes = hasData ? db.export() : null;
  const s = chunks(await gzipB64(siteBytes), n), d = dbBytes ? chunks(await gzipB64(dbBytes), n) : [];
  const sha = (await D.sha256hex(siteBytes)).slice(0, 8);
  const recs = [{ name: `_dnsite.${host}`, strings: [`v=1 site=${s.length} db=${d.length} map=0 sha=${sha}`] }];
  s.forEach((c, i) => recs.push({ name: `s${i}.${host}`, strings: strings(c) }));
  d.forEach((c, i) => recs.push({ name: `d${i}.${host}`, strings: strings(c) }));
  return { host, recs, siteBytes: siteBytes.length, dbBytes: dbBytes ? dbBytes.length : 0, chars: recs.reduce((t, r) => t + r.strings.join("").length, 0) };
}
const zoneText = ({ host, recs }) => `; dnsite v1 records for ${host} -- made at dnsite.org/make\n; point ${host} at a loader with a CNAME (or an A record for a bare domain); not included here\n` + recs.map(r => `${r.name}.\t300\tIN\tTXT\t${quote(r.strings)}`).join("\n") + "\n";
let built = null;
async function updatePublish() {
  built = await buildRecords();
  const cap = +$("cap").value || 1000, pct = Math.min(100, 100 * built.recs.length / cap);
  $("pubStat").innerHTML = `<div><b>${built.recs.length}</b><span>TXT records</span></div><div><b>${(built.chars / 1024).toFixed(1)} KB</b><span>of record text</span></div><div><b>${(built.siteBytes / 1024).toFixed(1)} KB</b><span>site document</span></div><div><b>${built.dbBytes ? (built.dbBytes / 1024).toFixed(0) + " KB" : "none"}</b><span>database</span></div>`;
  $("meter").className = "meter" + (pct > 80 ? " warn" : ""); $("meter").firstElementChild.style.width = pct + "%";
  $("records").textContent = zoneText(built);
  show(built.recs.length > cap ? `This site needs ${built.recs.length} records; your host allows ${cap}. Trim images or data, or use 2,000-character records.` : "", "bad");
}
function show(text, cls) { const m = $("pubMsg"); m.hidden = !text; m.textContent = text; m.className = "msg " + (cls || ""); }
$host.addEventListener("input", () => { save(); updatePublish(); render(); });
$("chunk").onchange = $("cap").oninput = updatePublish;
$("zoneBtn").onclick = async () => { await updatePublish(); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([zoneText(built)], { type: "text/plain" })); a.download = `${built.host}.zone`; a.click(); URL.revokeObjectURL(a.href); };
$("copyBtn").onclick = async () => { await updatePublish(); try { await navigator.clipboard.writeText(zoneText(built)); show("Copied.", "ok"); } catch (e) { show("Couldn't copy; select the text below instead.", "bad"); } };
$("checkBtn").onclick = async () => {
  await updatePublish(); show("Asking public DNS…");
  // presence per record, version by the manifest's sha (two gzip implementations pack the same site differently)
  const live = await Promise.all(built.recs.map(async r => { try { return await D.resolveTXT(r.name); } catch (e) { return null; } }));
  const ok = live.filter(Boolean).length, sha = s => (String(s || "").match(/sha=(\w+)/) || [])[1];
  let published = 0; try { const m = D.parseManifest(live[0] || ""); published = 1 + m.site + m.db + m.map; } catch (e) {}
  if (!ok) show("Nothing found yet. Either the records aren't published, or the resolver hasn't seen them (a few minutes after publishing is normal).", "bad");
  else if (live[0] && sha(live[0]) !== sha(built.recs[0].strings[0])) show(`Records found, but DNS holds a different version of the site text (manifest: ${live[0]}). Publish again to update it.`, "bad");
  else if (published && ok >= published) show(`All ${published} published records found, and the site text matches this editor. The site is live once the domain points at a loader.`, "ok");
  else show(`${ok} of ${published || live.length} records found; the rest may still be propagating.`, "bad");
};

/* ---------- publish to Cloudflare, from this browser, through the same-origin pass-through ---------- */
const CF = "/api/cf/";
async function cfCall(token, method, path, body) {
  const r = await fetch(CF + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch (e) {}
  if (!j || !j.success) throw new Error((j && j.errors && j.errors.map(e => e.message).join("; ")) || `Cloudflare answered ${r.status}`);
  return j;
}
const cfContent = ss => ss.map(x => '"' + x.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(" ");
async function publishToCloudflare(token, log) {
  await updatePublish();
  const host = built.host, zoneName = host.split(".").slice(-2).join(".");
  log(`Looking up zone ${zoneName}…`);
  const zones = (await cfCall(token, "GET", `zones?name=${encodeURIComponent(zoneName)}`)).result;
  if (!zones.length) throw new Error(`zone ${zoneName} isn't in this Cloudflare account, or the token can't see it`);
  const zid = zones[0].id;
  const existing = new Map();
  for (let page = 1; ; page++) {
    const res = await cfCall(token, "GET", `zones/${zid}/dns_records?type=TXT&per_page=500&page=${page}`);
    for (const r of res.result) existing.set(r.name.toLowerCase(), r);
    if (!res.result_info || page >= res.result_info.total_pages) break;
  }
  let created = 0, updated = 0, same = 0, deleted = 0;
  for (const rec of built.recs) {
    const content = cfContent(rec.strings), cur = existing.get(rec.name);
    if (cur && cur.content === content) { same++; continue; }
    const body = { type: "TXT", name: rec.name, content, ttl: 300 };
    if (cur) { await cfCall(token, "PUT", `zones/${zid}/dns_records/${cur.id}`, body); updated++; log(`updated ${rec.name}`); }
    else { await cfCall(token, "POST", `zones/${zid}/dns_records`, body); created++; log(`created ${rec.name}`); }
  }
  const wanted = new Set(built.recs.map(r => r.name)), stale = new RegExp(`^(_dnsite|[sdm]\\d+)\\.${host.replace(/\./g, "\\.")}$`);
  for (const [name, cur] of existing) if (stale.test(name) && !wanted.has(name)) { await cfCall(token, "DELETE", `zones/${zid}/dns_records/${cur.id}`); deleted++; log(`removed ${name} (no longer used)`); }
  return `${created} created, ${updated} updated, ${same} unchanged, ${deleted} removed`;
}
$("cfBtn").onclick = () => { $("cfPanel").hidden = false; try { const t = localStorage.getItem("dnsite.make.cftoken"); if (t) { $("cfToken").value = t; $("cfRemember").checked = true; } } catch (e) {} $("cfToken").focus(); };
$("cfCancel").onclick = () => { $("cfPanel").hidden = true; };
$("cfGo").onclick = async () => {
  const token = $("cfToken").value.trim(), logEl = $("cfLog"); logEl.hidden = false; logEl.textContent = "";
  const log = m => { logEl.textContent += m + "\n"; logEl.scrollTop = logEl.scrollHeight; };
  if (!token) return show("Paste a token first.", "bad");
  try { if ($("cfRemember").checked) localStorage.setItem("dnsite.make.cftoken", token); else localStorage.removeItem("dnsite.make.cftoken"); } catch (e) {}
  $("cfGo").disabled = true; show("Publishing…");
  try { const summary = await publishToCloudflare(token, log); log(summary); show(`Published: ${summary}. Checking the domain…`); await new Promise(r => setTimeout(r, 1500)); $("checkBtn").click(); }
  catch (e) { log("error: " + e.message); show(e.message, "bad"); }
  finally { $("cfGo").disabled = false; }
};

/* ---------- open an existing DNSite ---------- */
$("loadBtn").onclick = async () => {
  const host = prompt("Domain of the DNSite to open:", $host.value || "dnsite.org"); if (!host) return;
  $state.textContent = "Reading from DNS…";
  try {
    const h = host.trim().toLowerCase(), man = D.parseManifest(await D.resolveTXT(`_dnsite.${h}`) || "");
    const [s, d] = await Promise.all([D.loadBlob("s", man.site, h), D.loadBlob("d", man.db, h)]);
    site = D.parseSite(new TextDecoder().decode(s)); $host.value = h; sel = -1;
    db = d ? await D.setDatabase(d) : (D.useDatabase(null), null);
    refreshTables(); renderSettings(); renderAssets(); renderForm(); changed();
  } catch (e) { $state.textContent = `Couldn't open ${host}: ${e.message}`; console.error(e); }
};
$("exampleBtn").onclick = () => { site = D.parseSite(EXAMPLE); sel = -1; renderSettings(); renderForm(); changed(); };

/* ---------- start ---------- */
(async () => {
  let draft = {}; try { draft = { src: localStorage.getItem("dnsite.make.src"), host: localStorage.getItem("dnsite.make.host"), db: localStorage.getItem("dnsite.make.db") }; } catch (e) {}
  site = D.parseSite(draft.src || EXAMPLE); if (draft.host) $host.value = draft.host;
  if (draft.db) { try { db = await D.setDatabase(unb64(draft.db)); } catch (e) { db = null; } }
  refreshTables(); renderSettings(); renderList(); renderForm(); await render();
})();
})();
