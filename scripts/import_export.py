#!/usr/bin/env python3
"""把 Strava 或 Garmin Connect 的匯出檔轉成熱圖資料（site/data/imported.json）。

支援：
  - Strava「下載你的資料」封存檔（.zip 或解壓後的資料夾，會讀 activities.csv 取得運動類型）
  - Garmin Connect「匯出你的資料」封存檔（.zip，內含多層 zip 的 .fit）
  - 任何放了 .gpx / .tcx / .fit（可為 .gz）的資料夾或 zip

用法：
  pip install fitdecode        # 只有 .fit 檔需要
  python3 scripts/import_export.py <匯出檔.zip 或資料夾> [更多路徑…]

選項（環境變數）：
  PRIVACY_TRIM_M   路線頭尾各裁掉幾公尺（預設 200，0 為不裁切）
  OUTPUT           輸出檔（預設 site/data/imported.json，會與既有內容合併）
"""
import csv
import gzip
import hashlib
import io
import json
import math
import os
import re
import sys
import time
import zipfile
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_strava import encode, trim  # noqa: E402

# ---------- 運動類型 ----------
NAME_MAP = {
    "run": "run", "running": "run", "跑步": "run",
    "trailrun": "trail_run", "trailrunning": "trail_run", "越野跑": "trail_run", "山徑越野跑": "trail_run", "越野跑步": "trail_run",
    "walk": "walk", "walking": "walk", "步行": "walk", "健走": "walk",
    "hike": "hike", "hiking": "hike", "健行": "hike", "登山": "hike",
    "ride": "ride", "cycling": "ride", "biking": "ride", "bike": "ride", "騎車": "ride", "騎自行車": "ride", "自行車": "ride",
    "gravelride": "ride", "mountainbikeride": "ride", "ebikeride": "ride", "emountainbikeride": "ride",
    "gravelcycling": "ride", "mountainbiking": "ride", "roadbiking": "ride", "roadcycling": "ride",
    "礫石路騎行": "ride", "登山車騎行": "ride", "電動自行車騎行": "ride",
}
SPORT_KEYS = {"run", "trail_run", "walk", "hike", "ride"}
SKIP_SUBSPORTS = {"indoor_cycling", "virtual_activity", "treadmill", "indoor_running", "spin", "indoor_walking"}


def norm_sport(name):
    if not name:
        return None
    key = re.sub(r"[\s_\-]", "", str(name)).lower()
    return NAME_MAP.get(key)


# ---------- 檔案解析 ----------
def strip_ns(root):
    for el in root.iter():
        if isinstance(el.tag, str) and "}" in el.tag:
            el.tag = el.tag.split("}", 1)[1]
    return root


def parse_time(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.strip().replace("Z", "+00:00"))
    except ValueError:
        return None


def parse_gpx(data):
    root = strip_ns(ET.fromstring(data))
    pts = []
    for p in root.iter("trkpt"):
        pts.append((float(p.get("lat")), float(p.get("lon"))))
    if not pts:
        for p in root.iter("rtept"):
            pts.append((float(p.get("lat")), float(p.get("lon"))))
    t = root.find(".//trkpt/time")
    if t is None:
        t = root.find(".//metadata/time")
    typ = root.find(".//trk/type")
    return {"pts": pts, "start": parse_time(t.text if t is not None else None),
            "sport": norm_sport(typ.text if typ is not None else None)}


def parse_tcx(data):
    root = strip_ns(ET.fromstring(data.strip()))
    pts = []
    for tp in root.iter("Trackpoint"):
        pos = tp.find("Position")
        if pos is not None:
            pts.append((float(pos.findtext("LatitudeDegrees")), float(pos.findtext("LongitudeDegrees"))))
    act = root.find(".//Activity")
    sport = start = None
    if act is not None:
        sport = norm_sport(act.get("Sport"))
        start = parse_time(act.findtext("Id"))
    return {"pts": pts, "start": start, "sport": sport}


