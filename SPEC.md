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
theme: paper            # paper | ink | slate | journal (papers) | newsroom (journalism) | fieldnotes (kraft + Futura)
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

### Blocks

| Block | Form | Options |
|---|---|---|
| heading | `# Text`, `## Text`, `### Text` | `#` starts a new section |
| text | `text: paragraph` | markdown-lite: `**bold**`, `*italic*`, `` `code` ``, `[link](https://…)` |
| post | `post: Title` | `date: YYYY-MM-DD`. Starts a blog post: its own section with an anchor `#date-title`; everything up to the next post belongs to it |
| posts | `posts:` | the index of posts, newest first. Without it, an index is placed before the first post when there are two or more |
| chart | `chart: <type>` | `title`, `query`, `format` (`,` `k` `%` `0.0`), `note`, `slider`, type options; `pick` and `mode` are the builder's column-picker state (ignored by the loader) |
| number | `number:` | same as chart with type `bignumber` |
| image | `image: <asset name>` or `image: https://…` | `alt`, `caption`, `width` (`320px`, `60%`), `align` (`center` `full` `left` `right`), `sha256` (URL images: the loader refuses a file that no longer matches) |
| embed | `embed: <url>` | YouTube, Vimeo, Apple Music, Spotify, SoundCloud, Bandcamp (its `EmbeddedPlayer` URL from Share / Embed), CodePen; fixed allowlist, rendered as an iframe; `caption`, `ratio` (`wide` `square` `tall` `music` `track`; music players pick their height automatically) |
| quote | `quote: text` | `by` |
| math | `math: <LaTeX>` | `label` (equation number). Inline math in any text as `$…$`. Rendered to MathML with Temml, loaded only by sites that use it |
| abstract | `abstract: text` | `keywords` |
| authors | `authors: Name (Affiliation); Name (Affiliation)` | `doi`, `contact`; affiliations are numbered |
| ref | `ref: key` | `text`, `url`, `doi`. Cite in text as `[@key]`; numbered in order of first citation |
| references | `references:` | the numbered list of `ref` blocks |
| footnotes | `footnotes:` | lists the `[^footnote text]` notes from the text; without it they go before the footer |
| divider | `divider:` | |

Numbered figures: any chart, image or embed with `figure: label` gets "Figure n." (a `table` chart gets
"Table n.") in its caption and an anchor `#fig-label`; `[@label]` in text becomes a link reading "Figure n".
Images also take `credit:`. Every chart has "Show table" and "CSV" buttons.

Stored images live in the database table `assets(name TEXT PRIMARY KEY, type TEXT, data BLOB)`:
SVG (sanitised on render) or WebP/PNG/JPEG bytes. The older `svg(name, body)` table still works.

Rules:
* `key: value` at column 0 is a top-level property until the first `#` heading.
* `# Heading` starts a section; `## Subheading` is a smaller heading inside it.
* `text:` is a paragraph (markdown-lite: `**`, `*`, links, `` `code` ``).
* `chart: <type>` opens a chart block; the indented `key: value` lines that follow
  belong to it. `query` is SQL run against the site database. `{slider-column}`
  in a query is substituted with the current slider value.
* `number:`, `image:`, `embed:`, `quote:`, `post:`, `posts:` and `divider:` as in the table above.
* Everything is rendered by the loader's built-in components; a site never
  ships its own JavaScript.

### Built-in chart types (v1)

`bars`, `hbars`, `line`, `area`, `scatter`, `bignumber`, `table`, `choropleth`,
`flowmap`, `slope`, `waffle`, `timeline`, `histogram` (`value`, `bins`), `boxplot` (`label` group,
`value`), `heatmap` (`x`, `y`, `value`). Error bars: columns `err` (±) or `lo`/`hi` on bars, line and
scatter (line draws a band). `yscale: log` on bars, line, area, scatter, boxplot. `fit: linear` on
scatter adds a least-squares line with r². `annotate: x=2010 | Label; x=2015 | Label` on line and area. Each takes `title`, `query`, `note`,
and type-specific options (`x`, `y`, `series`, `format`, `from`, `slider`, `color`).
Column conventions: `label`/`value` for one-dimensional charts, `x`/`y`(+`series`)
for time series, `iso2`/`value` for maps. Every chart gets a "Show table" toggle.

## Builder

`loader/make.html` edits the same text form through a block list (Blocks tab), a raw text view
(Text), CSV import into SQLite (Data), stored images (Images: SVG cleaned and sanitised, photos
re-encoded to WebP in the browser) and Publish (zone file, copy, check against public DNS,
record-size and host-cap settings). The builder never adds anything to the loader a site
could not have written by hand.

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
