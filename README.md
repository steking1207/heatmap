# 我的足跡熱圖

用自己的 Strava 活動畫出的個人運動熱圖，部署在 GitHub Pages。

- 運動篩選：所有運動／所有足部運動（跑步、山徑越野跑、步行、健行，可個別勾選）／所有騎車運動（騎車）
- 時間範圍：全部、近一年、各年份
- 5 種配色、亮度調整，深色／淺色／衛星底圖
- 路線重疊越多次越亮，和 Strava 熱圖一樣的效果，但全部在瀏覽器端用 Canvas 繪製
- 可直接把 GPX 檔拖進網頁臨時檢視（不會上傳）
- GitHub Actions 每天自動從 Strava 同步一次

還沒設定 Strava 之前，網站會顯示示範資料。

## 設定步驟

### 1. 開啟 GitHub Pages

Repo → **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。

### 2. 建立 Strava API 應用程式

1. 到 <https://www.strava.com/settings/api> 建立應用程式。
   - Application Name、Website 隨意填（Website 可以填你的 GitHub Pages 網址）
   - **Authorization Callback Domain 填 `localhost`**
2. 記下 **Client ID** 和 **Client Secret**。

### 3. 取得 refresh token（只要做一次）

在自己電腦上執行（只需要 Python 3）：

```bash
python3 scripts/get_refresh_token.py <CLIENT_ID> <CLIENT_SECRET>
```

照提示在瀏覽器按「授權」，把跳轉後的網址貼回終端機，就會印出 `STRAVA_REFRESH_TOKEN`。

> 一定要用這個腳本取得的 token。Strava 設定頁面上直接顯示的 token 只有 `read` 權限，讀不到活動。

### 4. 把三個值存成 GitHub Secrets

Repo → **Settings → Secrets and variables → Actions → New repository secret**：

| 名稱 | 值 |
| --- | --- |
| `STRAVA_CLIENT_ID` | Client ID |
| `STRAVA_CLIENT_SECRET` | Client Secret |
| `STRAVA_REFRESH_TOKEN` | 第 3 步取得的 refresh token |

### 5. 執行部署

**Actions → 同步 Strava 並部署 GitHub Pages → Run workflow**。之後每天台灣時間 04:00 會自動更新。

## 從匯出檔匯入（不需要 Strava API）

適合沒有 Strava 訂閱、或想一次補齊所有歷史活動的情況。支援 Strava 和 Garmin Connect 的匯出檔，也支援任何放了 `.gpx`、`.tcx`、`.fit`（可為 `.gz`）的資料夾。

1. 取得匯出檔（兩個擇一即可）：
   - **Strava**（建議，通常幾小時內收到）：設定 → 我的帳號 → 下載或刪除你的帳號 → 「要求封存」，Email 會收到 zip。
   - **Garmin Connect**：<https://www.garmin.com/account/datamanagement/> → 匯出你的資料，可能要等數天。
2. 執行轉換：
   ```bash
   pip install fitdecode
   python3 scripts/import_export.py ~/Downloads/export_12345.zip
   ```
3. 會產生 `site/data/imported.json`，commit 並 push 後就會部署上去。

再次匯入時會和既有資料合併；同一個活動（以開始時間判斷）不會重複出現。運動類型優先採用 Strava 的 `activities.csv`，否則讀 FIT 檔內的運動類型；室內騎乘、跑步機等沒有 GPS 的活動會自動略過。

### 之後的新活動：上傳到 `inbox/`

不想每次都重新匯出全部資料的話，可以只上傳新活動的檔案：

1. 從 Garmin Connect 活動頁「⚙ → 匯出原始檔」（FIT）或 Strava 活動頁「⋯ → 匯出 GPX」下載單一活動。
2. 在 GitHub 網頁打開 [`inbox/`](inbox/) → **Add file → Upload files** → 拖曳檔案 → **Commit changes**（手機也可以）。
3. Actions 會自動轉換、合併進 `imported.json`、清空 `inbox/` 並重新部署。

API 同步和匯出檔可以同時使用，網站會自動合併兩邊的資料並去除重複。

## 隱私

GitHub Pages 是公開網站，任何拿到網址的人都看得到你的路線。

- 每條路線的起點和終點預設各裁掉 200 公尺，避免直接暴露住家位置。要調整的話，到 **Settings → Secrets and variables → Actions → Variables** 新增 `PRIVACY_TRIM_M`（單位公尺，`0` 代表不裁切）。
- Strava API 抓到的資料只在 Actions 執行時產生並直接部署，不會 commit 進 repo；匯出檔轉出的 `imported.json` 則需要 commit（已套用同樣的頭尾裁切）。
- 只會讀取路線摘要（`summary_polyline`）、日期、距離、運動類型。

## 運動類型對應

| 網站上的選項 | Strava 類型 |
| --- | --- |
| 跑步 | Run |
| 山徑越野跑 | Trail Run |
| 步行 | Walk |
| 健行 | Hike |
| 騎車 | Ride、Gravel Ride、Mountain Bike Ride、E-Bike Ride |

其他類型（游泳、重訓、室內訓練等沒有 GPS 路線的活動）不會出現在地圖上。

## 本機預覽

```bash
# 可選：先抓自己的資料
STRAVA_CLIENT_ID=... STRAVA_CLIENT_SECRET=... STRAVA_REFRESH_TOKEN=... python3 scripts/fetch_strava.py

cd site && python3 -m http.server 8000
# 開啟 http://localhost:8000
```

## 檔案結構

```
site/                 靜態網站（GitHub Pages 發佈這個資料夾）
  index.html, app.js, style.css
  vendor/leaflet/     Leaflet 1.9.4（BSD-2-Clause）
  data/activities.json  由 Actions 從 Strava API 產生
  data/imported.json    由匯出檔轉換產生
scripts/
  import_export.py      Strava／Garmin 匯出檔轉換
  fetch_strava.py       從 Strava API 抓活動
  get_refresh_token.py  一次性取得 refresh token
.github/workflows/deploy.yml
```

地圖底圖：© OpenStreetMap contributors、Esri World Imagery。
