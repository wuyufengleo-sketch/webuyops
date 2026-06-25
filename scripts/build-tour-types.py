#!/usr/bin/env python3
"""Extract a deduplicated TourType -> itinerary catalog from the WeBuy pricing
Google Sheet (3 tabs: CHINA / ASIA / TURKIYE & EUROPE).

Downstream use: each TourType's itinerary (and, for Europe/Turkiye, the explicit
In-Out airport pair) is parsed to derive the open-jaw departure / return cities
used to query flights (origin is always CGK Jakarta; see scripts/recon-gflights*).

Run:  python3 scripts/build-tour-types.py
Emits: docs/tour-types.json  and  docs/tour-types.md
"""
import csv, re, io, json, os, sys, urllib.request

SHEET_ID = "13hziRYTYWULZXjKEprOhLbPqPokc15rR"
TABS = [
    ("CHINA",          "1856560648"),
    ("ASIA",           "1927149497"),
    ("TURKIYE_EUROPE", "1992756456"),
]
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOCAL = "/tmp"  # use cached /tmp/sheet_<gid>.csv if present, else download


def clean(s):
    return re.sub(r"\s+", " ", (s or "").strip())


def base_code(code):
    """Normalize a dated tour code to its stable TourType.

    Codes embed a departure month prefix and a departure day (+/year) suffix
    around the real code, which may itself end in a '<n>D' days token.
      02WBBEUVIE18/26  -> WBBEUVIE       (no days token: strip trailing day)
      08WBWEHL10D16/26 -> WBWEHL10D      (days token: keep through '10D')
      02WBJPCJE7D20    -> WBJPCJE7D      (day suffix, no /year)
      WBKREAJEJU9DLBRN -> WBKREAJEJU9DLBRN (trailing letters: leave intact)
    """
    c = clean(code).replace(" ", "")
    if not c:
        return ""
    c = re.sub(r"^\d+", "", c)        # leading departure-month digits
    c = re.sub(r"/\d+$", "", c)       # trailing /year
    m = re.match(r"^(.*\d+D)\d+$", c)  # '<n>D' days token + trailing departure day
    if m:
        return m.group(1)
    return re.sub(r"\d+$", "", c)     # no days token: strip trailing departure day


def load(gid):
    path = os.path.join(LOCAL, f"sheet_{gid}.csv")
    if os.path.exists(path):
        with open(path, newline="", encoding="utf-8") as f:
            return list(csv.reader(f))
    url = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv&gid={gid}"
    with urllib.request.urlopen(url) as r:
        data = r.read().decode("utf-8")
    return list(csv.reader(io.StringIO(data)))


def pad(r, n):
    return r + [""] * (n - len(r)) if len(r) < n else r


# ---------------------------------------------------------------- CHINA (tab 1)
def parse_china(gid):
    rows = load(gid)
    groups, order = {}, []
    cur = None
    for r in rows[3:]:                      # header at row index 2
        r = pad(r, 21)
        no, code = clean(r[0]), clean(r[1])
        if code.upper() == "CHINA":
            continue
        bc = base_code(code)
        is_num = bool(re.fullmatch(r"\d+", no))
        if cur and bc and bc == groups[cur]["tour_type"]:
            key = cur                        # repeated dated code = date variant
        elif bc:
            key = ("CN", len(order), bc)     # new coded tour (incl. blank-NO ones)
            groups[key] = {"region": "CHINA", "tour_type": bc,
                           "package_name": "", "details_itinerary": ""}
            order.append(key); cur = key
        elif is_num:
            key = ("CN", len(order), "")     # numbered tour with no code in col1
            groups[key] = {"region": "CHINA", "tour_type": "",
                           "package_name": "", "details_itinerary": ""}
            order.append(key); cur = key
        else:
            key = cur                        # plain date row
        if key is None:
            continue
        g = groups[key]
        if not g["package_name"] and clean(r[2]):
            g["package_name"] = clean(r[2])
        if not g["details_itinerary"] and clean(r[19]):
            g["details_itinerary"] = clean(r[19])

    # Some tours are re-listed lower down with extra dates but no code; fold a
    # codeless group into a coded one when the package name is identical
    # (e.g. the second 'WBXJWNT 9D WINTER XINJIANG' block carries no code).
    result = [groups[k] for k in order]
    coded = {clean(g["package_name"]).upper(): g
             for g in result if g["tour_type"] and g["package_name"]}
    final = []
    for g in result:
        if not g["tour_type"] and g["package_name"]:
            twin = coded.get(clean(g["package_name"]).upper())
            if twin:
                if not twin["details_itinerary"] and g["details_itinerary"]:
                    twin["details_itinerary"] = g["details_itinerary"]
                continue
        final.append(g)
    return final


