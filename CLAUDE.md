# CLAUDE.md

## Project

ViralRadar is a personal one-user companion app for Shorts Studio: it holds
ideas, scripts, results and projects, and shows a daily radar of trending
short-video and tech links, with AI that writes ideas, scripts, hooks, angles,
research packs and edit plans. It is a vanilla-JS PWA — no framework, no
bundler — served as static files from Netlify (`npm run build` copies
`public/` into `dist/`, writes `dist/env.js` from the environment and vendors
supabase-js so nothing loads from a CDN). The backend is a Supabase project
*shared with the separate "tracebug" app*, so anything added here is prefixed
`vr_` / `vr-`: tables and policies under `vr_*`, Edge Functions `vr-generate`,
`vr-import`, `vr-research`, `vr-refresh-trends`, `vr-purge-project-files`.
Every table is protected by Row Level Security — the anon key is public by
design, RLS is what keeps the data private. Code lives in:

- `shared/` — the single source of truth for logic usable from both browser and
  server (`prompts.mjs`, `radar.mjs`, `generate-core.mjs`, `own-idea.mjs`,
  `contract.mjs`, …). Generated copies go to `public/shared/` and
  `supabase/functions/_shared/core/` via `npm run sync:shared`; never edit a
  copy, and `test/functions-sync.test.js` fails if one drifts.
- `public/` — the app shell: `index.html`, `app.js`, `styles.css`, `data.js`,
  `sw.js`, `manifest.webmanifest`, icons and fonts.
- `supabase/` — `migrations/` (timestamped SQL), `functions/` (Deno Edge
  Functions), `tests/` (pgTAP-style RLS tests), `config.toml`.
- `test/` (node:test), `qa/` (Playwright UI suite), `scripts/` (build, sync,
  RLS test, db inspect, icons), `docs/` (PROJECT.md, SETUP.md, README.md).

## Never

- Never run `supabase db reset`, `supabase db push`, or `supabase functions
  deploy`. Never touch storage or realtime policies that are not prefixed
  `vr_` — tracebug shares this project. I deploy myself; give me the commands.
- Never run two sessions at once. If files change that you did not change, stop
  and tell me.

## Testing levels (follow these, don't over-test)

- **During work:** run only the test files for what you changed —
  `node --test test/<file>.test.js`.
- **Before committing:** run `npm test` once. Run `npm run test:ui` only if the
  UI changed. Run `npm run test:rls` only if SQL or policies changed.
- **Tamper-testing** (adversarial inputs, hostile cases): ONLY for
  security-critical code — RLS policies, auth, tokens, storage paths, checksums
  (`sha256.mjs`), and the "keep my words exactly" and "only verified facts"
  rules in `shared/prompts.mjs` / `shared/own-idea.mjs`. Not for UI, copy,
  styling or formatting.

## Docs

- Don't update `docs/PROJECT.md`, `docs/SETUP.md` or `README.md` during a task.
  Update them once at the end of a feature, and only the sections that changed.
- Don't read `docs/PROJECT.md` unless you need architecture details, and then
  read only the section you need.

## Reports

End each task with at most 10 lines: what changed, tests run, what I must do,
anything unverified. No long explanations unless I ask.

## Commands

```bash
npm test                      # node --test test/*.test.js
npm run test:ui               # Playwright UI suite (qa/playwright.config.mjs)
npm run test:rls              # RLS proofs against the database
npm run sync:shared           # regenerate the shared/ copies
npm run sync:shared -- --check   # report drift without writing
npm run build                 # public/ -> dist/ + env.js + vendored supabase-js
npm run inspect:db            # read-only look at the live schema
npm run icons                 # regenerate PWA icons
```

Deploy commands — **I run these, not you:**

```bash
npx supabase db push
npx supabase functions deploy vr-generate --use-api
npx supabase functions deploy vr-import --use-api
npx supabase functions deploy vr-research --use-api
npx supabase functions deploy vr-refresh-trends --use-api
npx supabase functions deploy vr-purge-project-files --use-api
npx supabase secrets set "KEY=value"      # also: secrets list
# the site itself deploys from a push to main (Netlify)
```
