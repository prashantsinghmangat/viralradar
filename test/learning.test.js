// Tests for shared/learning.mjs — turning logged results into something a
// prompt can lean on.
//
// The thresholds are the whole point of this module, and both of them exist to
// stop it saying something confident about nothing. A generator told "your best
// hook is X" after two videos would narrow itself on an accident and keep
// narrowing, so the tests here are mostly about the cases where it must stay
// quiet.
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../shared/learning.mjs');

/** A result row, with only the fields the lesson reads. */
const row = (format, hook, len, cta, views, saves = 0) => ({ format, hook, len, cta, views, saves });

/** n videos that are identical apart from their views, so groups are easy to control. */
const many = (n, over = {}) => Array.from({ length: n }, (_, i) => ({
  format: 'demo', hook: 'I found', len: '30s', cta: 'save this', views: 1000, saves: 10, ...over, id: `r${i}`,
}));

test('fewer than five results says nothing at all', async () => {
  const { resultsLesson, MIN_RESULTS } = await load();
  assert.equal(MIN_RESULTS, 5);

  for (let n = 0; n < 5; n++) {
    // Deliberately well-shaped data: two clear groups per dimension, which
    // would produce a confident summary if the count threshold were missing.
    const rows = [
      ...Array.from({ length: Math.ceil(n / 2) }, () => row('demo', 'I found', '30s', 'save this', 9000)),
      ...Array.from({ length: Math.floor(n / 2) }, () => row('listicle', 'top 3', '60s', 'comment for the link', 100)),
    ];
    const lesson = resultsLesson(rows);
    assert.equal(lesson.active, false, `${n} results should not produce a lesson`);
    assert.equal(lesson.summary, '', `${n} results should produce an empty summary`);
    assert.deepEqual(lesson.dimensions, []);
    assert.equal(lesson.count, n, 'it should still report how many there are');
  }
});

test('an empty or missing list is handled, not thrown at', async () => {
  const { resultsLesson } = await load();
  for (const input of [[], null, undefined, 'nonsense']) {
    const lesson = resultsLesson(input);
    assert.equal(lesson.active, false);
    assert.equal(lesson.summary, '');
  }
});

test('a group with one video in it is ignored', async () => {
  const { resultsLesson, MIN_PER_GROUP } = await load();
  assert.equal(MIN_PER_GROUP, 2);

  // Five results: 'demo' four times, and one single spectacular 'story'.
  // A one-video group is an anecdote — and worse, it is simultaneously the best
  // and the worst of its kind, so letting it in makes the summary contradict
  // itself. It must not appear, however big its numbers.
  const rows = [
    ...Array.from({ length: 4 }, () => row('demo', 'I found', '30s', 'save this', 1000)),
    row('story', 'I found', '30s', 'save this', 999999),
  ];
  const lesson = resultsLesson(rows);
  assert.ok(!lesson.summary.includes('story'), 'a single video must not become "your best format"');
  // And with only one qualifying format group, the format dimension says
  // nothing either: "best" needs something to be better than.
  assert.ok(!lesson.dimensions.some((d) => d.key === 'format'),
    'one qualifying group is not enough to name a best and a worst');
});

test('a dimension with only one kind in it says nothing', async () => {
  const { resultsLesson } = await load();
  // Six videos, every one a 'demo' with the same hook. There is no comparison
  // to make, and "your best format is demo" would be vacuous — it is the only
  // format ever tried, which is exactly where a new channel starts.
  const lesson = resultsLesson(many(6));
  assert.equal(lesson.active, false);
  assert.equal(lesson.summary, '');
});

test('with enough spread it names the best and the weakest of each dimension', async () => {
  const { resultsLesson } = await load();
  const rows = [
    // demo: 2 videos averaging 10,000
    row('demo', 'I found', '30s', 'save this', 12000),
    row('demo', 'I found', '30s', 'save this', 8000),
    // listicle: 2 videos averaging 500
    row('listicle', 'top 3', '60s', 'comment for the link', 600),
    row('listicle', 'top 3', '60s', 'comment for the link', 400),
    // story: 2 videos averaging 3,000
    row('story', 'you will not believe', '45s', 'follow for a new tool every day', 3500),
    row('story', 'you will not believe', '45s', 'follow for a new tool every day', 2500),
  ];
  const lesson = resultsLesson(rows);

  assert.equal(lesson.active, true);
  assert.equal(lesson.count, 6);

  const format = lesson.dimensions.find((d) => d.key === 'format');
  assert.equal(format.best.label, 'demo');
  assert.equal(format.best.avg_views, 10000);
  assert.equal(format.weakest.label, 'listicle');
  assert.equal(format.weakest.avg_views, 500);

  // Every dimension that has the spread should be there, under a label a
  // person would recognise rather than the column name.
  assert.deepEqual(lesson.dimensions.map((d) => d.key).sort(), ['cta', 'format', 'hook', 'len']);
  assert.equal(lesson.dimensions.find((d) => d.key === 'len').label, 'length');
  assert.equal(lesson.dimensions.find((d) => d.key === 'cta').label, 'call to action');
});

test('the summary is written for a model to act on', async () => {
  const { resultsLesson, EXPLORE_ONE_IN } = await load();
  const rows = [
    row('demo', 'I found', '30s', 'save this', 12000),
    row('demo', 'I found', '30s', 'save this', 8000),
    row('listicle', 'top 3', '60s', 'comment for the link', 600),
    row('listicle', 'top 3', '60s', 'comment for the link', 400),
    row('story', 'maybe', '45s', 'follow for a new tool every day', 3000),
  ];
  const lesson = resultsLesson(rows);

  assert.match(lesson.summary, /from 5 logged videos/);
  assert.match(lesson.summary, /"demo" does best/);
  assert.match(lesson.summary, /"listicle" does worst/);
  assert.match(lesson.summary, /2 videos/, 'how much is behind a claim matters as much as the claim');
  // Views in a form a model will not misread as a precise figure.
  assert.match(lesson.summary, /10K average views/);

  // Without this the generator converges: every suggestion becomes the one
  // shape that has worked, and nothing new is ever tried.
  assert.match(lesson.summary, new RegExp(`one suggestion in ${EXPLORE_ONE_IN}`));
  assert.match(lesson.summary, /deliberately different/);
  assert.match(lesson.summary, /only what has been\ntried so far/);
});

test('a group labelled "(none)" is never named as a winner', async () => {
  const { resultsLesson } = await load();
  // Rows with a blank format are grouped as "(none)" by groupStats. Telling the
  // model "your best format is (none)" would be nonsense advice.
  const rows = [
    row('', 'I found', '30s', 'save this', 50000),
    row('', 'I found', '30s', 'save this', 50000),
    row('demo', 'I found', '30s', 'save this', 1000),
    row('demo', 'I found', '30s', 'save this', 1000),
    row('listicle', 'top 3', '60s', 'save this', 900),
  ];
  const lesson = resultsLesson(rows);
  assert.ok(!lesson.summary.includes('(none)'), 'an unlabelled group must not be presented as a finding');
});

test('the label the UI shows matches what is actually on', async () => {
  const { lessonLabel, resultsLesson } = await load();
  assert.equal(lessonLabel(null), '');
  assert.equal(lessonLabel({ active: false, count: 3 }), '', 'nothing to boast about below the threshold');
  assert.equal(lessonLabel({ active: true, count: 12 }), 'Personalised from your 12 logged videos');
  // And it agrees with the lesson it describes.
  assert.equal(lessonLabel(resultsLesson([])), '');
});
