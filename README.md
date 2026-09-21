# Beach Brawl '26 — OxFit Heat Board

A live heat-and-lane board for the OxFit crew at Beach Brawl '26,
Pensacola Beach FL.

Answers one question at a glance: **who's competing right now, and who's next?**

- **Saturday 26 Sep** — 9 individuals (+2 TBD), 15-minute heats
- **Sunday 27 Sep** — 5 teams, 17-minute heats

All times are Pensacola Beach local (`America/Chicago`), pinned in the page —
the board shows the same thing no matter what timezone the viewer's phone is on.

## Layout

```
beach-brawl/
├── index.html              ← generated, deployed. Do not edit by hand.
├── src/index.template.html ← the real source
├── data/
│   ├── heat-sheet.csv      ← source of truth, as received
│   ├── schedule.json       ← generated from the CSV
│   └── workouts.json       ← scraped from pensacolabeachbrawl.com
├── build-workouts.py       ← scrapes the 8 workout pages → workouts.json
├── build-data.py           ← CSV + workouts.json → index.html
└── test/time-engine.test.js
```

## Build

```sh
python3 build-workouts.py    # only when the organisers change a workout
python3 build-data.py        # transcribe, verify, and inject into index.html
node test/time-engine.test.js
```

`build-data.py` refuses to write if the schedule fails any invariant:

- every competitor has exactly 4 entries, one per arena
- no competitor is in two places at once
- each heat number maps to exactly one start time
- no two competitors share an arena + heat + lane
- **heat numbers run in the same order as the clock** — this is the check that
  catches AM/PM parsing bugs, which are otherwise invisible because they
  corrupt every afternoon time identically
- every start time lands inside a plausible competition window

## Testing a specific moment

The clock is overridable, so every state is reachable without waiting for
the weekend:

```
?now=2026-09-26T08:00   before the first heat
?now=2026-09-26T14:31   three athletes mid-heat
?now=2026-09-26T11:15   a real gap (next at 11:35)
?now=2026-09-26T19:30   Saturday done, auto-flips to Sunday
?now=2026-09-27T13:20   Sunday teams, mid-heat
?now=2026-09-27T18:00   weekend complete
```

## Workouts

Each event's workout is scraped from its page on pensacolabeachbrawl.com —
format, time cap, the movements for every division, and any event notes.
Movement standards run to thousands of words and are deliberately not
captured; each workout links out to the official write-up instead.

**Workouts attach by event number, never by arena name.** The heat sheet and
the organisers' site disagree on two spellings:

| Event | Heat sheet | Organisers' site |
|---|---|---|
| 1 | Backout Barbell Arena | Bl**a**ckout Barbell Arena |
| 3 | LRX **Beach** Arena | LRX Arena |

The board shows the heat sheet's spelling, per the data-fidelity rule below.
`build-data.py` cross-checks that both sources agree on which arena each
event number refers to, and refuses to build if they ever diverge.

Division names are written inconsistently across events — `Teen (16-17)` in
one, `Teen 16-17` in another, and several folded into a single
`Intermediate/ Masters 40+/ Teens/ Scaled` block. The picker offers the
divisions from whichever event spells out the most, and matching falls back
from an exact token match to an alphabetic-prefix match so every division
resolves on every event.

## Results

Not integrated, and not currently possible. The Competition Corner
leaderboard is an Angular app that fetches its data at runtime, and this
board is a static page on GitHub Pages — a browser fetch to their API from
another origin would be blocked by CORS even if the endpoint were public.
The footer links out to the live leaderboard instead.

## Data fidelity

**The spreadsheet is reproduced verbatim. No corrections, no warnings.**

OxFit Average Bros are Lane 1 in three events and Lane 2 for Event 3
(LRX Beach, 1:17 PM, Heat 16), which looks like a typo — it is rendered as
Lane 2, because that is what officials will be working from on the day. A
board that silently disagrees with the source of truth is worse than one
that faithfully reproduces an oddity.

Savannah Branch and Whitney Dunn have no assigned heats and are shown in a
"not yet scheduled" strip rather than dropped.

## Updating the schedule

Replace `data/heat-sheet.csv`, re-run `python3 build-data.py`, re-run the
tests, commit. If heat durations change, edit `heatMinutes` in
`build-data.py`.
