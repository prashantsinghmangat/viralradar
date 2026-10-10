// Roll the per-case findings up into something readable: how often each
// distinct problem occurs, and where. Run: node qa/summarise.mjs [before|after]
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const phase = process.argv[2] || 'before';
const dir = resolve(fileURLToPath(new URL('.', import.meta.url)), 'results', phase);

let files = [];
try { files = (await readdir(dir)).filter((f) => f.endsWith('.json')); } catch { /* none */ }

const cases = [];
for (const f of files) cases.push(JSON.parse(await readFile(resolve(dir, f), 'utf8')));

// Group by kind, then by the shape of the detail (numbers stripped) so the
// same bug at twelve widths reads as one line, not twelve.
const groups = new Map();
for (const c of cases) {
  for (const p of c.problems) {
    const shape = p.detail.replace(/\d+(\.\d+)?/g, 'N').slice(0, 170);
    const key = `${p.kind} :: ${shape}`;
    if (!groups.has(key)) groups.set(key, { kind: p.kind, shape, example: p.detail, where: [] });
    groups.get(key).where.push(`${c.screen}@${c.width}/${c.theme}`);
  }
}

const sorted = [...groups.values()].sort((a, b) => b.where.length - a.where.length);
console.log(`${phase}: ${cases.length} of 384 cases have findings; ${sorted.length} distinct problems\n`);
const byKind = new Map();
for (const g of sorted) byKind.set(g.kind, (byKind.get(g.kind) || 0) + g.where.length);
console.log('By kind:');
for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(5)}  ${k}`);
console.log('');
for (const g of sorted) {
  const widths = [...new Set(g.where.map((w) => w.split('@')[1].split('/')[0]))].sort((a, b) => a - b);
  const screens = [...new Set(g.where.map((w) => w.split('@')[0]))];
  const themes = [...new Set(g.where.map((w) => w.split('/')[1]))];
  console.log(`[${g.kind}] x${g.where.length}  widths=${widths.join(',')}  themes=${themes.join(',')}`);
  console.log(`   ${g.example}`);
  console.log(`   screens(${screens.length}): ${screens.slice(0, 8).join(', ')}${screens.length > 8 ? ' …' : ''}`);
  console.log('');
}
