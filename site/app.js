/* 我的足跡熱圖 — 以 Canvas 疊加繪製個人活動路線 */
(() => {
  "use strict";

  const SPORTS = ["run", "trail_run", "walk", "hike", "ride"];
  const GROUPS = { foot: ["run", "trail_run", "walk", "hike"], cycle: ["ride"], all: SPORTS };
  const SPORT_NAMES = { run: "跑步", trail_run: "山徑越野跑", walk: "步行", hike: "健行", ride: "騎車" };

  // 自訂配色：[位置 0–1, 顏色]
  const PALETTES = {
    ember:   { name: "餘燼", stops: [[0, "#3b0718"], [0.3, "#a3132f"], [0.55, "#ff4b1f"], [0.8, "#ffb340"], [1, "#fff6d6"]] },
    glacier: { name: "冰河", stops: [[0, "#06263f"], [0.3, "#0f5c8f"], [0.6, "#2fb4f0"], [0.85, "#a8ecff"], [1, "#ffffff"]] },
    aurora:  { name: "極光", stops: [[0, "#1d0b3a"], [0.35, "#5c2a9d"], [0.6, "#c04fd0"], [0.85, "#ffa3e4"], [1, "#fff0fb"]] },
    moss:    { name: "苔原", stops: [[0, "#06281c"], [0.35, "#0b7a4b"], [0.65, "#3fd27a"], [0.9, "#d4ff8a"], [1, "#fbffe8"]] },
    chalk:   { name: "粉筆", stops: [[0, "#2a2d33"], [0.4, "#6d737d"], [0.75, "#c3c8cf"], [1, "#ffffff"]] },
  };

  const store = {
    get(k, d) { try { const v = localStorage.getItem("hm:" + k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("hm:" + k, v); } catch { /* 忽略 */ } },
  };

  const state = {
    tracks: [],
    enabled: new Set(SPORTS),
    year: "all",
    palette: PALETTES[store.get("palette")] ? store.get("palette") : "ember",
    intensity: +store.get("intensity", 5),
    basemap: store.get("basemap", "dark"),
    demo: false,
  };

  // ---------- 地圖 ----------
  const map = L.map("map", { zoomControl: false, preferCanvas: true, worldCopyJump: true, minZoom: 2 });
  L.control.zoom({ position: "bottomright" }).addTo(map);
  map.createPane("heat").style.zIndex = 450;
  map.createPane("labels").style.zIndex = 550;
  map.getPane("labels").style.pointerEvents = "none";

  // OpenStreetMap 圖磚不需要 API key；深色／淺色以 CSS 濾鏡處理（見 style.css .tiles-*）
  const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const osmAttr = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  const osm = (cls) => L.tileLayer(OSM, { attribution: osmAttr, maxZoom: 19, className: cls });
  const BASEMAPS = {
    dark: [osm("tiles-dark")],
    light: [osm("tiles-light")],
    street: [osm("tiles-street")],
    satellite: [L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Imagery &copy; Esri", maxZoom: 19, maxNativeZoom: 18 })],
  };
  let activeBase = [];
  function setBasemap(name) {
    if (!BASEMAPS[name]) name = "dark";
    activeBase.forEach((l) => map.removeLayer(l));
    activeBase = BASEMAPS[name];
    activeBase.forEach((l) => l.addTo(map));
    document.documentElement.dataset.theme = name === "light" || name === "street" ? "light" : "dark";
    state.basemap = name;
    store.set("basemap", name);
  }

  // ---------- 熱圖圖層 ----------
  const HeatLayer = L.Layer.extend({
    onAdd(m) {
      this._canvas = L.DomUtil.create("canvas", "heat-canvas leaflet-zoom-hide");
      this._buf = document.createElement("canvas");
      m.getPane("heat").appendChild(this._canvas);
      m.on("moveend zoomend resize viewreset", this._reset, this);
      this._reset();
    },
    onRemove(m) {
      L.DomUtil.remove(this._canvas);
      m.off("moveend zoomend resize viewreset", this._reset, this);
    },
    redraw() {
      if (!this._frame) this._frame = requestAnimationFrame(() => { this._frame = null; this._draw(); });
    },
    _reset() {
      const m = this._map, size = m.getSize(), dpr = window.devicePixelRatio || 1;
      L.DomUtil.setPosition(this._canvas, m.containerPointToLayerPoint([0, 0]));
      for (const c of [this._canvas, this._buf]) {
        c.width = Math.round(size.x * dpr);
        c.height = Math.round(size.y * dpr);
      }
      this._canvas.style.width = size.x + "px";
      this._canvas.style.height = size.y + "px";
      this._draw();
    },
    _draw() {
      const m = this._map; if (!m) return;
      const dpr = window.devicePixelRatio || 1;
      const W = this._buf.width, H = this._buf.height;
      if (!W || !H) return;
      const zoom = m.getZoom();
      const k = m.options.crs.scale(zoom) / 256;      // 從 zoom 0 像素放大到目前 zoom
      const origin = m.getPixelBounds().min;           // 目前視窗左上角（世界像素）
      const pad = 8 / k;
      const vx0 = origin.x / k - pad, vy0 = origin.y / k - pad;
      const vx1 = vx0 + W / dpr / k + 2 * pad, vy1 = vy0 + H / dpr / k + 2 * pad;

      const b = this._buf.getContext("2d", { willReadFrequently: true });
      b.setTransform(1, 0, 0, 1, 0, 0);
      b.clearRect(0, 0, W, H);
      b.globalCompositeOperation = "lighter";
      const alpha = intensityAlpha();
      b.strokeStyle = `rgba(255,255,255,${alpha})`;
      b.lineWidth = Math.max(1, Math.min(4.5, 1 + (zoom - 10) * 0.45)) * dpr;
      b.lineJoin = "round"; b.lineCap = "round";

      const minStep = 0.8 * dpr;
      for (const t of visibleTracks()) {
        const bb = t.bb;
        // 經度方向考慮世界環繞
        let shift = 0;
        const worldW = 256;
        if (bb[2] < vx0) shift = Math.ceil((vx0 - bb[2]) / worldW) * worldW;
        else if (bb[0] > vx1) shift = -Math.ceil((bb[0] - vx1) / worldW) * worldW;
        if (bb[0] + shift > vx1 || bb[2] + shift < vx0 || bb[1] > vy1 || bb[3] < vy0) continue;

        const xy = t.xy, n = xy.length;
        b.beginPath();
        let lx = ((xy[0] + shift) * k - origin.x) * dpr, ly = (xy[1] * k - origin.y) * dpr;
        b.moveTo(lx, ly);
        for (let i = 2; i < n; i += 2) {
          const x = ((xy[i] + shift) * k - origin.x) * dpr, y = (xy[i + 1] * k - origin.y) * dpr;
          if (Math.abs(x - lx) + Math.abs(y - ly) < minStep && i < n - 2) continue;
          b.lineTo(x, y); lx = x; ly = y;
        }
        b.stroke();
      }

      // 依累積強度上色
      const src = b.getImageData(0, 0, W, H).data;
      const ctx = this._canvas.getContext("2d");
      const out = ctx.createImageData(W, H);
      const o = out.data, lut = getLut(alpha);
      for (let i = 3; i < src.length; i += 4) {
        const v = src[i];
        if (!v) continue;
        const j = v << 2;
        o[i - 3] = lut[j]; o[i - 2] = lut[j + 1]; o[i - 1] = lut[j + 2]; o[i] = lut[j + 3];
      }
      ctx.putImageData(out, 0, 0);
    },
  });

  function intensityAlpha() {
    return 0.018 * Math.pow(1.38, state.intensity - 1); // 1 → 0.018, 5 → 0.065, 10 → 0.32
  }

  const hexToRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  function samplePalette(stops, t) {
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [p0, c0] = stops[i - 1], [p1, c1] = stops[i];
        const f = (t - p0) / (p1 - p0 || 1), a = hexToRgb(c0), z = hexToRgb(c1);
        return a.map((v, k) => Math.round(v + (z[k] - v) * f));
      }
    }
    return hexToRgb(stops[stops.length - 1][1]);
  }
  let lutCache = {};
  function getLut(alpha) {
    const key = state.palette + ":" + alpha;
    if (lutCache[key]) return lutCache[key];
    const lut = new Uint8ClampedArray(256 * 4);
    const stops = PALETTES[state.palette].stops;
    const sat = 1 / alpha;                      // 約幾次疊加後飽和
    for (let v = 1; v < 256; v++) {
      const passes = (v / 255) * sat;
      const t = Math.min(1, Math.log1p(passes) / Math.log1p(sat));
      const [r, g, bl] = samplePalette(stops, t);
      lut.set([r, g, bl, Math.round(255 * Math.min(1, 0.3 + t * 2.5))], v * 4);
    }
    lutCache = { [key]: lut };
    return lut;
  }

  const heat = new HeatLayer().addTo(map);

  // ---------- 資料 ----------
  function decodePolyline(s) {
    const pts = []; let i = 0, lat = 0, lng = 0;
    while (i < s.length) {
      for (let which = 0; which < 2; which++) {
        let shift = 0, result = 0, b;
        do { b = s.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
        const d = result & 1 ? ~(result >> 1) : result >> 1;
        if (which === 0) lat += d; else lng += d;
      }
      pts.push([lat / 1e5, lng / 1e5]);
    }
    return pts;
  }

  function makeTrack(pts, sport, date, km, local) {
    const xy = new Float64Array(pts.length * 2);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    let prevX = null;
    pts.forEach(([lat, lng], i) => {
      const p = map.options.crs.latLngToPoint(L.latLng(lat, lng), 0);
      let x = p.x;
      // 保持跨越換日線時路線連續
      if (prevX != null) { while (x - prevX > 128) x -= 256; while (prevX - x > 128) x += 256; }
      prevX = x;
      xy[i * 2] = x; xy[i * 2 + 1] = p.y;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y;
    });
    const latlngs = [];
    const lats = pts.map((p) => p[0]), lngs = pts.map((p) => p[1]);
    latlngs.push([Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]);
    return { xy, bb: [x0, y0, x1, y1], sport, date: date || "", year: (date || "").slice(0, 4), km: km || 0, local: !!local, bounds: latlngs };
  }

  async function loadJson(url) {
    try {
      const res = await fetch(url, { cache: "no-cache" });
      return res.ok ? await res.json() : null;
    } catch { return null; }
  }

  async function loadData() {
    // activities.json：Strava API 每日同步；imported.json：匯出檔匯入（scripts/import_export.py）
    const [api, imported] = await Promise.all([loadJson("data/activities.json"), loadJson("data/imported.json")]);
    const seen = new Set();
    const list = [];
    for (const src of [api, imported]) {
      for (const a of (src && src.activities) || []) {
        const keys = [String(a.id), a.t].filter(Boolean);
        if (keys.some((k) => seen.has(k))) continue;
        keys.forEach((k) => seen.add(k));
        list.push(a);
      }
    }
    if (list.length) {
      state.tracks = list.filter((a) => SPORTS.includes(a.s)).map((a) => makeTrack(decodePolyline(a.p), a.s, a.d, a.km));
      state.generated = [api, imported].map((x) => x && x.generated).filter(Boolean).sort().pop();
    } else {
      state.demo = true;
      state.tracks = demoTracks();
    }
  }

  // ---------- 示範資料（尚未設定 Strava 時） ----------
  function demoTracks() {
    let seed = 20261103;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const tracks = [];
    const plans = [
      { sport: "run", n: 14, center: [25.035, 121.545], spread: 0.04, steps: [25, 60], step: 0.0035, grid: true },
      { sport: "walk", n: 10, center: [25.045, 121.52], spread: 0.03, steps: [12, 30], step: 0.0025, grid: true },
      { sport: "ride", n: 8, center: [25.06, 121.51], spread: 0.08, steps: [60, 140], step: 0.006, grid: true },
      { sport: "hike", n: 6, center: [25.16, 121.55], spread: 0.05, steps: [40, 90], step: 0.0018, grid: false },
      { sport: "trail_run", n: 6, center: [25.0, 121.58], spread: 0.04, steps: [40, 90], step: 0.0022, grid: false },
    ];
    const rot = 0.32; // 模擬街道方位
    for (const p of plans) {
      for (let r = 0; r < p.n; r++) {
        let lat = p.center[0] + (rnd() - 0.5) * p.spread, lng = p.center[1] + (rnd() - 0.5) * p.spread;
        const base = [[lat, lng]];
        let dir = Math.floor(rnd() * 4), ang = rnd() * Math.PI * 2;
        const steps = p.steps[0] + Math.floor(rnd() * (p.steps[1] - p.steps[0]));
        for (let s = 0; s < steps; s++) {
          let dx, dy;
          if (p.grid) {
            if (rnd() < 0.25) dir = (dir + (rnd() < 0.5 ? 1 : 3)) % 4;
            const a = rot + (dir * Math.PI) / 2;
            dx = Math.cos(a); dy = Math.sin(a);
          } else {
            ang += (rnd() - 0.5) * 1.4; dx = Math.cos(ang); dy = Math.sin(ang);
          }
          const len = p.step * (0.6 + rnd() * 0.8);
          lat += dy * len; lng += (dx * len) / Math.cos((lat * Math.PI) / 180);
          base.push([lat, lng]);
        }
        const repeats = 1 + Math.floor(Math.pow(rnd(), 2.2) * 40);
        for (let k = 0; k < repeats; k++) {
          const jit = 0.00004;
          const pts = base.map(([a, b]) => [a + (rnd() - 0.5) * jit, b + (rnd() - 0.5) * jit]);
          const y = 2023 + Math.floor(rnd() * 4), mo = 1 + Math.floor(rnd() * 12);
          tracks.push(makeTrack(pts, p.sport, `${y}-${String(mo).padStart(2, "0")}-15`, 0));
        }
      }
    }
    return tracks;
  }

  // ---------- 篩選 ----------
  function inYear(t) {
    if (state.year === "all") return true;
    if (state.year === "12m") {
      const d = new Date(); d.setFullYear(d.getFullYear() - 1);
      return t.date >= d.toISOString().slice(0, 10);
    }
    return t.year === state.year;
  }
  const visibleTracks = () => state.tracks.filter((t) => state.enabled.has(t.sport) && inYear(t));

  // ---------- 介面 ----------
  const $ = (s) => document.querySelector(s);
  const tree = $("#sportTree");

  function syncTree() {
    tree.querySelectorAll("input[data-sport]").forEach((cb) => (cb.checked = state.enabled.has(cb.dataset.sport)));
    tree.querySelectorAll("input[data-group]").forEach((cb) => {
      const members = GROUPS[cb.dataset.group];
      const on = members.filter((s) => state.enabled.has(s)).length;
      cb.checked = on === members.length;
      cb.indeterminate = on > 0 && on < members.length;
    });
  }

  tree.addEventListener("change", (e) => {
    const cb = e.target;
    const list = cb.dataset.sport ? [cb.dataset.sport] : GROUPS[cb.dataset.group];
    list.forEach((s) => (cb.checked ? state.enabled.add(s) : state.enabled.delete(s)));
    update();
  });

  function buildYears() {
    const years = [...new Set(state.tracks.map((t) => t.year).filter(Boolean))].sort().reverse();
    const opts = [["all", "全部"], ["12m", "近一年"], ...years.map((y) => [y, y])];
    const seg = $("#yearSeg");
    seg.innerHTML = "";
    for (const [v, label] of opts) {
      const btn = document.createElement("button");
      btn.type = "button"; btn.textContent = label; btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(state.year === v));
      btn.onclick = () => { state.year = v; buildYears(); update(); };
      seg.appendChild(btn);
    }
  }

  function buildPalettes() {
    const box = $("#palettes");
    box.innerHTML = "";
    for (const [key, p] of Object.entries(PALETTES)) {
      const btn = document.createElement("button");
      btn.type = "button"; btn.title = p.name; btn.setAttribute("aria-label", p.name); btn.setAttribute("role", "radio");
      btn.setAttribute("aria-checked", String(state.palette === key));
      btn.style.background = `linear-gradient(90deg, ${p.stops.map(([pos, c]) => `${c} ${pos * 100}%`).join(",")})`;
      btn.onclick = () => { state.palette = key; store.set("palette", key); buildPalettes(); heat.redraw(); };
      box.appendChild(btn);
    }
  }

  function updateCounts() {
    const counts = Object.fromEntries(SPORTS.map((s) => [s, 0]));
    state.tracks.forEach((t) => { if (inYear(t)) counts[t.sport]++; });
    for (const [g, members] of Object.entries(GROUPS)) counts[g] = members.reduce((a, s) => a + counts[s], 0);
    tree.querySelectorAll("em[data-count]").forEach((el) => (el.textContent = counts[el.dataset.count].toLocaleString()));
  }

  function updateStats() {
    const vis = visibleTracks();
    const km = vis.reduce((a, t) => a + t.km, 0);
    const days = new Set(vis.map((t) => t.date)).size;
    const top = SPORTS.map((s) => [s, vis.filter((t) => t.sport === s).length]).sort((a, b) => b[1] - a[1])[0];
    $("#stats").innerHTML = `
      <div class="stat"><b>${vis.length.toLocaleString()}</b><span>次活動</span></div>
      <div class="stat"><b>${km ? Math.round(km).toLocaleString() : "—"}</b><span>公里</span></div>
      <div class="stat"><b>${days.toLocaleString()}</b><span>個運動日</span></div>
      <div class="stat"><b>${top && top[1] ? SPORT_NAMES[top[0]] : "—"}</b><span>最常進行</span></div>`;
  }

  function update() {
    syncTree(); updateCounts(); updateStats(); heat.redraw();
  }

  function fitToData() {
    const vis = visibleTracks();
    if (!vis.length) return;
    // 去除離群值：取各邊界的 5%–95% 分位數
    const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
    const trimP = vis.length > 20 ? 0.05 : 0;
    const s = q(vis.map((t) => t.bounds[0][0]), trimP), w = q(vis.map((t) => t.bounds[0][1]), trimP);
    const n = q(vis.map((t) => t.bounds[1][0]), 1 - trimP), e = q(vis.map((t) => t.bounds[1][1]), 1 - trimP);
    const narrow = window.innerWidth <= 640;
    const panelH = $("#panel").getBoundingClientRect().height;
    map.fitBounds([[s, w], [n, e]], narrow
      ? { paddingTopLeft: [20, 60], paddingBottomRight: [20, panelH + 20] }
      : { paddingTopLeft: [340, 30], paddingBottomRight: [30, 30] });
  }

  // GPX 匯入
  function guessSport(type, name) {
    const s = `${type} ${name}`.toLowerCase();
    if (/trail/.test(s) || /越野/.test(s)) return "trail_run";
    if (/hik|健行|登山/.test(s)) return "hike";
    if (/walk|步行|散步/.test(s)) return "walk";
    if (/rid|cycl|bik|騎/.test(s)) return "ride";
    return "run";
  }
  async function importGpx(files) {
    let added = 0;
    for (const f of files) {
      if (!/\.gpx$/i.test(f.name)) continue;
      const doc = new DOMParser().parseFromString(await f.text(), "application/xml");
      const pts = [...doc.querySelectorAll("trkpt, rtept")].map((p) => [+p.getAttribute("lat"), +p.getAttribute("lon")]).filter((p) => isFinite(p[0]) && isFinite(p[1]));
      if (pts.length < 2) continue;
      const type = doc.querySelector("trk > type")?.textContent || "";
      const name = doc.querySelector("trk > name, metadata > name")?.textContent || f.name;
      const time = doc.querySelector("trkpt time, metadata > time")?.textContent || "";
      let km = 0;
      for (let i = 1; i < pts.length; i++) km += map.distance(pts[i - 1], pts[i]) / 1000;
      state.tracks.push(makeTrack(pts, guessSport(type, name), time.slice(0, 10), km, true));
      added++;
    }
    if (!added) { showBanner("沒有找到可用的 GPX 路線。"); return; }
    if (state.demo) { state.tracks = state.tracks.filter((t) => t.local); state.demo = false; }
    buildYears(); update(); fitToData();
    showBanner(`已匯入 ${added} 條 GPX 路線（僅在此瀏覽器顯示，重新整理後會消失）。`);
    setSubtitle();
  }

  function showBanner(html, sticky) {
    const el = $("#banner");
    el.innerHTML = html; el.hidden = false;
    clearTimeout(showBanner._t);
    if (!sticky) showBanner._t = setTimeout(() => (el.hidden = true), 6000);
  }

  function setSubtitle() {
    const sub = $("#subtitle");
    if (state.demo) sub.textContent = "示範資料";
    else if (state.generated) sub.textContent = `更新於 ${new Date(state.generated).toLocaleString("zh-TW", { dateStyle: "medium", timeStyle: "short" })}`;
    else sub.textContent = "本機匯入資料";
  }

  // 網址記錄地圖位置：#zoom/lat/lng
  function readHash() {
    const m = location.hash.match(/^#(\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/);
    return m ? { z: +m[1], c: [+m[2], +m[3]] } : null;
  }
  map.on("moveend", () => {
    const c = map.getCenter();
    history.replaceState(null, "", `#${map.getZoom()}/${c.lat.toFixed(4)}/${c.lng.toFixed(4)}`);
  });

  // 事件
  $("#togglePanel").onclick = () => {
    const p = $("#panel"); p.classList.toggle("collapsed");
    $("#togglePanel").setAttribute("aria-expanded", String(!p.classList.contains("collapsed")));
  };
  $("#intensity").value = state.intensity;
  $("#intensity").oninput = (e) => { state.intensity = +e.target.value; store.set("intensity", state.intensity); heat.redraw(); };
  $("#basemap").value = state.basemap;
  $("#basemap").onchange = (e) => setBasemap(e.target.value);
  $("#fitBtn").onclick = fitToData;
  $("#locateBtn").onclick = () => map.locate({ setView: true, maxZoom: 14 });
  map.on("locationerror", () => showBanner("無法取得目前位置。"));
  $("#gpxInput").onchange = (e) => importGpx(e.target.files);

  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { if (e.dataTransfer?.types?.includes("Files")) { dragDepth++; $("#dropOverlay").hidden = false; } });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; $("#dropOverlay").hidden = true; } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => { e.preventDefault(); dragDepth = 0; $("#dropOverlay").hidden = true; importGpx(e.dataTransfer.files); });

  // 啟動
  (async () => {
    setBasemap(state.basemap);
    if (window.innerWidth <= 640) $("#panel").classList.add("collapsed");
    const h = readHash();
    map.setView(h ? h.c : [23.7, 121], h ? h.z : 7);
    await loadData();
    buildYears(); buildPalettes(); update(); setSubtitle();
    if (!h) fitToData();
    if (state.demo) {
      showBanner('目前顯示的是<b>示範資料</b>。依照 <a href="https://github.com/steking1207/heatmap#readme" target="_blank" rel="noopener">README</a> 設定 Strava 後就會顯示你的活動，也可以直接拖曳 GPX 檔進來。', true);
    }
  })();
})();
