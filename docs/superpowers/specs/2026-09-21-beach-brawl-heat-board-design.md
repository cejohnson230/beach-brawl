# Beach Brawl '26 — Live Heat Board

**Date:** 2026-09-21
**Status:** Design approved, ready for implementation plan

## Purpose

A single web page that answers one question for the OxFit crew during Beach
Brawl '26: **who from our crew is competing right now, and who's next?**

The competition runs two days at four arenas. The official heat sheet is a
spreadsheet — accurate but unreadable on a phone in the sun. This replaces it
with a time-driven view that surfaces only what matters at the current moment.

## Audience and scope

Built for the OxFit crew, not the whole event. The source sheet covers 9
scheduled individuals (plus 2 TBD) and 5 teams — a slice of a field that runs
to 32 heats of 8 lanes. Empty arenas are the normal case and the design must
not read as broken when nobody from the crew is on.

Shared as a live URL, texted to the group chat, opened on phones at the venue.

## Event structure

Two separate competition days:

| Day | Date | Competitors | Heat spacing |
|---|---|---|---|
| Saturday | 2026-09-26 | 9 individuals (+2 TBD) | 15 min |
| Sunday | 2026-09-27 | 5 teams | 17 min |

Four arenas run in parallel: Backout Barbell, Mayhem Athlete, LRX Beach, PR
Apparel. Every competitor does all four, one per rotation block.

**Heat number is a global time slot, not per-arena.** On Saturday, Heat 7 is
9:30 AM in every arena simultaneously. Saturday runs 32 heats in 4 blocks of 8;
Sunday runs 28 heats in 4 blocks of 7. Breaks fall between blocks, which is why
consecutive heat numbers are not always evenly spaced across a block boundary.

Saturday and Sunday reuse the same heat numbers. They are different days, so
this is not a conflict — but day context must always be unambiguous in the UI.

### Heat duration

Every schedule entry in the source data carries its own explicit start time, so
start times are never computed from heat numbers. Heat spacing is used for
exactly one purpose: deciding when a heat **ends**, and therefore when a
competitor stops being "on now".

- Saturday: a heat is live for 15 minutes from its start time.
- Sunday: a heat is live for 17 minutes from its start time.

This keeps the time logic robust — a wrong duration shifts a card out of the
"NOW" zone a few minutes early or late, it can never show the wrong arena or
lane.

## Data fidelity

**The spreadsheet is displayed verbatim. No corrections, no inferred values, no
on-screen warnings.**

This is a deliberate decision. OxFit Average Bros are Lane 1 in three events and
Lane 2 for Event 3 (LRX Beach, 1:17 PM, Heat 16), which looks like a typo. It is
rendered as Lane 2, because the spreadsheet is what officials will be working
from on the day. A site that silently disagrees with the source of truth is
worse than one that faithfully reproduces an oddity.

Savannah Branch and Whitney Dunn have no assigned heats. They are shown in a
"TBD — not yet scheduled" strip so they are visibly accounted for rather than
silently missing.

## Architecture

A single self-contained HTML file. No framework, no build step, no backend.

The full dataset is ~56 schedule entries (~4KB) and never changes during the
event. Embedding it as a JSON literal in the page removes every failure mode
that matters at a beach venue: no fetch, no CORS, no second round trip, no
spinner on bad cell signal. The page either loads or it doesn't.

Three logical parts inside the one file:

1. **Data** — a frozen JSON literal transcribed from the CSV.
2. **Time engine** — pure functions mapping (dataset, instant) to view state.
3. **Render layer** — draws view state to the DOM, re-running on a 1s tick.

The time engine holds every decision worth testing and touches no DOM, so it
can be exercised directly without a browser.

### Data model

```js
{
  days: [
    {
      id: "saturday",
      label: "Saturday",
      date: "2026-09-26",
      division: "Individuals",
      heatMinutes: 15,
      entries: [
        { name: "Ant Oxley", arena: "Backout Barbell Arena",
          eventNo: 1, time: "09:30", heat: 7, lane: 5 },
        ...
      ],
      tbd: ["Savannah Branch", "Whitney Dunn"]
    },
    { id: "sunday", ... heatMinutes: 17, ... }
  ]
}
```

One entry per competitor per arena — 36 on Saturday, 20 on Sunday.

### Time engine

Given the dataset and an instant, classify every entry on the active day:

- `done` — start + heatMinutes is in the past
- `live` — start <= now < start + heatMinutes
- `upcoming` — start is in the future

Derived from that: the set of live entries, the next start time and everyone
sharing it, seconds remaining on the live block, and seconds until the next
start. All pure, all directly testable.

