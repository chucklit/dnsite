#!/usr/bin/env python3
"""mock_doh.py -- local stand-in for DNS-over-HTTPS + a static server for the loader.

    dev/mock_doh.py [--port 8787] [--zone zone/] [--loader loader/]

* GET /dns-query?name=<name>&type=TXT   -> Cloudflare-shaped JSON answer built from zone/*.json
* GET /<anything else>                   -> files from the loader folder (index.html at /)

The loader is opened as  http://localhost:8787/?host=<published host>  and, because the
resolver lives on the same origin, it asks  /dns-query  instead of cloudflare-dns.com.
Zone files are re-read on every request, so re-running publish.py is enough to see changes.
"""
import argparse, glob, json, os, sys, urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ZONE_DIR = "zone"


def load_zone():
    names = {}
    for path in glob.glob(os.path.join(ZONE_DIR, "*.json")):
        with open(path) as f:
            z = json.load(f)
        for r in z["records"]:
            names[r["name"].lower()] = r
    return names


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):  # development: never let the browser cache the loader files
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # quieter: one line per request, no timestamps
        if "/dns-query" not in self.path:
            sys.stderr.write("%s %s\n" % (self.command, self.path))

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path != "/dns-query":
            return super().do_GET()
        q = urllib.parse.parse_qs(u.query)
        name = (q.get("name") or [""])[0].rstrip(".").lower()
        qtype = (q.get("type") or ["TXT"])[0].upper()
        rec = load_zone().get(name)
        body = {"Status": 0, "TC": False, "RD": True, "RA": True, "AD": False, "CD": False,
                "Question": [{"name": name + ".", "type": 16}]}
        if rec and qtype in ("TXT", "16"):
            data = " ".join('"%s"' % s.replace("\\", "\\\\").replace('"', '\\"') for s in rec["strings"])
            body["Answer"] = [{"name": name + ".", "type": 16, "TTL": rec["ttl"], "data": data}]
        else:
            body["Status"] = 3  # NXDOMAIN
        out = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/dns-json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


def main():
    global ZONE_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--zone", default="zone")
    ap.add_argument("--loader", default="loader")
    a = ap.parse_args()
    ZONE_DIR = os.path.abspath(a.zone)
    os.chdir(a.loader)
    print(f"mock DoH + loader on http://localhost:{a.port}/  (zone: {ZONE_DIR})")
    for path in glob.glob(os.path.join(ZONE_DIR, "*.json")):
        print(f"  http://localhost:{a.port}/?host={os.path.basename(path)[:-5]}")
    ThreadingHTTPServer(("127.0.0.1", a.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