# ----------------------------------------------------------------- ASIA (tab 2)
def parse_asia(gid):
    rows = load(gid)
    groups, order = {}, []
    for r in rows[3:]:                       # header at row index 2
        r = pad(r, 17)
        raw = clean(r[1])
        if not raw or raw.upper() == "ASIA":
            continue
        bc = base_code(raw)
        if not bc:
            continue
        if bc not in groups:
            groups[bc] = {"region": "ASIA", "tour_type": bc,
                          "package_name": "", "details_itinerary": ""}
            order.append(bc)
        g = groups[bc]
        if not g["package_name"] and clean(r[2]):
            g["package_name"] = clean(r[2])
        if not g["details_itinerary"] and clean(r[16]):
            g["details_itinerary"] = clean(r[16])
    return [groups[k] for k in order]


# -------------------------------------------------------- TURKIYE/EUROPE (tab 3)
def parse_euro(gid):
    rows = load(gid)
    raw = []
    for r in rows[5:]:                       # header at row index 2, data from 5
        r = pad(r, 8)
        product, in_out, code, days = clean(r[4]), clean(r[5]), clean(r[2]), clean(r[3])
        if not product:
            continue
        raw.append({"tour_type": base_code(code), "product": product,
                    "in_out": in_out, "days": days})

    # for codeless rows, adopt the code of a coded sibling sharing (product,in_out)
    # only when that sibling code is unique (avoid merging distinct WEU/CEU SKUs)
    by_pi = {}
    for x in raw:
        if x["tour_type"]:
            by_pi.setdefault((x["product"], x["in_out"]), set()).add(x["tour_type"])
    for x in raw:
        if not x["tour_type"]:
            codes = by_pi.get((x["product"], x["in_out"]))
            if codes and len(codes) == 1:
                x["tour_type"] = next(iter(codes))

    out, seen = [], set()
    for x in raw:
        key = (x["tour_type"], x["product"], x["in_out"])
        if key in seen:
            continue
        seen.add(key)
        out.append({"region": "TURKIYE_EUROPE", "tour_type": x["tour_type"],
                    "package_name": x["product"], "details_itinerary": x["product"],
                    "in_out": x["in_out"], "days": x["days"]})
    return out


# ─────────────────────────────────────────────────────────────────────────────
# Flight endpoints per TourType — open-jaw origin (arrival) / return (departure).
# Customer home is always CGK (Jakarta): outbound CGK→arr, return dep→CGK.
# Europe/Turkiye: taken straight from the sheet's In-Out column (authoritative).
# China/Asia: derived from the itinerary, then web-verified (see EE notes).
# ─────────────────────────────────────────────────────────────────────────────
HOME = "CGK"
# Sheet In-Out codes that are informal/wrong → real IATA (web-verified).
IO_FIX = {"MUN": "MUC"}  # sheet wrote "MUN" (= Maturin, Venezuela) for Munich → MUC

# IATA → display city (covers every airport used below + Europe In-Out codes).
AIRPORT_CITY = {
    "CGK": "Jakarta", "PVG": "Shanghai", "PEK": "Beijing", "CKG": "Chongqing",
    "CTU": "Chengdu", "CSX": "Changsha", "DYG": "Zhangjiajie", "JZH": "Jiuzhaigou",
    "KMG": "Kunming", "DLU": "Dali", "LJG": "Lijiang", "DIG": "Shangri-La",
    "HRB": "Harbin", "OHE": "Mohe", "KHN": "Nanchang", "URC": "Urumqi",
    "HKG": "Hong Kong", "MFM": "Macau", "TPE": "Taipei", "TXN": "Huangshan",
    "HGH": "Hangzhou", "NKG": "Nanjing", "SZX": "Shenzhen", "ZUH": "Zhuhai",
    "CAN": "Guangzhou", "ALA": "Almaty", "NRT": "Tokyo", "CTS": "Sapporo",
    "KIX": "Osaka", "NGO": "Nagoya", "HAN": "Hanoi", "DAD": "Da Nang",
    "SIN": "Singapore", "KUL": "Kuala Lumpur", "BKK": "Bangkok", "IST": "Istanbul",
    "ICN": "Seoul", "PUS": "Busan", "CJU": "Jeju", "CEB": "Cebu",
    "CDG": "Paris", "MXP": "Milan", "ROM": "Rome", "FCO": "Rome", "FRA": "Frankfurt",
    "VIE": "Vienna", "MUC": "Munich", "ZRH": "Zurich", "MAN": "Manchester",
    "LHR": "London", "BCN": "Barcelona", "MAD": "Madrid",
}

