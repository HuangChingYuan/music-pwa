# 聲軌 Lyric Player

原生 JavaScript（無框架、無建置步驟）的 RWD + PWA 本機音樂播放器。

- **同步歌詞**：LRC 逐行高亮、單行逐字填色、點歌詞跳轉、手動捲動後自動回到目前行、每首歌可微調歌詞偏移（±0.5s）
- **背景播放**：`<audio>` + Media Session API，鎖定畫面／通知列／藍牙耳機按鍵可控制播放、切歌、拖曳進度
- **本機曲庫**：音檔以 Blob 存入 IndexedDB，離線也能播放；記住播放佇列、進度、隨機／重複、音量
- **自動配對**：同名 `.lrc` 自動配對（`周杰倫 - 晴天.mp3` ↔ `周杰倫 - 晴天.lrc`）；MP3 內嵌 ID3 歌名／歌手／封面／USLT 歌詞也會讀取（含 Big5 / GBK 亂碼修正）
- **RWD**：手機為「曲庫／歌詞」分頁 + 底部播放列；平板兩欄；寬螢幕三區（曲庫｜封面｜歌詞）。主色會依封面自動變化
- **PWA**：可安裝、離線開啟；桌面 Chrome/Edge 安裝後可從檔案總管「用聲軌開啟」音檔

## 執行

Service Worker 需要 `https://` 或 `localhost`：

```bash
cd music-pwa
python3 -m http.server 8080      # 或 npx serve .
# 開 http://localhost:8080
```

手機測試可部署到 GitHub Pages / Netlify / Cloudflare Pages（純靜態檔，直接上傳整個資料夾即可，路徑皆為相對路徑，放在子目錄也可運作）。

第一次開啟可按「產生示範曲」，會在瀏覽器內合成一首約 34 秒的曲子與 LRC，用來確認歌詞同步與背景播放。

## 檔案結構

```
index.html               版面 + SVG 圖示
css/style.css            樣式與 RWD 斷點（860px / 1180px）
js/app.js                播放器主程式（佇列、歌詞同步、Media Session、匯入）
js/lrc.js                LRC 解析 + 二分搜尋目前行
js/tags.js               ID3v2.3/2.4 讀取（TIT2/TPE1/TALB/APIC/USLT）
js/db.js                 IndexedDB 封裝
js/demo.js               示範曲合成（按需載入）
sw.js                    App 外殼快取
manifest.webmanifest
icons/
```

## 背景播放注意事項

| 平台 | 狀況 |
|---|---|
| Android Chrome | 瀏覽器分頁或安裝後皆可背景播放，通知列有媒體控制 |
| iOS / iPadOS Safari | 支援背景播放與鎖定畫面控制；建議「加入主畫面」以 PWA 開啟。**刻意沒有使用 Web Audio API 處理音訊**，因為把 `<audio>` 接進 AudioContext 在 iOS 會導致鎖屏後中斷 |
| 桌面 Chrome / Edge / Firefox | 正常，鍵盤媒體鍵可用 |

背景時歌詞不會更新 DOM（rAF 迴圈停止以省電），回到前景時立即重新同步。

## 快捷鍵

`Space` 播放/暫停、`←/→` 快轉 5 秒（加 Shift 為 30 秒）、`N` 下一首、`P` 上一首

## LRC 支援範圍

- `[mm:ss.xx]`、`[mm:ss.xxx]`、`[mm:ss]`，一行多個時間標籤
- `[offset:+500]`（正值 = 歌詞提早出現）、`[ti:] [ar:] [al:]` 等標頭
- 增強型逐字標籤 `<mm:ss.xx>` 會被移除，以整行為單位同步
- 無時間標籤的文字檔顯示為純文字歌詞
- 編碼自動判斷 UTF-8 → Big5 → GBK → UTF-16

## 已知限制

- 標籤只讀 MP3 的 ID3v2.3/2.4；M4A / FLAC 會從檔名推測「歌手 - 歌名」
- 曲庫存在瀏覽器儲存空間：清除網站資料會一併刪除；iOS 長時間未開啟的網站可能被系統清除（App 會在匯入後呼叫 `navigator.storage.persist()` 降低此風險）
- 可播放的格式取決於瀏覽器（例如 iOS 不支援 OGG/Opus 容器的部分變體）

## 更新版本

修改檔案後，把 `sw.js` 的 `VERSION` 改一下，使用者下次開啟會收到「有新版本」提示，重開即更新。
