// Every screen, every state, every width, both themes.
//
// Run with QA_SOFT=1 to record findings without failing — that is how the
// "before" pass is taken. Without it, any violation fails the run, which is
// what keeps the fixes from regressing.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootApp, gotoScreen, SCREENS, WIDTHS, THEMES } from '../lib/harness.mjs';
import { runLayoutChecks, axeCheck } from '../lib/checks.mjs';

const PHASE = process.env.QA_PHASE || 'before';
const SOFT = process.env.QA_SOFT === '1';
const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SHOTS = resolve(ROOT, 'qa/screenshots', PHASE);
const RESULTS = resolve(ROOT, 'qa/results', PHASE);

// Axe is slow; one phone width and one laptop width is enough to catch the
// contrast and labelling problems that are width-independent anyway.
const AXE_WIDTHS = new Set([390, 1280]);

for (const screen of SCREENS) {
  for (const { w, h, phone } of WIDTHS) {
    if (screen.phoneOnly && !phone) continue;
    for (const theme of THEMES) {
      test(`${screen.name} @ ${w} ${theme}`, async ({ page }) => {
        const { consoleErrors, failedRequests } = await bootApp(page, {
          theme,
          scenario: screen.scenario,
          signedOut: screen.signedOut,
        });
        await page.setViewportSize({ width: w, height: h });
        await gotoScreen(page, screen.hash);
        if (screen.setup) await screen.setup(page);
        await page.waitForTimeout(100);

        const shot = `${SHOTS}/${screen.name}--${w}--${theme}.png`;
        await mkdir(dirname(shot), { recursive: true });
        await page.screenshot({ path: shot, fullPage: true });

        const checks = await runLayoutChecks(page, { width: w, phone });
        if (AXE_WIDTHS.has(w)) checks['accessibility'] = await axeCheck(page, AxeBuilder);
        checks['console errors'] = consoleErrors;
        checks['failed requests'] = failedRequests;

        const problems = [];
        for (const [kind, list] of Object.entries(checks)) {
          for (const detail of list) problems.push({ kind, detail });
        }
        // One file per case, so parallel workers never race on the same write.
        if (problems.length) {
          await mkdir(RESULTS, { recursive: true });
          await writeFile(
            `${RESULTS}/${screen.name}--${w}--${theme}.json`,
            JSON.stringify({
              screen: screen.name, width: w, theme,
              shot: `qa/screenshots/${PHASE}/${screen.name}--${w}--${theme}.png`,
              problems,
            }, null, 2),
          );
        }

        if (!SOFT) {
          const summary = problems.map((p) => `[${p.kind}] ${p.detail}`).join('\n');
          expect(summary, `${screen.name} @ ${w} ${theme}\n${summary}`).toBe('');
        }
      });
    }
  }
}