def parse_fit(data):
    try:
        import fitdecode
    except ImportError:
        sys.exit("讀取 .fit 檔需要 fitdecode：pip install fitdecode")
    pts, sport, sub, start = [], None, None, None
    semi = 180 / 2 ** 31
    with fitdecode.FitReader(io.BytesIO(data), check_crc=fitdecode.CrcCheck.DISABLED,
                             error_handling=fitdecode.ErrorHandling.IGNORE) as fr:
        for frame in fr:
            if frame.frame_type != fitdecode.FIT_FRAME_DATA:
                continue
            if frame.name == "record":
                if frame.has_field("position_lat") and frame.has_field("position_long"):
                    la, lo = frame.get_value("position_lat"), frame.get_value("position_long")
                    if la is not None and lo is not None:
                        pts.append((la * semi, lo * semi))
                if start is None and frame.has_field("timestamp"):
                    start = frame.get_value("timestamp")
            elif frame.name in ("session", "sport"):
                if frame.has_field("sport") and sport is None:
                    sport = frame.get_value("sport")
                if frame.has_field("sub_sport") and sub is None:
                    sub = frame.get_value("sub_sport")
                if frame.name == "session" and frame.has_field("start_time"):
                    start = frame.get_value("start_time") or start
    sport_s, sub_s = str(sport or "").lower(), str(sub or "").lower()
    if sub_s in SKIP_SUBSPORTS:
        mapped = None
    elif sport_s == "running" and sub_s == "trail":
        mapped = "trail_run"
    else:
        mapped = norm_sport(sport_s)
    if isinstance(start, datetime) and start.tzinfo is None:
        start = start.replace(tzinfo=timezone.utc)
    return {"pts": pts, "start": start if isinstance(start, datetime) else None, "sport": mapped,
            "explicit_skip": sub_s in SKIP_SUBSPORTS}


def parse_file(name, data):
    lname = name.lower()
    if lname.endswith(".gz"):
        data = gzip.decompress(data)
        lname = lname[:-3]
    if lname.endswith(".gpx"):
        return parse_gpx(data)
    if lname.endswith(".tcx"):
        return parse_tcx(data)
    if lname.endswith(".fit"):
        return parse_fit(data)
    return None


# ---------- 走訪輸入 ----------
def walk_input(path):
    """產生 (相對路徑, bytes)；zip 內的 zip 也會展開（Garmin 匯出檔是多層 zip）。"""
    if os.path.isdir(path):
        for d, _, files in os.walk(path):
            for f in files:
                full = os.path.join(d, f)
                rel = os.path.relpath(full, path)
                with open(full, "rb") as fh:
                    if f.lower().endswith(".zip"):
                        yield from walk_zip(zipfile.ZipFile(fh), rel + "/")
                    else:
                        yield rel, fh.read()
    else:
        with zipfile.ZipFile(path) as z:
            yield from walk_zip(z, "")


def walk_zip(z, prefix):
    for info in z.infolist():
        if info.is_dir():
            continue
        data = z.read(info)
        if info.filename.lower().endswith(".zip"):
            yield from walk_zip(zipfile.ZipFile(io.BytesIO(data)), prefix + info.filename + "/")
        else:
            yield prefix + info.filename, data


# ---------- 路線簡化 ----------
def simplify(pts, tol_m=6):
    """Douglas–Peucker（等距投影近似），大幅縮小檔案。"""
    if len(pts) < 3:
        return pts
    lat0 = math.radians(sum(p[0] for p in pts) / len(pts))
    kx, ky = 111320 * math.cos(lat0), 110540
    xy = [(p[1] * kx, p[0] * ky) for p in pts]
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    tol2 = tol_m * tol_m
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy or 1e-12
        best, bi = -1, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            t = max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / L2))
            ex, ey = ax + t * dx - px, ay + t * dy - py
            d2 = ex * ex + ey * ey
            if d2 > best:
                best, bi = d2, i
        if best > tol2:
            keep[bi] = True
            stack += [(a, bi), (bi, b)]
    return [p for p, k in zip(pts, keep) if k]


def path_km(pts):
    from fetch_strava import haversine
    return sum(haversine(pts[i - 1], pts[i]) for i in range(1, len(pts))) / 1000


