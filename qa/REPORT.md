# QA round 1 — the Stitch restyle

A full visual and structural sweep of every screen, at seven widths, in both
themes, against controlled data. Written because the restyle shipped with
overlapping chrome, distorted layouts and controls that were never styled at
all.

## How it was tested

`npm run test:ui` boots the **real** `index.html`, `app.js` and `styles.css`
in Chromium and swaps out only the data layer: the browser's request for
`/data.js` is answered with `qa/fake-data.js` instead. Nothing in `public/`
knows the suite exists, and nothing about the suite ships.

The fixtures are built to be awkward on purpose: 120-character words with no
spaces, a URL with a 60-character query string, Devanagari and Hinglish with
emoji, trends from all four sources with and without thumbnails, an image that
deliberately 404s, rows with every optional field null, scripts in all four
stages, projects in every state including Inbox and archived, and list lengths
of 0, 1, 7 and 120.

**27 screens and states × 7 widths (360/390/412/768/1024/1280/1440) × 2 themes
= 384 cases.** Each one is screenshotted full-page and then checked for:

| Check | What fails it |
|---|---|
| Horizontal scroll | `documentElement.scrollWidth` > viewport |
| Overlap | two visible elements in the same stacking layer whose boxes intersect by >2px |
| Chrome covering content | fixed sidebar/top bar across `#view`'s content; at the bottom of the page, a bar covering the last item |
| Clipped text | `scrollWidth`/`scrollHeight` beyond the client box under `overflow:hidden`, without an ellipsis + full value |
| Broken data | `undefined`, `null`, `NaN`, `[object Object]`, `Invalid Date`, an unreplaced `${…}`, or a unit with no number |
| Tap targets | anything interactive under 44×44 at phone widths |
| Accessibility | axe-core, WCAG 2.0/2.1 A + AA |
| Console & network | any console error or failed request |
| Images | stretched by `object-fit`, or failed with no fallback |

Screenshots: `qa/screenshots/before/` and `qa/screenshots/after/`.
Raw findings: `qa/results/before/` and `qa/results/after/` (one JSON per case).
`node qa/summarise.mjs before|after` rolls them up.

## Result

| | Before | After |
|---|---|---|
| Cases with findings | **342 of 384** | **0 of 384** |
| Distinct problems | **107** | **0** |
| Horizontal scroll | 68 | 0 |
| Overlapping elements | 52 real (+56 false, see below) | 0 |
| Chrome covering content | 1 real, and the check missed it | 0 |
| Tap targets under 44px | 1350 | 0 |
| Accessibility violations | 112 | 0 |
| Broken data on screen | 0 | 0 |
| Clipped text | 0 | 0 |
| Console errors / failed requests | 0 | 0 |
| Stretched / broken images | 0 | 0 |

`npm run test:ui` now passes all 384 cases with hard assertions, and
`npm test` still passes its 586 — no behaviour changed.

**Three corrections to the suite itself, in the interest of not overclaiming:**

- The first version reported "top bar covers the content" on all 162
  desktop cases. That was wrong: it measured `#view`'s *border* box, and
  `#view` carries the top bar's height as padding, so its box legitimately
  starts under the bar. Those 162 were false. It now measures the content.
- It reported 56 overlaps between the collapsed "Original idea" block and the
  teleprompter buttons. Also false: Chrome keeps the contents of a **closed**
  `<details>` in the layout tree with a real bounding box, so they measure as
  present while never being painted. The visibility test now accounts for
  that.
- Worse than either: the first version **missed the sidebar bug entirely** —
  the one in your screenshots. It only recognised a sidebar by its shape
  (taller than wide), and the broken sidebar had collapsed to 16px tall, so it
  did not look like one. The check is now shape-agnostic: any fixed chrome
  that is not a bottom bar must not intersect the content, whatever shape it
  is in.

A fourth, non-correctness fix: the overlap check was O(n²) with a DOM
`contains()` call per pair. On the 120-card feed it only finished before
because it bailed out after 12 findings; once there was nothing to find it
ran for minutes. It is now a sweep over boxes sorted by top edge, with the
expensive test left until last.

---

# Findings

## BROKEN

### B1 — The desktop sidebar was positioned against the header, not the window

**Screens:** every screen · **Widths:** 1024, 1280, 1440 · **Themes:** both
**Before:** `qa/screenshots/before/radar--1280--dark.png`
**After:** `qa/screenshots/after/radar--1280--dark.png`

