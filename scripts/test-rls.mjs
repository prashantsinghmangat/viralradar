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
import {
  buildPlan, buildProofs, runPlan, runProofs,
  BUCKET, FIXTURE_BYTES, ITEM_ID, PROJECT_ID, objectPath,
} from './rls-plan.mjs';

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

async function becomeUser(tx, check) {
  const { as, jwt } = check;

  // The connection is already the owner, which BYPASSES Row Level Security.
  // Used for two things and nothing else: reading configuration that no policy
  // governs, and evaluating a policy's gate against a row that RLS would
  // otherwise hide — which needs the row visible AND a real session, so the
  // claims are set without changing role. rls-plan.test.js holds it to that.
  if (as === 'owner') {
    if (jwt) {
      await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: uid[jwt], role: 'authenticated' })}, true)`;
    }
    return;
  }
  if (as === 'anon') {
    await tx.unsafe('set local role anon');
    return;
  }
  await tx.unsafe('set local role authenticated');
  const claims = as === 'noclaims' ? '' : JSON.stringify({ sub: uid[as], role: 'authenticated' });
  await tx`select set_config('request.jwt.claims', ${claims}, true)`;
}

/**
 * The files an assertion needs, created inside its own transaction.
 *
 * WHY NOT ALONGSIDE THE OTHER FIXTURES
 *   Supabase forbids a direct DELETE on storage.objects — it wants the Storage
 *   API, so bytes cannot be orphaned in the bucket. The first version of this
 *   created the rows once, up front, and then could not clear them up: the run
 *   left four rows and three users behind in a live project.
 *
 *   Created here instead, they are rolled back with everything else the
 *   assertion did. Nothing is ever committed to storage.objects, so there is
 *   nothing to delete and no cleanup to fail.
 */
async function createStorageFixtures(tx) {
  for (const { path, size } of storageFixtures({ A, B })) {
    await tx`insert into storage.objects (bucket_id, name, metadata)
             values (${BUCKET}, ${path}, ${tx.json({ size })})`;
  }
}

async function attempt(tx, check) {
  try {
    const rows = await tx.unsafe(check.sql, check.params);
    // A statement with no RETURNING hands back no rows, so the number of rows
    // it affected comes from .count. Without this, "did the insert work?" would
    // always look like "no".
    const rowCount = typeof rows.count === 'number' ? rows.count : rows.length;
    return { rows: [...rows], rowCount, errorCode: null, errorMessage: null };
  } catch (e) {
    return { rows: [], rowCount: 0, errorCode: e.code || 'unknown', errorMessage: (e.message || '').split('\n')[0] };
  }
}

// One assertion: become the user, try the statement, always roll back.
async function exec(check) {
  try {
    await db.begin(async (tx) => {
      // Still the owner here, before SET LOCAL ROLE.
      if (check.needsStorage) await createStorageFixtures(tx);
      await becomeUser(tx, check);
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
      // Still the owner here, before SET LOCAL ROLE.
      await tx.unsafe(proof.breakSql);
      if (proof.check.needsStorage) await createStorageFixtures(tx);
      await becomeUser(tx, proof.check);
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
  // A's folder is the Inbox, because every user has exactly one and that makes
  // "a second Inbox is refused" something the suite can actually try.
  [
    'projects',
    (u, key) => db`insert into viralradar.projects (user_id, id, title, is_inbox)
                   values (${u}, ${key}, 'Fixture folder', ${key === PROJECT_ID.A})`,
  ],
  [
    'project_items',
    (u, key) => db`insert into viralradar.project_items (user_id, id, project_id, kind, content, from_device)
                   values (${u}, ${key}, ${u === uid.A ? PROJECT_ID.A : PROJECT_ID.B}, 'text', 'Fixture note', 'Laptop')`,
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
  projects: { A: PROJECT_ID.A, B: PROJECT_ID.B },
  project_items: { A: ITEM_ID.A, B: ITEM_ID.B },
};

/**
 * The extra fixtures the project-folder assertions need, which do not fit the
 * one-row-per-user shape above.
 *
 * THE POSTED DATES
 *   projects.posted_at is maintained by a trigger: it is set to now() the
 *   moment status becomes 'posted'. So a folder cannot simply be inserted with
 *   a date a month ago — it is inserted posted, and then the date is moved
 *   back by a second statement. That update leaves status alone, so the
 *   trigger's two branches both decline to fire and the backdated value
 *   survives. The suite then checks the 14-day rule against real dates rather
 *   than against whatever today happens to be.
 *
 * THE FILES
 *   Not here. The storage.objects rows are created inside each assertion that
 *   needs them and roll back with it — see createStorageFixtures above.
 *   Supabase forbids a direct DELETE on that table, so anything committed to it
 *   could not be cleared up again afterwards. The project_items rows below do
 *   stay, because they delete perfectly well.
 */
async function createProjectFixtures() {
  const posted = [
    [uid.A, PROJECT_ID.A_POSTED_OLD, 'A posted a month ago', '30 days'],
    [uid.A, PROJECT_ID.A_POSTED_NEW, 'A posted three days ago', '3 days'],
    [uid.B, PROJECT_ID.B_POSTED_OLD, 'B posted a month ago', '30 days'],
  ];
  for (const [user, id, title, age] of posted) {
    await db`insert into viralradar.projects (user_id, id, title, status)
             values (${user}, ${id}, ${title}, 'posted')`;
    await db`update viralradar.projects set posted_at = now() - ${age}::interval
             where user_id = ${user} and id = ${id}`;
  }

  // C is signed in but NOT on the allowlist. Giving C a folder of its own makes
  // "C can do nothing" a real statement: without it, every C assertion would
  // pass simply because there was nothing there to reach.
  await db`insert into viralradar.projects (user_id, id, title)
           values (${uid.C}, ${PROJECT_ID.C}, 'C folder, planted by the test')`;

  const files = [
    [uid.A, ITEM_ID.A_OLD_FILE, PROJECT_ID.A_POSTED_OLD, 'old.png', FIXTURE_BYTES.A_OLD],
    [uid.A, ITEM_ID.A_NEW_FILE, PROJECT_ID.A_POSTED_NEW, 'new.png', FIXTURE_BYTES.A_NEW],
    [uid.B, ITEM_ID.B_OLD_FILE, PROJECT_ID.B_POSTED_OLD, 'old.png', FIXTURE_BYTES.B_OLD],
  ];
  for (const [user, id, project, name, size] of files) {
    const path = objectPath(user, project, name);
    await db`insert into viralradar.project_items
               (user_id, id, project_id, kind, storage_path, file_name, mime, size_bytes)
             values (${user}, ${id}, ${project}, 'image', ${path}, ${name}, 'image/png', ${size})`;
  }

  // A video B transferred between its own devices: two gigabytes recorded, and
  // not one byte of it in the bucket. B has to have one for "A cannot see how
  // many videos B has" to be a statement about the policies rather than about
  // an empty table.
  await db`insert into viralradar.project_items
             (user_id, id, project_id, kind, file_name, size_bytes, sha256, devices, from_device)
           values (${uid.B}, ${ITEM_ID.B_VIDEO}, ${PROJECT_ID.B}, 'video_ref',
                   'b-export.mp4', 2147483648, ${'b'.repeat(64)}, array['Laptop', 'Phone'], 'Laptop')`;
}

/**
 * Anything of ours left in the bucket, which there should never be.
 *
 * Nothing commits to storage.objects any more, so this is a tripwire rather
 * than a cleanup step: it cannot delete them — Supabase forbids a direct DELETE
 * there — so it reports them and says what to do. If this ever prints
 * something, a fixture has escaped its transaction.
 */
async function checkBucketIsClean() {
  const rows = await db`select name from storage.objects
                        where bucket_id = ${BUCKET}
                          and (name like ${`${uid.A}/%`} or name like ${`${uid.B}/%`} or name like ${`${uid.C}/%`})`;
  if (!rows.length) return;
  console.error(`\nLEFT BEHIND IN THE BUCKET — ${rows.length} row(s). This is a bug in this script:`);
  for (const r of rows) console.error(`  ${r.name}`);
  console.error('  SQL cannot remove them. Delete these folders in the dashboard:');
  console.error('  Storage -> vr-project-files -> the folders named after the user ids above.');
}

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
  console.log(`  user C:   ${C}  (signed in, NOT on the allowlist)`);
  console.log(`  bucket:   ${BUCKET}  (A is under the 300 MB cap; B is deliberately over it)\n`);

  let created = false;
  let plan = { passed: 0, failed: 0 };
  let proofs = { passed: 0, failed: 0 };

  try {
    await createUsers();
    created = true;
    await createFixtures();
    await createProjectFixtures();

    console.log('--- isolation assertions ---');
    plan = await runPlan(buildPlan({ A, B, C }), exec, (line) => console.log('  ' + line));

    console.log('\n--- proofs that these assertions are real ---');
    console.log('  Each proof breaks one policy inside a transaction, re-runs one');
    console.log('  assertion, and demands that it now fails. The transaction is rolled');
    console.log('  back, so the policy is restored either way.\n');
    proofs = await runProofs(buildProofs({ A, B, C }), execBroken, (line) => console.log('  ' + line));
  } finally {
    // Two separate attempts on purpose. The first version did the bucket first
    // and the users second, in one try block — so when the bucket step failed
    // (Supabase forbids a direct DELETE there) the users were never deleted
    // either, and a failed run left three accounts behind in a live project.
    // Deleting the users is the part that actually matters, so it goes first
    // and nothing else can prevent it.
    if (created) {
      try {
        await deleteUsers();
        console.log('\nCleaned up: all three throwaway users and all their rows are deleted.');
      } catch (e) {
        console.error('\nCOULD NOT DELETE THE TEST USERS. Remove them by hand, in the SQL editor:');
        console.error("  delete from auth.users where email like 'rls-test-%@viralradar.invalid';");
        console.error(`  (they are ${A}, ${B}, ${C})`);
        console.error(`  ${e.message}`);
      }
      try {
        await checkBucketIsClean();
      } catch (e) {
        console.error(`\nCould not check the bucket: ${e.message}`);
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
