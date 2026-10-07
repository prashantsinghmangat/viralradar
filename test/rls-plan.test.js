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
const { buildPlan, buildProofs, runPlan, runProofs, matches, TABLES } = require('../scripts/rls-plan.mjs');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const uid = { A, B, C };

const rows = (r) => ({ rows: r, rowCount: r.length, errorCode: null, errorMessage: null });
const err = (code) => ({ rows: [], rowCount: 0, errorCode: code, errorMessage: 'simulated' });

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
  if (as === 'anon') return err('42501'); // privileges revoked from anon
  if (as === 'noclaims') return err('23502'); // auth.uid() is null, so the owner default is null

  // The allowlist is not readable or writable from any session.
  if (sim === 'allowlist-denied') return err('42501');

  // C is signed in but not on the allowlist, so is_allowed() is false and every
  // policy fails its second gate: reads return nothing, writes are refused.
  if (as === 'C') {
    if (leak === 'no-allowlist-gate') {
      // What it would look like if the second gate were missing from the
      // policies: C becomes an ordinary user of its own rows.
      return sim === 'not-allowed-select' ? rows([{ id: 'leaked' }]) : rows([{ id: 'fresh' }]);
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
      return leak === 'insert-check' ? rows([{ id: 'fresh' }]) : err('42501');
    case 'insert-default-owner':
      return rows([{ user_id: uid[me] }]);
    case 'insert-null-owner':
      return err('23502');
    default:
      throw new Error(`the model does not know the sim "${sim}"`);
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
    assert.ok(['A', 'B', 'C', 'anon', 'noclaims'].includes(c.as), `${c.name}: bad "as" value ${c.as}`);
    assert.ok(c.sql && /^(select|insert|update|delete)/i.test(c.sql.trim()), `${c.name}: missing or odd sql`);
    assert.ok(Array.isArray(c.params), `${c.name}: params must be an array`);
    assert.ok(c.sim, `${c.name}: missing sim label`);
    const keys = Object.keys(c.expect);
    assert.equal(keys.length, 1, `${c.name}: an assertion must expect exactly one thing, got ${keys}`);
    assert.ok(['rowCount', 'minRows', 'rows', 'errorCode', 'errorCodeIn'].includes(keys[0]), `${c.name}: unknown expectation ${keys[0]}`);
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
        'update-give-away', 'delete-own', 'delete-other', 'insert-own', 'insert-other', 'insert-default-owner']) {
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

test('if the allowlist gate were missing, the "not allowed" assertions fail', async () => {
  const plan = buildPlan({ A, B, C });
  const { failed, results } = await runPlan(plan, execWith('no-allowlist-gate'));
  assert.ok(failed > 0, 'a missing allowlist gate must be reported as a failure');
  const failedNames = results.filter((r) => !r.ok).map((r) => r.name);
  for (const { table } of TABLES) {
    assert.ok(failedNames.includes(`${table}: C is signed in but not on the allowlist, and sees nothing`), `${table}: the read check did not notice`);
    assert.ok(failedNames.includes(`${table}: C cannot create anything, not even a row of its own`), `${table}: the write check did not notice`);
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
  assert.ok(insertFailures.includes('ideas: B cannot insert a row owned by A'));
  assert.ok(insertFailures.includes('import_tokens: A cannot insert a row owned by B'));

  const updateLeak = await runPlan(buildPlan({ A, B, C }), execWith('update-check'));
  const updateFailures = updateLeak.results.filter((r) => !r.ok).map((r) => r.name);
  assert.ok(updateFailures.includes('ideas: A cannot give their own row away to B'));
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
});

test('a proof passes only when breaking the policy makes the assertion fail', async () => {
  const proofs = buildProofs({ A, B, C });
  assert.equal(proofs.length, 4);

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
  assert.equal(good.passed, 4);
  for (const r of good.results) assert.match(r.detail, /failed as it must/);

  // A database where breaking the policy changes nothing: the proofs must fail,
  // because then the assertions are not testing the policy at all.
  const useless = async (proof) => simulate(proof.check, 'none');
  const bad = await runProofs(proofs, useless);
  assert.equal(bad.passed, 0);
  assert.equal(bad.failed, 4);
  for (const r of bad.results) assert.match(r.detail, /still passed/);
});

test('a proof that cannot run at all is a failure, not a pass', async () => {
  const boom = async () => { throw new Error('permission denied to drop policy'); };
  const { passed, failed, results } = await runProofs(buildProofs({ A, B, C }), boom);
  assert.equal(passed, 0);
  assert.equal(failed, 4);
  assert.match(results[0].detail, /could not run the proof: permission denied/);
});
