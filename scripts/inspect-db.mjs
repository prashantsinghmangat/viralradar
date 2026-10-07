// Read-only look at the Supabase project, so we can plan around the app that
// is already in it instead of guessing.
//
//   npm run inspect:db
//
// This only ever runs SELECT statements. It creates nothing, changes nothing
// and deletes nothing. Paste the output back and it tells us: which schemas and
// tables already exist, whether anything is managed by the Supabase CLI,
// whether the other app uses auth, what extensions and cron jobs are set up,
// and whether the viralradar schema has been created yet.
import 'dotenv/config';
import postgres from 'postgres';

const HELP = `
Read-only inspection of your Supabase project.

  npm run inspect:db

Needs DATABASE_URL in .env. Use the "Session pooler" connection string from
Project Settings -> Database -> Connection string -> Session pooler, because
the direct connection is IPv6-only and usually fails on a home network.

Nothing is written. Every statement is a SELECT.
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

const db = postgres(url, { ssl: 'require', max: 1, prepare: false, connect_timeout: 30, onnotice: () => {} });

const line = (s = '') => console.log(s);
const head = (s) => { line(); line(s); line('-'.repeat(s.length)); };

// Any query may fail on a hosted project (missing extension, no permission).
// Say so and carry on rather than giving up the whole report.
async function safely(label, fn) {
  try {
    return await fn();
  } catch (e) {
    line(`  (could not read ${label}: ${(e.message || '').split('\n')[0]})`);
    return null;
  }
}

async function main() {
  line();
  line('ViralRadar - read-only inspection of the Supabase project');
  line(`host: ${new URL(url).host}`);

  head('PostgreSQL version');
  await safely('the version', async () => {
    const [{ version }] = await db`select version()`;
    line('  ' + version.split(',')[0]);
  });

  head('Schemas (excluding system and Supabase internals)');
  await safely('schemas', async () => {
    const rows = await db`
      select n.nspname as schema,
             (select count(*) from pg_class c
               where c.relnamespace = n.oid and c.relkind in ('r', 'p')) as tables
      from pg_namespace n
      where n.nspname not like 'pg_%'
        and n.nspname not in ('information_schema', 'auth', 'storage', 'realtime', 'vault',
                              'supabase_migrations', 'supabase_functions', 'extensions',
                              'graphql', 'graphql_public', 'pgbouncer', '_realtime', 'net', 'cron', 'pgsodium', 'pgsodium_masks')
      order by n.nspname`;
    for (const r of rows) line(`  ${r.schema.padEnd(24)} ${r.tables} table(s)`);
    const hasVr = rows.some((r) => r.schema === 'viralradar');
    line();
    line(`  viralradar schema: ${hasVr ? 'ALREADY EXISTS (migrations have been pushed)' : 'not created yet'}`);
  });

  head('Tables outside viralradar (the other app, so we avoid its names)');
  await safely('tables', async () => {
    const rows = await db`
      select schemaname as schema, relname as table, n_live_tup as approx_rows
      from pg_stat_user_tables
      where schemaname not in ('viralradar')
        and schemaname not like 'pg_%'
        and schemaname not in ('auth', 'storage', 'realtime', '_realtime', 'supabase_migrations',
                               'supabase_functions', 'extensions', 'vault', 'cron', 'net', 'pgsodium')
      order by schemaname, relname`;
    if (!rows.length) line('  (none - the database has no other app tables)');
    for (const r of rows) line(`  ${r.schema}.${r.table}`.padEnd(46) + `~${r.approx_rows} row(s)`);
  });

  head('Does the other app use Supabase Auth?');
  await safely('auth.users', async () => {
    const [{ n }] = await db`select count(*)::int as n from auth.users`;
    line(`  auth.users holds ${n} account(s)`);
    if (n === 0) line('  -> nobody is registered yet, so turning signups off after you register costs nothing');
  });
  await safely('triggers on auth.users', async () => {
    const rows = await db`
      select t.tgname as trigger, p.proname as function, n.nspname as function_schema
      from pg_trigger t
      join pg_class c on c.oid = t.tgrelid
      join pg_namespace cn on cn.oid = c.relnamespace
      join pg_proc p on p.oid = t.tgfoid
      join pg_namespace n on n.oid = p.pronamespace
      where cn.nspname = 'auth' and c.relname = 'users' and not t.tgisinternal
      order by t.tgname`;
    if (!rows.length) line('  no triggers on auth.users (nothing of the other app runs on signup)');
    for (const r of rows) line(`  trigger ${r.trigger} -> ${r.function_schema}.${r.function}()`);
  });

  head('Supabase CLI migration history');
  await safely('supabase_migrations.schema_migrations', async () => {
    const rows = await db`
      select version, name from supabase_migrations.schema_migrations order by version`;
    if (!rows.length) {
      line('  the history table exists but is empty');
      line('  -> the other app was built in the dashboard; my migrations will be the only recorded history');
      return;
    }
    line(`  ${rows.length} migration(s) already recorded:`);
    for (const r of rows) line(`    ${r.version}  ${r.name || ''}`.trimEnd());
    line();
    line('  -> history is shared. Pushing from this repo is still safe (push only adds),');
    line('     but never run "supabase db reset", and do not expect "db pull" or "db diff"');
    line('     from the other repo to look clean afterwards.');
  });

  head('Extensions the cloud version needs');
  await safely('extensions', async () => {
    const rows = await db`
      select e.extname as name, n.nspname as schema, e.extversion as version
      from pg_extension e join pg_namespace n on n.oid = e.extnamespace
      order by e.extname`;
    const have = new Set(rows.map((r) => r.name));
    for (const r of rows) line(`  ${r.name.padEnd(22)} ${String(r.version).padEnd(10)} in ${r.schema}`);
    line();
    for (const needed of ['pg_cron', 'pg_net', 'supabase_vault']) {
      line(`  ${needed.padEnd(22)} ${have.has(needed) ? 'installed' : 'NOT installed yet (the daily refresh step will enable it)'}`);
    }
  });

  head('Scheduled jobs (pg_cron)');
  await safely('cron.job', async () => {
    const rows = await db`select jobid, jobname, schedule, active from cron.job order by jobid`;
    if (!rows.length) line('  no cron jobs yet');
    for (const r of rows) line(`  [${r.jobid}] ${String(r.jobname || '(unnamed)').padEnd(30)} ${r.schedule}  ${r.active ? 'active' : 'paused'}`);
  });

  head('Realtime publication');
  await safely('publications', async () => {
    const rows = await db`
      select p.pubname as publication, n.nspname as schema, c.relname as table
      from pg_publication p
      left join pg_publication_rel pr on pr.prpubid = p.oid
      left join pg_class c on c.oid = pr.prrelid
      left join pg_namespace n on n.oid = c.relnamespace
      order by p.pubname, n.nspname, c.relname`;
    if (!rows.length) line('  no publications');
    for (const r of rows) line(`  ${r.publication}: ${r.table ? `${r.schema}.${r.table}` : '(no tables)'}`);
  });

  head('Database size against the 500 MB free limit');
  await safely('the database size', async () => {
    const [{ size, bytes }] = await db`
      select pg_size_pretty(pg_database_size(current_database())) as size,
             pg_database_size(current_database()) as bytes`;
    const pct = Math.round((Number(bytes) / (500 * 1024 * 1024)) * 100);
    line(`  ${size} used, roughly ${pct}% of the free tier's 500 MB`);
  });

  line();
  line('Done. Nothing was changed. Paste this back and I will adjust the plan to fit.');
  line();
  line('One thing this cannot see: the Data API "Exposed schemas" setting, which');
  line('lives in the dashboard (Project Settings -> API). The browser needs');
  line('"viralradar" added there before the app can read anything.');
  line();
}

main()
  .catch((e) => {
    console.error(`\nCould not inspect the database: ${e.message}`);
    if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/.test(e.message || '')) {
      console.error('\nThat looks like a connection problem. Use the "Session pooler" string');
      console.error('from the dashboard: the direct connection is IPv6-only and usually will');
      console.error('not work from a home network.');
    }
    process.exitCode = 2;
  })
  .finally(async () => {
    try { await db.end({ timeout: 5 }); } catch { /* already closed */ }
  });
