// The automated layout/data checks that run against every screen, at every
// width, in both themes.
//
// Each check returns an array of violation strings — empty means it passed.
// They are written to be specific enough to act on: a violation names the
// element and the numbers that make it wrong, not just "something overlaps".

/** Elements that are genuinely invisible, and so cannot be wrong on screen. */
const VISIBLE = `(el) => {
  const s = getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
  // Chrome keeps the contents of a CLOSED <details> in the layout tree — they
  // have a real bounding box but are never painted. Without this they look
  // like elements sitting on top of whatever follows the <details>.
  const details = el.parentElement && el.parentElement.closest('details');
  if (details && !details.open && !el.closest('summary')) return false;
  if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}`;

/** A readable name for an element, for the violation message. */
const DESCRIBE = `(el) => {
  const id = el.id ? '#' + el.id : '';
  const cls = typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/).slice(0, 3).join('.') : '';
  const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
  return el.tagName.toLowerCase() + id + cls + (text ? ' "' + text + '"' : '');
}`;

// ---------- 1. no horizontal page scroll ----------
export async function noHorizontalScroll(page, width) {
  return page.evaluate((w) => {
    const out = [];
    const docW = document.documentElement.scrollWidth;
    if (docW > w + 1) {
      // Name the widest offenders, or the report is unactionable.
      const wide = [...document.querySelectorAll('body *')]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.right > w + 1 && getComputedStyle(el).position !== 'fixed';
        })
        .slice(0, 6)
        .map((el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''} right=${Math.round(el.getBoundingClientRect().right)}`);
      out.push(`page scrolls horizontally: scrollWidth ${docW} > viewport ${w}${wide.length ? ' — widest: ' + wide.join(', ') : ''}`);
    }
    return out;
  }, width);
}

// ---------- 2a. overlapping elements, within one layer ----------
//
// Elements are only compared against others in the same stacking layer: a
// bottom sheet deliberately covers the page, and a sticky bar deliberately
// covers what is scrolling past under it. Covering content is checked
// separately, and precisely, in chromeClearsContent() below.
export async function noOverlap(page) {
  return page.evaluate(({ visibleSrc, describeSrc }) => {
    const visible = eval(visibleSrc);
    const describe = eval(describeSrc);

    const SELECTOR = 'button, a, input, select, textarea, h1, h2, h3, h4, .badge, .chip, .card, .tile, label, pre, dt, dd';
    const els = [...document.querySelectorAll(SELECTOR)].filter(visible);

    // The layer an element paints in: the nearest fixed/sticky ancestor or
    // open dialog, else the page itself.
    const layerOf = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) {
        if (n.tagName === 'DIALOG' && n.open) return n;
        const p = getComputedStyle(n).position;
        if (p === 'fixed' || p === 'sticky') return n;
      }
      return document.body;
    };

    // Sorted by top edge and swept, rather than compared pair by pair: a
    // 120-card feed has ~1800 candidates, and the naive O(n²) with a
    // contains() call per pair takes minutes when there is nothing to find.
    const items = els
      .map((el) => ({ el, rect: el.getBoundingClientRect(), layer: layerOf(el) }))
      .sort((a, b) => a.rect.top - b.rect.top);

    const out = [];
    for (let i = 0; i < items.length && out.length < 12; i++) {
      const a = items[i];
      for (let j = i + 1; j < items.length && out.length < 12; j++) {
        const b = items[j];
        // Sorted by top, so once b starts below a ends, nothing after b can
        // overlap a either.
        if (b.rect.top >= a.rect.bottom - 2) break;
        if (a.layer !== b.layer) continue;
        const ox = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
        if (ox <= 2) continue;
        const oy = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
        if (oy <= 2) continue;
        // Nesting is not collision, and it is the expensive test — so it runs
        // only on the few pairs whose boxes actually intersect.
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        out.push(`overlap ${Math.round(ox)}x${Math.round(oy)}px: ${describe(a.el)}  ><  ${describe(b.el)}`);
      }
    }
    if (out.length >= 12) out.push('…more overlaps not listed (stopped at 12)');
    return out;
  }, { visibleSrc: VISIBLE, describeSrc: DESCRIBE });
}

// ---------- 2b. fixed chrome must not cover content ----------
//
// The sidebar must sit beside the content, not on top of it; the top bar must
// sit above it; and at the very bottom of the page the last thing on screen
// must be fully clear of the bottom bar and any sticky action bar.
export async function chromeClearsContent(page) {
  // Check the sidebar/top bar first, at the top of the page.
  await page.evaluate(() => window.scrollTo(0, 0));
  const atTop = await page.evaluate(({ visibleSrc, describeSrc }) => {
    const visible = eval(visibleSrc);
    const describe = eval(describeSrc);
    const out = [];
    const view = document.querySelector('#view');
    if (!view || !visible(view)) return out;

    // The content box, not the border box: #view carries the top bar's height
    // as padding, so its own rect legitimately starts underneath the bar.
    const children = [...view.children].filter(visible);
    if (!children.length) return out;
    const content = children.reduce((acc, el) => {
      const r = el.getBoundingClientRect();
      return {
        left: Math.min(acc.left, r.left), right: Math.max(acc.right, r.right),
        top: Math.min(acc.top, r.top), bottom: Math.max(acc.bottom, r.bottom),
      };
    }, { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity });

    // Any fixed chrome that is not a bottom bar must sit beside or above the
    // content, never across it. Shape-agnostic on purpose: the bug this
    // replaced was a sidebar that had collapsed to 16px tall and so did not
    // look like a sidebar at all.
    for (const sel of ['#nav', '.topbar', '.brand']) {
      const el = document.querySelector(sel);
      if (!el || !visible(el)) continue;
      if (getComputedStyle(el).position !== 'fixed') continue;
      const r = el.getBoundingClientRect();
      const bottomBar = r.bottom > innerHeight - 4 && r.top > innerHeight / 2;
      if (bottomBar) continue; // checked at the bottom of the page instead
      const ox = Math.min(content.right, r.right) - Math.max(content.left, r.left);
      const oy = Math.min(content.bottom, r.bottom) - Math.max(content.top, r.top);
      if (ox > 2 && oy > 2) {
        out.push(`${describe(el)} covers the content by ${Math.round(ox)}x${Math.round(oy)}px `
          + `(chrome x ${Math.round(r.left)}–${Math.round(r.right)} y ${Math.round(r.top)}–${Math.round(r.bottom)}; `
          + `content starts x ${Math.round(content.left)} y ${Math.round(content.top)})`);
      }
    }
    return out;
  }, { visibleSrc: VISIBLE, describeSrc: DESCRIBE });

  // Then the bottom bars, at the very bottom of the page.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(120);
  const atBottom = await page.evaluate(({ visibleSrc, describeSrc }) => {
    const visible = eval(visibleSrc);
    const describe = eval(describeSrc);
    const out = [];
    const bars = ['#nav', '.sticky-actions'].map((s) => document.querySelector(s))
      .filter((el) => el && visible(el) && getComputedStyle(el).position === 'fixed')
      .map((el) => ({ el, rect: el.getBoundingClientRect() }))
      // only bars pinned to the bottom of the screen
      .filter((b) => b.rect.bottom > innerHeight - 4 && b.rect.height < innerHeight / 2);
    if (!bars.length) return out;

    const content = [...document.querySelectorAll('#view button, #view a, #view input, #view .card, #view h1, #view h2, #view p')]
      .filter(visible);
    if (!content.length) return out;
    const last = content[content.length - 1];
    const r = last.getBoundingClientRect();
    for (const b of bars) {
      const oy = Math.min(r.bottom, b.rect.bottom) - Math.max(r.top, b.rect.top);
      const ox = Math.min(r.right, b.rect.right) - Math.max(r.left, b.rect.left);
      if (oy > 2 && ox > 2) {
        out.push(`at the bottom of the page, ${describe(b.el)} covers the last item ${describe(last)} by ${Math.round(oy)}px`);
      }
    }
    return out;
  }, { visibleSrc: VISIBLE, describeSrc: DESCRIBE });

  await page.evaluate(() => window.scrollTo(0, 0));
  return [...atTop, ...atBottom];
}

// ---------- 3. clipped text ----------
export async function noClippedText(page) {
  return page.evaluate(({ visibleSrc, describeSrc }) => {
    const visible = eval(visibleSrc);
    const describe = eval(describeSrc);
    const out = [];
    const els = [...document.querySelectorAll('#view *, .topbar *, #nav *, dialog[open] *')].filter(visible);
    for (const el of els) {
      if (out.length >= 12) break;
      if (!el.textContent || !el.textContent.trim()) continue;
      // Only leaves: a container is "clipped" only because a child is.
      if ([...el.children].some((c) => c.textContent && c.textContent.trim())) continue;
      const s = getComputedStyle(el);
      const hiddenX = s.overflowX === 'hidden' || s.overflowX === 'clip';
      const hiddenY = s.overflowY === 'hidden' || s.overflowY === 'clip';
      // Truncating on purpose, with the whole value still available elsewhere.
      const ellipsis = s.textOverflow === 'ellipsis';
      const clamped = s.webkitLineClamp && s.webkitLineClamp !== 'none';
      const titled = el.title || el.closest('[title]');
      if (hiddenX && el.scrollWidth > el.clientWidth + 1 && !(ellipsis && titled)) {
        out.push(`text clipped horizontally (${el.scrollWidth} > ${el.clientWidth}): ${describe(el)}`);
      } else if (hiddenY && el.scrollHeight > el.clientHeight + 1 && !clamped) {
        out.push(`text clipped vertically (${el.scrollHeight} > ${el.clientHeight}): ${describe(el)}`);
      }
    }
    return out;
  }, { visibleSrc: VISIBLE, describeSrc: DESCRIBE });
}

// ---------- 4. no broken data on screen ----------
const BAD_TEXT = [
  ['undefined', /\bundefined\b/],
  ['null', /\bnull\b/],
  ['NaN', /\bNaN\b/],
  ['[object Object]', /\[object \w+\]/],
  ['Invalid Date', /Invalid Date/],
  ['unreplaced template', /\$\{[^}]*\}/],
];
export async function noBrokenData(page) {
  const text = await page.evaluate(() => {
    const view = document.querySelector('#view');
    const sheet = document.querySelector('dialog[open]');
    return [view ? view.innerText : '', sheet ? sheet.innerText : ''].join('\n');
  });
  const out = [];
  for (const [label, re] of BAD_TEXT) {
    const m = text.match(re);
    if (m) {
      const at = text.indexOf(m[0]);
      out.push(`rendered "${label}" on screen — near: …${text.slice(Math.max(0, at - 50), at + 50).replace(/\s+/g, ' ')}…`);
    }
  }
  // A unit with no number in front of it ("— views", "views" alone).
  const orphan = text.match(/(^|\n)\s*(views|stars|upvotes|points)\b/i);
  if (orphan) out.push(`a unit with no number: "${orphan[0].trim()}"`);
  return out;
}

// ---------- 5. tap targets ----------
export async function tapTargets(page) {
  return page.evaluate(({ visibleSrc, describeSrc }) => {
    const visible = eval(visibleSrc);
    const describe = eval(describeSrc);
    const out = [];
    const els = [...document.querySelectorAll('button, a[href], input:not([type=hidden]), select, [data-action]')].filter(visible);
    for (const el of els) {
      if (out.length >= 10) break;
      // A link inside a sentence is text, not a tap target.
      if (el.tagName === 'A' && el.closest('p, li, .small, .muted') && !el.classList.contains('btn')) continue;
      if (el.type === 'checkbox' || el.type === 'radio') continue; // measured with their label
      const r = el.getBoundingClientRect();
      if (r.width < 44 || r.height < 44) {
        out.push(`tap target ${Math.round(r.width)}x${Math.round(r.height)} (min 44x44): ${describe(el)}`);
      }
    }
    return out;
  }, { visibleSrc: VISIBLE, describeSrc: DESCRIBE });
}

// ---------- 6. images keep their shape ----------
export async function imagesOk(page) {
  return page.evaluate(({ describeSrc }) => {
    const describe = eval(describeSrc);
    const out = [];
    for (const img of document.querySelectorAll('img')) {
      const r = img.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (img.complete && img.naturalWidth === 0) {
        out.push(`image failed to load with no fallback: ${img.getAttribute('src')?.slice(0, 60)}`);
        continue;
      }
      const fit = getComputedStyle(img).objectFit;
      if (fit === 'fill' || fit === 'none') {
        const natural = img.naturalWidth / img.naturalHeight;
        const shown = r.width / r.height;
        if (natural && Math.abs(natural - shown) / natural > 0.02) {
          out.push(`image stretched (object-fit:${fit}, ${shown.toFixed(2)} vs natural ${natural.toFixed(2)}): ${describe(img)}`);
        }
      }
    }
    return out;
  }, { describeSrc: DESCRIBE });
}

// ---------- 7. accessibility ----------
export async function axeCheck(page, AxeBuilder) {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  return results.violations.map((v) =>
    `a11y ${v.id} (${v.impact}): ${v.help} — ${v.nodes.length} node(s), e.g. ${v.nodes[0]?.target?.join(' ')}`);
}

/** Every check except axe, which needs its own import in the spec file. */
export async function runLayoutChecks(page, { width, phone }) {
  const out = {};
  out['horizontal scroll'] = await noHorizontalScroll(page, width);
  out['overlap'] = await noOverlap(page);
  out['chrome covers content'] = await chromeClearsContent(page);
  out['clipped text'] = await noClippedText(page);
  out['broken data'] = await noBrokenData(page);
  out['images'] = await imagesOk(page);
  if (phone) out['tap targets'] = await tapTargets(page);
  return out;
}
