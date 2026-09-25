#!/usr/bin/env python3
"""Transcribe data/heat-sheet.csv into data/schedule.json.

The CSV has one row per competitor with four (time, "Heat N Lane M") pairs,
one per arena. A blank row then a TEAM header splits individuals from teams.
"""
import csv, json, re, sys, pathlib

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "data" / "heat-sheet.csv"
FRI = ROOT / "data" / "friday-heat-sheet.csv"
OUT = ROOT / "data" / "schedule.json"

ARENAS = [
    "Backout Barbell Arena",
    "Mayhem Athlete Arena",
    "LRX Beach Arena",
    "PR Apparel Arena",
]
# Friday is a single event on the beach itself, not one of the four arenas.
FRIDAY_ARENA = "Elite Beach Event"

HEAT_LANE = re.compile(r"Heat\s+(\d+)\s+Lane\s+(\d+)", re.I)


def to_seconds(t):
    """'9:30 AM' -> seconds since midnight."""
    m = re.match(r"^\s*(\d{1,2}):(\d{2})\s*([AP]M)\s*$", t, re.I)
    if not m:
        raise ValueError(f"unparseable time: {t!r}")
    h, mi, mer = int(m.group(1)), int(m.group(2)), m.group(3).upper()
    if h == 12:
        h = 0
    if mer[0] == "P":
        h += 12
    return h * 3600 + mi * 60


def parse():
    rows = list(csv.reader(SRC.open()))
    individuals, teams, tbd_ind, tbd_team = [], [], [], []
    bucket, tbd = individuals, tbd_ind

    for row in rows:
        if not row or not row[0].strip():
            continue
        name = row[0].strip()
        if name.upper() == "ATHLETE":
            continue
        if name.upper() == "TEAM":
            bucket, tbd = teams, tbd_team
            continue
        if (row[1] or "").strip().upper() == "TBD":
            tbd.append(name)
            continue

        for i, arena in enumerate(ARENAS):
            time_cell = (row[1 + i * 2] or "").strip()
            hl_cell = (row[2 + i * 2] or "").strip()
            if not time_cell or not hl_cell:
                raise ValueError(f"{name}: missing event {i+1}")
            hl = HEAT_LANE.search(hl_cell)
            if not hl:
                raise ValueError(f"{name}: unparseable {hl_cell!r}")
            bucket.append({
                "name": name,
                "arena": arena,
                "eventNo": i + 1,
                "time": time_cell,
                "startSec": to_seconds(time_cell),
                "heat": int(hl.group(1)),
                "lane": int(hl.group(2)),
            })
    return individuals, teams, tbd_ind, tbd_team


def parse_friday():
    """Friday runs one event, so its sheet is a single time/heat/lane column."""
    out = []
    if not FRI.exists():
        return out
    for row in csv.reader(FRI.open()):
        if not row or not row[0].strip() or row[0].strip().upper() == "ATHLETE":
            continue
        name, time_cell, hl_cell = (x.strip() for x in row[:3])
        hl = HEAT_LANE.search(hl_cell)
        if not hl:
            raise ValueError(f"{name}: unparseable {hl_cell!r}")
        out.append({
            "name": name,
            "arena": FRIDAY_ARENA,
            "eventNo": 1,
            "time": time_cell,
            "startSec": to_seconds(time_cell),
            "heat": int(hl.group(1)),
            "lane": int(hl.group(2)),
        })
    out.sort(key=lambda e: (e["startSec"], e["lane"]))
    return out


