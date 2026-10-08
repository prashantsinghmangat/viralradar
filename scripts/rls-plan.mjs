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
//   'owner'    -> no role change, so RLS is BYPASSED. Only for reading
//                 configuration, or for evaluating a policy's gate against a
//                 row RLS would otherwise hide; with `jwt: 'A'` the claims are
//                 set without changing role, so auth.uid() is still real.
//                 test/rls-plan.test.js refuses to let it be used otherwise.
//
// "expect" is one of:
//   { rowCount: n }      exactly n rows came back (0 means "RLS hid everything")
//   { minRows: n }       at least n rows came back
//   { rows: [...] }      the rows came back exactly like this
//   { errorCode: c }     the statement was rejected with that SQLSTATE
//   { errorCodeIn: [] }  rejected with any one of these SQLSTATEs
//                        42501 = row level security violation, or no privilege
//                        23502 = not-null violation (no owner on the row)
//                        23505 = unique violation    23514 = check violation
//   { errorMatches: s }  rejected with a message containing s. For the one case
//                        where a SQLSTATE cannot tell two causes apart: see the
//                        storage DELETE guard below.
//   { nothingVisible }   no rows, or refused outright — both mean "this role
//                        gets nothing", where which one is not ours to decide.
//
// "needsStorage" asks the runner to create the bucket fixtures inside this
// assertion's own transaction, so they roll back with it. Supabase forbids a
// direct DELETE on storage.objects, so nothing may ever be committed there.
//
// "sim" names what the assertion means, independent of its SQL, so the plan can
// be checked offline against a model of how RLS behaves (see test/rls-plan.test.js).

// ---------- the project-folder fixtures ----------
//
// Project folders are the one feature whose rows refer to each other, so the
// ids are fixed rather than random: an item's foreign key is the pair
// (user_id, project_id), and an assertion has to be able to name a folder that
// really exists — and one that deliberately does not belong to the user making
// the attempt.
//
// C gets a folder too, planted by the owner role. C is signed in but not on the
// allowlist, and having rows of its own makes "C can do nothing" a real
// statement rather than one that passes because there was nothing there.
export const PROJECT_ID = {
  A: 'aaaa1111-0000-4000-8000-00000000aaaa',
  B: 'bbbb1111-0000-4000-8000-00000000bbbb',
  C: 'cccc1111-0000-4000-8000-00000000cccc',
  // Marked posted 30 days ago: its file is due for the 14-day cleanup.
  A_POSTED_OLD: 'aaaa2222-0000-4000-8000-00000000aaaa',
  // Marked posted 3 days ago: its file must be left alone.
  A_POSTED_NEW: 'aaaa3333-0000-4000-8000-00000000aaaa',
  // B has a long-posted folder too, so "A cannot clean up B's files" is a
  // statement about the policies rather than about an empty result.
  B_POSTED_OLD: 'bbbb2222-0000-4000-8000-00000000bbbb',
};

export const ITEM_ID = {
  A: 'aaaa0001-0000-4000-8000-00000000aaaa',
  B: 'bbbb0001-0000-4000-8000-00000000bbbb',
  A_OLD_FILE: 'aaaa0002-0000-4000-8000-00000000aaaa',
  A_NEW_FILE: 'aaaa0003-0000-4000-8000-00000000aaaa',
  B_OLD_FILE: 'bbbb0002-0000-4000-8000-00000000bbbb',
  // A two gigabyte video B transferred between its own devices, recorded as a
  // row with no bytes anywhere. Needed so "A cannot see how many videos B has"
  // is about the policies rather than about an empty table.
  B_VIDEO: 'bbbb0003-0000-4000-8000-00000000bbbb',
};

export const BUCKET = 'vr-project-files';

/** Where a fixture file lives. The same layout the storage policies enforce. */
export const objectPath = (user, project, name) => `${user}/${project}/${name}`;

// What each fixture file claims to be, in bytes. A's two small files put A
// comfortably under the 300 MB cap; B's single enormous one puts B over it, so
// the same set of fixtures proves both that the cap refuses an upload and that
// it is counted per user rather than across the whole bucket.
export const FIXTURE_BYTES = {
  A_OLD: 1000,
  A_NEW: 2000,
  B_OLD: 500,
  // 320 MB, past TOTAL_BYTES_CAP (300 MB). No bytes exist behind this row: it
  // is a stand-in, which is exactly what is needed to test a cap without
  // uploading 320 MB.
  B_HUGE: 320 * 1000 * 1000,
};

export const A_USED = FIXTURE_BYTES.A_OLD + FIXTURE_BYTES.A_NEW;

/**
 * The files in the bucket, as data.
 *
 * Created inside each assertion's own transaction rather than once up front,
 * because **Supabase forbids a direct DELETE on storage.objects** — it wants
 * the Storage API, so bytes cannot be orphaned. Anything committed to that
 * table from here could never be cleared up again, and the first version of
 * this suite proved it by leaving four rows and three users in a live project.
 *
 * B's single enormous row is what puts B over the 300 MB cap. No bytes exist
 * behind any of them: a size in metadata is all storage_used() reads, which is
 * the only sane way to test a cap without uploading 320 MB.
 */
