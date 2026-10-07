// The Row Level Security isolation plan: every assertion, as data.
//
// The plan is kept separate from the database runner so it can be reasoned
// about (and unit-tested) without a database, and so every assertion is run
// the same way: one short transaction that becomes a real signed-in user
// before touching anything.
//
// "as" values:
//   'A' / 'B'  -> SET LOCAL ROLE authenticated, with request.jwt.claims for that
//                 user. Both are on the ViralRadar allowlist.
//   'C'        -> the same, but NOT on the allowlist: a real signed-in account
//                 that belongs to the other app sharing this Supabase project.
//                 C must be able to do nothing at all.
//   'anon'     -> SET LOCAL ROLE anon (a browser with no session)
//   'noclaims' -> SET LOCAL ROLE authenticated with no claims at all, so auth.uid() is null
//
// "expect" is one of:
//   { rowCount: n }     exactly n rows came back (0 means "RLS hid everything")
//   { minRows: n }      at least n rows came back
//   { rows: [...] }     the rows came back exactly like this
//   { errorCode: c }    the statement was rejected with that SQLSTATE
//   { errorCodeIn: [] } rejected with any one of these SQLSTATEs
//                       42501 = row level security violation, or no privilege
//                       23502 = not-null violation (no owner on the row)
//
// "sim" names what the assertion means, independent of its SQL, so the plan can
// be checked offline against a model of how RLS behaves (see test/rls-plan.test.js).

// Every table, with enough shape to insert a row and to find one again.
// `key` is the column that identifies a row within one user.
export const TABLES = [
  {
    table: 'ideas',
    key: 'id',
    fixture: { A: 'idea-a', B: 'idea-b' },
    fresh: 'idea-fresh',
    insert: (key) => ({ cols: 'id, title, source', vals: `${key}, 'fresh row', 'manual'` }),
    update: "set title = 'changed by the wrong user'",
    nullOwner: true,
  },
  {
    table: 'scripts',
    key: 'id',
    fixture: { A: 'script-a', B: 'script-b' },
    fresh: 'script-fresh',
    insert: (key) => ({ cols: 'id, title, source', vals: `${key}, 'fresh row', 'manual'` }),
    update: "set stage = 'posted'",
    nullOwner: true,
  },
  {
    table: 'results',
    key: 'id',
    fixture: { A: 'result-a', B: 'result-b' },
    fresh: 'result-fresh',
    insert: (key) => ({ cols: 'id, title, views, source', vals: `${key}, 'fresh row', 1, 'manual'` }),
    update: 'set views = 999999',
    nullOwner: true,
  },
  {
    table: 'trends',
    key: 'url',
    fixture: { A: 'https://a.example/trend-1', B: 'https://b.example/trend-1' },
    fresh: 'https://fresh.example/trend-1',
    insert: (key) => ({ cols: 'url, title, source', vals: `${key}, 'fresh trend', 'youtube'` }),
    update: 'set score = 999',
    nullOwner: false,
  },
  {
    table: 'usage',
    key: 'provider',
    fixture: { A: 'youtube', B: 'youtube' },
    fresh: 'openrouter',
    insert: (key) => ({ cols: 'provider, units, requests', vals: `${key}, 1, 1` }),
    update: 'set units = 999999',
    nullOwner: false,
  },
  {
    table: 'import_tokens',
    key: 'token_hash',
    fixture: { A: 'hash-of-token-a', B: 'hash-of-token-b' },
    fresh: 'hash-of-a-fresh-token',
    insert: (key) => ({ cols: 'token_hash, label', vals: `${key}, 'fresh token'` }),
    update: "set label = 'relabelled by the wrong user'",
    nullOwner: true,
  },
];

const OTHER = { A: 'B', B: 'A' };

/**
 * Build the full list of assertions.
 * @param {{A: string, B: string}} ids  the two throwaway user uuids
 */
