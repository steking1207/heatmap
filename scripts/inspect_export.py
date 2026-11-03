#!/usr/bin/env python3
"""檢查 Strava 匯出檔 activities.csv 的欄位（只列出欄位名稱與少量分類值，不印出活動名稱或描述）。
用法：py inspect_export.py <匯出檔.zip>
"""
import collections
import csv
import io
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as z:
    name = next(n for n in z.namelist() if n.endswith("activities.csv"))
    rows = list(csv.reader(io.TextIOWrapper(z.open(name), "utf-8-sig")))
header, body = rows[0], rows[1:]
print(f"{len(body)} 筆活動，{len(header)} 個欄位\n")
for i, h in enumerate(header):
    vals = collections.Counter(r[i] for r in body if i < len(r))
    if len(vals) <= 12:
        print(f"[{i}] {h}: " + ", ".join(f"{v or '(空)'}×{c}" for v, c in vals.most_common()))
    else:
        print(f"[{i}] {h}: （{len(vals)} 種不同值）")