export const storageFixtures = ({ A, B }) => [
  { path: objectPath(A, PROJECT_ID.A_POSTED_OLD, 'old.png'), size: FIXTURE_BYTES.A_OLD },
  { path: objectPath(A, PROJECT_ID.A_POSTED_NEW, 'new.png'), size: FIXTURE_BYTES.A_NEW },
  { path: objectPath(B, PROJECT_ID.B_POSTED_OLD, 'old.png'), size: FIXTURE_BYTES.B_OLD },
  { path: objectPath(B, PROJECT_ID.B, 'huge.bin'), size: FIXTURE_BYTES.B_HUGE },
];

// Every table, with enough shape to insert a row and to find one again.
// `key` is the column that identifies a row within one user.
//
// `insert(key, who)` is given the user the row is meant to belong to, because
// a project item has to name a folder owned by that same user — otherwise the
// foreign key would refuse it before any policy was consulted, and the
// assertion would prove something else.
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
  {
    table: 'projects',
    key: 'id',
    fixture: { A: PROJECT_ID.A, B: PROJECT_ID.B },
    fresh: 'ffff0000-0000-4000-8000-00000000ffff',
    insert: (key) => ({ cols: 'id, title', vals: `${key}, 'fresh folder'` }),
    update: "set title = 'renamed by the wrong user'",
    nullOwner: true,
  },
  {
    table: 'project_items',
    key: 'id',
    fixture: { A: ITEM_ID.A, B: ITEM_ID.B },
    fresh: 'ffff0001-0000-4000-8000-00000000ffff',
    // The folder has to be one the row's owner really has, or the composite
    // foreign key refuses it before RLS is reached.
    insert: (key, who) => ({
      cols: 'id, project_id, kind, content',
      vals: `${key}, '${PROJECT_ID[who]}', 'text', 'fresh note'`,
    }),
    update: "set content = 'rewritten by the wrong user'",
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
      //
      // Two shapes, not one. For most tables they are identical, but a project
      // item names the folder it goes in, and that folder has to belong to
      // whoever the row says owns it — the foreign key is on the pair. Reusing
      // one shape for both directions asked A to put a row it owned into B's
      // folder, which the foreign key refused with 23503 before any policy was
      // consulted, so "A can insert their own row" failed for a reason that
      // had nothing to do with RLS.
      const fresh = t.insert('$2', them);
      const freshOwn = t.insert('$2', me);
      add({
        name: `${table}: ${me} cannot insert a row owned by ${them}`,
        as: me, table, sim: 'insert-other', owner: them,
        sql: `insert into viralradar.${table} (user_id, ${fresh.cols}) values ($1, ${fresh.vals}) returning ${key}`,
        params: [uid[them], t.fresh],
        expect: { errorCode: '42501' },
      });
      // The same thing again without RETURNING. RETURNING needs the SELECT
      // policy as well as the INSERT one, so the check above cannot tell which
      // of the two refused it. This one isolates the INSERT policy.
      add({
        name: `${table}: ${me} cannot insert a row owned by ${them}, even without reading it back`,
        as: me, table, sim: 'insert-other-silent', owner: them,
        sql: `insert into viralradar.${table} (user_id, ${fresh.cols}) values ($1, ${fresh.vals})`,
        params: [uid[them], t.fresh],
        expect: { errorCode: '42501' },
      });
      add({
        name: `${table}: ${me} can insert their own row`,
        as: me, table, sim: 'insert-own', owner: me,
        sql: `insert into viralradar.${table} (user_id, ${freshOwn.cols}) values ($1, ${freshOwn.vals}) returning ${key}`,
        params: [uid[me], t.fresh],
        expect: { rowCount: 1 },
      });
      // No user_id given: the auth.uid() default fills it in from the JWT.
      const defaulted = t.insert('$1', me);
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
      const fresh = t.insert('$1', 'A');
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
    const own = t.insert('$2', 'C');
    add({
      name: `${table}: C cannot create anything, not even a row of its own`,
      as: 'C', table, sim: 'not-allowed-insert', owner: 'C',
      sql: `insert into viralradar.${table} (user_id, ${own.cols}) values ($1, ${own.vals}) returning ${key}`,
      params: [uid.C, t.fresh],
      expect: { errorCode: '42501' },
    });
    // Again without RETURNING, so this rests on the INSERT policy alone.
    add({
      name: `${table}: C cannot create anything, even without reading it back`,
      as: 'C', table, sim: 'not-allowed-insert-silent', owner: 'C',
      sql: `insert into viralradar.${table} (user_id, ${own.cols}) values ($1, ${own.vals})`,
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

  // ---- project folders: the rows have to make sense, not just belong to you ----
  //
  // RLS decides WHICH rows you may write. It says nothing about whether their
  // contents are coherent, and these rows point at each other and at files in a
  // bucket. Each of these is a constraint rather than a policy, and each of them
  // is the thing that stops a row describing something that is not true.
  add({
    name: "project_items: A cannot put an item in B's folder",
    as: 'A', table: 'project_items', sim: 'item-foreign-folder', owner: 'A',
    // Owned by A, which RLS is perfectly happy with — but pointing at a folder
    // that is B's. The foreign key is on the pair, so there is no such row.
    sql: `insert into viralradar.project_items (user_id, id, project_id, kind, content)
          values ($1, $2, '${PROJECT_ID.B}', 'text', 'planted in another folder')`,
    params: [A, 'ffff0002-0000-4000-8000-00000000ffff'],
    expect: { errorCodeIn: ['23503', '42501'] },
  });
  add({
    name: 'project_items: a file bigger than 25 MB is refused by the database too',
    as: 'A', table: 'project_items', sim: 'item-too-big', owner: 'A',
    sql: `insert into viralradar.project_items (user_id, id, project_id, kind, storage_path, file_name, size_bytes)
          values ($1, $2, '${PROJECT_ID.A}', 'file', $3, 'huge.mp4', 26214401)`,
    params: [A, 'ffff0003-0000-4000-8000-00000000ffff', objectPath(A, PROJECT_ID.A, 'huge.mp4')],
    expect: { errorCode: '23514' },
  });
  add({
    name: 'project_items: a row claiming a file in another folder is refused',
    as: 'A', table: 'project_items', sim: 'item-bad-path', owner: 'A',
    // Owned by A, in A's folder, but the path says the file is B's. Without the
    // CHECK this row would be perfectly legal and completely wrong.
    sql: `insert into viralradar.project_items (user_id, id, project_id, kind, storage_path, file_name, size_bytes)
          values ($1, $2, '${PROJECT_ID.A}', 'file', $3, 'theirs.png', 10)`,
    params: [A, 'ffff0004-0000-4000-8000-00000000ffff', objectPath(B, PROJECT_ID.B, 'theirs.png')],
    expect: { errorCode: '23514' },
  });
  add({
    name: 'project_items: a digest that is not lowercase hex is refused',
    as: 'A', table: 'project_items', sim: 'item-bad-digest', owner: 'A',
    // Part 2 proves a transfer was exact by comparing these. A mixed-case copy
    // of the same digest would compare unequal and read as a corrupt file.
    sql: `insert into viralradar.project_items (user_id, id, project_id, kind, storage_path, file_name, size_bytes, sha256)
          values ($1, $2, '${PROJECT_ID.A}', 'file', $3, 'a.png', 10, 'NOTAHEXDIGEST')`,
    params: [A, 'ffff0005-0000-4000-8000-00000000ffff', objectPath(A, PROJECT_ID.A, 'a.png')],
    expect: { errorCode: '23514' },
  });
  add({
    name: 'projects: a second Inbox is refused',
    as: 'A', table: 'projects', sim: 'second-inbox', owner: 'A',
    // Two devices can ask for the Inbox at the same moment. The partial unique
    // index is what makes the loser read the winner's folder instead of
    // creating a second one nobody's share menu points at.
    sql: `insert into viralradar.projects (user_id, id, title, is_inbox)
          values ($1, $2, 'Inbox', true)`,
    params: [A, 'ffff0006-0000-4000-8000-00000000ffff'],
    expect: { errorCode: '23505' },
  });

  // ---- files in Storage ----
  //
  // storage.objects is not ours: it is one table belonging to the Storage
  // extension, shared with the other app in this project, holding every app's
  // files. So there is no user_id column to compare — ownership is the first
  // folder of the path, which is why storagePath() puts the user id there.
  //
  // The fixtures put A well under the 300 MB cap and B deliberately over it, so
  // the same set proves the cap refuses an upload AND that it is counted per
  // user rather than across the whole bucket.
  //
  // WHAT CANNOT BE TESTED HERE, AND WHY
  //   Supabase forbids a direct DELETE on storage.objects: it raises
  //   "Direct deletion from storage tables is not allowed. Use the Storage API
  //   instead." So the delete policy cannot be exercised with SQL, however much
  //   one would like to. Worse, it raises SQLSTATE 42501 — the same code as an
  //   RLS refusal — so an assertion expecting 42501 from a DELETE here would go
  //   green while proving the exact opposite of what it claimed.
  //
  //   So the delete policy is covered two ways instead, and neither is DML:
  //   the gate it applies is evaluated against the real row with a real
  //   session (below), and the policy itself is read out of pg_policies for its
  //   verb and all four gates (further down). That is weaker than DML and is
  //   labelled as such in PROJECT.md rather than left looking equivalent.
  //
  //   INSERT and UPDATE are not guarded — measured, not assumed — so those stay
  //   as real statements.
  const ownFile = { A: objectPath(A, PROJECT_ID.A_POSTED_OLD, 'old.png'), B: objectPath(B, PROJECT_ID.B_POSTED_OLD, 'old.png') };

  // The delete policy's USING clause, evaluated against one row. Run as the
  // owner so the row is visible at all, with the claims of a real session so
  // auth.uid() and is_allowed() are the real thing.
  const DELETE_GATE = `select (
      o.bucket_id = $1
      and (storage.foldername(o.name))[1] = auth.uid()::text
      and array_length(storage.foldername(o.name), 1) = 2
      and (select viralradar.is_allowed())
    ) as allowed
    from storage.objects o where o.name = $2`;

  add({
    name: 'storage: A can see their own files',
    as: 'A', table: 'storage.objects', sim: 'storage-select-own', owner: 'A',
    needsStorage: true,
    sql: 'select name from storage.objects where bucket_id = $1 and name like $2',
    params: [BUCKET, `${A}/%`],
    expect: { minRows: 1 },
  });
  for (const [me, them] of [['A', 'B'], ['B', 'A']]) {
    add({
      name: `storage: ${me} cannot see ${them}'s files`,
      as: me, table: 'storage.objects', sim: 'storage-select-other', owner: them,
      needsStorage: true,
      sql: 'select name from storage.objects where bucket_id = $1 and name like $2',
      params: [BUCKET, `${uid[them]}/%`],
      expect: { rowCount: 0 },
    });
    // Asking for the whole bucket must still only return your own files.
    add({
      name: `storage: an unfiltered select by ${me} returns only ${me}'s files`,
      as: me, table: 'storage.objects', sim: 'storage-select-unfiltered', owner: them,
      needsStorage: true,
      sql: 'select count(*)::int as n from storage.objects where bucket_id = $1 and name not like $2',
      params: [BUCKET, `${uid[me]}/%`],
      expect: { rows: [{ n: 0 }] },
    });
    // The delete policy cannot be exercised with SQL at all — see the block
    // below. What is checked here is the gate it applies, against the real row.
    add({
      name: `storage: the delete gate says no to ${me} for ${them}'s files`,
      as: 'owner', jwt: me, table: 'storage.objects', sim: 'storage-delete-gate', owner: them,
      needsStorage: true,
      sql: DELETE_GATE,
      params: [BUCKET, ownFile[them]],
      expect: { rows: [{ allowed: false }] },
    });
    add({
      name: `storage: the delete gate says yes to ${me} for ${me}'s own files`,
      as: 'owner', jwt: me, table: 'storage.objects', sim: 'storage-delete-gate-own', owner: me,
      needsStorage: true,
      sql: DELETE_GATE,
      params: [BUCKET, ownFile[me]],
      expect: { rows: [{ allowed: true }] },
    });
    add({
      name: `storage: ${me} cannot rename one of ${them}'s files`,
      as: me, table: 'storage.objects', sim: 'storage-update-other', owner: them,
      needsStorage: true,
      sql: "update storage.objects set name = name || '.taken' where bucket_id = $1 and name like $2 returning name",
      params: [BUCKET, `${uid[them]}/%`],
      expect: { rowCount: 0 },
    });
    add({
      name: `storage: ${me} cannot upload into ${them}'s folder`,
      as: me, table: 'storage.objects', sim: 'storage-insert-other', owner: them,
      needsStorage: true,
      sql: 'insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3) returning name',
      params: [BUCKET, objectPath(uid[them], PROJECT_ID[them], 'planted.png'), '{"size": 10}'],
      expect: { errorCode: '42501' },
    });
    // Without RETURNING, so this rests on the INSERT policy alone: reading a
    // row back needs the SELECT policy too, which would refuse it regardless.
    add({
      name: `storage: ${me} cannot upload into ${them}'s folder, even without reading it back`,
      as: me, table: 'storage.objects', sim: 'storage-insert-other-silent', owner: them,
      needsStorage: true,
      sql: 'insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3)',
      params: [BUCKET, objectPath(uid[them], PROJECT_ID[them], 'planted-silently.png'), '{"size": 10}'],
      expect: { errorCode: '42501' },
    });
    // WITH CHECK on the update policy: a file may not be renamed out of your
    // own prefix and into someone else's, which is the storage equivalent of
    // handing a row away.
    add({
      name: `storage: ${me} cannot move their own file into ${them}'s folder`,
      as: me, table: 'storage.objects', sim: 'storage-move-away', owner: me,
      needsStorage: true,
      sql: 'update storage.objects set name = $3 where bucket_id = $1 and name like $2 returning name',
      params: [BUCKET, `${uid[me]}/%`, objectPath(uid[them], PROJECT_ID[them], 'moved.png')],
      expect: { errorCode: '42501' },
    });
  }

  // A is under the cap, so uploading works. This is also what proves B being
  // over the cap has not broken uploading for everyone.
  add({
    name: 'storage: A can upload into their own folder, even though B is over the cap',
    as: 'A', table: 'storage.objects', sim: 'storage-insert-own', owner: 'A',
    needsStorage: true,
    sql: 'insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3) returning name',
    params: [BUCKET, objectPath(A, PROJECT_ID.A, 'fresh.png'), '{"size": 10}'],
    expect: { rowCount: 1 },
  });
  // Being full must not mean being stuck: deleting is how you get unstuck, and
  // the delete policy deliberately carries no cap. Asked of the gate rather
  // than by deleting, for the reason given at the top of this section.
  add({
    name: 'storage: the delete gate still says yes to B, who is over the cap',
    as: 'owner', jwt: 'B', table: 'storage.objects', sim: 'storage-delete-gate-own', owner: 'B',
    needsStorage: true,
    sql: DELETE_GATE,
    params: [BUCKET, objectPath(B, PROJECT_ID.B, 'huge.bin')],
    expect: { rows: [{ allowed: true }] },
  });

  // The guard itself, stated rather than tripped over. It raises 42501, the
  // same SQLSTATE as an RLS refusal, so this is the assertion that stops a
  // future author writing a delete assertion that goes green for the wrong
  // reason. If Supabase ever allows direct deletes, this fails and the delete
  // policy can go back to being tested with DML.
  add({
    name: 'storage: a direct DELETE is refused by Supabase itself, whoever asks',
    as: 'A', table: 'storage.objects', sim: 'storage-delete-guarded', owner: 'A',
    needsStorage: true,
    sql: 'delete from storage.objects where bucket_id = $1 and name = $2 returning name',
    params: [BUCKET, ownFile.A],
    // Not { errorCode: '42501' }: that would also pass if the policy had
    // refused it, which is the confusion this assertion exists to name.
    expect: { errorMatches: 'Use the Storage API' },
  });

  // The path shape. Anything that is not exactly <user>/<project>/<file> is
  // refused, so nothing can accumulate at the top of the bucket and no one can
  // invent a deeper tree the UI would never show.
  add({
    name: 'storage: A cannot upload to the top of the bucket',
    as: 'A', table: 'storage.objects', sim: 'storage-bad-shape', owner: 'A',
    needsStorage: true,
    sql: 'insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3)',
    params: [BUCKET, 'loose.png', '{"size": 10}'],
    expect: { errorCode: '42501' },
  });
  add({
    name: 'storage: A cannot upload straight into their own prefix with no project folder',
    as: 'A', table: 'storage.objects', sim: 'storage-bad-shape', owner: 'A',
    needsStorage: true,
    sql: 'insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3)',
    params: [BUCKET, `${A}/loose.png`, '{"size": 10}'],
    expect: { errorCode: '42501' },
  });
  add({
    name: 'storage: A cannot upload deeper than a project folder',
    as: 'A', table: 'storage.objects', sim: 'storage-bad-shape', owner: 'A',
    needsStorage: true,
    sql: 'insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3)',
    params: [BUCKET, `${A}/${PROJECT_ID.A}/nested/deep.png`, '{"size": 10}'],
    expect: { errorCode: '42501' },
  });

  // ---- the 300 MB cap ----
  add({
    name: `storage: A's usage counts A's files and nobody else's`,
    as: 'A', table: 'storage.objects', sim: 'used-own', owner: 'A',
    needsStorage: true,
    // B has 320 MB in the same bucket. If this returned anything other than
    // A's own few kilobytes, the cap would be shared rather than per user.
    sql: 'select viralradar.storage_used()::int as used',
    params: [],
    expect: { rows: [{ used: A_USED }] },
  });
  add({
    name: 'storage: A is under the cap, and the policy agrees',
    as: 'A', table: 'storage.objects', sim: 'cap-under', owner: 'A',
    needsStorage: true,
    sql: 'select viralradar.storage_under_cap() as under',
    params: [],
    expect: { rows: [{ under: true }] },
  });
  add({
    name: 'storage: B is over the cap',
    as: 'B', table: 'storage.objects', sim: 'cap-over', owner: 'B',
    needsStorage: true,
    sql: 'select viralradar.storage_under_cap() as under',
    params: [],
    expect: { rows: [{ under: false }] },
  });
  add({
    name: 'storage: B cannot upload while over the cap, even into their own folder',
    as: 'B', table: 'storage.objects', sim: 'cap-refuses-upload', owner: 'B',
    needsStorage: true,
    // Everything else about this upload is correct: own prefix, right shape,
    // on the allowlist. The only thing wrong with it is the 300 MB.
    sql: 'insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3)',
    params: [BUCKET, objectPath(B, PROJECT_ID.B, 'one-more.png'), '{"size": 10}'],
    expect: { errorCode: '42501' },
  });
  add({
    name: "storage: C's usage reads as nothing, whatever is in the bucket",
    as: 'C', table: 'storage.objects', sim: 'used-not-allowed', owner: null,
    needsStorage: true,
    // The function is SECURITY DEFINER, so it is the filter in its body that
    // has to hold here rather than any policy.
    sql: 'select viralradar.storage_used()::int as used',
    params: [],
    expect: { rows: [{ used: 0 }] },
  });

  // ---- signed in but not a ViralRadar user, and not signed in at all ----
  add({
    name: 'storage: C is signed in but not on the allowlist, and sees no files',
    as: 'C', table: 'storage.objects', sim: 'storage-not-allowed-select', owner: null,
    needsStorage: true,
    sql: 'select name from storage.objects where bucket_id = $1',
    params: [BUCKET],
    expect: { rowCount: 0 },
  });
  add({
    name: 'storage: C cannot upload anything, not even into a folder of its own',
    as: 'C', table: 'storage.objects', sim: 'storage-not-allowed-insert', owner: 'C',
    needsStorage: true,
    sql: 'insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3)',
    params: [BUCKET, objectPath(C, PROJECT_ID.C, 'c.png'), '{"size": 10}'],
    expect: { errorCode: '42501' },
  });
  add({
    name: 'storage: anon (not signed in) sees no files',
    as: 'anon', table: 'storage.objects', sim: 'storage-anon', owner: null,
    needsStorage: true,
    // storage.objects is the Storage extension's, shared with the other app,
    // and whether anon has table privileges on it is their business rather
    // than ours. Both possible answers mean the same thing here — nothing is
    // visible — so the assertion accepts either, instead of pinning one and
    // failing the day a Supabase upgrade changes it. What it will not accept
    // is a single row coming back.
    sql: 'select name from storage.objects where bucket_id = $1',
    params: [BUCKET],
    expect: { nothingVisible: true },
  });

  // ---- the bucket's own settings ----
  // Read as the owner, not as a user: this is configuration, not isolation.
  // It is here because the 25 MB per-file limit is the ONE limit the Storage
  // API can enforce before the bytes are transferred, and nothing else in this
  // suite would notice if it were missing.
  // The delete policy, read out of the catalogue for its verb and all four
  // gates. This is the other half of covering a policy that cannot be
  // exercised with SQL — and unlike the file-based test in the offline suite,
  // it reads what the database actually has.
  add({
    name: 'storage: the delete policy exists, for DELETE, with all four gates',
    as: 'owner', table: 'storage.objects', sim: 'storage-delete-policy', owner: null,
    needsStorage: true,
    sql: `select count(*)::int as n from pg_policies
          where schemaname = 'storage' and tablename = 'objects'
            and policyname = 'vr_project_files_delete'
            and cmd = 'DELETE'
            and qual like '%vr-project-files%'
            and qual like '%foldername%'
            and qual like '%auth.uid()%'
            and qual like '%is_allowed%'`,
    params: [],
    expect: { rows: [{ n: 1 }] },
  });

  add({
    name: 'storage: the bucket is private and limits one file to 25 MB',
    as: 'owner', table: 'storage.buckets', sim: 'bucket-config', owner: null,
    sql: 'select public as is_public, file_size_limit::int as limit_bytes from storage.buckets where id = $1',
    params: [BUCKET],
    expect: { rows: [{ is_public: false, limit_bytes: 26214400 }] },
  });

  // ---- the 14-day cleanup ----
  add({
    name: 'cleanup: a file from a project posted 30 days ago is due, and a 3-day-old one is not',
    as: 'A', table: 'project_items', sim: 'cleanup-due', owner: 'A',
    // A has a file in each. Exactly one row coming back is what says the
    // fortnight is being applied rather than "posted" alone.
    sql: 'select storage_path from viralradar.project_files_due($1, 14)',
    params: [A],
    expect: { rows: [{ storage_path: objectPath(A, PROJECT_ID.A_POSTED_OLD, 'old.png') }] },
  });
  add({
    name: 'cleanup: with a 60-day retention, nothing is due yet',
    as: 'A', table: 'project_items', sim: 'cleanup-retention', owner: 'A',
    // Proves the period is really a parameter, rather than the function
    // returning every posted file whatever it is asked.
    sql: 'select storage_path from viralradar.project_files_due($1, 60)',
    params: [A],
    expect: { rowCount: 0 },
  });
  add({
    name: "cleanup: A cannot find out which of B's files are due",
    as: 'A', table: 'project_items', sim: 'cleanup-other', owner: 'B',
    // B has a long-posted folder with a file in it, so there IS something to
    // find. SECURITY INVOKER is what means the policies still hide it.
    sql: 'select storage_path from viralradar.project_files_due($1, 14)',
    params: [B],
    expect: { rowCount: 0 },
  });
  add({
    name: 'cleanup: C cannot find out which files are due for anyone',
    as: 'C', table: 'project_items', sim: 'cleanup-not-allowed', owner: null,
    sql: 'select storage_path from viralradar.project_files_due($1, 14)',
    params: [A],
    expect: { rowCount: 0 },
  });

  // ---- videos, which are recorded but never stored ----
  //
  // A video_ref is the one row in this schema that makes a claim about
  // something the database cannot see: a file on two devices, and that it
  // arrived unchanged. So the constraints are the strictest here, and these
  // assertions are about the constraints rather than about the policies.
  const videoCols = 'user_id, id, project_id, kind, file_name, size_bytes, sha256, devices';
  const DIGEST = 'a'.repeat(64);

  add({
    name: 'video_ref: a two gigabyte video can be recorded, because no bytes are stored',
    as: 'A', table: 'project_items', sim: 'video-ref-own', owner: 'A',
    // The 25 MB limit is about Storage. If it applied here, the one thing Part 2
    // exists for could never be written down.
    sql: `insert into viralradar.project_items (${videoCols})
          values ($1, $2, '${PROJECT_ID.A}', 'video_ref', 'export.mp4', 2147483648, $3, array['Laptop','Phone'])
          returning id`,
    params: [A, 'ffff0010-0000-4000-8000-00000000ffff', DIGEST],
    expect: { rowCount: 1 },
  });
  add({
    name: 'video_ref: one that points at a file in Storage is refused',
    as: 'A', table: 'project_items', sim: 'video-ref-stored', owner: 'A',
    // A storage_path would mean a download button for bytes that are not there
    // — and would be a way to smuggle a 2 GB row past the size limit.
    sql: `insert into viralradar.project_items (${videoCols}, storage_path)
          values ($1, $2, '${PROJECT_ID.A}', 'video_ref', 'export.mp4', 2147483648, $3, array['Laptop'], $4)`,
    params: [A, 'ffff0011-0000-4000-8000-00000000ffff', DIGEST, objectPath(A, PROJECT_ID.A, 'export.mp4')],
    expect: { errorCode: '23514' },
  });
  add({
    name: 'video_ref: one with no digest is refused, because it would claim to be verified',
    as: 'A', table: 'project_items', sim: 'video-ref-undigested', owner: 'A',
    sql: `insert into viralradar.project_items (user_id, id, project_id, kind, file_name, size_bytes, devices)
          values ($1, $2, '${PROJECT_ID.A}', 'video_ref', 'export.mp4', 2147483648, array['Laptop'])`,
    params: [A, 'ffff0012-0000-4000-8000-00000000ffff'],
    expect: { errorCode: '23514' },
  });
  add({
    name: 'video_ref: one held by no device is refused',
    as: 'A', table: 'project_items', sim: 'video-ref-nowhere', owner: 'A',
    sql: `insert into viralradar.project_items (${videoCols})
          values ($1, $2, '${PROJECT_ID.A}', 'video_ref', 'export.mp4', 2147483648, $3, array[]::text[])`,
    params: [A, 'ffff0013-0000-4000-8000-00000000ffff', DIGEST],
    expect: { errorCode: '23514' },
  });
  add({
    name: 'video_ref: C cannot record a video, even in a folder of its own',
    as: 'C', table: 'project_items', sim: 'video-ref-not-allowed', owner: 'C',
    sql: `insert into viralradar.project_items (${videoCols})
          values ($1, $2, '${PROJECT_ID.C}', 'video_ref', 'export.mp4', 100, $3, array['Phone'])`,
    params: [C, 'ffff0014-0000-4000-8000-00000000ffff', DIGEST],
    expect: { errorCode: '42501' },
  });
  add({
    name: "video_ref: A cannot see how many videos B has recorded",
    as: 'A', table: 'project_items', sim: 'video-totals-other', owner: 'B',
    sql: 'select videos::int from viralradar.project_video_totals($1)',
    params: [B],
    expect: { rowCount: 0 },
  });

  // ---- the private channel the two devices signal on ----
  //
  // WHAT THESE CAN AND CANNOT PROVE
  //   realtime.topic() reads a setting the Realtime server puts on the
  //   connection, and this suite is talking to Postgres directly — so the
  //   setting can be made here, and the gate the policy applies really is
  //   exercised against real auth.uid() and real is_allowed() values.
  //
  //   What is NOT proved is that Realtime consults the policy at all; that is
  //   the Realtime server's behaviour and only two real devices can show it.
  //   So the policies themselves are also read back out of the catalogue, as
  //   configuration, rather than being taken on trust from the migration file.
  const gate = (topic) => `with chosen as materialized (select set_config('realtime.topic', ${topic}, true))
     select (realtime.topic() = 'vr-devices-' || auth.uid()::text
             and (select viralradar.is_allowed())) as allowed
     from chosen`;

  for (const me of ['A', 'B']) {
    const them = OTHER[me];
    add({
      name: `signalling: ${me} is allowed on ${me}'s own channel`,
      as: me, table: 'realtime.messages', sim: 'signal-own', owner: me,
      sql: gate('$1'),
      params: [`vr-devices-${uid[me]}`],
      expect: { rows: [{ allowed: true }] },
    });
    add({
      name: `signalling: ${me} is not allowed on ${them}'s channel`,
      as: me, table: 'realtime.messages', sim: 'signal-other', owner: them,
      // The topic IS the authorisation. Being able to guess the name of
      // someone else's channel must buy nothing: a session description
      // carries both devices' IP addresses.
      sql: gate('$1'),
      params: [`vr-devices-${uid[them]}`],
      expect: { rows: [{ allowed: false }] },
    });
  }
  add({
    name: 'signalling: a channel name that is not a user id is allowed to nobody',
    as: 'A', table: 'realtime.messages', sim: 'signal-junk', owner: null,
    sql: gate("'vr-devices-everyone'"),
    params: [],
    expect: { rows: [{ allowed: false }] },
  });
  add({
    name: 'signalling: C is signed in but not on the allowlist, and is allowed on no channel',
    as: 'C', table: 'realtime.messages', sim: 'signal-not-allowed', owner: 'C',
    sql: gate('$1'),
    params: [`vr-devices-${C}`],
    expect: { rows: [{ allowed: false }] },
  });

  // The two policies really exist, named as expected, saying what they should.
  // Read as the owner, from the catalogue rather than from the migration file:
  // this is the only check here that a migration was actually applied.
  add({
    name: 'signalling: the two policies exist on realtime.messages, for the right verbs',
    as: 'owner', table: 'realtime.messages', sim: 'signal-policies', owner: null,
    sql: `select policyname, cmd from pg_policies
          where schemaname = 'realtime' and tablename = 'messages'
            and policyname in ('vr_devices_read', 'vr_devices_write')
          order by policyname`,
    params: [],
    expect: { rows: [{ policyname: 'vr_devices_read', cmd: 'SELECT' }, { policyname: 'vr_devices_write', cmd: 'INSERT' }] },
  });
  add({
    name: 'signalling: both policies tie the channel to the caller and check the allowlist',
    as: 'owner', table: 'realtime.messages', sim: 'signal-policy-text', owner: null,
    sql: `select count(*)::int as n from pg_policies
          where schemaname = 'realtime' and tablename = 'messages'
            and policyname in ('vr_devices_read', 'vr_devices_write')
            and (coalesce(qual, '') || coalesce(with_check, '')) like '%vr-devices-%'
            and (coalesce(qual, '') || coalesce(with_check, '')) like '%auth.uid()%'
            and (coalesce(qual, '') || coalesce(with_check, '')) like '%is_allowed%'`,
    params: [],
    expect: { rows: [{ n: 2 }] },
  });

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
        // Deliberately no RETURNING. RETURNING also needs the SELECT policy, so
        // with it this statement would still be refused even once the INSERT
        // policy was wide open, and the proof would prove nothing.
        name: 'ideas: B cannot insert a row owned by A, even without reading it back',
        as: 'B', table: 'ideas', sim: 'insert-other-silent', owner: 'A',
        sql: "insert into viralradar.ideas (user_id, id, title, source) values ($1, 'proof-row', 'planted', 'manual')",
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
        // No RETURNING, for the same reason as the proof above.
        name: 'ideas: C cannot create anything, even without reading it back',
        as: 'C', table: 'ideas', sim: 'not-allowed-insert-silent', owner: 'C',
        sql: "insert into viralradar.ideas (user_id, id, title, source) values ($1, 'proof-row-c', 'planted by C', 'manual')",
        params: [C],
        expect: { errorCode: '42501' },
      },
      why: 'without the is_allowed() gate, anyone with an account in this shared project becomes a ViralRadar user, so the assertion must fail',
      modelLeak: 'no-allowlist-gate',
    },
    {
      name: 'dropping vr_project_files_select must break "A can see their own files"',
      breakSql: 'drop policy vr_project_files_select on storage.objects',
      check: {
        name: 'storage: A can see their own files',
        as: 'A', table: 'storage.objects', sim: 'storage-select-own', owner: 'A',
        needsStorage: true,
        sql: 'select name from storage.objects where bucket_id = $1 and name like $2',
        params: [BUCKET, `${A}/%`],
        expect: { minRows: 1 },
      },
      why: 'with no select policy for this bucket, even the owner of a file is denied, so the assertion must fail',
      modelLeak: 'no-storage-select',
    },
    {
      name: 'widening vr_project_files_select to the whole bucket must break "A cannot see B\'s files"',
      // The prefix check is the only thing separating two users inside one
      // bucket, so this is the mistake worth being able to detect.
      breakSql: "alter policy vr_project_files_select on storage.objects using (bucket_id = 'vr-project-files')",
      check: {
        name: "storage: A cannot see B's files",
        as: 'A', table: 'storage.objects', sim: 'storage-select-other', owner: 'B',
        needsStorage: true,
        sql: 'select name from storage.objects where bucket_id = $1 and name like $2',
        params: [BUCKET, `${B}/%`],
        expect: { rowCount: 0 },
      },
      why: "a policy scoped to the bucket but not to the prefix shows B's files to A, so the assertion must fail",
      modelLeak: 'storage-select',
    },
    {
      name: 'removing the cap from vr_project_files_insert must break "B cannot upload while over the cap"',
      // Everything except the cap is left in place, so this proves the cap
      // specifically rather than the policy in general.
      breakSql: "alter policy vr_project_files_insert on storage.objects with check ("
        + "bucket_id = 'vr-project-files'"
        + " and (storage.foldername(name))[1] = auth.uid()::text"
        + ' and array_length(storage.foldername(name), 1) = 2'
        + ' and (select viralradar.is_allowed()))',
      check: {
        // No RETURNING: reading the row back needs the SELECT policy, which
        // would allow it here, but keeping the two apart is the habit that
        // stopped the allowlist proof from proving nothing.
        name: 'storage: B cannot upload while over the cap, even into their own folder',
        as: 'B', table: 'storage.objects', sim: 'cap-refuses-upload', owner: 'B',
        needsStorage: true,
        sql: 'insert into storage.objects (bucket_id, name, metadata) values ($1, $2, $3)',
        params: [BUCKET, objectPath(B, PROJECT_ID.B, 'one-more.png'), '{"size": 10}'],
        expect: { errorCode: '42501' },
      },
      why: 'without the cap, ViralRadar can fill a shared project past its 300 MB slice, so the assertion must fail',
      modelLeak: 'no-cap',
    },
  ];
}

