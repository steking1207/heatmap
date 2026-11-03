#!/usr/bin/env python3
"""一次性工具：取得具有 activity:read_all 權限的 Strava refresh token。

用法：
  python3 scripts/get_refresh_token.py <CLIENT_ID> <CLIENT_SECRET>
依照提示在瀏覽器授權，再把網址列中的 code 貼回來。
"""
import json
import re
import sys
import urllib.error
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
m = re.search(r"code=([0-9a-fA-F]+)", raw)
code = m.group(1) if m else raw.split("&")[0].strip()
body = urllib.parse.urlencode({"client_id": cid, "client_secret": secret, "code": code,
                               "grant_type": "authorization_code"}).encode()
try:
    with urllib.request.urlopen(urllib.request.Request("https://www.strava.com/oauth/token", data=body)) as r:
        tok = json.load(r)
except urllib.error.HTTPError as e:
    sys.exit(f"\nStrava 回傳錯誤 {e.code}：{e.read().decode(errors='replace')}\n"
             "code 只能用一次且幾分鐘內就過期，請重新執行此腳本並重新授權；也請確認用戶端密碼正確。")
print("\n授權範圍：", tok.get("scope", "(未回傳)"))
print("STRAVA_REFRESH_TOKEN =", tok["refresh_token"])
