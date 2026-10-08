// Offline checks on the Row Level Security test itself.
//
// This does NOT prove the database is secure — only `npm run test:rls` against
// the real Postgres can do that. What it proves is that the plan and the runner
// are sound: that every assertion covers what it claims to, that each
// expectation agrees with how RLS actually behaves, that a leak is reported as
// a failure rather than a pass, and that the "proof" mode really does demand a
// broken policy be caught.
//
// It works by running the plan against a model of RLS driven by each
// assertion's `sim` label, so a wrong expectation in the plan fails here.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildPlan, buildProofs, runPlan, runProofs, matches,
  TABLES, PROJECT_ID, BUCKET, A_USED, objectPath,
} = require('../scripts/rls-plan.mjs');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const uid = { A, B, C };

const rows = (r) => ({ rows: r, rowCount: r.length, errorCode: null, errorMessage: null });
const err = (code) => ({ rows: [], rowCount: 0, errorCode: code, errorMessage: 'simulated' });
// A statement with no RETURNING: rows affected, but nothing handed back.
const affected = (n) => ({ rows: [], rowCount: n, errorCode: null, errorMessage: null });

/**
 * A model of what Postgres does with these policies.
 * `leak` injects a specific mistake:
 *   'select'       a USING clause that returns every row
 *   'insert-check' a WITH CHECK that accepts every row
 *   'update-check' an UPDATE WITH CHECK that accepts every row
 *   'no-select'    the select policy is missing entirely (default deny)
 */
function simulate(check, leak = 'none') {
  const { sim, as, owner } = check;

  // ---- files in Storage ----
  // Routed first, and regardless of role: some of these run as the owner (a
  // gate evaluated against a row RLS would hide, and the policy read from the
  // catalogue), so the owner branch below must not swallow them.
  if (sim.startsWith('storage-') || sim.startsWith('cap-') || sim.startsWith('used-')) {
    return simulateStorage(check, leak);
  }

  // ---- configuration, read as the owner ----
  // Not an isolation check at all: the bucket's own settings, which no policy
  // governs. The 25 MB per-file limit lives there and nowhere else in SQL.
  if (as === 'owner') {
    if (sim === 'bucket-config') return rows([{ is_public: false, limit_bytes: 26214400 }]);
    // The signalling policies, read out of the catalogue. Configuration again:
    // this is the one check that says a migration was really applied.
    if (sim === 'signal-policies') {
      return rows([
        { policyname: 'vr_devices_read', cmd: 'SELECT' },
        { policyname: 'vr_devices_write', cmd: 'INSERT' },
      ]);
    }
    if (sim === 'signal-policy-text') return rows([{ n: 2 }]);
    throw new Error(`the model does not know the owner-role sim "${sim}"`);
  }

  // ---- the private signalling channel ----
  // The topic is the authorisation, so the answer depends only on whose
  // channel it is and whether they are on the allowlist — not on any policy
  // this model can break, which is why no leak changes these.
  if (sim.startsWith('signal-')) {
    if (sim === 'signal-own') return rows([{ allowed: as !== 'C' }]);
    return rows([{ allowed: false }]);
  }

  // ---- videos, recorded but never stored ----
  // These are constraints, not policies: a row that belongs to the right person
  // and still describes something impossible.
  if (sim === 'video-ref-own') return rows(as === 'C' ? [] : [{ id: 'fresh' }]);
  if (['video-ref-stored', 'video-ref-undigested', 'video-ref-nowhere'].includes(sim)) return err('23514');
  if (sim === 'video-ref-not-allowed') return err('42501');
  if (sim === 'video-totals-other') return rows(canSeeAs(as, 'B', leak) ? [{ videos: 1 }] : []);

  if (as === 'anon') return err('42501'); // privileges revoked from anon
  if (as === 'noclaims') return err('23502'); // auth.uid() is null, so the owner default is null

  // The allowlist is not readable or writable from any session.
  if (sim === 'allowlist-denied') return err('42501');

  // ---- constraints, not policies ----
  // These rows belong to the right person and are still wrong: an item in
  // someone else's folder, a path that points outside the folder it claims, a
  // file over 25 MB, a second Inbox. RLS has nothing to say about any of them,
  // so neither does the leak model — breaking a policy must not change these.
  if (sim === 'item-foreign-folder') return err('23503');
  if (sim === 'item-too-big' || sim === 'item-bad-path' || sim === 'item-bad-digest') return err('23514');
  if (sim === 'second-inbox') return err('23505');

  // ---- the 14-day cleanup ----
  if (sim === 'cleanup-due') {
    if (as === 'C') return rows([]);
    return rows(canSeeAs(as, 'A', leak)
      ? [{ storage_path: objectPath(uid.A, PROJECT_ID.A_POSTED_OLD, 'old.png') }] : []);
  }
  // Nothing is 60 days old, so this is empty however wide the policies are.
  if (sim === 'cleanup-retention') return rows([]);
  if (sim === 'cleanup-other') return rows(canSeeAs(as, 'B', leak) ? [{ storage_path: 'leaked' }] : []);
  if (sim === 'cleanup-not-allowed') return rows([]);

  // C is signed in but not on the allowlist, so is_allowed() is false and every
  // policy fails its second gate: reads return nothing, writes are refused.
  if (as === 'C') {
    if (leak === 'no-allowlist-gate') {
      // What it would look like if the gate were missing from the INSERT
      // policy: C can write. Reading back still needs the SELECT policy, which
      // keeps its own gate, so the RETURNING form stays refused. That is
      // exactly the trap the first run of this test fell into.
      if (sim === 'not-allowed-insert-silent') return affected(1);
      if (sim === 'not-allowed-insert') return err('42501');
      return rows([{ id: 'leaked' }]);
    }
    return sim === 'not-allowed-select' ? rows([]) : err('42501');
  }

  const me = as;
  const canSee = (rowOwner) => (leak === 'no-select' ? false : leak === 'select' ? true : rowOwner === me);

  switch (sim) {
    case 'select-own':
      return rows(canSee(owner) ? [{ id: 'fixture' }] : []);
    case 'select-other':
      return rows(canSee(owner) ? [{ id: 'fixture' }] : []);
    case 'select-unfiltered':
      return rows([{ n: canSee(owner) ? 1 : 0 }]);
    case 'settings-own-count':
      return rows([{ n: canSee(owner) ? 1 : 0 }]);
    case 'update-own':
    case 'delete-own':
      return rows(canSee(owner) ? [{ id: 'fixture' }] : []);
    case 'update-other':
    case 'delete-other':
      return rows(canSee(owner) ? [{ id: 'fixture' }] : []);
    case 'update-give-away':
      return leak === 'update-check' ? rows([{ id: 'fixture' }]) : err('42501');
    case 'insert-own':
      return rows([{ id: 'fresh' }]);
    case 'insert-other':
      // With RETURNING, the SELECT policy gates it too, so widening only the
      // INSERT policy is not enough to let this through.
      return err('42501');
    case 'insert-other-silent':
      return leak === 'insert-check' ? affected(1) : err('42501');
    case 'insert-default-owner':
      return rows([{ user_id: uid[me] }]);
    case 'insert-null-owner':
      return err('23502');
    default:
      throw new Error(`the model does not know the sim "${sim}"`);
  }
}

