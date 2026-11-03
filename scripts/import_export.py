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
  PRIVACY_TRIM_M   路線頭尾各裁掉幾公尺（預設 100，0 為不裁切）
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


def num(s):
    try:
        return float(s) if s not in (None, "") else None
    except ValueError:
        return None


def epoch(s):
    t = parse_time(s)
    if t is None:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return t.timestamp()


def parse_gpx(data):
    root = strip_ns(ET.fromstring(data))
    pts = []
    for tag in ("trkpt", "rtept"):
        for p in root.iter(tag):
            pts.append((float(p.get("lat")), float(p.get("lon")), num(p.findtext("ele")), epoch(p.findtext("time"))))
        if pts:
            break
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
            pts.append((float(pos.findtext("LatitudeDegrees")), float(pos.findtext("LongitudeDegrees")),
                        num(tp.findtext("AltitudeMeters")), epoch(tp.findtext("Time"))))
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
                        ele = None
                        for k in ("enhanced_altitude", "altitude"):
                            if frame.has_field(k) and frame.get_value(k) is not None:
                                ele = float(frame.get_value(k))
                                break
                        ts = frame.get_value("timestamp") if frame.has_field("timestamp") else None
                        if isinstance(ts, datetime):
                            ts = (ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc)).timestamp()
                        else:
                            ts = None
                        pts.append((la * semi, lo * semi, ele, ts))
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
WANTED = re.compile(r"(\.(gpx|tcx|fit)(\.gz)?|activities\.csv)$", re.I)


def walk_input(path):
    """產生 (相對路徑, bytes)；zip 內的 zip 也會展開（Garmin 匯出檔是多層 zip）。
    只讀取活動檔與 activities.csv，略過照片等其他檔案以節省記憶體。"""
    if os.path.isdir(path):
        for d, _, files in os.walk(path):
            for f in files:
                full = os.path.join(d, f)
                rel = os.path.relpath(full, path)
                if f.lower().endswith(".zip"):
                    with zipfile.ZipFile(full) as z:
                        yield from walk_zip(z, rel + "/")
                elif WANTED.search(f):
                    with open(full, "rb") as fh:
                        yield rel, fh.read()
    else:
        with zipfile.ZipFile(path) as z:
            yield from walk_zip(z, "")


def walk_zip(z, prefix):
    for info in z.infolist():
        if info.is_dir():
            continue
        if info.filename.lower().endswith(".zip"):
            with zipfile.ZipFile(io.BytesIO(z.read(info))) as inner:
                yield from walk_zip(inner, prefix + info.filename + "/")
        elif WANTED.search(info.filename):
            yield prefix + info.filename, z.read(info)


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


def encode_ints(vals):
    """一維整數序列，用和 polyline 一樣的差值編碼。"""
    out, prev = [], 0
    for v in vals:
        d = v - prev
        x = ~(d << 1) if d < 0 else d << 1
        while x >= 0x20:
            out.append(chr((0x20 | (x & 0x1F)) + 63))
            x >>= 5
        out.append(chr(x + 63))
        prev = v
    return "".join(out)


def fill(vals):
    """缺值以前後最近的值補上；缺超過一半就放棄。"""
    if sum(v is None for v in vals) > len(vals) / 2:
        return None
    out, last = [], next(v for v in vals if v is not None)
    for v in vals:
        last = v if v is not None else last
        out.append(last)
    return out


def path_km(pts):
    from fetch_strava import haversine
    return sum(haversine(pts[i - 1], pts[i]) for i in range(1, len(pts))) / 1000


def main(paths):
    trim_m = float(os.environ.get("PRIVACY_TRIM_M", "100"))
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
                i_tags = next((i for i, h in enumerate(header) if re.search(r"tag|標籤", h, re.I)), None)
                i_race = ci("Competition", "Race", "競賽")
                if i_file is None:
                    continue
                base = name.rsplit("activities.csv", 1)[0]
                for r in rows:
                    if len(r) > i_file and r[i_file]:
                        tags = set(r[i_tags].lower().split("|")) if i_tags is not None and len(r) > i_tags and r[i_tags] else set()
                        race_col = r[i_race].strip() if i_race is not None and len(r) > i_race else ""
                        meta[base + r[i_file]] = {"id": r[i_id] if i_id is not None else None,
                                                  "type": r[i_type] if i_type is not None else None,
                                                  "tags": tags,
                                                  "race": "race" in tags or race_col not in ("", "0", "0.0", "false")}

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
            # Strava 標籤 offroad + 跑步 = 越野跑（Garmin 同步過來的越野跑常被記成一般跑步）
            if sport == "run" and not folder_sport and "offroad" in m.get("tags", ()):
                sport = "trail_run"
            if sport == "run" and not folder_sport and res["sport"] == "trail_run":
                sport = "trail_run"  # FIT 檔本身標記為越野跑
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
            rec = {"id": aid, "s": sport, "d": d, "km": round(km, 2), "p": encode([p[:2] for p in pts])}
            # 每點海拔（公尺）與時間（距第一點的秒數），供 3D 鳥瞰使用
            ele = fill([p[2] if len(p) > 2 else None for p in pts])
            if ele:
                rec["e"] = encode_ints([round(v) for v in ele])
            ts = fill([p[3] if len(p) > 3 else None for p in pts])
            if ts and ts[-1] > ts[0]:
                t0, sec, prev = ts[0], [], 0
                for v in ts:
                    prev = max(prev, round(v - t0))  # 確保遞增
                    sec.append(prev)
                rec["ts"] = encode_ints(sec)
            if t:
                rec["t"] = t
            if m.get("race"):
                rec["r"] = 1
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