def main():
    ind, team, tbd_i, tbd_t = parse()
    fri = parse_friday()
    for b in (ind, team):
        b.sort(key=lambda e: (e["startSec"], e["name"]))

    data = {
        "event": "Beach Brawl '26",
        "venue": "Pensacola Beach, FL",
        "timeZone": "America/Chicago",
        "arenas": ARENAS + [FRIDAY_ARENA],
        "days": [
            # The Elite Beach Event has no published time cap; 45 minutes is an
            # estimate for a 500m swim, two 800m runs, two sled pulls and a
            # 1000m ski, and only decides when a heat stops reading as live.
            {"id": "friday", "label": "Friday", "date": "2026-09-25",
             "division": "Elite Beach Event", "heatMinutes": 45, "wodKey": "elite",
             "entries": fri, "tbd": []},
            {"id": "saturday", "label": "Saturday", "date": "2026-09-26",
             "division": "Individuals", "heatMinutes": 15, "wodKey": "individual",
             "entries": ind, "tbd": tbd_i},
            {"id": "sunday", "label": "Sunday", "date": "2026-09-27",
             "division": "Teams", "heatMinutes": 17, "wodKey": "team",
             "entries": team, "tbd": tbd_t},
        ],
    }

    # --- verification (before anything is written) -----------------------
    errs = []
    if not ind:
        errs.append("no individual entries parsed")
    if not team:
        errs.append("no team entries parsed")
    if not fri:
        errs.append("no Friday entries parsed")

    for day in data["days"]:
        if not day["entries"]:
            errs.append(f"{day['id']}: no entries")
            continue
        events = {e["eventNo"] for e in day["entries"]}
        by_person = {}
        for e in day["entries"]:
            by_person.setdefault(e["name"], []).append(e)
        for name, es in by_person.items():
            if len(es) != len(events):
                errs.append(f"{name}: {len(es)} entries, expected {len(events)}")
            if len({e["arena"] for e in es}) != len(es):
                errs.append(f"{name}: duplicate arena")
        # no one in two places at once
        seen = {}
        for e in day["entries"]:
            k = (e["name"], e["startSec"])
            if k in seen:
                errs.append(f"{e['name']} double-booked at {e['time']}")
            seen[k] = e
        # heat number must map to exactly one start time across the day
        heat_times = {}
        for e in day["entries"]:
            prev = heat_times.setdefault(e["heat"], e["startSec"])
            if prev != e["startSec"]:
                errs.append(f"{day['id']} heat {e['heat']}: two start times")
        # no two competitors in the same arena+heat+lane
        slots = {}
        for e in day["entries"]:
            k = (e["arena"], e["heat"], e["lane"])
            if k in slots:
                errs.append(f"{day['id']} clash {k}: {slots[k]} & {e['name']}")
            slots[k] = e["name"]
        # Heat numbers must run in the same order as the clock. This is the
        # check that catches AM/PM parsing errors, which are otherwise
        # invisible because they corrupt every afternoon time identically.
        order = sorted(heat_times.items())
        for (h1, t1), (h2, t2) in zip(order, order[1:]):
            if t2 <= t1:
                errs.append(
                    f"{day['id']} heat {h2} starts at or before heat {h1} "
                    f"({t2//3600:02d}:{t2%3600//60:02d} vs "
                    f"{t1//3600:02d}:{t1%3600//60:02d})")
        # Every heat should land inside a plausible competition window.
        for e in day["entries"]:
            if not (6 * 3600 <= e["startSec"] <= 20 * 3600):
                errs.append(f"{e['name']} {e['time']} -> implausible {e['startSec']}s")

    for day in data["days"]:
        day["heatCount"] = len({e["heat"] for e in day["entries"]})
        day["competitors"] = len({e["name"] for e in day["entries"]})

    print(f"friday:      {len(fri)} entries, {len(fri)} athletes")
    print(f"individuals: {len(ind)} entries, {len(ind)//4} athletes, tbd={tbd_i}")
    print(f"teams:       {len(team)} entries, {len(team)//4} teams, tbd={tbd_t}")
    for day in data["days"]:
        if not day["entries"]:
            continue
        hs = sorted({(e["heat"], e["time"]) for e in day["entries"]})
        print(f"{day['id']}: {len(hs)} distinct heats, "
              f"{hs[0][1]} -> {hs[-1][1]}")
    if errs:
        print("\nVERIFICATION FAILED \u2014 nothing written:", file=sys.stderr)
        for e in errs:
            print("  -", e, file=sys.stderr)
        sys.exit(1)
    print("\nverification OK")

    OUT.write_text(json.dumps(data, indent=2) + "\n")

    # --- workouts, keyed by event number ---------------------------------
    # The heat sheet and the organisers' site spell two arenas differently
    # ("Backout"/"Blackout", "LRX Beach"/"LRX"), so workouts are attached by
    # event number. This check catches the day either source reorders them.
    WOD_SRC = ROOT / "data" / "workouts.json"
    wods = json.loads(WOD_SRC.read_text()) if WOD_SRC.exists() else {}
    if wods:
        keyword = {1: "barbell", 2: "mayhem", 3: "lrx", 4: "apparel"}
        for day in data["days"]:
            if day["wodKey"] == "elite":
                continue
            for e in day["entries"]:
                n = e["eventNo"]
                site = wods.get(day["wodKey"], {}).get(str(n), {}).get("arena", "")
                if keyword[n] not in e["arena"].lower():
                    errs.append(f"sheet event {n} arena {e['arena']!r} "
                                f"lacks {keyword[n]!r}")
                if site and keyword[n] not in site.lower():
                    errs.append(f"workout event {n} arena {site!r} "
                                f"lacks {keyword[n]!r}")
        if errs:
            print("\nARENA MAPPING FAILED \u2014 nothing written:", file=sys.stderr)
            for e in sorted(set(errs)):
                print("  -", e, file=sys.stderr)
            sys.exit(1)
        print(f"workouts: {sum(len(v) for v in wods.values())} events attached")
    else:
        print("workouts: none found (run build-workouts.py)")

    # --- inject into the page -------------------------------------------
    tpl = (ROOT / "src" / "index.template.html").read_text()
    for token in ("__SCHEDULE_JSON__", "__WORKOUTS_JSON__"):
        if token not in tpl:
            print(f"template placeholder {token} missing", file=sys.stderr)
            sys.exit(1)
    # Compact, and neutralise any sequence that could close the script tag.
    def blob(o):
        return json.dumps(o, separators=(",", ":")).replace("</", "<\\/")
    page = (tpl.replace("__SCHEDULE_JSON__", blob(data))
               .replace("__WORKOUTS_JSON__", blob(wods)))
    (ROOT / "index.html").write_text(page)
    print(f"wrote index.html ({len(page)/1024:.1f} KB)")


main()