## Interface

One page, mobile-first, portrait, one-handed. Ticks every second.

```
┌──────────────────────────────────┐
│ BEACH BRAWL '26                  │  sticky
│ SATURDAY · INDIVIDUALS   2:31 PM │
├──────────────────────────────────┤
│  ●  ON NOW          ends in 14m  │
│  ┌────────────────────────────┐  │
│  │ ANT OXLEY                  │  │
│  │ LRX BEACH ARENA            │  │
│  │ Heat 23    Lane 5          │  │
│  ├────────────────────────────┤  │
│  │ KEITH CALDWELL             │  │
│  │ BACKOUT BARBELL            │  │
│  │ Heat 23    Lane 6          │  │
│  └────────────────────────────┘  │
│                                  │
│  ○  UP NEXT            in 14:07  │
│     2:45  Adam Morgan            │
│           LRX Beach · H24 · L4   │
│                                  │
│  ─── LATER TODAY ───             │
│     3:45  Debbie Allen           │
│     3:45  Kelsey Graham          │
│     ...                          │
│                                  │
│  ▸ Earlier today (11 done)       │  collapsed
└──────────────────────────────────┘
```

Three zones in priority order: **who is on right now**, **who is next with a
live countdown**, **everything still to come**. Completed heats collapse behind
a disclosure but stay reachable.

Arena name is given equal weight to competitor name — knowing someone is up is
useless without knowing which end of the beach to walk to.

### Day selection

The active day is chosen from the real date: Saturday shows individuals, Sunday
shows teams. A toggle in the header switches manually, so Sunday's teams can
check their times on Saturday.

Outside the event weekend the page opens on a countdown to the first heat plus
the full schedule, so the link is useful the moment it is shared rather than
showing an empty board for five days.

### States

| Condition | Display |
|---|---|
| Before the event | Countdown to Saturday's first heat + full preview |
| Before day's first heat | Countdown to first heat, full day listed |
| Crew member competing | NOW zone populated, block countdown running |
| Gap between crew heats | NOW zone shows the gap and time to next start |
| After day's last heat | Day-complete wrap, link to the other day |

The gap state matters — Saturday has real dead stretches (nothing between
10:50 AM and 11:35 AM). It reports "next up in 42 min", never an empty screen.

### Time zone

The viewer's device clock is used directly, on the assumption that everyone
looking at this is at the venue. All schedule times are treated as venue-local
wall-clock times.

## Visual direction

Bright, retro, fun — a beach poster, not a spreadsheet. Must stay legible in
direct sun at arm's length.

Built on OxFit's own brand tokens, lifted from ox.fit:

| Role | Value | Source |
|---|---|---|
| Highlight | `#25ABF3` | OxFit `--azure` |
| Highlight bright | `#33A7FF` | OxFit `--azure-bright` |
| Highlight deep | `#1488D4` | OxFit `--azure-deep` |
| Ink | `#081359` | OxFit `--navy` |
| Sun accent | `#FFC53D` | OxFit palette |
| Ground | `#FBF4E6` | new — warm sand, inverted from OxFit's dark site |
| Ground raised | `#FFFDF7` | new — card surfaces |

OxFit's site is dark; this is deliberately inverted to a sun-bleached cream
ground with navy ink, keeping azure as the single highlight colour. Sun yellow
is a secondary pop used sparingly.

Type is OxFit's own pairing: **Oswald** condensed caps for display, **Lato** for
body. Numerals are tabular so countdowns don't jitter.

Retro treatment: heavy rules, chunky uppercase headers, hard offset shadows on
cards, generous scale. Live state is carried by colour *and* an explicit label,
never colour alone.

## Testing

A `?now=2026-09-26T14:31` URL parameter freezes the clock to any instant. Every
state — mid-heat, gap, pre-event, day-complete, Sunday — is reachable and
reviewable now rather than only on the day.

Time engine functions are pure and unit-tested against fixed instants covering:
first heat boundary, last heat boundary, exact start, exact end, inside a gap,
day rollover, and both days' differing heat durations.

Transcription is verified by asserting the embedded JSON round-trips against the
source CSV — 36 Saturday entries and 20 Sunday entries, every field matching.

## Out of scope

- Live results, scores, or leaderboards
- Any athlete outside the OxFit crew
- Editing the schedule in the browser
- Accounts, notifications, or push alerts
- Offline caching / service worker

## Source data

`/Users/catherinejohnson/Downloads/BB 26' HEAT SHEET.csv` — copied into the repo
as the transcription reference.
