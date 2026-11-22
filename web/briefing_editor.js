(() => {
  "use strict";

  // Dedicated account-independent local storage for user-authored briefings.
  // Intentionally separated from StudyDB (user accounts / cloud DB sync) so
  // briefings remain visible regardless of which ID logs in.
  const BRIEFING_IDB_NAME = "GarisaStudySharedBriefings";
  const BRIEFING_IDB_VERSION = 1;
  const BRIEFING_STORE = "briefings";
  const BRIEFING_LS_KEY = "garisastudy_shared_briefings_v1";
  const CLOUD_CONFIG_PREFIX = "garisastudy_cloud_v1_";
  const SHARED_CLOUD_USER_KEY = "__shared_briefings__";
  const SHARED_GIST_FILENAME = "garisastudy_shared_briefings.json";
  const SHARED_GIST_ID_KEY = "garisastudy_shared_briefing_gist_id_v1";

  const FONT_SIZES = [
    { label: "작게 (12px)", px: "12px" },
    { label: "보통 (15px)", px: "15px" },
    { label: "조금 크게 (18px)", px: "18px" },
    { label: "크게 (22px)", px: "22px" },
    { label: "제목 (26px)", px: "26px" },
  ];

  const TEXT_COLORS = [
    { label: "기본", value: "" },
    { label: "빨강", value: "#f87171" },
    { label: "주황", value: "#fb923c" },
    { label: "노랑", value: "#facc15" },
    { label: "초록", value: "#4ade80" },
    { label: "파랑", value: "#60a5fa" },
    { label: "보라", value: "#c084fc" },
    { label: "회색", value: "#9ca3af" },
  ];

  const HIGHLIGHT_COLORS = [
    { label: "없음", value: "transparent" },
    { label: "노랑", value: "rgba(250, 204, 21, 0.28)" },
    { label: "초록", value: "rgba(74, 222, 128, 0.24)" },
    { label: "파랑", value: "rgba(96, 165, 250, 0.26)" },
    { label: "빨강", value: "rgba(248, 113, 113, 0.26)" },
    { label: "보라", value: "rgba(192, 132, 252, 0.26)" },
  ];

  let idbPromise = null;
  let cache = {}; // { [topicCode]: { topicCode, html, updatedAt } }
  let storageMode = "local"; // "file" | "cloud" | "local"
  let activeInstance = null;

  function openIDB() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve) => {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      try {
        const req = indexedDB.open(BRIEFING_IDB_NAME, BRIEFING_IDB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(BRIEFING_STORE)) {
            db.createObjectStore(BRIEFING_STORE, { keyPath: "topicCode" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return idbPromise;
  }

  async function idbGetAll() {
    const db = await openIDB();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(BRIEFING_STORE, "readonly");
        const req = tx.objectStore(BRIEFING_STORE).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  async function idbPut(record) {
    const db = await openIDB();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(BRIEFING_STORE, "readwrite");
        tx.objectStore(BRIEFING_STORE).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  async function idbDelete(topicCode) {
    const db = await openIDB();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(BRIEFING_STORE, "readwrite");
        tx.objectStore(BRIEFING_STORE).delete(topicCode);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  function readLocalStorageMirror() {
    try {
      const raw = localStorage.getItem(BRIEFING_LS_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeLocalStorageMirror() {
    try {
      localStorage.setItem(BRIEFING_LS_KEY, JSON.stringify(cache));
    } catch {
      // If images exceed localStorage 5MB quota, file server / IndexedDB still persists everything.
    }
  }

  // Find any existing cloud sync config on this device (account-independent)
  function findAnyCloudConfig() {
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(CLOUD_CONFIG_PREFIX)) continue;
        const raw = localStorage.getItem(key);
        if (!raw) continue;
        const cfg = JSON.parse(raw);
        if (cfg && (cfg.provider === "supabase" || cfg.provider === "gist")) {
          if (cfg.provider === "supabase" && cfg.supabaseUrl && cfg.supabaseKey) return cfg;
          if (cfg.provider === "gist" && cfg.githubToken) return cfg;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  async function pullFromSharedCloud(cfg) {
    if (!cfg) return null;
    if (cfg.provider === "supabase") {
      const base = String(cfg.supabaseUrl || "").trim().replace(/\/+$/, "");
      const key = String(cfg.supabaseKey || "").trim();
      const table = String(cfg.supabaseTable || "study_sync").trim();
      const url = `${base}/rest/v1/${encodeURIComponent(table)}?user_id=eq.${encodeURIComponent(SHARED_CLOUD_USER_KEY)}&select=payload`;
      const resp = await fetch(url, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      });
      if (!resp.ok) return null;
      const rows = await resp.json();
      if (!Array.isArray(rows) || rows.length === 0) return {};
      const payload = rows[0]?.payload;
      return payload && typeof payload.briefings === "object" ? payload.briefings : {};
    }
    if (cfg.provider === "gist") {
      const token = String(cfg.githubToken || "").trim();
      let gistId = "";
      try {
        gistId = localStorage.getItem(SHARED_GIST_ID_KEY) || "";
      } catch {
        // ignore
      }
      if (!gistId) {
        const listResp = await fetch("https://api.github.com/gists?per_page=100", {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
        });
        if (!listResp.ok) return null;
        const gists = await listResp.json();
        const found = Array.isArray(gists) && gists.find((g) => g.files && g.files[SHARED_GIST_FILENAME]);
        if (found) {
          gistId = found.id;
          try {
            localStorage.setItem(SHARED_GIST_ID_KEY, gistId);
          } catch {
            // ignore
          }
        }
      }
      if (!gistId) return {};
      const resp = await fetch(`https://api.github.com/gists/${gistId}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
      });
      if (!resp.ok) return null;
      const gist = await resp.json();
      const file = gist.files && gist.files[SHARED_GIST_FILENAME];
      if (!file || !file.content) return {};
      const parsed = JSON.parse(file.content);
      return parsed && typeof parsed.briefings === "object" ? parsed.briefings : parsed;
    }
    return null;
  }

  async function pushToSharedCloud(cfg, briefingsMap) {
    if (!cfg) return false;
    const payload = { briefings: briefingsMap, updatedAt: Date.now() };
    if (cfg.provider === "supabase") {
      const base = String(cfg.supabaseUrl || "").trim().replace(/\/+$/, "");
      const key = String(cfg.supabaseKey || "").trim();
      const table = String(cfg.supabaseTable || "study_sync").trim();
      const url = `${base}/rest/v1/${encodeURIComponent(table)}?on_conflict=user_id`;
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify({
          user_id: SHARED_CLOUD_USER_KEY,
          payload,
          updated_at: new Date().toISOString(),
        }),
      });
      return resp.ok;
    }
    if (cfg.provider === "gist") {
      const token = String(cfg.githubToken || "").trim();
      let gistId = "";
      try {
        gistId = localStorage.getItem(SHARED_GIST_ID_KEY) || "";
      } catch {
        // ignore
      }
      const url = gistId ? `https://api.github.com/gists/${gistId}` : "https://api.github.com/gists";
      const resp = await fetch(url, {
        method: gistId ? "PATCH" : "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          description: "GarisaStudy Shared Briefings (All Accounts)",
          public: false,
          files: { [SHARED_GIST_FILENAME]: { content: JSON.stringify(payload) } },
        }),
      });
      if (!resp.ok) return false;
      const saved = await resp.json();
      if (saved && saved.id) {
        try {
          localStorage.setItem(SHARED_GIST_ID_KEY, saved.id);
        } catch {
          // ignore
        }
      }
      return true;
    }
    return false;
  }

  function mergeIntoMap(target, source) {
    if (!source || typeof source !== "object") return;
    Object.entries(source).forEach(([code, rec]) => {
      if (!code || !rec || typeof rec !== "object" || typeof rec.html !== "string") return;
      const ts = Number(rec.updatedAt) || 0;
      const prev = target[code];
      if (!prev || ts >= (Number(prev.updatedAt) || 0)) {
        target[code] = { topicCode: code, html: rec.html, updatedAt: ts };
      }
    });
  }

  async function tryFetchFileServerBriefings() {
    try {
      const resp = await fetch(`./api/briefings?t=${Date.now()}`, { cache: "no-store" });
      if (!resp.ok) return { available: false, data: null };
      const ct = resp.headers.get("content-type") || "";
      if (!ct.includes("application/json")) return { available: false, data: null };
      const json = await resp.json();
      if (json && json.ok && typeof json.briefings === "object") {
        return { available: true, data: json.briefings };
      }
    } catch {
      // Not running on serve_web.py
    }
    return { available: false, data: null };
  }

  async function tryFetchStaticBriefingsJson() {
    try {
      const resp = await fetch(`./data/user_briefings.json?t=${Date.now()}`, { cache: "no-store" });
      if (!resp.ok) return null;
      const json = await resp.json();
      return json && typeof json === "object" ? json : null;
    } catch {
      return null;
    }
  }

  async function initStorage() {
    const merged = {};
    mergeIntoMap(merged, readLocalStorageMirror());
    const idbList = await idbGetAll();
    idbList.forEach((rec) => {
      if (rec && rec.topicCode) mergeIntoMap(merged, { [rec.topicCode]: rec });
    });

    // 1. Check zero-token local file server (start.bat -> scripts/serve_web.py)
    const serverRes = await tryFetchFileServerBriefings();
    if (serverRes.available) {
      storageMode = "file";
      // File on PC is the shared source of truth across PC & mobile
      cache = {};
      mergeIntoMap(cache, serverRes.data);
      writeLocalStorageMirror();
      return cache;
    }

    // 2. Static host (e.g., GitHub Pages): load committed web/data/user_briefings.json
    const staticData = await tryFetchStaticBriefingsJson();
    if (staticData) {
      mergeIntoMap(merged, staticData);
    }

    // 3. If an existing cloud sync config (Supabase/Gist) is present, also pull shared slot
    const cloudCfg = findAnyCloudConfig();
    if (cloudCfg) {
      try {
        const cloudData = await pullFromSharedCloud(cloudCfg);
        if (cloudData) {
          storageMode = "cloud";
          mergeIntoMap(merged, cloudData);
        }
      } catch {
        // Fallback to local
      }
    }

    cache = merged;
    writeLocalStorageMirror();
    return cache;
  }

  async function refreshFromRemote() {
    if (storageMode === "file") {
      const serverRes = await tryFetchFileServerBriefings();
      if (serverRes.available && serverRes.data) {
        cache = {};
        mergeIntoMap(cache, serverRes.data);
        writeLocalStorageMirror();
        return true;
      }
    } else {
      const cloudCfg = findAnyCloudConfig();
      if (cloudCfg) {
        try {
          const cloudData = await pullFromSharedCloud(cloudCfg);
          if (cloudData) {
            storageMode = "cloud";
            mergeIntoMap(cache, cloudData);
            writeLocalStorageMirror();
            return true;
          }
        } catch {
          // ignore
        }
      }
    }
    return false;
  }

  function getStorageMode() {
    return storageMode;
  }

  function isHtmlEffectivelyEmpty(html) {
    if (!html) return true;
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    if (tmp.querySelector("img, table, hr")) return false;
    const text = (tmp.textContent || "").replace(/\u00a0|\u200b/g, "").trim();
    return text.length === 0;
  }

  function getBriefing(topicCode) {
    if (!topicCode) return null;
    const rec = cache[topicCode];
    if (!rec || isHtmlEffectivelyEmpty(rec.html)) return null;
    return rec;
  }

  function hasBriefing(topicCode) {
    return Boolean(getBriefing(topicCode));
  }

  async function saveBriefing(topicCode, html) {
    if (!topicCode) return { ok: false, mode: storageMode };
    const cleaned = String(html || "");
    const isEmpty = isHtmlEffectivelyEmpty(cleaned);
    const updatedAt = Date.now();

    if (isEmpty) {
      delete cache[topicCode];
      await idbDelete(topicCode);
    } else {
      const rec = { topicCode, html: cleaned, updatedAt };
      cache[topicCode] = rec;
      await idbPut(rec);
    }
    writeLocalStorageMirror();

    // Persist directly to web/data/user_briefings.json when running via start.bat (serve_web.py)
    if (storageMode === "file") {
      try {
        const resp = await fetch("./api/briefings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            topicCode,
            html: isEmpty ? "" : cleaned,
            empty: isEmpty,
            updatedAt,
          }),
        });
        if (resp.ok) {
          return { ok: true, mode: "file", empty: isEmpty, updatedAt };
        }
      } catch {
        // fall through
      }
    }

    // Or persist to shared cloud slot if existing Supabase/Gist sync is configured
    const cloudCfg = findAnyCloudConfig();
    if (cloudCfg) {
      try {
        const pushed = await pushToSharedCloud(cloudCfg, cache);
        if (pushed) {
          storageMode = "cloud";
          return { ok: true, mode: "cloud", empty: isEmpty, updatedAt };
        }
      } catch {
        // fall through to local
      }
    }

    return { ok: true, mode: "local", empty: isEmpty, updatedAt };
  }

  function exportAllBriefings() {
    const items = {};
    Object.entries(cache).forEach(([code, rec]) => {
      if (rec && !isHtmlEffectivelyEmpty(rec.html)) {
        items[code] = rec;
      }
    });
    return {
      format: "garisastudy_shared_briefings_v1",
      exportedAt: new Date().toISOString(),
      count: Object.keys(items).length,
      briefings: items,
    };
  }

  async function importAllBriefings(payload) {
    if (!payload || typeof payload !== "object") {
      throw new Error("올바른 브리핑 백업 JSON 형식이 아닙니다.");
    }
    const source = payload.briefings && typeof payload.briefings === "object" ? payload.briefings : payload;
    let importedCount = 0;
    for (const [code, rec] of Object.entries(source)) {
      if (!code || !rec || typeof rec.html !== "string") continue;
      if (isHtmlEffectivelyEmpty(rec.html)) continue;
      const entry = {
        topicCode: code,
        html: rec.html,
        updatedAt: Number(rec.updatedAt) || Date.now(),
      };
      cache[code] = entry;
      await idbPut(entry);
      importedCount += 1;
    }
    writeLocalStorageMirror();
    if (storageMode === "file") {
      try {
        await fetch("./api/briefings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ briefings: cache }),
        });
      } catch {
        // ignore
      }
    } else {
      const cloudCfg = findAnyCloudConfig();
      if (cloudCfg) {
        await pushToSharedCloud(cloudCfg, cache).catch(() => {});
      }
    }
    return importedCount;
  }

  function formatTimestamp(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Compress/resize uploaded or pasted images so storage stays fast & spacious
  function processImageFile(file) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type || !file.type.startsWith("image/")) {
        reject(new Error("이미지 파일만 삽입할 수 있습니다."));
        return;
      }
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
      reader.onload = () => {
        const dataUrl = reader.result;
        // Keep GIFs or small images (< 220KB) as-is to preserve animations/sharpness
        if (file.type === "image/gif" || file.size < 220 * 1024) {
          resolve(dataUrl);
          return;
        }
        const img = new Image();
        img.onerror = () => resolve(dataUrl);
        img.onload = () => {
          const maxDim = 1280;
          let { width, height } = img;
          if (width > maxDim || height > maxDim) {
            if (width >= height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }
          try {
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, width, height);
            const mime = file.type === "image/png" ? "image/png" : "image/jpeg";
            const quality = mime === "image/jpeg" ? 0.84 : undefined;
            const out = canvas.toDataURL(mime, quality);
            resolve(out.length < dataUrl.length ? out : dataUrl);
          } catch {
            resolve(dataUrl);
          }
        };
        img.src = dataUrl;
      };
      reader.readAsDataURL(file);
    });
  }

  function createTableHtml(rows, cols, withHeader = true) {
    const rCount = Math.max(1, Math.min(20, Number(rows) || 3));
    const cCount = Math.max(1, Math.min(12, Number(cols) || 3));
    let html = `<div class="be-table-wrap"><table class="be-table">`;
    if (withHeader) {
      html += "<thead><tr>";
      for (let c = 0; c < cCount; c += 1) {
        html += `<th>제목 ${c + 1}</th>`;
      }
      html += "</tr></thead>";
    }
    html += "<tbody>";
    const bodyRows = withHeader ? Math.max(1, rCount - 1) : rCount;
    for (let r = 0; r < bodyRows; r += 1) {
      html += "<tr>";
      for (let c = 0; c < cCount; c += 1) {
        html += "<td><br></td>";
      }
      html += "</tr>";
    }
    html += "</tbody></table></div><p><br></p>";
    return html;
  }

  function sanitizePastedHtml(rawHtml) {
    const tmp = document.createElement("div");
    tmp.innerHTML = rawHtml;
    tmp.querySelectorAll("script, style, meta, link, iframe, object, embed").forEach((n) => n.remove());
    tmp.querySelectorAll("*").forEach((el) => {
      // Strip inline colors/backgrounds from external pages so dark/light themes stay readable
      if (el.style) {
        el.style.removeProperty("color");
        el.style.removeProperty("background");
        el.style.removeProperty("background-color");
        el.style.removeProperty("font-family");
        if (!el.getAttribute("style")?.trim()) el.removeAttribute("style");
      }
      el.removeAttribute("class");
      el.removeAttribute("id");
    });
    return tmp.innerHTML;
  }

  function hasUnsavedChanges() {
    return Boolean(activeInstance && activeInstance.isDirty());
  }

  function confirmDiscardIfDirty() {
    if (!hasUnsavedChanges()) return true;
    return window.confirm("저장하지 않은 브리핑 내용이 있습니다. 저장하지 않고 이동할까요?");
  }

  function unmountActive() {
    if (activeInstance && typeof activeInstance.destroy === "function") {
      activeInstance.destroy();
    }
    activeInstance = null;
  }

  function mountEditor(container, options = {}) {
    if (!container) return null;
    unmountActive();

    const {
      topicCode,
      compact = false,
      onSaved = null,
      onOpenLightbox = null,
      onToast = null,
    } = options;

    const existing = getBriefing(topicCode);
    let savedHtml = existing ? existing.html : "";
    let lastUpdatedAt = existing ? existing.updatedAt : 0;
    let dirty = false;
    let savedRange = null;
    let selectedImg = null;
    let activeTableCell = null;

    const uid = `be_${Math.random().toString(36).slice(2, 8)}`;

    container.innerHTML = `
      <div class="be-root ${compact ? "is-compact" : ""}" data-topic-code="${topicCode || ""}">
        <div class="be-toolbar" role="toolbar" aria-label="브리핑 서식 도구">
          <div class="be-toolbar-group">
            <select class="be-select" data-be-role="fontSize" title="글자 크기" aria-label="글자 크기">
              <option value="">글자 크기</option>
              ${FONT_SIZES.map((s) => `<option value="${s.px}">${s.label}</option>`).join("")}
            </select>
          </div>

          <div class="be-toolbar-sep" aria-hidden="true"></div>

          <div class="be-toolbar-group">
            <button type="button" class="be-tool-btn" data-be-cmd="bold" title="굵게 (Ctrl+B)"><strong>B</strong></button>
            <button type="button" class="be-tool-btn" data-be-cmd="italic" title="기울임 (Ctrl+I)"><em>I</em></button>
            <button type="button" class="be-tool-btn" data-be-cmd="underline" title="밑줄 (Ctrl+U)"><u>U</u></button>
            <button type="button" class="be-tool-btn" data-be-cmd="strikeThrough" title="취소선"><s>S</s></button>
          </div>

          <div class="be-toolbar-sep" aria-hidden="true"></div>

          <div class="be-toolbar-group">
            <div class="be-popover-wrap">
              <button type="button" class="be-tool-btn" data-be-popover="textColor" title="글자 색상">
                <span class="be-color-icon">A</span>
              </button>
              <div class="be-popover hidden" data-be-panel="textColor">
                <div class="be-popover-title">글자 색상</div>
                <div class="be-swatch-grid">
                  ${TEXT_COLORS.map(
                    (c) => `
                    <button type="button" class="be-swatch-btn ${c.value === "" ? "is-reset" : ""}" data-be-forecolor="${c.value}" title="${c.label}">
                      <span class="be-swatch-dot" style="${c.value ? `background:${c.value}` : ""}"></span>
                    </button>`
                  ).join("")}
                </div>
              </div>
            </div>

            <div class="be-popover-wrap">
              <button type="button" class="be-tool-btn" data-be-popover="highlight" title="형광펜">
                <span class="be-hilite-icon">형</span>
              </button>
              <div class="be-popover hidden" data-be-panel="highlight">
                <div class="be-popover-title">형광펜</div>
                <div class="be-swatch-grid">
                  ${HIGHLIGHT_COLORS.map(
                    (c) => `
                    <button type="button" class="be-swatch-btn ${c.value === "transparent" ? "is-reset" : ""}" data-be-hilite="${c.value}" title="${c.label}">
                      <span class="be-swatch-dot" style="${c.value !== "transparent" ? `background:${c.value}` : ""}"></span>
                    </button>`
                  ).join("")}
                </div>
              </div>
            </div>
          </div>

          <div class="be-toolbar-sep" aria-hidden="true"></div>

          <div class="be-toolbar-group">
            <button type="button" class="be-tool-btn" data-be-cmd="insertUnorderedList" title="글머리 기호 목록">• 목록</button>
            <button type="button" class="be-tool-btn" data-be-cmd="insertOrderedList" title="번호 매기기 목록">1. 목록</button>
            <button type="button" class="be-tool-btn" data-be-action="callout" title="강조 메모 박스 삽입">강조박스</button>
            <button type="button" class="be-tool-btn" data-be-cmd="insertHorizontalRule" title="구분선 삽입">―</button>
          </div>

          <div class="be-toolbar-sep" aria-hidden="true"></div>

          <div class="be-toolbar-group">
            <div class="be-popover-wrap">
              <button type="button" class="be-tool-btn be-tool-accent" data-be-popover="table" title="표 삽입">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <line x1="3" y1="9" x2="21" y2="9"/>
                  <line x1="3" y1="15" x2="21" y2="15"/>
                  <line x1="9" y1="3" x2="9" y2="21"/>
                  <line x1="15" y1="3" x2="15" y2="21"/>
                </svg>
                <span>표</span>
              </button>
              <div class="be-popover be-table-popover hidden" data-be-panel="table">
                <div class="be-popover-title">표 삽입</div>
                <div class="be-table-inputs">
                  <label>
                    <span>행</span>
                    <input type="number" min="1" max="20" value="3" data-be-role="tableRows" />
                  </label>
                  <span class="be-times">×</span>
                  <label>
                    <span>열</span>
                    <input type="number" min="1" max="12" value="3" data-be-role="tableCols" />
                  </label>
                </div>
                <label class="be-table-check">
                  <input type="checkbox" checked data-be-role="tableHeader" />
                  <span>첫 줄 제목행(헤더) 사용</span>
                </label>
                <button type="button" class="be-popover-primary" data-be-action="insertTable">표 넣기</button>
              </div>
            </div>

            <button type="button" class="be-tool-btn be-tool-accent" data-be-action="pickImage" title="사진 삽입 (복사/붙여넣기, 드래그&드롭도 가능)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2"/>
                <circle cx="8.5" cy="8.5" r="1.5"/>
                <polyline points="21 15 16 10 5 21"/>
              </svg>
              <span>사진</span>
            </button>
            <input id="${uid}_imgInput" type="file" accept="image/*" multiple hidden />
          </div>

          <div class="be-toolbar-sep" aria-hidden="true"></div>

          <div class="be-toolbar-group">
            <button type="button" class="be-tool-btn" data-be-cmd="justifyLeft" title="왼쪽 정렬">좌</button>
            <button type="button" class="be-tool-btn" data-be-cmd="justifyCenter" title="가운데 정렬">중</button>
            <button type="button" class="be-tool-btn" data-be-cmd="justifyRight" title="오른쪽 정렬">우</button>
            <button type="button" class="be-tool-btn" data-be-cmd="undo" title="실행 취소 (Ctrl+Z)">↶</button>
            <button type="button" class="be-tool-btn" data-be-cmd="redo" title="다시 실행 (Ctrl+Y)">↷</button>
          </div>
        </div>

        <!-- Contextual Table Controls (shown when cursor is inside a table) -->
        <div class="be-context-bar hidden" data-be-role="tableContextBar">
          <span class="be-context-label">표 편집</span>
          <button type="button" class="be-ctx-btn" data-be-table="addRow">+ 행 추가</button>
          <button type="button" class="be-ctx-btn" data-be-table="addCol">+ 열 추가</button>
          <button type="button" class="be-ctx-btn" data-be-table="delRow">- 행 삭제</button>
          <button type="button" class="be-ctx-btn" data-be-table="delCol">- 열 삭제</button>
          <button type="button" class="be-ctx-btn is-danger" data-be-table="delTable">표 삭제</button>
        </div>

        <!-- Contextual Image Controls (shown when an image is clicked) -->
        <div class="be-context-bar hidden" data-be-role="imgContextBar">
          <span class="be-context-label">사진 크기</span>
          <button type="button" class="be-ctx-btn" data-be-img="35%">작게</button>
          <button type="button" class="be-ctx-btn" data-be-img="65%">보통</button>
          <button type="button" class="be-ctx-btn" data-be-img="100%">크게</button>
          <button type="button" class="be-ctx-btn" data-be-img="zoom">확대 보기</button>
          <button type="button" class="be-ctx-btn is-danger" data-be-img="delete">사진 삭제</button>
        </div>

        <div
          class="be-surface"
          contenteditable="true"
          spellcheck="false"
          data-be-role="surface"
          data-placeholder="여기에 나만의 브리핑을 자유롭게 작성하세요. (사진 복사·붙여넣기, 드래그&드롭, 표, 글자 크기 지원 · 작성 후 아래 저장 버튼 클릭)"
        ></div>

        <div class="be-save-bar">
          <div class="be-save-status" data-be-role="statusWrap">
            <span class="be-status-dot" data-be-role="statusDot"></span>
            <span class="be-status-text" data-be-role="statusText"></span>
          </div>
          <div class="be-save-actions">
            <button type="button" class="be-clear-btn" data-be-action="clear" title="이 토픽 브리핑 내용 비우기">초기화</button>
            ${
              storageMode === "file"
                ? `<button type="button" class="be-publish-btn" data-be-action="publishGit" title="작성한 브리핑 파일을 GitHub에 올려 외부 모바일(GitHub Pages)에도 반영">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                      <polyline points="17 8 12 3 7 8"/>
                      <line x1="12" y1="3" x2="12" y2="15"/>
                    </svg>
                    <span>Git에 올리기</span>
                  </button>`
                : ""
            }
            <button type="button" class="be-save-btn" data-be-action="save" title="브리핑 저장 (Ctrl+S)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                <polyline points="17 21 17 13 7 13 7 21"/>
                <polyline points="7 3 7 8 15 8"/>
              </svg>
              <span>저장</span>
            </button>
          </div>
        </div>
      </div>
    `;

    const root = container.querySelector(".be-root");
    const surface = root.querySelector('[data-be-role="surface"]');
    const fontSizeSelect = root.querySelector('[data-be-role="fontSize"]');
    const imgInput = root.querySelector(`#${uid}_imgInput`);
    const tableContextBar = root.querySelector('[data-be-role="tableContextBar"]');
    const imgContextBar = root.querySelector('[data-be-role="imgContextBar"]');
    const statusDot = root.querySelector('[data-be-role="statusDot"]');
    const statusText = root.querySelector('[data-be-role="statusText"]');
    const saveBtn = root.querySelector('[data-be-action="save"]');
    const publishBtn = root.querySelector('[data-be-action="publishGit"]');

    surface.innerHTML = savedHtml;

    function getModeHint() {
      if (storageMode === "file") return "공용 파일(user_briefings.json) · PC·모바일·모든 계정 공통";
      if (storageMode === "cloud") return "공용 클라우드 · PC·모바일·모든 계정 공통";
      return "이 기기 로컬 저장 (PC↔모바일 공유는 start.bat 또는 동기화 연결)";
    }

    function updateStatusUI() {
      if (dirty) {
        statusDot.className = "be-status-dot is-dirty";
        statusText.textContent = "수정됨 · 저장 버튼을 눌러 저장하세요 (Ctrl+S)";
        saveBtn.classList.add("is-dirty");
      } else if (lastUpdatedAt && !isHtmlEffectivelyEmpty(savedHtml)) {
        statusDot.className = "be-status-dot is-saved";
        statusText.textContent = `저장됨 (${formatTimestamp(lastUpdatedAt)}) · ${getModeHint()}`;
        saveBtn.classList.remove("is-dirty");
      } else {
        statusDot.className = "be-status-dot";
        statusText.textContent = `작성된 브리핑 없음 · ${getModeHint()}`;
        saveBtn.classList.remove("is-dirty");
      }
    }

    function markDirty() {
      if (!dirty) {
        dirty = true;
        updateStatusUI();
      }
    }

    function closeAllPopovers() {
      root.querySelectorAll(".be-popover").forEach((p) => p.classList.add("hidden"));
    }

    function saveSelection() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (surface.contains(range.commonAncestorContainer)) {
        savedRange = range.cloneRange();
      }
    }

    function restoreSelection() {
      surface.focus();
      if (!savedRange) {
        const range = document.createRange();
        range.selectNodeContents(surface);
        range.collapse(false);
        savedRange = range;
      }
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }

    function clearSelectedImg() {
      if (selectedImg) {
        selectedImg.classList.remove("is-selected");
        selectedImg = null;
      }
      imgContextBar.classList.add("hidden");
    }

    function updateContextBars() {
      const sel = window.getSelection();
      let node = sel && sel.rangeCount > 0 ? sel.anchorNode : null;
      if (node && node.nodeType === Node.TEXT_NODE) node = node.parentElement;
      const cell = node && surface.contains(node) ? node.closest("td, th") : null;
      activeTableCell = cell || null;
      tableContextBar.classList.toggle("hidden", !activeTableCell);
    }

    function applyFontSize(px) {
      if (!px) return;
      restoreSelection();
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) {
        // Use execCommand fontSize sentinel and convert <font size="7"> to clean <span style="font-size: px">
        document.execCommand("fontSize", false, "7");
        surface.querySelectorAll('font[size="7"]').forEach((fontEl) => {
          const span = document.createElement("span");
          span.style.fontSize = px;
          span.innerHTML = fontEl.innerHTML;
          fontEl.replaceWith(span);
        });
      } else {
        const span = document.createElement("span");
        span.style.fontSize = px;
        span.innerHTML = "\u200b";
        const range = sel.getRangeAt(0);
        range.insertNode(span);
        const nextRange = document.createRange();
        nextRange.setStart(span.firstChild, 1);
        nextRange.collapse(true);
        sel.removeAllRanges();
        sel.addRange(nextRange);
      }
      saveSelection();
      markDirty();
    }

    function insertHtmlAtCursor(html) {
      restoreSelection();
      document.execCommand("insertHTML", false, html);
      saveSelection();
      markDirty();
    }

    async function insertImages(fileList) {
      const files = Array.from(fileList || []).filter((f) => f && f.type && f.type.startsWith("image/"));
      if (files.length === 0) return;
      for (const file of files) {
        try {
          const dataUrl = await processImageFile(file);
          insertHtmlAtCursor(
            `<p><img class="be-img" src="${dataUrl}" alt="${(file.name || "이미지").replace(/"/g, "&quot;")}" style="width: 100%;" /></p><p><br></p>`
          );
        } catch (err) {
          if (onToast) onToast(err.message || "사진 삽입에 실패했습니다");
        }
      }
    }

    function handleTableAction(action) {
      if (!activeTableCell) return;
      const table = activeTableCell.closest("table");
      const row = activeTableCell.closest("tr");
      if (!table || !row) return;
      const colIdx = Array.from(row.children).indexOf(activeTableCell);

      if (action === "addRow") {
        const isHeader = row.parentElement?.tagName === "THEAD";
        const tbody = table.querySelector("tbody") || table;
        const newRow = document.createElement("tr");
        const cols = row.children.length || 1;
        for (let i = 0; i < cols; i += 1) {
          const td = document.createElement("td");
          td.innerHTML = "<br>";
          newRow.appendChild(td);
        }
        if (isHeader) {
          tbody.insertBefore(newRow, tbody.firstChild);
        } else {
          row.after(newRow);
        }
      } else if (action === "addCol") {
        table.querySelectorAll("tr").forEach((tr) => {
          const isTh = tr.parentElement?.tagName === "THEAD";
          const cell = document.createElement(isTh ? "th" : "td");
          cell.innerHTML = isTh ? "새 열" : "<br>";
          const refCell = tr.children[colIdx];
          if (refCell) refCell.after(cell);
          else tr.appendChild(cell);
        });
      } else if (action === "delRow") {
        const allRows = table.querySelectorAll("tr");
        if (allRows.length <= 1) {
          const wrap = table.closest(".be-table-wrap") || table;
          wrap.remove();
          activeTableCell = null;
          tableContextBar.classList.add("hidden");
        } else {
          row.remove();
          activeTableCell = null;
          tableContextBar.classList.add("hidden");
        }
      } else if (action === "delCol") {
        const cols = row.children.length;
        if (cols <= 1) {
          const wrap = table.closest(".be-table-wrap") || table;
          wrap.remove();
          activeTableCell = null;
          tableContextBar.classList.add("hidden");
        } else {
          table.querySelectorAll("tr").forEach((tr) => {
            if (tr.children[colIdx]) tr.children[colIdx].remove();
          });
          activeTableCell = null;
          tableContextBar.classList.add("hidden");
        }
      } else if (action === "delTable") {
        const wrap = table.closest(".be-table-wrap") || table;
        wrap.remove();
        activeTableCell = null;
        tableContextBar.classList.add("hidden");
      }
      markDirty();
    }

    async function performSave() {
      clearSelectedImg();
      const html = surface.innerHTML;
      const res = await saveBriefing(topicCode, html);
      savedHtml = res.empty ? "" : html;
      lastUpdatedAt = res.empty ? 0 : res.updatedAt;
      dirty = false;
      updateStatusUI();
      if (onToast) {
        if (res.empty) {
          onToast("빈 브리핑으로 저장되었습니다");
        } else if (res.mode === "file") {
          onToast("공용 파일에 저장됨 · PC와 모바일에서 바로 보입니다");
        } else if (res.mode === "cloud") {
          onToast("공용 클라우드에 저장됨 · PC와 모바일에서 바로 보입니다");
        } else {
          onToast("브리핑이 이 기기에 저장되었습니다");
        }
      }
      if (onSaved) onSaved(topicCode, res);
      return res;
    }

    // Event handlers
    const onSurfaceInput = () => {
      markDirty();
      saveSelection();
    };

    const onSurfaceKeyupOrMouseup = () => {
      saveSelection();
      updateContextBars();
    };

    const onSurfaceClick = (e) => {
      const img = e.target.closest("img");
      if (img && surface.contains(img)) {
        clearSelectedImg();
        selectedImg = img;
        selectedImg.classList.add("is-selected");
        imgContextBar.classList.remove("hidden");
      } else {
        clearSelectedImg();
      }
      saveSelection();
      updateContextBars();
    };

    const onSurfaceDblClick = (e) => {
      const img = e.target.closest("img");
      if (img && surface.contains(img) && onOpenLightbox) {
        onOpenLightbox(img.src);
      }
    };

    const onSurfacePaste = (e) => {
      const dt = e.clipboardData;
      if (!dt) return;
      const imageFiles = [];
      if (dt.items) {
        for (const item of dt.items) {
          if (item.kind === "file" && item.type.startsWith("image/")) {
            const f = item.getAsFile();
            if (f) imageFiles.push(f);
          }
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        saveSelection();
        insertImages(imageFiles);
        return;
      }
      const html = dt.getData("text/html");
      if (html) {
        e.preventDefault();
        const cleaned = sanitizePastedHtml(html);
        document.execCommand("insertHTML", false, cleaned);
        markDirty();
      }
    };

    const onSurfaceDragOver = (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files")) {
        e.preventDefault();
        surface.classList.add("is-dragover");
      }
    };

    const onSurfaceDragLeave = () => {
      surface.classList.remove("is-dragover");
    };

    const onSurfaceDrop = (e) => {
      surface.classList.remove("is-dragover");
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const imgs = Array.from(files).filter((f) => f.type.startsWith("image/"));
        if (imgs.length > 0) {
          e.preventDefault();
          saveSelection();
          insertImages(imgs);
        }
      }
    };

    const onRootClick = (e) => {
      // Command buttons
      const cmdBtn = e.target.closest("[data-be-cmd]");
      if (cmdBtn) {
        e.preventDefault();
        closeAllPopovers();
        restoreSelection();
        document.execCommand(cmdBtn.dataset.beCmd, false, null);
        saveSelection();
        markDirty();
        return;
      }

      // Popover toggles
      const popBtn = e.target.closest("[data-be-popover]");
      if (popBtn) {
        e.preventDefault();
        saveSelection();
        const targetName = popBtn.dataset.bePopover;
        const panel = root.querySelector(`[data-be-panel="${targetName}"]`);
        const wasHidden = panel ? panel.classList.contains("hidden") : true;
        closeAllPopovers();
        if (panel && wasHidden) {
          panel.classList.remove("hidden");
        }
        return;
      }

      // Text color swatch
      const foreBtn = e.target.closest("[data-be-forecolor]");
      if (foreBtn) {
        e.preventDefault();
        const val = foreBtn.dataset.beForecolor;
        closeAllPopovers();
        restoreSelection();
        if (!val) {
          document.execCommand("removeFormat", false, null);
        } else {
          document.execCommand("foreColor", false, val);
        }
        saveSelection();
        markDirty();
        return;
      }

      // Highlight swatch
      const hiBtn = e.target.closest("[data-be-hilite]");
      if (hiBtn) {
        e.preventDefault();
        const val = hiBtn.dataset.beHilite;
        closeAllPopovers();
        restoreSelection();
        document.execCommand("hiliteColor", false, val);
        saveSelection();
        markDirty();
        return;
      }

      // Custom actions
      const actBtn = e.target.closest("[data-be-action]");
      if (actBtn) {
        const action = actBtn.dataset.beAction;
        if (action === "callout") {
          e.preventDefault();
          closeAllPopovers();
          insertHtmlAtCursor(
            `<blockquote class="be-callout">핵심 포인트를 여기에 정리하세요.</blockquote><p><br></p>`
          );
        } else if (action === "insertTable") {
          e.preventDefault();
          const rVal = root.querySelector('[data-be-role="tableRows"]')?.value || 3;
          const cVal = root.querySelector('[data-be-role="tableCols"]')?.value || 3;
          const hasHead = Boolean(root.querySelector('[data-be-role="tableHeader"]')?.checked);
          closeAllPopovers();
          insertHtmlAtCursor(createTableHtml(rVal, cVal, hasHead));
        } else if (action === "pickImage") {
          e.preventDefault();
          closeAllPopovers();
          saveSelection();
          imgInput.value = "";
          imgInput.click();
        } else if (action === "save") {
          e.preventDefault();
          performSave();
        } else if (action === "publishGit") {
          e.preventDefault();
          if (!publishBtn || publishBtn.disabled) return;
          const labelSpan = publishBtn.querySelector("span");
          const prevLabel = labelSpan ? labelSpan.textContent : "Git에 올리기";
          publishBtn.disabled = true;
          if (labelSpan) labelSpan.textContent = "올리는 중...";
          (async () => {
            try {
              if (dirty) {
                await performSave();
              }
              const resp = await fetch("./api/briefings/publish", { method: "POST" });
              const data = await resp.json().catch(() => ({}));
              if (!resp.ok || !data.ok) {
                throw new Error(data.error || `Git 업로드 실패 (${resp.status})`);
              }
              if (onToast) onToast(data.message || "Git에 업로드했습니다");
            } catch (err) {
              if (onToast) onToast(err.message || "Git 업로드에 실패했습니다");
            } finally {
              publishBtn.disabled = false;
              if (labelSpan) labelSpan.textContent = prevLabel;
            }
          })();
        } else if (action === "clear") {
          e.preventDefault();
          if (isHtmlEffectivelyEmpty(surface.innerHTML) && !dirty) return;
          if (!window.confirm("이 토픽의 브리핑 내용을 모두 지울까요? (저장 버튼을 누르면 반영됩니다)")) {
            return;
          }
          clearSelectedImg();
          surface.innerHTML = "";
          markDirty();
          surface.focus();
        }
        return;
      }

      // Table contextual actions
      const tblBtn = e.target.closest("[data-be-table]");
      if (tblBtn) {
        e.preventDefault();
        handleTableAction(tblBtn.dataset.beTable);
        return;
      }

      // Image contextual actions
      const imgBtn = e.target.closest("[data-be-img]");
      if (imgBtn && selectedImg) {
        e.preventDefault();
        const mode = imgBtn.dataset.beImg;
        if (mode === "delete") {
          selectedImg.remove();
          clearSelectedImg();
          markDirty();
        } else if (mode === "zoom") {
          if (onOpenLightbox) onOpenLightbox(selectedImg.src);
        } else {
          selectedImg.style.width = mode;
          markDirty();
        }
        return;
      }
    };

    const onFontSizeChange = () => {
      const px = fontSizeSelect.value;
      if (px) {
        applyFontSize(px);
        fontSizeSelect.value = "";
      }
    };

    const onImgInputChange = () => {
      if (imgInput.files && imgInput.files.length > 0) {
        insertImages(imgInput.files);
      }
    };

    const onDocClick = (e) => {
      if (!e.target.closest(".be-popover-wrap")) {
        closeAllPopovers();
      }
    };

    const onKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        if (root.contains(document.activeElement) || !compact) {
          e.preventDefault();
          performSave();
        }
      }
    };

    const onRootMouseDown = (e) => {
      if (e.target.closest(".be-tool-btn, .be-ctx-btn, .be-swatch-btn")) {
        e.preventDefault();
      }
    };

    surface.addEventListener("input", onSurfaceInput);
    surface.addEventListener("keyup", onSurfaceKeyupOrMouseup);
    surface.addEventListener("mouseup", onSurfaceKeyupOrMouseup);
    surface.addEventListener("click", onSurfaceClick);
    surface.addEventListener("dblclick", onSurfaceDblClick);
    surface.addEventListener("paste", onSurfacePaste);
    surface.addEventListener("dragover", onSurfaceDragOver);
    surface.addEventListener("dragleave", onSurfaceDragLeave);
    surface.addEventListener("drop", onSurfaceDrop);
    root.addEventListener("mousedown", onRootMouseDown);
    root.addEventListener("click", onRootClick);
    fontSizeSelect.addEventListener("change", onFontSizeChange);
    imgInput.addEventListener("change", onImgInputChange);
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onKeyDown);

    updateStatusUI();

    let destroyed = false;
    const instance = {
      topicCode,
      isDirty: () => dirty,
      save: performSave,
      destroy: () => {
        destroyed = true;
        document.removeEventListener("click", onDocClick);
        document.removeEventListener("keydown", onKeyDown);
      },
    };
    activeInstance = instance;

    // Silently pull latest content from shared file server / cloud so edits on PC appear on mobile immediately
    if (storageMode === "file" || storageMode === "cloud") {
      refreshFromRemote().then((updated) => {
        if (!updated || destroyed || dirty) return;
        const latest = getBriefing(topicCode);
        const nextHtml = latest ? latest.html : "";
        const nextTs = latest ? latest.updatedAt : 0;
        if (nextHtml !== savedHtml || nextTs !== lastUpdatedAt) {
          savedHtml = nextHtml;
          lastUpdatedAt = nextTs;
          surface.innerHTML = savedHtml;
          updateStatusUI();
        }
      });
    }

    return instance;
  }

  window.BriefingEditor = {
    initStorage,
    refreshFromRemote,
    getStorageMode,
    getBriefing,
    hasBriefing,
    saveBriefing,
    exportAllBriefings,
    importAllBriefings,
    mountEditor,
    unmountActive,
    hasUnsavedChanges,
    confirmDiscardIfDirty,
  };
})();
