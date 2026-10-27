# Putting dnsite.org online

Two halves: the **records** (the sites themselves, in DNS) and the **loader** (one static
page the domains point at). Both are prepared; the steps below need the account owner.

## 1. Records -> DNS

If dnsite.org's DNS is on Cloudflare:

```bash
export CF_API_TOKEN=...        # token with Zone:DNS:Edit on dnsite.org, made in the dashboard
cd ~/Developer/dnsite
python3 tools/push_cloudflare.py zone/dnsite.org.json zone/greeks.dnsite.org.json --dry-run
python3 tools/push_cloudflare.py zone/dnsite.org.json zone/greeks.dnsite.org.json
```

Elsewhere: import `zone/dnsite.org.zone` and `zone/greeks.dnsite.org.zone` (BIND format),
or paste the records. 35 TXT records in all. Re-run `publish.py` + the push after any edit.

Check from anywhere once it propagates: `dig TXT _dnsite.dnsite.org +short`

## 2. Loader -> a static host

The loader is the `loader/` folder, plain static files, no build. Cloudflare Pages is the
simplest home if the domain is already there (free, HTTPS handled, custom domains in the UI):

```bash
npm i -g wrangler && wrangler login
cd ~/Developer/dnsite/loader
wrangler pages project create dnsite --production-branch main
wrangler pages deploy . --project-name dnsite
```

Then in Pages -> Custom domains add `dnsite.org` and `greeks.dnsite.org`; Cloudflare writes
the CNAMEs and issues certificates. (Pages has no wildcard, so each free subdomain is added
there once. Other people's domains later go through Cloudflare for SaaS or a Caddy host with
on-demand TLS.)

Any other static host works the same way: upload `loader/`, point the two names at it with a
CNAME (or A record for the apex) and give it certificates for both names.

## 3. Check

Open https://dnsite.org and https://greeks.dnsite.org. The loader reads
`location.hostname`, asks cloudflare-dns.com for `_dnsite.<host>`, and renders. The footer
of every page shows the record count and the `dig` command.
