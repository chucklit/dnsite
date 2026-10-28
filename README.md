# dnsite

A website that lives entirely in its domain's DNS records. The text, the SQLite
database behind the charts and (optionally) a custom SVG map are stored as TXT
records; a single static loader page reads them back over DNS-over-HTTPS and
renders the site in the visitor's browser. No hosting per site, nothing to deploy.
`SPEC.md` has the record layout and the site language.

## Layout

```
publish.py          site.txt (+db, +svg) -> zone/<host>.zone + zone/<host>.json
loader/             the universal loader (index.html, app.js, site.css, vendor/sql.js, assets/world.svg)
                    and the builder (make.html, make.js): write, add CSVs, preview, get the records
dev/mock_doh.py     local DNS-over-HTTPS stand-in + static server for the loader
tools/make_map.py   rebuilds loader/assets/world.svg + centroids.json from world-atlas
data/               datasets and the scripts that build the demo databases
examples/           demo sites: smoke test, Greek emigration, a blog, a research note (paper)
zone/               published records (generated)
```

## Try it locally

```bash
python3 publish.py examples/smoke/site.txt --host smoke.test --db examples/smoke/smoke.db --out zone
python3 dev/mock_doh.py --port 8787
# open http://localhost:8787/?host=smoke.test
```

## Make one in the browser

Open `/make.html` on any loader (https://dnsite.org/make.html): write the site, drop CSV
files on the Data tab, watch the preview, then publish: straight to Cloudflare from the browser
(through a same-origin pass-through that stores nothing), or download the zone file. It can also
open an existing DNSite from DNS for editing.

## Publish for real

1. Run `publish.py` with `--host yourdomain.com` and paste the lines of
   `zone/yourdomain.com.zone` into your DNS host (or import the file).
2. Point `yourdomain.com` at a loader (A record or CNAME).
3. Open the domain. The loader asks `cloudflare-dns.com/dns-query` for
   `_dnsite.yourdomain.com` and takes it from there.

Anyone can check what the site is made of: `dig TXT _dnsite.yourdomain.com`.

## For tools and language models

`loader/llms.txt` (short) and `loader/llms-full.txt` (the spec) are served at dnsite.org for anything that
wants to write a DNSite; `loader/.well-known/dnsite` advertises the format version. `THEMES.md` covers
writing themes and running your own loader.

## Prior art

[triweb.dev](https://news.ycombinator.com/item?id=39502097) (2024) stores small text pages in TXT records and reads them over DNS-over-HTTPS; DNSite adds the database, the charts and maps, equations and references, images, themes, the site language and the builder.
