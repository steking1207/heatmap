#!/usr/bin/env python3
"""一次性工具：取得具有 activity:read_all 權限的 Strava refresh token。

用法：
  python3 scripts/get_refresh_token.py <CLIENT_ID> <CLIENT_SECRET>
依照提示在瀏覽器授權，再把網址列中的 code 貼回來。
"""
import json
import sys
import urllib.parse
import urllib.request

if len(sys.argv) != 3:
    sys.exit(__doc__)
cid, secret = sys.argv[1], sys.argv[2]
url = "https://www.strava.com/oauth/authorize?" + urllib.parse.urlencode({
    "client_id": cid,
    "redirect_uri": "http://localhost/exchange_token",
    "response_type": "code",
    "approval_prompt": "force",
    "scope": "read,activity:read_all",
})
print("1. 用瀏覽器開啟以下網址並按「授權」：\n\n   " + url + "\n")
print("2. 瀏覽器會跳到一個打不開的 localhost 網址，這是正常的。")
raw = input("   把整個網址（或其中 code= 後面的值）貼在這裡：").strip()
code = urllib.parse.parse_qs(urllib.parse.urlparse(raw).query).get("code", [raw])[0]
body = urllib.parse.urlencode({"client_id": cid, "client_secret": secret, "code": code,
                               "grant_type": "authorization_code"}).encode()
with urllib.request.urlopen(urllib.request.Request("https://www.strava.com/oauth/token", data=body)) as r:
    tok = json.load(r)
print("\n授權範圍：", tok.get("scope", "(未回傳)"))
print("STRAVA_REFRESH_TOKEN =", tok["refresh_token"])