/** Can `me` see rows owned by `rowOwner`, given the injected mistake? */
function canSeeAs(me, rowOwner, leak) {
  if (me === 'C') return false; // signed in, but not on the allowlist
  if (leak === 'no-select') return false;
  if (leak === 'select') return true;
  return rowOwner === me;
}

/**
 * A model of what the storage policies do.
 *
 * storage.objects has no user_id: ownership is the first folder of the path.
 * The fixtures put A under the 300 MB cap and B over it, which is why B's
 * uploads are refused here and A's are not.
 */
function simulateStorage(check, leak) {
  const { sim, as, owner } = check;
  const overCap = { A: false, B: true, C: false };

  // Not revoked from anon, because the table is shared with the other app.
  // The policies are scoped to authenticated, so anon simply matches nothing
  // rather than being refused outright the way the viralradar tables are.
  if (as === 'anon') {
    return sim === 'storage-anon' || sim.startsWith('storage-select') ? rows([]) : err('42501');
  }

  const canSee = (rowOwner) => (leak === 'no-storage-select' ? false : leak === 'storage-select' ? true : canSeeAs(as, rowOwner, 'none'));
  // Only the INSERT policy carries the cap, so only uploading is affected.
  const canWrite = (rowOwner) => as !== 'C' && rowOwner === as;
  const canUpload = (rowOwner) => canWrite(rowOwner) && (leak === 'no-cap' || !overCap[as]);

  switch (sim) {
    case 'storage-select-own':
    case 'storage-select-other':
      return rows(canSee(owner) ? [{ name: 'fixture' }] : []);
    case 'storage-select-unfiltered':
      return rows([{ n: canSee(owner) ? 1 : 0 }]);
    case 'storage-update-other':
      // USING decides which rows an UPDATE can even find, and that is the same
      // clause a SELECT uses.
      return rows(canSee(owner) ? [{ name: 'fixture' }] : []);
    case 'storage-delete-gate':
    case 'storage-delete-gate-own':
      // Evaluated as the owner with a real session, so RLS does not hide the
      // row and the answer is the gate's alone: own prefix and on the
      // allowlist. No policy this model can break changes it.
      return rows([{ allowed: owner === check.jwt && check.jwt !== 'C' }]);
    case 'storage-delete-policy':
      // Read from the catalogue, so no policy this model can break changes it.
      return rows([{ n: 1 }]);
    case 'storage-delete-guarded':
      // Supabase's own guard, not a policy. Recognised by its message.
      return { rows: [], rowCount: 0, errorCode: '42501', errorMessage: 'Direct deletion from storage tables is not allowed. Use the Storage API instead.' };
    case 'storage-move-away':
      // Renaming into someone else's prefix fails the update policy's WITH
      // CHECK, which is the storage equivalent of handing a row away.
      return err('42501');
    case 'storage-insert-own':
      return canUpload(owner) ? rows([{ name: 'fresh' }]) : err('42501');
    case 'storage-insert-other':
      // With RETURNING the SELECT policy gates it too, so widening the INSERT
      // policy alone could never let this through.
      return err('42501');
    case 'storage-insert-other-silent':
      return err('42501');
    case 'storage-bad-shape':
      // Nothing to do with who you are: the path is not <user>/<project>/<file>.
      return err('42501');
    case 'storage-not-allowed-select':
      return rows([]);
    case 'storage-not-allowed-insert':
      return err('42501');
    case 'storage-anon':
      // Either answer is a pass; the model picks one.
      return rows([]);
    case 'used-own':
      return rows([{ used: A_USED }]);
    case 'used-not-allowed':
      return rows([{ used: 0 }]);
    // storage_under_cap() reads the bucket, not the policy, so breaking the
    // policy does not change what it answers. That is the point of asking it
    // separately: the proof below has to rest on the upload being refused.
    case 'cap-under':
    case 'cap-over':
      return rows([{ under: !overCap[as] }]);
    case 'cap-refuses-upload':
      return canUpload(owner) ? rows([{ name: 'fresh' }]) : err('42501');
    default:
      throw new Error(`the storage model does not know the sim "${sim}"`);
  }
}