# key → (arr_iata, dep_iata, confidence, review). key = tour_type, or a slug for
# codeless China tours. Values are web-verified; "review" flags a soft call.
ENTRY_EXIT = {
    "WBFUNSHA": ("PVG", "PVG", "high", False),
    "WBBJSH": ("PEK", "PVG", "high", False),
    "WBBJDSNY": ("PEK", "PVG", "high", False),
    "WBCQZHJ": ("CKG", "CSX", "high", False),
    "WBCQ5D": ("CKG", "CKG", "high", False),
    "WBCHJZ": ("CTU", "CTU", "high", False),
    "WBHKGM": ("HKG", "HKG", "high", False),
    "WBJGXI": ("KHN", "KHN", "high", False),
    "WBYNKNMG": ("KMG", "KMG", "high", False),   # Lijiang domestic-only → loop back to KMG (Yunnan's only intl gw)
    "WBKNMGSHA": ("KMG", "KMG", "high", False),  # Shangri-La domestic-only → loop back to KMG
    "WBTWN": ("TPE", "TPE", "high", False),
    "WBMOHE": ("HRB", "HRB", "high", False),
    "WBHRBN": ("HRB", "HRB", "high", False),
    "WB2THMPARK": ("PEK", "PVG", "high", False),
    "WBCQCDJH": ("CTU", "CKG", "high", False),
    "WBXNJG14D": ("URC", "URC", "high", False),
    "JIANGNAN": ("TXN", "NKG", "high", False),
    "WBHWHS": ("", "", "low", True),
    "WBXJWNT": ("URC", "URC", "high", False),
    "XINJIANG_ALMATY": ("URC", "ALA", "high", False),
    "XINJIANG_JOURNEY": ("URC", "URC", "high", False),
    "HK_SZ_ZH_GZ": ("HKG", "CAN", "high", False),
    "WBJPNTKYKM": ("NRT", "NRT", "high", False),
    "WBJPNSKG": ("NGO", "NGO", "high", False),
    "WBJPCJE7D": ("NGO", "NGO", "high", False),
    "WBJPHSIF6D": ("CTS", "CTS", "high", False),
    "WBJPJGUD8D": ("NRT", "KIX", "high", False),
    "WBBEUVIE": ("HAN", "HAN", "high", False),
    "WBVIEDAD": ("HAN", "DAD", "high", False),
    "WBJS3NEG7D": ("SIN", "BKK", "high", False),
    "WBBKKPTY5D": ("BKK", "BKK", "high", False),
    "WBCDTR10D": ("IST", "IST", "high", False),
    "WBKREAC6D": ("ICN", "ICN", "high", False),
    "WBKREALBRN": ("ICN", "ICN", "high", False),
    "WBKREALBRNDR": ("ICN", "ICN", "medium", False),
    "WBKREALBRNCEBU": ("ICN", "ICN", "high", False),
    "WBKREAJEJU9DLBRN": ("ICN", "ICN", "high", False),
    "WBKREASCL": ("ICN", "ICN", "high", False),
    "WBKREAC6DMH": ("ICN", "ICN", "high", False),
    "WBKREFL": ("ICN", "ICN", "medium", False),
    "WBBSNSL": ("PUS", "ICN", "high", False),
    "WBKREAEVLBRN": ("ICN", "ICN", "high", False),
    "WBKREAEV": ("ICN", "ICN", "high", False),
    "WBEXSOL": ("PUS", "ICN", "high", False),
    "WBAZKR": ("ICN", "ICN", "high", False),
}


def airport_key(rec):
    """Stable ENTRY_EXIT key: the tour code, or a slug for codeless China tours."""
    if rec["tour_type"]:
        return rec["tour_type"]
    it = (rec.get("details_itinerary") or "").upper()
    if "JIANGNAN" in it:           return "JIANGNAN"
    if "ALMATY" in it:             return "XINJIANG_ALMATY"
    if "XINJIANG JOURNEY" in it:   return "XINJIANG_JOURNEY"
    if "EXPLORE HONG KONG" in it:  return "HK_SZ_ZH_GZ"
    return None


