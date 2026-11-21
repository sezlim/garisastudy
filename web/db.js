(() => {
  "use strict";

  const DB_NAME = "GarisaStudyDB";
  const DB_VERSION = 1;
  const LEGACY_STORAGE_KEY = "ai_workspace_study_v1";
  const SESSION_KEY = "garisastudy_session_v1";
  const ACCOUNTS_FALLBACK_KEY = "garisastudy_accounts_v1";
  const STATE_FALLBACK_PREFIX = "garisastudy_state_v1_";
  const CLOUD_CONFIG_PREFIX = "garisastudy_cloud_v1_";

  let idbPromise = null;

  function openIDB() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise((resolve) => {
      if (typeof indexedDB === "undefined") {
        resolve(null);
        return;
      }
      try {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("accounts")) {
            db.createObjectStore("accounts", { keyPath: "username" });
          }
          if (!db.objectStoreNames.contains("states")) {
            db.createObjectStore("states", { keyPath: "username" });
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

  async function idbGet(storeName, key) {
    const db = await openIDB();
    if (!db) return null;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }

  async function idbGetAll(storeName) {
    const db = await openIDB();
    if (!db) return [];
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readonly");
        const req = tx.objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      } catch {
        resolve([]);
      }
    });
  }

  async function idbPut(storeName, value) {
    const db = await openIDB();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).put(value);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  async function idbDelete(storeName, key) {
    const db = await openIDB();
    if (!db) return false;
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(storeName, "readwrite");
        tx.objectStore(storeName).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
    });
  }

  async function hashPassword(username, password) {
    const raw = `garisastudy:${username.trim().toLowerCase()}:${password || ""}`;
    if (typeof crypto !== "undefined" && crypto.subtle && typeof TextEncoder !== "undefined") {
      try {
        const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
        return Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");
      } catch {
        // Fallback below for non-secure HTTP contexts
      }
    }
    let h = 2166136261;
    for (let i = 0; i < raw.length; i++) {
      h ^= raw.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return "fnv1a_" + (h >>> 0).toString(16);
  }

  function normalizeUsername(name) {
    return String(name || "").trim();
  }

  function readFallbackAccounts() {
    try {
      const raw = localStorage.getItem(ACCOUNTS_FALLBACK_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeFallbackAccounts(list) {
    try {
      localStorage.setItem(ACCOUNTS_FALLBACK_KEY, JSON.stringify(list));
    } catch {
      // ignore
    }
  }

  async function listAccounts() {
    const idbList = await idbGetAll("accounts");
    const fbList = readFallbackAccounts();
    const map = new Map();
    fbList.forEach((a) => {
      if (a && a.username) map.set(a.username, a);
    });
    idbList.forEach((a) => {
      if (a && a.username) map.set(a.username, a);
    });
    return Array.from(map.values()).sort((a, b) => (b.lastLoginAt || 0) - (a.lastLoginAt || 0));
  }

  async function getAccount(username) {
    const u = normalizeUsername(username);
    if (!u) return null;
    const rec = await idbGet("accounts", u);
    if (rec) return rec;
    return readFallbackAccounts().find((a) => a.username === u) || null;
  }

  async function saveAccount(acc) {
    await idbPut("accounts", acc);
    const list = readFallbackAccounts().filter((a) => a.username !== acc.username);
    list.push(acc);
    writeFallbackAccounts(list);
  }

  async function registerAccount(username, password) {
    const u = normalizeUsername(username);
    if (!u || u.length < 2) {
      return { ok: false, error: "아이디는 2글자 이상 입력하세요." };
    }
    const existing = await getAccount(u);
    if (existing) {
      return { ok: false, error: "이미 존재하는 아이디입니다. 로그인 탭에서 접속하세요." };
    }
    const passwordHash = await hashPassword(u, password || "");
    const now = Date.now();
    const acc = {
      username: u,
      passwordHash,
      hasPassword: Boolean(password && password.length > 0),
      createdAt: now,
      lastLoginAt: now,
    };
    await saveAccount(acc);

    // If legacy single-user state exists and this is the first account, migrate it seamlessly
    const all = await listAccounts();
    if (all.length === 1) {
      try {
        const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (legacyRaw) {
          const legacyData = JSON.parse(legacyRaw);
          if (legacyData && typeof legacyData === "object") {
            await saveUserState(u, legacyData);
          }
        }
      } catch {
        // ignore migration errors
      }
    }
    return { ok: true, account: acc };
  }

  async function loginAccount(username, password) {
    const u = normalizeUsername(username);
    if (!u) return { ok: false, error: "아이디를 입력하세요." };
    const acc = await getAccount(u);
    if (!acc) {
      return { ok: false, error: "등록되지 않은 아이디입니다. '새 계정 만들기'로 시작하세요." };
    }
    if (acc.hasPassword) {
      const h = await hashPassword(u, password || "");
      if (h !== acc.passwordHash) {
        return { ok: false, error: "비밀번호가 일치하지 않습니다." };
      }
    }
    acc.lastLoginAt = Date.now();
    await saveAccount(acc);
    return { ok: true, account: acc };
  }

  async function deleteAccount(username) {
    const u = normalizeUsername(username);
    await idbDelete("accounts", u);
    await idbDelete("states", u);
    const list = readFallbackAccounts().filter((a) => a.username !== u);
    writeFallbackAccounts(list);
    try {
      localStorage.removeItem(STATE_FALLBACK_PREFIX + u);
      localStorage.removeItem(CLOUD_CONFIG_PREFIX + u);
    } catch {
      // ignore
    }
  }

  function getSavedSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && parsed.username ? parsed : null;
    } catch {
      return null;
    }
  }

  function setSavedSession(username, remember = true) {
    try {
      if (!username || !remember) {
        localStorage.removeItem(SESSION_KEY);
      } else {
        localStorage.setItem(SESSION_KEY, JSON.stringify({ username, savedAt: Date.now() }));
      }
    } catch {
      // ignore
    }
  }

  async function loadUserState(username) {
    const u = normalizeUsername(username);
    if (!u) return null;
    let idbData = null;
    const row = await idbGet("states", u);
    if (row && row.data) idbData = row.data;

    let lsData = null;
    try {
      const raw = localStorage.getItem(STATE_FALLBACK_PREFIX + u);
      if (raw) lsData = JSON.parse(raw);
    } catch {
      lsData = null;
    }

    if (idbData && lsData) {
      return (idbData._updatedAt || 0) >= (lsData._updatedAt || 0) ? idbData : lsData;
    }
    return idbData || lsData || null;
  }

  async function saveUserState(username, data) {
    const u = normalizeUsername(username);
    if (!u || !data) return false;
    const stamped = { ...data, _updatedAt: Date.now() };
    await idbPut("states", { username: u, data: stamped, updatedAt: stamped._updatedAt });
    try {
      localStorage.setItem(STATE_FALLBACK_PREFIX + u, JSON.stringify(stamped));
    } catch {
      // localStorage quota exceeded — IndexedDB still succeeded
    }
    return true;
  }

  async function getAccountSummary(username) {
    const st = await loadUserState(username);
    if (!st) return { solved: 0, lastLabel: "" };
    const solved = Object.values(st.records || {}).filter((r) => r && r.selected != null).length;
    const lp = st.lastPosition;
    const lastLabel = lp && lp.yearRound ? `${lp.yearRound} ${lp.number}번` : "";
    return { solved, lastLabel };
  }

  // Cloud Sync Config per user
  function getCloudConfig(username) {
    const u = normalizeUsername(username);
    if (!u) return { provider: "none" };
    try {
      const raw = localStorage.getItem(CLOUD_CONFIG_PREFIX + u);
      if (!raw) return { provider: "none" };
      return { provider: "none", ...JSON.parse(raw) };
    } catch {
      return { provider: "none" };
    }
  }

  function saveCloudConfig(username, cfg) {
    const u = normalizeUsername(username);
    if (!u) return;
    try {
      localStorage.setItem(CLOUD_CONFIG_PREFIX + u, JSON.stringify(cfg || { provider: "none" }));
    } catch {
      // ignore
    }
  }

  // Merge two user states intelligently (newest per record/memo wins)
  function mergeStates(localState, remoteState) {
    if (!remoteState || typeof remoteState !== "object") return localState;
    if (!localState || typeof localState !== "object") return remoteState;

    const remoteNewer = (remoteState._updatedAt || 0) > (localState._updatedAt || 0);
    const mergedRecords = { ...(localState.records || {}) };
    Object.entries(remoteState.records || {}).forEach(([qid, rRec]) => {
      const lRec = mergedRecords[qid];
      if (!lRec || (rRec.updatedAt || 0) > (lRec.updatedAt || 0)) {
        mergedRecords[qid] = rRec;
      }
    });

    const mergedMemos = remoteNewer
      ? { ...(localState.memos || {}), ...(remoteState.memos || {}) }
      : { ...(remoteState.memos || {}), ...(localState.memos || {}) };

    const mergedCustomAnswers = remoteNewer
      ? { ...(localState.customAnswers || {}), ...(remoteState.customAnswers || {}) }
      : { ...(remoteState.customAnswers || {}), ...(localState.customAnswers || {}) };

    const mergedTrend = { ...(localState.trendChecked || {}), ...(remoteState.trendChecked || {}) };
    const mergedTopicLast = remoteNewer
      ? { ...(localState.topicLastQid || {}), ...(remoteState.topicLastQid || {}) }
      : { ...(remoteState.topicLastQid || {}), ...(localState.topicLastQid || {}) };

    const base = remoteNewer ? remoteState : localState;
    return {
      ...localState,
      ...base,
      records: mergedRecords,
      memos: mergedMemos,
      customAnswers: mergedCustomAnswers,
      trendChecked: mergedTrend,
      topicLastQid: mergedTopicLast,
      lastPosition:
        (remoteState.lastPosition?.updatedAt || 0) >= (localState.lastPosition?.updatedAt || 0)
          ? remoteState.lastPosition || localState.lastPosition
          : localState.lastPosition,
      _updatedAt: Math.max(localState._updatedAt || 0, remoteState._updatedAt || 0),
    };
  }

  // --- Cloud Provider: GitHub Gist ---
  async function findGistForUser(token, username) {
    const filename = `garisastudy_db_${username.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}.json`;
    const resp = await fetch("https://api.github.com/gists?per_page=100", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!resp.ok) throw new Error(`GitHub API ${resp.status}`);
    const gists = await resp.json();
    const found = gists.find((g) => g.files && g.files[filename]);
    return { gistId: found ? found.id : null, filename };
  }

  async function pullFromGist(cfg, username) {
    const token = (cfg.githubToken || "").trim();
    if (!token) throw new Error("GitHub 토큰이 없습니다.");
    let gistId = (cfg.gistId || "").trim();
    let filename = `garisastudy_db_${username.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}.json`;
    if (!gistId) {
      const found = await findGistForUser(token, username);
      gistId = found.gistId;
      filename = found.filename;
      if (gistId) {
        saveCloudConfig(username, { ...cfg, gistId });
      }
    }
    if (!gistId) return null;
    const resp = await fetch(`https://api.github.com/gists/${gistId}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
      },
    });
    if (!resp.ok) throw new Error(`GitHub Gist 불러오기 실패 (${resp.status})`);
    const gist = await resp.json();
    const file = gist.files && (gist.files[filename] || Object.values(gist.files)[0]);
    if (!file || !file.content) return null;
    return JSON.parse(file.content);
  }

  async function pushToGist(cfg, username, stateData) {
    const token = (cfg.githubToken || "").trim();
    if (!token) throw new Error("GitHub 토큰이 없습니다.");
    let gistId = (cfg.gistId || "").trim();
    const filename = `garisastudy_db_${username.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}.json`;
    if (!gistId) {
      const found = await findGistForUser(token, username);
      gistId = found.gistId;
    }
    const body = {
      description: `GarisaStudy DB (${username})`,
      public: false,
      files: {
        [filename]: { content: JSON.stringify(stateData) },
      },
    };
    const url = gistId ? `https://api.github.com/gists/${gistId}` : "https://api.github.com/gists";
    const method = gistId ? "PATCH" : "POST";
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`GitHub Gist 저장 실패 (${resp.status})`);
    const saved = await resp.json();
    if (saved.id && saved.id !== cfg.gistId) {
      saveCloudConfig(username, { ...cfg, gistId: saved.id });
    }
    return true;
  }

  // --- Cloud Provider: Supabase REST ---
  function cleanSupabaseUrl(url) {
    return String(url || "").trim().replace(/\/+$/, "");
  }

  async function pullFromSupabase(cfg, username) {
    const base = cleanSupabaseUrl(cfg.supabaseUrl);
    const key = (cfg.supabaseKey || "").trim();
    const table = (cfg.supabaseTable || "study_sync").trim();
    if (!base || !key) throw new Error("Supabase URL과 Anon Key를 입력하세요.");
    const url = `${base}/rest/v1/${encodeURIComponent(table)}?user_id=eq.${encodeURIComponent(username)}&select=payload,updated_at`;
    const resp = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    if (!resp.ok) throw new Error(`Supabase 불러오기 실패 (${resp.status})`);
    const rows = await resp.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return rows[0].payload || null;
  }

  async function pushToSupabase(cfg, username, stateData) {
    const base = cleanSupabaseUrl(cfg.supabaseUrl);
    const key = (cfg.supabaseKey || "").trim();
    const table = (cfg.supabaseTable || "study_sync").trim();
    if (!base || !key) throw new Error("Supabase URL과 Anon Key를 입력하세요.");
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
        user_id: username,
        payload: stateData,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!resp.ok) throw new Error(`Supabase 저장 실패 (${resp.status})`);
    return true;
  }

  async function pullCloud(username) {
    const cfg = getCloudConfig(username);
    if (cfg.provider === "gist") return pullFromGist(cfg, username);
    if (cfg.provider === "supabase") return pullFromSupabase(cfg, username);
    return null;
  }

  async function pushCloud(username, stateData) {
    const cfg = getCloudConfig(username);
    if (cfg.provider === "gist") return pushToGist(cfg, username, stateData);
    if (cfg.provider === "supabase") return pushToSupabase(cfg, username, stateData);
    return false;
  }

  window.StudyDB = {
    listAccounts,
    getAccount,
    registerAccount,
    loginAccount,
    deleteAccount,
    getSavedSession,
    setSavedSession,
    loadUserState,
    saveUserState,
    getAccountSummary,
    getCloudConfig,
    saveCloudConfig,
    mergeStates,
    pullCloud,
    pushCloud,
  };
})();
