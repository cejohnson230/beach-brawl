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
const wods = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/workouts.json'), 'utf8'));

// --- extract the DOM-free portions of the engine -------------------------
// Two windows: the time engine, and the arena-view builder (which needs only
// DATA, esc and arenaCls from the first). Anything touching the DOM, the
// clock interval or localStorage stays out of both.
function slice(from, to, label) {
  const a = page.indexOf(from);
  const b = page.indexOf(to, a + 1);
  assert.ok(a > 0 && b > a, `could not locate ${label} in index.html`);
  return page.slice(a, b);
}
const src =
  slice('var partsFmt = new Intl.DateTimeFormat',
        '/* ==================================================================\n     Render',
        'time engine') +
  '\n' +
  slice('function arenaSections(day, c){',
        '  // #body is rebuilt from a string',
        'arena view');

assert.ok(!/localStorage/.test(src),
  'extracted block must stay DOM-free: localStorage leaked back in');
assert.ok(!/document\./.test(src),
  'extracted block must stay DOM-free: document access leaked back in');

const engine = new Function(
  'DATA', 'WODS', 'TZ', 'location',
  src + '\nreturn {wallToEpoch,venueParts,venueDateISO,venueOffset,classify,dayBounds,autoDay,fmtClock,fmtDur,fmtMins,DAYS,arenaSections,arenaCls,wodFor,pickDivision,divisionChoices,wodTag,normDiv};'
)(data, wods, data.timeZone, { search: '' });

const { wallToEpoch, venueDateISO, venueOffset, classify, dayBounds, autoDay, fmtClock, fmtDur, DAYS,
        arenaSections, arenaCls, wodFor, pickDivision, divisionChoices, wodTag, normDiv } = engine;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

