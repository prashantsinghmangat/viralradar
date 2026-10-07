// vr-import: takes a Shorts Studio export and saves it.
//
//   POST /functions/v1/vr-import
//   Authorization: Bearer <user JWT>   from the browser
//                  Bearer vr_...       from the laptop folder watcher
//   Body: the export, as application/json or text/plain
//
// Validation and wording come from shared/contract.mjs, the same module the
// local SQLite app uses, so the same file is accepted or refused the same way
// with the same message either side of the migration.

import { authenticate, AuthError, storeFor } from '../_shared/auth.ts';
import { corsHeaders, json, preflight } from '../_shared/cors.ts';
import { runImport } from '../_shared/core/import-core.mjs';
import { ImportError } from '../_shared/core/contract.mjs';

const MAX_BYTES = 10 * 1024 * 1024; // a Shorts Studio export is kilobytes; this is only a guard

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight(req);
  if (req.method !== 'POST') {
    return json(req, { ok: false, error: 'Send the export with POST.' }, 405);
  }

  let caller;
  try {
    caller = await authenticate(req);
  } catch (e) {
    if (e instanceof AuthError) return json(req, { ok: false, error: e.message }, e.status);
    console.error('[vr-import] auth failed', e);
    return json(req, { ok: false, error: 'Could not check who you are. Try again in a moment.' }, 503);
  }

  const body = await req.text();
  if (body.length > MAX_BYTES) {
    return json(req, { ok: false, error: 'That file is too large (limit 10 MB).' }, 413);
  }

  try {
    const result = await runImport(body, storeFor(caller));
    console.log(`[vr-import] ${caller.via} ${caller.userId}: ${result.message}`);
    return json(req, result);
  } catch (e) {
    if (e instanceof ImportError) {
      // Bad file, not a bad request: the message tells the person what to fix.
      return json(req, { ok: false, error: e.message }, 400);
    }
    console.error('[vr-import] failed', e);
    return json(req, { ok: false, error: `Import failed: ${(e as Error).message}` }, 500);
  }
});

// corsHeaders is re-exported so a future function can reuse the same list
// without importing two modules.
export { corsHeaders };
