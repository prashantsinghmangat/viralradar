// Proves that one ViralRadar user cannot reach another user's rows.
//
//   npm run test:rls
//
// It connects as the "postgres" role, which OWNS the tables and therefore
// BYPASSES Row Level Security. That is exactly why every assertion runs inside
// its own transaction that first becomes a real signed-in user:
//
//   SET LOCAL ROLE authenticated;
//   SELECT set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', true);
//
// From that point on the policies apply just as they do for the browser. Every
// assertion transaction is rolled back, so the fixtures stay intact and the
// database is left exactly as it was found.
//
// Three throwaway users are created in auth.users (user_id references it) and
// deleted again at the end, which cascades their rows away. A and B are on the
// ViralRadar allowlist; C is not, standing in for an account belonging to the
// other app that shares this Supabase project. C must be able to do nothing.
import 'dotenv/config';
import postgres from 'postgres';
import { randomUUID } from 'node:crypto';
import { describe, explain, WHERE_TO_FIND } from './db-url.mjs';
import { buildPlan, buildProofs, runPlan, runProofs } from './rls-plan.mjs';

const HELP = `
Run the Row Level Security isolation test against your Supabase database.

  npm run test:rls

It needs DATABASE_URL in .env. Use the pooled connection string: click "Connect"
at the top of the dashboard, pick the "Direct / Connection string" tab, and copy
the one labelled "Shared pooler" (older wording: "Session pooler"). The direct
connection is IPv6-only and will not work on most home networks:

  DATABASE_URL=postgresql://postgres.<project-ref>:<your-db-password>@aws-0-<region>.pooler.supabase.com:5432/postgres

.env is gitignored, so the password stays on this laptop.
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set.');
  console.error(HELP);
  process.exit(2);
}

// Catch the wrong connection string here, rather than after a 30 second timeout.
const check = describe(url);
if (!check.ok) {
  console.error('\nThat DATABASE_URL will not work:\n');
  console.error(explain(check));
  console.error(WHERE_TO_FIND);
  process.exit(2);
}
if (check.warnings.length) console.error('\n' + explain(check) + '\n');

// Used to roll every assertion back while still carrying its outcome out.
class Rollback extends Error {
  constructor(outcome) {
    super('rollback');
    this.outcome = outcome;
  }
}

// A and B are ViralRadar users. C is a signed-in account that is NOT on the
// allowlist — the situation the other app sharing this project creates.
const A = randomUUID();
const B = randomUUID();
const C = randomUUID();
const uid = { A, B, C };

const db = postgres(url, {
  ssl: 'require',
  max: 1, // one connection, so SET LOCAL always applies to the statement that follows
  prepare: false, // safe through the pooler
  idle_timeout: 20,
  connect_timeout: 30,
  onnotice: () => {},
});

const host = (() => {
  try { return new URL(url).host; } catch { return 'the database'; }
})();

async function becomeUser(tx, as) {
  if (as === 'anon') {
    await tx.unsafe('set local role anon');
    return;
  }
  await tx.unsafe('set local role authenticated');
  const claims = as === 'noclaims' ? '' : JSON.stringify({ sub: uid[as], role: 'authenticated' });
  await tx`select set_config('request.jwt.claims', ${claims}, true)`;
}

async function attempt(tx, check) {
  try {
    const rows = await tx.unsafe(check.sql, check.params);
    return { rows: [...rows], rowCount: rows.length, errorCode: null, errorMessage: null };
  } catch (e) {
    return { rows: [], rowCount: 0, errorCode: e.code || 'unknown', errorMessage: (e.message || '').split('\n')[0] };
  }
}

// One assertion: become the user, try the statement, always roll back.
async function exec(check) {
  try {
    await db.begin(async (tx) => {
      await becomeUser(tx, check.as);
      throw new Rollback(await attempt(tx, check));
    });
    return { rows: [], rowCount: 0, errorCode: 'no-rollback', errorMessage: 'the transaction committed unexpectedly' };
  } catch (e) {
    if (e instanceof Rollback) return e.outcome;
    return { rows: [], rowCount: 0, errorCode: e.code || 'harness', errorMessage: e.message };
  }
}

// One proof: break a policy, re-run a single assertion, always roll back so the
// policy comes straight back.
async function execBroken(proof) {
  try {
    await db.begin(async (tx) => {
      await tx.unsafe(proof.breakSql); // still the owner here, before SET LOCAL ROLE
      await becomeUser(tx, proof.check.as);
      throw new Rollback(await attempt(tx, proof.check));
    });
    throw new Error('the proof transaction committed unexpectedly');
  } catch (e) {
    if (e instanceof Rollback) return e.outcome;
    throw e;
  }
}

const FIXTURES = [
  [
    'ideas',
    (u, key) => db`insert into viralradar.ideas (user_id, id, title, hook, source)
                   values (${u}, ${key}, 'Fixture idea', 'a hook', 'manual')`,
  ],
  [
    'scripts',
    (u, key) => db`insert into viralradar.scripts (user_id, id, topic, title, source)
                   values (${u}, ${key}, 'fixture', 'Fixture script', 'manual')`,
  ],
  [
    'results',
    (u, key) => db`insert into viralradar.results (user_id, id, title, views, saves, posted_on, source)
                   values (${u}, ${key}, 'Fixture result', 1000, 50, current_date, 'manual')`,
  ],
  [
    'trends',
    (u, key) => db`insert into viralradar.trends (user_id, url, title, source, score)
                   values (${u}, ${key}, 'Fixture trend', 'youtube', 12)`,
  ],
  [
    'usage',
    (u, key) => db`insert into viralradar.usage (user_id, date, provider, units, requests)
                   values (${u}, current_date, ${key}, 100, 1)`,
  ],
  [
    'import_tokens',
    (u, key) => db`insert into viralradar.import_tokens (user_id, token_hash, label)
                   values (${u}, ${key}, 'Fixture token')`,
  ],
  // Settings rows are created by the app on first use, not by a trigger on
  // auth.users: this Supabase project is shared with another app, and a trigger
  // there would fire for that app's signups too. So the test creates them the
  // same way the app does.
  [
    'settings',
    (u) => db`insert into viralradar.settings (user_id) values (${u}) on conflict (user_id) do nothing`,
  ],
];

const FIXTURE_KEYS = {
  ideas: { A: 'idea-a', B: 'idea-b' },
  scripts: { A: 'script-a', B: 'script-b' },
  results: { A: 'result-a', B: 'result-b' },
  trends: { A: 'https://a.example/trend-1', B: 'https://b.example/trend-1' },
  usage: { A: 'youtube', B: 'youtube' },
  import_tokens: { A: 'hash-of-token-a', B: 'hash-of-token-b' },
  settings: { A: null, B: null }, // keyed by user_id alone
};

async function createUsers() {
  for (const [label, id] of [['a', A], ['b', B], ['c', C]]) {
    await db`
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password,
                              email_confirmed_at, created_at, updated_at)
      values ('00000000-0000-0000-0000-000000000000', ${id}, 'authenticated', 'authenticated',
              ${`rls-test-${label}-${id}@viralradar.invalid`}, '', now(), now(), now())`;
  }
  // A and B are ViralRadar users. C is deliberately left off the allowlist: it
  // stands in for an account belonging to the other app in this project.
  await db`insert into viralradar.allowed_users (user_id, note) values
             (${A}, 'rls test user A'), (${B}, 'rls test user B')`;
}

async function createFixtures() {
  for (const [table, insert] of FIXTURES) {
    for (const who of ['A', 'B']) await insert(uid[who], FIXTURE_KEYS[table][who]);
  }
}

async function deleteUsers() {
  // Cascades through every table, the settings rows and the allowlist entries.
  await db`delete from auth.users where id in (${A}, ${B}, ${C})`;
}

async function main() {
  console.log(`\nRow Level Security isolation test`);
  console.log(`  database: ${host}`);
  console.log(`  user A:   ${A}  (on the allowlist)`);
  console.log(`  user B:   ${B}  (on the allowlist)`);
  console.log(`  user C:   ${C}  (signed in, NOT on the allowlist)\n`);

  let created = false;
  let plan = { passed: 0, failed: 0 };
  let proofs = { passed: 0, failed: 0 };

  try {
    await createUsers();
    created = true;
    await createFixtures();

    console.log('--- isolation assertions ---');
    plan = await runPlan(buildPlan({ A, B, C }), exec, (line) => console.log('  ' + line));

    console.log('\n--- proofs that these assertions are real ---');
    console.log('  Each proof breaks one policy inside a transaction, re-runs one');
    console.log('  assertion, and demands that it now fails. The transaction is rolled');
    console.log('  back, so the policy is restored either way.\n');
    proofs = await runProofs(buildProofs({ A, B, C }), execBroken, (line) => console.log('  ' + line));
  } finally {
    if (created) {
      try {
        await deleteUsers();
        console.log('\nCleaned up: both throwaway users and all their rows are deleted.');
      } catch (e) {
        console.error(`\nCOULD NOT CLEAN UP. Delete these users by hand:\n  ${A}\n  ${B}\n  ${e.message}`);
      }
    }
    await db.end({ timeout: 5 });
  }

  const failed = plan.failed + proofs.failed;
  console.log(`\nassertions: ${plan.passed} passed, ${plan.failed} failed`);
  console.log(`proofs:     ${proofs.passed} passed, ${proofs.failed} failed`);
  console.log(failed === 0
    ? '\nPASS - a user can only reach their own rows, and the test can detect it when that breaks.\n'
    : `\nFAIL - ${failed} problem(s) above. Do not put real data in this project until they are fixed.\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(`\nThe test could not run: ${e.message}`);
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/.test(e.message || '')) {
    console.error('\nThat looks like a connection problem. Use the "Session pooler" string');
    console.error('from the Supabase dashboard: the direct connection is IPv6-only and');
    console.error('usually will not work from a home network.');
  }
  try { await db.end({ timeout: 5 }); } catch { /* already closed */ }
  process.exit(2);
});
