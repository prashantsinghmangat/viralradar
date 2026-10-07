// CORS for the browser. The folder watcher is a Node script and never sends an
// Origin, so none of this applies to it.
//
// Origins are listed, not wildcarded. ALLOWED_ORIGINS is a comma-separated
// secret holding the Netlify address; local development addresses are always
// allowed because they cannot be reached from anywhere else.

const LOCAL_ORIGINS = [
  'http://localhost:8888',
  'http://localhost:5173',
  'http://localhost:4173',
  'http://localhost:3000',
  'http://127.0.0.1:8888',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:4173',
  'http://127.0.0.1:3000',
];

export function allowedOrigins(): string[] {
  const configured = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return [...configured, ...LOCAL_ORIGINS];
}

/**
 * Headers for one request. An origin we do not know gets no CORS headers at
 * all, which is what stops another website from calling this with your session.
 */
export function corsHeaders(req: Request): Record<string, string> {
  const origin = (req.headers.get('origin') ?? '').replace(/\/+$/, '');
  const base: Record<string, string> = {
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && allowedOrigins().includes(origin)) {
    base['Access-Control-Allow-Origin'] = origin;
  }
  return base;
}

/** The browser's pre-flight request. */
export const preflight = (req: Request) => new Response(null, { status: 204, headers: corsHeaders(req) });

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json; charset=utf-8' },
  });
}