const SAT = DAYS.saturday, SUN = DAYS.sunday, FRI = DAYS.friday;
// The arenas a given day actually runs, in event order.
const eventsOf = day => [...new Map(day.entries.map(e => [e.eventNo, e.arena]))]
  .sort((a, b) => a[0] - b[0]);
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
t('before the weekend -> friday', () => {
  assert.strictEqual(autoDay(Date.parse('2026-09-21T17:00:00Z')), 'friday');
});
t('during friday -> friday', () => {
  assert.strictEqual(autoDay(at(FRI, '10:45')), 'friday');
});
t('friday evening rolls on to saturday', () => {
  assert.strictEqual(autoDay(at(FRI, '20:00')), 'saturday');
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
  assert.deepStrictEqual(
    c.next.map(r => r.e.name).sort(),
    SAT.entries.filter(e => e.heat === 7).map(e => e.name).sort());
  // The 9:15 heat legitimately overlaps and is still running.
  assert.deepStrictEqual(
    c.live.map(r => r.e.name).sort(),
    SAT.entries.filter(e => e.time === '9:15 AM').map(e => e.name).sort());
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
  assert.deepStrictEqual(
    c.next.map(r => r.e.name).sort(),
    SAT.entries.filter(e => e.time === '11:35 AM').map(e => e.name).sort());
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
  assert.strictEqual(c.upcoming.length, SAT.entries.length);
});
t('after last heat everything is done', () => {
  const c = classify(SAT, at(SAT, '18:00'));
  assert.strictEqual(c.done.length, SAT.entries.length);
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

console.log('\narena view');
t('each arena maps to its own colour class, in sheet order', () => {
  assert.deepStrictEqual(data.arenas.map(arenaCls),
    data.arenas.map((_, i) => 'a' + i));
  assert.strictEqual(data.arenas.length, 5, 'four arenas plus the beach event');
  assert.strictEqual(arenaCls('Elite Beach Event'), 'a4');
  assert.strictEqual(arenaCls('Not An Arena'), '');
});
t('emits one section per event the day actually runs', () => {
  for (const [day, when, want] of [[SAT, '14:31', 4], [SUN, '13:20', 4], [FRI, '10:45', 1]]) {
    const html = arenaSections(day, classify(day, at(day, when)));
    eventsOf(day).forEach(([no, arena]) => {
      assert.ok(html.includes('<i>Event ' + no + '</i><b>' + arena + '</b>'),
        `${day.id}: missing section for ${arena}`);
    });
    assert.strictEqual((html.match(/<section class="sec /g) || []).length, want, day.id);
  }
});
t('a section lists only its own arena, in time order', () => {
  const html = arenaSections(SAT, classify(SAT, at(SAT, '14:31')));
  eventsOf(SAT).forEach(([, arena], i) => {
    const body = html.split('<section class="sec ')[i + 1];
    const expected = SAT.entries
      .filter(e => e.arena === arena)
      .sort((x, y) => x.startSec - y.startSec || x.name.localeCompare(y.name));
    const got = [...body.matchAll(/<div class="who">([^<]+)<\/div>/g)].map(m => m[1]);
    assert.deepStrictEqual(got, expected.map(e => e.name), arena);
  });
});
t('live beats done and next when a row is tagged', () => {
  const when = at(SAT, '14:31');
  const html = arenaSections(SAT, classify(SAT, when));
  // Heat 23 at 2:30 PM: Ant Oxley (LRX), Bailey Barnard + Keith Caldwell (Backout)
  assert.strictEqual((html.match(/class="tag">Now</g) || []).length, 3);
  // Adam Morgan at 2:45 PM is the only thing queued next.
  assert.strictEqual((html.match(/class="tag">Next</g) || []).length, 1);
  const adam = html.split('ADAM MORGAN').length > 1 || html.includes('Adam Morgan');
  assert.ok(adam, 'Adam Morgan should appear');
});
t('completed rows are marked done, upcoming rows are unmarked', () => {
  const html = arenaSections(SAT, classify(SAT, at(SAT, '14:31')));
  const rows = [...html.matchAll(/<div class="arow ([^"]*)">\s*<b class="t num">([^<]+)<\/b><div class="who">([^<]+)</g)]
    .map(m => ({ cls: m[1].trim(), time: m[2], name: m[3] }));
  assert.strictEqual(rows.length, SAT.entries.length,
    'every entry should render exactly once');
  const antE1 = rows.find(r => r.name === 'Ant Oxley' && r.time === '9:30 AM');
  assert.strictEqual(antE1.cls, 'is-done');
  const antLive = rows.find(r => r.name === 'Ant Oxley' && r.time === '2:30 PM');
  assert.strictEqual(antLive.cls, 'is-live');
  const antLater = rows.find(r => r.name === 'Ant Oxley' && r.time === '5:00 PM');
  assert.strictEqual(antLater.cls, '');
});
t('before the first heat nothing is marked done', () => {
  const html = arenaSections(SAT, classify(SAT, at(SAT, '7:00')));
  assert.ok(!html.includes('is-done'));
  assert.strictEqual((html.match(/class="tag">Next</g) || []).length, 3);
});

console.log('\nworkouts');
t('every event on both days has a workout attached', () => {
  for (const day of [SAT, SUN]) {
    for (let n = 1; n <= 4; n++) {
      const w = wodFor(day, n);
      assert.ok(w, `${day.id} event ${n} has no workout`);
      assert.ok(w.cap, `${day.id} event ${n} has no time cap`);
      assert.ok(w.divisions.length, `${day.id} event ${n} has no divisions`);
    }
  }
});
t('workout arenas agree with the heat sheet, despite the spellings', () => {
  // Sheet: "Backout Barbell" / "LRX Beach".  Site: "Blackout Barbell" / "LRX".
  const kw = { 1: 'barbell', 2: 'mayhem', 3: 'lrx', 4: 'apparel' };
  for (const day of [SAT, SUN]) {
    for (let n = 1; n <= 4; n++) {
      assert.ok(wodFor(day, n).arena.toLowerCase().includes(kw[n]));
      const sheet = day.entries.find(e => e.eventNo === n).arena.toLowerCase();
      assert.ok(sheet.includes(kw[n]));
    }
  }
});
t('division choices come from the most granular event', () => {
  assert.deepStrictEqual(divisionChoices(SAT).map(normDiv),
    ['elite', 'rx', 'intermediate', 'masters40+', 'masters50+', 'scaled', 'teen1617', 'teen1415']);
  assert.deepStrictEqual(divisionChoices(SUN).map(normDiv),
    ['rx', 'intermediate', 'masters40+', 'scaled']);
});
t('RX picks the RX loads, not Elite', () => {
  const d = pickDivision(wodFor(SAT, 1), 'RX');
  assert.strictEqual(d.name, 'RX');
  assert.ok(d.lines.some(l => l.includes('(135/95)')));
  assert.ok(!d.lines.some(l => l.includes('(155/105)')));
});
t('Masters 50+ is not confused with Masters 40+', () => {
  const d = pickDivision(wodFor(SAT, 1), 'Masters 50+');
  assert.strictEqual(d.name, 'Masters 50+');
  const d40 = pickDivision(wodFor(SAT, 1), 'Masters 40+');
  assert.strictEqual(d40.name, 'Intermediate/ Masters 40+');
});
t('a choice with no block of its own falls into the combined block', () => {
  // Event 3 rolls everything below RX into one block including "Teens".
  const d = pickDivision(wodFor(SAT, 3), 'Teen (16-17)');
  assert.ok(/teens/i.test(d.name), 'expected the combined block, got ' + d.name);
  assert.ok(d.lines.some(l => l.includes('(80/50)')));
});
t('every division choice resolves on every event of its day', () => {
  for (const day of [SAT, SUN]) {
    for (const choice of divisionChoices(day)) {
      for (let n = 1; n <= 4; n++) {
        const d = pickDivision(wodFor(day, n), choice);
        assert.ok(d && d.lines.length, `${day.id} event ${n} / ${choice}`);
      }
    }
  }
});
t('the tag line reads format then cap', () => {
  assert.strictEqual(wodTag(SAT, 1), 'For Time · 12:00 cap');
  assert.strictEqual(wodTag(SAT, 2), '3 Rounds for time · 12:00 cap');
  assert.strictEqual(wodTag(SUN, 4), 'For max weight · 13:00 cap');
});

console.log('\nfriday');
t('Friday is one heat at 10:30 AM with both athletes', () => {
  assert.strictEqual(FRI.entries.length, 2);
  assert.deepStrictEqual(
    FRI.entries.map(e => `${e.name} L${e.lane}`),
    ['Whitney Dunn L1', 'Savannah Branch L2']);
  FRI.entries.forEach(e => {
    assert.strictEqual(e.time, '10:30 AM');
    assert.strictEqual(e.heat, 1);
    assert.strictEqual(e.arena, 'Elite Beach Event');
  });
});
t('Friday runs on a 45-minute heat', () => {
  assert.strictEqual(FRI.heatMinutes, 45);
  const b = dayBounds(FRI);
  assert.strictEqual(fmtClock(b.first), '10:30 AM');
  assert.strictEqual(fmtClock(b.last), '11:15 AM');
});
t('both are live through the heat and done after it', () => {
  assert.strictEqual(classify(FRI, at(FRI, '10:29')).live.length, 0);
  assert.strictEqual(classify(FRI, at(FRI, '10:30')).live.length, 2);
  assert.strictEqual(classify(FRI, at(FRI, '11:14')).live.length, 2);
  assert.strictEqual(classify(FRI, at(FRI, '11:15')).live.length, 0);
  assert.strictEqual(classify(FRI, at(FRI, '11:15')).done.length, 2);
});
t('Friday has the beach event workout and no division to pick', () => {
  const w = wodFor(FRI, 1);
  assert.ok(w, 'no Friday workout');
  assert.strictEqual(w.arena, 'Elite Beach Event');
  assert.ok(w.divisions[0].lines.some(l => /500 Meter Swim/.test(l)));
  assert.deepStrictEqual(divisionChoices(FRI), []);
});
t('neither is still listed as a Saturday TBD', () => {
  assert.deepStrictEqual(SAT.tbd, []);
  assert.ok(!SAT.entries.some(e => /Whitney|Savannah/.test(e.name)));
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
