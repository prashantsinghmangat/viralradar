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
import {
  BUCKET, INBOX_TITLE, PROJECT_STATUS,
  checkUpload, escapeLikePattern, kindForFile, kindForText, safeFileName, sha256Hex, storagePath, titleForScript, usageSummary,
} from './shared/projects.mjs';
import { deviceTopic, readSignal, videoRefRow } from './shared/transfer.mjs';

export const TABLES = { ideas: 'ideas', scripts: 'scripts', results: 'results', trends: 'trends' };
export const LIVE_TABLES = ['ideas', 'scripts', 'results'];
// Project folders live on their own channel: an item arriving from the other
// device gets its own toast naming the device, rather than the generic
// "updated from another device" the three tables above share.
export const PROJECT_LIVE_TABLES = ['projects', 'project_items'];

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

    /**
     * "Just save the idea" — New Project's third mode. No AI call: this is
     * a row typed by hand, source 'manual', exactly like anything else a
     * person enters rather than imports or generates.
     */
    async create({ title, details, links = [] } = {}) {
      const name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!name) throw new Error('Give the idea a title.');
      const row = {
        id: crypto.randomUUID(),
        title: name,
        status: 'new',
        source: 'manual',
        raw: { title: name, details: String(details ?? '').trim(), links },
      };
      const rows = await run(client.from('ideas').insert(row).select('*'), 'save that idea');
      return rows && rows[0];
    },
  };

  // ---------- scripts ----------

  const scripts = {
    list: () => run(
      client.from('scripts').select('id, topic, title, yt_title, thumbnail_text, stage, language, own_idea, origin_at, updated_at')
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

  // ---------- project folders ----------
  //
  // One folder per video, holding notes, links and files. Raw video is never
  // uploaded: this Supabase project is shared and its whole file quota is
  // about 1 GB, so ViralRadar keeps to a 300 MB slice and sends video device
  // to device instead.
  //
  // Every limit checked here is also enforced by the database and by the
  // bucket's own settings. This layer exists to refuse before spending
  // someone's mobile data, and to say which limit it was.

  const projects = {
    /** Folder cards, newest first, each with what is inside it. */
    async list() {
      const [rows, items] = await Promise.all([
        run(
          client.from('projects').select('*').order('origin_at', { ascending: false }),
          'load your projects',
        ),
        // Only the columns a card needs. "preview" is a generated column
        // holding a short line of whatever the item is, so drawing the folder
        // list never reads a note in full — one can be 20,000 characters, and
        // a few hundred of them is megabytes to draw a list of folders.
        run(
          client.from('project_items').select('id, project_id, kind, preview, file_name, size_bytes, from_device, created_at')
            .order('created_at', { ascending: false }),
          'load what is in your projects',
        ),
      ]);
      const byProject = new Map();
      for (const item of items || []) {
        if (!byProject.has(item.project_id)) byProject.set(item.project_id, []);
        byProject.get(item.project_id).push(item);
      }
      return (rows || []).map((p) => {
        const own = byProject.get(p.id) || [];
        return {
          ...p,
          item_count: own.length,
          bytes: own.reduce((n, i) => n + (Number(i.size_bytes) || 0), 0),
          // Already newest-first from the query above.
          latest: own[0] || null,
        };
      });
    },

    async get(id) {
      const rows = await run(client.from('projects').select('*').eq('id', id).limit(1), 'open that project');
      if (!rows || !rows.length) throw new Error('That project is no longer there.');
      return rows[0];
    },

    items: (projectId) => run(
      client.from('project_items').select('*').eq('project_id', projectId)
        .order('created_at', { ascending: false }),
      'load what is in that project',
    ),

    async create({ title, scriptId = null, ownIdea = false } = {}) {
      const name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!name) throw new Error('Give the project a name.');
      const rows = await run(
        client.from('projects').insert({ title: name, script_id: scriptId, own_idea: ownIdea === true }).select('*'),
        'create that project',
      );
      return rows && rows[0];
    },

    /**
     * The one folder a share with no particular destination lands in.
     *
     * Created on first use, the same way the settings row is and for the same
     * reason: this Supabase project is shared with another app, so a trigger on
     * auth.users would fire for its signups too. The partial unique index on
     * is_inbox means two devices racing to create it end up with one folder,
     * not two — the loser's insert is refused and it reads the winner's.
     */
    async inbox() {
      const existing = await run(
        client.from('projects').select('*').eq('is_inbox', true).limit(1),
        'find your Inbox',
      );
      if (existing && existing.length) return existing[0];
      try {
        const rows = await run(
          client.from('projects').insert({ title: INBOX_TITLE, is_inbox: true }).select('*'),
          'create your Inbox',
        );
        if (rows && rows.length) return rows[0];
      } catch (e) {
        // Lost the race, or the index refused a second Inbox. Either way the
        // other one is the right answer.
        if (!/duplicate|unique|23505/i.test(e.message)) throw e;
      }
      const created = await run(
        client.from('projects').select('*').eq('is_inbox', true).limit(1),
        'find your Inbox',
      );
      if (!created || !created.length) throw new Error('Could not open your Inbox.');
      return created[0];
    },

    /**
     * Open the folder for a script, making it the first time.
     *
     * In order: a folder already linked to this script; else an unlinked
     * folder with the same title, case-insensitively — linked rather than
     * left alone, because that is the folder a research pack or a note
     * imported before the script existed would already have landed in, under
     * exactly this title (see shared/import-projects.mjs). Without this step,
     * opening the script's project after importing its research would make a
     * second folder with the same name instead of reusing the one that
     * already has the pack in it; only once neither exists is one created.
     */
    async forScript(script) {
      const scriptId = String(script?.id ?? '');
      if (!scriptId) throw new Error('That script has no id.');

      const linked = await run(
        client.from('projects').select('*').eq('script_id', scriptId).limit(1),
        'find that script\'s project',
      );
      if (linked && linked.length) return linked[0];

      const title = titleForScript(script);
      const unlinked = await run(
        client.from('projects').select('*').is('script_id', null).ilike('title', escapeLikePattern(title)).limit(1),
        'find a folder with that name',
      );
      if (unlinked && unlinked.length) {
        const rows = await run(
          client.from('projects').update({ script_id: scriptId }).eq('id', unlinked[0].id).select('*'),
          'link that folder to the script',
        );
        return rows && rows[0];
      }

      return projects.create({ title, scriptId });
    },

    async setStatus(id, status) {
      if (!PROJECT_STATUS.includes(status)) throw new Error(`Unknown status: ${status}`);
      const rows = await run(
        client.from('projects').update({ status }).eq('id', id).select('id, status, posted_at'),
        'change that project',
      );
      if (!rows || !rows.length) throw new Error('That project is no longer there.');
      return rows[0];
    },

    async rename(id, title) {
      const name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
      if (!name) throw new Error('Give the project a name.');
      const rows = await run(
        client.from('projects').update({ title: name }).eq('id', id).select('id, title'),
        'rename that project',
      );
      if (!rows || !rows.length) throw new Error('That project is no longer there.');
      return rows[0];
    },

    /**
     * Fix this project's local folder name in place, the first time its local
     * folder is made. Set once and never recomputed from the title afterwards
     * — see the migration and shared/localfolder.mjs's projectFolderName().
     */
    setLocalFolderName: (id, name) => run(
      client.from('projects').update({ local_folder_name: name }).eq('id', id).select('id, local_folder_name'),
      'remember that folder name',
    ),

    /**
     * Delete a folder and everything in it.
     *
     * The files go first. Deleting the rows first would work and look fine,
     * and leave the bytes in the bucket with nothing left pointing at them —
     * still counted against the quota this whole feature is careful about.
     */
    async remove(id) {
      // Checked here as well as hidden in the UI: the one folder a phone
      // share can always land in must always exist.
      const project = await projects.get(id);
      if (project.is_inbox) throw new Error('The Inbox cannot be deleted.');

      const items = await projects.items(id);
      const paths = (items || []).map((i) => i.storage_path).filter(Boolean);
      if (paths.length) {
        const { error } = await client.storage.from(BUCKET).remove(paths);
        if (error) throw new Error(readable(error, 'delete that project\'s files'));
      }
      const result = await run(client.from('projects').delete().eq('id', id), 'delete that project');
      if (paths.length) await client.storage.from(BUCKET).remove(paths);
      return result;
    },
  };

  const items = {
    /** A note, or a link if that is what it looks like. */
    async addText(projectId, text, fromDevice) {
      const content = String(text ?? '').trim();
      if (!content) throw new Error('Type something first.');
      if (content.length > 20000) throw new Error('That is too long to send as a note. Save it as a file instead.');
      const rows = await run(
        client.from('project_items').insert({
          project_id: projectId,
          kind: kindForText(content),
          content,
          from_device: fromDevice || null,
        }).select('*'),
        'send that',
      );
      return rows && rows[0];
    },

    /**
     * Upload a file into a folder.
     *
     * The order matters: bytes first, row second. A row written first would
     * describe a file that might never arrive, and the folder would show a
     * download button for nothing. This way a failed upload leaves no trace,
     * and a failed row insert leaves bytes that the next usage reading counts
     * honestly — so the cap stays truthful either way.
     */
    async addFile(projectId, file, { userId, fromDevice, usedBytes } = {}) {
      if (!file) throw new Error('No file was chosen.');
      if (!userId) throw new Error('Sign in again before uploading.');

      const used = usedBytes === undefined ? await storage.used() : usedBytes;
      const verdict = checkUpload({ size: file.size, usedBytes: used, fileName: file.name });
      if (!verdict.ok) throw new Error(verdict.message);

      const name = safeFileName(file.name);
      const path = storagePath(userId, projectId, name);
      const mime = file.type || 'application/octet-stream';

      const { error } = await client.storage.from(BUCKET).upload(path, file, {
        contentType: mime,
        upsert: false,
      });
      if (error) throw new Error(uploadFailed(error, verdict));

      // Computed from the bytes the browser holds, so it describes what was
      // sent rather than what the server says it received. Part 2 compares
      // these to prove a device-to-device transfer changed nothing.
      let sha256 = null;
      try {
        sha256 = await sha256Hex(await file.arrayBuffer());
      } catch {
        // A digest is worth having, never worth failing an upload over.
      }

      try {
        const rows = await run(
          client.from('project_items').insert({
            project_id: projectId,
            kind: kindForFile(mime, name),
            storage_path: path,
            file_name: name,
            mime,
            size_bytes: file.size,
            sha256,
            from_device: fromDevice || null,
          }).select('*'),
          'save that file',
        );
        return rows && rows[0];
      } catch (e) {
        // The bytes are up but nothing points at them. Take them back out, or
        // they sit in a shared quota forever with no way to find them.
        await client.storage.from(BUCKET).remove([path]).catch(() => {});
        throw e;
      }
    },

    /** A short-lived URL for one file. Nothing in this bucket is public. */
    async fileUrl(storagePathValue, seconds = 300) {
      const { data, error } = await client.storage.from(BUCKET).createSignedUrl(storagePathValue, seconds);
      if (error) throw new Error(readable(error, 'open that file'));
      return data?.signedUrl ?? null;
    },

    /**
     * Record that a video exists, and which devices hold it. Never the video.
     *
     * Sending the same video to the same folder twice should leave one note
     * listing both devices, not two notes. That is done by reading first and
     * merging rather than by a unique index: this row is written immediately
     * after a transfer that may have taken half an hour, and a constraint
     * violation at that moment would throw away the record of the one thing
     * that did work. A duplicate note is cosmetic; losing the note is not.
     */
    async addVideoRef({ projectId, name, size, sha256, devices, fromDevice }) {
      const row = videoRefRow({ projectId, name, size, sha256, devices, fromDevice });

      let existing = null;
      try {
        const found = await run(
          client.from('project_items').select('id, devices')
            .eq('project_id', projectId).eq('kind', 'video_ref').eq('sha256', sha256).limit(1),
          'look for that video',
        );
        existing = found && found[0];
      } catch {
        // Never a reason to lose the note. Worst case there are two of them.
      }

      if (existing) {
        const merged = [...new Set([...(existing.devices || []), ...row.devices])].sort();
        const rows = await run(
          client.from('project_items').update({ devices: merged, from_device: row.from_device })
            .eq('id', existing.id).select('*'),
          'record that video',
        );
        return rows && rows[0];
      }

      const rows = await run(client.from('project_items').insert(row).select('*'), 'record that video');
      return rows && rows[0];
    },

    /** Files first, then the row, for the same reason as everywhere else here. */
    async remove(item) {
      if (item?.storage_path) {
        const { error } = await client.storage.from(BUCKET).remove([item.storage_path]);
        // A file that is already gone is not a reason to keep the row.
        if (error && !/not found|404/i.test(error.message || '')) {
          throw new Error(readable(error, 'delete that file'));
        }
      }
      return run(client.from('project_items').delete().eq('id', item.id), 'delete that item');
    },
  };

  /**
   * A failed upload, explained.
   *
   * The Storage API refuses an oversized file with its own wording, and the
   * insert policy refuses one over the 300 MB cap with a bare "row-level
   * security" message. Neither tells anyone what to do, and the second is
   * especially misleading: nothing is wrong with the account.
   */
  function uploadFailed(error, verdict) {
    const message = error?.message || String(error);
    if (/exceeded the maximum allowed size|payload too large|413/i.test(message)) {
      return `That file is bigger than the 25 MB limit for one file.${verdict?.message ? ` ${verdict.message}` : ''}`;
    }
    if (/row-level security|permission denied|42501|Unauthorized/i.test(message)) {
      return 'That upload was refused. Either ViralRadar has used up its 300 MB of this shared project'
        + ' — Settings shows how much — or this account is not allowed to use ViralRadar.';
    }
    if (/already exists|Duplicate/i.test(message)) {
      return 'A file with that exact name and timestamp is already there. Try again.';
    }
    return readable(error, 'upload that file');
  }

  const storage = {
    /**
     * How many bytes ViralRadar is holding, from the bucket itself.
     *
     * Deliberately not a sum of project_items.size_bytes: an upload whose row
     * insert failed still occupies the shared quota, and a usage figure that
     * cannot see those bytes would let the cap be walked past.
     */
    async used() {
      const { data, error } = await client.rpc('storage_used');
      if (error) throw new Error(readable(error, 'check how much storage is used'));
      return Number(data) || 0;
    },
    async usage() {
      return usageSummary(await storage.used());
    },
    /** Delete files from projects posted more than a fortnight ago, now rather than tonight. */
    purge: () => callFunction('vr-purge-project-files', {}, 'clean up old project files'),
  };

  // ---------- my own devices ----------
  //
  // Two things on one Realtime channel: presence, so each device can see which
  // of the others are online, and broadcast, which carries the WebRTC offers
  // and ICE candidates that let them connect directly.
  //
  // THE CHANNEL IS PRIVATE, AND THAT MATTERS
  //   An ordinary Realtime channel is readable by anyone with the publishable
  //   key who knows its name, and this project's auth.users is shared with
  //   another app. A session description contains both devices' IP addresses,
  //   so a guessable channel would mean another account could read them and
  //   inject offers of its own. `private: true` makes Realtime consult the
  //   policies on realtime.messages instead, and those tie the topic to
  //   auth.uid() — see the migration.
  //
  // No video goes over this channel. It carries a few kilobytes of handshake,
  // and then the two devices talk to each other.

  const devices = {
    /**
     * Join the channel as this device. Resolves once presence is established.
     *
     * `peerId` is per tab, not per device: two tabs on one laptop are two
     * peers, and the name a person typed may well be the same on both.
     */
    async join({ userId, peerId, deviceName, canStream, onSignal = () => {}, onPeers = () => {} }) {
      // A private channel is authorised by the session's own token, so the
      // socket has to be carrying it before the subscribe.
      try {
        const session = await auth.session();
        if (session?.access_token && client.realtime?.setAuth) await client.realtime.setAuth(session.access_token);
      } catch {
        // If this fails the subscribe below fails too, with a better message.
      }

      const channel = client.channel(deviceTopic(userId), {
        config: {
          private: true,
          // Our own broadcasts coming back would have a device offering a file
          // to itself. readSignal drops them anyway; this saves the round trip.
          broadcast: { self: false },
          presence: { key: peerId },
        },
      });

      const listeners = new Set();

      channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
        const message = readSignal(payload, peerId);
        if (!message) return;
        onSignal(message);
        for (const listener of listeners) listener(message);
      });

      const readPeers = () => {
        const state = channel.presenceState();
        return Object.entries(state).flatMap(([key, entries]) => (entries || []).map((entry) => ({
          id: entry.peerId || key,
          device: entry.device || 'Unknown device',
          canStream: entry.canStream === true,
          at: entry.at || null,
        }))).filter((p) => p.id !== peerId);
      };

      for (const event of ['sync', 'join', 'leave']) {
        channel.on('presence', { event }, () => onPeers(readPeers()));
      }

      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(
          'Could not open the channel your devices use to find each other. Reload and try again.',
        )), 15000);
        channel.subscribe(async (status, error) => {
          if (status === 'SUBSCRIBED') {
            clearTimeout(timer);
            await channel.track({ peerId, device: deviceName, canStream: canStream === true, at: new Date().toISOString() });
            resolve();
            return;
          }
          if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) {
            clearTimeout(timer);
            reject(new Error(readable(error || { message: status }, 'reach your other devices')));
          }
        });
      });

      return {
        /** The signalling port shared/transfer.mjs expects. */
        send: (message) => channel.send({ type: 'broadcast', event: 'signal', payload: message }),
        onMessage(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        /** The next message that matches, or a readable failure if none comes. */
        waitFor(matches, ms, timeoutMessage = () => 'The other device did not answer.') {
          return new Promise((resolve, reject) => {
            const stop = () => { listeners.delete(listener); clearTimeout(timer); };
            const listener = (message) => {
              if (!matches(message)) return;
              stop();
              resolve(message);
            };
            const timer = setTimeout(() => { stop(); reject(new Error(timeoutMessage())); }, ms);
            listeners.add(listener);
          });
        },
        peers: readPeers,
        /** Keep presence honest when the name is changed in Settings. */
        rename: (name) => channel.track({ peerId, device: name, canStream: canStream === true, at: new Date().toISOString() }),
        leave: () => client.removeChannel(channel),
      };
    },
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
    /**
     * Read the live pages for a subject and write the pack.
     *
     * The fetching has to happen server-side: a browser cannot read another
     * site's page, which is the whole point of cross-origin rules. So this is
     * the one generator that could not have lived in the page even if the keys
     * were not a problem.
     */
    research: (options) => callFunction('vr-research', options, 'research that'),
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

  /**
   * Project folders, on their own channel.
   *
   * Separate from live() because the interesting thing about a project item is
   * which device it came from — "New from Laptop: …" is the whole point of the
   * feature — and that deserves its own message rather than being counted into
   * the generic "updated from another device" one.
   */
  function liveProjects(onChange) {
    const channel = client.channel('viralradar-projects');
    for (const table of PROJECT_LIVE_TABLES) {
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
      const [i, s, r, t, st, u, p, pi] = await Promise.all([
        run(client.from('ideas').select('*'), 'export your ideas'),
        run(client.from('scripts').select('*'), 'export your scripts'),
        run(client.from('results').select('*'), 'export your results'),
        run(client.from('trends').select('*'), 'export your trends'),
        run(client.from('settings').select('*'), 'export your settings'),
        run(client.from('usage').select('*'), 'export your usage'),
        run(client.from('projects').select('*'), 'export your projects'),
        // Notes and links only. A backup is one JSON file, so it cannot carry
        // the bytes of a file — and a row describing a file that is not in the
        // backup would restore as a download button pointing at nothing.
        // Files are in Storage, which is not what this feature is for keeping.
        run(client.from('project_items').select('*').in('kind', ['text', 'link']), 'export your project notes'),
      ]);
      return {
        app: 'viralradar',
        backup_version: 3,
        exported_at: new Date().toISOString(),
        // What is deliberately not here, so a restore is not a surprise.
        excludes: ['project files (they live in Storage, not in this file)'],
        tables: { ideas: i, scripts: s, results: r, trends: t, settings: st, usage: u, projects: p, project_items: pi },
      };
    },
    /** Restore adds and updates; it never deletes, so a restore cannot lose work. */
    async restore(file, userId) {
      if (!file || file.app !== 'viralradar' || !file.tables) {
        throw new Error('That is not a ViralRadar backup file (expected "app": "viralradar").');
      }
      const counts = {};
      // projects before project_items: an item's foreign key is the pair
      // (user_id, project_id), so its folder has to exist first.
      for (const table of ['ideas', 'scripts', 'results', 'trends', 'settings', 'usage', 'projects', 'project_items']) {
        let rows = file.tables[table];
        if (!Array.isArray(rows) || !rows.length) { counts[table] = 0; continue; }
        if (table === 'project_items') {
          // A file item's storage_path starts with the user id it was uploaded
          // under, and the database checks that. Re-owning one would write a
          // path that no longer matches, so files are skipped here as well as
          // in the download — and an older backup might still contain some.
          rows = rows.filter((row) => !row.storage_path);
        }
        if (table === 'projects') {
          // Two Inboxes cannot exist, and the one already here is the one the
          // share menu is pointed at. A restored folder becomes an ordinary one.
          rows = rows.map((row) => ({ ...row, is_inbox: false }));
        }
        if (!rows.length) { counts[table] = 0; continue; }
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

  return { auth, settings, ideas, scripts, results, trends, usage, tokens, imports, ai, backup, projects, items, storage, devices, live, liveProjects, callFunction };
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
