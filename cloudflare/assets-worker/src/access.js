// Who may fetch the assets, and which cross-origin headers the answer carries.
//
// This is hotlink protection for a public site, not secrecy: every header it
// looks at except the bearer token can be set freely by a client that is not a
// browser. It stops other sites from embedding or linking the files.

// One entry of ALLOWED_ORIGINS as a test on an origin. An entry is an origin
// ("https://example.dev") or has "*." in place of the first host labels
// ("https://*.example.pages.dev": any subdomain, not the bare domain).
function matcher(entry) {
  const wildcard = /^(https?:\/\/)\*(\.[^/*]+)$/.exec(entry);
  if (!wildcard) {
    const exact = entry.replace(/\/+$/, '');
    return (origin) => origin === exact;
  }
  const [, scheme, suffix] = wildcard;
  return (origin) =>
    origin.startsWith(scheme) &&
    origin.endsWith(suffix) &&
    /^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(origin.slice(scheme.length, -suffix.length));
}

export function allowedOrigins(value) {
  const matchers = String(value ?? '')
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(matcher);
  return (origin) => matchers.some((matches) => matches(origin));
}

function refererOrigin(referer) {
  if (referer === null) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

// Compares digests instead of the strings so that neither the length of the
// secret nor the position of the first wrong character shows in the timing.
async function sameSecret(given, secret) {
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(given)),
    crypto.subtle.digest('SHA-256', encoder.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

async function bearerMatches(header, secret) {
  // No configured secret means no token access, never "the empty token works".
  if (typeof secret !== 'string' || secret === '') return false;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return match !== null && (await sameSecret(match[1], secret));
}

// `site` is the origin the request arrived on. The Worker and the site share
// the hostname, so that is the site's origin without naming it here.
//
// Returns { allowed, crossOrigin, corsOrigin }: whether to serve the request,
// whether it comes from a listed origin other than the site, and the origin to
// grant CORS access to (the Origin header of such a request, or null).
export async function checkAccess(request, site, env) {
  const listed = allowedOrigins(env.ALLOWED_ORIGINS);
  const origin = request.headers.get('Origin');
  // Where the request says it comes from. A browser that sends Origin has
  // answered that, so the Referer is not consulted as a second opinion.
  const from = origin ?? refererOrigin(request.headers.get('Referer'));
  const crossOrigin = from !== null && from !== site && listed(from);

  let allowed = request.headers.get('Sec-Fetch-Site') === 'same-origin' || from === site || crossOrigin;
  if (!allowed) {
    allowed = await bearerMatches(request.headers.get('Authorization'), env.ASSETS_TOKEN);
  }
  return { allowed, crossOrigin, corsOrigin: crossOrigin ? origin : null };
}

// The headers every response carries, whatever its status. The page is
// cross-origin isolated (COEP: require-corp), so the browser blocks a response
// that does not carry a Cross-Origin-Resource-Policy the page passes. A listed
// origin needs "cross-origin" also when it sent no Origin header (a no-cors
// request, allowed by its Referer): CORS headers would not help it there.
export function applyAccessHeaders(headers, access) {
  // The CORS headers depend on Origin, so a cache must not hand one origin's
  // response to another.
  headers.append('Vary', 'Origin');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Cross-Origin-Resource-Policy', access.crossOrigin ? 'cross-origin' : 'same-origin');
  if (access.corsOrigin !== null) {
    headers.set('Access-Control-Allow-Origin', access.corsOrigin);
    headers.set('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range, ETag');
  }
}
