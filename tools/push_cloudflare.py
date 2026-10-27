#!/usr/bin/env python3
"""push_cloudflare.py -- put a published zone's TXT records into Cloudflare DNS.

    CF_API_TOKEN=... tools/push_cloudflare.py zone/dnsite.org.json [zone/greeks.dnsite.org.json ...]
                      [--zone dnsite.org] [--dry-run]

The token must have  Zone:DNS:Edit  on the zone (make it at dash.cloudflare.com -> My Profile ->
API Tokens -> "Edit zone DNS" template). It is read from the environment only; never put it on
the command line or in a file in this repo.

For each record in the JSON: create it if absent, update it if its content differs, leave it
alone if identical. Then delete any leftover  _dnsite/s*/d*/m*  records under that host that the
new publish no longer uses (an old, longer site). Prints one line per change.
"""
import argparse, json, os, re, sys, urllib.request, urllib.parse

API = "https://api.cloudflare.com/client/v4"


def call(method, path, token, body=None, params=None):
    url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    req = urllib.request.Request(url, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req) as r:
            out = json.load(r)
    except urllib.error.HTTPError as e:
        try:
            msgs = "; ".join(f"{x.get('code')}: {x.get('message')}" for x in json.load(e).get("errors", []))
        except Exception:
            msgs = e.reason
        sys.exit(f"Cloudflare answered {e.code} on {method} {path}: {msgs}"
                 + ("\n(check the token: it must be the real token string, with DNS Read+Edit on the zone)" if e.code in (400, 401, 403) else ""))
    if not out.get("success"):
        sys.exit(f"Cloudflare error on {method} {path}: {out.get('errors')}")
    return out


def txt_content(strings):
    # Cloudflare stores a TXT record as one content string; multiple quoted strings are allowed and
    # kept as separate character-strings in the wire record.
    return " ".join('"%s"' % s.replace("\\", "\\\\").replace('"', '\\"') for s in strings)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("json", nargs="+", help="zone/<host>.json files from publish.py")
    ap.add_argument("--zone", help="Cloudflare zone name (default: derived from the host, last two labels)")
    ap.add_argument("--ttl", type=int, default=300)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    token = os.environ.get("CF_API_TOKEN")
    if not token:
        sys.exit("set CF_API_TOKEN in the environment first (Zone:DNS:Edit on the zone)")

    for path in a.json:
        pub = json.load(open(path))
        host = pub["host"]
        zone_name = a.zone or ".".join(host.split(".")[-2:])
        zones = call("GET", "/zones", token, params={"name": zone_name})["result"]
        if not zones:
            sys.exit(f"zone {zone_name} not found in this Cloudflare account (or token lacks access)")
        zid = zones[0]["id"]

        # what's there now, for this host's dnsite names
        existing = {}
        page = 1
        while True:
            res = call("GET", f"/zones/{zid}/dns_records", token, params={"type": "TXT", "per_page": 500, "page": page})
            for r in res["result"]:
                existing[r["name"].lower()] = r
            if page >= res["result_info"]["total_pages"]:
                break
            page += 1

        wanted = {r["name"].lower(): r for r in pub["records"]}
        created = updated = same = deleted = 0
        for name, r in wanted.items():
            content = txt_content(r["strings"])
            cur = existing.get(name)
            if cur and cur["content"] == content:
                same += 1; continue
            body = {"type": "TXT", "name": name, "content": content, "ttl": a.ttl}
            if cur:
                print(f"update {name}"); updated += 1
                if not a.dry_run: call("PUT", f"/zones/{zid}/dns_records/{cur['id']}", token, body)
            else:
                print(f"create {name}"); created += 1
                if not a.dry_run: call("POST", f"/zones/{zid}/dns_records", token, body)

        stale = re.compile(rf"^(_dnsite|[sdm]\d+)\.{re.escape(host)}$")
        for name, cur in existing.items():
            if stale.match(name) and name not in wanted:
                print(f"delete {name} (no longer used)"); deleted += 1
                if not a.dry_run: call("DELETE", f"/zones/{zid}/dns_records/{cur['id']}", token)

        print(f"{host}: {created} created, {updated} updated, {same} unchanged, {deleted} deleted"
              + (" (dry run, nothing sent)" if a.dry_run else ""))


if __name__ == "__main__":
    main()
