// Who is calling, and with what powers.
//
// Two ways in, with deliberately different trust:
//
//   JWT    the browser, after signing in. A client is built carrying that JWT,
//          so every statement runs as that user and Row Level Security applies
//          exactly as it does anywhere else. Nothing here has to check whether
//          the user is allowed: the policies do it.
//
//   vr_    a personal import token, for the laptop folder watcher, which has no
//          session and cannot refresh one. The token is hashed and looked up,
//          and the work then runs with the SERVICE ROLE, which bypasses RLS
//          entirely. That means the two things RLS would have done have to be
//          done here by hand:
//            1. user_id is set explicitly on every row (never defaulted)
//            2. the allowlist is checked, because the service role ignores it
//          Miss either and a token becomes a way around every policy.

import { createClient, type SupabaseClient } from 'jsr:@supabase/supabase-js@2';
import { hashToken, readAuthorization } from './core/tokens.mjs';
import { pickKey } from './core/keys.mjs';
import { escapeLikePattern, INBOX_TITLE } from './core/projects.mjs';

export const SCHEMA = 'viralradar';

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

/**
 * Why a lookup against the database failed.
 *
 * These functions reach the database through PostgREST, exactly as the browser
 * does, so they hit the same wall when the schema is not in the Data API's
 * exposed list. Reporting that as "try again in a moment" sends someone
 * refreshing forever, because it will never come right on its own.
 */
function lookupFailed(error: { message?: string; code?: string }): AuthError {
  const message = error?.message ?? '';
  // The detail goes to the function's log, never to the caller: a stranger
  // probing with made-up tokens should learn nothing about the inside.
  console.error(`[vr-import] token lookup failed: ${error?.code ?? '?'} ${message}`);
  if (/PGRST106|invalid schema|schema must be one of/i.test(message) || error?.code === 'PGRST106') {
    return new AuthError(
      'ViralRadar is not switched on in Supabase yet: add "viralradar" under '
      + 'Project Settings -> API -> Data API -> Exposed schemas.',
      503,
    );
  }
  return new AuthError('Could not check that import token. Try again in a moment.', 503);
}

export type Caller = {
  userId: string;
  client: SupabaseClient;
  /** How they got in. Worth logging; never worth trusting from the request. */
  via: 'jwt' | 'token';
};