export function buildPlan({ A, B, C }) {
  const uid = { A, B, C };
  const plan = [];
  const add = (c) => plan.push(c);

  for (const t of TABLES) {
    const { table, key } = t;

    for (const me of ['A', 'B']) {
      const them = OTHER[me];

      // ---- SELECT, both directions ----
      add({
        name: `${table}: ${me} can see their own rows`,
        as: me, table, sim: 'select-own', owner: me,
        sql: `select ${key} from viralradar.${table} where user_id = $1`,
        params: [uid[me]],
        expect: { minRows: 1 },
      });
      add({
        name: `${table}: ${me} cannot see ${them}'s rows`,
        as: me, table, sim: 'select-other', owner: them,
        sql: `select ${key} from viralradar.${table} where user_id = $1`,
        params: [uid[them]],
        expect: { rowCount: 0 },
      });
      // Asking for everything must still only return your own rows.
      add({
        name: `${table}: an unfiltered select by ${me} returns only ${me}'s rows`,
        as: me, table, sim: 'select-unfiltered', owner: them,
        sql: `select count(*)::int as n from viralradar.${table} where user_id <> $1`,
        params: [uid[me]],
        expect: { rows: [{ n: 0 }] },
      });

      // ---- UPDATE, both directions ----
      add({
        name: `${table}: ${me} cannot update ${them}'s rows`,
        as: me, table, sim: 'update-other', owner: them,
        sql: `update viralradar.${table} ${t.update} where user_id = $1 returning ${key}`,
        params: [uid[them]],
        expect: { rowCount: 0 },
      });
      add({
        name: `${table}: ${me} can update their own rows`,
        as: me, table, sim: 'update-own', owner: me,
        sql: `update viralradar.${table} ${t.update} where user_id = $1 and ${key} = $2 returning ${key}`,
        params: [uid[me], t.fixture[me]],
        expect: { rowCount: 1 },
      });
      // WITH CHECK: you may not hand one of your rows to someone else.
      add({
        name: `${table}: ${me} cannot give their own row away to ${them}`,
        as: me, table, sim: 'update-give-away', owner: me,
        sql: `update viralradar.${table} set user_id = $1 where user_id = $2 and ${key} = $3 returning ${key}`,
        params: [uid[them], uid[me], t.fixture[me]],
        expect: { errorCode: '42501' },
      });

      // ---- DELETE, both directions ----
      add({
        name: `${table}: ${me} cannot delete ${them}'s rows`,
        as: me, table, sim: 'delete-other', owner: them,
        sql: `delete from viralradar.${table} where user_id = $1 returning ${key}`,
        params: [uid[them]],
        expect: { rowCount: 0 },
      });
      add({
        name: `${table}: ${me} can delete their own rows`,
        as: me, table, sim: 'delete-own', owner: me,
        sql: `delete from viralradar.${table} where user_id = $1 and ${key} = $2 returning ${key}`,
        params: [uid[me], t.fixture[me]],
        expect: { rowCount: 1 },
      });

      // ---- INSERT, both directions ----
      const fresh = t.insert('$2');
      add({
        name: `${table}: ${me} cannot insert a row owned by ${them}`,
        as: me, table, sim: 'insert-other', owner: them,
        sql: `insert into viralradar.${table} (user_id, ${fresh.cols}) values ($1, ${fresh.vals}) returning ${key}`,
        params: [uid[them], t.fresh],
        expect: { errorCode: '42501' },
      });
      add({
        name: `${table}: ${me} can insert their own row`,
        as: me, table, sim: 'insert-own', owner: me,
        sql: `insert into viralradar.${table} (user_id, ${fresh.cols}) values ($1, ${fresh.vals}) returning ${key}`,
        params: [uid[me], t.fresh],
        expect: { rowCount: 1 },
      });
      // No user_id given: the auth.uid() default fills it in from the JWT.
      const defaulted = t.insert('$1');
      add({
        name: `${table}: a row inserted by ${me} without a user_id belongs to ${me}`,
        as: me, table, sim: 'insert-default-owner', owner: me,
        sql: `insert into viralradar.${table} (${defaulted.cols}) values (${defaulted.vals}) returning user_id`,
        params: [t.fresh],
        expect: { rows: [{ user_id: uid[me] }] },
      });
    }

    // ---- rows can never be ownerless ----
    // Two things reject these: the NOT NULL column and the RLS check, and
    // Postgres is free to report either first, so both codes are accepted.
    // What matters is that no ownerless row can be created.
    if (t.nullOwner) {
      const fresh = t.insert('$1');
      add({
        name: `${table}: a row with no owner is rejected`,
        as: 'A', table, sim: 'insert-null-owner', owner: null,
        sql: `insert into viralradar.${table} (user_id, ${fresh.cols}) values (null, ${fresh.vals}) returning ${key}`,
        params: [t.fresh],
        expect: { errorCodeIn: ['23502', '42501'] },
      });
      add({
        name: `${table}: an insert with no session is rejected, because auth.uid() is null`,
        as: 'noclaims', table, sim: 'insert-no-session', owner: null,
        sql: `insert into viralradar.${table} (${fresh.cols}) values (${fresh.vals}) returning ${key}`,
        params: [t.fresh],
        expect: { errorCodeIn: ['23502', '42501'] },
      });
    }

    // ---- a browser with no session sees nothing at all ----
    add({
      name: `${table}: anon (not signed in) has no access`,
      as: 'anon', table, sim: 'anon-denied', owner: null,
      sql: `select ${key} from viralradar.${table}`,
      params: [],
      expect: { errorCode: '42501' },
    });

    // ---- signed in, but not a ViralRadar user ----
    // This is the case the other app in this project creates: a perfectly
    // valid account that has nothing to do with ViralRadar. Being signed in
    // must not be enough.
    add({
      name: `${table}: C is signed in but not on the allowlist, and sees nothing`,
      as: 'C', table, sim: 'not-allowed-select', owner: null,
      sql: `select ${key} from viralradar.${table}`,
      params: [],
      expect: { rowCount: 0 },
    });
    const own = t.insert('$2');
    add({
      name: `${table}: C cannot create anything, not even a row of its own`,
      as: 'C', table, sim: 'not-allowed-insert', owner: 'C',
      sql: `insert into viralradar.${table} (user_id, ${own.cols}) values ($1, ${own.vals}) returning ${key}`,
      params: [uid.C, t.fresh],
      expect: { errorCode: '42501' },
    });
  }

  // ---- settings: one row per user, created on first use ----
  // There are no insert assertions here on purpose: the signup trigger already
  // created each user's only settings row, so an insert would hit the primary
  // key before RLS and the result would be ambiguous.
  for (const me of ['A', 'B']) {
    const them = OTHER[me];
    add({
      name: `settings: ${me} has exactly one settings row, created on first use`,
      as: me, table: 'settings', sim: 'settings-own-count', owner: me,
      sql: 'select count(*)::int as n from viralradar.settings',
      params: [],
      expect: { rows: [{ n: 1 }] },
    });
    add({
      name: `settings: ${me} cannot see ${them}'s settings`,
      as: me, table: 'settings', sim: 'select-other', owner: them,
      sql: 'select user_id from viralradar.settings where user_id = $1',
      params: [uid[them]],
      expect: { rowCount: 0 },
    });
    add({
      name: `settings: ${me} cannot change ${them}'s settings`,
      as: me, table: 'settings', sim: 'update-other', owner: them,
      sql: "update viralradar.settings set language = 'changed by the wrong user' where user_id = $1 returning user_id",
      params: [uid[them]],
      expect: { rowCount: 0 },
    });
    add({
      name: `settings: ${me} cannot delete ${them}'s settings`,
      as: me, table: 'settings', sim: 'delete-other', owner: them,
      sql: 'delete from viralradar.settings where user_id = $1 returning user_id',
      params: [uid[them]],
      expect: { rowCount: 0 },
    });
    add({
      name: `settings: ${me} can change their own settings`,
      as: me, table: 'settings', sim: 'update-own', owner: me,
      sql: "update viralradar.settings set language = 'Hindi' where user_id = $1 returning language",
      params: [uid[me]],
      expect: { rowCount: 1 },
    });
  }
  add({
    name: 'settings: anon (not signed in) has no access',
    as: 'anon', table: 'settings', sim: 'anon-denied', owner: null,
    sql: 'select user_id from viralradar.settings',
    params: [],
    expect: { errorCode: '42501' },
  });
  add({
    name: 'settings: C is signed in but not on the allowlist, and sees nothing',
    as: 'C', table: 'settings', sim: 'not-allowed-select', owner: null,
    sql: 'select user_id from viralradar.settings',
    params: [],
    expect: { rowCount: 0 },
  });
  add({
    name: 'settings: C cannot create a settings row for itself',
    as: 'C', table: 'settings', sim: 'not-allowed-insert', owner: 'C',
    sql: 'insert into viralradar.settings (user_id) values ($1) returning user_id',
    params: [C],
    expect: { errorCode: '42501' },
  });

  // ---- the allowlist itself is not reachable from a session ----
  // Even an allowed user must not be able to read it or add anyone to it,
  // or the gate would be self-service.
  for (const me of ['A', 'C']) {
    add({
      name: `allowed_users: ${me} cannot read the allowlist`,
      as: me, table: 'allowed_users', sim: 'allowlist-denied', owner: null,
      sql: 'select user_id from viralradar.allowed_users',
      params: [],
      expect: { errorCode: '42501' },
    });
    add({
      name: `allowed_users: ${me} cannot add anyone to the allowlist`,
      as: me, table: 'allowed_users', sim: 'allowlist-denied', owner: null,
      sql: 'insert into viralradar.allowed_users (user_id, note) values ($1, $2) returning user_id',
      params: [uid[me], 'let me in'],
      expect: { errorCode: '42501' },
    });
  }

  return plan;
}

