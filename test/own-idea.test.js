// Tests for shared/own-idea.mjs: New Project's form validation, link
// cleanup, the "keep my words exactly" check vr-generate enforces, and the
// payload/note built from a submission so the creator's original input is
// never lost.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IDEA_MODES, MAX_IDEA_LINKS, cleanIdeaLinks, validateNewProject,
  keepsExact, joinedSpoken, originalIdeaPayload, originalIdeaNote,
} = require('../shared/own-idea.mjs');

// ---------- validation ----------

test('every mode needs a title', () => {
  for (const mode of IDEA_MODES) {
    assert.match(validateNewProject({ mode, title: '' }) || '', /title/i);
    assert.match(validateNewProject({ mode, title: '   ' }) || '', /title/i);
  }
});

test('an unknown mode is refused before anything else is checked', () => {
  assert.match(validateNewProject({ mode: 'bogus', title: 'x' }), /choose/i);
});

test('"my own script" needs the script itself; the other two modes do not', () => {
  assert.match(validateNewProject({ mode: 'own_script', title: 'x', myScript: '' }), /script/i);
  assert.equal(validateNewProject({ mode: 'own_script', title: 'x', myScript: 'Hello there.' }), null);
  assert.equal(validateNewProject({ mode: 'generate', title: 'x' }), null);
  assert.equal(validateNewProject({ mode: 'save_only', title: 'x' }), null);
});

// ---------- links ----------

test('links are capped at five and cleaned the same way research links are', () => {
  const links = Array.from({ length: 8 }, (_, i) => `https://example.com/${i}`);
  assert.equal(cleanIdeaLinks(links).length, MAX_IDEA_LINKS);
});

test('a blank line or junk among the links is dropped, not passed through', () => {
  assert.deepEqual(cleanIdeaLinks(['https://example.com', '', '   ', 'not a url']), ['https://example.com/']);
});

// ---------- keepsExact ----------

test('keepsExact passes when the beats carry the same words, only reflowed into beats', () => {
  const myScript = 'Stop paying for background removal.\nThis site does it free, in one click.';
  const beats = [{ t: '0-3s', say: 'Stop paying for background removal.' }, { t: '3-8s', say: 'This site does it free, in one click.' }];
  assert.equal(keepsExact(myScript, beats), true);
});

test('keepsExact only tolerates whitespace differences, not rewording', () => {
  const myScript = 'Stop paying for background removal.';
  assert.equal(keepsExact(myScript, [{ say: 'Stop paying for background removal.' }]), true);
  assert.equal(keepsExact(myScript, [{ say: '  Stop   paying for  background removal.  ' }]), true, 'whitespace-only differences must still pass');
});

test('keepsExact catches a model that rewrote, reordered, shortened, or added a line', () => {
  const myScript = 'Stop paying for this. It is free. Try it now.';
  const original = ['Stop paying for this.', 'It is free.', 'Try it now.'];
  const say = (lines) => lines.map((t) => ({ say: t }));

  assert.equal(keepsExact(myScript, say(original)), true, 'sanity check: the unmodified split passes');
  assert.equal(keepsExact(myScript, say(['Stop paying for that.', ...original.slice(1)])), false, 'a reworded line must be caught');
  assert.equal(keepsExact(myScript, say([original[1], original[0], original[2]])), false, 'a reordered line must be caught');
  assert.equal(keepsExact(myScript, say(original.slice(0, 2))), false, 'a dropped line must be caught');
  assert.equal(keepsExact(myScript, say([...original, 'One more thing!'])), false, 'an added line must be caught');
});

test('keepsExact on no beats at all is only true for an empty script', () => {
  assert.equal(keepsExact('', []), true);
  assert.equal(keepsExact('Something was said.', []), false);
});

test('joinedSpoken ignores a beat with nothing spoken rather than inserting a blank', () => {
  assert.equal(joinedSpoken([{ say: 'One.' }, { say: '' }, { say: 'Two.' }]), 'One. Two.');
});

// ---------- the original input, preserved ----------

test('originalIdeaPayload keeps the mode, title, details and links for every mode', () => {
  const payload = originalIdeaPayload({ mode: 'generate', title: '  A background remover  ', details: 'free tier', links: ['https://bgless.example'] });
  assert.equal(payload.mode, 'generate');
  assert.equal(payload.title, 'A background remover');
  assert.equal(payload.details, 'free tier');
  assert.deepEqual(payload.links, ['https://bgless.example/']);
  assert.equal('my_script' in payload, false, 'only own_script carries a script');
});

test('originalIdeaPayload keeps the script and the keep-exact choice only for own_script', () => {
  const payload = originalIdeaPayload({ mode: 'own_script', title: 'x', myScript: 'My words.', keepExact: true });
  assert.equal(payload.my_script, 'My words.');
  assert.equal(payload.keep_exact, true);
});

test('originalIdeaNote renders every field a reader would want back, and nothing crashes on a bare object', () => {
  const payload = originalIdeaPayload({
    mode: 'own_script', title: 'A background remover', details: '', myScript: 'Stop paying for this.', keepExact: false,
    links: ['https://bgless.example'],
  });
  const note = originalIdeaNote(payload);
  assert.match(note, /A background remover/);
  assert.match(note, /Stop paying for this\./);
  assert.match(note, /polish lightly/i);
  assert.match(note, /https:\/\/bgless\.example/);
  assert.doesNotThrow(() => originalIdeaNote({}));
  assert.doesNotThrow(() => originalIdeaNote(null));
});
