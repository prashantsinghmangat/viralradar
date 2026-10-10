# Data binding audit

Every value each screen shows, the field it comes from, and how it is
formatted. Compiled by reading `public/app.js` against `public/data.js` and the
migrations, then confirmed by rendering each screen against known fixtures
(`qa/fake-data.js`) and reading the result back out of the DOM.

Formatting helpers (`public/app.js`):

| Helper | Does | Example |
|---|---|---|
| `esc(v)` | HTML-escapes; `null`/`undefined` become `''` | — |
| `fmt(n)` | `toLocaleString('en-IN')`; `null`/`''` become `—` | `1,84,000` |
| `compact(n)` | Indian short scale | `184000` → `1.8L`, `14100` → `14.1K`, `410` → `410` |
| `ago(iso)` | relative | `just now`, `34m ago`, `5h ago`, `2d ago` |
| `when(iso)` | `toLocaleString('en-IN', {dateStyle:'medium', timeStyle:'short'})` | `10 Oct 2026, 12:00 pm` |

**Nothing renders `undefined`, `null`, `NaN`, `[object Object]` or `Invalid
Date` on any screen, at any width, in either theme** — that is check 4 in the
suite, and it passes on all 384 cases.

---

## Radar — `renderRadar()`

| Shown | Field | Formatting |
|---|---|---|
| "Collected …" | `trends.list().day` ← `trends.fetched_on` | **raw `YYYY-MM-DD`** — see finding D1 |
| YouTube quota | `usage.today().youtube.{requests, units}` | `fmt()` on units |
| Weekly goal "N of G" | N: count of `results.posted_on` ≥ Monday of this week; G: `settings.weekly_goal` | integers, `0` shown as `0` |
| Goal bar width | `min(100, round(N/G*100))` | % |
| Source badge | `trends.source` → `SOURCE[...]` label + icon | fixed map, falls back to the raw source string |
| Keyword chip | `trends.extra.keyword` | omitted when absent |
| Title | `trends.title` | `esc` |
| Views / stars / upvotes / points | `trends.views`, unit chosen by `source` | `compact()`; **whole metric omitted when `views` is null** |
| Velocity | `trends.score` | `compact()` + per-source unit (`views/hr`, `pts/hr`, …) |
| Age | `trends.published_at` | `ago()`; empty string when null |
| Summary | `trends.summary` | `esc`, omitted when empty |
| Thumbnail | `trends.thumbnail` | `<img>`; on error swapped for the source emoji |
| Language chip | `settings.radar_languages` → `RADAR_LANGUAGE_OPTIONS` | `Hindi + English`; falls back to `DEFAULT_RADAR_LANGUAGES` |

Verified: the weekly-goal count is computed from real `posted_on` dates (3 of
the 4 fixture results fall in the current Mon–Sun week → renders "3 of 5"); a
trend with `views: null` renders its velocity only, with no orphaned unit; a
trend with `published_at: null` renders no age rather than "Invalid Date".

## Ideas — `renderIdeas()`

| Shown | Field | Formatting |
|---|---|---|
| Day heading | `ideas.date`, falling back to `origin_at` | grouped, `esc` |
| Title / hook / tool / show / why / format | the same-named columns | `esc`; a row with every optional field null renders the title alone |
| Filter chip counts | counted from the loaded list | `All · 4`, `New · 2`, `Picked · 1`, `Skipped · 1` — match the data |
| Status | `ideas.status` | drives `.picked` / `.skipped` styling |

## Scripts board — `renderScripts()`

| Shown | Field | Formatting |
|---|---|---|
| Column | `scripts.stage` ← `SCRIPT_STAGES` | 4 fixed columns |
| Card title | `title` → `yt_title` → `id` | first non-empty |
| Topic line | `scripts.topic` | `esc` |
| Language tag | `scripts.language` | omitted when null |
| "My idea" badge | `scripts.own_idea` | boolean |
| Column counts | length of each stage bucket | integer |

`scripts.list()` selects a **narrow column set** (`id, topic, title, yt_title,
thumbnail_text, stage, language, own_idea, origin_at, updated_at`) — every
field the board draws is in it, so nothing is silently dropped.

## Script detail — `renderScriptDetail()`

