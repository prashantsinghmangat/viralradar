---
name: finish
description: Close out a task — run the right tests for what changed (npm test, plus test:ui or test:rls only when relevant), update only the doc sections this task affected, commit, and print the 10-line report. Use when asked to finish, wrap up, or finalise and commit a task.
---

# finish

Close out the task that was just done. Work from the actual diff, not memory.

## 1. See what changed

```bash
git status --short
git diff --stat
```

## 2. Test, by the levels in CLAUDE.md — don't over-test

Always:

```bash
npm test
```

Then, only if the diff warrants it:

- `npm run test:ui` — only if `public/` (UI, styles, markup) changed.
- `npm run test:rls` — only if `supabase/migrations/`, `supabase/tests/` or
  `scripts/rls-plan.mjs` changed. It needs `DATABASE_URL` in `.env`; if it is
  absent, say so as unverified rather than skipping silently.
- `npm run sync:shared -- --check` — if anything in `shared/` changed. If it
  reports drift, run `npm run sync:shared` and include the copies in the commit.

Do not run the suites the diff does not touch. If a test fails, fix it or report
the failure with its output — never commit over a red suite without saying so.

## 3. Docs — only the affected sections

This is the end of the task, so docs may be updated now, but narrowly:

- Update only the sections of `docs/PROJECT.md`, `docs/SETUP.md` or `README.md`
  that this task actually changed — typically §9 Status, a new Step 14x in
  SETUP, or the screen description in §8. Read only the section you are editing.
- Leave `qa/REPORT.md` and `qa/DATA-BINDING.md` alone unless the task was a QA
  round.
- If nothing in the docs is now wrong, change nothing and say so.

## 4. Commit

Never deploy, and never `git push` unless I ask. Commit only:

```bash
git add <the files this task touched>
git commit -m "<subject in the imperative, matching the log's style>"
```

Match the existing log's voice (`git log --oneline -10`). **No AI attribution:**
no `Co-Authored-By`, no mention of Claude or Claude Code in the message.
If the current branch is `main` and the change is substantial, say so and ask
before committing to it.

## 5. Report (at most 10 lines)

- what changed, by file or area
- tests run, and their result
- doc sections updated
- the commit subject and hash
- what I must do (deploy steps, secrets, anything by hand)
- anything unverified
