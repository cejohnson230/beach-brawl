/**
 * Tests the page's time engine by extracting the pure section of the
 * inline script (everything from the Intl formatter down to classify())
 * and evaluating it against the real generated schedule.
 *
 * Run: node test/time-engine.test.js
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..');
const page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/schedule.json'), 'utf8'));

// --- extract the DOM-free portion of the engine --------------------------
const START = 'var partsFmt = new Intl.DateTimeFormat';
const END = '/* ==================================================================\n     Render';
const a = page.indexOf(START);
const b = page.indexOf(END);
assert.ok(a > 0 && b > a, 'could not locate engine block in index.html');
const src = page.slice(a, b);

const sandbox = { DATA: data, TZ: data.timeZone, location: { search: '' }, document: null };
const engine = new Function(
  'DATA', 'TZ', 'location',
  src + '\nreturn {wallToEpoch,venueParts,venueDateISO,venueOffset,classify,dayBounds,autoDay,fmtClock,fmtDur,fmtMins,DAYS};'
)(sandbox.DATA, sandbox.TZ, sandbox.location);

const { wallToEpoch, venueDateISO, venueOffset, classify, dayBounds, autoDay, fmtClock, fmtDur, DAYS } = engine;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const SAT = DAYS.saturday, SUN = DAYS.sunday;
const at = (day, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return wallToEpoch(day.date, h * 3600 + m * 60);
};

console.log('\ntimezone anchoring');
t('event weekend resolves to CDT (UTC-5)', () => {
  assert.strictEqual(venueOffset(at(SAT, '12:00')), -5 * 3600 * 1000);
});
t('8:15 AM Sat CDT === 13:15 UTC', () => {
  assert.strictEqual(new Date(at(SAT, '8:15')).toISOString(), '2026-09-26T13:15:00.000Z');
});
t('wall-clock round-trips through venueDateISO', () => {
  assert.strictEqual(venueDateISO(at(SAT, '8:15')), '2026-09-26');
  assert.strictEqual(venueDateISO(at(SUN, '16:55')), '2026-09-27');
});
t('late-evening instant does not roll to the next venue date', () => {
  assert.strictEqual(venueDateISO(at(SAT, '23:59')), '2026-09-26');
});
t('midnight venue time maps to hour 0, not 24', () => {
  assert.strictEqual(engine.venueParts(at(SAT, '0:00')).hour, 0);
});
t('survives a DST boundary (Nov 1 2026 fall-back)', () => {
  assert.strictEqual(venueOffset(wallToEpoch('2026-11-02', 12 * 3600)), -6 * 3600 * 1000);
});

console.log('\nday bounds');
t('Saturday spans 8:15 AM to 5:30 PM (last heat + 15m)', () => {
  const b = dayBounds(SAT);
  assert.strictEqual(fmtClock(b.first), '8:15 AM');
  assert.strictEqual(fmtClock(b.last), '5:30 PM');
});
t('Sunday spans 8:00 AM to 5:12 PM (last heat + 17m)', () => {
  const b = dayBounds(SUN);
  assert.strictEqual(fmtClock(b.first), '8:00 AM');
  assert.strictEqual(fmtClock(b.last), '5:12 PM');
});

console.log('\nauto day selection');
t('before the weekend -> saturday', () => {
  assert.strictEqual(autoDay(Date.parse('2026-09-21T17:00:00Z')), 'saturday');
});
t('during saturday -> saturday', () => {
  assert.strictEqual(autoDay(at(SAT, '14:31')), 'saturday');
});
t('during sunday -> sunday', () => {
  assert.strictEqual(autoDay(at(SUN, '10:00')), 'sunday');
});
t('saturday night after last heat -> sunday', () => {
  assert.strictEqual(autoDay(at(SAT, '22:00')), 'sunday');
});
t('after the weekend -> sunday', () => {
  assert.strictEqual(autoDay(Date.parse('2026-10-05T17:00:00Z')), 'sunday');
});

console.log('\nclassification boundaries (Saturday, 15 min heats)');
t('exact start counts as live, not upcoming', () => {
  const c = classify(SAT, at(SAT, '9:30'));
  const names = c.live.map(r => r.e.name).sort();
  assert.deepStrictEqual(names, ['Ant Oxley', 'Bailey Barnard', 'Keith Caldwell']);
});
t('one second before start, heat 7 is next not live', () => {
  const c = classify(SAT, at(SAT, '9:30') - 1000);
  assert.strictEqual(c.live.filter(r => r.e.heat === 7).length, 0, 'heat 7 must not be live yet');
  assert.strictEqual(c.next.length, 3, 'all three heat-7 entries queued as next');
  // Nick Stanley's 9:15 heat legitimately overlaps and is still running.
  assert.deepStrictEqual(c.live.map(r => r.e.name), ['Nick Stanley']);
});
t('last second of the heat is still live', () => {
  const c = classify(SAT, at(SAT, '9:30') + 15 * 60000 - 1000);
  assert.strictEqual(c.live.length, 3);
});
t('exact end is done, not live', () => {
  const c = classify(SAT, at(SAT, '9:30') + 15 * 60000);
  assert.strictEqual(c.live.filter(r => r.e.heat === 7).length, 0);
});
t('9:30 heat 7 shows the right arenas', () => {
  const c = classify(SAT, at(SAT, '9:32'));
  const m = {};
  c.live.forEach(r => { m[r.e.name] = r.e.arena + ' L' + r.e.lane; });
  assert.strictEqual(m['Ant Oxley'], 'Backout Barbell Arena L5');
  assert.strictEqual(m['Keith Caldwell'], 'LRX Beach Arena L6');
  assert.strictEqual(m['Bailey Barnard'], 'LRX Beach Arena L5');
});

console.log('\ngap handling');
t('11:15 AM Saturday is a real gap with next at 11:35', () => {
  const c = classify(SAT, at(SAT, '11:15'));
  assert.strictEqual(c.live.length, 0, 'expected nobody live');
  assert.strictEqual(fmtClock(c.nextStart), '11:35 AM');
  assert.strictEqual(c.next[0].e.name, 'Nick Stanley');
});
t('10:55 AM is NOT a gap — Caryn Ligon is mid-heat', () => {
  const c = classify(SAT, at(SAT, '10:55'));
  assert.deepStrictEqual(c.live.map(r => r.e.name), ['Caryn Ligon']);
});
t('Saturday has seven crew gaps of 5 min or more', () => {
  const b = dayBounds(SAT);
  let gaps = 0, open = null;
  for (let t0 = b.first; t0 <= b.last; t0 += 60000) {
    const n = classify(SAT, t0).live.length;
    if (n === 0 && open === null) open = t0;
    if (n > 0 && open !== null) {
      if (t0 - open >= 5 * 60000) gaps++;
      open = null;
    }
  }
  assert.strictEqual(gaps, 7);
});
t('pre-first-heat has no done entries', () => {
  const c = classify(SAT, at(SAT, '7:00'));
  assert.strictEqual(c.done.length, 0);
  assert.strictEqual(c.upcoming.length, 36);
});
t('after last heat everything is done', () => {
  const c = classify(SAT, at(SAT, '18:00'));
  assert.strictEqual(c.done.length, 36);
  assert.strictEqual(c.live.length, 0);
  assert.strictEqual(c.nextStart, null);
});

console.log('\nSunday uses 17-minute heats');
t('Sunday heat still live at +16 min', () => {
  const c = classify(SUN, at(SUN, '8:00') + 16 * 60000);
  assert.strictEqual(c.live.length, 1);
  assert.strictEqual(c.live[0].e.name, 'Ox Mommies');
});
t('Sunday heat done at +17 min, handing straight to the next team', () => {
  const c = classify(SUN, at(SUN, '8:00') + 17 * 60000);
  assert.strictEqual(c.live.filter(r => r.e.name === 'Ox Mommies').length, 0,
    'Ox Mommies must be done at exactly +17');
  // 8:17 is also OxFit Average Bros' start — a legitimate handoff.
  assert.deepStrictEqual(c.live.map(r => r.e.name), ['OxFit Average Bros']);
});
t('Average Bros Event 3 is Lane 2, exactly as the sheet says', () => {
  const e = SUN.entries.find(x => x.name === 'OxFit Average Bros' && x.eventNo === 3);
  assert.strictEqual(e.lane, 2);
  assert.strictEqual(e.heat, 16);
  assert.strictEqual(e.time, '1:17 PM');
});

console.log('\nno competitor is ever live in two places');
t('every minute of both days', () => {
  for (const day of [SAT, SUN]) {
    const b = dayBounds(day);
    for (let t0 = b.first; t0 <= b.last; t0 += 60000) {
      const seen = new Set();
      for (const r of classify(day, t0).live) {
        assert.ok(!seen.has(r.e.name),
          `${r.e.name} live twice at ${fmtClock(t0)} on ${day.id}`);
        seen.add(r.e.name);
      }
    }
  }
});

console.log('\nduration formatting');
t('sub-hour, hour, and multi-day forms', () => {
  assert.strictEqual(fmtDur(45), '0:45');
  assert.strictEqual(fmtDur(14 * 60 + 7), '14:07');
  assert.strictEqual(fmtDur(3 * 3600 + 5 * 60 + 9), '3:05:09');
  assert.strictEqual(fmtDur(4 * 86400 + 19 * 3600 + 44 * 60), '4d 19h 44m');
  assert.strictEqual(fmtDur(-5), '0:00');
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