This is the one in your screenshots. The sidebar's links painted *on top of*
the page content, and "ViralRadar" sat on top of the search box.

Measured, the sidebar was **16 pixels tall** and started at x=260 instead of
x=0; its links overflowed that 16px box and scattered across the cards.

The cause: `.topbar` carries `backdrop-filter: blur(10px)`, and a
backdrop-filter makes an element the **containing block for its
`position: fixed` descendants**. `.brand` and `.nav` lived inside the header,
so `left: 0` meant "the header's left edge" (x=260), and `top: 64px;
bottom: 0` inside a 64px-tall header collapsed the nav to nothing.

The original code knew about this trap — there is a comment in `styles.css`
warning that a backdrop-filter on the header would capture *the phone's*
fixed bottom bar. The restyle made the desktop nav fixed too and walked
straight into it.

**Fix:** `<nav>` moved out of `<header>` to be its sibling, with the reason
written down next to it. `.brand` became an ordinary 260px flex child instead
of a fixed one, which is what lines it up with the sidebar. The header keeps
its blur.

### B2 — Long text pushed the page sideways on seven screens

**Screens:** scripts, script-detail, ideas, angles, results · **Widths:** 360–1440 · **Themes:** both
**Before:** `qa/screenshots/before/scripts--360--dark.png`
**After:** `qa/screenshots/after/scripts--360--dark.png`

At 360px the Scripts board was **918px wide**; at 1024 the script detail was
**1942px**. One unbreakable token — a pasted prompt, a long URL, a run-on
title — set the minimum width of its card, which set the width of the grid
track, which set the width of the page.

**Fix:** `overflow-wrap: anywhere` on text-bearing elements (via `:where()`,
so it carries no specificity and any component can still opt out), and
`min-width: 0` on grid and flex children, which otherwise default to
`min-width: auto` and let the token win. `.board` moved from `1fr` to
`minmax(0, 1fr)` for the same reason. Buttons and table cells are excluded —
breaking a button label mid-word reads as damage.

### B3 — The sign-in, keyword and goal inputs were never styled

**Screens:** login, settings · **Widths:** all · **Themes:** both
**Before:** `qa/screenshots/before/login--390--dark.png`
**After:** `qa/screenshots/after/login--390--dark.png`

The email box was **24px tall**, the password box **21px**, the weekly-goal box
**21px** — raw browser defaults, white-on-white in dark mode, and less than
half the minimum tap size.

The selector was `input[type=text], textarea, select`. It matched none of
`type=email`, `type=password` or `type=number`. This predates the restyle;
the restyle made it visible by putting a number input on the Settings screen.

**Fix:** the selector now matches every text-entry control —
`input:not([type=checkbox]):not([type=radio]):not([type=file]):not([type=hidden])`
— with a 44px minimum height.

### B4 — A long URL sat on top of its own status badge

**Screens:** research-pack · **Widths:** all · **Themes:** both
**Before:** `qa/screenshots/before/research-pack--1280--dark.png`
**After:** `qa/screenshots/after/research-pack--1280--dark.png`

`packLink()` emitted an `<a>` followed by an inline badge. When the URL wrapped
to several lines, the badge painted across the last line instead of following
it — which, on the one screen whose whole purpose is telling verified from
unverified, put "● Live" on top of the thing it was describing.

**Fix:** the link and its badge are now one wrapping flex row (`.pack-link`).

## UGLY

### U1 — Nothing on a phone met the 44×44 tap-target minimum

**Screens:** all · **Widths:** 360, 390, 412 · **Themes:** both

1,350 failures across the matrix: `.sm` buttons at 32px, chips at 32px, the
segmented control at 36px, the theme toggle at 36px, the brand link at 23px.
The design system's own brief ("a hard minimum tap target of 44px × 44px") was
not being met anywhere.

**Fix:** a `@media (max-width: 767px)` block raising every interactive control
to 44×44. It sits at the end of the stylesheet deliberately — see N1.

### U2 — Colour contrast failed in both themes

**Screens:** most · **Widths:** 390, 1280 · **Themes:** both

112 axe violations, nearly all `color-contrast`. The main offenders and their
measured ratios:

