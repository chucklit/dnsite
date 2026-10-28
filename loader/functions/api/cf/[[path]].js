/* Same-origin proxy to the Cloudflare DNS API, for the builder's "Publish to Cloudflare" button.
 *
 * Browsers can't call api.cloudflare.com directly from a web page, so the builder calls
 * /api/cf/<path> on its own origin and this Cloudflare Pages Function forwards the request.
 * It forwards the person's token exactly as sent and never stores or logs it. Only the zone
 * lookup and DNS-record endpoints are allowed, with GET/POST/PUT/DELETE, so a token used here
 * can do nothing this page could not do anyway. No cookies, no state, nothing retained.
 */
const ALLOWED = [
  /^zones$/,                                   // GET  /zones?name=example.com
  /^zones\/[0-9a-f]{32}\/dns_records$/,        // GET list, POST create
  /^zones\/[0-9a-f]{32}\/dns_records\/[0-9a-f]{32}$/,   // PUT update, DELETE
];

export async function onRequest({ request, params }) {
  const path = (params.path || []).join("/");
  if (!ALLOWED.some(re => re.test(path))) return new Response(JSON.stringify({ success: false, errors: [{ message: "path not allowed" }] }), { status: 403, headers: { "content-type": "application/json" } });
  if (!["GET", "POST", "PUT", "DELETE"].includes(request.method)) return new Response("method not allowed", { status: 405 });
  const auth = request.headers.get("authorization") || "";
  if (!/^Bearer [A-Za-z0-9._-]{20,200}$/.test(auth)) return new Response(JSON.stringify({ success: false, errors: [{ message: "missing or malformed token" }] }), { status: 401, headers: { "content-type": "application/json" } });
  const url = new URL(request.url), upstream = "https://api.cloudflare.com/client/v4/" + path + url.search;
  const res = await fetch(upstream, {
    method: request.method,
    headers: { authorization: auth, "content-type": "application/json", accept: "application/json" },
    body: ["POST", "PUT"].includes(request.method) ? await request.text() : undefined,
  });
  return new Response(res.body, { status: res.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