const execWith = (leak) => async (check) => simulate(check, leak);

test('every assertion in the plan is well formed and uniquely named', () => {
  const plan = buildPlan({ A, B, C });
  assert.ok(plan.length > 100, `expected a thorough plan, got ${plan.length} assertions`);
  const names = new Set();
  for (const c of plan) {
    assert.ok(c.name, 'every assertion needs a name');
    assert.ok(!names.has(c.name), `duplicate assertion name: ${c.name}`);
    names.add(c.name);
    // 'owner' is the postgres role, which bypasses RLS. It is only ever used
    // for reading configuration — the bucket's own settings — never to prove
    // anything about isolation, which it could not do.
    assert.ok(['A', 'B', 'C', 'anon', 'noclaims', 'owner'].includes(c.as), `${c.name}: bad "as" value ${c.as}`);
    if (c.as === 'owner') {
      // The owner bypasses RLS, so it can prove nothing about isolation on its
      // own. Two uses are allowed: reading configuration no policy governs, and
      // evaluating a policy's gate against a row RLS would otherwise hide —
      // which needs a real session, hence `jwt`.
      assert.match(c.sql.trim(), /^select /i, 'the owner role bypasses RLS, so it may only ever read');
      const ALLOWED_OWNER_SIMS = ['bucket-config', 'signal-policies', 'signal-policy-text',
        'storage-delete-gate', 'storage-delete-gate-own', 'storage-delete-policy'];
      assert.ok(ALLOWED_OWNER_SIMS.includes(c.sim),
        `${c.name}: the owner role is only for configuration or gate evaluation, not for ${c.sim}`);
      if (c.sim.startsWith('storage-delete-gate')) {
        assert.ok(['A', 'B', 'C'].includes(c.jwt),
          `${c.name}: evaluating a gate is pointless without a real session on it`);
        assert.match(c.sql, /auth\.uid\(\)/, `${c.name}: must compare against the real session`);
        assert.match(c.sql, /is_allowed\(\)/, `${c.name}: must include the allowlist gate`);
      }
    }
    // "with" is here for the signalling checks, which have to put the channel
    // name on the connection before reading the gate that depends on it — a
    // materialized CTE is the only way to make that order certain in one
    // statement. Everything else is a plain verb.
    assert.ok(c.sql && /^(select|insert|update|delete|with)/i.test(c.sql.trim()), `${c.name}: missing or odd sql`);
    if (/^with/i.test(c.sql.trim())) {
      assert.match(c.sql, /\bselect\b/i, `${c.name}: a CTE here must end in a read`);
      assert.ok(!/\b(insert|update|delete)\s+(into|from|viralradar)/i.test(c.sql),
        `${c.name}: a CTE must not be a way to smuggle a write past this check`);
    }
    assert.ok(Array.isArray(c.params), `${c.name}: params must be an array`);
    assert.ok(c.sim, `${c.name}: missing sim label`);
    const keys = Object.keys(c.expect);
    assert.equal(keys.length, 1, `${c.name}: an assertion must expect exactly one thing, got ${keys}`);
    assert.ok(['rowCount', 'minRows', 'rows', 'errorCode', 'errorCodeIn', 'errorMatches', 'nothingVisible'].includes(keys[0]),
      `${c.name}: unknown expectation ${keys[0]}`);
    // A statement must never carry a user id it does not use, or use one it was not given.
    const highest = Math.max(0, ...[...c.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])));
    assert.equal(highest, c.params.length, `${c.name}: uses $${highest} but got ${c.params.length} param(s)`);
  }
});