// Supabase hands a function both the new keys and the legacy ones. A project
// can have the legacy anon/service_role keys switched off — this one does —
// and then using them fails with "Legacy API keys are disabled". So prefer the
// new ones and keep the old as a fallback, rather than assuming either.
//
// pickKey lives in shared/ because getting it wrong is silent: see keys.mjs.
const url = () => Deno.env.get('SUPABASE_URL') ?? '';
const anonKey = () => pickKey(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS'), Deno.env.get('SUPABASE_ANON_KEY'));
const serviceKey = () => pickKey(Deno.env.get('SUPABASE_SECRET_KEYS'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));

const options = { db: { schema: SCHEMA }, auth: { persistSession: false, autoRefreshToken: false } };

/** A client that is the signed-in user: RLS applies to everything it does. */
function userClient(jwt: string): SupabaseClient {
  return createClient(url(), anonKey(), {
    ...options,
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

/**
 * A client that bypasses RLS. Only ever used behind something already
 * verified: a token whose hash was found, or the schedule secret. Whatever
 * uses it must set user_id itself and check the allowlist itself.
 */
export function serviceClient(): SupabaseClient {
  // An empty key here does not fail loudly: the client simply has no privileges
  // and every query comes back "permission denied".
  if (!serviceKey()) console.error("[vr-import] no usable service key in SUPABASE_SECRET_KEYS or SUPABASE_SERVICE_ROLE_KEY");
  return createClient(url(), serviceKey(), options);
}

/**
 * Resolve the caller, or throw AuthError with a message meant for a person.
 * Never reveals whether a token merely exists.
 */
export async function authenticate(req: Request): Promise<Caller> {
  const { kind, value } = readAuthorization(req.headers.get('authorization'));

  if (kind === 'none') {
    throw new AuthError('Not signed in. Open ViralRadar and sign in, or send an import token.');
  }

  if (kind === 'jwt') {
    const client = userClient(value);
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user) {
      throw new AuthError('Your session has expired. Open ViralRadar and sign in again.');
    }
    // No allowlist check here on purpose: this client is the user, so every
    // policy applies to it, including the allowlist gate.
    return { userId: data.user.id, client, via: 'jwt' };
  }

  // ---- import token ----
  const service = serviceClient();
  const tokenHash = await hashToken(value);

  const { data: token, error } = await service
    .from('import_tokens')
    .select('id, user_id')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) throw lookupFailed(error);
  if (!token) {
    // Same wording whether the token never existed or has been revoked.
    throw new AuthError('That import token is not valid. Make a new one in Settings.');
  }

  // The service role ignores Row Level Security, so the allowlist gate that
  // every policy carries would be skipped. Check it here instead.
  const { data: allowed, error: allowedError } = await service
    .from('allowed_users')
    .select('user_id')
    .eq('user_id', token.user_id)
    .maybeSingle();

  if (allowedError) throw lookupFailed(allowedError);
  if (!allowed) {
    throw new AuthError('That import token belongs to an account that is not allowed to use ViralRadar.', 403);
  }

  // Best effort: knowing when a token was last used is how you spot one you
  // forgot about. Never worth failing an import over.
  service.from('import_tokens').update({ last_used_at: new Date().toISOString() }).eq('id', token.id)
    .then(({ error: e }) => { if (e) console.warn(`[vr-import] could not update last_used_at: ${e.message}`); });

  return { userId: token.user_id, client: service, via: 'token' };
}

/**
 * The storage port shared/import-core.mjs expects.
 *
 * user_id is written explicitly on every row, for both kinds of caller. For a
 * token it is the only thing making the row belong to anyone; for a JWT the
 * policy checks it matches, so a mismatch is refused rather than silently
 * accepted.
 */
export function storeFor(caller: Caller) {
  return {
    userId: caller.userId,

    async findExisting(table: string, ids: string[]): Promise<string[]> {
      if (!ids.length) return [];
      const { data, error } = await caller.client
        .from(table)
        .select('id')
        .eq('user_id', caller.userId)
        .in('id', ids);
      if (error) throw new Error(`Could not read your existing ${table}: ${error.message}`);
      return (data ?? []).map((r: { id: string }) => r.id);
    },

    async upsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
      if (!rows.length) return;
      const { error } = await caller.client.from(table).upsert(rows, { onConflict: 'user_id,id' });
      if (error) throw new Error(`Could not save your ${table}: ${error.message}`);
    },

    // ---- filing a research pack or a note into a project folder ----
    // See shared/import-projects.mjs for the rule these back.
    //
    // Every query below filters by user_id explicitly, and every insert sets
    // it explicitly, the same discipline findExisting()/upsert() use above:
    // the vr_ token path runs with the service role, which bypasses RLS, so
    // "yours" has to be said in the query rather than assumed from it.

    async findProject(id: string) {
      const { data, error } = await caller.client.from('projects').select('*')
        .eq('id', id).eq('user_id', caller.userId).maybeSingle();
      if (error) throw new Error(`Could not look up that project: ${error.message}`);
      return data ?? null;
    },

    async findProjectByTitle(title: string) {
      // ilike is case-insensitive but treats % and _ as wildcards; a title is
      // plain text, not a search pattern, so both are escaped before matching.
      const { data, error } = await caller.client.from('projects').select('*')
        .eq('user_id', caller.userId).ilike('title', escapeLikePattern(title)).limit(1);
      if (error) throw new Error(`Could not look up that project: ${error.message}`);
      return data?.[0] ?? null;
    },

    async findProjectByScriptId(scriptId: string) {
      const { data, error } = await caller.client.from('projects').select('*')
        .eq('user_id', caller.userId).eq('script_id', scriptId).limit(1);
      if (error) throw new Error(`Could not look up that script's project: ${error.message}`);
      return data?.[0] ?? null;
    },

    async createProject({ title, scriptId }: { title: string; scriptId?: string }) {
      const { data, error } = await caller.client.from('projects')
        .insert({ user_id: caller.userId, title, script_id: scriptId ?? null }).select('*');
      if (error) throw new Error(`Could not create a project folder: ${error.message}`);
      return data?.[0];
    },

    // Same find-or-create-once race as the browser's data.projects.inbox():
    // a partial unique index on is_inbox means a second insert is refused
    // rather than making a second Inbox, so the loser just reads the winner.
    async inbox() {
      const existing = await caller.client.from('projects').select('*')
        .eq('user_id', caller.userId).eq('is_inbox', true).limit(1);
      if (existing.error) throw new Error(`Could not find your Inbox: ${existing.error.message}`);
      if (existing.data?.length) return existing.data[0];
      const made = await caller.client.from('projects')
        .insert({ user_id: caller.userId, title: INBOX_TITLE, is_inbox: true }).select('*');
      if (made.error) {
        if (!/duplicate|unique|23505/i.test(made.error.message)) {
          throw new Error(`Could not create your Inbox: ${made.error.message}`);
        }
        const after = await caller.client.from('projects').select('*')
          .eq('user_id', caller.userId).eq('is_inbox', true).limit(1);
        if (after.error || !after.data?.length) throw new Error('Could not find your Inbox.');
        return after.data[0];
      }
      return made.data?.[0];
    },

    async findExistingItems(externalIds: string[]): Promise<string[]> {
      if (!externalIds.length) return [];
      const { data, error } = await caller.client.from('project_items')
        .select('external_id').eq('user_id', caller.userId).in('external_id', externalIds);
      if (error) throw new Error(`Could not read your existing project items: ${error.message}`);
      return (data ?? []).map((r: { external_id: string }) => r.external_id);
    },

    async upsertItems(rows: Record<string, unknown>[]): Promise<void> {
      if (!rows.length) return;
      const { error } = await caller.client.from('project_items').upsert(rows, { onConflict: 'user_id,external_id' });
      if (error) throw new Error(`Could not save that to a project folder: ${error.message}`);
    },
  };
}
