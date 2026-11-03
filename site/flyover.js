/* 單一活動 3D 鳥瞰 — MapLibre GL + AWS Terrain Tiles（不需 API key） */
(() => {
  "use strict";

  const TERRAIN = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
  const SAT = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
  const OSM = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const SPORT_COLORS = { run: "#ff6a2b", trail_run: "#ffb02e", walk: "#4fd1c5", hike: "#7bd75a", ride: "#4f9dff" };
  const SPORT_NAMES = { run: "跑步", trail_run: "山徑越野跑", walk: "步行", hike: "健行", ride: "騎車" };
  const SPEEDS = [0.5, 1, 2, 4];
  const EXAGGERATION = 1.4;

  const store = {
    get(k, d) { try { const v = localStorage.getItem("hm:" + k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem("hm:" + k, v); } catch { /* 忽略 */ } },
  };

  // ---------- 載入 MapLibre（第一次開啟鳥瞰才下載） ----------
  let libPromise;
  function loadLib() {
    if (window.maplibregl) return Promise.resolve();
    if (!libPromise) {
      libPromise = new Promise((resolve, reject) => {
        const css = document.createElement("link");
        css.rel = "stylesheet"; css.href = "vendor/maplibre/maplibre-gl.css";
        document.head.appendChild(css);
        const s = document.createElement("script");
        s.src = "vendor/maplibre/maplibre-gl.js";
        s.onload = () => resolve();
        s.onerror = () => { libPromise = null; reject(new Error("無法載入 3D 地圖元件")); };
        document.head.appendChild(s);
      });
    }
    return libPromise;
  }

  // ---------- 幾何 ----------
  const R = 6371008.8, rad = Math.PI / 180;
  function dist(a, b) { // a, b = [lng, lat]
    const dLat = (b[1] - a[1]) * rad, dLng = (b[0] - a[0]) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  function bearing(a, b) {
    const y = Math.sin((b[0] - a[0]) * rad) * Math.cos(b[1] * rad);
    const x = Math.cos(a[1] * rad) * Math.sin(b[1] * rad) - Math.sin(a[1] * rad) * Math.cos(b[1] * rad) * Math.cos((b[0] - a[0]) * rad);
    return Math.atan2(y, x) / rad;
  }
  const wrap180 = (d) => ((d + 540) % 360) - 180;

  function buildPath(pts) {
    const coords = pts.map(([lat, lng]) => [lng, lat]);
    // 移除重複點
    const c = [coords[0]];
    for (let i = 1; i < coords.length; i++) if (dist(c[c.length - 1], coords[i]) > 0.5) c.push(coords[i]);
    const cum = [0];
    for (let i = 1; i < c.length; i++) cum.push(cum[i - 1] + dist(c[i - 1], c[i]));
    return { coords: c, cum, total: cum[cum.length - 1] };
  }
  // 沿路線距離 d 公尺處的位置，以及所在線段索引
  function locate(path, d) {
    const { coords, cum } = path;
    d = Math.max(0, Math.min(path.total, d));
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= d) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo] || 1, f = (d - cum[lo]) / seg;
    const a = coords[lo], b = coords[hi];
    return { i: lo, p: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f] };
  }
  function bounds(coords) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of coords) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
    return [[w, s], [e, n]];
  }

  // ---------- 高度剖面（直接讀地形圖磚） ----------
  function lng2x(lng, z) { return ((lng + 180) / 360) * 2 ** z; }
  function lat2y(lat, z) { const s = Math.sin(lat * rad); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z; }

  async function elevationProfile(path, samples) {
    const pts = [];
    for (let k = 0; k <= samples; k++) pts.push(locate(path, (path.total * k) / samples).p);
    let z = 13, tiles;
    for (; z >= 8; z--) {
      tiles = new Set(pts.map(([x, y]) => `${Math.floor(lng2x(x, z))}/${Math.floor(lat2y(y, z))}`));
      if (tiles.size <= 30) break;
    }
    const cache = {};
    await Promise.all([...tiles].map((key) => new Promise((resolve) => {
      const [x, y] = key.split("/");
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const cv = document.createElement("canvas"); cv.width = cv.height = 256;
          const ctx = cv.getContext("2d", { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          cache[key] = ctx.getImageData(0, 0, 256, 256).data;
        } catch { /* CORS 失敗 */ }
        resolve();
      };
      img.onerror = () => resolve();
      img.src = TERRAIN.replace("{z}", z).replace("{x}", x).replace("{y}", y);
    })));
    const out = pts.map(([lng, lat]) => {
      const fx = lng2x(lng, z), fy = lat2y(lat, z);
      const d = cache[`${Math.floor(fx)}/${Math.floor(fy)}`];
      if (!d) return null;
      const px = Math.min(255, Math.floor((fx % 1) * 256)), py = Math.min(255, Math.floor((fy % 1) * 256));
      const j = (py * 256 + px) * 4;
      return d[j] * 256 + d[j + 1] + d[j + 2] / 256 - 32768;
    });
    if (out.filter((v) => v == null).length > out.length / 3) return null;
    // 補洞
    for (let i = 0; i < out.length; i++) if (out[i] == null) out[i] = out[i - 1] ?? out.find((v) => v != null);
    // 輕微平滑，避免 DEM 雜訊讓累積爬升偏高
    const sm = out.map((_, i) => {
      let s = 0, n = 0;
      for (let k = -2; k <= 2; k++) { const v = out[i + k]; if (v != null) { s += v; n++; } }
      return s / n;
    });
    return sm;
  }

  function profileStats(ele) {
    let gain = 0, ref = ele[0];
    for (const v of ele) { // 3 公尺門檻
      if (v > ref + 3) { gain += v - ref; ref = v; } else if (v < ref - 3) ref = v;
    }
    return { gain, max: Math.max(...ele), min: Math.min(...ele) };
  }

  // ---------- 介面 ----------
  let ui, map, run;

  function buildUi() {
    const el = document.createElement("div");
    el.className = "fly";
    el.hidden = true;
    el.innerHTML = `
      <div class="fly-map" id="flyMap"></div>
      <div class="fly-top">
        <div class="fly-title">
          <i class="dot"></i>
          <div><b></b><span class="muted"></span></div>
        </div>
        <div class="fly-tools">
          <button class="fly-chip" data-act="base" type="button"></button>
          <button class="icon-btn fly-close" data-act="close" type="button" aria-label="關閉鳥瞰">
            <svg viewBox="0 0 24 24" width="22" height="22"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>
      </div>
      <div class="fly-loading">載入地形中…</div>
      <div class="fly-bottom">
        <div class="fly-stats">
          <div><b data-v="dist">0.0</b><span>公里</span></div>
          <div><b data-v="ele">—</b><span>海拔 m</span></div>
          <div><b data-v="gain">—</b><span>累積爬升 m</span></div>
        </div>
        <div class="fly-scrub" role="slider" aria-label="播放進度" tabindex="0" aria-valuemin="0" aria-valuemax="100">
          <svg preserveAspectRatio="none" viewBox="0 0 1000 100"><path class="area"/><path class="line"/></svg>
          <div class="fly-done"></div>
          <div class="fly-cursor"></div>
        </div>
        <div class="fly-ctrl">
          <button class="fly-play" data-act="play" type="button" aria-label="播放"></button>
          <div class="seg fly-speed" role="radiogroup" aria-label="播放速度"></div>
          <button class="fly-chip" data-act="follow" type="button">重設視角</button>
        </div>
      </div>`;
    document.body.appendChild(el);
    const q = (s) => el.querySelector(s);
    ui = {
      el, q, title: q(".fly-title b"), sub: q(".fly-title span"), dot: q(".fly-title .dot"),
      loading: q(".fly-loading"), play: q(".fly-play"), base: q('[data-act="base"]'), follow: q('[data-act="follow"]'),
      scrub: q(".fly-scrub"), area: q(".fly-scrub .area"), line: q(".fly-scrub .line"),
      done: q(".fly-done"), cursor: q(".fly-cursor"), speed: q(".fly-speed"),
      dist: q('[data-v="dist"]'), ele: q('[data-v="ele"]'), gain: q('[data-v="gain"]'),
    };
    el.addEventListener("click", (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      if (act === "close") close();
      else if (act === "play") togglePlay();
      else if (act === "base") setBase(run.base === "sat" ? "map" : "sat");
      else if (act === "follow") { resetView(); frameCamera(true); }
    });
    // 拖曳進度
    const seek = (e) => {
      const r = ui.scrub.getBoundingClientRect();
      const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      run.d = f * run.path.total; run.done = false;
      render(true);
    };
    ui.scrub.addEventListener("pointerdown", (e) => {
      if (!run) return;
      ui.scrub.setPointerCapture(e.pointerId); seek(e);
      const mv = (ev) => seek(ev);
      const up = () => { ui.scrub.removeEventListener("pointermove", mv); ui.scrub.removeEventListener("pointerup", up); };
      ui.scrub.addEventListener("pointermove", mv); ui.scrub.addEventListener("pointerup", up);
    });
    ui.scrub.addEventListener("keydown", (e) => {
      if (!run) return;
      const step = run.path.total / 50;
      if (e.key === "ArrowRight") { run.d = Math.min(run.path.total, run.d + step); render(true); e.preventDefault(); }
      if (e.key === "ArrowLeft") { run.d = Math.max(0, run.d - step); run.done = false; render(true); e.preventDefault(); }
    });
    document.addEventListener("keydown", (e) => {
      if (el.hidden) return;
      if (e.key === "Escape") close();
      else if (e.key === " " && e.target === document.body) { togglePlay(); e.preventDefault(); }
    });
  }

  function buildSpeeds() {
    ui.speed.innerHTML = "";
    for (const s of SPEEDS) {
      const b = document.createElement("button");
      b.type = "button"; b.textContent = s + "×"; b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(run.speed === s));
      b.onclick = () => { run.speed = s; store.set("flySpeed", s); buildSpeeds(); };
      ui.speed.appendChild(b);
    }
  }

  function setPlayIcon() {
    const playing = run && run.playing;
    ui.play.setAttribute("aria-label", playing ? "暫停" : run && run.done ? "重播" : "播放");
    ui.play.innerHTML = playing
      ? '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor"/></svg>'
      : run && run.done
        ? '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M12 5a7 7 0 1 1-6.6 4.7" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round"/><path d="M4 4v6h6" stroke="currentColor" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg viewBox="0 0 24 24" width="22" height="22"><path d="M8 5l11 7-11 7z" fill="currentColor"/></svg>';
  }

  function setBase(name) {
    run.base = name; store.set("flyBase", name);
    ui.base.textContent = name === "sat" ? "衛星" : "地圖";
    ui.base.setAttribute("aria-label", `底圖：${ui.base.textContent}（點擊切換）`);
    if (!map) return;
    map.setLayoutProperty("sat", "visibility", name === "sat" ? "visible" : "none");
    map.setLayoutProperty("osm", "visibility", name === "map" ? "visible" : "none");
    map.setPaintProperty("hillshade", "hillshade-exaggeration", name === "map" ? 0.45 : 0.15);
  }

  function style() {
    return {
      version: 8,
      sources: {
        sat: { type: "raster", tiles: [SAT], tileSize: 256, maxzoom: 18, attribution: "Imagery &copy; Esri" },
        osm: { type: "raster", tiles: [OSM], tileSize: 256, maxzoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' },
        dem: { type: "raster-dem", tiles: [TERRAIN], encoding: "terrarium", tileSize: 256, maxzoom: 15, attribution: '地形 <a href="https://registry.opendata.aws/terrain-tiles/">AWS Terrain Tiles</a>' },
        hs: { type: "raster-dem", tiles: [TERRAIN], encoding: "terrarium", tileSize: 256, maxzoom: 15 },
      },
      layers: [
        { id: "bg", type: "background", paint: { "background-color": "#20262d" } },
        { id: "sat", type: "raster", source: "sat", paint: { "raster-saturation": -0.1, "raster-contrast": 0.05 } },
        { id: "osm", type: "raster", source: "osm", layout: { visibility: "none" }, paint: { "raster-saturation": -0.35 } },
        { id: "hillshade", type: "hillshade", source: "hs", paint: { "hillshade-exaggeration": 0.15, "hillshade-shadow-color": "#1a1d21" } },
      ],
      terrain: { source: "dem", exaggeration: EXAGGERATION },
      sky: {
        "sky-color": "#6fa3d8", "horizon-color": "#d7e4ef", "fog-color": "#cfdbe6",
        "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.6, "fog-ground-blend": 0.75, "atmosphere-blend": 0.6,
      },
    };
  }

  function addRouteLayers(color) {
    map.addSource("route", { type: "geojson", data: line(run.path.coords) });
    map.addSource("done", { type: "geojson", data: line([run.path.coords[0], run.path.coords[0]]) });
    map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#000", "line-opacity": 0.35, "line-width": 7, "line-blur": 2 } });
    map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": "#ffffff", "line-opacity": 0.7, "line-width": 3 } });
    map.addLayer({ id: "done", type: "line", source: "done", layout: { "line-join": "round", "line-cap": "round" },
      paint: { "line-color": color, "line-width": 5 } });
  }
  const line = (coords) => ({ type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } });

  // ---------- 播放 ----------
  function cameraZoom(total) {
    const km = total / 1000;
    return km < 3 ? 15.8 : km < 8 ? 15.2 : km < 20 ? 14.6 : km < 60 ? 14 : 13.4;
  }

  function frameCamera(instant) {
    const { path } = run;
    const look = Math.max(60, Math.min(500, path.total * 0.03));
    const here = locate(path, run.d).p;
    const back = locate(path, run.d - look * 0.5).p, ahead = locate(path, run.d + look).p;
    const target = dist(back, ahead) > 5 ? bearing(back, ahead) : run.bearing;
    if (instant || run.bearing == null) run.bearing = target;
    else run.bearing += wrap180(target - run.bearing) * run.smooth;
    absorbUserCamera();
    map.jumpTo(camera(here));
    const c = map.getCenter();
    run.lastCam = { here, routeBearing: run.bearing, center: [c.lng, c.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch() };
  }

  function render(instant) {
    const { path } = run;
    const { i, p } = locate(path, run.d);
    if (run.ready) {
      map.getSource("done").setData(line([...path.coords.slice(0, i + 1), p]));
      run.marker.setLngLat(p);
      frameCamera(instant);
    }
    const f = run.d / path.total;
    ui.done.style.width = f * 100 + "%";
    ui.cursor.style.left = f * 100 + "%";
    ui.scrub.setAttribute("aria-valuenow", Math.round(f * 100));
    ui.dist.textContent = ((run.km || path.total / 1000) * f).toFixed(1);
    if (run.ele) {
      const k = Math.min(run.ele.length - 1, Math.round(f * (run.ele.length - 1)));
      ui.ele.textContent = Math.round(run.ele[k]).toLocaleString();
    }
  }

  function tick(now) {
    if (!run || !run.playing) return;
    const dt = Math.min(0.25, (now - (run.last || now)) / 1000);
    run.last = now;
    run.smooth = 1 - Math.exp(-dt / 0.9);
    run.d += (run.path.total / run.duration) * run.speed * dt;
    if (run.d >= run.path.total) {
      run.d = run.path.total; render(); finish(); return;
    }
    render();
    run.raf = requestAnimationFrame(tick);
  }

  function togglePlay() {
    if (!run || !run.ready) return;
    if (run.playing) { pause(); return; }
    if (run.done) { run.d = 0; run.done = false; run.bearing = null; }
    const start = () => { run.playing = true; run.last = 0; setPlayIcon(); run.raf = requestAnimationFrame(tick); };
    // 從總覽畫面切入起點
    if (run.d === 0) {
      const b0 = bearing(run.path.coords[0], locate(run.path, Math.min(run.path.total, 300)).p);
      run.bearing = b0;
      map.flyTo({ ...camera(run.path.coords[0]), duration: 2600, essential: true });
      run.playing = true; setPlayIcon();
      map.once("moveend", () => { if (run && run.playing) { run.playing = false; start(); } });
    } else start();
  }

  function pause() {
    run.playing = false; cancelAnimationFrame(run.raf); setPlayIcon();
  }

  function finish() {
    run.playing = false; run.done = true; run.lastCam = null; setPlayIcon();
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    map.fitBounds(bounds(run.path.coords), { padding: pad(), pitch: 50, bearing: run.bearing || 0, duration: 3000, essential: true });
  }

  // 跟隨時讓目前位置落在下方控制列之上、畫面偏下處，前方視野較多
  // 鏡頭 = 目前位置 + 使用者調整的偏移（位置、方位、俯角、遠近），播放／暫停時都可以用手勢調整
  const DEFAULT_PITCH = 62;
  function camera(here) {
    return {
      center: [here[0] + run.offset[0], here[1] + run.offset[1]],
      bearing: run.bearing + run.bearingOffset, pitch: run.pitch, zoom: run.zoom, padding: followPad(),
    };
  }
  function resetView() {
    run.offset = [0, 0]; run.bearingOffset = 0; run.pitch = DEFAULT_PITCH; run.zoom = run.zoom0; run.lastCam = null;
    ui.follow.hidden = true;
  }
  // 上一格鏡頭和目前地圖狀態不同 → 是使用者用手勢（拖曳、旋轉、滾輪、雙指）調整的，把差異記成偏移
  function absorbUserCamera() {
    const L = run.lastCam;
    if (!L) return;
    const c = map.getCenter(), z = map.getZoom(), b = map.getBearing(), p = map.getPitch();
    const moved = Math.abs(c.lng - L.center[0]) > 1e-7 || Math.abs(c.lat - L.center[1]) > 1e-7 ||
      Math.abs(z - L.zoom) > 1e-4 || Math.abs(wrap180(b - L.bearing)) > 0.01 || Math.abs(p - L.pitch) > 0.01;
    if (!moved) return;
    run.offset = [c.lng - L.here[0], c.lat - L.here[1]];
    run.bearingOffset = wrap180(b - L.routeBearing);
    run.pitch = p; run.zoom = z;
    ui.follow.hidden = false;
  }

  function followPad() {
    const h = ui.q(".fly-bottom").getBoundingClientRect().height;
    return { top: Math.round(window.innerHeight * 0.18), bottom: Math.round(h + 20), left: 0, right: 0 };
  }

  function pad() {
    const narrow = window.innerWidth <= 640;
    return narrow ? { top: 90, bottom: 210, left: 30, right: 30 } : { top: 100, bottom: 200, left: 80, right: 80 };
  }

  function drawProfile(ele) {
    const lo = Math.min(...ele), hi = Math.max(...ele), span = Math.max(30, hi - lo);
    const pts = ele.map((v, i) => [(i / (ele.length - 1)) * 1000, 95 - ((v - lo) / span) * 85]);
    const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    ui.line.setAttribute("d", d);
    ui.area.setAttribute("d", `${d}L1000,100L0,100Z`);
  }

  // ---------- 開啟／關閉 ----------
  async function open(track) {
    if (!track || !track.pts || track.pts.length < 2) return;
    if (!ui) buildUi();
    if (run) teardown();
    const path = buildPath(track.pts);
    if (path.total < 50) return;
    const color = SPORT_COLORS[track.sport] || "#ff6a2b";
    const km = track.km || path.total / 1000;
    run = {
      track, path, km, zoom: cameraZoom(path.total), zoom0: cameraZoom(path.total), d: 0,
      offset: [0, 0], bearingOffset: 0, pitch: DEFAULT_PITCH, speed: +store.get("flySpeed", 1) || 1,
      duration: Math.max(25, Math.min(120, 22 + km * 1.3)), playing: false, done: false,
      base: store.get("flyBase", "sat") === "map" ? "map" : "sat", bearing: null, smooth: 0.05,
    };
    if (!SPEEDS.includes(run.speed)) run.speed = 1;
    ui.el.hidden = false;
    document.body.classList.add("flying");
    ui.dot.style.background = color;
    ui.el.style.setProperty("--fly", color);
    ui.title.textContent = `${SPORT_NAMES[track.sport] || "活動"} · ${km.toFixed(1)} 公里`;
    ui.sub.textContent = track.date || "";
    ui.loading.hidden = false; ui.loading.textContent = "載入地形中…";
    ui.ele.textContent = "—"; ui.gain.textContent = "—"; ui.dist.textContent = "0.0";
    ui.line.removeAttribute("d"); ui.area.removeAttribute("d");
    ui.follow.hidden = true;
    setBase(run.base); buildSpeeds(); setPlayIcon();

    const me = run;
    elevationProfile(path, 240).then((ele) => {
      if (run !== me || !ele) return;
      run.ele = ele;
      drawProfile(ele);
      ui.gain.textContent = Math.round(profileStats(ele).gain).toLocaleString();
      render(!run.playing);
    }).catch(() => {});

    try { await loadLib(); } catch (e) { ui.loading.textContent = e.message; return; }
    if (run !== me) return;

    map = new maplibregl.Map({
      container: ui.q("#flyMap"), style: style(), center: path.coords[0], zoom: 12, maxPitch: 80,
      attributionControl: false, fadeDuration: 0,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "top-right");

    const init = () => {
      if (run !== me || run.ready) return;
      setBase(run.base);
      addRouteLayers(color);
      const dot = document.createElement("div");
      dot.className = "fly-head";
      run.marker = new maplibregl.Marker({ element: dot }).setLngLat(path.coords[0]).addTo(map);
      map.fitBounds(bounds(path.coords), { padding: pad(), pitch: 50, duration: 0 });
      run.ready = true;
      // 等畫面圖磚載完（最多 5 秒）再自動開始
      let started = false;
      const go = () => {
        if (started || run !== me) return;
        started = true;
        ui.loading.hidden = true;
        setTimeout(() => { if (run === me && !run.playing && run.d === 0) togglePlay(); }, 600);
      };
      map.once("idle", go);
      setTimeout(go, 5000);
    };
    if (map.isStyleLoaded()) init(); else map.once("style.load", init);
    map.once("load", init);
    map.on("error", (e) => { if (!e?.tile) console.warn("flyover", e?.error?.message || e); if (/dem|terrain/i.test(e?.sourceId || "")) ui.loading.textContent = "地形載入失敗"; });
  }

  function teardown() {
    if (!run) return;
    cancelAnimationFrame(run.raf);
    run = null;
    if (map) { map.remove(); map = null; }
  }

  function close() {
    teardown();
    if (ui) ui.el.hidden = true;
    document.body.classList.remove("flying");
    if (typeof Flyover.onclose === "function") Flyover.onclose();
  }

  const Flyover = { open, close, isOpen: () => !!run, onclose: null };
  window.Flyover = Flyover;
})();
