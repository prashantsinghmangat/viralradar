// Checks a Supabase DATABASE_URL before anything tries to connect with it, so
// the common mistakes come back as one plain sentence instead of a timeout or
// an authentication error ten seconds later.
//
// Supabase offers three connection strings and they look almost identical:
//
//   Direct connection     db.<ref>.supabase.co:5432          IPv6 only
//   Transaction pooler    <region>.pooler.supabase.com:6543   no session state
//   Session pooler        <region>.pooler.supabase.com:5432   what we need
//
// We need the Session pooler: it reaches a home network over IPv4, and it keeps
// one real server connection for the whole session, which SET LOCAL ROLE in the
// RLS test depends on.

export const PLACEHOLDERS = ['[your-password]', 'your-password', 'your-db-password', 'password', '[password]'];

// Characters that must be percent-encoded inside a URL's password.
const NEEDS_ENCODING = ['@', '/', '?', '#', '[', ']', ' ', '%'];

const ENCODINGS = '@ becomes %40, / becomes %2F, # becomes %23, ? becomes %3F, a space becomes %20, % becomes %25';

// What is left after removing the valid %XX escapes. A password written
// correctly as pa%40ss leaves "pass"; a raw % or @ is still there to be found.
const unescaped = (raw) => raw.replace(/%[0-9a-fA-F]{2}/g, '');

// decodeURIComponent throws on a stray % (for example "pa%ss"), which is
// exactly the kind of password that brings someone here. Never let it crash.
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s || '');
  } catch {
    return s || '';
  }
};

export function describe(raw) {
  const out = { ok: false, kind: 'unknown', problems: [], warnings: [], host: null, port: null, user: null };

  const url = String(raw || '').trim();
  if (!url) {
    out.problems.push('DATABASE_URL is empty.');
    return out;
  }
  if (!/^postgres(ql)?:\/\//i.test(url)) {
    out.problems.push('DATABASE_URL must start with postgresql:// — copy the whole string, including that part.');
    return out;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    out.problems.push(
      'DATABASE_URL could not be read as a URL. This nearly always means the password contains a character\n'
      + `  that has to be percent-encoded: ${ENCODINGS}.\n`
      + '  The easy fix is to reset the database password to one with only letters and numbers\n'
      + '  (Project Settings -> Database -> Reset database password).');
    return out;
  }

  out.host = parsed.hostname;
  out.port = parsed.port || '5432';
  out.user = safeDecode(parsed.username);
  const password = safeDecode(parsed.password);

  // Which of the three strings is this?
  if (/\.pooler\.supabase\.com$/i.test(out.host)) {
    out.kind = out.port === '6543' ? 'transaction-pooler' : 'session-pooler';
  } else if (/^db\..*\.supabase\.(co|net)$/i.test(out.host)) {
    out.kind = 'direct';
  } else if (/^(localhost|127\.0\.0\.1)$/i.test(out.host)) {
    out.kind = 'local';
  }

  if (out.kind === 'direct') {
    out.problems.push(
      'This is the "Direct connection" string. It is IPv6-only and usually will not work from a home network.\n'
      + '  Use the "Session pooler" tab instead: the host ends in .pooler.supabase.com and the port is 5432.');
  }
  if (out.kind === 'transaction-pooler') {
    // Not refused: every statement these scripts run is inside a transaction,
    // and SET LOCAL / set_config(..., true) are transaction-scoped, so this
    // should work. Session pooler is still the one to prefer.
    out.warnings.push(
      'This is the "Transaction pooler" string (port 6543). It should still work here, because everything\n'
      + '  these scripts do happens inside a transaction, but the "Session pooler" string (same host, port 5432)\n'
      + '  is the one to prefer. If you see odd connection errors, switch to it.');
  }
  if (out.kind === 'unknown') {
    out.warnings.push(`The host ${out.host} is not a Supabase address. Carrying on, but double-check you copied the right string.`);
  }

  if (!password) {
    out.problems.push('The connection string has no password in it. Supabase shows it as [YOUR-PASSWORD] — replace that with your real database password.');
  } else if (PLACEHOLDERS.includes(password.toLowerCase())) {
    out.problems.push(`The password is still the placeholder "${password}". Replace it with your real database password (Project Settings -> Database).`);
  } else {
    // Look only at what is NOT already a valid %XX escape, so a password
    // written correctly as pa%40ss is not reported as a problem.
    const offenders = NEEDS_ENCODING.filter((c) => unescaped(parsed.password).includes(c));
    if (offenders.length) {
      out.warnings.push(
        `The password contains ${offenders.map((c) => (c === ' ' ? 'a space' : c)).join(', ')}, which must be percent-encoded in a URL`
        + ` (${ENCODINGS}).`
        + '\n  If the connection fails, that is almost certainly why. Resetting the database password to one with only letters and numbers is the easy fix.');
    }
  }

  // The pooler username carries the project ref: postgres.<ref>
  if (out.kind.endsWith('pooler') && !/^postgres\.[a-z0-9]+$/i.test(out.user)) {
    out.warnings.push(`The username is "${out.user}". A pooler string normally has postgres.<project-ref>. Copy the whole string from the dashboard rather than editing it by hand.`);
  }

  out.ok = out.problems.length === 0;
  return out;
}

/** One block of text to print when the string is wrong. */
export function explain(info) {
  const lines = [];
  for (const p of info.problems) lines.push('  ' + p);
  for (const w of info.warnings) lines.push('  Note: ' + w);
  return lines.join('\n');
}

export const WHERE_TO_FIND = `
Where to find the right string:
  1. Open your project in the Supabase dashboard.
  2. Click "Connect" at the top of the page (next to the branch name).
  3. Pick the "Direct / Connection string" tab. That tab means "connect straight
     to Postgres" rather than through a client library; it is not only the
     direct-connection string.
  4. Use the pooled string, labelled "Shared pooler" (older wording: "Session
     pooler"). Copy it and replace [YOUR-PASSWORD] with your database password.

  The right one looks like:
    postgresql://postgres.<project-ref>:<password>@aws-<n>-<region>.pooler.supabase.com:5432/postgres
  host ends in .pooler.supabase.com, port is 5432, user is postgres.<project-ref>
`;
