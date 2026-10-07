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

export const SCHEMA = 'viralradar';

export class AuthError extends Error {
  status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.status = status;
  }
}

export type Caller = {
  userId: string;
  client: SupabaseClient;
  /** How they got in. Worth logging; never worth trusting from the request. */
  via: 'jwt' | 'token';
};

const url = () => Deno.env.get('SUPABASE_URL') ?? '';
const anonKey = () => Deno.env.get('SUPABASE_ANON_KEY') ?? '';
const serviceKey = () => Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

const options = { db: { schema: SCHEMA }, auth: { persistSession: false, autoRefreshToken: false } };

/** A client that is the signed-in user: RLS applies to everything it does. */
function userClient(jwt: string): SupabaseClient {
  return createClient(url(), anonKey(), {
    ...options,
    global: { headers: { Authorization: `Bearer ${jwt}` } },
  });
}

/** A client that bypasses RLS. Only ever used behind a verified token. */
function serviceClient(): SupabaseClient {
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

  if (error) throw new AuthError('Could not check that import token. Try again in a moment.', 503);
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

  if (allowedError) throw new AuthError('Could not check that import token. Try again in a moment.', 503);
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
  };
}
