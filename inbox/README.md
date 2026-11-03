# 新活動投遞區

把新活動的 `.fit`、`.gpx`、`.tcx`（可為 `.gz` 或 `.zip`）上傳到這個資料夾，GitHub Actions 會自動：

1. 轉換並合併進 `site/data/imported.json`
2. 清空這個資料夾
3. 重新部署網站

上傳方式：在 GitHub 網頁打開這個資料夾 → **Add file → Upload files** → 拖曳檔案 → **Commit changes**。手機瀏覽器也可以。

運動類型會自動從檔案判斷。若判斷錯誤，可以放進以類型命名的子資料夾（`run/`、`trail_run/`、`walk/`、`hike/`、`ride/`），例如上傳時把檔名改成 `hike/xxx.fit`。
