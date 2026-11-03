#!/usr/bin/env python3
"""從 Strava API 抓取自己的活動，輸出成 heatmap 使用的 JSON。

需要環境變數：
  STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN
選用：
  PRIVACY_TRIM_M  每條路線頭尾各裁掉幾公尺（預設 200，保護住家位置；設 0 關閉）
  OUTPUT          輸出路徑（預設 site/data/activities.json）

只使用 Python 標準函式庫。
"""
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request

API = "https://www.strava.com/api/v3"

# Strava sport_type → 本站分類
SPORT_MAP = {
    "Run": "run",
    "VirtualRun": None,  # 沒有實際路線
    "TrailRun": "trail_run",
    "Walk": "walk",
    "Hike": "hike",
    "Ride": "ride",
    "GravelRide": "ride",
    "MountainBikeRide": "ride",
    "EBikeRide": "ride",
    "EMountainBikeRide": "ride",
}


def http_json(url, data=None, headers=None):
    body = urllib.parse.urlencode(data).encode() if data else None
    req = urllib.request.Request(url, data=body, headers=headers or {})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                print("Strava 速率限制，等待 60 秒…", file=sys.stderr)
                time.sleep(60)
                continue
            print(e.read().decode(errors="replace"), file=sys.stderr)
            raise
    raise RuntimeError("重試次數用盡")


def get_access_token():
    tok = http_json(
        "https://www.strava.com/oauth/token",
        {
            "client_id": os.environ["STRAVA_CLIENT_ID"],
            "client_secret": os.environ["STRAVA_CLIENT_SECRET"],
            "refresh_token": os.environ["STRAVA_REFRESH_TOKEN"],
            "grant_type": "refresh_token",
        },
    )
    if "access_token" not in tok:
        raise RuntimeError(f"取得 token 失敗：{tok}")
    return tok["access_token"]


# ---- Google encoded polyline ----
def decode(s):
    pts, i, lat, lng = [], 0, 0, 0
    while i < len(s):
        for which in (0, 1):
            shift = result = 0
            while True:
                b = ord(s[i]) - 63
                i += 1
                result |= (b & 0x1F) << shift
                shift += 5
                if b < 0x20:
                    break
            d = ~(result >> 1) if result & 1 else result >> 1
            if which == 0:
                lat += d
            else:
                lng += d
        pts.append((lat / 1e5, lng / 1e5))
    return pts


def encode(pts):
    out, plat, plng = [], 0, 0
    for lat, lng in pts:
        ilat, ilng = round(lat * 1e5), round(lng * 1e5)
        for d in (ilat - plat, ilng - plng):
            v = ~(d << 1) if d < 0 else d << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        plat, plng = ilat, ilng
    return "".join(out)


def haversine(a, b):
    r = 6371000
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def trim(pts, meters):
    if meters <= 0 or len(pts) < 3:
        return pts

    def cut(seq):
        acc = 0
        for i in range(1, len(seq)):
            acc += haversine(seq[i - 1], seq[i])
            if acc >= meters:
                return i
        return len(seq)

    start = cut(pts)
    end = len(pts) - cut(pts[::-1])
    return pts[start:end] if end - start >= 2 else []


def main():
    trim_m = float(os.environ.get("PRIVACY_TRIM_M", "200"))
    output = os.environ.get("OUTPUT", "site/data/activities.json")
    token = get_access_token()
    headers = {"Authorization": f"Bearer {token}"}

    activities, page = [], 1
    while True:
        batch = http_json(f"{API}/athlete/activities?per_page=200&page={page}", headers=headers)
        if not batch:
            break
        activities.extend(batch)
        print(f"第 {page} 頁：{len(batch)} 筆", file=sys.stderr)
        page += 1

    out = []
    for a in activities:
        sport = SPORT_MAP.get(a.get("sport_type") or a.get("type"))
        poly = (a.get("map") or {}).get("summary_polyline")
        if not sport or not poly:
            continue
        pts = trim(decode(poly), trim_m)
        if len(pts) < 2:
            continue
        out.append({
            "id": a["id"],
            "s": sport,
            "d": a["start_date_local"][:10],
            "km": round(a.get("distance", 0) / 1000, 2),
            "t": (a.get("start_date") or "")[:16],
            "p": encode(pts),
        })

    out.sort(key=lambda x: x["d"])
    os.makedirs(os.path.dirname(output), exist_ok=True)
    with open(output, "w", encoding="utf-8") as f:
        json.dump({"generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "activities": out},
                  f, ensure_ascii=False, separators=(",", ":"))
    print(f"輸出 {len(out)} 筆有路線的活動 → {output}", file=sys.stderr)


if __name__ == "__main__":
    main()