| Shown | Field | Formatting |
|---|---|---|
| Title | `title` → `yt_title` → `id` | |
| Stage pills | `stage` | active pill from `stageIdx()` |
| Language badge | `language` | omitted when null |
| "Written by" | `source` (hidden for `shorts-studio`) | |
| Created | `raw.created_at` → `origin_at` | `when()` |
| Original idea | `raw.original` | `<details>`, omitted when absent |
| Beats | `beats[].{t, say, screen}` | `say` large, `screen` small |
| Demo Setup | `raw.demo` via `readDemo()` | omitted entirely when absent |
| Verified / Unverified badge | `demo.checked === true` | three-state, never collapsed to two |
| Pre-flight checklist | `demo.prepare` + `demo.check` | ticks in `localStorage['vr-checklist-<id>']` |
| Edit plan | `raw.edit_plan` via `readEditPlan()` | offers "Make edit plan" when absent |
| Ready to post | `thumbnail_text, yt_title, ig_caption, fb_caption, hashtags, pinned_comment, broll, audio` + joined beats | each block omitted when its value is empty |
| Hashtags | `hashtags[]` | `#` prefixed if missing, space-joined |

Confirmed against `scr_bare` (no beats, no demo, no edit plan, no captions):
the screen renders the header and an empty-beats line, and silently omits every
absent section rather than rendering empty shells.

## Projects — `renderProjects()` / `renderProjectDetail()`

| Shown | Field | Formatting |
|---|---|---|
| Folder title | `projects.title` | `esc` |
| Item count / size | `item_count`, `bytes` (computed in `data.projects.list()`) | `formatBytes()` |
| Latest item line | `latest.{from_device, created_at, preview}` | `itemPreview()` + `ago()` |
| Status | `status` (`active`/`posted`/`archived`), `is_inbox` | archived hidden behind a toggle |
| Storage meter | `storage.usage().{text, percent}` | `"40 MB of 300 MB used"` |
| Item body | `kind` → text / link / image / file / video_ref / research | per-kind rendering |
| Video record | `size_bytes`, `devices[]`, `sha256` | `videoRefSummary()` |

## Results — `renderResults()`

| Shown | Field | Formatting |
|---|---|---|
| Tiles | `stats().{count, total_views, avg_views, save_rate, streak}` | `fmt()` / `compact()` / `%` |
| Bars | `stats().by[dim][].{label, avg_views, save_rate, count}` | width relative to the max |
| Top 5 | `stats().top[]` | `fmt()` views/saves |
| Table | every `results` column | `fmt()` for numbers, raw for dates |
| Save % | computed `saves / views * 100` | 2 dp, `—` when `views` is 0 — **no division by zero** |

A result with `views: 0` renders `0`, not a blank — confirmed on fixture
`res_3`.

## Settings — `renderSettings()`

Reads the whole settings row; every column has a control: `niche_keywords`,
`radar_languages`, `weekly_goal`, `language`, `default_length`, `ai_order`,
`gemini_model`, `openrouter_model`. Plus `tokens.list()`, `usage.today()`,
`storage.usage()` (null-tolerant — the card degrades rather than failing the
screen), and `__VR_ENV.{BUILT_AT, SUPABASE_URL}`.

---

## Navigation and live updates

| Behaviour | State | Evidence |
|---|---|---|
| Deep link `#/scripts/<id>` | works | the suite loads every detail screen by URL, not by clicking |
| Reload on any screen | works | every one of the 384 cases is a cold load of that hash |
| Back button | works | hash routing; `hashchange` re-renders |
| Filters survive a screen change | yes | `radarSource`, `ideaFilter`, `resultDim`, `uiSearch` are module-level |
| `#/projects?shared=1` | works | the query is split off in `parseHash()` before routing |
| Realtime row change redraws | yes | `data.live()` → `render()` for radar/ideas/scripts/results/import |
| Open dialogs survive a redraw | yes | `<dialog>`s live outside `#view`, which is what `render()` replaces |
| Scroll position survives a redraw | **partly** — see finding D2 | |

---

## Findings

**D1 — the Radar's "Collected" date is the only unformatted date in the app.**
`renderRadar()` prints `trends.fetched_on` raw (`Collected 2026-10-10`) while
every other date on every other screen goes through `when()` or `ago()`.
Cosmetic, and it is a real value, so it is listed as *minor* in the report, not
fixed in this round.

**D2 — a Realtime redraw rebuilds `#view` wholesale.** `render()` sets
`view.innerHTML`, so an open `<details>`, a part-typed `<input>` inside the
view, and the exact scroll offset relative to the content are reset when a row
arrives from another device. The window's scroll position itself is kept (only
`hashchange` scrolls to top), and dialogs/sheets survive because they sit
outside `#view`. Fixing this properly means diffing rather than replacing,
which is a behaviour change and out of scope for a restyle — flagged for your
decision.

**D3 — `when()` formats in the browser's timezone, not IST.** It passes
`en-IN` as the locale but no `timeZone`, so a laptop set to another zone shows
local times while the Radar's own copy says "7:00 AM IST". Not visible on your
machines today; worth pinning `timeZone: 'Asia/Kolkata'` if the app ever
travels. Flagged, not fixed.

No field read by any screen is missing from what `data.js` returns, and no
value read by a screen is dropped on the way — checked call site by call site
against the method list in `public/data.js`.
