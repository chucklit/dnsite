# dnsite — a website that lives in its domain's DNS

Working name. The domain is the document: everything a site needs (its text, its
database, its map) is stored in TXT records. One static **loader** page, which any
domain can point at, reads those records back over DNS-over-HTTPS and renders the
site in the visitor's browser. No per-site server, no hosting, nothing to deploy.

## Record layout (format v1)

All names are relative to the site's hostname `H` (for example `greekexpats.com`).

| Record | Type | Content |
|---|---|---|
| `_dnsite.H` | TXT | manifest: `v=1 site=<n> db=<m> map=<k> sha=<hex8>` |
| `s0.H` … `s{n-1}.H` | TXT | site document, chunked |
| `d0.H` … `d{m-1}.H` | TXT | SQLite database file, chunked (m = 0 → no database) |
| `m0.H` … `m{k-1}.H` | TXT | custom SVG map, chunked (k = 0 → loader's built-in map) |
| `H` | A / CNAME | points at the loader |

**Encoding of every blob:** raw bytes → gzip (level 9) → base64 (standard alphabet,
with padding) → split into chunks of at most `CHUNK` characters (default 1000) →
one TXT record per chunk. Each record may hold several ≤255-character strings;
the reader concatenates all strings of a record in order, then concatenates the
records in index order. The browser decodes with `atob` + `DecompressionStream("gzip")`.

`sha` is the first 8 hex characters of SHA-256 over the concatenated decoded
site document; the loader uses it as a cache key and to detect a half-updated zone.

Manifest first, then chunks, so a reader always knows how many names to ask for
and can fetch them in parallel.

**Limits to design around:** many DNS hosts cap a TXT record near 2048–4096
characters and a zone at a few hundred to a few thousand records. A site of
~50 KB of records is comfortable; ~500 KB is the practical ceiling today.

## Site document (the site language)

Plain text, UTF-8, readable from `dig`. Line based.

```
site: Where the Greeks went
tagline: Seventy years of leaving home
theme: paper            # paper | ink | slate
accent: #1f6feb
source: UN DESA, International Migrant Stock 2024

# A heading starts a section
text: A paragraph. **bold**, *italic*, [a link](https://…).
text: Another paragraph.

chart: bars
  title: Where Greeks lived abroad in 2020
  query: SELECT dest AS label, people AS value FROM stock WHERE year=2020 ORDER BY 2 DESC LIMIT 12
  format: ,

chart: flowmap
  title: Greek-born population by country
  query: SELECT iso2, people AS value FROM stock WHERE year={year}
  from: GR
  slider: year            # column name; distinct values become the slider stops
```

Rules:
* `key: value` at column 0 is a top-level property until the first `#` heading.
* `# Heading` starts a section; `## Subheading` is a smaller heading inside it.
* `text:` is a paragraph (markdown-lite: `**`, `*`, links, `` `code` ``).
* `chart: <type>` opens a chart block; the indented `key: value` lines that follow
  belong to it. `query` is SQL run against the site database. `{slider-column}`
  in a query is substituted with the current slider value.
* `number:` big-number block, `image:` an SVG stored under `svg/<name>` in the
  database (table `svg(name, body)`), `divider:` a rule.
* Everything is rendered by the loader's built-in components; a site never
  ships its own JavaScript.

### Built-in chart types (v1)

`bars`, `hbars`, `line`, `area`, `scatter`, `bignumber`, `table`, `choropleth`,
`flowmap`, `slope`, `waffle`, `timeline`. Each takes `title`, `query`, `note`,
and type-specific options (`x`, `y`, `series`, `format`, `from`, `slider`, `color`).
Column conventions: `label`/`value` for one-dimensional charts, `x`/`y`(+`series`)
for time series, `iso2`/`value` for maps. Every chart gets a "Show table" toggle.

## Loader

* `loader/index.html` + `loader/app.js` + `loader/vendor/sql-wasm.{js,wasm}`.
* On load: `host = location.hostname` (overridable with `?host=` for development),
  resolve `_dnsite.host` via DNS-over-HTTPS (`https://cloudflare-dns.com/dns-query`
  with `accept: application/dns-json`; `?doh=` overrides the resolver for local
  testing), fetch all chunks in parallel, decode, open the database in SQLite
  (wasm), parse the site document, render.
* Site content is data. Markdown-lite is rendered through a whitelist, never
  `innerHTML` of raw site text. SVG maps are sanitised (scripts, handlers,
  foreignObject, external hrefs stripped).

## Publisher

`publish.py site.txt --db emigration.db [--map world.svg] --host H --out zone/`
writes `zone/H.zone` (BIND zone fragment), `zone/H.json` (the same records as
JSON, for registrar APIs and the mock resolver) and prints the record count and
byte totals.

## Local development

`dev/mock_doh.py` serves `/dns-query` in the Cloudflare JSON shape from the
published `zone/*.json` files, plus the loader as static files, so the whole
thing runs on localhost before any real DNS exists.

## Production (later)

Loader behind Caddy with on-demand TLS (`ask` endpoint checks the domain has a
valid `_dnsite` manifest before a certificate is issued), or Cloudflare for SaaS.
Open source the loader so anyone can run one.
