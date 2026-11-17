// Which pages may open a room. The relay is for the site's own pages: a
// browser always sends the page's origin with a WebSocket handshake, and a
// page of another site is refused. A client that is not a browser can send
// any Origin it likes, so this keeps other websites from using the relay, and
// nothing more.

// Stands for a request without an Origin header in ALLOWED_ORIGINS.
const NO_ORIGIN = 'none';

// One entry of ALLOWED_ORIGINS as a test on an origin. An entry is an origin
// ("https://example.dev"), or has "*." in place of the first host labels
// ("https://*.example.pages.dev": any subdomain, not the bare domain), or
// ends in ":*" for any port or none ("http://localhost:*").
function matcher(entry) {
  const anyPort = entry.endsWith(':*');
  const base = (anyPort ? entry.slice(0, -2) : entry).replace(/\/+$/, '');
  const port = (origin) => {
    if (!anyPort) return origin;
    const found = /^(.*?)(?::\d{1,5})?$/.exec(origin);
    return found ? found[1] : origin;
  };
  const wildcard = /^(https?:\/\/)\*(\.[^/*]+)$/.exec(base);
  if (!wildcard) return (origin) => port(origin) === base;
  const [, scheme, suffix] = wildcard;
  return (origin) => {
    const bare = port(origin);
    return (
      bare.startsWith(scheme) &&
      bare.endsWith(suffix) &&
      /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(bare.slice(scheme.length, -suffix.length))
    );
  };
}

// ALLOWED_ORIGINS as a test on the value of an Origin header (null when the
// request has none). Entries are separated by spaces or commas.
export function allowedOrigins(value) {
  const entries = String(value ?? '')
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  const matchers = entries.filter((entry) => entry !== NO_ORIGIN).map(matcher);
  const withoutOrigin = entries.includes(NO_ORIGIN);
  return (origin) => (origin === null ? withoutOrigin : matchers.some((matches) => matches(origin)));
}

// `site` is the origin the request arrived on: the Worker and the site share
// the host name, so that is the site's origin without naming it here.
//
// Returns { allowed, corsOrigin }: whether the request may open a room, and
// the origin to grant CORS access to for the plain GET answers (the Origin of
// a listed origin other than the site, or null).
export function checkOrigin(request, site, env) {
  const origin = request.headers.get('Origin');
  if (origin === site) return { allowed: true, corsOrigin: null };
  const listed = allowedOrigins(env.ALLOWED_ORIGINS)(origin);
  return { allowed: listed, corsOrigin: listed ? origin : null };
}
