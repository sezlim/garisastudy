(() => {
  "use strict";

  const DEFAULT_GEM_URL = "https://gemini.google.com/app";
  const DEFAULT_VIEW_PREF_KEY = "ai_workspace_default_topic_view_v1";
  const CIRCLED = { 1: "①", 2: "②", 3: "③", 4: "④" };
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DOUBLE_ESC_MS = 420;
  const SUPABASE_SETUP_SQL = `create table if not exists public.study_sync (
  user_id text primary key,
  payload jsonb not null,
  updated_at timestamptz default now()
);
alter table public.study_sync enable row level security;
create policy "Allow anon read/write" on public.study_sync
  for all using (true) with check (true);`;

  const FILTER_LABELS = {
    all: "전체",
    unsolved: "안 푼 문제",
    wrong: "오답만",
    uncertain: "불확실(찍음)만",
    review: "오늘 복습할 문제 (1·3·7일)",
  };

  const SORT_LABELS = {
    latest: "최신순",
    random: "랜덤순",
  };

  const DAY_SHORT = {
    "01_월_감리및사업관리": { day: "월", name: "감리" },
    "02_화_소프트웨어공학": { day: "화", name: "SW공학" },
    "03_수_데이터베이스": { day: "수", name: "DB" },
    "04_목_시스템구조": { day: "목", name: "시스템" },
    "05_금_보안": { day: "금", name: "보안" },
  };

  function readSavedDefaultTopicView() {
    try {
      const v = localStorage.getItem(DEFAULT_VIEW_PREF_KEY);
      if (v === "briefing" || v === "session") return v;
    } catch {
      // ignore storage errors
    }
    return "briefing";
  }

  function writeSavedDefaultTopicView(val) {
    try {
      if (val === "briefing" || val === "session") {
        localStorage.setItem(DEFAULT_VIEW_PREF_KEY, val);
      }
    } catch {
      // ignore storage errors
    }
  }

  const DEFAULT_STATE = {
    theme: "dark",
    invertImages: true,
    alwaysShowAnswer: false,
    defaultTopicView: readSavedDefaultTopicView(),
    gemUrl: "",
    activeSubjectCode: "01_월_감리및사업관리",
    activeTopicCode: null,
    filter: "all",
    sort: "latest",
    sidebarCollapsed: false,
    lastPosition: null,
    topicLastQid: {},
    records: {},
    memos: {},
    customAnswers: {},
    trendChecked: {},
  };

  let studyData = null;
  let theoryData = null;
  let currentUser = null;
  let authMode = "login"; // "login" | "register"
  let state = normalizeState(null);
  let activeViewMode = "session"; // "briefing" | "session"
  let briefingPeekOpen = false;
  let currentQueue = [];
  let currentIndex = 0;
  let randomSeedKey = "";
  let randomOrderMap = {};
  let perQuestionOriginalColor = {};
  let peekedQuestions = {};
  let navigatorOpen = false;
  let stealthActive = false;
  let lightboxQid = null;
  let lastEscTs = 0;
  let toastTimer = null;
  let memoHintTimer = null;
  let cloudSyncTimer = null;
  let syncInFlight = false;

  const el = {
    authOverlay: document.getElementById("authOverlay"),
    savedAccountsWrap: document.getElementById("savedAccountsWrap"),
    savedAccountsList: document.getElementById("savedAccountsList"),
    authTabLogin: document.getElementById("authTabLogin"),
    authTabRegister: document.getElementById("authTabRegister"),
    authForm: document.getElementById("authForm"),
    authUsernameInput: document.getElementById("authUsernameInput"),
    authPasswordInput: document.getElementById("authPasswordInput"),
    authRememberCheckbox: document.getElementById("authRememberCheckbox"),
    authErrorMsg: document.getElementById("authErrorMsg"),
    authSubmitBtn: document.getElementById("authSubmitBtn"),
    authCloudProvider: document.getElementById("authCloudProvider"),
    authGistFields: document.getElementById("authGistFields"),
    authGithubToken: document.getElementById("authGithubToken"),
    authSupabaseFields: document.getElementById("authSupabaseFields"),
    authSupabaseUrl: document.getElementById("authSupabaseUrl"),
    authSupabaseKey: document.getElementById("authSupabaseKey"),
    userAvatarInitial: document.getElementById("userAvatarInitial"),
    currentUserName: document.getElementById("currentUserName"),
    cloudSyncStatus: document.getElementById("cloudSyncStatus"),
    manualSyncBtn: document.getElementById("manualSyncBtn"),
    logoutBtn: document.getElementById("logoutBtn"),
    resumeStudyBtn: document.getElementById("resumeStudyBtn"),
    resumeStudyDetail: document.getElementById("resumeStudyDetail"),
    appShell: document.getElementById("appShell"),
    sidebar: document.getElementById("sidebar"),
    sidebarBackdrop: document.getElementById("sidebarBackdrop"),
    sidebarToggleBtn: document.getElementById("sidebarToggleBtn"),
    sidebarCloseBtn: document.getElementById("sidebarCloseBtn"),
    subjectTabs: document.getElementById("subjectTabs"),
    subjectSubtitle: document.getElementById("subjectSubtitle"),
    topicList: document.getElementById("topicList"),
    dueReviewShortcutBtn: document.getElementById("dueReviewShortcutBtn"),
    sidebarStatsText: document.getElementById("sidebarStatsText"),
    filterDropdownBtn: document.getElementById("filterDropdownBtn"),
    activeFilterBadge: document.getElementById("activeFilterBadge"),
    filterMenu: document.getElementById("filterMenu"),
    filterOptionsGroup: document.getElementById("filterOptionsGroup"),
    sortOptionsGroup: document.getElementById("sortOptionsGroup"),
    alwaysShowAnsBtn: document.getElementById("alwaysShowAnsBtn"),
    stealthBtn: document.getElementById("stealthBtn"),
    settingsBtn: document.getElementById("settingsBtn"),
    viewModeBar: document.getElementById("viewModeBar"),
    viewTabBriefing: document.getElementById("viewTabBriefing"),
    viewTabSession: document.getElementById("viewTabSession"),
    viewTabSessionLabel: document.getElementById("viewTabSessionLabel"),
    chatStream: document.getElementById("chatStream"),
    streamInner: document.getElementById("streamInner"),
    composerBar: document.getElementById("composerBar"),
    memoInput: document.getElementById("memoInput"),
    memoSavedHint: document.getElementById("memoSavedHint"),
    uncertainBtn: document.getElementById("uncertainBtn"),
    nextBtn: document.getElementById("nextBtn"),
    briefingPeekBackdrop: document.getElementById("briefingPeekBackdrop"),
    briefingPeekDrawer: document.getElementById("briefingPeekDrawer"),
    briefingPeekCode: document.getElementById("briefingPeekCode"),
    briefingPeekTitle: document.getElementById("briefingPeekTitle"),
    briefingPeekFullBtn: document.getElementById("briefingPeekFullBtn"),
    briefingPeekCloseBtn: document.getElementById("briefingPeekCloseBtn"),
    briefingPeekBody: document.getElementById("briefingPeekBody"),
    stealthScreen: document.getElementById("stealthScreen"),
    stealthReturnBtn: document.getElementById("stealthReturnBtn"),
    stealthInput: document.getElementById("stealthInput"),
    stealthSubmitBtn: document.getElementById("stealthSubmitBtn"),
    lightboxModal: document.getElementById("lightboxModal"),
    lightboxImg: document.getElementById("lightboxImg"),
    lightboxInvertBtn: document.getElementById("lightboxInvertBtn"),
    lightboxCloseBtn: document.getElementById("lightboxCloseBtn"),
    settingsModal: document.getElementById("settingsModal"),
    settingsCloseBtn: document.getElementById("settingsCloseBtn"),
    themeDarkBtn: document.getElementById("themeDarkBtn"),
    themeLightBtn: document.getElementById("themeLightBtn"),
    defaultViewBriefingBtn: document.getElementById("defaultViewBriefingBtn"),
    defaultViewSessionBtn: document.getElementById("defaultViewSessionBtn"),
    defaultInvertCheckbox: document.getElementById("defaultInvertCheckbox"),
    alwaysShowAnsCheckbox: document.getElementById("alwaysShowAnsCheckbox"),
    cloudProviderSelect: document.getElementById("cloudProviderSelect"),
    settingsGistFields: document.getElementById("settingsGistFields"),
    settingsGithubToken: document.getElementById("settingsGithubToken"),
    settingsSupabaseFields: document.getElementById("settingsSupabaseFields"),
    settingsSupabaseUrl: document.getElementById("settingsSupabaseUrl"),
    settingsSupabaseKey: document.getElementById("settingsSupabaseKey"),
    copySupabaseSqlBtn: document.getElementById("copySupabaseSqlBtn"),
    saveCloudSyncBtn: document.getElementById("saveCloudSyncBtn"),
    syncNowBtn: document.getElementById("syncNowBtn"),
    copyMobileLinkBtn: document.getElementById("copyMobileLinkBtn"),
    gemUrlInput: document.getElementById("gemUrlInput"),
    saveGemUrlBtn: document.getElementById("saveGemUrlBtn"),
    settingsProgressMeta: document.getElementById("settingsProgressMeta"),
    exportBackupBtn: document.getElementById("exportBackupBtn"),
    importBackupBtn: document.getElementById("importBackupBtn"),
    importAnswersBtn: document.getElementById("importAnswersBtn"),
    resetTopicBtn: document.getElementById("resetTopicBtn"),
    resetSubjectBtn: document.getElementById("resetSubjectBtn"),
    resetProgressBtn: document.getElementById("resetProgressBtn"),
    importBackupFile: document.getElementById("importBackupFile"),
    importAnswersFile: document.getElementById("importAnswersFile"),
    toast: document.getElementById("toast"),
  };

  function normalizeState(parsed) {
    const src = parsed && typeof parsed === "object" ? parsed : {};
    const resolvedDefaultView =
      src.defaultTopicView === "briefing" || src.defaultTopicView === "session"
        ? src.defaultTopicView
        : readSavedDefaultTopicView();
    return {
      ...DEFAULT_STATE,
      ...src,
      alwaysShowAnswer: Boolean(src.alwaysShowAnswer),
      defaultTopicView: resolvedDefaultView,
      lastPosition: src.lastPosition && typeof src.lastPosition === "object" ? src.lastPosition : null,
      topicLastQid: src.topicLastQid && typeof src.topicLastQid === "object" ? src.topicLastQid : {},
      records: src.records && typeof src.records === "object" ? src.records : {},
      memos: src.memos && typeof src.memos === "object" ? src.memos : {},
      customAnswers: src.customAnswers && typeof src.customAnswers === "object" ? src.customAnswers : {},
      trendChecked: src.trendChecked && typeof src.trendChecked === "object" ? src.trendChecked : {},
    };
  }

  function setSyncStatus(text, isSynced = false) {
    if (!el.cloudSyncStatus) return;
    el.cloudSyncStatus.textContent = text;
    el.cloudSyncStatus.classList.toggle("synced", Boolean(isSynced));
  }

  function scheduleCloudPush() {
    if (!currentUser || !window.StudyDB) return;
    const cfg = window.StudyDB.getCloudConfig(currentUser);
    if (!cfg || cfg.provider === "none") return;
    clearTimeout(cloudSyncTimer);
    setSyncStatus("클라우드 동기화 대기...", false);
    cloudSyncTimer = setTimeout(async () => {
      if (syncInFlight || !currentUser) return;
      syncInFlight = true;
      setSyncStatus("클라우드 저장 중...", false);
      try {
        await window.StudyDB.pushCloud(currentUser, state);
        const now = new Date();
        const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
        setSyncStatus(`클라우드 동기화됨 (${hm})`, true);
      } catch {
        setSyncStatus("로컬 저장됨 (클라우드 오류)", false);
      } finally {
        syncInFlight = false;
      }
    }, 1200);
  }

  function saveState({ pushCloud = true } = {}) {
    if (!currentUser || !window.StudyDB) return;
    state._updatedAt = Date.now();
    window.StudyDB.saveUserState(currentUser, state).catch(() => {
      showToast("저장 공간이 부족해 일부 기록을 저장하지 못했습니다.");
    });
    if (pushCloud) {
      scheduleCloudPush();
    }
  }

  async function syncWithCloudNow({ silent = false } = {}) {
    if (!currentUser || !window.StudyDB) return;
    const cfg = window.StudyDB.getCloudConfig(currentUser);
    if (!cfg || cfg.provider === "none") {
      if (!silent) showToast("클라우드 동기화가 설정되지 않았습니다");
      return;
    }
    if (syncInFlight) return;
    syncInFlight = true;
    setSyncStatus("클라우드 동기화 중...", false);
    try {
      const remote = await window.StudyDB.pullCloud(currentUser);
      if (remote) {
        state = normalizeState(window.StudyDB.mergeStates(state, remote));
        await window.StudyDB.saveUserState(currentUser, state);
      }
      await window.StudyDB.pushCloud(currentUser, state);
      const now = new Date();
      const hm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
      setSyncStatus(`클라우드 동기화됨 (${hm})`, true);
      if (!silent) {
        renderAll({ rebuildQueue: true, keepCurrentQid: currentQueue[currentIndex]?.id || null });
        showToast("클라우드 DB 동기화를 완료했습니다");
      }
    } catch (err) {
      setSyncStatus("클라우드 연결 실패", false);
      if (!silent) showToast(`클라우드 동기화 실패: ${err.message || "설정 확인 필요"}`);
    } finally {
      syncInFlight = false;
    }
  }

  function resolveImageUrl(p) {
    if (!p) return "";
    const clean = String(p).replace(/\\/g, "/").replace(/^\.?\/?web\//i, "").replace(/^\/+/, "");
    return "./" + clean;
  }

  function getEffectiveAnswers(q) {
    if (!q) return [];
    const custom = state.customAnswers[q.id];
    if (custom != null && Number(custom) >= 1 && Number(custom) <= 4) {
      return [Number(custom)];
    }
    if (Array.isArray(q.answers) && q.answers.length > 0) {
      const valid = q.answers.map(Number).filter((n) => n >= 1 && n <= 4);
      if (valid.length > 0) return Array.from(new Set(valid)).sort((a, b) => a - b);
    }
    if (q.answer != null && Number(q.answer) >= 1 && Number(q.answer) <= 4) {
      return [Number(q.answer)];
    }
    return [];
  }

  function getEffectiveAnswer(q) {
    const list = getEffectiveAnswers(q);
    return list.length > 0 ? list[0] : null;
  }

  function formatAnswersLabel(ansList) {
    if (!ansList || ansList.length === 0) return "미등록";
    if (ansList.length === 4) return "①~④ (전원정답)";
    const joined = ansList.map((n) => CIRCLED[n]).join(", ");
    return ansList.length > 1 ? `${joined} (복수정답)` : joined;
  }

  function endOfTodayMs() {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  function isDueForReview(rec) {
    if (!rec || rec.nextReviewAt == null) return false;
    return rec.nextReviewAt <= endOfTodayMs();
  }

  function computeReviewSchedule(prevRec, result, uncertain) {
    const now = Date.now();
    if (result === "wrong" || uncertain) {
      return { reviewStage: 0, nextReviewAt: now + 1 * DAY_MS };
    }
    if (result === "correct") {
      if (prevRec && prevRec.nextReviewAt != null) {
        if (prevRec.reviewStage === 0) {
          return { reviewStage: 1, nextReviewAt: now + 3 * DAY_MS };
        }
        if (prevRec.reviewStage === 1) {
          return { reviewStage: 2, nextReviewAt: now + 7 * DAY_MS };
        }
        return { reviewStage: 3, nextReviewAt: null };
      }
      return {
        reviewStage: prevRec ? prevRec.reviewStage : null,
        nextReviewAt: null,
      };
    }
    return {
      reviewStage: prevRec ? prevRec.reviewStage : null,
      nextReviewAt: prevRec ? prevRec.nextReviewAt : null,
    };
  }

  function recordCurrentPosition(q) {
    const subj = getActiveSubject();
    const topic = getActiveTopic();
    if (!subj || !topic || topic.is_trend || !q) return;
    state.topicLastQid[topic.topic_code] = q.id;
    state.lastPosition = {
      subjectCode: subj.subject_code,
      topicCode: topic.topic_code,
      topicName: topic.topic,
      questionId: q.id,
      yearRound: q.year_round,
      number: q.number,
      queueIndex: currentIndex + 1,
      queueTotal: currentQueue.length,
      updatedAt: Date.now(),
    };
  }

  function applyRecordUpdate(q, { selected, selfResult, toggleUncertain }) {
    const prev = state.records[q.id] || {
      selected: null,
      result: "ungraded",
      uncertain: false,
      updatedAt: 0,
      reviewStage: null,
      nextReviewAt: null,
    };

    const nextSelected = selected !== undefined ? selected : prev.selected;
    const nextUncertain = toggleUncertain ? !prev.uncertain : prev.uncertain;
    const effAnsList = getEffectiveAnswers(q);

    let nextResult = prev.result;
    if (nextSelected == null) {
      nextResult = "ungraded";
    } else if (effAnsList.length > 0) {
      nextResult = effAnsList.includes(nextSelected) ? "correct" : "wrong";
    } else if (selfResult !== undefined) {
      nextResult = selfResult;
    } else if (selected !== undefined && selected !== prev.selected) {
      nextResult = "ungraded";
    }

    const sched = computeReviewSchedule(prev, nextResult, nextUncertain);

    state.records[q.id] = {
      selected: nextSelected,
      result: nextResult,
      uncertain: nextUncertain,
      updatedAt: Date.now(),
      reviewStage: sched.reviewStage,
      nextReviewAt: sched.nextReviewAt,
    };
    recordCurrentPosition(q);
    saveState();
  }

  function getActiveSubject() {
    if (!studyData) return null;
    return (
      studyData.subjects.find((s) => s.subject_code === state.activeSubjectCode) ||
      studyData.subjects[0]
    );
  }

  function getActiveTopic() {
    const subj = getActiveSubject();
    if (!subj) return null;
    let topic = subj.topics.find((t) => t.topic_code === state.activeTopicCode);
    if (!topic) {
      topic = subj.topics[0];
      state.activeTopicCode = topic ? topic.topic_code : null;
    }
    return topic;
  }

  function getSubjectTrendTopic(subj) {
    if (!subj) return null;
    return subj.topics.find((t) => t.is_trend) || null;
  }

  function matchesFilter(q, filterKey) {
    const rec = state.records[q.id];
    switch (filterKey) {
      case "unsolved":
        return !rec || rec.selected == null;
      case "wrong":
        return Boolean(rec && rec.result === "wrong");
      case "uncertain":
        return Boolean(rec && rec.uncertain);
      case "review":
        return isDueForReview(rec);
      case "all":
      default:
        return true;
    }
  }

  function buildQueueForTopic(topic, keepCurrentQid = null) {
    if (!topic || topic.is_trend) {
      currentQueue = [];
      currentIndex = 0;
      return;
    }
    const base = topic.gamrisa_questions.filter((q) => matchesFilter(q, state.filter));
    if (state.sort === "random") {
      const key = `${topic.topic_code}|${state.filter}`;
      if (randomSeedKey !== key) {
        const ids = base.map((q) => q.id);
        for (let i = ids.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [ids[i], ids[j]] = [ids[j], ids[i]];
        }
        randomOrderMap = {};
        ids.forEach((id, idx) => {
          randomOrderMap[id] = idx;
        });
        randomSeedKey = key;
      }
      base.sort((a, b) => (randomOrderMap[a.id] ?? 0) - (randomOrderMap[b.id] ?? 0));
    } else {
      randomSeedKey = "";
    }

    currentQueue = base;
    const targetQid = keepCurrentQid || (state.filter === "all" ? state.topicLastQid[topic.topic_code] : null);
    if (targetQid) {
      const foundIdx = currentQueue.findIndex((q) => q.id === targetQid);
      if (foundIdx >= 0) {
        currentIndex = foundIdx;
        return;
      }
    }
    // Start at first unsolved question if viewing 'all', else 0
    if (state.filter === "all" && currentQueue.length > 0 && !keepCurrentQid) {
      const firstUnsolved = currentQueue.findIndex((q) => {
        const r = state.records[q.id];
        return !r || r.selected == null;
      });
      currentIndex = firstUnsolved >= 0 ? firstUnsolved : 0;
    } else {
      currentIndex = Math.max(0, Math.min(currentIndex, Math.max(0, currentQueue.length - 1)));
    }
  }

  function isMobileViewport() {
    return window.matchMedia("(max-width: 768px)").matches;
  }

  function setMobileSidebarOpen(open) {
    el.appShell.classList.toggle("mobile-sidebar-open", Boolean(open));
  }

  function applyTheme() {
    if (state.theme === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    el.themeDarkBtn.classList.toggle("active", state.theme !== "light");
    el.themeLightBtn.classList.toggle("active", state.theme === "light");
    if (el.defaultViewBriefingBtn && el.defaultViewSessionBtn) {
      el.defaultViewBriefingBtn.classList.toggle("active", state.defaultTopicView === "briefing");
      el.defaultViewSessionBtn.classList.toggle("active", state.defaultTopicView !== "briefing");
    }
    el.defaultInvertCheckbox.checked = Boolean(state.invertImages);
    if (el.alwaysShowAnsCheckbox) {
      el.alwaysShowAnsCheckbox.checked = Boolean(state.alwaysShowAnswer);
    }
    if (el.alwaysShowAnsBtn) {
      el.alwaysShowAnsBtn.classList.toggle("active", Boolean(state.alwaysShowAnswer));
      el.alwaysShowAnsBtn.setAttribute("aria-pressed", String(Boolean(state.alwaysShowAnswer)));
    }
  }

  function applySidebarCollapse() {
    el.appShell.classList.toggle("sidebar-collapsed", Boolean(state.sidebarCollapsed));
  }

  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.add("hidden");
    }, 2600);
  }

  function getEffectiveGemUrl() {
    const raw = (state.gemUrl || "").trim();
    if (!raw) return DEFAULT_GEM_URL;
    if (/^https?:\/\//i.test(raw)) return raw;
    return DEFAULT_GEM_URL;
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function singleLine(str) {
    return String(str ?? "").replace(/\s+/g, " ").trim();
  }

  function copyTextWithFallback(text) {
    let fallbackDone = false;
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-9999px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      fallbackDone = document.execCommand("copy");
      document.body.removeChild(ta);
    } catch {
      fallbackDone = false;
    }

    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).catch(() => {});
      return true;
    }
    return fallbackDone;
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function copyOrSaveImage(imagePath, qid) {
    const url = resolveImageUrl(imagePath);
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error("fetch failed");
      const blob = await resp.blob();

      if (
        typeof window.ClipboardItem === "function" &&
        navigator.clipboard &&
        typeof navigator.clipboard.write === "function"
      ) {
        try {
          await navigator.clipboard.write([new ClipboardItem({ [blob.type || "image/png"]: blob })]);
          showToast("그림을 클립보드에 복사했습니다");
          return;
        } catch {
          // Fall back cleanly to saving the PNG
        }
      }
      downloadBlob(blob, `${qid}.png`);
      showToast("클립보드 이미지 복사 미지원 · 원본 이미지를 저장했습니다");
    } catch {
      showToast("이미지를 불러오지 못했습니다");
    }
  }

  function formatOptionLinesForPrompt(q) {
    const opts = q.options || {};
    return [1, 2, 3, 4]
      .map((n) => {
        const txt = singleLine(opts[String(n)] || "");
        return `${CIRCLED[n]} ${txt || "(이미지 보기 참고)"}`;
      })
      .join(" ");
  }

  function formatRelatedPeForPrompt(subj, topic) {
    const topicPe = (topic && topic.pe_questions) || [];
    if (topicPe.length > 0) {
      return topicPe
        .slice(0, 5)
        .map(
          (p) =>
            `- [${p.exam_type} ${p.year_round} ${p.session} ${p.number}번] ${singleLine(p.question)}`
        )
        .join("\n");
    }
    const trend = getSubjectTrendTopic(subj);
    const trendPe = (trend && trend.pe_questions) || [];
    if (trendPe.length > 0) {
      return (
        "(직접 매핑된 기술사 기출이 없어 동일 과목 최신 트렌드 참고)\n" +
        trendPe
          .slice(0, 3)
          .map(
            (p) =>
              `- [${p.exam_type} ${p.year_round} ${p.session} ${p.number}번] ${singleLine(p.question)}`
          )
          .join("\n")
      );
    }
    return "없음";
  }

  function buildGeminiExplainPrompt(subj, topic, q, rec) {
    const effAns = getEffectiveAnswer(q);
    const sel = rec && rec.selected ? rec.selected : "미선택";
    const tags = [];
    if (rec && rec.result === "correct") tags.push("정답");
    else if (rec && rec.result === "wrong") tags.push("오답");
    if (rec && rec.uncertain) tags.push("찍음");
    const statusStr = tags.length > 0 ? tags.join("/") : "정답 미확인";

    const stateLine =
      effAns !== null
        ? `정답은 ${effAns}번인데, 나는 ${sel}번을 선택했어(${statusStr}).`
        : `공식 정답은 미등록 상태이고, 나는 ${sel}번을 선택했어(${statusStr}). 먼저 정확한 정답 번호를 판정하고 해설해 줘.`;

    const qBody = singleLine(q.question) || "(문제 이미지 참고)";
    const optLine = formatOptionLinesForPrompt(q);
    const peBlock = formatRelatedPeForPrompt(subj, topic);

    return [
      "---",
      `[과목/토픽] ${subj.display_name} > ${topic.topic}`,
      `[기출 출처] ${q.year_round} ${q.number}번`,
      `[문제] ${qBody}`,
      `[보기] ${optLine}`,
      `[내 풀이 상태] ${stateLine}`,
      `[연관 기술사 기출]\n${peBlock}`,
      "[질문 요청] 내가 헷갈린 보기와 정답의 결정적 차이를 설명해 주고, 위 연관 기술사 기출 관점에서 출제 의도와 암기할 핵심 키워드를 3줄로 정리해 줘.",
      "---",
    ].join("\n");
  }

  function buildGeminiVariantPrompt(subj, topic, q) {
    const qBody = singleLine(q.question) || "(문제 이미지 참고)";
    const optLine = formatOptionLinesForPrompt(q);
    const peBlock = formatRelatedPeForPrompt(subj, topic);

    return [
      "---",
      `[과목/토픽] ${subj.display_name} > ${topic.topic}`,
      `[원본 감리사 기출] (${q.year_round} ${q.number}번) ${qBody}`,
      `[원본 보기] ${optLine}`,
      `[연관 기술사 기출]\n${peBlock}`,
      "[요청] 방금 푼 위 감리사 기출과 연관 기술사 기출의 최신·심화 논점을 결합해서, 감리사 실전 4지선다 고난도 변형문제 2개와 각 문항의 정답·오답 함정 해설을 작성해 줘.",
      "---",
    ].join("\n");
  }

  function buildTrendMockPrompt(subj, pe) {
    return [
      "---",
      `[과목/트렌드] ${subj.display_name} > 신규 출제 예상(트렌드)`,
      `[기술사 기출] (${pe.exam_type} ${pe.year_round} ${pe.session} ${pe.number}번)`,
      singleLine(pe.question),
      `[감리사 출제 포인트] ${pe.relevance_note || ""}`,
      "[요청] 위 기술사 최신 트렌드 문제가 정보시스템 감리사 시험(객관식 4지선다)에 출제된다고 가정하고, 실전 감리사 스타일 4지선다 예상문제 2개와 정답 및 암기 포인트를 만들어 줘.",
      "---",
    ].join("\n");
  }

  function getTopicTheory(topicCode) {
    if (!topicCode || !theoryData || typeof theoryData !== "object") return null;
    const item = theoryData[topicCode];
    if (!item || typeof item !== "object") return null;
    if (!item.core_summary && (!Array.isArray(item.trap_patterns) || item.trap_patterns.length === 0)) {
      return null;
    }
    return item;
  }

  function resolveInitialViewMode(topic, { forceSession = false } = {}) {
    if (forceSession || !topic) return "session";
    if (state.defaultTopicView === "briefing" && getTopicTheory(topic.topic_code)) {
      return "briefing";
    }
    return "session";
  }

  function formatInlineMarkdown(str) {
    let escaped = escapeHtml(str ?? "");
    // Inline code first so we don't style inside code spans
    const codeSlots = [];
    escaped = escaped.replace(/`([^`\n]+)`/g, (_, inner) => {
      const idx = codeSlots.length;
      codeSlots.push(`<code class="briefing-code">${inner}</code>`);
      return `\u0000CODE${idx}\u0000`;
    });
    // Bold **...**
    escaped = escaped.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    // Highlight exam year/round references gently (e.g., 2025년(제26회) 15번, 2024년 9번)
    escaped = escaped.replace(
      /(\d{4}년(?:\(제\d+회\))?\s*(?:\d+교시\s*)?\d+번(?:\s*\/\s*\d+번)?)/g,
      '<span class="briefing-ref-pill">$1</span>'
    );
    // Restore code slots
    escaped = escaped.replace(/\u0000CODE(\d+)\u0000/g, (_, idx) => codeSlots[Number(idx)] || "");
    return escaped;
  }

  function highlightLeadIn(htmlStr) {
    // If a bullet starts with "short label: body", emphasize the lead-in label gently
    if (htmlStr.startsWith("<strong>") || htmlStr.startsWith("<code")) return htmlStr;
    const m = htmlStr.match(/^([^:<>]{2,32})(:|\s=)\s+(.+)$/);
    if (!m) return htmlStr;
    return `<span class="briefing-lead">${m[1]}${m[2]}</span> ${m[3]}`;
  }

  function splitSubItems(bodyText) {
    const raw = String(bodyText || "").trim();
    if (!raw) return [];
    // Mask inline code spans (`...`) and parenthetical remarks containing ※ so math "-" or "(※ ...)" are never split
    const masks = [];
    const masked = raw.replace(/`[^`\n]+`|\([^()\n]*※[^()\n]*\)/g, (m) => {
      const idx = masks.length;
      masks.push(m);
      return `\u0001M${idx}\u0001`;
    });

    const normalized = masked
      .replace(/\s+(?=[①②③④⑤⑥⑦⑧⑨]\s+)/g, "\n")
      .replace(/\s+(?=•\s+)/g, "\n")
      .replace(/(?:^|[.!?:])\s+(?=※\s*)/g, (m) => (m[0] === " " ? "\n" : m[0] + "\n"))
      .replace(/([.!?])\s+(?=-\s+(?!\d))/g, "$1\n");

    return normalized
      .split(/\n+/)
      .map((s) => s.replace(/\u0001M(\d+)\u0001/g, (_, idx) => masks[Number(idx)] || "").trim())
      .filter(Boolean);
  }

  function renderSummaryItemsHtml(bodyText) {
    const items = splitSubItems(bodyText);
    if (items.length === 0) return "";
    if (items.length === 1 && !/^[①②③④⑤⑥⑦⑧⑨•※\-]/.test(items[0])) {
      return `<p class="briefing-card-text">${highlightLeadIn(formatInlineMarkdown(items[0]))}</p>`;
    }
    return `
      <ul class="briefing-sublist">
        ${items
          .map((item) => {
            if (item.startsWith("※")) {
              const cleaned = item.replace(/^※\s*/, "");
              return `<li class="briefing-subitem is-note"><span class="briefing-marker note">※</span><span class="briefing-subtext">${formatInlineMarkdown(cleaned)}</span></li>`;
            }
            const circled = item.match(/^([①②③④⑤⑥⑦⑧⑨])\s+(.+)$/);
            if (circled) {
              return `<li class="briefing-subitem"><span class="briefing-marker num">${circled[1]}</span><span class="briefing-subtext">${highlightLeadIn(formatInlineMarkdown(circled[2]))}</span></li>`;
            }
            const bulleted = item.match(/^[•\-·]\s+(.+)$/);
            if (bulleted) {
              return `<li class="briefing-subitem"><span class="briefing-marker dot">•</span><span class="briefing-subtext">${highlightLeadIn(formatInlineMarkdown(bulleted[1]))}</span></li>`;
            }
            return `<li class="briefing-subitem"><span class="briefing-marker dot">•</span><span class="briefing-subtext">${highlightLeadIn(formatInlineMarkdown(item))}</span></li>`;
          })
          .join("")}
      </ul>
    `;
  }

  function formatCoreSummaryHtml(summary) {
    const raw = String(summary || "").trim();
    if (!raw) return "";

    // Protect inline code spans (`...`) from being split by top-level section delimiters like [guard]
    const codeMasks = [];
    const safeRaw = raw.replace(/`[^`\n]+`/g, (m) => {
      const idx = codeMasks.length;
      codeMasks.push(m);
      return `\u0002C${idx}\u0002`;
    });
    const unmask = (s) => s.replace(/\u0002C(\d+)\u0002/g, (_, idx) => codeMasks[Number(idx)] || "");

    let blocks = [];

    // Pattern A: [Section Title] body ...
    if (/(?:^|\s)\[[^\]\n]{2,56}\]\s+/.test(safeRaw)) {
      const parts = safeRaw
        .replace(/\s+(?=\[[^\]\n]{2,56}\]\s+)/g, "\n")
        .split(/\n+/)
        .map((s) => unmask(s).trim())
        .filter(Boolean);
      parts.forEach((part) => {
        const m = part.match(/^\[([^\]\n]{2,56})\]\s+(.+)$/);
        if (m) blocks.push({ title: m[1].trim(), body: m[2].trim() });
        else blocks.push({ title: "", body: part });
      });
    }
    // Pattern B: ■ Title: body ...
    else if (/(?:^|\s)■\s+/.test(safeRaw)) {
      const parts = safeRaw
        .replace(/\s+(?=■\s+)/g, "\n")
        .split(/\n+/)
        .map((s) => unmask(s).replace(/^■\s*/, "").trim())
        .filter(Boolean);
      parts.forEach((part) => {
        const m = part.match(/^([^:\n]{2,42}):\s+(.+)$/);
        if (m) blocks.push({ title: m[1].trim(), body: m[2].trim() });
        else blocks.push({ title: "", body: part });
      });
    }
    // Pattern C: • **Title**: body or - **Title**: body
    else if (/(?:^|\s)[•\-]\s+\*\*[^*\n]{2,46}\*\*\s*:/.test(safeRaw)) {
      const parts = safeRaw
        .replace(/\s+(?=[•\-]\s+\*\*[^*\n]{2,46}\*\*\s*:)/g, "\n")
        .split(/\n+/)
        .map((s) => unmask(s).replace(/^[•\-]\s+/, "").trim())
        .filter(Boolean);
      parts.forEach((part) => {
        const m = part.match(/^\*\*([^*\n]{2,46})\*\*\s*:\s*(.+)$/);
        if (m) blocks.push({ title: m[1].trim(), body: m[2].trim() });
        else blocks.push({ title: "", body: part });
      });
    }
    // Pattern D: ① Title: body ② Title: body ...
    else if (/(?:^|\s)[①②③④⑤⑥]\s+/.test(safeRaw)) {
      const parts = safeRaw
        .replace(/\s+(?=[①②③④⑤⑥]\s+)/g, "\n")
        .split(/\n+/)
        .map((s) => unmask(s).trim())
        .filter(Boolean);
      parts.forEach((part) => {
        const m = part.match(/^([①②③④⑤⑥])\s+\*\*([^*\n]{2,42})\*\*\s*[:：]?\s*(.+)$/);
        if (m) {
          blocks.push({ title: `${m[1]} ${m[2].trim()}`, body: m[3].trim() });
          return;
        }
        const m2 = part.match(/^([①②③④⑤⑥])\s+([^:\n]{2,36}):\s+(.+)$/);
        if (m2) {
          blocks.push({ title: `${m2[1]} ${m2[2].trim()}`, body: m2[3].trim() });
          return;
        }
        blocks.push({ title: "", body: part });
      });
    }
    // Fallback: single block
    else {
      blocks = [{ title: "", body: raw }];
    }

    return blocks
      .map((blk) => {
        const titleHtml = blk.title
          ? `<div class="briefing-card-heading">${formatInlineMarkdown(blk.title)}</div>`
          : "";
        return `
          <div class="briefing-summary-card">
            ${titleHtml}
            ${renderSummaryItemsHtml(blk.body)}
          </div>
        `;
      })
      .join("");
  }

  function formatTableCellHtml(cellText, colIdx) {
    const raw = String(cellText || "").trim();
    if (!raw) return "";
    // For readability in dense non-first columns, break cleanly on "; " when cell is long
    if (colIdx > 0 && raw.length >= 44 && raw.includes("; ")) {
      const pieces = raw.split(/;\s+/).map((p) => p.trim()).filter(Boolean);
      if (pieces.length >= 2) {
        return pieces
          .map((p) => `<div class="briefing-cell-line">${formatInlineMarkdown(p)}</div>`)
          .join("");
      }
    }
    return formatInlineMarkdown(raw);
  }

  function formatPeAlertHtml(text) {
    const raw = String(text || "").trim();
    if (!raw) return "";
    // Split multi-sentence trend alerts cleanly for scannability
    const split = raw
      .replace(/\s+(?=\[(?:정보관리|컴응))/g, "\n")
      .replace(/(다\.|됨\.|습니다\.|추세\.|유력\.)\s+/g, "$1\n")
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return split.map((p) => `<p class="briefing-pe-para">${formatInlineMarkdown(p)}</p>`).join("");
  }

  function renderBriefingTrapsHtml(traps) {
    if (!Array.isArray(traps) || traps.length === 0) return "";
    return `
      <div class="briefing-trap-list">
        ${traps
          .map(
            (t, idx) => `
          <div class="briefing-trap-card">
            <div class="briefing-trap-head">
              <span class="briefing-trap-badge">함정 ${String(idx + 1).padStart(2, "0")}</span>
              <div class="briefing-trap-pattern">${formatInlineMarkdown(t.pattern || "")}</div>
            </div>
            ${
              t.example_ref
                ? `<div class="briefing-trap-ref">
                     <span class="briefing-trap-ref-label">기출 근거</span>
                     <span class="briefing-trap-ref-text">${formatInlineMarkdown(t.example_ref)}</span>
                   </div>`
                : ""
            }
          </div>
        `
          )
          .join("")}
      </div>
    `;
  }

  function renderBriefingTableHtml(table) {
    if (
      !table ||
      typeof table !== "object" ||
      !Array.isArray(table.headers) ||
      table.headers.length === 0 ||
      !Array.isArray(table.rows) ||
      table.rows.length === 0
    ) {
      return "";
    }
    const headerHtml = table.headers.map((h) => `<th>${formatInlineMarkdown(h)}</th>`).join("");
    const rowsHtml = table.rows
      .map(
        (row) =>
          `<tr>${row.map((cell, ci) => `<td>${formatTableCellHtml(cell, ci)}</td>`).join("")}</tr>`
      )
      .join("");
    return `
      ${table.title ? `<div class="briefing-table-caption">${formatInlineMarkdown(table.title)}</div>` : ""}
      <div class="briefing-table-scroll">
        <table class="briefing-table">
          <thead><tr>${headerHtml}</tr></thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>
    `;
  }

  function buildGeminiBriefingPrompt(subj, topic, theory) {
    const lines = [
      "---",
      `[과목/토픽] ${subj.display_name} > ${topic.topic_code} ${topic.topic}`,
      "",
      "[1. 30초 핵심 배경]",
      theory.core_summary || "",
      "",
      "[2. 단골 오답 함정 패턴]",
      ...(theory.trap_patterns || []).map(
        (t, idx) => `${idx + 1}. ${t.pattern}${t.example_ref ? ` (기출: ${t.example_ref})` : ""}`
      ),
    ];

    if (
      theory.comparison_table &&
      Array.isArray(theory.comparison_table.headers) &&
      Array.isArray(theory.comparison_table.rows)
    ) {
      lines.push("", `[3. 핵심 비교·암기표: ${theory.comparison_table.title || ""}]`);
      lines.push(`| ${theory.comparison_table.headers.join(" | ")} |`);
      lines.push(`| ${theory.comparison_table.headers.map(() => "---").join(" | ")} |`);
      theory.comparison_table.rows.forEach((row) => {
        lines.push(`| ${row.join(" | ")} |`);
      });
    }

    if (Array.isArray(theory.cross_domain_links) && theory.cross_domain_links.length > 0) {
      lines.push("", "[4. 타 영역 크로스오버 출제 포인트]");
      theory.cross_domain_links.forEach((link) => lines.push(`- ${link}`));
    }

    if (theory.pe_trend_alert) {
      lines.push("", "[5. 기술사 연계 신유형 경보]", theory.pe_trend_alert);
    }

    lines.push(
      "",
      "[질문 요청] 이 토픽에서 가장 헷갈리는 핵심 함정을 예시로 쉽게 설명해 줘",
      "---"
    );
    return lines.join("\n");
  }

  function getTopicSessionCounts(topic) {
    if (!topic) return { done: 0, total: 0 };
    if (topic.is_trend) {
      const done = (topic.pe_questions || []).filter((p) => state.trendChecked[p.id]).length;
      return { done, total: topic.pe_count || (topic.pe_questions || []).length };
    }
    let done = 0;
    (topic.gamrisa_questions || []).forEach((q) => {
      if (state.records[q.id]?.selected != null) done += 1;
    });
    return { done, total: topic.gamrisa_count || (topic.gamrisa_questions || []).length };
  }

  function renderViewModeBar() {
    if (!el.viewModeBar || !el.viewTabBriefing || !el.viewTabSession) return;
    const topic = getActiveTopic();
    if (!topic) {
      el.viewModeBar.classList.add("hidden");
      return;
    }
    el.viewModeBar.classList.remove("hidden");
    const { done, total } = getTopicSessionCounts(topic);
    if (el.viewTabSessionLabel) {
      el.viewTabSessionLabel.textContent = `세션 (${done}/${total})`;
    }
    const isBriefing = activeViewMode === "briefing";
    el.viewTabBriefing.classList.toggle("active", isBriefing);
    el.viewTabBriefing.setAttribute("aria-selected", String(isBriefing));
    el.viewTabSession.classList.toggle("active", !isBriefing);
    el.viewTabSession.setAttribute("aria-selected", String(!isBriefing));
  }

  function setViewMode(mode, { scrollTop = true } = {}) {
    const next = mode === "briefing" ? "briefing" : "session";
    closeBriefingPeek();
    activeViewMode = next;
    renderMainStream();
    if (scrollTop) el.chatStream.scrollTop = 0;
  }

  function openBriefingPeek() {
    const topic = getActiveTopic();
    const theory = getTopicTheory(topic?.topic_code);
    if (!topic || !theory || !el.briefingPeekDrawer || !el.briefingPeekBackdrop) {
      showToast("이 토픽의 브리핑 데이터가 없습니다");
      return;
    }

    if (el.briefingPeekCode) el.briefingPeekCode.textContent = topic.topic_code;
    if (el.briefingPeekTitle) el.briefingPeekTitle.textContent = topic.topic;

    const trapsHtml = renderBriefingTrapsHtml(theory.trap_patterns);
    const tableHtml = renderBriefingTableHtml(theory.comparison_table);

    el.briefingPeekBody.innerHTML = `
      ${
        trapsHtml
          ? `
        <section class="briefing-section">
          <h3 class="briefing-section-title">
            <span class="briefing-section-index">01</span>
            <span>단골 오답 함정 패턴</span>
          </h3>
          ${trapsHtml}
        </section>
      `
          : ""
      }
      ${
        tableHtml
          ? `
        <section class="briefing-section">
          <h3 class="briefing-section-title">
            <span class="briefing-section-index">02</span>
            <span>핵심 비교·암기표</span>
          </h3>
          ${tableHtml}
        </section>
      `
          : ""
      }
      ${
        !trapsHtml && !tableHtml
          ? `<div class="empty-state">표시할 함정·비교표 데이터가 없습니다.</div>`
          : ""
      }
    `;

    briefingPeekOpen = true;
    el.briefingPeekBackdrop.classList.remove("hidden");
    el.briefingPeekDrawer.classList.remove("hidden");
    el.briefingPeekBody.scrollTop = 0;
  }

  function closeBriefingPeek() {
    if (!briefingPeekOpen) return;
    briefingPeekOpen = false;
    if (el.briefingPeekBackdrop) el.briefingPeekBackdrop.classList.add("hidden");
    if (el.briefingPeekDrawer) el.briefingPeekDrawer.classList.add("hidden");
  }

  function renderBriefingStream(subj, topic) {
    const theory = getTopicTheory(topic.topic_code);
    if (!theory) {
      el.streamInner.innerHTML = `
        <div class="empty-state">
          <div>이 토픽(${escapeHtml(topic.topic_code)})의 압축 이론 브리핑 데이터가 준비되지 않았습니다.</div>
          <button id="briefingStartSessionBtn" class="empty-state-btn" type="button">문제 풀이 세션으로 이동 →</button>
        </div>
      `;
      return;
    }

    const { done, total } = getTopicSessionCounts(topic);
    const summaryHtml = formatCoreSummaryHtml(theory.core_summary);
    const trapsHtml = renderBriefingTrapsHtml(theory.trap_patterns);
    const tableHtml = renderBriefingTableHtml(theory.comparison_table);
    const linksHtml =
      Array.isArray(theory.cross_domain_links) && theory.cross_domain_links.length > 0
        ? `
          <ul class="briefing-link-list">
            ${theory.cross_domain_links
              .map((l) => `<li class="briefing-link-item">${highlightLeadIn(formatInlineMarkdown(l))}</li>`)
              .join("")}
          </ul>
        `
        : "";

    let secNum = 0;
    const nextSec = () => String(++secNum).padStart(2, "0");

    const metaLabel = topic.is_trend
      ? `${subj.display_name} · 기술사 트렌드 ${total}건`
      : `${subj.display_name} · 빈출 ${topic.frequency_rank}위 · 풀이 ${done}/${total} · 기술사 ${topic.pe_count}건`;

    el.streamInner.innerHTML = `
      <article class="briefing-doc" aria-label="토픽 압축 이론 브리핑">
        <header class="briefing-header">
          <div class="briefing-badge-row">
            <span class="briefing-doc-tag">BRIEFING · ${escapeHtml(topic.topic_code)}</span>
            <span>${escapeHtml(metaLabel)}</span>
          </div>
          <h1 class="briefing-title">${escapeHtml(theory.topic_name || topic.topic)}</h1>
          ${topic.desc ? `<p class="briefing-subtitle">${escapeHtml(topic.desc)}</p>` : ""}
        </header>

        ${
          summaryHtml
            ? `
          <section class="briefing-section">
            <h2 class="briefing-section-title">
              <span class="briefing-section-index">${nextSec()}</span>
              <span>30초 핵심 배경</span>
            </h2>
            <div class="briefing-summary-stack">${summaryHtml}</div>
          </section>
        `
            : ""
        }

        ${
          trapsHtml
            ? `
          <section class="briefing-section">
            <h2 class="briefing-section-title">
              <span class="briefing-section-index">${nextSec()}</span>
              <span>단골 오답 함정 패턴 (${theory.trap_patterns.length})</span>
            </h2>
            ${trapsHtml}
          </section>
        `
            : ""
        }

        ${
          tableHtml
            ? `
          <section class="briefing-section">
            <h2 class="briefing-section-title">
              <span class="briefing-section-index">${nextSec()}</span>
              <span>핵심 비교·암기표</span>
            </h2>
            ${tableHtml}
          </section>
        `
            : ""
        }

        ${
          linksHtml
            ? `
          <section class="briefing-section">
            <h2 class="briefing-section-title">
              <span class="briefing-section-index">${nextSec()}</span>
              <span>타 영역 크로스오버 출제 포인트</span>
            </h2>
            ${linksHtml}
          </section>
        `
            : ""
        }

        ${
          theory.pe_trend_alert
            ? `
          <section class="briefing-section">
            <h2 class="briefing-section-title">
              <span class="briefing-section-index">${nextSec()}</span>
              <span>기술사 연계 신유형 경보</span>
            </h2>
            <details class="pe-accordion briefing-pe-alert" open>
              <summary>
                <span>기술사 출제 동향 기반 신규 예상 포인트</span>
                <span>▾</span>
              </summary>
              <div class="briefing-pe-body">${formatPeAlertHtml(theory.pe_trend_alert)}</div>
            </details>
          </section>
        `
            : ""
        }

        <div class="briefing-footer-actions">
          <button id="briefingStartSessionBtn" class="briefing-primary-btn" type="button">
            <span>${topic.is_trend ? "이 토픽 트렌드 문항 보기 →" : "이 토픽 문제 바로 풀기 →"}</span>
          </button>
          <button id="briefingCopyGemBtn" class="briefing-secondary-btn" type="button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            </svg>
            <span>이 토픽 이론 제미니에 질문 복사</span>
          </button>
        </div>
      </article>
    `;
  }

  function openGemWithPrompt(promptText) {
    // Open tab synchronously inside user gesture to satisfy mobile Safari/Chrome popup policies
    const gemUrl = getEffectiveGemUrl();
    window.open(gemUrl, "_blank", "noopener,noreferrer");
    copyTextWithFallback(promptText);
    showToast("복사 완료 · 붙여넣기 하세요");
  }

  // Renderers
  function renderSubjectTabs() {
    const activeSubj = getActiveSubject();
    el.subjectTabs.innerHTML = studyData.subjects
      .map((s) => {
        const meta = DAY_SHORT[s.subject_code] || { day: s.subject_code, name: s.raw_subject };
        const isActive = s.subject_code === activeSubj.subject_code;
        return `
          <button
            class="subject-tab ${isActive ? "active" : ""}"
            type="button"
            role="tab"
            aria-selected="${isActive}"
            data-subject="${escapeHtml(s.subject_code)}"
            title="${escapeHtml(s.display_name)}"
          >
            <span class="day-label">${escapeHtml(meta.day)}</span>
            <span class="short-label">${escapeHtml(meta.name)}</span>
          </button>
        `;
      })
      .join("");

    let solvedCount = 0;
    activeSubj.topics.forEach((t) => {
      t.gamrisa_questions.forEach((q) => {
        if (state.records[q.id]?.selected != null) solvedCount += 1;
      });
    });

    el.subjectSubtitle.innerHTML = `
      <span>${escapeHtml(activeSubj.display_name)}</span>
      <span>${solvedCount}/${activeSubj.gamrisa_count}</span>
    `;
  }

  function renderTopicList() {
    const subj = getActiveSubject();
    const activeTopic = getActiveTopic();
    const regular = subj.topics.filter((t) => !t.is_trend);
    const trend = subj.topics.filter((t) => t.is_trend);

    const renderItem = (t) => {
      const isActive = activeTopic && t.topic_code === activeTopic.topic_code;
      let statText = "";
      if (t.is_trend) {
        const checked = t.pe_questions.filter((p) => state.trendChecked[p.id]).length;
        statText = `${checked}/${t.pe_count} · 트렌드`;
      } else {
        let attempted = 0;
        let graded = 0;
        let correct = 0;
        t.gamrisa_questions.forEach((q) => {
          const r = state.records[q.id];
          if (r && r.selected != null) {
            attempted += 1;
            if (r.result === "correct" || r.result === "wrong") {
              graded += 1;
              if (r.result === "correct") correct += 1;
            }
          }
        });
        statText =
          graded > 0
            ? `${attempted}/${t.gamrisa_count} · ${Math.round((correct / graded) * 100)}%`
            : `${attempted}/${t.gamrisa_count}`;
      }

      const rankDisplay = t.is_trend ? "✦" : `${t.frequency_rank}`;
      return `
        <button
          class="topic-item ${isActive ? "active" : ""}"
          type="button"
          data-topic="${escapeHtml(t.topic_code)}"
          title="${escapeHtml(t.topic)}"
        >
          <span class="topic-item-left">
            <span class="topic-rank">${rankDisplay}</span>
            <span class="topic-name">${escapeHtml(t.topic)}</span>
          </span>
          <span class="topic-stat">${escapeHtml(statText)}</span>
        </button>
      `;
    };

    let html = `<div class="topic-divider-label">빈출 순위 토픽</div>`;
    html += regular.map(renderItem).join("");
    if (trend.length > 0) {
      html += `<div class="topic-divider-label">기술사 기반 신유형</div>`;
      html += trend.map(renderItem).join("");
    }
    el.topicList.innerHTML = html;
  }

  function renderSidebarFooterStats() {
    let totalSolved = 0;
    let dueReview = 0;
    studyData.subjects.forEach((s) => {
      s.topics.forEach((t) => {
        t.gamrisa_questions.forEach((q) => {
          const r = state.records[q.id];
          if (r && r.selected != null) totalSolved += 1;
          if (isDueForReview(r)) dueReview += 1;
        });
      });
    });
    el.sidebarStatsText.textContent = `오늘 복습 ${dueReview}건 · 전체 ${totalSolved}/${studyData.meta.gamrisa_total}`;
  }

  function renderFilterDropdown() {
    const topic = getActiveTopic();
    const isTrend = Boolean(topic && topic.is_trend);
    const badgeParts = [];
    if (state.filter !== "all") {
      badgeParts.push(FILTER_LABELS[state.filter].replace(" (1·3·7일)", ""));
    }
    if (state.sort === "random") {
      badgeParts.push("랜덤");
    }
    el.activeFilterBadge.textContent = badgeParts.length ? `· ${badgeParts.join(" · ")}` : "";

    // Compute counts across active topic (if regular) or active subject
    const pool =
      topic && !isTrend
        ? topic.gamrisa_questions
        : getActiveSubject().topics.flatMap((t) => t.gamrisa_questions);

    el.filterOptionsGroup.innerHTML = Object.keys(FILTER_LABELS)
      .map((fk) => {
        const cnt = pool.filter((q) => matchesFilter(q, fk)).length;
        const active = state.filter === fk;
        return `
          <button class="dropdown-item ${active ? "active" : ""}" type="button" data-filter="${fk}">
            <span>${active ? "✓ " : ""}${escapeHtml(FILTER_LABELS[fk])}</span>
            <span class="dropdown-item-meta">${cnt}</span>
          </button>
        `;
      })
      .join("");

    el.sortOptionsGroup.innerHTML = Object.keys(SORT_LABELS)
      .map((sk) => {
        const active = state.sort === sk;
        return `
          <button class="dropdown-item ${active ? "active" : ""}" type="button" data-sort="${sk}">
            <span>${active ? "✓ " : ""}${escapeHtml(SORT_LABELS[sk])}</span>
          </button>
        `;
      })
      .join("");
  }

  function updateComposerBar(subj, topic, q) {
    if (topic && topic.is_trend) {
      const memoKey = `trend:${topic.topic_code}`;
      el.memoInput.value = state.memos[memoKey] || "";
      el.memoInput.placeholder = "트렌드 토픽 메모 입력 (자동 저장)...";
      el.uncertainBtn.classList.add("hidden");
      el.nextBtn.title = "다음 과목 토픽";
    } else if (q) {
      const rec = state.records[q.id];
      el.memoInput.value = state.memos[q.id] || "";
      el.memoInput.placeholder = "이 문제 한 줄 메모 (자동 저장)...";
      el.uncertainBtn.classList.remove("hidden");
      const isUncertain = Boolean(rec && rec.uncertain);
      el.uncertainBtn.classList.toggle("active", isUncertain);
      el.uncertainBtn.setAttribute("aria-pressed", String(isUncertain));
      el.nextBtn.title = "다음 문제 (Enter)";
    } else {
      el.memoInput.value = "";
      el.memoInput.placeholder = "메모 입력 (자동 저장)...";
      el.uncertainBtn.classList.add("hidden");
    }
    autoResizeTextarea(el.memoInput);
  }

  function autoResizeTextarea(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(96, Math.max(36, ta.scrollHeight)) + "px";
  }

  function formatReviewHint(rec) {
    if (!rec || rec.nextReviewAt == null) {
      if (rec && rec.reviewStage === 3) return " · 복습 완료(7일 통과)";
      return "";
    }
    const diffDays = Math.max(1, Math.ceil((rec.nextReviewAt - Date.now()) / DAY_MS));
    if (isDueForReview(rec)) return " · 오늘 복습 대상";
    return ` · ${diffDays}일 후 복습 예정`;
  }

  function renderUserProfileBar() {
    if (!el.currentUserName) return;
    const uname = currentUser || "로컬 사용자";
    el.currentUserName.textContent = uname;
    el.userAvatarInitial.textContent = uname.slice(0, 1).toUpperCase();

    if (currentUser && window.StudyDB) {
      const cfg = window.StudyDB.getCloudConfig(currentUser);
      const hasCloud = cfg && cfg.provider && cfg.provider !== "none";
      if (el.manualSyncBtn) el.manualSyncBtn.classList.toggle("hidden", !hasCloud);
      if (!hasCloud) {
        setSyncStatus("로컬 DB 저장 중", false);
      }
    }

    if (el.resumeStudyBtn && el.resumeStudyDetail) {
      const lp = state.lastPosition;
      if (lp && lp.subjectCode && lp.topicCode && lp.questionId) {
        const subjMeta = DAY_SHORT[lp.subjectCode];
        const subjLabel = subjMeta ? subjMeta.name : lp.subjectCode;
        const idxLabel =
          lp.queueIndex && lp.queueTotal ? ` (${lp.queueIndex}/${lp.queueTotal})` : "";
        el.resumeStudyDetail.textContent = `${subjLabel} · ${lp.yearRound || ""} ${lp.number || ""}번${idxLabel}`;
        el.resumeStudyBtn.classList.remove("hidden");
      } else {
        el.resumeStudyBtn.classList.add("hidden");
      }
    }
  }

  function renderAiResponseBlock(subj, topic, q, rec) {
    const effAnsList = getEffectiveAnswers(q);
    const effAnsLabel = formatAnswersLabel(effAnsList);
    const sel = rec.selected;
    const isUncertain = Boolean(rec.uncertain);

    let verdictClass = "";
    let verdictText = `선택 ${CIRCLED[sel]}`;
    if (effAnsList.length > 0) {
      if (rec.result === "correct") {
        verdictClass = "ok";
        verdictText = `정답입니다 · 선택 ${CIRCLED[sel]} (정답 ${effAnsLabel})`;
      } else {
        verdictClass = "warn";
        verdictText = `오답입니다 · 선택 ${CIRCLED[sel]} / 정답 ${effAnsLabel}`;
      }
    } else if (rec.result === "correct") {
      verdictClass = "ok";
      verdictText = `맞힘 표시 · 선택 ${CIRCLED[sel]}`;
    } else if (rec.result === "wrong") {
      verdictClass = "warn";
      verdictText = `오답 표시 · 선택 ${CIRCLED[sel]}`;
    } else {
      verdictText = `선택 ${CIRCLED[sel]} · 기준 답안 미등록`;
    }

    if (isUncertain) verdictText += " · 불확실";
    verdictText += formatReviewHint(rec);

    // Self-grade & quick custom-answer controls when official answer is missing
    let selfGradeHtml = "";
    if (q.answer == null && (!Array.isArray(q.answers) || q.answers.length === 0)) {
      const effAns = effAnsList[0] ?? null;
      const okActive = rec.result === "correct" && effAns == null ? "active-ok" : "";
      const warnActive = rec.result === "wrong" && effAns == null ? "active-warn" : "";
      const ansBtns = [1, 2, 3, 4]
        .map(
          (n) =>
            `<button class="mini-ans-btn ${effAns === n ? "active" : ""}" type="button" data-register-answer="${n}" title="이 문제 정답을 ${n}번으로 등록">${CIRCLED[n]}</button>`
        )
        .join("");

      selfGradeHtml = `
        <div class="self-grade-bar">
          ${
            effAns === null
              ? `<button class="mini-pill ${okActive}" type="button" data-self-grade="correct">맞힘</button>
                 <button class="mini-pill ${warnActive}" type="button" data-self-grade="wrong">틀림</button>`
              : ""
          }
          <span class="mini-ans-group" title="정답 번호 직접 등록">
            정답:${ansBtns}
          </span>
        </div>
      `;
    }

    const kwsHtml = (q.keywords || [])
      .map((kw) => `<span class="kw-chip">#${escapeHtml(kw)}</span>`)
      .join("");

    const peList = topic.pe_questions || [];
    const trendTopic = getSubjectTrendTopic(subj);
    const trendKws = trendTopic && trendTopic.top_keywords ? trendTopic.top_keywords.slice(0, 6) : [];

    const peBodyHtml =
      peList.length > 0
        ? peList
            .map(
              (p) => `
              <div class="pe-ref-item">
                <div class="pe-ref-meta">${escapeHtml(p.exam_type)} · ${escapeHtml(p.year_round)} ${escapeHtml(p.session)} ${p.number}번</div>
                <div class="pe-ref-q">${escapeHtml(p.question)}</div>
                <div class="pe-ref-note">${escapeHtml(p.relevance_note || "")}</div>
              </div>
            `
            )
            .join("")
        : `<div class="pe-ref-item"><div class="pe-ref-note">이 토픽에 직접 연결된 기술사 기출이 없습니다.</div></div>`;

    const trendBridgeHtml =
      trendTopic && trendTopic.pe_count > 0
        ? `
          <div class="trend-bridge-row">
            <span>신규 예상 키워드: ${escapeHtml(trendKws.join(" · "))}</span>
            <button class="trend-jump-btn" type="button" data-jump-topic="${escapeHtml(trendTopic.topic_code)}">
              ${escapeHtml(subj.raw_subject)} 트렌드(${trendTopic.pe_count}) 보기
            </button>
          </div>
        `
        : "";

    const peekBriefingBtnHtml = getTopicTheory(topic.topic_code)
      ? `
          <button id="peekBriefingBtn" class="action-chip-btn" type="button" title="현재 토픽 오답 함정·비교표 빠르게 보기">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
            </svg>
            <span>브리핑 보기</span>
          </button>
        `
      : "";

    const copyImgBtnHtml =
      q.has_image && q.image_path
        ? `
          <button id="geminiCopyImageBtn" class="action-chip-btn" type="button">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
              <circle cx="8.5" cy="8.5" r="1.5"/>
              <polyline points="21 15 16 10 5 21"/>
            </svg>
            <span>그림 복사</span>
          </button>
        `
        : "";

    return `
      <article class="ai-response" aria-label="해설 응답">
        <div class="ai-avatar" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round">
            <path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>
          </svg>
        </div>
        <div class="ai-response-body">
          <div class="ai-status-row">
            <span class="verdict-text ${verdictClass}">${escapeHtml(verdictText)}</span>
            ${selfGradeHtml}
          </div>

          <p class="ai-explanation">${escapeHtml(q.short_explanation || "핵심 해설이 준비되지 않았습니다.")}</p>

          ${kwsHtml ? `<div class="keyword-row">${kwsHtml}</div>` : ""}

          <details class="pe-accordion">
            <summary>
              <span>연관 기술사 기출 참고 (${peList.length}건) · 신규 트렌드 키워드</span>
              <span>▾</span>
            </summary>
            <div class="pe-accordion-body">
              ${peBodyHtml}
              ${trendBridgeHtml}
            </div>
          </details>

          <div class="ai-action-bar">
            ${peekBriefingBtnHtml}

            <button id="geminiExplainBtn" class="action-chip-btn" type="button">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              <span>오답 1:1 해설 + 제미니 열기</span>
            </button>

            <button id="geminiVariantBtn" class="action-chip-btn" type="button">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10"/>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
              <span>기술사 연계 변형문제 생성</span>
            </button>

            ${copyImgBtnHtml}
          </div>
        </div>
      </article>
    `;
  }

  function renderTrendStream(subj, topic) {
    const checkedCnt = topic.pe_questions.filter((p) => state.trendChecked[p.id]).length;
    const kwHtml = (topic.top_keywords || [])
      .map((k) => `<span class="kw-chip">#${escapeHtml(k)}</span>`)
      .join("");

    const cardsHtml = topic.pe_questions
      .map((p) => {
        const isChecked = Boolean(state.trendChecked[p.id]);
        const pKws = (p.keywords || []).map((k) => `<span class="kw-chip">#${escapeHtml(k)}</span>`).join("");
        return `
          <div class="trend-pe-card ${isChecked ? "checked" : ""}" data-pe-id="${escapeHtml(p.id)}">
            <div class="trend-pe-top">
              <span class="question-source-pill">
                <span>${escapeHtml(p.exam_type)} · ${escapeHtml(p.year_round)} ${escapeHtml(p.session)} ${p.number}번</span>
              </span>
              <button class="mini-pill ${isChecked ? "active-ok" : ""}" type="button" data-toggle-trend="${escapeHtml(p.id)}">
                ${isChecked ? "✓ 확인 완료" : "확인 표시"}
              </button>
            </div>
            <div class="question-body">${escapeHtml(p.question)}</div>
            ${pKws ? `<div class="keyword-row" style="margin-top:8px;">${pKws}</div>` : ""}
            <div class="pe-ref-note" style="margin-top:6px;">${escapeHtml(p.relevance_note || "")}</div>
            <div class="trend-pe-actions">
              <button class="action-chip-btn" type="button" data-trend-gem="${escapeHtml(p.id)}">
                이 트렌드로 감리사 예상문제 생성
              </button>
            </div>
          </div>
        `;
      })
      .join("");

    el.streamInner.innerHTML = `
      <div class="stream-context-bar">
        <span class="stream-topic-title">${escapeHtml(subj.display_name)} · ${escapeHtml(topic.topic)}</span>
        <span class="nav-counter">${checkedCnt}/${topic.pe_count} 확인</span>
      </div>
      <div class="trend-intro-card">
        <h2 class="trend-intro-title">${escapeHtml(topic.topic_code)} ${escapeHtml(topic.topic)}</h2>
        <p class="trend-intro-desc">${escapeHtml(topic.desc)}</p>
        <div class="keyword-row">${kwHtml}</div>
      </div>
      ${cardsHtml || `<div class="empty-state">등록된 트렌드 문항이 없습니다.</div>`}
    `;
    updateComposerBar(subj, topic, null);
  }

  function renderMainStream() {
    const subj = getActiveSubject();
    const topic = getActiveTopic();
    if (!subj || !topic) return;

    renderViewModeBar();

    if (el.streamInner) {
      el.streamInner.classList.toggle("is-briefing-mode", activeViewMode === "briefing");
    }

    if (activeViewMode === "briefing") {
      if (el.composerBar) el.composerBar.classList.add("hidden");
      renderBriefingStream(subj, topic);
      return;
    }

    if (el.composerBar) el.composerBar.classList.remove("hidden");

    if (topic.is_trend) {
      renderTrendStream(subj, topic);
      return;
    }

    if (currentQueue.length === 0) {
      el.streamInner.innerHTML = `
        <div class="stream-context-bar">
          <span class="stream-topic-title">${escapeHtml(topic.topic)}</span>
          <span class="nav-counter">0 / 0</span>
        </div>
        <div class="empty-state">
          <div>'${escapeHtml(FILTER_LABELS[state.filter])}' 조건에 해당하는 문항이 없습니다.</div>
          ${
            state.filter !== "all"
              ? `<button id="resetFilterEmptyBtn" class="empty-state-btn" type="button">전체 문항 보기</button>`
              : ""
          }
        </div>
      `;
      updateComposerBar(subj, topic, null);
      return;
    }

    const q = currentQueue[currentIndex];
    const rec = state.records[q.id] || null;
    const effAnsList = getEffectiveAnswers(q);
    const effAnsLabel = formatAnswersLabel(effAnsList);
    const isAnswered = Boolean(rec && rec.selected != null);
    const isPeeked = Boolean(peekedQuestions[q.id]);
    const revealAnswer = isAnswered || Boolean(state.alwaysShowAnswer) || isPeeked;
    const hasImg = Boolean(q.has_image && q.image_path);
    const useInverted = state.theme !== "light" && state.invertImages && !perQuestionOriginalColor[q.id];

    // Topic progress stats
    let topicSolved = 0;
    let topicCorrect = 0;
    let topicGraded = 0;
    topic.gamrisa_questions.forEach((item) => {
      const r = state.records[item.id];
      if (r && r.selected != null) {
        topicSolved += 1;
        if (r.result === "correct" || r.result === "wrong") {
          topicGraded += 1;
          if (r.result === "correct") topicCorrect += 1;
        }
      }
    });
    const progressPct =
      topic.gamrisa_count > 0 ? Math.round((topicSolved / topic.gamrisa_count) * 100) : 0;
    const accLabel =
      topicGraded > 0 ? ` · 정답률 ${Math.round((topicCorrect / topicGraded) * 100)}%` : "";

    // Question number navigator grid (collapsible)
    const navCellsHtml = navigatorOpen
      ? currentQueue
          .map((item, idx) => {
            const r = state.records[item.id];
            let cls = "";
            if (r && r.selected != null) {
              if (r.result === "correct") cls = "st-correct";
              else if (r.result === "wrong") cls = "st-wrong";
              else if (r.uncertain) cls = "st-uncertain";
            }
            if (idx === currentIndex) cls += " is-current";
            return `<button class="q-nav-cell ${cls}" type="button" data-jump-idx="${idx}" title="${escapeHtml(item.year_round)} ${item.number}번">${idx + 1}</button>`;
          })
          .join("")
      : "";

    const navigatorHtml = navigatorOpen
      ? `
        <div id="qNavigatorPanel" class="q-navigator-panel">
          <div class="q-navigator-header">
            <span>문항 번호 이동 (${currentQueue.length}문항)</span>
            <span class="q-navigator-legend">
              <span><i class="legend-dot ok"></i>정답</span>
              <span><i class="legend-dot warn"></i>오답</span>
              <span><i class="legend-dot idle"></i>미풀이</span>
            </span>
          </div>
          <div class="q-navigator-grid">${navCellsHtml}</div>
        </div>
      `
      : "";

    const questionContentHtml = hasImg
      ? `
        <div class="q-image-wrap dark-mode-wrap">
          <button id="toggleImgColorBtn" class="img-color-toggle" type="button">
            ${useInverted ? "원본 색상" : "다크 반전"}
          </button>
          <img
            id="questionCropImg"
            class="q-image ${useInverted ? "dark-inverted" : ""}"
            src="${escapeHtml(resolveImageUrl(q.image_path))}"
            alt="${escapeHtml(q.year_round)} ${q.number}번 문제"
            loading="eager"
          />
        </div>
        <div class="img-tap-hint">이미지를 탭하면 전체 화면으로 확대됩니다</div>
      `
      : `<div class="question-body">${escapeHtml(q.question)}</div>`;

    const optionsHtml = [1, 2, 3, 4]
      .map((n) => {
        const selected = rec && rec.selected === n;
        const isCorrectOpt = effAnsList.includes(n);
        let stateCls = selected ? "selected" : "";
        let badgeHtml = "";

        if (revealAnswer) {
          if (effAnsList.length > 0) {
            if (isCorrectOpt) {
              stateCls += " is-correct";
              badgeHtml = `<span class="option-badge ok">정답</span>`;
            } else if (selected) {
              stateCls += " is-wrong";
              badgeHtml = `<span class="option-badge warn">내 선택</span>`;
            }
          } else if (selected && rec.result === "correct") {
            stateCls += " is-correct";
          } else if (selected && rec.result === "wrong") {
            stateCls += " is-wrong";
          }
        }
        const optText = (q.options && q.options[String(n)]) || "";
        return `
          <button class="option-chip ${stateCls}" type="button" data-option="${n}">
            <span class="option-num">${CIRCLED[n]}</span>
            ${hasImg ? "" : `<span class="option-text">${escapeHtml(optText)}</span>`}
            ${badgeHtml}
          </button>
        `;
      })
      .join("");

    // Inline answer banner when user peeks or has Always-Show-Answer enabled before selecting
    let answerPreviewHtml = "";
    if (!isAnswered && revealAnswer && effAnsList.length > 0) {
      answerPreviewHtml = `
        <div class="answer-preview-banner">
          <span>공식 정답: ${escapeHtml(effAnsLabel)}</span>
          <span style="font-size:11.5px;font-weight:400;opacity:0.85;">보기를 누르면 풀이 기록에 저장됩니다</span>
        </div>
      `;
    }

    const aiResponseHtml = isAnswered ? renderAiResponseBlock(subj, topic, q, rec) : "";

    const peekBtnHtml =
      !isAnswered && !state.alwaysShowAnswer && effAnsList.length > 0
        ? `<button id="peekAnswerBtn" class="peek-ans-btn ${isPeeked ? "active" : ""}" type="button" title="정답 미리 보기 (A)">${isPeeked ? `정답 ${escapeHtml(effAnsLabel)}` : "정답 보기"}</button>`
        : "";

    const resetQBtnHtml = isAnswered
      ? `<button id="resetSingleQBtn" class="reset-q-btn" type="button" title="이 문제 풀이 기록 지우기">다시 풀기</button>`
      : "";

    el.streamInner.innerHTML = `
      <div class="stream-context-bar">
        <span class="stream-topic-title">
          [빈출 ${topic.frequency_rank}위] ${escapeHtml(topic.topic)} · 기술사 ${topic.pe_count}건 연계
        </span>
        <div class="nav-pair">
          <button id="prevQBtn" class="nav-mini-btn" type="button" ${currentIndex === 0 ? "disabled" : ""} aria-label="이전 문제" title="이전 문제 (←)">‹</button>
          <button id="qNavToggleBtn" class="nav-counter-btn" type="button" title="문항 번호 목록 열기/닫기">${currentIndex + 1} / ${currentQueue.length} ▾</button>
          <button id="nextQBtn" class="nav-mini-btn" type="button" ${currentIndex >= currentQueue.length - 1 ? "disabled" : ""} aria-label="다음 문제" title="다음 문제 (→)">›</button>
        </div>
      </div>

      <div class="topic-progress-strip">
        <div class="topic-progress-track">
          <div class="topic-progress-fill" style="width:${progressPct}%"></div>
        </div>
        <span class="topic-progress-label">풀이 ${topicSolved}/${topic.gamrisa_count} (${progressPct}%)${accLabel}</span>
      </div>

      ${navigatorHtml}

      <section class="question-card" aria-label="문제 본문">
        <div class="question-meta-row">
          <span class="question-source-pill">
            <span>${escapeHtml(q.year_round)} ${q.number}번</span>
            <span>·</span>
            <span>${escapeHtml(q.topic_code)}</span>
          </span>
          <div class="question-meta-actions">
            ${rec && rec.uncertain ? `<span class="question-flag-pill">불확실</span>` : ""}
            ${peekBtnHtml}
            ${resetQBtnHtml}
          </div>
        </div>
        ${questionContentHtml}
      </section>

      <section class="options-list ${hasImg ? "compact-grid" : ""}" aria-label="선택지">
        ${optionsHtml}
      </section>

      ${answerPreviewHtml}
      ${aiResponseHtml}
    `;

    updateComposerBar(subj, topic, q);
  }

  function renderAll({ rebuildQueue = false, keepCurrentQid = null } = {}) {
    applyTheme();
    applySidebarCollapse();
    renderUserProfileBar();
    renderSubjectTabs();
    renderTopicList();
    renderSidebarFooterStats();
    renderFilterDropdown();
    if (rebuildQueue) {
      buildQueueForTopic(getActiveTopic(), keepCurrentQid);
    }
    renderMainStream();
  }

  // Navigation & Actions
  function selectSubject(subjectCode) {
    if (state.activeSubjectCode === subjectCode) return;
    closeBriefingPeek();
    state.activeSubjectCode = subjectCode;
    const subj = getActiveSubject();
    const firstTopic = subj.topics[0] || null;
    state.activeTopicCode = firstTopic ? firstTopic.topic_code : null;
    activeViewMode = resolveInitialViewMode(firstTopic);
    currentIndex = 0;
    navigatorOpen = false;
    saveState();
    renderAll({ rebuildQueue: true });
    el.chatStream.scrollTop = 0;
  }

  function selectTopic(topicCode, targetQid = null) {
    closeBriefingPeek();
    state.activeTopicCode = topicCode;
    const topic = getActiveTopic();
    activeViewMode = resolveInitialViewMode(topic, { forceSession: Boolean(targetQid) });
    currentIndex = 0;
    navigatorOpen = false;
    saveState();
    renderAll({ rebuildQueue: true, keepCurrentQid: targetQid });
    el.chatStream.scrollTop = 0;
    if (isMobileViewport()) setMobileSidebarOpen(false);
  }

  function jumpToQuestionIndex(idx) {
    if (idx < 0 || idx >= currentQueue.length) return;
    currentIndex = idx;
    const q = currentQueue[currentIndex];
    if (q) {
      recordCurrentPosition(q);
      saveState();
      renderUserProfileBar();
    }
    renderMainStream();
    el.chatStream.scrollTop = 0;
  }

  function goNextQuestion() {
    const topic = getActiveTopic();
    if (topic && topic.is_trend) {
      const subj = getActiveSubject();
      const idx = subj.topics.findIndex((t) => t.topic_code === topic.topic_code);
      const next = subj.topics[(idx + 1) % subj.topics.length];
      if (next) selectTopic(next.topic_code);
      return;
    }
    if (currentQueue.length === 0) return;
    if (currentIndex < currentQueue.length - 1) {
      jumpToQuestionIndex(currentIndex + 1);
    } else {
      showToast("현재 토픽의 마지막 문항입니다");
    }
  }

  function goPrevQuestion() {
    if (currentIndex > 0) {
      jumpToQuestionIndex(currentIndex - 1);
    }
  }

  function resumeLastPosition() {
    const lp = state.lastPosition;
    if (!lp || !lp.subjectCode || !lp.topicCode) {
      showToast("저장된 최근 학습 위치가 없습니다");
      return;
    }
    closeBriefingPeek();
    state.activeSubjectCode = lp.subjectCode;
    state.activeTopicCode = lp.topicCode;
    state.filter = "all";
    activeViewMode = "session";
    saveState();
    renderAll({ rebuildQueue: true, keepCurrentQid: lp.questionId || null });
    el.chatStream.scrollTop = 0;
    if (isMobileViewport()) setMobileSidebarOpen(false);
    showToast(`이어서 풀기: ${lp.yearRound || ""} ${lp.number || ""}번`);
  }

  function toggleStealth(force) {
    stealthActive = force !== undefined ? Boolean(force) : !stealthActive;
    el.stealthScreen.classList.toggle("hidden", !stealthActive);
    if (stealthActive) {
      closeBriefingPeek();
      closeSettings();
      closeLightbox();
      el.filterMenu.classList.add("hidden");
      setMobileSidebarOpen(false);
    }
  }

  function openLightbox(qid, imgPath) {
    lightboxQid = qid;
    const useInverted = state.theme !== "light" && state.invertImages && !perQuestionOriginalColor[qid];
    el.lightboxImg.src = resolveImageUrl(imgPath);
    el.lightboxImg.classList.toggle("dark-inverted", useInverted);
    el.lightboxInvertBtn.textContent = useInverted ? "원본 색상" : "다크 반전";
    el.lightboxModal.classList.remove("hidden");
  }

  function closeLightbox() {
    lightboxQid = null;
    el.lightboxModal.classList.add("hidden");
    el.lightboxImg.src = "";
  }

  function updateSettingsCloudFields(provider) {
    if (el.settingsGistFields) el.settingsGistFields.classList.toggle("hidden", provider !== "gist");
    if (el.settingsSupabaseFields) el.settingsSupabaseFields.classList.toggle("hidden", provider !== "supabase");
  }

  function openSettings() {
    el.gemUrlInput.value = state.gemUrl || "";
    const solved = Object.values(state.records).filter((r) => r && r.selected != null).length;
    const correct = Object.values(state.records).filter((r) => r && r.result === "correct").length;
    const wrong = Object.values(state.records).filter((r) => r && r.result === "wrong").length;
    el.settingsProgressMeta.textContent = `계정(${currentUser || "-"}) 기록: 풀이 ${solved}/${studyData?.meta?.gamrisa_total || 1560}건 · 정답 ${correct}건 · 오답 ${wrong}건`;

    if (currentUser && window.StudyDB && el.cloudProviderSelect) {
      const cfg = window.StudyDB.getCloudConfig(currentUser);
      el.cloudProviderSelect.value = cfg.provider || "none";
      if (el.settingsGithubToken) el.settingsGithubToken.value = cfg.githubToken || "";
      if (el.settingsSupabaseUrl) el.settingsSupabaseUrl.value = cfg.supabaseUrl || "";
      if (el.settingsSupabaseKey) el.settingsSupabaseKey.value = cfg.supabaseKey || "";
      updateSettingsCloudFields(cfg.provider || "none");
    }

    el.settingsModal.classList.remove("hidden");
  }

  function closeSettings() {
    el.settingsModal.classList.add("hidden");
  }

  // Event Binding
  function bindEvents() {
    // Sidebar toggle
    el.sidebarToggleBtn.addEventListener("click", () => {
      if (isMobileViewport()) {
        setMobileSidebarOpen(!el.appShell.classList.contains("mobile-sidebar-open"));
      } else {
        state.sidebarCollapsed = !state.sidebarCollapsed;
        saveState();
        applySidebarCollapse();
      }
    });

    el.sidebarCloseBtn.addEventListener("click", () => {
      if (isMobileViewport()) {
        setMobileSidebarOpen(false);
      } else {
        state.sidebarCollapsed = true;
        saveState();
        applySidebarCollapse();
      }
    });

    el.sidebarBackdrop.addEventListener("click", () => setMobileSidebarOpen(false));

    // Subject tabs
    el.subjectTabs.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-subject]");
      if (btn) selectSubject(btn.dataset.subject);
    });

    // Topic list
    el.topicList.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-topic]");
      if (btn) selectTopic(btn.dataset.topic);
    });

    // Due review shortcut
    el.dueReviewShortcutBtn.addEventListener("click", () => {
      closeBriefingPeek();
      const subj = getActiveSubject();
      if (getActiveTopic()?.is_trend && subj.topics[0]) {
        state.activeTopicCode = subj.topics[0].topic_code;
      }
      state.filter = "review";
      activeViewMode = "session";
      currentIndex = 0;
      saveState();
      renderAll({ rebuildQueue: true });
      if (isMobileViewport()) setMobileSidebarOpen(false);
    });

    // View mode tabs (Briefing / Session)
    if (el.viewTabBriefing) {
      el.viewTabBriefing.addEventListener("click", () => setViewMode("briefing"));
    }
    if (el.viewTabSession) {
      el.viewTabSession.addEventListener("click", () => setViewMode("session"));
    }

    // Briefing Peek Drawer controls
    if (el.briefingPeekBackdrop) {
      el.briefingPeekBackdrop.addEventListener("click", closeBriefingPeek);
    }
    if (el.briefingPeekCloseBtn) {
      el.briefingPeekCloseBtn.addEventListener("click", closeBriefingPeek);
    }
    if (el.briefingPeekFullBtn) {
      el.briefingPeekFullBtn.addEventListener("click", () => setViewMode("briefing"));
    }

    // Header Filter Dropdown
    el.filterDropdownBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = el.filterMenu.classList.contains("hidden");
      el.filterMenu.classList.toggle("hidden", !willOpen);
      el.filterDropdownBtn.setAttribute("aria-expanded", String(willOpen));
    });

    el.filterMenu.addEventListener("click", (e) => {
      const filterBtn = e.target.closest("[data-filter]");
      const sortBtn = e.target.closest("[data-sort]");
      if (filterBtn) {
        state.filter = filterBtn.dataset.filter;
        activeViewMode = "session";
        currentIndex = 0;
        saveState();
        el.filterMenu.classList.add("hidden");
        renderAll({ rebuildQueue: true });
      } else if (sortBtn) {
        state.sort = sortBtn.dataset.sort;
        activeViewMode = "session";
        currentIndex = 0;
        randomSeedKey = "";
        saveState();
        el.filterMenu.classList.add("hidden");
        renderAll({ rebuildQueue: true });
      }
    });

    document.addEventListener("click", (e) => {
      if (!el.filterMenu.classList.contains("hidden")) {
        if (!e.target.closest(".model-dropdown-wrap")) {
          el.filterMenu.classList.add("hidden");
          el.filterDropdownBtn.setAttribute("aria-expanded", "false");
        }
      }
    });

    // Main stream delegation
    el.streamInner.addEventListener("click", (e) => {
      const subj = getActiveSubject();
      const topic = getActiveTopic();
      const q = currentQueue[currentIndex];

      if (e.target.closest("#resetFilterEmptyBtn")) {
        state.filter = "all";
        currentIndex = 0;
        saveState();
        renderAll({ rebuildQueue: true });
        return;
      }
      if (e.target.closest("#prevQBtn")) {
        goPrevQuestion();
        return;
      }
      if (e.target.closest("#nextQBtn")) {
        goNextQuestion();
        return;
      }
      if (e.target.closest("#qNavToggleBtn")) {
        navigatorOpen = !navigatorOpen;
        renderMainStream();
        return;
      }
      const jumpIdxBtn = e.target.closest("[data-jump-idx]");
      if (jumpIdxBtn) {
        const idx = Number(jumpIdxBtn.dataset.jumpIdx);
        navigatorOpen = false;
        jumpToQuestionIndex(idx);
        return;
      }

      // Peek answer toggle (before selecting)
      if (e.target.closest("#peekAnswerBtn") && q) {
        peekedQuestions[q.id] = !peekedQuestions[q.id];
        renderMainStream();
        return;
      }

      // Reset single question record
      if (e.target.closest("#resetSingleQBtn") && q) {
        delete state.records[q.id];
        delete peekedQuestions[q.id];
        saveState();
        renderSubjectTabs();
        renderTopicList();
        renderSidebarFooterStats();
        renderFilterDropdown();
        renderMainStream();
        showToast("이 문제의 풀이 기록을 초기화했습니다");
        return;
      }

      // Image color toggle
      if (e.target.closest("#toggleImgColorBtn") && q) {
        perQuestionOriginalColor[q.id] = !perQuestionOriginalColor[q.id];
        renderMainStream();
        return;
      }

      // Image lightbox open
      if (e.target.closest("#questionCropImg") && q) {
        openLightbox(q.id, q.image_path);
        return;
      }

      // 4-choice option select
      const optBtn = e.target.closest("[data-option]");
      if (optBtn && q) {
        const chosen = Number(optBtn.dataset.option);
        applyRecordUpdate(q, { selected: chosen });
        renderUserProfileBar();
        renderSubjectTabs();
        renderTopicList();
        renderSidebarFooterStats();
        renderFilterDropdown();
        renderMainStream();
        return;
      }

      // Self-grade (correct/wrong)
      const selfBtn = e.target.closest("[data-self-grade]");
      if (selfBtn && q) {
        applyRecordUpdate(q, { selfResult: selfBtn.dataset.selfGrade });
        renderTopicList();
        renderSidebarFooterStats();
        renderFilterDropdown();
        renderMainStream();
        return;
      }

      // Register custom answer inline
      const ansBtn = e.target.closest("[data-register-answer]");
      if (ansBtn && q) {
        const ansNum = Number(ansBtn.dataset.registerAnswer);
        if (state.customAnswers[q.id] === ansNum) {
          delete state.customAnswers[q.id];
        } else {
          state.customAnswers[q.id] = ansNum;
        }
        applyRecordUpdate(q, {});
        renderTopicList();
        renderSidebarFooterStats();
        renderFilterDropdown();
        renderMainStream();
        return;
      }

      // Jump to trend topic from accordion
      const jumpBtn = e.target.closest("[data-jump-topic]");
      if (jumpBtn) {
        selectTopic(jumpBtn.dataset.jumpTopic);
        return;
      }

      // Briefing view action buttons
      if (e.target.closest("#briefingStartSessionBtn")) {
        setViewMode("session");
        return;
      }
      if (e.target.closest("#briefingCopyGemBtn") && subj && topic) {
        const theory = getTopicTheory(topic.topic_code);
        if (theory) {
          openGemWithPrompt(buildGeminiBriefingPrompt(subj, topic, theory));
        } else {
          showToast("복사할 브리핑 데이터가 없습니다");
        }
        return;
      }

      // Quick briefing peek button inside AI explanation bar
      if (e.target.closest("#peekBriefingBtn")) {
        openBriefingPeek();
        return;
      }

      // Gemini Action Buttons
      if (e.target.closest("#geminiExplainBtn") && q) {
        const rec = state.records[q.id] || {};
        openGemWithPrompt(buildGeminiExplainPrompt(subj, topic, q, rec));
        return;
      }
      if (e.target.closest("#geminiVariantBtn") && q) {
        openGemWithPrompt(buildGeminiVariantPrompt(subj, topic, q));
        return;
      }
      if (e.target.closest("#geminiCopyImageBtn") && q) {
        copyOrSaveImage(q.image_path, q.id);
        return;
      }

      // Trend mode buttons
      const trendCheckBtn = e.target.closest("[data-toggle-trend]");
      if (trendCheckBtn && topic?.is_trend) {
        const peId = trendCheckBtn.dataset.toggleTrend;
        if (state.trendChecked[peId]) delete state.trendChecked[peId];
        else state.trendChecked[peId] = true;
        saveState();
        renderTopicList();
        renderMainStream();
        return;
      }

      const trendGemBtn = e.target.closest("[data-trend-gem]");
      if (trendGemBtn && topic?.is_trend) {
        const peId = trendGemBtn.dataset.trendGem;
        const pe = topic.pe_questions.find((p) => p.id === peId);
        if (pe) openGemWithPrompt(buildTrendMockPrompt(subj, pe));
        return;
      }
    });

    // Always-show-answer toggle (Top bar & Settings)
    if (el.alwaysShowAnsBtn) {
      el.alwaysShowAnsBtn.addEventListener("click", () => {
        state.alwaysShowAnswer = !state.alwaysShowAnswer;
        saveState();
        applyTheme();
        renderMainStream();
        showToast(state.alwaysShowAnswer ? "항상 정답 표시 (암기 모드) 켜짐" : "정답 숨김 (실전 풀이 모드)");
      });
    }
    if (el.alwaysShowAnsCheckbox) {
      el.alwaysShowAnsCheckbox.addEventListener("change", () => {
        state.alwaysShowAnswer = el.alwaysShowAnsCheckbox.checked;
        saveState();
        applyTheme();
        renderMainStream();
      });
    }

    // Sidebar Profile: Resume / Sync / Switch Account
    if (el.resumeStudyBtn) {
      el.resumeStudyBtn.addEventListener("click", resumeLastPosition);
    }
    if (el.manualSyncBtn) {
      el.manualSyncBtn.addEventListener("click", () => syncWithCloudNow({ silent: false }));
    }
    if (el.logoutBtn) {
      el.logoutBtn.addEventListener("click", () => {
        window.StudyDB.setSavedSession(null, false);
        currentUser = null;
        showAuthOverlay();
      });
    }

    // Auth Overlay Controls
    if (el.authTabLogin) {
      el.authTabLogin.addEventListener("click", () => setAuthMode("login"));
    }
    if (el.authTabRegister) {
      el.authTabRegister.addEventListener("click", () => setAuthMode("register"));
    }
    if (el.authCloudProvider) {
      el.authCloudProvider.addEventListener("change", () => {
        const p = el.authCloudProvider.value;
        el.authGistFields.classList.toggle("hidden", p !== "gist");
        el.authSupabaseFields.classList.toggle("hidden", p !== "supabase");
      });
    }
    if (el.savedAccountsList) {
      el.savedAccountsList.addEventListener("click", async (e) => {
        const btn = e.target.closest("[data-quick-user]");
        if (!btn) return;
        const uname = btn.dataset.quickUser;
        const acc = await window.StudyDB.getAccount(uname);
        if (acc && !acc.hasPassword) {
          await completeSignIn(uname, el.authRememberCheckbox?.checked ?? true);
        } else {
          setAuthMode("login");
          el.authUsernameInput.value = uname;
          el.authPasswordInput.focus();
        }
      });
    }
    if (el.authForm) {
      el.authForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        el.authErrorMsg.classList.add("hidden");
        const uname = (el.authUsernameInput.value || "").trim();
        const pw = el.authPasswordInput.value || "";
        const remember = Boolean(el.authRememberCheckbox?.checked);

        const prov = el.authCloudProvider?.value || "none";
        let pendingCloudCfg = null;
        if (prov === "gist" && el.authGithubToken?.value.trim()) {
          pendingCloudCfg = {
            provider: "gist",
            githubToken: el.authGithubToken.value.trim(),
          };
        } else if (
          prov === "supabase" &&
          el.authSupabaseUrl?.value.trim() &&
          el.authSupabaseKey?.value.trim()
        ) {
          pendingCloudCfg = {
            provider: "supabase",
            supabaseUrl: el.authSupabaseUrl.value.trim(),
            supabaseKey: el.authSupabaseKey.value.trim(),
            supabaseTable: "study_sync",
          };
        }

        let res =
          authMode === "register"
            ? await window.StudyDB.registerAccount(uname, pw)
            : await window.StudyDB.loginAccount(uname, pw);

        // If logging in on a brand-new device (e.g. mobile) with Cloud Sync credentials,
        // auto-register locally so cloud records can be pulled right away
        if (!res.ok && authMode === "login" && pendingCloudCfg) {
          const exists = await window.StudyDB.getAccount(uname);
          if (!exists) {
            res = await window.StudyDB.registerAccount(uname, pw);
          }
        }

        if (!res.ok) {
          el.authErrorMsg.textContent = res.error || "로그인에 실패했습니다.";
          el.authErrorMsg.classList.remove("hidden");
          return;
        }

        if (pendingCloudCfg) {
          window.StudyDB.saveCloudConfig(uname, pendingCloudCfg);
        }

        await completeSignIn(uname, remember);
      });
    }

    // Bottom Composer (Memo auto-save + Uncertain + Next)
    el.memoInput.addEventListener("input", () => {
      autoResizeTextarea(el.memoInput);
      const topic = getActiveTopic();
      let key = null;
      if (topic && topic.is_trend) {
        key = `trend:${topic.topic_code}`;
      } else {
        const q = currentQueue[currentIndex];
        if (q) key = q.id;
      }
      if (!key) return;
      const val = el.memoInput.value;
      if (val.trim()) state.memos[key] = val;
      else delete state.memos[key];
      saveState();
      el.memoSavedHint.classList.add("visible");
      clearTimeout(memoHintTimer);
      memoHintTimer = setTimeout(() => {
        el.memoSavedHint.classList.remove("visible");
      }, 1200);
    });

    el.memoInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        el.memoInput.blur();
        el.memoSavedHint.classList.add("visible");
        clearTimeout(memoHintTimer);
        memoHintTimer = setTimeout(() => {
          el.memoSavedHint.classList.remove("visible");
        }, 1200);
      }
    });

    el.uncertainBtn.addEventListener("click", () => {
      const q = currentQueue[currentIndex];
      if (!q) return;
      applyRecordUpdate(q, { toggleUncertain: true });
      renderTopicList();
      renderSidebarFooterStats();
      renderFilterDropdown();
      renderMainStream();
    });

    el.nextBtn.addEventListener("click", goNextQuestion);

    // Stealth controls
    el.stealthBtn.addEventListener("click", () => toggleStealth(true));
    el.stealthReturnBtn.addEventListener("click", () => toggleStealth(false));
    el.stealthSubmitBtn.addEventListener("click", () => {
      if (el.stealthInput.value.trim()) el.stealthInput.value = "";
    });
    el.stealthInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        el.stealthInput.value = "";
      }
    });

    // Lightbox controls
    el.lightboxCloseBtn.addEventListener("click", closeLightbox);
    el.lightboxModal.addEventListener("click", (e) => {
      if (e.target === el.lightboxModal || e.target.id === "lightboxBody") {
        closeLightbox();
      }
    });
    el.lightboxInvertBtn.addEventListener("click", () => {
      if (!lightboxQid) return;
      perQuestionOriginalColor[lightboxQid] = !perQuestionOriginalColor[lightboxQid];
      const useInverted =
        state.theme !== "light" && state.invertImages && !perQuestionOriginalColor[lightboxQid];
      el.lightboxImg.classList.toggle("dark-inverted", useInverted);
      el.lightboxInvertBtn.textContent = useInverted ? "원본 색상" : "다크 반전";
      renderMainStream();
    });

    // Settings Modal
    el.settingsBtn.addEventListener("click", openSettings);
    el.settingsCloseBtn.addEventListener("click", closeSettings);
    el.settingsModal.addEventListener("click", (e) => {
      if (e.target === el.settingsModal) closeSettings();
    });

    el.themeDarkBtn.addEventListener("click", () => {
      state.theme = "dark";
      saveState();
      renderAll();
    });
    el.themeLightBtn.addEventListener("click", () => {
      state.theme = "light";
      saveState();
      renderAll();
    });

    if (el.defaultViewBriefingBtn) {
      el.defaultViewBriefingBtn.addEventListener("click", () => {
        state.defaultTopicView = "briefing";
        writeSavedDefaultTopicView("briefing");
        saveState();
        applyTheme();
        showToast("토픽 선택 시 브리핑을 먼저 표시합니다");
      });
    }
    if (el.defaultViewSessionBtn) {
      el.defaultViewSessionBtn.addEventListener("click", () => {
        state.defaultTopicView = "session";
        writeSavedDefaultTopicView("session");
        saveState();
        applyTheme();
        showToast("토픽 선택 시 바로 문제 풀이로 진입합니다");
      });
    }

    el.defaultInvertCheckbox.addEventListener("change", () => {
      state.invertImages = el.defaultInvertCheckbox.checked;
      saveState();
      renderMainStream();
    });

    // Cloud Sync Settings
    if (el.cloudProviderSelect) {
      el.cloudProviderSelect.addEventListener("change", () => {
        updateSettingsCloudFields(el.cloudProviderSelect.value);
      });
    }
    if (el.copySupabaseSqlBtn) {
      el.copySupabaseSqlBtn.addEventListener("click", () => {
        copyTextWithFallback(SUPABASE_SETUP_SQL);
        showToast("Supabase 테이블 생성 SQL을 복사했습니다");
      });
    }
    if (el.saveCloudSyncBtn) {
      el.saveCloudSyncBtn.addEventListener("click", async () => {
        if (!currentUser || !window.StudyDB) return;
        const provider = el.cloudProviderSelect.value;
        const existing = window.StudyDB.getCloudConfig(currentUser);
        const cfg = { ...existing, provider };
        if (provider === "gist") {
          cfg.githubToken = (el.settingsGithubToken.value || "").trim();
          if (!cfg.githubToken) {
            showToast("GitHub Personal Access Token을 입력하세요");
            return;
          }
        } else if (provider === "supabase") {
          cfg.supabaseUrl = (el.settingsSupabaseUrl.value || "").trim();
          cfg.supabaseKey = (el.settingsSupabaseKey.value || "").trim();
          cfg.supabaseTable = "study_sync";
          if (!cfg.supabaseUrl || !cfg.supabaseKey) {
            showToast("Supabase URL과 Anon Key를 모두 입력하세요");
            return;
          }
        }
        window.StudyDB.saveCloudConfig(currentUser, cfg);
        renderUserProfileBar();
        if (provider !== "none") {
          await syncWithCloudNow({ silent: false });
        } else {
          showToast("로컬 DB 단독 모드로 변경했습니다");
        }
      });
    }
    if (el.syncNowBtn) {
      el.syncNowBtn.addEventListener("click", () => syncWithCloudNow({ silent: false }));
    }
    if (el.copyMobileLinkBtn) {
      el.copyMobileLinkBtn.addEventListener("click", () => {
        if (!currentUser || !window.StudyDB) return;
        const cfg = window.StudyDB.getCloudConfig(currentUser);
        if (!cfg || cfg.provider === "none") {
          showToast("먼저 위에서 GitHub Gist 또는 Supabase 동기화 설정을 저장해 주세요");
          return;
        }
        try {
          const payload = JSON.stringify({ u: currentUser, c: cfg });
          const bytes = new TextEncoder().encode(payload);
          let bin = "";
          bytes.forEach((b) => {
            bin += String.fromCharCode(b);
          });
          const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
          const baseUrl = window.location.href.split("#")[0];
          const link = `${baseUrl}#sync=${b64}`;
          copyTextWithFallback(link);
          showToast("모바일 연결 링크 복사 완료! 카톡 '나에게 보내기'로 열고 접속하세요");
        } catch {
          showToast("연결 링크 생성에 실패했습니다");
        }
      });
    }

    el.saveGemUrlBtn.addEventListener("click", () => {
      const val = el.gemUrlInput.value.trim();
      if (val && !/^https?:\/\//i.test(val)) {
        showToast("http:// 또는 https:// 로 시작하는 URL을 입력하세요");
        return;
      }
      state.gemUrl = val;
      saveState();
      showToast(val ? "Gemini Gem URL을 저장했습니다" : "기본 Gemini URL로 초기화했습니다");
    });

    // Export Backup
    el.exportBackupBtn.addEventListener("click", () => {
      const payload = {
        app: "AI Workspace Study",
        version: 2,
        user: currentUser,
        exportedAt: new Date().toISOString(),
        data: {
          theme: state.theme,
          invertImages: state.invertImages,
          alwaysShowAnswer: state.alwaysShowAnswer,
          defaultTopicView: state.defaultTopicView,
          gemUrl: state.gemUrl,
          lastPosition: state.lastPosition,
          topicLastQid: state.topicLastQid,
          records: state.records,
          memos: state.memos,
          customAnswers: state.customAnswers,
          trendChecked: state.trendChecked,
        },
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const dateStr = new Date().toISOString().slice(0, 10);
      downloadBlob(blob, `ai_workspace_backup_${currentUser || "local"}_${dateStr}.json`);
      showToast("학습기록 백업 JSON을 저장했습니다");
    });

    // Import Backup
    el.importBackupBtn.addEventListener("click", () => el.importBackupFile.click());
    el.importBackupFile.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const src = parsed.data || parsed;
        if (!src || typeof src !== "object" || !src.records) {
          throw new Error("Invalid backup");
        }
        state.records = src.records || {};
        state.memos = src.memos || {};
        state.customAnswers = src.customAnswers || {};
        state.trendChecked = src.trendChecked || {};
        if (src.lastPosition) state.lastPosition = src.lastPosition;
        if (src.topicLastQid) state.topicLastQid = src.topicLastQid;
        if (src.theme === "dark" || src.theme === "light") state.theme = src.theme;
        if (typeof src.invertImages === "boolean") state.invertImages = src.invertImages;
        if (typeof src.alwaysShowAnswer === "boolean") state.alwaysShowAnswer = src.alwaysShowAnswer;
        if (src.defaultTopicView === "briefing" || src.defaultTopicView === "session") {
          state.defaultTopicView = src.defaultTopicView;
          writeSavedDefaultTopicView(src.defaultTopicView);
        }
        if (typeof src.gemUrl === "string") state.gemUrl = src.gemUrl;
        saveState();
        renderAll({ rebuildQueue: true });
        openSettings();
        showToast("학습기록을 성공적으로 불러왔습니다");
      } catch {
        showToast("유효한 백업 JSON 파일이 아닙니다");
      }
    });

    // Bulk Import Answers
    el.importAnswersBtn.addEventListener("click", () => el.importAnswersFile.click());
    el.importAnswersFile.addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        let count = 0;
        if (Array.isArray(parsed)) {
          parsed.forEach((item) => {
            const ans = Number(item?.answer);
            if (item?.id && ans >= 1 && ans <= 4) {
              state.customAnswers[item.id] = ans;
              count += 1;
            }
          });
        } else if (parsed && typeof parsed === "object") {
          Object.entries(parsed).forEach(([id, val]) => {
            const ans = Number(val);
            if (ans >= 1 && ans <= 4) {
              state.customAnswers[id] = ans;
              count += 1;
            }
          });
        }
        if (count === 0) throw new Error("Empty");
        const byId = {};
        studyData.subjects.forEach((s) =>
          s.topics.forEach((t) =>
            t.gamrisa_questions.forEach((q) => {
              byId[q.id] = q;
            })
          )
        );
        Object.keys(state.records).forEach((qid) => {
          if (byId[qid] && state.records[qid].selected != null) {
            applyRecordUpdate(byId[qid], {});
          }
        });
        saveState();
        renderAll({ rebuildQueue: true });
        openSettings();
        showToast(`정답 ${count}건을 반영했습니다`);
      } catch {
        showToast("정답지 JSON 형식을 확인하세요 ({id: 1~4})");
      }
    });

    // Reset current topic
    if (el.resetTopicBtn) {
      el.resetTopicBtn.addEventListener("click", () => {
        const topic = getActiveTopic();
        if (!topic) return;
        if (!window.confirm(`현재 토픽 [${topic.topic}]의 풀이 기록을 모두 날릴까요?`)) return;
        topic.gamrisa_questions.forEach((q) => {
          delete state.records[q.id];
          delete peekedQuestions[q.id];
        });
        delete state.topicLastQid[topic.topic_code];
        if (state.lastPosition?.topicCode === topic.topic_code) {
          state.lastPosition = null;
        }
        saveState();
        currentIndex = 0;
        renderAll({ rebuildQueue: true });
        openSettings();
        showToast(`[${topic.topic}] 풀이 기록을 초기화했습니다`);
      });
    }

    // Reset current subject
    if (el.resetSubjectBtn) {
      el.resetSubjectBtn.addEventListener("click", () => {
        const subj = getActiveSubject();
        if (!subj) return;
        if (!window.confirm(`현재 과목 [${subj.display_name}]의 풀이 기록을 모두 날릴까요?`)) return;
        subj.topics.forEach((t) => {
          t.gamrisa_questions.forEach((q) => {
            delete state.records[q.id];
            delete peekedQuestions[q.id];
          });
          delete state.topicLastQid[t.topic_code];
        });
        if (state.lastPosition?.subjectCode === subj.subject_code) {
          state.lastPosition = null;
        }
        saveState();
        currentIndex = 0;
        renderAll({ rebuildQueue: true });
        openSettings();
        showToast(`[${subj.display_name}] 풀이 기록을 초기화했습니다`);
      });
    }

    // Reset all progress
    el.resetProgressBtn.addEventListener("click", () => {
      if (
        !window.confirm(
          `[${currentUser || "현재 계정"}]의 모든 풀이 기록, 오답, 불확실 표시, 메모, 진도 위치를 완전히 날릴까요?`
        )
      ) {
        return;
      }
      state.records = {};
      state.memos = {};
      state.customAnswers = {};
      state.trendChecked = {};
      state.lastPosition = null;
      state.topicLastQid = {};
      peekedQuestions = {};
      currentIndex = 0;
      saveState();
      renderAll({ rebuildQueue: true });
      openSettings();
      showToast("모든 공부 기록을 초기화했습니다");
    });

    // Keyboard Shortcuts
    document.addEventListener("keydown", (e) => {
      if (!el.authOverlay.classList.contains("hidden")) return;

      if (e.key === "Escape") {
        const now = Date.now();
        if (!el.lightboxModal.classList.contains("hidden")) {
          closeLightbox();
          lastEscTs = now;
          return;
        }
        if (!el.settingsModal.classList.contains("hidden")) {
          closeSettings();
          lastEscTs = now;
          return;
        }
        if (briefingPeekOpen) {
          closeBriefingPeek();
          if (now - lastEscTs <= DOUBLE_ESC_MS) {
            lastEscTs = 0;
            toggleStealth(true);
          } else {
            lastEscTs = now;
          }
          return;
        }
        if (!el.filterMenu.classList.contains("hidden")) {
          el.filterMenu.classList.add("hidden");
          lastEscTs = now;
          return;
        }

        if (now - lastEscTs <= DOUBLE_ESC_MS) {
          lastEscTs = 0;
          toggleStealth();
        } else {
          lastEscTs = now;
        }
        return;
      }

      if (stealthActive) return;
      if (!el.lightboxModal.classList.contains("hidden")) return;
      if (!el.settingsModal.classList.contains("hidden")) return;

      const activeEl = document.activeElement;
      const tag = activeEl?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || activeEl?.isContentEditable) return;

      const topic = getActiveTopic();
      if (!topic) return;

      // Toggle Briefing <-> Session via 'T' key on PC
      if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        setViewMode(activeViewMode === "briefing" ? "session" : "briefing");
        return;
      }

      if (activeViewMode !== "session" || briefingPeekOpen) return;
      if (topic.is_trend || currentQueue.length === 0) return;

      if (e.key >= "1" && e.key <= "4") {
        const q = currentQueue[currentIndex];
        if (q) {
          e.preventDefault();
          applyRecordUpdate(q, { selected: Number(e.key) });
          renderUserProfileBar();
          renderSubjectTabs();
          renderTopicList();
          renderSidebarFooterStats();
          renderFilterDropdown();
          renderMainStream();
        }
      } else if (e.key === "a" || e.key === "A") {
        const q = currentQueue[currentIndex];
        if (q) {
          e.preventDefault();
          peekedQuestions[q.id] = !peekedQuestions[q.id];
          renderMainStream();
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        goNextQuestion();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        goNextQuestion();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        goPrevQuestion();
      }
    });
  }

  // Auth Flow
  function setAuthMode(mode) {
    authMode = mode === "register" ? "register" : "login";
    el.authTabLogin.classList.toggle("active", authMode === "login");
    el.authTabRegister.classList.toggle("active", authMode === "register");
    el.authTabLogin.setAttribute("aria-selected", String(authMode === "login"));
    el.authTabRegister.setAttribute("aria-selected", String(authMode === "register"));
    el.authSubmitBtn.textContent =
      authMode === "register" ? "계정 만들고 공부 시작하기" : "로그인하고 이어서 공부하기";
    el.authErrorMsg.classList.add("hidden");
  }

  async function showAuthOverlay() {
    const accounts = await window.StudyDB.listAccounts();
    if (accounts.length > 0) {
      const summaries = await Promise.all(
        accounts.map(async (acc) => ({
          acc,
          summary: await window.StudyDB.getAccountSummary(acc.username),
        }))
      );
      el.savedAccountsList.innerHTML = summaries
        .map(({ acc, summary }) => {
          const meta = summary.lastLabel
            ? `${summary.solved}문제 · ${summary.lastLabel}`
            : `${summary.solved}문제 풀이`;
          return `
            <button class="saved-account-chip" type="button" data-quick-user="${escapeHtml(acc.username)}">
              <span class="saved-account-main">
                <span class="user-avatar">${escapeHtml(acc.username.slice(0, 1).toUpperCase())}</span>
                <span class="saved-account-name">${escapeHtml(acc.username)}</span>
              </span>
              <span class="saved-account-meta">${escapeHtml(meta)}</span>
            </button>
          `;
        })
        .join("");
      el.savedAccountsWrap.classList.remove("hidden");
      setAuthMode("login");
    } else {
      el.savedAccountsWrap.classList.add("hidden");
      setAuthMode("register");
    }
    el.authPasswordInput.value = "";
    el.authErrorMsg.classList.add("hidden");
    el.authOverlay.classList.remove("hidden");
    setTimeout(() => el.authUsernameInput.focus(), 50);
  }

  async function completeSignIn(username, remember = true) {
    currentUser = username;
    window.StudyDB.setSavedSession(username, remember);
    const loaded = await window.StudyDB.loadUserState(username);
    state = normalizeState(loaded);
    peekedQuestions = {};
    navigatorOpen = false;
    el.authOverlay.classList.add("hidden");

    // Pull latest from cloud DB if connected
    const cfg = window.StudyDB.getCloudConfig(username);
    if (cfg && cfg.provider && cfg.provider !== "none") {
      await syncWithCloudNow({ silent: true });
    }

    // Resume exact last studied position if available
    if (state.lastPosition && state.lastPosition.subjectCode && state.lastPosition.topicCode) {
      state.activeSubjectCode = state.lastPosition.subjectCode;
      state.activeTopicCode = state.lastPosition.topicCode;
    }

    const subj = getActiveSubject();
    state.activeSubjectCode = subj.subject_code;
    const topic = getActiveTopic();
    state.activeTopicCode = topic.topic_code;

    const resumeQid =
      state.lastPosition && state.lastPosition.topicCode === topic.topic_code
        ? state.lastPosition.questionId
        : null;

    activeViewMode = resolveInitialViewMode(topic, { forceSession: Boolean(resumeQid) });
    closeBriefingPeek();

    renderAll({ rebuildQueue: true, keepCurrentQid: resumeQid });
    if (state.lastPosition && state.lastPosition.yearRound) {
      showToast(
        `${username}님 환영합니다 · ${state.lastPosition.yearRound} ${state.lastPosition.number}번부터 이어서 풀기`
      );
    } else {
      showToast(`${username}님으로 로그인했습니다`);
    }
  }

  async function tryPairingFromUrlHash() {
    const hash = window.location.hash || "";
    if (!hash.startsWith("#sync=")) return null;
    const rawB64 = hash.slice(6).trim();
    // Immediately clear sensitive sync token from browser URL bar & history
    try {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    } catch {
      window.location.hash = "";
    }
    if (!rawB64) return null;
    try {
      const pad = "=".repeat((4 - (rawB64.length % 4)) % 4);
      const b64 = rawB64.replace(/-/g, "+").replace(/_/g, "/") + pad;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const parsed = JSON.parse(new TextDecoder().decode(bytes));
      if (!parsed || !parsed.u || !parsed.c) return null;
      const uname = String(parsed.u).trim();
      const exists = await window.StudyDB.getAccount(uname);
      if (!exists) {
        await window.StudyDB.registerAccount(uname, "");
      }
      window.StudyDB.saveCloudConfig(uname, parsed.c);
      return uname;
    } catch {
      return null;
    }
  }

  async function init() {
    applyTheme();
    applySidebarCollapse();
    bindEvents();

    try {
      const studyPromise = fetch("./data/study_data.json").then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        return resp.json();
      });
      const theoryPromise = fetch("./data/theory_data.json")
        .then((resp) => (resp.ok ? resp.json() : null))
        .catch(() => null);

      const [loadedStudy, loadedTheory] = await Promise.all([studyPromise, theoryPromise]);
      studyData = loadedStudy;
      theoryData = loadedTheory && typeof loadedTheory === "object" ? loadedTheory : {};

      // 1. Check 1-tap mobile pairing link (#sync=...)
      const pairedUser = await tryPairingFromUrlHash();
      if (pairedUser) {
        await completeSignIn(pairedUser, true);
        showToast(`${pairedUser} 계정 PC↔모바일 동기화 연결 완료!`);
        return;
      }

      // 2. Check auto-login session
      const session = window.StudyDB.getSavedSession();
      if (session && session.username) {
        const acc = await window.StudyDB.getAccount(session.username);
        if (acc) {
          await completeSignIn(acc.username, true);
          return;
        }
      }

      // 3. Show login screen for account selection / creation
      await showAuthOverlay();
    } catch (err) {
      el.streamInner.innerHTML = `
        <div class="empty-state">
          <div>학습 데이터를 불러오지 못했습니다.</div>
          <div style="margin-top:8px;font-size:12.5px;color:#6e6e6e;">
            로컬 파일(file://)이 아닌 정적 웹 서버(start.bat 또는 GitHub Pages)에서 실행해 주세요.
          </div>
        </div>
      `;
    }
  }

  init();
})();