/** Did a statement's outcome match what the assertion expected? */
export function matches(expect, outcome) {
  // A refusal recognised by its MESSAGE rather than its SQLSTATE. Needed
  // because Supabase's guard on storage.objects raises 42501 — the same code as
  // an RLS refusal — so "rejected with 42501" cannot tell the two apart, and an
  // assertion that accepted either would pass for the wrong reason.
  if (expect.errorMatches) {
    if (!outcome.errorCode) {
      return { ok: false, detail: `expected a refusal mentioning "${expect.errorMatches}", but the statement succeeded with ${outcome.rowCount} row(s)` };
    }
    return (outcome.errorMessage || '').includes(expect.errorMatches)
      ? { ok: true, detail: `refused with ${outcome.errorCode}: ${outcome.errorMessage}` }
      : { ok: false, detail: `expected a refusal mentioning "${expect.errorMatches}", got ${outcome.errorCode}: ${outcome.errorMessage || ''}`.trim() };
  }

  // "This role gets nothing", however the database chooses to say it: no rows,
  // or refused outright. Used for anon against storage.objects, where whether
  // the role has table privileges at all is the Storage extension's business
  // and not ViralRadar's — both answers mean the same thing to us, and pinning
  // one would make the suite fail on a Supabase upgrade that changed it.
  if (expect.nothingVisible) {
    if (outcome.errorCode) return { ok: true, detail: `refused outright (${outcome.errorCode})` };
    return outcome.rowCount === 0
      ? { ok: true, detail: '0 row(s)' }
      : { ok: false, detail: `expected nothing to be visible, got ${outcome.rowCount} row(s)` };
  }

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