def _trip_days(rec):
    """Number of days for the tour (return = departure + days-1). Europe carries
    it in the sheet; elsewhere parse the 'nD' token from the itinerary/package."""
    d = rec.get("days")
    if d:
        m = re.search(r"\d+", str(d))
        if m:
            return int(m.group())
    for s in (rec.get("details_itinerary"), rec.get("package_name")):
        m = re.search(r"(\d+)\s*D", (s or "").upper())
        if m:
            return int(m.group(1))
    return None


def enrich_airports(catalog):
    for rec in catalog:
        rec["days"] = _trip_days(rec)
        if rec["region"] == "TURKIYE_EUROPE":
            io = (rec.get("in_out") or "").strip()
            arr, dep = (io.split("-", 1) + [""])[:2] if "-" in io else ("", "")
            arr, dep = IO_FIX.get(arr.strip(), arr.strip()), IO_FIX.get(dep.strip(), dep.strip())
            conf, review = ("high" if arr and dep else "low"), not (arr and dep)
        else:
            arr, dep, conf, review = ENTRY_EXIT.get(airport_key(rec), ("", "", "low", True))
        open_jaw = bool(arr and dep and arr != dep)
        rec["arr_iata"], rec["dep_iata"] = arr, dep
        rec["arr_city"] = AIRPORT_CITY.get(arr, arr)
        rec["dep_city"] = AIRPORT_CITY.get(dep, dep)
        rec["open_jaw"] = open_jaw
        rec["airport_confidence"] = conf
        rec["airport_review"] = review
        # outbound CGK→arr, return dep→CGK (round-trip when arr==dep)
        rec["flight_route"] = (f"{HOME}→{arr} · {dep}→{HOME}" if arr and dep else "")
    return catalog


def main():
    catalog = []
    catalog += parse_china(TABS[0][1])
    catalog += parse_asia(TABS[1][1])
    catalog += parse_euro(TABS[2][1])
    enrich_airports(catalog)

    os.makedirs(os.path.join(HERE, "docs"), exist_ok=True)
    with open(os.path.join(HERE, "docs", "tour-types.json"), "w", encoding="utf-8") as f:
        json.dump({"source_sheet": SHEET_ID, "tabs": dict(TABS),
                   "count": len(catalog), "tour_types": catalog},
                  f, ensure_ascii=False, indent=2)

    lines = ["# Tour Types — Itinerary Catalog", "",
             f"Source: Google Sheet `{SHEET_ID}` (tabs: CHINA / ASIA / TURKIYE & EUROPE). "
             "Deduplicated by TourType. Regenerate with `python3 scripts/build-tour-types.py`.",
             "",
             "`In-Out` (Europe/Turkiye tab) is the explicit entry→exit airport pair used "
             "as the open-jaw flight origin/return. For CHINA/ASIA it is derived from the itinerary "
             "and web-verified. **Origin→Return** = the international flight legs from home base "
             f"`{HOME}` (Jakarta): outbound `{HOME}→origin`, return `return→{HOME}`. ⚠ marks a soft "
             "call worth a human check.",
             ""]

    def route_cell(c):
        a, d = c.get("arr_iata") or "", c.get("dep_iata") or ""
        if not (a and d):
            return "⚠ —"
        tag = " ⚠" if c.get("airport_review") else ""
        return (f"{a} (round){tag}" if not c.get("open_jaw") else f"{a} → {d} (open-jaw){tag}")

    for region, _ in TABS:
        items = [c for c in catalog if c["region"] == region]
        lines.append(f"## {region}  ({len(items)})")
        lines.append("")
        if region == "TURKIYE_EUROPE":
            lines.append("| TourType | In-Out | Origin→Return | Days | Itinerary |")
            lines.append("|---|---|---|---|---|")
            for c in items:
                lines.append(f"| {c['tour_type'] or '—'} | {c.get('in_out') or '—'} "
                             f"| {route_cell(c)} | {c.get('days') or '—'} | {c['details_itinerary']} |")
        else:
            lines.append("| TourType | Origin→Return | Itinerary | Package Name |")
            lines.append("|---|---|---|---|")
            for c in items:
                lines.append(f"| {c['tour_type'] or '—'} | {route_cell(c)} "
                             f"| {c['details_itinerary'] or '—'} | {c['package_name'] or '—'} |")
        lines.append("")
    with open(os.path.join(HERE, "docs", "tour-types.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"Wrote {len(catalog)} tour types -> docs/tour-types.json, docs/tour-types.md")
    for region, _ in TABS:
        print(f"  {region}: {sum(1 for c in catalog if c['region']==region)}")


if __name__ == "__main__":
    main()
