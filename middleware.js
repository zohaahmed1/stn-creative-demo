// Vercel Edge Middleware — rate limit /creative-audit to block bot bursts.
// Runs at the CDN edge before the page is served. In-memory Map resets per
// edge instance (not distributed), which is fine for blocking scrapers but
// not for strict quota enforcement. For that we'd move to Upstash Redis.

export const config = {
  matcher: ['/creative-audit', '/creative-audit/:path*'],
};

// Sliding window: max N requests per IP within WINDOW_MS ms.
const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS = 5;

// IP -> array of request timestamps within the current window.
const ipHits = new Map();

function getClientIp(request) {
  // Vercel sets x-forwarded-for and x-real-ip on all edge requests.
  const xff = request.headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  const xri = request.headers.get('x-real-ip');
  if (xri) return xri.trim();
  return 'unknown';
}

export default function middleware(request) {
  const ip = getClientIp(request);
  const now = Date.now();
  const windowStart = now - WINDOW_MS;

  // Pull existing timestamps for this IP, drop anything older than the window.
  let hits = ipHits.get(ip) || [];
  hits = hits.filter((t) => t > windowStart);

  if (hits.length >= MAX_REQUESTS) {
    // Rate limited. Return a 429 with a retry hint.
    const oldest = hits[0];
    const retryAfterSec = Math.max(1, Math.ceil((oldest + WINDOW_MS - now) / 1000));
    return new Response('Too many requests. Please slow down.', {
      status: 429,
      headers: {
        'Retry-After': String(retryAfterSec),
        'X-RateLimit-Limit': String(MAX_REQUESTS),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': String(Math.ceil((oldest + WINDOW_MS) / 1000)),
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }

  // Record this hit and prune the Map occasionally to prevent unbounded growth.
  hits.push(now);
  ipHits.set(ip, hits);

  if (ipHits.size > 10000) {
    for (const [key, value] of ipHits.entries()) {
      if (value.length === 0 || value[value.length - 1] < windowStart) {
        ipHits.delete(key);
      }
    }
  }

  // Within the limit — let the request through and annotate the response.
  return undefined;
}
