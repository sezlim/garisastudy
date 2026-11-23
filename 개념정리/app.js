(() => {
  "use strict";

  const STORAGE_KEY = "garisa_concept_hub_v1";
  const DAY_MS = 24 * 60 * 60 * 1000;
  const SR_INTERVALS_DAYS = [1, 3, 7, 14, 30];
  const FONT_CYCLE = [
    { key: "md", label: "가" },
    { key: "lg", label: "가+" },
    { key: "xl", label: "가++" },
  ];

  const DB = window.CONCEPT_DB;
  if (!DB || !Array.isArray(DB.topics)) {
    const root = document.getElementById("viewRoot");
    if (root) {
      root.innerHTML = `<div class="loading-box">concept_data.js를 불러오지 못했습니다. 같은 폴더에 concept_data.js가 있는지 확인해 주세요.</div>`;
    }
    return;
  }

  const topicByCode = new Map(DB.topics.map((t) => [t.topic_code, t]));
  const subjectByCode = new Map(DB.subjects.map((s) => [s.subject_code, s]));

  function loadStore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return {
        theme: parsed.theme === "dark" ? "dark" : "light",
        font: ["md", "lg", "xl"].includes(parsed.font) ? parsed.font : "md",
        activeSubject: parsed.activeSubject && subjectByCode.has(parsed.activeSubject)
          ? parsed.activeSubject
          : DB.subjects[0].subject_code,
        activeTopic: parsed.activeTopic && topicByCode.has(parsed.activeTopic)
          ? parsed.activeTopic
          : DB.topics[0].topic_code,
        mastery: parsed.mastery && typeof parsed.mastery === "object" ? parsed.mastery : {},
        memos: parsed.memos && typeof parsed.memos === "object" ? parsed.memos : {},
        flashStats: parsed.flashStats && typeof parsed.flashStats === "object"
          ? parsed.flashStats
          : { reviewed: 0, known: 0 },
      };
    } catch {
      return {
        theme: "light",
        font: "md",
        activeSubject: DB.subjects[0].subject_code,
        activeTopic: DB.topics[0].topic_code,
        mastery: {},
        memos: {},
        flashStats: { reviewed: 0, known: 0 },
      };
    }
  }

  let store = loadStore();

  function saveStore() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    } catch {
      // ignore quota errors
    }
  }

  // Runtime UI state
  let activeView = "reader"; // "reader" | "commute" | "flash" | "radar"
  let activeFilter = "all"; // "all" | "S" | "recent" | "weak"
  let searchQuery = "";
  let blindMode = false;
  let commuteMinutes = 10;
  let flashScope = "interleave_s"; // "interleave_s" | "interleave_all" | "weak" | "topic" | "commute" | subject_code
  let flashDeck = [];
  let flashIndex = 0;
  let flashRevealed = false;
  let flashSessionDone = 0;
  let flashSessionAgain = 0;
  let toastTimer = null;

  const el = {
    drawer: document.getElementById("topicDrawer"),
    drawerBackdrop: document.getElementById("drawerBackdrop"),
    drawerOpenBtn: document.getElementById("drawerOpenBtn"),
    drawerCloseBtn: document.getElementById("drawerCloseBtn"),
    searchInput: document.getElementById("globalSearchInput"),
    searchClearBtn: document.getElementById("searchClearBtn"),
    subjectTabs: document.getElementById("subjectTabs"),
    tierFilters: document.getElementById("tierFilters"),
    topicList: document.getElementById("topicList"),
    sidebarProgressLabel: document.getElementById("sidebarProgressLabel"),
    sidebarProgressPct: document.getElementById("sidebarProgressPct"),
    sidebarProgressFill: document.getElementById("sidebarProgressFill"),
    mobileHeaderTitle: document.getElementById("mobileHeaderTitle"),
    fontSizeBtn: document.getElementById("fontSizeBtn"),
    fontSizeLabel: document.getElementById("fontSizeLabel"),
    themeToggleBtn: document.getElementById("themeToggleBtn"),
    themeIconSun: document.getElementById("themeIconSun"),
    themeIconMoon: document.getElementById("themeIconMoon"),
    mainScroll: document.getElementById("mainScroll"),
    viewRoot: document.getElementById("viewRoot"),
    toast: document.getElementById("toast"),
  };

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function showToast(msg) {
    if (!el.toast) return;
    el.toast.textContent = msg;
    el.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.add("hidden");
    }, 2200);
  }

  function applyThemeAndFont() {
    document.documentElement.setAttribute("data-theme", store.theme);
    document.documentElement.setAttribute("data-font", store.font);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute("content", store.theme === "dark" ? "#121413" : "#f7f6f2");
    }
    const isDark = store.theme === "dark";
    el.themeIconSun.classList.toggle("hidden", !isDark);
    el.themeIconMoon.classList.toggle("hidden", isDark);
    const foundFont = FONT_CYCLE.find((f) => f.key === store.font) || FONT_CYCLE[0];
    el.fontSizeLabel.textContent = foundFont.label;
  }

  function setDrawerOpen(open) {
    el.drawer.classList.toggle("is-open", open);
    el.drawerBackdrop.classList.toggle("hidden", !open);
  }

  // Mastery & Spaced Repetition helpers
  function getMasteryRecord(topicCode) {
    return store.mastery[topicCode] || { status: "unseen", step: 0, nextReviewAt: 0, updatedAt: 0 };
  }

  function isTopicDue(rec) {
    if (!rec || rec.status === "unseen") return false;
    if (rec.status === "fuzzy") return true;
    if (rec.status === "mastered" && rec.nextReviewAt && Date.now() >= rec.nextReviewAt) return true;
    return false;
  }

  function setTopicMastery(topicCode, nextStatus) {
    const prev = getMasteryRecord(topicCode);
    const now = Date.now();
    if (nextStatus === "unseen") {
      delete store.mastery[topicCode];
    } else if (nextStatus === "fuzzy") {
      store.mastery[topicCode] = {
        status: "fuzzy",
        step: 0,
        nextReviewAt: now,
        updatedAt: now,
      };
    } else if (nextStatus === "mastered") {
      const nextStep = prev.status === "mastered" ? Math.min(prev.step + 1, SR_INTERVALS_DAYS.length - 1) : 0;
      const days = SR_INTERVALS_DAYS[nextStep];
      store.mastery[topicCode] = {
        status: "mastered",
        step: nextStep,
        nextReviewAt: now + days * DAY_MS,
        updatedAt: now,
      };
      showToast(`암기 완료! ${days}일 뒤 자동 복습 큐에 올라옵니다`);
    }
    saveStore();
    renderSidebar();
  }

  // Rich formatting with Active-Recall Cloze tagging
  function formatRichText(raw, { enableCloze = true } = {}) {
    let s = escapeHtml(raw || "");
    const slots = [];
    const stash = (html) => {
      const idx = slots.length;
      slots.push(html);
      return `\u0000S${idx}\u0000`;
    };

    // 1. Inline code (`...`) -> cloze target
    s = s.replace(/`([^`\n]+)`/g, (_, inner) => {
      const codeHtml = `<code class="inline-code">${inner}</code>`;
      return stash(enableCloze ? `<span class="cloze" tabindex="0">${codeHtml}</span>` : codeHtml);
    });

    // 2. Bold (**...**) -> cloze target
    s = s.replace(/\*\*([^*\n]+)\*\*/g, (_, inner) => {
      const strongHtml = `<strong>${inner}</strong>`;
      return stash(enableCloze ? `<span class="cloze" tabindex="0">${strongHtml}</span>` : strongHtml);
    });

    // 3. Single-quoted key exam terms ('계약문서', '통합시험 이후', etc.) -> cloze target
    if (enableCloze) {
      s = s.replace(/&#39;([^&#\n]{2,20})&#39;/g, (_, inner) => {
        return stash(`&#39;<span class="cloze" tabindex="0">${inner}</span>&#39;`);
      });
    }

    // 4. Past exam refs (not clozed, styled softly)
    s = s.replace(
      /(\d{4}년(?:\(제\d+회\))?\s*(?:\d+교시\s*)?\d+번(?:\s*\/\s*\d+번)?)/g,
      (_, m) => stash(`<span class="exam-ref">${m}</span>`)
    );

    // 5. High-value exam thresholds, units, numbers & legal penalties -> cloze target
    if (enableCloze) {
      s = s.replace(
        /(\d+(?:\.\d+)?\s*(?:억원?|만원|개월|년|일|시간|주|분|회|단계|차|%|퍼센트|비트|bit|Byte|MB\/s|Mbps|ns|ms|배|개)\s*(?:이상|이하|미만|초과|이내|범위)?|1차\s*(?:경고|정지\s*\d+개월|취소)|필요적\s*취소|임의적\s*처분)/g,
        (m) => stash(`<span class="cloze" tabindex="0">${m}</span>`)
      );
    }

    // Restore slots
    s = s.replace(/\u0000S(\d+)\u0000/g, (_, idx) => slots[Number(idx)] || "");
    return s;
  }

  function formatCellHtml(text, colIdx) {
    const raw = String(text || "").trim();
    if (!raw) return "";
    if (colIdx > 0 && raw.length >= 42 && raw.includes("; ")) {
      const parts = raw.split(/;\s+/).filter(Boolean);
      if (parts.length >= 2) {
        return parts.map((p) => `<div class="cell-line">${formatRichText(p, { enableCloze: false })}</div>`).join("");
      }
    }
    return `<div>${formatRichText(raw, { enableCloze: false })}</div>`;
  }

  // Sidebar Rendering
  function getFilteredTopicsForSubject(subjCode) {
    const subj = subjectByCode.get(subjCode);
    if (!subj) return [];
    return subj.topic_codes
      .map((c) => topicByCode.get(c))
      .filter(Boolean)
      .filter((t) => {
        if (activeFilter === "S") return t.priority.tier === "S";
        if (activeFilter === "recent") return t.gamrisa_recent_count >= 3 || t.is_trend;
        if (activeFilter === "weak") {
          const rec = getMasteryRecord(t.topic_code);
          return rec.status !== "mastered" || isTopicDue(rec);
        }
        return true;
      });
  }

  function renderSidebar() {
    // 1. Subject tabs
    el.subjectTabs.innerHTML = DB.subjects
      .map((s) => {
        const isActive = s.subject_code === store.activeSubject;
        return `
          <button
            class="subj-tab ${isActive ? "active" : ""}"
            type="button"
            role="tab"
            aria-selected="${isActive}"
            data-subject="${escapeHtml(s.subject_code)}"
            title="${escapeHtml(s.display_name)}"
          >
            <span class="subj-day">${escapeHtml(s.day)}</span>
            <span class="subj-short">${escapeHtml(s.short)}</span>
          </button>
        `;
      })
      .join("");

    // 2. Filter chips active state
    el.tierFilters.querySelectorAll(".filter-chip").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.filter === activeFilter);
    });

    // 3. Topic list (or live search results inside sidebar)
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      const hits = searchTopics(q);
      if (hits.length === 0) {
        el.topicList.innerHTML = `<div class="topic-group-head">검색 결과가 없습니다.</div>`;
      } else {
        el.topicList.innerHTML =
          `<div class="topic-group-head">전체 검색 결과 (${hits.length}건)</div>` +
          hits.map(({ topic }) => renderTopicRowHtml(topic, true)).join("");
      }
    } else {
      const list = getFilteredTopicsForSubject(store.activeSubject);
      const regular = list.filter((t) => !t.is_trend);
      const trend = list.filter((t) => t.is_trend);
      let html = "";
      if (regular.length === 0 && trend.length === 0) {
        html = `<div class="topic-group-head">해당 조건의 토픽이 없습니다.</div>`;
      } else {
        if (regular.length > 0) {
          html += `<div class="topic-group-head">빈출 순위 토픽 (${regular.length})</div>`;
          html += regular.map((t) => renderTopicRowHtml(t, false)).join("");
        }
        if (trend.length > 0) {
          html += `<div class="topic-group-head">기술사 연계 신유형</div>`;
          html += trend.map((t) => renderTopicRowHtml(t, false)).join("");
        }
      }
      el.topicList.innerHTML = html;
    }

    // 4. Footer overall mastery
    const masteredCount = DB.topics.filter((t) => getMasteryRecord(t.topic_code).status === "mastered").length;
    const pct = Math.round((masteredCount / DB.topics.length) * 100);
    el.sidebarProgressLabel.textContent = `전체 숙지 ${masteredCount} / ${DB.topics.length}토픽`;
    el.sidebarProgressPct.textContent = `${pct}%`;
    el.sidebarProgressFill.style.width = `${pct}%`;
  }

  function renderTopicRowHtml(t, showSubj) {
    const isActive = activeView === "reader" && t.topic_code === store.activeTopic;
    const rec = getMasteryRecord(t.topic_code);
    const dotClass =
      rec.status === "mastered" ? "is-mastered" : rec.status === "fuzzy" ? "is-fuzzy" : "";
    const meta = t.is_trend
      ? `기술사 ${t.pe_count}건 · 신유형`
      : `13년 ${t.gamrisa_count}회 · 최근3년 ${t.gamrisa_recent_count}회`;
    return `
      <button
        class="topic-row ${isActive ? "active" : ""}"
        type="button"
        data-topic="${escapeHtml(t.topic_code)}"
      >
        <div class="topic-row-main">
          <div class="topic-row-top">
            <span class="tier-tag tier-${escapeHtml(t.priority.tier)}">${escapeHtml(t.priority.tier)}급</span>
            <span class="topic-row-code">${escapeHtml(showSubj ? `${t.subject_short} · ${t.topic_code}` : t.topic_code)}</span>
          </div>
          <div class="topic-row-title">${escapeHtml(t.topic)}</div>
          <div class="topic-row-meta">${escapeHtml(meta)}</div>
        </div>
        <span class="status-dot ${dotClass}" title="${rec.status === "mastered" ? "암기 완료" : rec.status === "fuzzy" ? "헷갈림(복습)" : "미학습"}"></span>
      </button>
    `;
  }

  function searchTopics(qLower) {
    const results = [];
    for (const t of DB.topics) {
      let score = 0;
      let snippet = "";
      const titleL = t.topic.toLowerCase();
      const descL = (t.desc || "").toLowerCase();
      if (titleL.includes(qLower)) {
        score += 10;
        snippet = t.desc || t.exam_intent.goal;
      } else if (descL.includes(qLower)) {
        score += 7;
        snippet = t.desc;
      } else if ((t.exam_intent.key_keywords || []).some((k) => k.toLowerCase().includes(qLower))) {
        score += 6;
        snippet = `핵심 키워드: ${(t.exam_intent.key_keywords || []).join(" · ")}`;
      } else {
        // Search traps & concepts
        const trapHit = (t.traps || []).find(
          (tr) => tr.pattern.toLowerCase().includes(qLower) || tr.example_ref.toLowerCase().includes(qLower)
        );
        if (trapHit) {
          score += 5;
          snippet = `[함정] ${trapHit.pattern}`;
        } else {
          const blkHit = (t.core_blocks || []).find((b) =>
            (b.title || "").toLowerCase().includes(qLower) ||
            (b.items || []).some((it) => it.text.toLowerCase().includes(qLower))
          );
          if (blkHit) {
            score += 4;
            const matchItem = blkHit.items.find((it) => it.text.toLowerCase().includes(qLower));
            snippet = matchItem ? matchItem.text.slice(0, 120) : blkHit.title;
          } else if (t.comparison_table && JSON.stringify(t.comparison_table).toLowerCase().includes(qLower)) {
            score += 3;
            snippet = `[비교표] ${t.comparison_table.title || t.topic}`;
          }
        }
      }
      if (score > 0) {
        results.push({ topic: t, score, snippet });
      }
    }
    results.sort((a, b) => b.score - a.score || b.topic.priority.score - a.topic.priority.score);
    return results;
  }

  // Navigation sync across desktop pills & mobile bottom nav
  function syncNavTabs() {
    document.querySelectorAll("[data-view]").forEach((btn) => {
      const isAct = btn.dataset.view === activeView;
      btn.classList.toggle("active", isAct);
      if (btn.getAttribute("role") === "tab") {
        btn.setAttribute("aria-selected", String(isAct));
      }
    });
    const labels = {
      reader: topicByCode.get(store.activeTopic)?.topic || "개념서",
      commute: "오늘의 출퇴근 10분",
      flash: "함정·비교 플래시카드",
      radar: "합격 레이더",
    };
    if (el.mobileHeaderTitle) el.mobileHeaderTitle.textContent = labels[activeView] || "감리사 합격 개념서";
  }

  function switchView(nextView, { scrollTop = true } = {}) {
    activeView = nextView;
    syncNavTabs();
    renderSidebar();
    renderActiveView();
    if (scrollTop) el.mainScroll.scrollTop = 0;
  }

  function openTopic(topicCode, { scrollTop = true } = {}) {
    const t = topicByCode.get(topicCode);
    if (!t) return;
    store.activeSubject = t.subject_code;
    store.activeTopic = t.topic_code;
    saveStore();
    activeView = "reader";
    setDrawerOpen(false);
    syncNavTabs();
    renderSidebar();
    renderActiveView();
    if (scrollTop) el.mainScroll.scrollTop = 0;
  }

  // ========================================================================
  // VIEW 1: Concept Mastery Reader
  // ========================================================================
  function updateBlindCounterUI() {
    const counterEl = document.getElementById("blindCounterText");
    if (!counterEl) return;
    if (!blindMode) {
      counterEl.textContent = "";
      return;
    }
    const allCloze = el.viewRoot.querySelectorAll(".cloze, .cloze-cell");
    const revealed = el.viewRoot.querySelectorAll(".cloze.is-revealed, .cloze-cell.is-revealed");
    counterEl.textContent = `${revealed.length}/${allCloze.length}`;
  }

  function renderReaderView() {
    const t = topicByCode.get(store.activeTopic) || DB.topics[0];
    const rec = getMasteryRecord(t.topic_code);
    const memoVal = store.memos[t.topic_code] || "";

    // Adjacent topics in current subject
    const subj = subjectByCode.get(t.subject_code);
    const codes = subj ? subj.topic_codes : [];
    const idx = codes.indexOf(t.topic_code);
    const prevTopic = idx > 0 ? topicByCode.get(codes[idx - 1]) : null;
    const nextTopic = idx >= 0 && idx < codes.length - 1 ? topicByCode.get(codes[idx + 1]) : null;

    // 13-year sparkline bars
    const series = t.year_series || [];
    const maxY = Math.max(1, ...series);
    const sparkHtml = !t.is_trend
      ? `
        <div class="sparkline" title="2014~2026 연도별 출제 빈도 (녹색: 최근 3년)">
          ${series
            .map((val, i) => {
              const yr = DB.meta.years[i];
              const isRecent = i >= series.length - 3;
              const h = val > 0 ? Math.max(5, Math.round((val / maxY) * 26)) : 2;
              return `<div class="spark-col" title="${yr}년: ${val}문항"><span class="spark-bar ${val === 0 ? "is-zero" : ""} ${isRecent && val > 0 ? "is-recent" : ""}" style="height:${h}px"></span></div>`;
            })
            .join("")}
        </div>
      `
      : "";

    // Question archetype chips
    const profileHtml = (t.question_profile || [])
      .map((p) => `<span class="profile-chip">${escapeHtml(p.type)}<strong>${p.pct}%</strong></span>`)
      .join("");

    // Key keywords
    const kwHtml = (t.exam_intent.key_keywords || [])
      .map((k) => `<span class="kw-tag">#${escapeHtml(k)}</span>`)
      .join("");

    // Section 02: Core concept blocks
    const blocksHtml = (t.core_blocks || [])
      .map((blk) => {
        const titleHtml = blk.title ? `<h3 class="concept-block-title">${escapeHtml(blk.title)}</h3>` : "";
        const itemsHtml = (blk.items || [])
          .map((it) => {
            const isNote = it.kind === "note";
            const marker = it.marker || "•";
            return `
              <li class="concept-item ${isNote ? "is-note" : ""}">
                <span class="concept-marker">${escapeHtml(marker)}</span>
                <span class="concept-text">${formatRichText(it.text, { enableCloze: true })}</span>
              </li>
            `;
          })
          .join("");
        return `
          <div class="concept-block">
            ${titleHtml}
            <ul class="concept-list">${itemsHtml}</ul>
          </div>
        `;
      })
      .join("");

    // Comparison table
    let tableHtml = "";
    const tbl = t.comparison_table;
    if (tbl && Array.isArray(tbl.headers) && Array.isArray(tbl.rows) && tbl.rows.length > 0) {
      const ths = tbl.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
      const trs = tbl.rows
        .map(
          (row) =>
            `<tr>${row
              .map((cell, ci) =>
                ci === 0
                  ? `<td>${formatCellHtml(cell, ci)}</td>`
                  : `<td class="cloze-cell" tabindex="0">${formatCellHtml(cell, ci)}</td>`
              )
              .join("")}</tr>`
        )
        .join("");
      tableHtml = `
        <div id="secTable" class="concept-section" style="margin-top:18px;margin-bottom:0;">
          ${tbl.title ? `<div class="table-caption">핵심 비교·암기표 — ${escapeHtml(tbl.title)}</div>` : ""}
          <div class="table-scroll">
            <table class="concept-table">
              <thead><tr>${ths}</tr></thead>
              <tbody>${trs}</tbody>
            </table>
          </div>
        </div>
      `;
    }

    // Section 03: Traps
    const trapsHtml = (t.traps || [])
      .map(
        (tr, i) => `
          <article class="trap-card">
            <div class="trap-head">
              <span class="trap-num">함정 ${String(i + 1).padStart(2, "0")}</span>
              <span class="trap-tech">${escapeHtml(tr.technique)}</span>
            </div>
            <p class="trap-pattern">${formatRichText(tr.pattern, { enableCloze: true })}</p>
            ${
              tr.example_ref
                ? `<div class="trap-ref"><span class="trap-ref-label">기출 실증</span>${formatRichText(tr.example_ref, { enableCloze: false })}</div>`
                : ""
            }
          </article>
        `
      )
      .join("");

    // Section 04: Recent Exam Evidence
    const evHtml = (t.recent_evidence || [])
      .map(
        (ev) => `
          <div class="evidence-card">
            <div class="evidence-meta">
              <span class="evidence-ref">${escapeHtml(ev.ref)}</span>
              ${ev.q_type ? `<span class="evidence-type">${escapeHtml(ev.q_type)}</span>` : ""}
              ${(ev.keywords || []).map((k) => `<span class="kw-tag">${escapeHtml(k)}</span>`).join("")}
            </div>
            <p class="evidence-text">${formatRichText(ev.summary, { enableCloze: true })}</p>
          </div>
        `
      )
      .join("");

    const linksHtml = (t.cross_domain_links || []).length
      ? `
        <div class="radar-box-title">타 영역 크로스오버 출제 연계</div>
        <ul class="link-list">
          ${t.cross_domain_links.map((l) => `<li>${formatRichText(l, { enableCloze: false })}</li>`).join("")}
        </ul>
      `
      : "";

    const peHtml = t.pe_trend_alert
      ? `
        <div class="radar-box-title">기술사 연계 신유형 경보</div>
        <p class="pe-alert-body">${formatRichText(t.pe_trend_alert, { enableCloze: false })}</p>
      `
      : "";

    el.viewRoot.innerHTML = `
      <article id="conceptArticle" class="${blindMode ? "is-blind-active" : ""}">
        <header class="topic-header">
          <div class="topic-eyebrow">
            <span class="tier-tag tier-${escapeHtml(t.priority.tier)}">${escapeHtml(t.priority.label)}</span>
            <span class="topic-code-pill">${escapeHtml(t.subject_short)} · ${escapeHtml(t.topic_code)}</span>
            <span>${escapeHtml(t.priority.reason)}</span>
          </div>
          <h1 class="topic-h1">${escapeHtml(t.topic)}</h1>
          ${t.desc ? `<p class="topic-desc">${escapeHtml(t.desc)}</p>` : ""}

          <div class="pulse-strip">
            <div class="pulse-stats">
              ${
                t.is_trend
                  ? `<span>기술사 연계 <strong>${t.pe_count}건</strong></span><span>예상 함정 <strong>${t.traps.length}개</strong></span>`
                  : `<span>13년 출제 <strong>${t.gamrisa_count}문항</strong></span>
                     <span>최근 3년(24~26) <strong>${t.gamrisa_recent_count}문항</strong></span>
                     <span>과목 내 순위 <strong>${t.frequency_rank}위</strong></span>
                     <span>연계 기술사 <strong>${t.pe_count}건</strong></span>`
              }
            </div>
            ${sparkHtml}
          </div>
        </header>

        <!-- Sticky Active Recall & Mastery Bar -->
        <div class="study-action-bar">
          <button id="blindToggleBtn" class="blind-toggle-btn ${blindMode ? "active" : ""}" type="button" aria-pressed="${blindMode}">
            <span>${blindMode ? "블라인드 암기 ON" : "블라인드 암기"}</span>
            <span id="blindCounterText" class="blind-counter"></span>
          </button>

          <div class="mastery-seg" role="group" aria-label="토픽 숙지 상태">
            <button class="mastery-btn ${rec.status === "unseen" ? "active" : ""}" type="button" data-status="unseen">미학습</button>
            <button class="mastery-btn ${rec.status === "fuzzy" ? "active" : ""}" type="button" data-status="fuzzy">헷갈림</button>
            <button class="mastery-btn ${rec.status === "mastered" ? "active" : ""}" type="button" data-status="mastered">암기완료</button>
          </div>

          <div class="section-jumps">
            <button class="jump-pill" type="button" data-jump="secIntent">01 출제의도</button>
            <button class="jump-pill" type="button" data-jump="secConcept">02 핵심개념</button>
            ${tableHtml ? `<button class="jump-pill" type="button" data-jump="secTable">비교암기표</button>` : ""}
            <button class="jump-pill" type="button" data-jump="secTrap">03 함정설계(${t.traps.length})</button>
            <button class="jump-pill" type="button" data-jump="secEvidence">04 기출근거</button>
          </div>
        </div>

        <!-- 01. Exam Intent -->
        <section id="secIntent" class="concept-section">
          <div class="section-head">
            <span class="section-num">01</span>
            <h2 class="section-title">출제 의도 & 최단 공략법</h2>
          </div>
          <div class="intent-sheet">
            <p class="intent-goal">${escapeHtml(t.exam_intent.goal)}</p>
            ${profileHtml ? `<div class="profile-bars">${profileHtml}</div>` : ""}
            <div class="intent-strategy">
              <span class="intent-strategy-label">3초 풀이 포인트</span>${escapeHtml(t.exam_intent.strategy)}
            </div>
            ${kwHtml ? `<div class="keyword-row">${kwHtml}</div>` : ""}
          </div>
        </section>

        <!-- 02. Core Concepts & Comparison Table -->
        <section id="secConcept" class="concept-section">
          <div class="section-head">
            <span class="section-num">02</span>
            <h2 class="section-title">확인하고자 하는 핵심 개념</h2>
            <span class="section-sub">${blindMode ? "검은 박스를 탭해 회상 확인" : "블라인드 모드로 암기 점검 가능"}</span>
          </div>
          <div class="concept-stack">${blocksHtml}</div>
          ${tableHtml}
        </section>

        <!-- 03. Trap Engineering -->
        <section id="secTrap" class="concept-section">
          <div class="section-head">
            <span class="section-num">03</span>
            <h2 class="section-title">출제자 함정 설계 해부</h2>
            <span class="section-sub">단골 오답 ${t.traps.length}패턴</span>
          </div>
          <div class="trap-list">${trapsHtml}</div>
        </section>

        <!-- 04. Verified Exam Evidence & PE Trend -->
        <section id="secEvidence" class="concept-section">
          <div class="section-head">
            <span class="section-num">04</span>
            <h2 class="section-title">${t.is_trend ? "기술사 핵심 기출 근거" : "최근 기출 1줄 정답 논리"}</h2>
          </div>
          ${evHtml ? `<div class="evidence-list">${evHtml}</div>` : ""}
          ${
            linksHtml || peHtml
              ? `<div class="radar-box">${linksHtml}${peHtml}</div>`
              : ""
          }
        </section>

        <!-- Personal Mnemonic Note -->
        <section class="mnemonic-box">
          <div class="mnemonic-head">
            <label for="mnemonicInput" class="mnemonic-label">나만의 1줄 암기팁 · 두문자 메모</label>
            <span id="mnemonicHint" class="mnemonic-hint">자동 저장됨</span>
          </div>
          <textarea
            id="mnemonicInput"
            class="mnemonic-textarea"
            placeholder="출퇴근길에 떠올릴 나만의 두문자나 핵심 요약 1줄을 적어두세요 (자동 저장)..."
          >${escapeHtml(memoVal)}</textarea>
        </section>

        <!-- Bottom Pager -->
        <nav class="topic-pager" aria-label="이전/다음 토픽 이동">
          <button class="pager-btn prev" type="button" ${prevTopic ? `data-open-topic="${escapeHtml(prevTopic.topic_code)}"` : "disabled"}>
            <span class="pager-dir">← 이전 토픽</span>
            <span class="pager-name">${prevTopic ? escapeHtml(prevTopic.topic) : "첫 번째 토픽"}</span>
          </button>
          <button id="topicFlashBtn" class="pager-flash-btn" type="button">
            이 토픽 플래시카드 (${t.flashcard_count}장)
          </button>
          <button class="pager-btn next" type="button" ${nextTopic ? `data-open-topic="${escapeHtml(nextTopic.topic_code)}"` : "disabled"}>
            <span class="pager-dir">다음 토픽 →</span>
            <span class="pager-name">${nextTopic ? escapeHtml(nextTopic.topic) : "마지막 토픽"}</span>
          </button>
        </nav>
      </article>
    `;

    updateBlindCounterUI();

    // Bind memo auto-save
    const memoInput = document.getElementById("mnemonicInput");
    const memoHint = document.getElementById("mnemonicHint");
    let memoTimer = null;
    if (memoInput) {
      memoInput.addEventListener("input", () => {
        const val = memoInput.value.trim();
        if (val) store.memos[t.topic_code] = memoInput.value;
        else delete store.memos[t.topic_code];
        saveStore();
        if (memoHint) {
          memoHint.classList.add("show");
          clearTimeout(memoTimer);
          memoTimer = setTimeout(() => memoHint.classList.remove("show"), 1200);
        }
      });
    }
  }

  // ========================================================================
  // VIEW 2: Daily 10-Min Commute Sprint (Spaced Repetition + 과락 방어)
  // ========================================================================
  function buildCommuteQueue(limit) {
    // 1. Compute per-subject mastery ratio to prioritize weakest subject (과락 방어!)
    const subjRates = new Map();
    for (const s of DB.subjects) {
      const total = s.topic_codes.length || 1;
      const done = s.topic_codes.filter((c) => getMasteryRecord(c).status === "mastered").length;
      subjRates.set(s.subject_code, done / total);
    }
    const weakestSubj = [...subjRates.entries()].sort((a, b) => a[1] - b[1])[0]?.[0];

    const picked = [];
    const used = new Set();

    // Priority 1: Fuzzy or Spaced-Repetition Due items
    const dueList = DB.topics
      .filter((t) => isTopicDue(getMasteryRecord(t.topic_code)))
      .sort((a, b) => {
        const ra = getMasteryRecord(a.topic_code);
        const rb = getMasteryRecord(b.topic_code);
        if (ra.status !== rb.status) return ra.status === "fuzzy" ? -1 : 1;
        return b.priority.score - a.priority.score;
      });

    for (const t of dueList) {
      if (picked.length >= Math.max(2, Math.ceil(limit * 0.5))) break;
      const rec = getMasteryRecord(t.topic_code);
      picked.push({
        topic: t,
        kind: "due",
        badge: rec.status === "fuzzy" ? "헷갈림 재복습" : "망각곡선 복습 도래",
      });
      used.add(t.topic_code);
    }

    // Priority 2: Weakest subject's unmastered S-tier topics (과락 방어)
    const guardList = DB.topics
      .filter(
        (t) =>
          !used.has(t.topic_code) &&
          t.subject_code === weakestSubj &&
          t.priority.tier === "S" &&
          getMasteryRecord(t.topic_code).status !== "mastered"
      )
      .sort((a, b) => b.priority.score - a.priority.score);

    for (const t of guardList.slice(0, 2)) {
      if (picked.length >= limit) break;
      picked.push({
        topic: t,
        kind: "guard",
        badge: `과락 방어 · ${t.subject_short} S급`,
      });
      used.add(t.topic_code);
    }

    // Priority 3: Highest-ROI unmastered S/A topics across all 5 subjects (interleaved)
    const remaining = DB.topics
      .filter((t) => !used.has(t.topic_code) && getMasteryRecord(t.topic_code).status !== "mastered")
      .sort((a, b) => {
        const tierOrd = { S: 0, A: 1, T: 2, B: 3 };
        if (tierOrd[a.priority.tier] !== tierOrd[b.priority.tier]) {
          return tierOrd[a.priority.tier] - tierOrd[b.priority.tier];
        }
        return b.priority.score - a.priority.score;
      });

    // Interleave across subjects for better memory discrimination
    const bySubj = new Map();
    for (const t of remaining) {
      if (!bySubj.has(t.subject_code)) bySubj.set(t.subject_code, []);
      bySubj.get(t.subject_code).push(t);
    }
    while (picked.length < limit && bySubj.size > 0) {
      for (const [sc, arr] of [...bySubj.entries()]) {
        if (picked.length >= limit) break;
        const next = arr.shift();
        if (next) {
          picked.push({
            topic: next,
            kind: "core",
            badge: `${next.priority.label} · 교차 학습`,
          });
          used.add(next.topic_code);
        }
        if (arr.length === 0) bySubj.delete(sc);
      }
    }

    return picked;
  }

  function renderCommuteView() {
    const limitMap = { 5: 3, 10: 6, 20: 10 };
    const limit = limitMap[commuteMinutes] || 6;
    const queue = buildCommuteQueue(limit);

    const itemsHtml = queue.length
      ? queue
          .map(({ topic: t, kind, badge }, i) => {
            const cls = kind === "due" ? "is-due" : kind === "guard" ? "is-guard" : "is-core";
            return `
              <button class="sprint-item" type="button" data-open-topic="${escapeHtml(t.topic_code)}">
                <div>
                  <span class="sprint-reason ${cls}">${escapeHtml(badge)}</span>
                  <div class="sprint-title">${i + 1}. [${escapeHtml(t.subject_short)}] ${escapeHtml(t.topic)}</div>
                  <div class="sprint-meta">
                    ${t.is_trend ? `기술사 ${t.pe_count}건` : `13년 ${t.gamrisa_count}회 · 최근3년 ${t.gamrisa_recent_count}회`}
                    · 단골 함정 ${t.traps.length}개 · 플래시 ${t.flashcard_count}장
                  </div>
                </div>
                <span aria-hidden="true" style="color:var(--ink-muted);font-size:18px;">→</span>
              </button>
            `;
          })
          .join("")
      : `<div class="loading-box">모든 104개 토픽을 암기 완료했습니다! 함정 플래시카드로 최종 감각을 유지하세요.</div>`;

    el.viewRoot.innerHTML = `
      <section>
        <div class="page-hero">
          <h1>오늘의 출퇴근 ${commuteMinutes}분 합격 코스</h1>
          <p>망각곡선 복습(1·3·7일) + 과락 위험 과목 S급 방어 + 전 과목 교차 학습(Interleaving)으로 자동 편성했습니다.</p>
        </div>

        <div class="sprint-controls">
          <div class="seg-group" role="group" aria-label="출퇴근 시간 선택">
            <button class="seg-btn ${commuteMinutes === 5 ? "active" : ""}" type="button" data-commute-min="5">5분 (3토픽)</button>
            <button class="seg-btn ${commuteMinutes === 10 ? "active" : ""}" type="button" data-commute-min="10">10분 (6토픽)</button>
            <button class="seg-btn ${commuteMinutes === 20 ? "active" : ""}" type="button" data-commute-min="20">20분 (10토픽)</button>
          </div>
          ${
            queue.length > 0
              ? `<button id="startCommuteFlashBtn" class="primary-btn" type="button">오늘 코스 함정 플래시 바로 훈련</button>`
              : ""
          }
        </div>

        <div class="sprint-list">${itemsHtml}</div>
      </section>
    `;
  }

  // ========================================================================
  // VIEW 3: Active-Recall Flashcard Deck
  // ========================================================================
  function shuffleArray(arr) {
    const copy = arr.slice();
    for (let i = copy.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  function buildFlashDeck(scope) {
    flashScope = scope;
    let pool = [];
    if (scope === "interleave_s") {
      pool = DB.flashcards.filter((c) => c.tier === "S");
    } else if (scope === "interleave_all") {
      pool = DB.flashcards;
    } else if (scope === "weak") {
      const weakSet = new Set(
        DB.topics
          .filter((t) => {
            const r = getMasteryRecord(t.topic_code);
            return r.status === "fuzzy" || isTopicDue(r);
          })
          .map((t) => t.topic_code)
      );
      pool = DB.flashcards.filter((c) => weakSet.has(c.topic_code));
    } else if (scope === "topic") {
      pool = DB.flashcards.filter((c) => c.topic_code === store.activeTopic);
    } else if (scope === "commute") {
      const limitMap = { 5: 3, 10: 6, 20: 10 };
      const qCodes = new Set(buildCommuteQueue(limitMap[commuteMinutes] || 6).map((x) => x.topic.topic_code));
      pool = DB.flashcards.filter((c) => qCodes.has(c.topic_code));
    } else if (subjectByCode.has(scope)) {
      pool = DB.flashcards.filter((c) => c.subject_code === scope);
    }

    const shuffled = shuffleArray(pool);
    flashDeck = scope === "topic" ? shuffled : shuffled.slice(0, 25);
    flashIndex = 0;
    flashRevealed = false;
    flashSessionDone = 0;
    flashSessionAgain = 0;
  }

  function renderFlashView() {
    if (flashDeck.length === 0 && flashScope !== "weak") {
      buildFlashDeck(flashScope);
    }

    const currentTopic = topicByCode.get(store.activeTopic);
    const scopeOptions = [
      { val: "interleave_s", label: "전 과목 S급 핵심 교차 믹스 (추천 · 25장)" },
      { val: "interleave_all", label: "전 과목 전체 랜덤 믹스 (25장)" },
      { val: "commute", label: `오늘의 ${commuteMinutes}분 코스 카드` },
      { val: "weak", label: "헷갈림·복습 도래 토픽만" },
      { val: "topic", label: `현재 토픽만 (${currentTopic ? currentTopic.topic_code : ""})` },
      ...DB.subjects.map((s) => ({ val: s.subject_code, label: `${s.name} 집중 (25장)` })),
    ];

    const selectHtml = `
      <select id="flashScopeSelect" class="flash-select" aria-label="플래시카드 범위 선택">
        ${scopeOptions
          .map((o) => `<option value="${escapeHtml(o.val)}" ${o.val === flashScope ? "selected" : ""}>${escapeHtml(o.label)}</option>`)
          .join("")}
      </select>
    `;

    if (flashDeck.length === 0) {
      el.viewRoot.innerHTML = `
        <section>
          <div class="page-hero">
            <h1>함정·비교 능동 회상 플래시카드</h1>
            <p>수동으로 읽기만 하는 것보다 기억에서 직접 꺼내보는 훈련이 합격 기억 유지율을 3배 이상 높입니다.</p>
          </div>
          <div class="flash-toolbar">
            ${selectHtml}
            <button id="flashReshuffleBtn" class="secondary-btn" type="button">새 덱 섞기</button>
          </div>
          <div class="loading-box">선택한 범위에 해당하는 카드가 없습니다. 다른 범위를 선택해 주세요.</div>
        </section>
      `;
      return;
    }

    if (flashIndex >= flashDeck.length) {
      const total = flashSessionDone;
      el.viewRoot.innerHTML = `
        <section>
          <div class="page-hero">
            <h1>이번 세트 회상 훈련 완료!</h1>
            <p>총 ${total}회 인출 확인 · 재도전 ${flashSessionAgain}회 — 뇌에 함정 패턴이 각인되었습니다.</p>
          </div>
          <div class="flash-toolbar">
            ${selectHtml}
            <button id="flashReshuffleBtn" class="primary-btn" type="button">새 25장 다시 도전</button>
          </div>
        </section>
      `;
      return;
    }

    const card = flashDeck[flashIndex];
    const pct = Math.round(((flashIndex + 1) / flashDeck.length) * 100);

    el.viewRoot.innerHTML = `
      <section>
        <div class="page-hero">
          <h1>함정·비교 능동 회상 플래시카드</h1>
          <p>카드를 탭(또는 Space)해 정답을 확인하고, 헷갈린 카드는 '다시 볼래요'를 눌러 즉시 재인출하세요.</p>
        </div>

        <div class="flash-toolbar">
          ${selectHtml}
          <button id="flashReshuffleBtn" class="secondary-btn" type="button">새로 섞기</button>
        </div>

        <div class="flash-progress-wrap">
          <span>${flashIndex + 1} / ${flashDeck.length}장</span>
          <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${pct}%"></div></div>
          <span>누적 ${store.flashStats.reviewed}회</span>
        </div>

        <div id="flashCardBox" class="flash-card" role="button" tabindex="0" aria-label="플래시카드 정답 보기">
          <div class="flash-card-top">
            <div class="flash-badges">
              <span class="tier-tag tier-${escapeHtml(card.tier)}">${escapeHtml(card.tier)}급</span>
              <span class="flash-kind-badge ${card.kind === "trap" ? "is-trap" : "is-table"}">${escapeHtml(card.tag)}</span>
              <span class="topic-code-pill">${escapeHtml(card.subject_short)} · ${escapeHtml(card.topic_code)}</span>
            </div>
            <button class="flash-topic-link" type="button" data-open-topic="${escapeHtml(card.topic_code)}">개념서 보기 →</button>
          </div>

          <div class="flash-front-text">${escapeHtml(card.front)}</div>

          ${
            flashRevealed
              ? `
                <div class="flash-answer-box">
                  <div class="flash-back-main">${escapeHtml(card.back_main)}</div>
                  ${card.back_detail ? `<div class="flash-back-detail">${formatRichText(card.back_detail, { enableCloze: false })}</div>` : ""}
                </div>
              `
              : `<div class="flash-tap-hint">머릿속으로 떠올린 뒤 카드를 탭해 정답 확인 (단축키: Space)</div>`
          }
        </div>

        ${
          flashRevealed
            ? `
              <div class="flash-thumb-actions">
                <button id="flashAgainBtn" class="thumb-btn is-again" type="button">다시 볼래요 (재출제)</button>
                <button id="flashGoodBtn" class="thumb-btn is-good" type="button">완벽히 알아요 →</button>
              </div>
            `
            : ""
        }
      </section>
    `;
  }

  function advanceFlash(knewIt) {
    const card = flashDeck[flashIndex];
    if (!card) return;
    store.flashStats.reviewed = (store.flashStats.reviewed || 0) + 1;
    flashSessionDone += 1;
    if (knewIt) {
      store.flashStats.known = (store.flashStats.known || 0) + 1;
    } else {
      flashSessionAgain += 1;
      // Re-insert 3 cards later for immediate spaced retrieval
      const insertPos = Math.min(flashDeck.length, flashIndex + 4);
      flashDeck.splice(insertPos, 0, card);
    }
    saveStore();
    flashIndex += 1;
    flashRevealed = false;
    renderFlashView();
  }

  // ========================================================================
  // VIEW 4: Pass Readiness Radar (과락 방어 + 3단계 최단기 합격 로드맵)
  // ========================================================================
  function renderRadarView() {
    const total = DB.topics.length;
    const mastered = DB.topics.filter((t) => getMasteryRecord(t.topic_code).status === "mastered").length;
    const fuzzy = DB.topics.filter((t) => getMasteryRecord(t.topic_code).status === "fuzzy").length;
    const sTopics = DB.topics.filter((t) => t.priority.tier === "S");
    const sMastered = sTopics.filter((t) => getMasteryRecord(t.topic_code).status === "mastered").length;
    const aTopics = DB.topics.filter((t) => t.priority.tier === "A");
    const aMastered = aTopics.filter((t) => getMasteryRecord(t.topic_code).status === "mastered").length;
    const btTopics = DB.topics.filter((t) => t.priority.tier === "B" || t.priority.tier === "T");
    const btMastered = btTopics.filter((t) => getMasteryRecord(t.topic_code).status === "mastered").length;

    const sPct = Math.round((sMastered / Math.max(1, sTopics.length)) * 100);
    const aPct = Math.round((aMastered / Math.max(1, aTopics.length)) * 100);
    const btPct = Math.round((btMastered / Math.max(1, btTopics.length)) * 100);

    const subjHtml = DB.subjects
      .map((s) => {
        const list = s.topic_codes.map((c) => topicByCode.get(c)).filter(Boolean);
        const done = list.filter((t) => getMasteryRecord(t.topic_code).status === "mastered").length;
        const sList = list.filter((t) => t.priority.tier === "S");
        const sDone = sList.filter((t) => getMasteryRecord(t.topic_code).status === "mastered").length;
        const pct = Math.round((done / Math.max(1, list.length)) * 100);
        const sSubjPct = Math.round((sDone / Math.max(1, sList.length)) * 100);

        let riskBadge = `<span class="risk-badge is-danger">과락 주의 (S급 ${sDone}/${sList.length})</span>`;
        if (pct >= 65 || sSubjPct >= 80) {
          riskBadge = `<span class="risk-badge is-ok">안정권 (S급 ${sDone}/${sList.length})</span>`;
        } else if (pct >= 35 || sSubjPct >= 50) {
          riskBadge = `<span class="risk-badge is-warn">보강 필요 (S급 ${sDone}/${sList.length})</span>`;
        }

        return `
          <div class="subj-balance-card">
            <div class="subj-balance-head">
              <span class="subj-balance-name">${escapeHtml(s.name)} (${done}/${list.length} · ${pct}%)</span>
              ${riskBadge}
            </div>
            <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${pct}%"></div></div>
          </div>
        `;
      })
      .join("");

    const trapBreakdownHtml = Object.entries(DB.meta.trap_technique_counts || {})
      .map(([tech, cnt]) => `<span class="profile-chip">${escapeHtml(tech)}<strong>${cnt}건</strong></span>`)
      .join("");

    el.viewRoot.innerHTML = `
      <section>
        <div class="page-hero">
          <h1>합격 레이더 & 과락 방어 현황</h1>
          <p>감리사 합격 기준(과목당 40점 과락 방지 · 전 과목 평균 60점 이상)에 맞춘 과학적 진행률입니다.</p>
        </div>

        <div class="radar-summary-grid">
          <div class="stat-tile">
            <div class="stat-label">전체 숙지율</div>
            <div class="stat-val">${Math.round((mastered / total) * 100)}%</div>
            <div class="stat-sub">${mastered} / ${total}토픽 완료 · 헷갈림 ${fuzzy}개</div>
          </div>
          <div class="stat-tile">
            <div class="stat-label">S급 필수 장악률</div>
            <div class="stat-val">${sPct}%</div>
            <div class="stat-sub">${sMastered} / ${sTopics.length}토픽 (전체 기출의 ${DB.meta.s_coverage_pct}%)</div>
          </div>
          <div class="stat-tile">
            <div class="stat-label">능동 회상 플래시</div>
            <div class="stat-val">${store.flashStats.reviewed}회</div>
            <div class="stat-sub">총 ${DB.meta.total_flashcards}장 중 숙지 응답 ${store.flashStats.known}회</div>
          </div>
        </div>

        <div class="section-head">
          <span class="section-num">01</span>
          <h2 class="section-title">5과목 균형 & 과락 방어 모니터링</h2>
        </div>
        <div class="subject-balance-list">${subjHtml}</div>

        <div class="section-head">
          <span class="section-num">02</span>
          <h2 class="section-title">최단기 합격 3단계 파레토 로드맵</h2>
        </div>
        <div class="roadmap-list">
          <div class="roadmap-item">
            <div class="roadmap-head">
              <span>Phase 1 · S급 필수 ${sTopics.length}토픽 장악 (출제 비중 ${DB.meta.s_coverage_pct}%)</span>
              <span>${sMastered}/${sTopics.length} (${sPct}%)</span>
            </div>
            <div class="roadmap-desc">과목당 최다 빈출 핵심 토픽만 먼저 끝내 빠르게 과락을 벗어나고 합격권(60점)에 진입합니다.</div>
            <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${sPct}%"></div></div>
          </div>
          <div class="roadmap-item">
            <div class="roadmap-head">
              <span>Phase 2 · A급 고빈출 ${aTopics.length}토픽 완성 (누적 비중 ${DB.meta.sa_coverage_pct}%)</span>
              <span>${aMastered}/${aTopics.length} (${aPct}%)</span>
            </div>
            <div class="roadmap-desc">S+A급을 마스터하면 13개년 기출의 약 90%를 커버하여 75점+ 안정 합격선을 확보합니다.</div>
            <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${aPct}%"></div></div>
          </div>
          <div class="roadmap-item">
            <div class="roadmap-head">
              <span>Phase 3 · B급 보강 + 기술사 신유형(T급) ${btTopics.length}토픽 마감</span>
              <span>${btMastered}/${btTopics.length} (${btPct}%)</span>
            </div>
            <div class="roadmap-desc">최근 기술사(120~136회)에서 내려오는 신유형까지 점검해 불의타 변수를 제거합니다.</div>
            <div class="mini-bar-track"><div class="mini-bar-fill" style="width:${btPct}%"></div></div>
          </div>
        </div>

        <div class="section-head">
          <span class="section-num">03</span>
          <h2 class="section-title">13개년 출제자 함정 설계 유형 (${DB.meta.total_traps}건)</h2>
        </div>
        <div class="profile-bars" style="margin-bottom:24px;">${trapBreakdownHtml}</div>

        <div class="backup-bar">
          <button id="exportProgressBtn" class="secondary-btn" type="button">학습 현황·메모 백업 (JSON)</button>
          <button id="importProgressBtn" class="secondary-btn" type="button">백업 불러오기</button>
          <button id="resetProgressBtn" class="secondary-btn" type="button" style="color:var(--crimson);">학습 기록 초기화</button>
          <input id="importProgressFile" type="file" accept=".json,application/json" hidden />
        </div>
      </section>
    `;
  }

  function renderActiveView() {
    if (activeView === "reader") renderReaderView();
    else if (activeView === "commute") renderCommuteView();
    else if (activeView === "flash") renderFlashView();
    else if (activeView === "radar") renderRadarView();
  }

  // ========================================================================
  // Event Delegation & Keyboard Shortcuts
  // ========================================================================
  function bindEvents() {
    el.drawerOpenBtn.addEventListener("click", () => setDrawerOpen(true));
    el.drawerCloseBtn.addEventListener("click", () => setDrawerOpen(false));
    el.drawerBackdrop.addEventListener("click", () => setDrawerOpen(false));

    el.themeToggleBtn.addEventListener("click", () => {
      store.theme = store.theme === "dark" ? "light" : "dark";
      saveStore();
      applyThemeAndFont();
    });

    el.fontSizeBtn.addEventListener("click", () => {
      const i = FONT_CYCLE.findIndex((f) => f.key === store.font);
      const next = FONT_CYCLE[(i + 1) % FONT_CYCLE.length];
      store.font = next.key;
      saveStore();
      applyThemeAndFont();
      showToast(`글자 크기: ${next.label}`);
    });

    // Global Search
    el.searchInput.addEventListener("input", () => {
      searchQuery = el.searchInput.value;
      el.searchClearBtn.classList.toggle("hidden", !searchQuery);
      renderSidebar();
    });
    el.searchClearBtn.addEventListener("click", () => {
      searchQuery = "";
      el.searchInput.value = "";
      el.searchClearBtn.classList.add("hidden");
      renderSidebar();
      el.searchInput.focus();
    });

    // Subject Tabs
    el.subjectTabs.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-subject]");
      if (!btn) return;
      store.activeSubject = btn.dataset.subject;
      searchQuery = "";
      el.searchInput.value = "";
      el.searchClearBtn.classList.add("hidden");
      const firstCode = subjectByCode.get(store.activeSubject)?.topic_codes[0];
      if (firstCode) store.activeTopic = firstCode;
      saveStore();
      renderSidebar();
      if (activeView === "reader") {
        syncNavTabs();
        renderReaderView();
        el.mainScroll.scrollTop = 0;
      }
    });

    // Tier Filters
    el.tierFilters.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-filter]");
      if (!btn) return;
      activeFilter = btn.dataset.filter;
      renderSidebar();
    });

    // Topic Click
    el.topicList.addEventListener("click", (e) => {
      const row = e.target.closest("[data-topic]");
      if (!row) return;
      openTopic(row.dataset.topic);
    });

    // View Switching (Desktop & Mobile Bottom Bar)
    document.querySelectorAll("[data-view]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const v = btn.dataset.view;
        if (v === "flash" && flashDeck.length === 0) {
          buildFlashDeck(flashScope);
        }
        switchView(v);
      });
    });

    // Delegated Main View Interactions
    el.viewRoot.addEventListener("click", (e) => {
      // Open topic from anywhere (pager, commute sprint, flash link)
      const openBtn = e.target.closest("[data-open-topic]");
      if (openBtn) {
        e.stopPropagation();
        openTopic(openBtn.dataset.openTopic);
        return;
      }

      // Blind mode toggle
      if (e.target.closest("#blindToggleBtn")) {
        blindMode = !blindMode;
        const art = document.getElementById("conceptArticle");
        const btn = document.getElementById("blindToggleBtn");
        if (art) art.classList.toggle("is-blind-active", blindMode);
        if (btn) {
          btn.classList.toggle("active", blindMode);
          btn.setAttribute("aria-pressed", String(blindMode));
          btn.querySelector("span").textContent = blindMode ? "블라인드 암기 ON" : "블라인드 암기";
        }
        // Reset revealed states when turning ON
        if (blindMode && art) {
          art.querySelectorAll(".is-revealed").forEach((n) => n.classList.remove("is-revealed"));
        }
        updateBlindCounterUI();
        return;
      }

      // Tap individual cloze pill or table cell in blind mode
      if (blindMode) {
        const cloze = e.target.closest(".cloze, .cloze-cell");
        if (cloze) {
          cloze.classList.toggle("is-revealed");
          updateBlindCounterUI();
          return;
        }
      }

      // Mastery status button
      const mBtn = e.target.closest(".mastery-btn[data-status]");
      if (mBtn) {
        setTopicMastery(store.activeTopic, mBtn.dataset.status);
        el.viewRoot.querySelectorAll(".mastery-btn").forEach((b) => {
          b.classList.toggle("active", b.dataset.status === mBtn.dataset.status);
        });
        return;
      }

      // Section jump pill
      const jBtn = e.target.closest("[data-jump]");
      if (jBtn) {
        const target = document.getElementById(jBtn.dataset.jump);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }

      // Launch flashcards for current topic
      if (e.target.closest("#topicFlashBtn")) {
        buildFlashDeck("topic");
        switchView("flash");
        return;
      }

      // Commute duration switch
      const cBtn = e.target.closest("[data-commute-min]");
      if (cBtn) {
        commuteMinutes = Number(cBtn.dataset.commuteMin) || 10;
        renderCommuteView();
        return;
      }

      // Start commute flashcard sprint
      if (e.target.closest("#startCommuteFlashBtn")) {
        buildFlashDeck("commute");
        switchView("flash");
        return;
      }

      // Flashcard flip & controls
      if (e.target.closest("#flashCardBox") && !e.target.closest("[data-open-topic]")) {
        flashRevealed = !flashRevealed;
        renderFlashView();
        return;
      }
      if (e.target.closest("#flashAgainBtn")) {
        advanceFlash(false);
        return;
      }
      if (e.target.closest("#flashGoodBtn")) {
        advanceFlash(true);
        return;
      }
      if (e.target.closest("#flashReshuffleBtn")) {
        buildFlashDeck(flashScope);
        renderFlashView();
        showToast("새 플래시카드 덱을 섞었습니다");
        return;
      }

      // Radar backup/import/reset
      if (e.target.closest("#exportProgressBtn")) {
        const blob = new Blob([JSON.stringify(store, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `garisa_concept_progress_${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
        showToast("학습 현황과 메모를 JSON으로 백업했습니다");
        return;
      }
      if (e.target.closest("#importProgressBtn")) {
        const inp = document.getElementById("importProgressFile");
        if (inp) inp.click();
        return;
      }
      if (e.target.closest("#resetProgressBtn")) {
        if (!window.confirm("모든 숙지 상태와 한 줄 암기 메모를 초기화할까요?")) return;
        store.mastery = {};
        store.memos = {};
        store.flashStats = { reviewed: 0, known: 0 };
        saveStore();
        renderSidebar();
        renderRadarView();
        showToast("학습 기록을 초기화했습니다");
        return;
      }
    });

    // Change events (flash scope select & backup file input)
    el.viewRoot.addEventListener("change", async (e) => {
      if (e.target.id === "flashScopeSelect") {
        buildFlashDeck(e.target.value);
        renderFlashView();
        return;
      }
      if (e.target.id === "importProgressFile") {
        const file = e.target.files?.[0];
        if (!file) return;
        try {
          const parsed = JSON.parse(await file.text());
          if (parsed && typeof parsed === "object") {
            if (parsed.mastery) store.mastery = parsed.mastery;
            if (parsed.memos) store.memos = parsed.memos;
            if (parsed.flashStats) store.flashStats = parsed.flashStats;
            saveStore();
            renderSidebar();
            renderRadarView();
            showToast("백업된 학습 현황을 불러왔습니다");
          }
        } catch {
          showToast("올바른 JSON 백업 파일이 아닙니다");
        } finally {
          e.target.value = "";
        }
      }
    });

    // Keyboard shortcuts (PC convenience)
    document.addEventListener("keydown", (e) => {
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (activeView === "flash" && flashIndex < flashDeck.length) {
        if (e.code === "Space") {
          e.preventDefault();
          flashRevealed = !flashRevealed;
          renderFlashView();
        } else if (flashRevealed && (e.key === "1" || e.key === "ArrowLeft")) {
          e.preventDefault();
          advanceFlash(false);
        } else if (flashRevealed && (e.key === "2" || e.key === "ArrowRight" || e.key === "Enter")) {
          e.preventDefault();
          advanceFlash(true);
        }
      } else if (activeView === "reader") {
        if (e.key === "b" || e.key === "B") {
          const btn = document.getElementById("blindToggleBtn");
          if (btn) btn.click();
        }
      }
    });
  }

  // Boot
  applyThemeAndFont();
  bindEvents();
  syncNavTabs();
  renderSidebar();
  renderActiveView();
})();
