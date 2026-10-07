// Everything the app reads or writes, in one place.
//
// In the cloud version there is no server of our own: the browser talks to
// Supabase directly with the publishable key, and Row Level Security is what
// keeps one person's rows away from another's. So every query here is written
// as if it were the only thing standing between you and someone else's data —
// knowing full well that it is not, and that the policies are.
//
// createData(client) takes the Supabase client rather than making one, so the
// whole layer can be driven by a fake client in the tests. The real client is
// built at the bottom of this file from the values the build injected.

import { resultStats } from './shared/stats.mjs';
import { IDEA_STATUS, SCRIPT_STAGES } from './shared/defaults.mjs';
import { istDay } from './shared/time.mjs';

export const TABLES = { ideas: 'ideas', scripts: 'scripts', results: 'results', trends: 'trends' };
export const LIVE_TABLES = ['ideas', 'scripts', 'results'];

/** Turn a Supabase error into something worth showing a person. */
export function readable(error, doing) {
  if (!error) return null;
  const message = error.message || String(error);
  if (/Failed to fetch|NetworkError|network/i.test(message)) {
    return 'No internet connection. Your changes are not saved.';
  }
  if (/JWT|expired|not authenticated/i.test(message)) {
    return 'Your session has expired. Please sign in again.';
  }
  if (/permission denied|row-level security|42501/i.test(message)) {
    return 'That account is not allowed to use ViralRadar.';
  }
  // PostgREST says "Invalid schema: viralradar" when the schema is not in the
  // Data API's exposed list. Nothing in the app can work until it is, so say
  // exactly what to do rather than repeating the database's wording.
  if (/schema must be one of|PGRST106|invalid schema/i.test(message)) {
    return 'ViralRadar is not switched on in Supabase yet. Add "viralradar" under '
      + 'Project Settings → API → Data API → Exposed schemas, then reload this page.';
  }
  return `Could not ${doing}: ${message}`;
}