def main(paths):
    trim_m = float(os.environ.get("PRIVACY_TRIM_M", "200"))
    output = os.environ.get("OUTPUT", "site/data/imported.json")

    existing = {}
    if os.path.exists(output):
        with open(output, encoding="utf-8") as f:
            for a in json.load(f).get("activities", []):
                existing[a.get("t") or a["id"]] = a

    stats = {"ok": 0, "no_gps": 0, "other_sport": 0, "error": 0}
    for path in paths:
        files = dict(walk_input(path))
        # Strava 匯出檔：activities.csv 提供 Filename → 類型、ID
        meta = {}
        for name, data in files.items():
            if os.path.basename(name).lower() == "activities.csv":
                rows = csv.reader(io.StringIO(data.decode("utf-8-sig")))
                header = next(rows)
                col = {h: i for i, h in reversed(list(enumerate(header)))}
                ci = lambda *keys: next((col[k] for k in keys if k in col), None)  # noqa: E731
                i_id, i_type, i_file = ci("Activity ID", "活動 ID"), ci("Activity Type", "活動類型"), ci("Filename", "檔案名稱")
                if i_file is None:
                    continue
                base = name.rsplit("activities.csv", 1)[0]
                for r in rows:
                    if len(r) > i_file and r[i_file]:
                        meta[base + r[i_file]] = {"id": r[i_id] if i_id is not None else None,
                                                  "type": r[i_type] if i_type is not None else None}

        candidates = [n for n in files if re.search(r"\.(gpx|tcx|fit)(\.gz)?$", n, re.I)]
        print(f"{path}: 找到 {len(candidates)} 個活動檔", file=sys.stderr)
        for n, name in enumerate(candidates, 1):
            if n % 200 == 0:
                print(f"  …{n}/{len(candidates)}", file=sys.stderr)
            try:
                res = parse_file(name, files[name])
            except Exception as e:  # 壞檔就略過
                stats["error"] += 1
                print(f"  略過 {name}：{e}", file=sys.stderr)
                continue
            if not res:
                continue
            m = meta.get(name, {})
            csv_type = m.get("type")
            # 檔案放在以運動命名的資料夾（例如 inbox/hike/）時以資料夾為準
            folder_sport = next((p if p in SPORT_KEYS else norm_sport(p) for p in re.split(r"[\\/]", name)[:-1]
                                 if p in SPORT_KEYS or norm_sport(p)), None)
            sport = folder_sport or (norm_sport(csv_type) if csv_type else res["sport"])
            if csv_type and not sport:
                sport = None  # CSV 明確是其他運動（例如游泳）
            if not sport:
                stats["other_sport"] += 1
                continue
            pts = [p for p in res["pts"] if abs(p[0]) > 1e-6 or abs(p[1]) > 1e-6]
            if len(pts) < 2:
                stats["no_gps"] += 1
                continue
            km = path_km(pts)
            pts = trim(simplify(pts), trim_m)
            if len(pts) < 2:
                stats["no_gps"] += 1
                continue
            start = res["start"]
            t = start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M") if start else None
            # 日期用當地時間：以路線經度粗估時區
            local = start.astimezone(timezone.utc).timestamp() + pts[0][1] / 15 * 3600 if start else None
            d = time.strftime("%Y-%m-%d", time.gmtime(local)) if local else ""
            aid = m.get("id") or "x" + hashlib.sha1((t or name).encode()).hexdigest()[:12]
            rec = {"id": aid, "s": sport, "d": d, "km": round(km, 2), "p": encode(pts)}
            if t:
                rec["t"] = t
            existing[t or aid] = rec
            stats["ok"] += 1

    out = sorted(existing.values(), key=lambda a: a.get("t") or a["d"])
    os.makedirs(os.path.dirname(output) or ".", exist_ok=True)
    with open(output, "w", encoding="utf-8") as f:
        json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "activities": out},
                  f, ensure_ascii=False, separators=(",", ":"))
    print(f"完成：匯入 {stats['ok']}，無 GPS {stats['no_gps']}，其他運動 {stats['other_sport']}，"
          f"錯誤 {stats['error']}。共 {len(out)} 筆 → {output}（{os.path.getsize(output) // 1024} KB）", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main(sys.argv[1:])
