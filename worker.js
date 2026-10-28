/* DNSite loader as a Cloudflare Worker.
 *
 * Serves the static loader (the `loader/` folder, bound as ASSETS) and the same-origin
 * pass-through to the Cloudflare DNS API at /api/cf/* that the builder's "Publish to
 * Cloudflare" button uses. This is the file "Deploy to Cloudflare" installs into someone's
 * own account, so their domain serves the loader with no dependence on dnsite.org.
 * The pass-through forwards the person's token exactly as sent and keeps nothing.
 */
const ALLOWED = [
  /^zones$/,
  /^zones\/[0-9a-f]{32}\/dns_records$/,
  /^zones\/[0-9a-f]{32}\/dns_records\/[0-9a-f]{32}$/,
];
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/cf/")) {
      const path = url.pathname.slice("/api/cf/".length);
      if (!ALLOWED.some(re => re.test(path))) return json({ success: false, errors: [{ message: "path not allowed" }] }, 403);
      if (!["GET", "POST", "PUT", "DELETE"].includes(request.method)) return new Response("method not allowed", { status: 405 });
      const auth = request.headers.get("authorization") || "";
      if (!/^Bearer [A-Za-z0-9._-]{20,200}$/.test(auth)) return json({ success: false, errors: [{ message: "missing or malformed token" }] }, 401);
      const res = await fetch("https://api.cloudflare.com/client/v4/" + path + url.search, {
        method: request.method,
        headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
        body: ["POST", "PUT"].includes(request.method) ? await request.text() : undefined,
      });
      return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    // /make is the builder; everything else is the loader's static files (ASSETS honours _headers)
    if (url.pathname === "/make" || url.pathname === "/make/") return env.ASSETS.fetch(new Request(new URL("/make.html", url), request));
    return env.ASSETS.fetch(request);
  },
};
