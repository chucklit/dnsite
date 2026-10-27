# dnsite

A website that lives entirely in its domain's DNS records. The text, the SQLite
database behind the charts and (optionally) a custom SVG map are stored as TXT
records; a single static loader page reads them back over DNS-over-HTTPS and
renders the site in the visitor's browser. No hosting per site, nothing to deploy.
`SPEC.md` has the record layout and the site language.

## Layout

```
publish.py          site.txt (+db, +svg) -> zone/<host>.zone + zone/<host>.json
loader/             the universal loader: index.html, app.js, vendor/sql.js, assets/world.svg
dev/mock_doh.py     local DNS-over-HTTPS stand-in + static server for the loader
tools/make_map.py   rebuilds loader/assets/world.svg + centroids.json from world-atlas
data/               datasets and the scripts that build the demo databases
examples/           demo sites (smoke test, Greek emigration)
zone/               published records (generated)
```

## Try it locally

```bash
python3 publish.py examples/smoke/site.txt --host smoke.test --db examples/smoke/smoke.db --out zone
python3 dev/mock_doh.py --port 8787
# open http://localhost:8787/?host=smoke.test
```

## Publish for real

1. Run `publish.py` with `--host yourdomain.com` and paste the lines of
   `zone/yourdomain.com.zone` into your DNS host (or import the file).
2. Point `yourdomain.com` at a loader (A record or CNAME).
3. Open the domain. The loader asks `cloudflare-dns.com/dns-query` for
   `_dnsite.yourdomain.com` and takes it from there.

Anyone can check what the site is made of: `dig TXT _dnsite.yourdomain.com`.
