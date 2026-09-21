#!/usr/bin/env python3
"""Transcribe data/heat-sheet.csv into data/schedule.json.

The CSV has one row per competitor with four (time, "Heat N Lane M") pairs,
one per arena. A blank row then a TEAM header splits individuals from teams.
"""
import csv, json, re, sys, pathlib

ROOT = pathlib.Path(__file__).parent
SRC = ROOT / "data" / "heat-sheet.csv"
OUT = ROOT / "data" / "schedule.json"

ARENAS = [
    "Backout Barbell Arena",
    "Mayhem Athlete Arena",
    "LRX Beach Arena",
    "PR Apparel Arena",
]

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


def main():
    ind, team, tbd_i, tbd_t = parse()
    for b in (ind, team):
        b.sort(key=lambda e: (e["startSec"], e["name"]))

    data = {
        "event": "Beach Brawl '26",
        "venue": "Pensacola Beach, FL",
        "timeZone": "America/Chicago",
        "arenas": ARENAS,
        "days": [
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
    for b, label in ((ind, "individual"), (team, "team")):
        if len(b) % 4:
            errs.append(f"{len(b)} {label} entries is not a whole number of "
                        f"competitors (4 events each)")

    for day in data["days"]:
        by_person = {}
        for e in day["entries"]:
            by_person.setdefault(e["name"], []).append(e)
        for name, es in by_person.items():
            if len(es) != 4:
                errs.append(f"{name}: {len(es)} entries, expected 4")
            if len({e["arena"] for e in es}) != 4:
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
        heats = {e["heat"] for e in day["entries"]}
        day["heatCount"] = len(heats)

    print(f"individuals: {len(ind)} entries, {len(ind)//4} athletes, tbd={tbd_i}")
    print(f"teams:       {len(team)} entries, {len(team)//4} teams, tbd={tbd_t}")
    for day in data["days"]:
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
