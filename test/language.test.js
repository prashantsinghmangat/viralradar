// Tests for shared/language.mjs — detecting a trending video's language from
// its title's Unicode script, and the Radar's filter decision built on it.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../shared/language.mjs');

test('detectTitleScript recognises all nine Indic scripts from real sample titles', async () => {
  const { detectTitleScript } = await load();
  const samples = [
    ['हिन्दी वीडियो में यह मुफ्त AI टूल', 'hi'],
    ['தமிழ் விடியோ இது இலவச AI', 'ta'],
    ['తెలుగు వీడియో ఇది ఉచిత AI', 'te'],
    ['ಕನ್ನಡ ವೀಡಿಯೋ ಇದು ಉಚಿತ AI', 'kn'],
    ['മലയാളം വീഡിയോ ഇത് സൗജന്യമാണ്', 'ml'],
    ['বাংলা ভিডিও এটি বিনামূল্যে', 'bn'],
    ['ગુજરાતી વિડિઓ આ મફત છે', 'gu'],
    ['ਪੰਜਾਬੀ ਵੀਡੀਓ ਇਹ ਮੁਫਤ ਹੈ', 'pa'],
    ['ଓଡିଆ ଭିଡିଓ ଏହା ମାଗଣା', 'or'],
  ];
  for (const [title, expected] of samples) {
    assert.equal(detectTitleScript(title), expected, `"${title}" should detect as ${expected}`);
  }
});

test('detectTitleScript calls a Latin-lettered title "latin", not a guess at which language', async () => {
  const { detectTitleScript } = await load();
  assert.equal(detectTitleScript('This free AI tool removes backgrounds'), 'latin');
  assert.equal(detectTitleScript('Yeh bahut accha hai yaar'), 'latin', 'romanised Hindi is still Latin letters');
});

test('detectTitleScript finds nothing in a title with no linguistic signal at all', async () => {
  const { detectTitleScript } = await load();
  assert.equal(detectTitleScript('12345'), '');
  assert.equal(detectTitleScript('🔥🔥🔥 999'), '');
  assert.equal(detectTitleScript(''), '');
  assert.equal(detectTitleScript(null), '');
  assert.equal(detectTitleScript(undefined), '');
});

test('a title mixing scripts is caught by whichever range comes first — not every mix matters here', async () => {
  const { detectTitleScript } = await load();
  // Devanagari appears first in SCRIPT_RANGES and in the title; the point of
  // this test is just that a mixed title still returns something usable
  // rather than throwing or returning a blend.
  assert.equal(detectTitleScript('हिन्दी + English'), 'hi');
});

test('baseLanguage strips a region, case and the two "no real language" codes', async () => {
  const { baseLanguage } = await load();
  assert.equal(baseLanguage('en-US'), 'en');
  assert.equal(baseLanguage('hi_IN'), 'hi');
  assert.equal(baseLanguage('EN'), 'en');
  assert.equal(baseLanguage('und'), '', 'YouTube\'s "undetermined" is not a declaration');
  assert.equal(baseLanguage('zxx'), '', 'YouTube\'s "no linguistic content" is not a declaration');
  assert.equal(baseLanguage(''), '');
  assert.equal(baseLanguage(null), '');
  assert.equal(baseLanguage(undefined), '');
});

test('isLanguageAllowed trusts YouTube\'s own declaration over the title', async () => {
  const { isLanguageAllowed } = await load();
  // A Latin-script title but YouTube declares Tamil — the declaration wins,
  // and Tamil is not in the allowed list, so it is dropped even though the
  // title alone would have passed as ambiguous Latin.
  assert.equal(isLanguageAllowed({
    title: 'Oru Tamil Short Video', allowed: ['hi', 'en'], audioLanguage: 'ta',
  }), false);
  assert.equal(isLanguageAllowed({
    title: 'x', allowed: ['te'], defaultLanguage: 'te-IN',
  }), true);
});

test('isLanguageAllowed falls back to the title\'s script when there is no usable declaration', async () => {
  const { isLanguageAllowed } = await load();
  assert.equal(isLanguageAllowed({ title: 'ಕನ್ನಡ ವೀಡಿಯೋ', allowed: ['kn'] }), true);
  assert.equal(isLanguageAllowed({ title: 'ಕನ್ನಡ ವೀಡಿಯೋ', allowed: ['hi', 'en'] }), false);
  assert.equal(isLanguageAllowed({ title: 'ಕನ್ನಡ ವೀಡಿಯೋ', allowed: ['kn'], audioLanguage: 'und' }), true,
    '"und" is not a declaration, so the title still decides');
});

test('a Latin title is kept whenever Hindi or English is allowed, and dropped when neither is', async () => {
  const { isLanguageAllowed } = await load();
  assert.equal(isLanguageAllowed({ title: 'Free AI tool', allowed: ['hi'] }), true);
  assert.equal(isLanguageAllowed({ title: 'Free AI tool', allowed: ['en'] }), true);
  assert.equal(isLanguageAllowed({ title: 'Free AI tool', allowed: ['ta', 'te'] }), false);
});

test('a title with no usable signal at all is kept rather than guessed away', async () => {
  const { isLanguageAllowed } = await load();
  assert.equal(isLanguageAllowed({ title: '12345 999', allowed: ['ta'] }), true);
  assert.equal(isLanguageAllowed({ title: '', allowed: [] }), true);
});

test('isLanguageAllowed copes with no allowed list at all', async () => {
  const { isLanguageAllowed } = await load();
  assert.equal(isLanguageAllowed({ title: 'हिन्दी वीडियो' }), false);
  assert.equal(isLanguageAllowed({ title: '999 🔥' }), true, 'nothing to detect means nothing to filter out');
});