test('the plan covers select, insert, update and delete in both directions for every table', () => {
  const plan = buildPlan({ A, B, C });
  for (const { table } of TABLES) {
    for (const [me, them] of [['A', 'B'], ['B', 'A']]) {
      const forTable = plan.filter((c) => c.table === table && c.as === me);
      for (const sim of ['select-own', 'select-other', 'select-unfiltered', 'update-own', 'update-other',
        'update-give-away', 'delete-own', 'delete-other', 'insert-own', 'insert-other',
        'insert-other-silent', 'insert-default-owner']) {
        assert.ok(forTable.some((c) => c.sim === sim), `${table}: missing "${sim}" as user ${me}`);
      }
      // The cross-user assertions must actually point at the other user's id.
      const other = forTable.find((c) => c.sim === 'select-other');
      assert.deepEqual(other.params, [uid[them]], `${table}: the cross-user select must use ${them}'s id`);
    }
    assert.ok(plan.some((c) => c.table === table && c.sim === 'anon-denied'), `${table}: missing the anon check`);
  }
  // Ownerless rows are checked on the tables the import function writes.
  for (const table of ['ideas', 'scripts', 'results', 'import_tokens']) {
    assert.ok(plan.some((c) => c.table === table && c.sim === 'insert-null-owner'), `${table}: missing the null-owner check`);
    assert.ok(plan.some((c) => c.table === table && c.sim === 'insert-no-session'), `${table}: missing the no-session check`);
  }
  assert.ok(plan.some((c) => c.table === 'settings' && c.sim === 'settings-own-count'));

  // Being signed in is not being a ViralRadar user: this project's auth.users
  // is shared with another app that already has accounts in it.
  for (const { table } of TABLES) {
    const forC = plan.filter((c) => c.table === table && c.as === 'C');
    assert.ok(forC.some((c) => c.sim === 'not-allowed-select'), `${table}: missing the "signed in but not allowed" read check`);
    assert.ok(forC.some((c) => c.sim === 'not-allowed-insert'), `${table}: missing the "signed in but not allowed" write check`);
    assert.ok(forC.some((c) => c.sim === 'not-allowed-insert-silent'), `${table}: missing the write check that isolates the INSERT policy`);
  }
  assert.ok(plan.some((c) => c.table === 'settings' && c.as === 'C'));

  // The gate must not be self-service.
  const allowlist = plan.filter((c) => c.table === 'allowed_users');
  assert.ok(allowlist.length >= 4, 'the allowlist itself needs read and write checks');
  for (const c of allowlist) {
    assert.equal(c.sim, 'allowlist-denied');
    assert.deepEqual(c.expect, { errorCode: '42501' }, `${c.name}: must be refused outright`);
  }
  assert.ok(allowlist.some((c) => c.as === 'A'), 'even an allowed user must not read the allowlist');
  assert.ok(allowlist.some((c) => c.as === 'C'));
});

test('the plan covers the files in Storage, not only the rows in the schema', () => {
  // A folder's files live in storage.objects, which is a different table with
  // different policies and no user_id column. Covering the two new tables and
  // stopping there would leave the files themselves untested.
  const plan = buildPlan({ A, B, C });
  const storage = plan.filter((c) => c.table === 'storage.objects');
  assert.ok(storage.length >= 20, `expected the storage policies to be covered, found ${storage.length} assertions`);

  for (const sim of ['storage-select-own', 'storage-select-other', 'storage-select-unfiltered',
    'storage-insert-own', 'storage-insert-other', 'storage-insert-other-silent',
    'storage-update-other', 'storage-move-away',
    'storage-bad-shape', 'storage-not-allowed-select', 'storage-not-allowed-insert', 'storage-anon']) {
    assert.ok(storage.some((c) => c.sim === sim), `storage: missing "${sim}"`);
  }

  // Deleting cannot be tested with SQL: Supabase forbids a direct DELETE on
  // storage.objects, and raises 42501 doing it — the same code as an RLS
  // refusal. So the delete policy is covered by its gate and by its own
  // definition, and the guard is asserted by MESSAGE so nothing can go green
  // for the wrong reason.
  for (const sim of ['storage-delete-gate', 'storage-delete-gate-own', 'storage-delete-guarded', 'storage-delete-policy']) {
    assert.ok(storage.some((c) => c.sim === sim), `storage: missing "${sim}"`);
  }
  const guard = storage.find((c) => c.sim === 'storage-delete-guarded');
  assert.ok(guard.expect.errorMatches, 'the guard must be recognised by its message, not by 42501');
  assert.ok(!storage.some((c) => /^delete/i.test(c.sql.trim()) && c.expect.errorCode === '42501'),
    'no storage assertion may rest on 42501 from a DELETE: the guard and a policy refusal share that code');

  // Every assertion that reads the bucket needs the fixtures, and they have to
  // be per-assertion so they roll back — nothing may be committed there.
  for (const c of storage.filter((x) => x.table === 'storage.objects')) {
    assert.equal(c.needsStorage, true, `${c.name}: must ask for the in-transaction bucket fixtures`);
  }

  // Both directions, like every other table.
  for (const [me, them] of [['A', 'B'], ['B', 'A']]) {
    const other = storage.find((c) => c.as === me && c.sim === 'storage-select-other');
    assert.ok(other, `storage: ${me} never tries to read ${them}'s files`);
    assert.ok(other.params.includes(`${uid[them]}/%`), `storage: the cross-user read must use ${them}'s prefix`);
  }

  // Every storage assertion must name the bucket, or it could be passing
  // because of something the other app in this project happens to have done.
  // Three ways to say it: as a parameter, inside a function that pins it, or
  // literally in the SQL — the catalogue checks do the last of those, because
  // they read a policy's text rather than touching a row.
  for (const c of storage) {
    assert.ok(c.params.includes(BUCKET) || /storage_use|under_cap/.test(c.sql) || c.sql.includes(BUCKET),
      `${c.name}: must be scoped to ViralRadar's own bucket`);
  }
});

