#!/usr/bin/env python3
"""mock_doh.py -- local stand-in for DNS-over-HTTPS + a static server for the loader.

    dev/mock_doh.py [--port 8787] [--zone zone/] [--loader loader/]

* GET /dns-query?name=<name>&type=TXT   -> Cloudflare-shaped JSON answer built from zone/*.json
* GET /<anything else>                   -> files from the loader folder (index.html at /)

The loader is opened as  http://localhost:8787/?host=<published host>  and, because the
resolver lives on the same origin, it asks  /dns-query  instead of cloudflare-dns.com.
Zone files are re-read on every request, so re-running publish.py is enough to see changes.
"""
import argparse, glob, json, os, re, sys, urllib.parse, urllib.request, uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ZONE_DIR = "zone"

# A fake Cloudflare DNS API lives at /api/cf/... when the token starts with "fake-" (any other token is
# forwarded to the real API, like the Pages Function in loader/functions does in production). Records
# written to the fake zone also answer /dns-query, so "Publish to Cloudflare" + "Check the domain" can
# be exercised end to end on localhost without a real token.
FAKE_ZONE = {"id": "f" * 32, "name": "fake.test"}
FAKE_RECORDS = {}   # id -> {id, type, name, content, ttl}


def fake_cf(method, path, query, body):
    if path == "zones":
        name = (query.get("name") or [""])[0]
        return {"success": True, "result": [FAKE_ZONE] if name.endswith(FAKE_ZONE["name"]) or not name else []}
    m = re.match(r"^zones/([0-9a-f]{32})/dns_records(?:/([0-9a-f]{32}))?$", path)
    if not m or m.group(1) != FAKE_ZONE["id"]:
        return {"success": False, "errors": [{"code": 7003, "message": "no such zone or route"}]}
    rid = m.group(2)
    if method == "GET":
        return {"success": True, "result": list(FAKE_RECORDS.values()), "result_info": {"total_pages": 1}}
    if method == "POST":
        r = {"id": uuid.uuid4().hex, **{k: body[k] for k in ("type", "name", "content", "ttl")}}
        FAKE_RECORDS[r["id"]] = r; return {"success": True, "result": r}
    if method == "PUT" and rid in FAKE_RECORDS:
        FAKE_RECORDS[rid].update({k: body[k] for k in ("type", "name", "content", "ttl")}); return {"success": True, "result": FAKE_RECORDS[rid]}
    if method == "DELETE" and rid in FAKE_RECORDS:
        return {"success": True, "result": FAKE_RECORDS.pop(rid)}
    return {"success": False, "errors": [{"code": 81044, "message": "record not found"}]}


def fake_txt_strings(name):
    """TXT strings for a name written through the fake API (content is "a" "b" quoted strings)."""
    for r in FAKE_RECORDS.values():
        if r["name"].lower() == name and r["type"] == "TXT":
            return [x.replace('\\"', '"').replace("\\\\", "\\") for x in re.findall(r'"((?:[^"\\]|\\.)*)"', r["content"])] or [r["content"]]
    return None


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

    def cf(self):
        u = urllib.parse.urlsplit(self.path)
        path = u.path[len("/api/cf/"):]
        n = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(n) if n else b""
        auth = self.headers.get("Authorization") or ""
        token = auth[7:] if auth.startswith("Bearer ") else ""
        if token.startswith("fake-"):
            out = fake_cf(self.command, path, urllib.parse.parse_qs(u.query), json.loads(raw or b"{}"))
            status = 200
        else:   # forward to the real API, exactly like the Pages Function
            req = urllib.request.Request("https://api.cloudflare.com/client/v4/" + path + ("?" + u.query if u.query else ""),
                                         method=self.command, data=raw or None, headers={"Authorization": auth, "Content-Type": "application/json"})
            try:
                with urllib.request.urlopen(req) as r: out, status = json.load(r), r.status
            except urllib.error.HTTPError as e: out, status = json.load(e), e.code
        body = json.dumps(out).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body)))
        self.end_headers(); self.wfile.write(body)

    def do_POST(self): return self.cf() if self.path.startswith("/api/cf/") else self.send_error(404)
    def do_PUT(self): return self.cf() if self.path.startswith("/api/cf/") else self.send_error(404)
    def do_DELETE(self): return self.cf() if self.path.startswith("/api/cf/") else self.send_error(404)

    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        if u.path.startswith("/api/cf/"):
            return self.cf()
        if u.path != "/dns-query":
            return super().do_GET()
        q = urllib.parse.parse_qs(u.query)
        name = (q.get("name") or [""])[0].rstrip(".").lower()
        qtype = (q.get("type") or ["TXT"])[0].upper()
        rec = load_zone().get(name)
        strings = rec["strings"] if rec else fake_txt_strings(name)
        body = {"Status": 0, "TC": False, "RD": True, "RA": True, "AD": False, "CD": False,
                "Question": [{"name": name + ".", "type": 16}]}
        if strings and qtype in ("TXT", "16"):
            data = " ".join('"%s"' % s.replace("\\", "\\\\").replace('"', '\\"') for s in strings)
            body["Answer"] = [{"name": name + ".", "type": 16, "TTL": 300, "data": data}]
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