/**
 * Proofs that the plan above is actually exercising the policies, rather than
 * passing because the connection cannot see anything at all.
 *
 * Each proof breaks one policy inside a transaction, re-runs one assertion and
 * demands that it now FAILS, then rolls the transaction back so the policy is
 * restored. A proof that does not fail means the harness is not testing what
 * it claims to.
 */
export function buildProofs({ A, B, C }) {
  return [
    {
      name: 'dropping ideas_select_own must break "A can see their own rows"',
      breakSql: 'drop policy ideas_select_own on viralradar.ideas',
      check: {
        name: 'ideas: A can see their own rows',
        as: 'A', table: 'ideas', sim: 'select-own', owner: 'A',
        sql: 'select id from viralradar.ideas where user_id = $1',
        params: [A],
        expect: { minRows: 1 },
      },
      why: 'with no select policy, even the owner is denied, so the assertion must fail',
      modelLeak: 'no-select',
    },
    {
      name: 'widening ideas_select_own to using(true) must break "B cannot see A\'s rows"',
      breakSql: 'alter policy ideas_select_own on viralradar.ideas using (true)',
      check: {
        name: "ideas: B cannot see A's rows",
        as: 'B', table: 'ideas', sim: 'select-other', owner: 'A',
        sql: 'select id from viralradar.ideas where user_id = $1',
        params: [A],
        expect: { rowCount: 0 },
      },
      why: "a policy that allows every row leaks A's data to B, so the assertion must fail",
      modelLeak: 'select',
    },
    {
      name: 'widening ideas_insert_own to with check(true) must break "B cannot insert a row owned by A"',
      breakSql: 'alter policy ideas_insert_own on viralradar.ideas with check (true)',
      check: {
        name: 'ideas: B cannot insert a row owned by A',
        as: 'B', table: 'ideas', sim: 'insert-other', owner: 'A',
        sql: "insert into viralradar.ideas (user_id, id, title, source) values ($1, 'proof-row', 'planted', 'manual') returning id",
        params: [A],
        expect: { errorCode: '42501' },
      },
      why: "with no insert check, B can plant rows in A's account, so the assertion must fail",
      modelLeak: 'insert-check',
    },
    {
      name: 'removing the allowlist gate must break "C cannot create anything"',
      breakSql: 'alter policy ideas_insert_own on viralradar.ideas with check (user_id = auth.uid())',
      check: {
        name: 'ideas: C cannot create anything, not even a row of its own',
        as: 'C', table: 'ideas', sim: 'not-allowed-insert', owner: 'C',
        sql: "insert into viralradar.ideas (user_id, id, title, source) values ($1, 'proof-row-c', 'planted by C', 'manual') returning id",
        params: [C],
        expect: { errorCode: '42501' },
      },
      why: 'without the is_allowed() gate, anyone with an account in this shared project becomes a ViralRadar user, so the assertion must fail',
      modelLeak: 'no-allowlist-gate',
    },
  ];
}