test('the plan covers the 300 MB cap, the 25 MB limit and the 14-day cleanup', () => {
  const plan = buildPlan({ A, B, C });
  const sims = new Set(plan.map((c) => c.sim));

  // The cap: that it is measured per user, that it reads true for the user
  // under it and false for the one over, and that it actually refuses.
  for (const sim of ['used-own', 'used-not-allowed', 'cap-under', 'cap-over', 'cap-refuses-upload']) {
    assert.ok(sims.has(sim), `the 300 MB cap is not covered: missing "${sim}"`);
  }
  // Being full must not mean being stuck.
  assert.ok(plan.some((c) => c.jwt === 'B' && c.sim === 'storage-delete-gate-own'),
    'a user over the cap must still be allowed to delete, or there is no way back');

  // The 25 MB limit, in both the places that can refuse it.
  assert.ok(sims.has('item-too-big'), 'nothing checks the 25 MB limit in the database');
  assert.ok(sims.has('bucket-config'), 'nothing checks the 25 MB limit in the bucket settings');

  // The cleanup: that it fires at a fortnight, that the period is a real
  // parameter, and that it cannot be used to see or clear someone else's.
  for (const sim of ['cleanup-due', 'cleanup-retention', 'cleanup-other', 'cleanup-not-allowed']) {
    assert.ok(sims.has(sim), `the 14-day cleanup is not covered: missing "${sim}"`);
  }

  // The row-shape constraints, which RLS says nothing about.
  for (const sim of ['item-foreign-folder', 'item-bad-path', 'item-bad-digest', 'second-inbox']) {
    assert.ok(sims.has(sim), `missing "${sim}": a row can belong to you and still be wrong`);
  }
});

test('the plan covers videos being recorded but never stored', () => {
  const plan = buildPlan({ A, B, C });
  const sims = new Set(plan.map((c) => c.sim));

  // The row that says a 2 GB video exists is the whole output of Part 2, and
  // the things that could go wrong with it are all constraints rather than
  // policies — so they need checking by name.
  for (const sim of ['video-ref-own', 'video-ref-stored', 'video-ref-undigested',
    'video-ref-nowhere', 'video-ref-not-allowed', 'video-totals-other']) {
    assert.ok(sims.has(sim), `videos are not covered: missing "${sim}"`);
  }

  // The one that matters most: a video_ref of two gigabytes must be allowed,
  // or the feature cannot record its own result.
  const big = plan.find((c) => c.sim === 'video-ref-own');
  assert.match(big.sql, /2147483648/, 'the test should use a genuinely large size');
  assert.deepEqual(big.expect, { rowCount: 1 });
  // And a file of that size must still be refused, which is the other half.
  const file = plan.find((c) => c.sim === 'item-too-big');
  assert.deepEqual(file.expect, { errorCode: '23514' });
});

test('the plan covers the private channel the two devices signal on', () => {
  const plan = buildPlan({ A, B, C });
  const signalling = plan.filter((c) => c.table === 'realtime.messages');
  assert.ok(signalling.length >= 6, `expected the channel to be covered, found ${signalling.length}`);

  for (const sim of ['signal-own', 'signal-other', 'signal-junk', 'signal-not-allowed',
    'signal-policies', 'signal-policy-text']) {
    assert.ok(signalling.some((c) => c.sim === sim), `signalling: missing "${sim}"`);
  }

  // Both directions, like every other table. A session description carries both
  // devices' IP addresses, so being able to guess the name of someone else's
  // channel has to buy nothing.
  for (const [me, them] of [['A', 'B'], ['B', 'A']]) {
    const own = signalling.find((c) => c.as === me && c.sim === 'signal-own');
    const other = signalling.find((c) => c.as === me && c.sim === 'signal-other');
    assert.ok(own && other, `signalling: ${me} is not checked in both directions`);
    assert.deepEqual(own.expect, { rows: [{ allowed: true }] });
    assert.deepEqual(other.expect, { rows: [{ allowed: false }] });
    assert.ok(other.params.some((p) => String(p).includes(uid[them])),
      `signalling: ${me}'s cross-channel check must name ${them}'s channel`);
  }

  // The gate has to be the real one: auth.uid() and is_allowed(), not a
  // hard-coded answer.
  for (const c of signalling.filter((x) => x.as !== 'owner')) {
    assert.match(c.sql, /auth\.uid\(\)/, `${c.name}: must compare against the real session`);
    assert.match(c.sql, /is_allowed\(\)/, `${c.name}: must include the allowlist gate`);
    assert.match(c.sql, /realtime\.topic\(\)/, `${c.name}: must read the topic the way the policy does`);
  }
});

