---
name: ui-qa
description: Run the Playwright UI suite for one screen at 390 px and 1280 px in both themes, fix the layout failures it finds (overflow, overlap, clipped text, broken data), re-run until clean, and report in 10 lines. Use when asked to UI-QA, visually check, or fix the layout of a screen.
---

# ui-qa <screen>

`$1` is a screen name from `SCREENS` in [qa/lib/harness.mjs](qa/lib/harness.mjs)
— e.g. `radar`, `ideas`, `scripts`, `script-detail`, `projects`,
`project-detail`, `results`, `import`, `settings`, `login`, `hook-sheet`, and
the `-empty` / `-single` / `-many` / `-bare` / `-hindi` variants.

If `$1` is missing or matches nothing, list the available names and stop.
If it names a base screen that has variants (`radar` → `radar-empty`,
`radar-single`, `radar-many`), include the variants — a layout bug usually
lives in one state only.

## 1. Before pass (record, don't fail)

Test titles are `<screen> @ <width> <theme>`, so target exactly the four cases
per screen:

```bash
QA_PHASE=before QA_SOFT=1 npx playwright test --config qa/playwright.config.mjs \
  -g "(radar|radar-empty|radar-single|radar-many) @ (390|1280) (dark|light)$"
```

(Substitute the real screen names. `QA_SOFT=1` records findings instead of
failing, which is what makes the before/after pair readable. `-g` matches the
*full* test name, file path included, so no leading `^` — verify a selector with
`--list` before running it.)

Then read the findings — one JSON file per case:

```bash
ls qa/results/before && cat qa/results/before/<screen>--390--dark.json
```

Look at the screenshots in `qa/screenshots/before/` when a finding is unclear;
they are full-page PNGs you can read directly.

## 2. Fix only these

- **overflow** — horizontal scroll, or an element wider than the viewport
- **overlap** — two interactive or text elements covering each other
- **clipped text** — text cut off, or chrome (`#nav`, `.topbar`) covering content
- **broken data** — a console error, a failed request, `undefined`/`NaN`/empty
  where the fixture has a value
- contrast and labelling failures axe reports on the same screen

Fix them in [public/styles.css](public/styles.css) or
[public/app.js](public/app.js). Prefer a change scoped to the component that is
failing over a global rule — a fix at 390 must not break 1280, and vice versa.
Do not restyle, rename, reword or "improve" anything the checks did not flag.

This is UI work, so **no tamper-testing** — that is reserved for
security-critical code (see CLAUDE.md).

## 3. After pass (must pass hard)

Re-run without `QA_SOFT`, so any remaining violation fails:

```bash
QA_PHASE=after npx playwright test --config qa/playwright.config.mjs \
  -g "(<screens>) @ (390|1280) (dark|light)$"
```

Loop fix → re-run until it is green, or until a finding is one you cannot fix
without a decision from me — then stop and say which.

Before finishing, run the full UI suite once for the screen at every width, so
a 390/1280 fix did not break 360, 412, 768, 1024 or 1440:

```bash
npx playwright test --config qa/playwright.config.mjs -g "(<screens>) @ "
```

## 4. Report (at most 10 lines)

- the screen and cases run
- findings in the before pass, grouped by kind
- what was changed, by file
- the after pass result, and the all-widths result
- anything left unfixed, and why
