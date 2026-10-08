// vr-purge-project-files: delete files from projects that were posted a while ago.
//
//   POST /functions/v1/vr-purge-project-files
//
// WHY THIS IS A FUNCTION AND NOT JUST SQL
//   Deleting a row from storage.objects does NOT delete the bytes behind it.
//   They stay in the bucket, still counted against this project's ~1 GB free
//   tier, and now with nothing left to find them by. Only the Storage API
//   really removes a file, and SQL cannot call it. So pg_cron asks pg_net to
//   call this, exactly as it asks for the morning trend refresh.
//
// Two callers, told apart the same way vr-refresh-trends tells them apart:
//
//   you          a user JWT, from the "Clean up now" button in Settings. Runs
//                for whoever is signed in, and Row Level Security is what
//                limits it to their own files.
//   the schedule pg_cron, nightly, with the shared secret in x-vr-cron-secret
//                and a user_id in the body. There is no session, so it runs as
//                the service role — which bypasses every policy, and therefore
//                has to check the allowlist by hand and filter by user_id
//                itself.
//
// WHICH FILES
//   Never decided here. viralradar.project_files_due() is the single place the
//   "14 days after the project was marked posted" rule is written, so this
//   function only ever asks and then deletes what it is handed.
//
// ORDER
//   Files first, rows second. A failure half way then leaves rows pointing at
//   files that are gone — which the UI can show as "file removed" — rather than
//   files that nothing points at, which nothing could ever clean up.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { authenticate, AuthError, SCHEMA, serviceClient } from '../_shared/auth.ts';
import { corsHeaders, json, preflight } from '../_shared/cors.ts';
import { BUCKET, POSTED_RETENTION_DAYS, formatBytes } from '../_shared/core/projects.mjs';

/** Constant-time compare, so the secret cannot be guessed a character at a time. */
function sameSecret(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

type Caller = { userId: string; client: SupabaseClient; via: 'jwt' | 'cron' };

async function resolveCaller(req: Request, body: { user_id?: string }): Promise<Caller> {
  const offered = req.headers.get('x-vr-cron-secret') ?? '';
  const expected = Deno.env.get('CRON_SECRET') ?? '';

  if (offered) {
    if (!expected) throw new AuthError('The schedule is not configured: CRON_SECRET is not set.', 503);
    if (!sameSecret(offered, expected)) throw new AuthError('That is not the right schedule secret.', 401);
    const userId = String(body?.user_id ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(userId)) {
      throw new AuthError('The schedule must say which user to clean up for.', 400);
    }
    // The service role skips every policy, so check the allowlist by hand.
    const service = serviceClient();
    const { data: allowed, error } = await service
      .from('allowed_users').select('user_id').eq('user_id', userId).maybeSingle();
    if (error) throw new AuthError(`Could not check that account: ${error.message}`, 503);
    if (!allowed) throw new AuthError('That account is not allowed to use ViralRadar.', 403);
    return { userId, client: service, via: 'cron' };
  }

  const caller = await authenticate(req);
  return { userId: caller.userId, client: caller.client, via: 'jwt' };
}

type DueFile = { item_id: string; project_id: string; storage_path: string; size_bytes: number | null };

// The Storage API takes a list of keys. Kept modest so one bad key cannot take
// a large batch down with it, and so a slow response cannot run out the clock.
const BATCH = 50;

const chunk = <T>(list: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight(req);
  if (req.method !== 'POST') return json(req, { ok: false, error: 'Use POST to clean up old project files.' }, 405);

  let body: { user_id?: string } = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text);
  } catch {
    return json(req, { ok: false, error: 'The request body is not valid JSON.' }, 400);
  }

  let caller: Caller;
  try {
    caller = await resolveCaller(req, body);
  } catch (e) {
    if (e instanceof AuthError) return json(req, { ok: false, error: e.message }, e.status);
    console.error('[vr-purge-project-files] auth failed', e);
    return json(req, { ok: false, error: 'Could not check who you are.' }, 503);
  }

  try {
    // The retention rule lives in the database, not here.
    const { data: due, error: dueError } = await caller.client.rpc('project_files_due', {
      p_user_id: caller.userId,
      p_days: POSTED_RETENTION_DAYS,
    });
    if (dueError) throw new Error(`Could not work out which files are due: ${dueError.message}`);

    const files = (due ?? []) as DueFile[];
    if (!files.length) {
      console.log(`[vr-purge-project-files] ${caller.via} ${caller.userId}: nothing due`);
      return json(req, { ok: true, deleted: 0, freed_bytes: 0, freed: formatBytes(0), message: 'Nothing to clean up.' });
    }

    // A path outside this user's own prefix would mean the database handed
    // back something impossible, and deleting it is not this function's call.
    // The storage policies would refuse it for a JWT caller, but the schedule
    // runs as the service role, where nothing else would.
    const prefix = `${caller.userId}/`;
    const mine = files.filter((f) => typeof f.storage_path === 'string' && f.storage_path.startsWith(prefix));
    if (mine.length !== files.length) {
      console.error(`[vr-purge-project-files] ${caller.userId}: ${files.length - mine.length} due file(s)`
        + ' were not under this user\'s prefix and have been left alone');
    }

    let deleted = 0;
    let freed = 0;
    const removedIds: string[] = [];
    const failures: string[] = [];

    for (const batch of chunk(mine, BATCH)) {
      const paths = batch.map((f) => f.storage_path);
      const { error } = await caller.client.storage.from(BUCKET).remove(paths);
      if (error) {
        // One batch failing must not lose the rest: the next run picks these
        // up again, because their rows are still there.
        failures.push(error.message);
        console.error(`[vr-purge-project-files] could not remove ${paths.length} file(s): ${error.message}`);
        continue;
      }
      deleted += batch.length;
      freed += batch.reduce((n, f) => n + (Number(f.size_bytes) || 0), 0);
      removedIds.push(...batch.map((f) => f.item_id));
    }

    // Rows only for files that really went. user_id is filtered explicitly
    // because the schedule's client is the service role and ignores policies.
    if (removedIds.length) {
      for (const ids of chunk(removedIds, BATCH)) {
        const { error } = await caller.client
          .from('project_items').delete().eq('user_id', caller.userId).in('id', ids);
        if (error) {
          // The files are gone; the rows are not. The UI shows those as
          // "file removed", and the next run cannot re-delete a missing file,
          // so this is worth reporting but not worth failing over.
          failures.push(error.message);
          console.error(`[vr-purge-project-files] files deleted but ${ids.length} row(s) remain: ${error.message}`);
        }
      }
    }

    console.log(`[vr-purge-project-files] ${caller.via} ${caller.userId}: deleted ${deleted} of ${mine.length} file(s),`
      + ` freed ${formatBytes(freed)}${failures.length ? `, ${failures.length} failure(s)` : ''}`);

    return json(req, {
      ok: failures.length === 0,
      deleted,
      freed_bytes: freed,
      freed: formatBytes(freed),
      retention_days: POSTED_RETENTION_DAYS,
      message: deleted
        ? `Deleted ${deleted} file${deleted === 1 ? '' : 's'} and freed ${formatBytes(freed)}.`
        : 'Nothing could be deleted.',
      ...(failures.length ? { error: `Some files could not be deleted: ${failures[0]}` } : {}),
    }, failures.length ? 500 : 200);
  } catch (e) {
    console.error('[vr-purge-project-files] failed', e);
    return json(req, { ok: false, error: `Could not clean up old project files: ${(e as Error).message}` }, 500);
  }
});

export { corsHeaders, SCHEMA };
