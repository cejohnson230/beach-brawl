#!/usr/bin/env python3
"""Scrape the eight Beach Brawl workout pages into data/workouts.json.

Each event has its own WordPress page carrying the format, time cap, a block
of movements per division, and a prose description of the flow. Movement
standards run to thousands of words and are deliberately NOT captured — the
page links out to the official write-up for those.

Run only when the organisers change a workout; the committed JSON is what the
board actually ships.
"""
import html
import json
import pathlib
import re
import sys
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).parent
OUT = ROOT / "data" / "workouts.json"
BASE = "https://pensacolabeachbrawl.com/"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
      "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# (day, event number) -> page slug. Note the organisers' slugs are not
# consistently named; event 3 of each day uses a different prefix.
PAGES = {
    ("individual", 1): "fall-2026-individual-event-1",
    ("individual", 2): "fall-2026-individual-event-2",
    ("individual", 3): "2026-fall-individual-event-3",
    ("individual", 4): "fall-2026-individual-event-4",
    ("team", 1): "fall-2026-team-event-1",
    ("team", 2): "fall-2026-team-event-2",
    ("team", 3): "2026-fall-team-event-3",
    ("team", 4): "fall-2026-team-event-4",
}

DIVISION = re.compile(
    r"^(elite|rx|intermediate|masters|scaled|teen)\b[^.]*$", re.I)
CAP = re.compile(r"(\d{1,2}:\d{2})\s*time\s*cap|time\s*cap\s*(\d{1,2}:\d{2})", re.I)
FLOW = re.compile(r"^3\s*,?\s*2\s*,?\s*1", re.I)
STANDARDS = re.compile(r"^movement\s+standards", re.I)
FORMAT = re.compile(
    r"^(for time|for max weight|\d+\s*rounds?.*|relay style|"
    r"amrap.*|.*for time:?)$", re.I)


def text_lines(raw):
    s = re.sub(r"(?is)<(script|style|noscript|svg)[^>]*>.*?</\1>", " ", raw)
    s = re.sub(r"(?s)<!--.*?-->", " ", s)
    s = re.sub(r"(?i)<(br|/p|/div|/h[1-6]|/li|/tr)[^>]*>", "\n", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = html.unescape(s)
    out = []
    for line in s.split("\n"):
        line = re.sub(r"[ \t\xa0]+", " ", line).strip()
        if line and (not out or out[-1] != line):
            out.append(line)
    return out


def content_block(lines):
    """Trim the site chrome from around the workout body."""
    start = 0
    for i, l in enumerate(lines[:12]):
        if re.search(r"(individual|team|elite).*event", l, re.I):
            start = i
    end = len(lines)
    for i in range(start + 1, len(lines)):
        if lines[i] in ("About", "Register", "WORKOUTS", "Pictures"):
            end = i
            break
    return lines[start + 1:end]


def parse(slug, day, event_no):
    req = urllib.request.Request(BASE + slug + "/", headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        raw = r.read().decode("utf-8", "replace")

    body = content_block(text_lines(raw))

    arena = next((l for l in body[:6] if re.search(r"arena", l, re.I)), "")
    cap = ""
    fmt = []
    notes = []

    # Header runs until the first division heading, the first movement line,
    # or the flow narrative — whichever comes first.
    head_end = len(body)
    for i, l in enumerate(body):
        # A time cap reads like "12:00 Time cap" and would otherwise look
        # like a movement line ("digits, then non-digits"), cutting the
        # header short and losing the cap entirely.
        # A time cap ("12:00 Time cap") and some format lines ("3 Rounds for
        # time") both start with digits and would otherwise read as movement
        # lines, cutting the header short and losing what follows them.
        if CAP.search(l) or FORMAT.match(l):
            continue
        if DIVISION.match(l) or FLOW.match(l) or re.match(r"^\d+\s*\D", l) \
                or re.match(r"^partner\b|^\d+:\d{2}\s+to\s+\d+:\d{2}", l, re.I):
            head_end = i
            break

    for l in body[:head_end]:
        # Drop the page's own headings ("Team Event 1", "Event 1").
        if l == arena or re.search(r"(individual|team)\s+event", l, re.I) \
                or re.match(r"^event\s+\d+$", l, re.I):
            continue
        m = CAP.search(l)
        if m:
            cap = m.group(1) or m.group(2)
            if re.sub(r"\W", "", CAP.sub("", l)):
                fmt.append(CAP.sub("", l).strip(" -–—"))
            continue
        if l.startswith("*"):
            notes.append(l.lstrip("* ").strip())
        elif FORMAT.match(l) or len(l) < 60:
            fmt.append(l)

    # Divisions, stopping at the flow narrative.
    divisions = []
    current = None
    for l in body[head_end:]:
        if FLOW.match(l) or STANDARDS.match(l):
            break
        if l.startswith("*"):
            note = l.lstrip("* ").strip()
            if note not in notes:
                notes.append(note)
            continue
        if DIVISION.match(l) and not re.match(r"^\d", l):
            current = {"name": l.rstrip(":").strip(), "lines": []}
            divisions.append(current)
        elif current is not None:
            current["lines"].append(l)
        else:
            # No division heading yet (e.g. the 1RM snatch events) — one
            # block that applies to everyone.
            current = {"name": "All divisions", "lines": [l]}
            divisions.append(current)

    flow = []
    grabbing = False
    for l in body:
        if STANDARDS.match(l):
            break
        if FLOW.match(l):
            grabbing = True
        if grabbing:
            flow.append(l)

    divisions = [d for d in divisions if d["lines"]]
    return {
        "day": day,
        "eventNo": event_no,
        "arena": arena,
        "format": " · ".join(dict.fromkeys(f for f in fmt if f)),
        "cap": cap,
        "notes": notes,
        "divisions": divisions,
        "flow": flow,
        "url": BASE + slug + "/",
    }


def main():
    workouts, errs = {"individual": {}, "team": {}}, []
    for (day, no), slug in sorted(PAGES.items()):
        try:
            w = parse(slug, day, no)
        except urllib.error.URLError as e:
            errs.append(f"{day} event {no}: fetch failed ({e})")
            continue
        if not w["divisions"]:
            errs.append(f"{day} event {no}: no movements parsed")
        if not w["arena"]:
            errs.append(f"{day} event {no}: no arena found")
        workouts[day][str(no)] = w
        print(f"{day:11s} event {no}  {w['arena']:24s} "
              f"{w['cap'] or '--:--':>6s}  "
              f"{len(w['divisions'])} divisions")

    if errs:
        print("\nSCRAPE FAILED — nothing written:", file=sys.stderr)
        for e in errs:
            print("  -", e, file=sys.stderr)
        sys.exit(1)

    OUT.write_text(json.dumps(workouts, indent=2) + "\n")
    print(f"\nwrote {OUT.relative_to(ROOT)} "
          f"({OUT.stat().st_size / 1024:.1f} KB)")


main()
