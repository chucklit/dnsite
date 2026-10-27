/* DNSite builder -- write, add data, preview live, and produce the DNS records. Uses window.DNSite from app.js. */
(() => {
"use strict";
const D = window.DNSite;
const $ = id => document.getElementById(id);
const $src = $("src"), $preview = $("preview"), $state = $("state"), $host = $("host");

/* ---------- tabs ---------- */
for (const b of document.querySelectorAll(".tabs [role=tab]")) b.onclick = () => {
  for (const x of document.querySelectorAll(".tabs [role=tab]")) x.setAttribute("aria-selected", x === b);
  for (const p of document.querySelectorAll(".pane")) p.classList.toggle("on", p.id === "pane-" + b.dataset.tab);
  if (b.dataset.tab === "publish") updatePublish();
};

/* ---------- draft persistence (per-browser convenience only) ---------- */
const save = () => { try { localStorage.setItem("dnsite.make.src", $src.value); localStorage.setItem("dnsite.make.host", $host.value); } catch (e) {} };
const load = () => { try { return { src: localStorage.getItem("dnsite.make.src"), host: localStorage.getItem("dnsite.make.host") }; } catch (e) { return {}; } };

/* ---------- in-browser database ---------- */
let db = null;                 // the sql.js Database the preview and charts use
const tables = new Map();      // name -> { rows, cols }
async function ensureDb() { if (!db) { db = await D.newDatabase(); D.useDatabase(db); } return db; }

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
  // integer-looking columns stay tidy in tables (no "1990.0")
  tables.set(t, { rows: body.length, cols });
  renderTables(); render();
}

function renderTables() {
  const box = $("tables"); box.replaceChildren();
  if (!tables.size) { box.innerHTML = `<p class="hint">No tables yet. A site without data works fine; charts need tables.</p>`; return; }
  for (const [name, t] of tables) {
    const card = document.createElement("div"); card.className = "tbl-card";
    card.innerHTML = `<div class="row"><span><b>${esc(name)}</b> · ${t.rows} rows</span><button class="btn small" type="button">remove</button></div><div class="cols">${t.cols.map(esc).join(", ")}</div>`;
    card.querySelector("button").onclick = () => { db.run(`DROP TABLE IF EXISTS "${name}"`); tables.delete(name); renderTables(); render(); };
    box.appendChild(card);
  }
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

$("csv").onchange = e => { for (const f of e.target.files) f.text().then(t => addTable(f.name, t)).catch(err => { $state.textContent = err.message; }); e.target.value = ""; };
const drop = $("drop");
drop.ondragover = e => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = e => { e.preventDefault(); drop.classList.remove("over"); for (const f of e.dataTransfer.files) f.text().then(t => addTable(f.name, t)).catch(err => { $state.textContent = err.message; }); };

$("runSql").onclick = () => {
  const out = $("sqlOut"), msg = $("sqlMsg");
  try {
    const res = D.query($("sql").value);
    out.hidden = false; out.innerHTML = `<table><thead><tr>${res.columns.map(c => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${res.rows.slice(0, 200).map(r => `<tr>${res.columns.map(c => `<td class="${typeof r[c] === "number" ? "num" : ""}">${esc(r[c] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    msg.textContent = `${res.rows.length} row${res.rows.length === 1 ? "" : "s"}${res.rows.length > 200 ? " (showing 200)" : ""}`;
  } catch (e) { out.hidden = true; msg.textContent = e.message; }
};

/* ---------- snippets ---------- */
const SNIPS = {
  heading: "\n# New section\ntext: Say something here.\n",
  text: "text: A paragraph. **bold**, *italic*, [a link](https://example.com).\n",
  number: "number:\n  query: SELECT COUNT(*) AS value, 'rows in my table' AS label FROM mytable\n  format: ,\n",
  divider: "divider:\n",
};
const CHART = {
  bars: "chart: bars\n  title: Values by label\n  query: SELECT name AS label, amount AS value FROM mytable ORDER BY 2 DESC LIMIT 10\n  format: ,\n",
  hbars: "chart: hbars\n  title: Values by label\n  query: SELECT name AS label, amount AS value FROM mytable ORDER BY 2 DESC LIMIT 15\n  format: ,\n",
  line: "chart: line\n  title: Over time\n  query: SELECT year AS x, amount AS y, name AS series FROM mytable\n  format: ,\n",
  area: "chart: area\n  title: Over time\n  query: SELECT year AS x, amount AS y FROM mytable\n  format: ,\n",
  scatter: "chart: scatter\n  title: One against another\n  query: SELECT a AS x, b AS y, name AS label FROM mytable\n",
  slope: "chart: slope\n  title: First year against last\n  query: SELECT year AS x, amount AS y, name AS series FROM mytable WHERE year IN (2010, 2020)\n  format: k\n",
  waffle: "chart: waffle\n  title: Share of the whole\n  query: SELECT name AS label, amount AS value FROM mytable\n  format: ,\n",
  timeline: "chart: timeline\n  title: What happened when\n  query: SELECT year AS x, event AS label, detail AS note FROM mytable ORDER BY 1\n",
  table: "chart: table\n  title: The data\n  query: SELECT * FROM mytable LIMIT 50\n",
  choropleth: "chart: choropleth\n  title: By country\n  query: SELECT iso2, amount AS value FROM mytable\n  format: ,\n",
  flowmap: "chart: flowmap\n  title: From one place to many\n  query: SELECT iso2, amount AS value FROM mytable\n  from: US\n  labels: 8\n  format: ,\n",
  bignumber: SNIPS.number,
};
for (const t of D.chartTypes()) if (t !== "bignumber") $("chartPick").insertAdjacentHTML("beforeend", `<option value="${t}">${t}</option>`);
function insert(text) {
  const s = $src.selectionStart, before = $src.value.slice(0, s), after = $src.value.slice($src.selectionEnd);
  const pad = before.length && !before.endsWith("\n") ? "\n" : "";
  $src.value = before + pad + text + after; $src.selectionStart = $src.selectionEnd = (before + pad + text).length;
  $src.focus(); onEdit();
}
$("snippets").onclick = e => { const b = e.target.closest("[data-snip]"); if (b) insert(SNIPS[b.dataset.snip]); };
$("chartPick").onchange = e => { if (e.target.value) insert(CHART[e.target.value]); e.target.value = ""; };

const EXAMPLE = `site: My first DNSite
tagline: A page that lives in DNS
theme: paper
accent: #1d5fc2

text: This page is stored in TXT records and rendered in your browser. Edit the text on the left and watch it change.

# A section
text: Add a CSV on the **Data** tab, then insert a chart from the toolbar and point its query at your table.

divider:
text: When it looks right, open **Publish** to get the records.
`;
$("exampleBtn").onclick = () => { $src.value = EXAMPLE; onEdit(); };

/* ---------- live preview ---------- */
let timer = null;
function onEdit() { save(); clearTimeout(timer); timer = setTimeout(render, 150); }
$src.addEventListener("input", onEdit);
let mapReady = false;
async function render() {
  const site = D.parseSite($src.value);
  if (!mapReady && site.blocks.some(b => b.kind === "chart" && /^(choropleth|flowmap)$/.test(b.type))) { await D.ensureMap(); mapReady = true; }
  let stats = { records: 0, bytes: 0, chars: 0 };
  try { const b = await buildRecords(); stats = { records: b.recs.length, bytes: b.siteBytes + b.dbBytes, chars: b.chars }; } catch (e) {}
  try { D.render(site, null, stats, $preview, $host.value.trim() || "example.com"); }
  catch (e) { $preview.innerHTML = `<p class="status err">${esc(e.message)}</p>`; }
  for (const n of $preview.querySelectorAll(".reveal")) n.classList.add("in");   // no scroll-in animation while editing
  $state.textContent = `${$src.value.length.toLocaleString()} characters`;
}

/* ---------- publish: the same encoding as publish.py, in the browser ---------- */
async function gzipB64(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  let s = ""; for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode.apply(null, out.subarray(i, i + 0x8000));
  return btoa(s);
}
const chunks = (b64, n = 1000) => { const a = []; for (let i = 0; i < b64.length; i += n) a.push(b64.slice(i, i + n)); return a; };
const strings = (s, w = 255) => { const a = []; for (let i = 0; i < s.length; i += w) a.push(s.slice(i, i + w)); return a; };
const quote = ss => ss.map(x => '"' + x.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"').join(" ");

async function buildRecords() {
  const host = ($host.value.trim().toLowerCase().replace(/\.$/, "") || "example.com");
  const siteBytes = new TextEncoder().encode($src.value);
  const dbBytes = db && tables.size ? db.export() : null;
  const s = chunks(await gzipB64(siteBytes)), d = dbBytes ? chunks(await gzipB64(dbBytes)) : [];
  const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", siteBytes))].slice(0, 4).map(b => b.toString(16).padStart(2, "0")).join("");
  const recs = [{ name: `_dnsite.${host}`, strings: [`v=1 site=${s.length} db=${d.length} map=0 sha=${sha}`] }];
  s.forEach((c, i) => recs.push({ name: `s${i}.${host}`, strings: strings(c) }));
  d.forEach((c, i) => recs.push({ name: `d${i}.${host}`, strings: strings(c) }));
  return { host, recs, siteBytes: siteBytes.length, dbBytes: dbBytes ? dbBytes.length : 0, chars: recs.reduce((n, r) => n + r.strings.join("").length, 0) };
}
const zoneText = ({ host, recs }) => `; dnsite v1 records for ${host} -- made at dnsite.org/make\n; point ${host} at a loader with a CNAME (or an A record for a bare domain); not included here\n` + recs.map(r => `${r.name}.\t300\tIN\tTXT\t${quote(r.strings)}`).join("\n") + "\n";

let built = null;
async function updatePublish() {
  built = await buildRecords();
  $("pubStat").innerHTML = `<div><b>${built.recs.length}</b><span>TXT records</span></div><div><b>${(built.chars / 1024).toFixed(1)} KB</b><span>of record text</span></div><div><b>${(built.siteBytes / 1024).toFixed(1)} KB</b><span>site document</span></div><div><b>${built.dbBytes ? (built.dbBytes / 1024).toFixed(0) + " KB" : "none"}</b><span>database</span></div>`;
  $("records").textContent = zoneText(built);
  const big = built.recs.filter(r => r.strings.join("").length > 2048).length;
  show(big ? `${big} record(s) are over 2 KB; some DNS hosts cap TXT records there. Trim the site or the data.` : "", big ? "bad" : "");
}
function show(text, cls) { const m = $("pubMsg"); m.hidden = !text; m.textContent = text; m.className = "msg " + (cls || ""); }
$host.addEventListener("input", () => { save(); updatePublish(); render(); });
$("zoneBtn").onclick = async () => { await updatePublish(); const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([zoneText(built)], { type: "text/plain" })); a.download = `${built.host}.zone`; a.click(); URL.revokeObjectURL(a.href); };
$("copyBtn").onclick = async () => { await updatePublish(); try { await navigator.clipboard.writeText(zoneText(built)); show("Copied.", "ok"); } catch (e) { show("Couldn't copy; select the text below instead.", "bad"); } };
$("checkBtn").onclick = async () => {
  await updatePublish(); show("Asking public DNS…");
  // records are compared by presence, and the version by the manifest's sha: two gzip implementations
  // pack the same site into different bytes, so byte-for-byte equality would be a false alarm
  const live = await Promise.all(built.recs.map(async r => { try { return await D.resolveTXT(r.name); } catch (e) { return null; } }));
  const ok = live.filter(Boolean).length, sha = s => (String(s || "").match(/sha=(\w+)/) || [])[1];
  let published = 0; try { const m = D.parseManifest(live[0] || ""); published = 1 + m.site + m.db + m.map; } catch (e) {}
  if (!ok) show("Nothing found yet. Either the records aren't published, or the resolver hasn't seen them (a few minutes after publishing is normal).", "bad");
  else if (live[0] && sha(live[0]) !== sha(built.recs[0].strings[0])) show(`Records found, but DNS holds a different version of the site text (manifest: ${live[0]}). Publish again to update it.`, "bad");
  else if (published && ok >= published) show(`All ${published} published records found, and the site text matches this editor. The site is live once the domain points at a loader.`, "ok");
  else show(`${ok} of ${published || live.length} records found; the rest may still be propagating.`, "bad");
};

/* ---------- open an existing DNSite into the editor ---------- */
$("loadBtn").onclick = async () => {
  const host = prompt("Domain of the DNSite to open:", $host.value || "dnsite.org"); if (!host) return;
  $state.textContent = "Reading from DNS…";
  try {
    const man = D.parseManifest(await D.resolveTXT(`_dnsite.${host.trim().toLowerCase()}`) || "");
    const [s, d] = await Promise.all([D.loadBlob("s", man.site, host), D.loadBlob("d", man.db, host)]);
    $src.value = new TextDecoder().decode(s); $host.value = host.trim().toLowerCase();
    tables.clear();
    if (d) { db = await D.setDatabase(d); for (const r of D.query("SELECT name FROM sqlite_master WHERE type='table'").rows) tables.set(r.name, { rows: D.query(`SELECT COUNT(*) AS n FROM "${r.name}"`).rows[0].n, cols: D.query(`PRAGMA table_info("${r.name}")`).rows.map(c => c.name) }); }
    else db = await D.setDatabase(null);
    renderTables(); save(); render();
  } catch (e) { $state.textContent = `Couldn't open ${host}: ${e.message}`; console.error(e); }
};

/* ---------- start ---------- */
(async () => {
  const draft = load();
  $src.value = draft.src || EXAMPLE; if (draft.host) $host.value = draft.host;
  renderTables(); await render();
})();
})();