test('breaking a storage policy is noticed, and does not look like a schema leak', async () => {
  const plan = buildPlan({ A, B, C });

  // A policy scoped to the bucket but not to the prefix: every ViralRadar user
  // would see every other one's files, inside one bucket.
  const leaked = await runPlan(plan, execWith('storage-select'));
  const leakedNames = leaked.results.filter((r) => !r.ok).map((r) => r.name);
  assert.ok(leakedNames.includes("storage: A cannot see B's files"));
  assert.ok(leakedNames.includes("storage: B cannot see A's files"));
  assert.ok(leakedNames.includes("storage: an unfiltered select by A returns only A's files"));
  // The rows in the schema are governed by different policies entirely, so
  // this must not be confused with a leak there.
  assert.ok(!leakedNames.some((n) => n.startsWith('ideas: ')), 'a storage leak is not a leak in the schema');

  // No select policy for the bucket at all: even the owner of a file is denied.
  const closed = await runPlan(plan, execWith('no-storage-select'));
  const closedNames = closed.results.filter((r) => !r.ok).map((r) => r.name);
  assert.ok(closedNames.includes('storage: A can see their own files'));

  // The cap gone from the insert policy: the one user over it can upload again.
  const uncapped = await runPlan(plan, execWith('no-cap'));
  const uncappedNames = uncapped.results.filter((r) => !r.ok).map((r) => r.name);
  assert.ok(uncappedNames.includes('storage: B cannot upload while over the cap, even into their own folder'),
    'a missing cap must be reported as a failure, or 300 MB means nothing');
  // And nothing else: removing the cap is not a leak between users.
  assert.ok(!uncappedNames.some((n) => /cannot see/.test(n)), 'a missing cap is not a leak between users');
});

test('if the allowlist gate were missing, the "not allowed" assertions fail', async () => {
  const plan = buildPlan({ A, B, C });
  const { failed, results } = await runPlan(plan, execWith('no-allowlist-gate'));
  assert.ok(failed > 0, 'a missing allowlist gate must be reported as a failure');
  const failedNames = results.filter((r) => !r.ok).map((r) => r.name);
  for (const { table } of TABLES) {
    assert.ok(failedNames.includes(`${table}: C is signed in but not on the allowlist, and sees nothing`), `${table}: the read check did not notice`);
    assert.ok(failedNames.includes(`${table}: C cannot create anything, even without reading it back`), `${table}: the write check did not notice`);
    // The RETURNING form is NOT expected to notice: reading the row back
    // still needs the SELECT policy, which keeps its own gate. Writing the
    // assertion that way is what made the first real run prove nothing.
    assert.ok(!failedNames.includes(`${table}: C cannot create anything, not even a row of its own`),
      `${table}: the RETURNING form cannot detect an insert-only leak, so it must not be the one relied on`);
  }
  // The A and B assertions still pass: this mistake does not leak between users,
  // it lets the wrong people in. The test has to tell those two apart.
  assert.ok(!failedNames.some((n) => n.startsWith('ideas: A cannot see')), 'this leak should not be confused with a cross-user leak');
});

test('against a correctly locked-down database, every assertion passes', async () => {
  const plan = buildPlan({ A, B, C });
  const { passed, failed, results } = await runPlan(plan, execWith('none'));
  const firstFailure = results.find((r) => !r.ok);
  assert.equal(failed, 0, firstFailure ? `${firstFailure.name}: ${firstFailure.detail}` : '');
  assert.equal(passed, plan.length);
});

test('a policy that leaks every row makes the cross-user assertions fail', async () => {
  const plan = buildPlan({ A, B, C });
  const { failed, results } = await runPlan(plan, execWith('select'));
  assert.ok(failed > 0, 'a leak must be reported as a failure');
  const failedNames = results.filter((r) => !r.ok).map((r) => r.name);
  assert.ok(failedNames.includes("ideas: A cannot see B's rows"));
  assert.ok(failedNames.includes("results: B cannot see A's rows"));
  assert.ok(failedNames.includes('trends: an unfiltered select by A returns only A\'s rows'));
  // Every table must notice, not just the first one.
  for (const { table } of TABLES) {
    assert.ok(failedNames.some((n) => n.startsWith(`${table}: `)), `${table} did not notice the leak`);
  }
});

