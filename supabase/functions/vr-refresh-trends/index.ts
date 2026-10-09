// vr-refresh-trends: collect today's trending links.
//
//   POST /functions/v1/vr-refresh-trends
//
// Two callers, and they are told apart deliberately:
//
//   you          a user JWT from the Refresh button. Runs for whoever is
//                signed in, with their own keywords.
//   the schedule pg_cron, every morning, with the shared secret in
//                x-vr-cron-secret and a user_id in the body. There is no
//                session to speak of, so it runs as the service role — which
//                means the owner of every row has to be set by hand, exactly as
//                in vr-import.
//
// The API keys (YouTube, GitHub) are read from this function's environment and
// never leave it. The sources themselves are shared/sources/*, the same code
// the local app used.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { authenticate, AuthError, SCHEMA, serviceClient } from '../_shared/auth.ts';
import { corsHeaders, json, preflight } from '../_shared/cors.ts';
import { runRefresh } from '../_shared/core/trends-core.mjs';
import { DEFAULT_KEYWORDS, DEFAULT_RADAR_LANGUAGES, SUBREDDITS } from '../_shared/core/defaults.mjs';
import { istDay } from '../_shared/core/time.mjs';

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
      throw new AuthError('The schedule must say which user to refresh for.', 400);
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

/** The storage shared/trends-core.mjs expects, on top of Postgres. */
function storeFor(caller: Caller) {
  const { client, userId } = caller;
  return {
    userId,

    async getUsage(provider: string) {
      const { data, error } = await client
        .from('usage').select('units, requests')
        .eq('user_id', userId).eq('provider', provider).eq('date', istDay())
        .maybeSingle();
      if (error && error.code !== 'PGRST116') throw new Error(`Could not read today's usage: ${error.message}`);
      return data ?? { units: 0, requests: 0 };
    },

    // Counted before the call, because YouTube charges for failed ones too.
    async addUsage(provider: string, units: number, requests: number) {
      const { error } = await client.rpc('add_usage', {
        p_user_id: userId, p_provider: provider, p_units: units, p_requests: requests,
      });
      if (error) throw new Error(`Could not record usage: ${error.message}`);
    },

    async replaceDay(day: string, sources: string[], rows: Record<string, unknown>[]) {
      if (sources.length) {
        const { error } = await client.from('trends')
          .delete().eq('user_id', userId).eq('fetched_on', day).in('source', sources);
        if (error) throw new Error(`Could not clear today's trends: ${error.message}`);
      }
      if (!rows.length) return;
      const { error } = await client.from('trends').upsert(rows, { onConflict: 'user_id,url' });
      if (error) throw new Error(`Could not save the trends: ${error.message}`);
    },

    async prune(before: string) {
      const { error } = await client.from('trends')
        .delete().eq('user_id', userId).lt('fetched_on', before);
      if (error) console.warn(`[vr-refresh-trends] could not prune old trends: ${error.message}`);
    },
  };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return preflight(req);
  if (req.method !== 'POST') return json(req, { ok: false, error: 'Use POST to refresh the radar.' }, 405);

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
    console.error('[vr-refresh-trends] auth failed', e);
    return json(req, { ok: false, error: 'Could not check who you are.' }, 503);
  }

  try {
    // Their own keywords and languages, if they have set any.
    const { data: settings } = await caller.client
      .from('settings').select('niche_keywords, radar_languages').eq('user_id', caller.userId).maybeSingle();
    const keywords = settings?.niche_keywords?.length ? settings.niche_keywords : DEFAULT_KEYWORDS;
    const languages = settings?.radar_languages?.length ? settings.radar_languages : DEFAULT_RADAR_LANGUAGES;

    const summary = await runRefresh(storeFor(caller), {
      keywords,
      subreddits: SUBREDDITS,
      youtubeKey: Deno.env.get('YOUTUBE_API_KEY') ?? '',
      githubToken: Deno.env.get('GITHUB_TOKEN') ?? '',
      languages,
    });

    console.log(`[vr-refresh-trends] ${caller.via} ${caller.userId}: ${summary.total} trends`
      + `${summary.failed.length ? `, failed: ${summary.failed.join(', ')}` : ''}`);
    return json(req, { ok: true, ...summary });
  } catch (e) {
    console.error('[vr-refresh-trends] failed', e);
    return json(req, { ok: false, error: `Could not refresh the radar: ${(e as Error).message}` }, 500);
  }
});

export { corsHeaders, SCHEMA };