/** Did a statement's outcome match what the assertion expected? */
export function matches(expect, outcome) {
  if (expect.errorCodeIn) {
    if (!outcome.errorCode) return { ok: false, detail: `expected one of ${expect.errorCodeIn.join('/')}, but the statement succeeded with ${outcome.rowCount} row(s)` };
    return expect.errorCodeIn.includes(outcome.errorCode)
      ? { ok: true, detail: `rejected with ${outcome.errorCode}, as it must be` }
      : { ok: false, detail: `expected one of ${expect.errorCodeIn.join('/')}, got ${outcome.errorCode} (${outcome.errorMessage || ''})`.trim() };
  }
  if (expect.errorCode) {
    if (!outcome.errorCode) return { ok: false, detail: `expected error ${expect.errorCode}, but the statement succeeded with ${outcome.rowCount} row(s)` };
    if (outcome.errorCode !== expect.errorCode) return { ok: false, detail: `expected error ${expect.errorCode}, got ${outcome.errorCode} (${outcome.errorMessage || ''})`.trim() };
    return { ok: true, detail: `rejected with ${outcome.errorCode}, as it must be` };
  }
  if (outcome.errorCode) {
    return { ok: false, detail: `unexpected error ${outcome.errorCode}: ${outcome.errorMessage || ''}`.trim() };
  }
  if (expect.rowCount !== undefined) {
    return outcome.rowCount === expect.rowCount
      ? { ok: true, detail: `${outcome.rowCount} row(s)` }
      : { ok: false, detail: `expected ${expect.rowCount} row(s), got ${outcome.rowCount}` };
  }
  if (expect.minRows !== undefined) {
    return outcome.rowCount >= expect.minRows
      ? { ok: true, detail: `${outcome.rowCount} row(s)` }
      : { ok: false, detail: `expected at least ${expect.minRows} row(s), got ${outcome.rowCount}` };
  }
  if (expect.rows) {
    const got = JSON.stringify(outcome.rows);
    const want = JSON.stringify(expect.rows);
    return got === want ? { ok: true, detail: got } : { ok: false, detail: `expected ${want}, got ${got}` };
  }
  return { ok: false, detail: 'this assertion has no expectation, which is a bug in the plan' };
}