test('a missing select policy makes the own-rows assertions fail', async () => {
  const { failed, results } = await runPlan(buildPlan({ A, B, C }), execWith('no-select'));
  assert.ok(failed > 0);
  const failedNames = results.filter((r) => !r.ok).map((r) => r.name);
  assert.ok(failedNames.includes('ideas: A can see their own rows'));
  assert.ok(failedNames.includes('settings: B has exactly one settings row, created on first use'));
});

test('a WITH CHECK that accepts anything makes the insert and update assertions fail', async () => {
  const insertLeak = await runPlan(buildPlan({ A, B, C }), execWith('insert-check'));
  const insertFailures = insertLeak.results.filter((r) => !r.ok).map((r) => r.name);
  // Only the no-RETURNING assertions can see an insert-only leak.
  assert.ok(insertFailures.includes('ideas: B cannot insert a row owned by A, even without reading it back'));
  assert.ok(insertFailures.includes('import_tokens: A cannot insert a row owned by B, even without reading it back'));
  assert.ok(!insertFailures.includes('ideas: B cannot insert a row owned by A'),
    'the RETURNING form is blocked by the SELECT policy, so it cannot prove anything about the INSERT policy');

  const updateLeak = await runPlan(buildPlan({ A, B, C }), execWith('update-check'));
  const updateFailures = updateLeak.results.filter((r) => !r.ok).map((r) => r.name);
  assert.ok(updateFailures.includes('ideas: A cannot give their own row away to B'));
});