| Element | Was | Now |
|---|---|---|
| White text on primary buttons (dark) | 3.07:1 | 4.96:1 — dark navy ink on blue, which is what `DESIGN.md` specifies (`on-primary-container: #00285d`) |
| Nav labels (dark) | 4.0:1 | 6.0:1 |
| Nav labels (light) | 4.3:1 | 5.4:1 |
| Active nav pill / chips / accent badges | 3.5:1 | 5.6:1 — new `--accent-on-soft` token for text sitting on `--accent-soft` |
| `.toast.bad` white on red | 3.3:1 | 6.5:1 |
| Source badges (light) | 3.97–4.46:1 | 5.8–6.2:1 |
| "Unverified" warn badge (light) | 4.47:1 | 6.4:1 |
| Error tone on its own fill (light) | 4.47:1 | 6.96:1 |
| Skipped ideas (`opacity: .55`) | 3.6:1 | no opacity at all — see below |

Every pair was computed before being changed, not guessed, and axe now passes
on all 384 cases.

Two things worth keeping in mind for future colour work:

- **The dark theme's "soft" fills were alpha, not solid.** `rgba(245,158,11,.16)`
  composites against whatever happens to be behind it, so the same badge
  passed on one surface and failed on another. They are solid hexes now, and
  the contrast is a fixed number rather than a function of context.
- **`opacity` dims text and buttons with it.** The skipped-idea card was
  dimmed to `.55`, which dragged everything inside it — including a primary
  button — under the threshold. Raising the opacity just moved the failure
  around; it is now recessed with a dashed border and a sunken background,
  which says the same thing without touching contrast at all.

### U3 — Two missing accessibility affordances

- The niche-keywords textarea had no label at all (axe: *critical*). An
  `<h2>` above a control is not a label. Given `aria-label`.
- The results table scrolls horizontally but could not be reached from the
  keyboard. Given `tabindex="0"` and `role="region"` with a name.

## MINOR — found, not fixed

### D1 — The Radar's "Collected" date is the only unformatted date in the app
It prints `trends.fetched_on` raw (`Collected 2026-10-10`) while every other
date goes through `when()` or `ago()`. Cosmetic and truthful; left alone
because changing it is a copy decision, not a bug fix.

### D2 — A Realtime redraw rebuilds `#view` wholesale
`render()` replaces `view.innerHTML`, so when a row arrives from another device
an open `<details>`, a half-typed input inside the view, and the scroll offset
relative to the content are reset. Dialogs and sheets survive (they live
outside `#view`), and the window's scroll position is kept. Fixing it properly
means diffing instead of replacing — a behaviour change, so out of scope here.
**Needs your decision.**

### D3 — `when()` formats in the browser's timezone, not IST
It passes the `en-IN` locale but no `timeZone`, so a machine set to another
zone would show local times while the Radar says "7:00 AM IST". Invisible on
your machines today. **Needs your decision** — pinning it to `Asia/Kolkata` is
a one-line change but it is a product choice.

### B5 — A fact's source link sat on top of its own verified badge

**Screens:** research-pack · **Widths:** 768–1440 · **Themes:** both

The same shape as B4, in the fact-check list: a badge followed by an inline
link that wraps. Fixed the same way, by reusing `.pack-link`.

## NOTE

### N1 — Two of these bugs were the same cascade mistake
B1 and U1 were both "the rule exists but a later unconditional rule wins". CSS
breaks ties by source order regardless of whether a media query matches, so a
`@media (min-width: 1024px)` block placed *before* the base `.view` rule loses
to it, and a `@media (max-width: 767px)` block placed before `.chip` loses to
that. Both blocks now sit at the end of the stylesheet, with the reason
written above them. This is also why the earlier "fix" for the sidebar did not
work: it corrected the ordering but not the containing block.

---

## What the suite does not cover

- **Real devices.** Chromium at a given viewport is not an iPhone. Safari's
  `dialog`, `:has()` and `backdrop-filter` behaviour, and the on-screen
  keyboard, still need a look on your actual phone.
- **The keyboard-open case.** The brief asks that a focused input stay visible
  when the keyboard opens. Headless Chromium has no on-screen keyboard, so
  this is not asserted; it needs a real phone.
- **Video transfer.** The two-device WebRTC flow cannot be driven from one
  browser context, so its sheet is not in the matrix.
- **Pixel diffing.** Screenshots are for your eyes and for before/after
  comparison; the suite asserts structure, not pixels, so it will not fail on
  an intentional design change.