/**
 * Run every assertion and report. `exec({ as, sql, params })` must resolve to
 * { rows, rowCount, errorCode, errorMessage } and must never throw.
 */
export async function runPlan(plan, exec, log = () => {}) {
  const results = [];
  for (const check of plan) {
    const outcome = await exec(check);
    const verdict = matches(check.expect, outcome);
    results.push({ name: check.name, ...verdict });
    log(`${verdict.ok ? 'PASS' : 'FAIL'}  ${check.name}${verdict.ok ? '' : `\n        ${verdict.detail}`}`);
  }
  return { results, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}

/**
 * Run the proofs. Each one needs `execBroken(proof)` to break the policy, run
 * the single assertion and roll everything back, resolving to the outcome.
 * A proof passes when the assertion FAILED while the policy was broken.
 */
export async function runProofs(proofs, execBroken, log = () => {}) {
  const results = [];
  for (const proof of proofs) {
    let outcome;
    try {
      outcome = await execBroken(proof);
    } catch (e) {
      results.push({ name: proof.name, ok: false, detail: `could not run the proof: ${e.message}` });
      log(`FAIL  ${proof.name}\n        could not run the proof: ${e.message}`);
      continue;
    }
    const verdict = matches(proof.check.expect, outcome);
    // The assertion is supposed to fail while the policy is broken.
    const ok = !verdict.ok;
    results.push({
      name: proof.name,
      ok,
      detail: ok
        ? `the assertion failed as it must (${verdict.detail})`
        : `the assertion still passed (${verdict.detail}), so it is not really testing the policy`,
    });
    log(`${ok ? 'PASS' : 'FAIL'}  ${proof.name}\n        ${ok ? proof.why : `the assertion still passed, so it proves nothing: ${verdict.detail}`}`);
  }
  return { results, passed: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
}