// The runner had no tests at all, which is how it came to create rows in a
// table it could not delete from and then leave three accounts behind in a live
// project when the cleanup threw. It is read as text here, in the same way the
// frontend tests read app.js: these are the properties that bug violated.
test('the runner creates its bucket fixtures inside the transaction that rolls back', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'test-rls.mjs'), 'utf8');

  // Supabase forbids a direct DELETE on storage.objects, so anything committed
  // there can never be cleared up. The only safe place to create it is inside
  // the transaction that is about to be rolled back.
  assert.ok(!/delete from storage\.objects/i.test(runner),
    'the runner must never try to delete from storage.objects: Supabase refuses, and the cleanup then fails');

  for (const fn of ['exec', 'execBroken']) {
    const start = runner.indexOf(`async function ${fn}(`);
    assert.ok(start > 0, `${fn} is missing`);
    const body = runner.slice(start, runner.indexOf('\n}', start));
    assert.match(body, /needsStorage/, `${fn} must create the bucket fixtures for assertions that need them`);
    // Before SET LOCAL ROLE, or the insert runs as the user and the INSERT
    // policy — the thing under test — decides whether the fixture exists.
    const fixtures = body.indexOf('createStorageFixtures');
    const become = body.indexOf('becomeUser');
    assert.ok(fixtures > 0 && become > 0 && fixtures < become,
      `${fn} must create the fixtures as the owner, before becoming the user`);
  }

  const create = runner.slice(runner.indexOf('async function createStorageFixtures'));
  assert.match(create.slice(0, create.indexOf('\n}')), /tx`insert into storage\.objects/,
    'the fixtures must be inserted on the transaction, not on the pool');
});

test('the runner deletes the test users whatever else fails', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const runner = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'test-rls.mjs'), 'utf8');
  const cleanup = runner.slice(runner.indexOf('} finally {'), runner.indexOf('const failed ='));

  // The original did the bucket first and the users second in one try block,
  // so when the bucket step threw the users were never deleted either.
  const users = cleanup.indexOf('deleteUsers()');
  const bucket = cleanup.indexOf('checkBucketIsClean()');
  assert.ok(users > 0, 'the cleanup must delete the test users');
  assert.ok(bucket > 0, 'the cleanup should still report anything left in the bucket');
  assert.ok(users < bucket, 'deleting the users is what matters, so it must come first');
  assert.equal(cleanup.match(/try \{/g).length, 2,
    'the two steps need separate try blocks, or one failing stops the other');

  // And if it cannot, it has to name every user — the first version printed two
  // of the three, so the third was left behind silently.
  assert.match(cleanup, /\$\{A\}, \$\{B\}, \$\{C\}|\$\{A\}[\s\S]{0,40}\$\{B\}[\s\S]{0,40}\$\{C\}/,
    'a failed cleanup must list all three users, not two');
  assert.match(cleanup, /rls-test-%@viralradar\.invalid/,
    'it should give the exact statement to run by hand');
});

test('the delete policy is covered by its verb and all four gates', () => {
  // This assertion stands in for DML that Supabase will not allow, so if it
  // stops pinning any of the four gates it stops standing in for anything.
  const plan = buildPlan({ A, B, C });
  const check = plan.find((c) => c.sim === 'storage-delete-policy');
  assert.ok(check, 'the delete policy is never read out of the catalogue');
  assert.match(check.sql, /policyname = 'vr_project_files_delete'/);
  assert.match(check.sql, /cmd = 'DELETE'/, 'a policy for the wrong verb would prove nothing');
  for (const gate of ['vr-project-files', 'foldername', 'auth.uid()', 'is_allowed']) {
    assert.ok(check.sql.includes(gate), `the catalogue check does not pin "${gate}"`);
  }
  assert.deepEqual(check.expect, { rows: [{ n: 1 }] });
});

test('matches() reads each kind of expectation correctly', () => {
  assert.equal(matches({ rowCount: 0 }, rows([])).ok, true);
  assert.equal(matches({ rowCount: 0 }, rows([{}])).ok, false);
  assert.equal(matches({ minRows: 1 }, rows([{}, {}])).ok, true);
  assert.equal(matches({ minRows: 1 }, rows([])).ok, false);
  assert.equal(matches({ rows: [{ n: 0 }] }, rows([{ n: 0 }])).ok, true);
  assert.equal(matches({ rows: [{ n: 0 }] }, rows([{ n: 1 }])).ok, false);
  assert.equal(matches({ errorCode: '42501' }, err('42501')).ok, true);
  assert.equal(matches({ errorCode: '42501' }, err('23502')).ok, false);
  assert.equal(matches({ errorCodeIn: ['23502', '42501'] }, err('42501')).ok, true);
  assert.equal(matches({ errorCodeIn: ['23502'] }, err('42501')).ok, false);
  // An expected rejection that silently succeeded is the worst case: say so clearly.
  const silent = matches({ errorCode: '42501' }, rows([{}]));
  assert.equal(silent.ok, false);
  assert.match(silent.detail, /but the statement succeeded with 1 row/);
  // An unexpected error must never be read as a pass.
  assert.equal(matches({ rowCount: 0 }, err('42P01')).ok, false);
  assert.match(matches({ rowCount: 0 }, err('42P01')).detail, /unexpected error 42P01/);

  // errorMatches: a refusal recognised by its message, because Supabase's
  // guard on storage.objects raises 42501 — the same code as an RLS refusal —
  // so the SQLSTATE alone cannot tell the two causes apart.
  const guard = { rows: [], rowCount: 0, errorCode: '42501', errorMessage: 'Direct deletion from storage tables is not allowed. Use the Storage API instead.' };
  const policy = { rows: [], rowCount: 0, errorCode: '42501', errorMessage: 'new row violates row-level security policy' };
  assert.equal(matches({ errorMatches: 'Use the Storage API' }, guard).ok, true);
  assert.equal(matches({ errorMatches: 'Use the Storage API' }, policy).ok, false,
    'the whole point: an RLS refusal must not satisfy an assertion about the guard');
  // And a statement that quietly succeeded is never a pass.
  assert.equal(matches({ errorMatches: 'Use the Storage API' }, rows([{}])).ok, false);
  assert.match(matches({ errorMatches: 'Use the Storage API' }, rows([{}])).detail, /but the statement succeeded/);

  // nothingVisible: no rows, or refused outright. Both mean "this role gets
  // nothing", where which one it is belongs to the Storage extension.
  assert.equal(matches({ nothingVisible: true }, rows([])).ok, true);
  assert.equal(matches({ nothingVisible: true }, err('42501')).ok, true);
  assert.equal(matches({ nothingVisible: true }, rows([{ name: 'leaked' }])).ok, false,
    'a row coming back is the one answer that is never acceptable');
  assert.match(matches({ nothingVisible: true }, rows([{}])).detail, /expected nothing to be visible/);
});

test('a proof passes only when breaking the policy makes the assertion fail', async () => {
  const proofs = buildProofs({ A, B, C });
  assert.ok(proofs.length >= 7, `expected a proof per policy family, got ${proofs.length}`);

  // Each proof names the policy it breaks and the assertion that must then fail.
  for (const p of proofs) {
    assert.match(p.breakSql, /^(drop|alter) policy /);
    assert.ok(p.check && p.check.expect && p.why);
    assert.ok(p.modelLeak, `${p.name}: must declare what its break does, for the offline model`);
  }

  // A database where breaking the policy really does change the answer.
  const honest = async (proof) => simulate(proof.check, proof.modelLeak);
  const good = await runProofs(proofs, honest);
  assert.equal(good.failed, 0, JSON.stringify(good.results));
  assert.equal(good.passed, proofs.length);
  for (const r of good.results) assert.match(r.detail, /failed as it must/);

  // A database where breaking the policy changes nothing: the proofs must fail,
  // because then the assertions are not testing the policy at all.
  const useless = async (proof) => simulate(proof.check, 'none');
  const bad = await runProofs(proofs, useless);
  assert.equal(bad.passed, 0);
  assert.equal(bad.failed, proofs.length);
  for (const r of bad.results) assert.match(r.detail, /still passed/);
});

test('a proof that cannot run at all is a failure, not a pass', async () => {
  const boom = async () => { throw new Error('permission denied to drop policy'); };
  const proofs = buildProofs({ A, B, C });
  const { passed, failed, results } = await runProofs(proofs, boom);
  assert.equal(passed, 0);
  assert.equal(failed, proofs.length);
  assert.match(results[0].detail, /could not run the proof: permission denied/);
});