export function createData(client) {
  /** Run a query and turn a failure into a readable error. */
  const run = async (promise, doing) => {
    const { data, error } = await promise;
    if (error) throw new Error(readable(error, doing));
    return data;
  };

  // ---------- who is signed in ----------

  const auth = {
    async session() {
      const { data } = await client.auth.getSession();
      return data?.session ?? null;
    },
    async user() {
      const session = await auth.session();
      return session?.user ?? null;
    },
    /**
     * Sign in with an email and password.
     *
     * The password is never in this code or in the repository: it lives hashed
     * in Supabase, set from the dashboard. Nothing in the browser could hold a
     * password safely — the files are served to anyone who asks for them.
     */
    async signInWithPassword(email, password) {
      const address = String(email || '').trim();
      if (!address) throw new Error('Enter your email address.');
      if (!password) throw new Error('Enter your password.');

      const { data: result, error } = await client.auth.signInWithPassword({ email: address, password });
      if (error) {
        const message = error.message || '';
        // Deliberately the same wording for a wrong address and a wrong
        // password, so neither tells you which accounts exist.
        if (/invalid login credentials/i.test(message)) throw new Error('Wrong email or password.');
        if (/email not confirmed/i.test(message)) {
          throw new Error('That account is not confirmed yet. Confirm it in Supabase, under Authentication → Users.');
        }
        if (/rate limit|too many/i.test(message)) throw new Error('Too many attempts. Wait a minute and try again.');
        throw new Error(readable(error, 'sign in'));
      }
      return result?.session ?? null;
    },

    /** Send the magic link. The address it returns to must be allow-listed in Supabase. */
    async signIn(email, redirectTo) {
      const address = String(email || '').trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error('That does not look like an email address.');
      const { error } = await client.auth.signInWithOtp({
        email: address,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: false },
      });
      if (error) {
        if (/signups not allowed|not allowed for otp/i.test(error.message)) {
          throw new Error('That email address does not have an account here.');
        }
        if (/rate limit|too many/i.test(error.message)) {
          throw new Error('Too many sign-in emails. Wait a minute and try again.');
        }
        throw new Error(readable(error, 'send the sign-in link'));
      }
      return true;
    },
    async signOut() {
      await client.auth.signOut();
    },
    onChange(callback) {
      const { data } = client.auth.onAuthStateChange((event, session) => callback(session, event));
      return () => data?.subscription?.unsubscribe();
    },
  };

  // ---------- settings ----------
  //
  // There is no trigger creating this row, on purpose: this Supabase project is
  // shared with another app and a trigger on auth.users would fire for its
  // signups too. So the row is created on first use. Every column has a
  // default, which is what makes one statement enough.

  const settings = {
    async get(userId) {
      const rows = await run(client.from('settings').select('*').limit(1), 'read your settings');
      if (rows && rows.length) return rows[0];
      await run(
        client.from('settings').upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true }),
        'create your settings',
      );
      const created = await run(client.from('settings').select('*').limit(1), 'read your settings');
      return (created && created[0]) || null;
    },
    async update(userId, patch) {
      const rows = await run(
        client.from('settings').update(patch).eq('user_id', userId).select('*'),
        'save your settings',
      );
      return rows && rows[0];
    },
  };

  // ---------- ideas ----------

  const ideas = {
    list: () => run(client.from('ideas').select('*').order('origin_at', { ascending: false }), 'load your ideas'),
    async setStatus(id, status) {
      if (!IDEA_STATUS.includes(status)) throw new Error(`Unknown status: ${status}`);
      const rows = await run(client.from('ideas').update({ status }).eq('id', id).select('id, status'), 'update that idea');
      if (!rows || !rows.length) throw new Error('That idea is no longer there.');
      return rows[0];
    },
    remove: (id) => run(client.from('ideas').delete().eq('id', id), 'delete that idea'),
  };

  // ---------- scripts ----------

  const scripts = {
    list: () => run(
      client.from('scripts').select('id, topic, title, yt_title, thumbnail_text, stage, origin_at, updated_at')
        .order('origin_at', { ascending: false }),
      'load your scripts',
    ),
    async get(id) {
      const rows = await run(client.from('scripts').select('*').eq('id', id).limit(1), 'open that script');
      if (!rows || !rows.length) throw new Error('Script not found.');
      return rows[0];
    },
    async setStage(id, stage) {
      if (!SCRIPT_STAGES.includes(stage)) throw new Error(`Unknown stage: ${stage}`);
      const rows = await run(client.from('scripts').update({ stage }).eq('id', id).select('id, stage'), 'move that script');
      if (!rows || !rows.length) throw new Error('That script is no longer there.');
      return rows[0];
    },
    remove: (id) => run(client.from('scripts').delete().eq('id', id), 'delete that script'),
  };

  // ---------- results ----------

  const results = {
    list: () => run(
      client.from('results').select('*').order('posted_on', { ascending: false, nullsFirst: false })
        .order('origin_at', { ascending: false }),
      'load your results',
    ),
    /** The Results screen's numbers, worked out here rather than on a server. */
    async stats(today = istDay()) {
      return resultStats(await results.list(), today);
    },
    remove: (id) => run(client.from('results').delete().eq('id', id), 'delete that result'),
  };

  // ---------- trends ----------

  const trends = {
    async latestDay() {
      const rows = await run(
        client.from('trends').select('fetched_on').order('fetched_on', { ascending: false }).limit(1),
        'check for trends',
      );
      return rows && rows.length ? rows[0].fetched_on : null;
    },
    async list(source) {
      const day = await trends.latestDay();
      if (!day) return { day: null, trends: [] };
      let query = client.from('trends').select('*').eq('fetched_on', day);
      if (source) query = query.eq('source', source);
      const rows = await run(query.order('score', { ascending: false }).limit(300), 'load the radar');
      return { day, trends: rows || [] };
    },
    refresh: () => callFunction('vr-refresh-trends', {}, 'refresh the radar'),
  };

  // ---------- usage (the YouTube quota and AI call counts) ----------

  const usage = {
    async today(day = istDay()) {
      const rows = await run(client.from('usage').select('*').eq('date', day), 'read today\'s usage');
      const byProvider = {};
      for (const row of rows || []) byProvider[row.provider] = row;
      return byProvider;
    },
  };

  // ---------- import tokens ----------

  const tokens = {
    list: () => run(
      client.from('import_tokens').select('id, label, last_used_at, created_at').order('created_at', { ascending: false }),
      'load your import tokens',
    ),
    /** The plain token is returned once and never stored; only its hash is saved. */
    async create(userId, label, token, tokenHash) {
      await run(
        client.from('import_tokens').insert({ user_id: userId, label: label || null, token_hash: tokenHash }),
        'create an import token',
      );
      return token;
    },
    revoke: (id) => run(client.from('import_tokens').delete().eq('id', id), 'revoke that token'),
  };

  // ---------- Edge Functions ----------

  async function callFunction(name, body, doing) {
    const { data, error } = await client.functions.invoke(name, { body });
    if (error) {
      // The function's own message is the useful one, when there is one.
      const detail = await readFunctionError(error);
      if (detail) throw new Error(detail);

      const message = error.message || '';
      // A function that was never deployed cannot answer, and the browser
      // cannot see why: the gateway's 404 carries no CORS headers, so this
      // arrives as a bare "failed to send a request". Say what is missing.
      if (/failed to send a request|FunctionsFetchError|NetworkError|Failed to fetch/i.test(message)) {
        throw new Error(`This needs the "${name}" function, which is not deployed yet.`
          + ` Deploy it with: npx supabase functions deploy ${name} --use-api`);
      }
      if (/relay|timeout|timed out/i.test(message)) {
        throw new Error(`The "${name}" function took too long to answer. Try again.`);
      }
      throw new Error(message || `Could not ${doing}.`);
    }
    return data;
  }

  /** Edge Functions report failures with a body; dig the message out of it. */
  async function readFunctionError(error) {
    try {
      const body = await error.context?.json?.();
      if (body && typeof body.error === 'string') return body.error;
    } catch { /* not JSON, or no body */ }
    return null;
  }

  const imports = {
    /** Send a Shorts Studio export. The text is passed through untouched so the
     *  function produces exactly the message the local app would. */
    send: (text) => callFunction('vr-import', text, 'import that file'),
    /** What arrived most recently, across all three kinds. */
    async recent(limit = 20) {
      const [i, s, r] = await Promise.all([
        run(client.from('ideas').select('id, title, created_at').order('created_at', { ascending: false }).limit(limit), 'load recent imports'),
        run(client.from('scripts').select('id, title, yt_title, created_at').order('created_at', { ascending: false }).limit(limit), 'load recent imports'),
        run(client.from('results').select('id, title, created_at').order('created_at', { ascending: false }).limit(limit), 'load recent imports'),
      ]);
      return [
        ...(i || []).map((x) => ({ kind: 'idea', ...x })),
        ...(s || []).map((x) => ({ kind: 'script', ...x })),
        ...(r || []).map((x) => ({ kind: 'result', ...x })),
      ].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
    },
  };

  const ai = {
    generate: (options) => callFunction('vr-generate', options, 'write that'),
  };

  // ---------- live updates ----------
  //
  // An import on the laptop should show up on the phone without a refresh.
  // The policies apply to Realtime too, so a subscriber only ever receives
  // their own rows.

  function live(onChange) {
    const channel = client.channel('viralradar-changes');
    for (const table of LIVE_TABLES) {
      channel.on('postgres_changes', { event: '*', schema: 'viralradar', table }, (payload) => {
        onChange({ table, event: payload.eventType, row: payload.new || payload.old });
      });
    }
    channel.subscribe();
    return () => client.removeChannel(channel);
  }

  // ---------- backup ----------

  const backup = {
    async download() {
      const [i, s, r, t, st, u] = await Promise.all([
        run(client.from('ideas').select('*'), 'export your ideas'),
        run(client.from('scripts').select('*'), 'export your scripts'),
        run(client.from('results').select('*'), 'export your results'),
        run(client.from('trends').select('*'), 'export your trends'),
        run(client.from('settings').select('*'), 'export your settings'),
        run(client.from('usage').select('*'), 'export your usage'),
      ]);
      return {
        app: 'viralradar',
        backup_version: 2,
        exported_at: new Date().toISOString(),
        tables: { ideas: i, scripts: s, results: r, trends: t, settings: st, usage: u },
      };
    },
    /** Restore adds and updates; it never deletes, so a restore cannot lose work. */
    async restore(file, userId) {
      if (!file || file.app !== 'viralradar' || !file.tables) {
        throw new Error('That is not a ViralRadar backup file (expected "app": "viralradar").');
      }
      const counts = {};
      for (const table of ['ideas', 'scripts', 'results', 'trends', 'settings', 'usage']) {
        const rows = file.tables[table];
        if (!Array.isArray(rows) || !rows.length) { counts[table] = 0; continue; }
        // Every row is re-owned by whoever is restoring: a backup from another
        // account must not try to write rows that are not theirs.
        const owned = rows.map((row) => ({ ...row, user_id: userId }));
        const conflict = table === 'trends' ? 'user_id,url' : table === 'settings' ? 'user_id'
          : table === 'usage' ? 'user_id,date,provider' : 'user_id,id';
        await run(client.from(table).upsert(owned, { onConflict: conflict }), `restore your ${table}`);
        counts[table] = owned.length;
      }
      return counts;
    },
  };

  return { auth, settings, ideas, scripts, results, trends, usage, tokens, imports, ai, backup, live, callFunction };
}

// ---------- the real client ----------

function createClient() {
  const env = (typeof window !== 'undefined' && window.__VR_ENV) || null;
  if (!env || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    throw new Error('This build has no Supabase configuration. Set SUPABASE_URL and SUPABASE_ANON_KEY and deploy again.');
  }
  if (!window.supabase || !window.supabase.createClient) {
    throw new Error('The Supabase library did not load. Try a hard refresh.');
  }
  return window.supabase.createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    db: { schema: 'viralradar' },
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
}

// Only built in a browser; importing this file in Node gives you createData only.
export const data = typeof window !== 'undefined' && window.__VR_ENV ? createData(createClient()) : null;
if (typeof window !== 'undefined') window.VR = data;
