#!/usr/bin/env python3
"""Build standalone concept_data.js for the GarisaStudy Concept Mastery Hub.

Synthesizes all 104 topics (1,560 verified past exam questions from 2014~2026
and 868 PE exam references) from web/data/study_data.json and
web/data/theory_data.json into a structured, offline-ready JS bundle:
  개념정리/concept_data.js  (window.CONCEPT_DB = {...})

Each topic includes:
  - Priority tier (S / A / B / T) based on 13-year frequency + 2024~2026 surge
  - Year-by-year exam frequency series (2014..2026)
  - Exam question archetype profile (부정형 / 정답선별 / 계산·코드 / 복합선다 / 빈칸·매칭)
  - Synthesized Exam Intent (출제 의도: 변별 목표, 빈출 출제 형태, 3초 풀이 전략)
  - Structured Core Concepts (확인하고자 하는 개념: 카드별 제목·불릿·주의사항)
  - Comparison & Memorization Table (핵심 비교·암기표)
  - Trap Engineering Breakdown (함정 설계 기법 태그 + 패턴 + 기출 실증 근거)
  - Recent Verified Exam Evidence (최근 기출 정답 논리 원라인 모음)
  - Cross-Domain Links & PE Trend Alert (타 과목 연계 + 기술사 신유형 경보)
  - Active-Recall Flashcards (함정 판별 + 비교표 핵심 암기 카드)
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent
STUDY_PATH = ROOT_DIR / "web" / "data" / "study_data.json"
THEORY_PATH = ROOT_DIR / "web" / "data" / "theory_data.json"
OUT_DIR = ROOT_DIR / "개념정리"
OUT_JS_PATH = OUT_DIR / "concept_data.js"

YEARS = [str(y) for y in range(2014, 2027)]

SUBJECT_META = {
    "01_월_감리및사업관리": {
        "short": "감리",
        "day": "월",
        "name": "감리 및 사업관리",
        "color_key": "audit",
        "exam_weight": 25,
        "core_focus": "법령 조항의 적용 기준(금액·기간·비율), 주체별 법정 역할 구분(발주자·사업자·감리법인·PMO), 감리 단계별 산출물 및 행정처분 수위",
    },
    "02_화_소프트웨어공학": {
        "short": "SW",
        "day": "화",
        "name": "소프트웨어 공학",
        "color_key": "swe",
        "exam_weight": 25,
        "core_focus": "개발 방법론·테스트 기법·디자인 패턴의 목적과 적용 상황 구분, UML·코드 실행 결과 추적, 척도·공식 계산 정확도",
    },
    "03_수_데이터베이스": {
        "short": "DB",
        "day": "수",
        "name": "데이터베이스",
        "color_key": "db",
        "exam_weight": 25,
        "core_focus": "SQL·관계대수 실행 결과 판별, 정규화·함수종속성 추론, 트랜잭션 격리수준·동시성 제어·회복(UNDO/REDO) 및 인덱스 구조",
    },
    "04_목_시스템구조": {
        "short": "시스템",
        "day": "목",
        "name": "시스템 구조",
        "color_key": "sys",
        "exam_weight": 25,
        "core_focus": "OS 스케줄링·가상메모리·동기화 동작 원리, 네트워크 계층별 프로토콜·TCP/IP 계산, 컴퓨터 구조·클라우드·분산 아키텍처 특성 비교",
    },
    "05_금_보안": {
        "short": "보안",
        "day": "금",
        "name": "보안",
        "color_key": "sec",
        "exam_weight": 20,
        "core_focus": "암호 알고리즘의 수학적 기반·키 구조·운용모드 구분, 공격 기법과 대응책의 1:1 매핑, 보안 인증·개인정보보호 법령 수치 및 절차",
    },
}


def classify_question_type(q_text: str) -> str:
    qt = q_text or ""
    if re.search(r"않은|틀린|잘못|먼\s*것은|아닌|부적절|적합하지\s*않", qt):
        return "오답찾기(부정형)"
    if re.search(r"모두\s*(?:고른|나열|묶은|선택)|옳은\s*것으로\s*묶|바르게\s*묶", qt):
        return "복합선다(가나다)"
    if re.search(r"빈칸|괄호|들어갈|㉮|㉠", qt):
        return "빈칸·매칭형"
    if re.search(
        r"계산|구한|출력\s*결과|실행\s*결과|수행\s*결과|몇\s*(?:개|번|일|초|비트|바이트)|시간은|비용은|확률|크기는|개수는|순환복잡도|평균|최소|최대|합은|값은",
        qt,
    ):
        return "계산·추적형"
    return "개념선별(정답형)"


def classify_trap_technique(pattern: str, example_ref: str = "") -> str:
    # Classify primarily from the trap pattern itself (strip exam year/round strings)
    pat = re.sub(r"\d{4}년(?:\(제\d+회\))?", "", pattern or "")
    if re.search(r"계산|공식|환산|곱셈|나눗셈|단위|bit|Byte|클록|시간\s*계산|확률|복잡도|속도|산정\s*공식|대역폭", pat):
        return "계산·단위 함정"
    if re.search(r"주체|역할|책임|발주자|감리법인|사업자|PMO|주관기관|전문기관|소관|기관\s*범위|담당|수행\s*주체", pat):
        return "주체·역할 바꿔치기"
    if re.search(r"경계|미만|이상|초과|이하|퍼센트|%|개월|억원|억\s|일\s*이내|수치|기한|비율|개수|배수|연한|\d+년", pat):
        return "수치·경계값 변조"
    if re.search(r"순서|단계|절차|선후|수위\s*역전|경중|우선순위|이전|이후|직전|직후|시점", pat):
        return "순서·단계·수위 역전"
    if re.search(r"AND|OR|필수|임의|필요적|의무|면제|생략|예외|반대|불가|불성립|위배|역전|왜곡|금지|허용|포함|제외|여부", pat):
        return "조건·논리 반전"
    return "유사개념 혼동·치환"


def split_sub_items(body_text: str) -> list[dict]:
    raw = str(body_text or "").strip()
    if not raw:
        return []
    masks: list[str] = []

    def _mask(m: re.Match) -> str:
        idx = len(masks)
        masks.append(m.group(0))
        return f"\u0001M{idx}\u0001"

    masked = re.sub(r"`[^`\n]+`|\([^()\n]*※[^()\n]*\)", _mask, raw)
    normalized = re.sub(r"\s+(?=[①②③④⑤⑥⑦⑧⑨]\s+)", "\n", masked)
    normalized = re.sub(r"\s+(?=•\s+)", "\n", normalized)
    normalized = re.sub(
        r"(?:^|[.!?:])\s+(?=※\s*)",
        lambda m: "\n" if m.group(0).startswith(" ") else m.group(0)[0] + "\n",
        normalized,
    )
    normalized = re.sub(r"([.!?])\s+(?=-\s+(?!\d))", r"\1\n", normalized)

    out: list[dict] = []
    for line in normalized.split("\n"):
        s = re.sub(r"\u0001M(\d+)\u0001", lambda m: masks[int(m.group(1))], line).strip()
        if not s:
            continue
        if s.startswith("※"):
            out.append({"kind": "note", "marker": "※", "text": re.sub(r"^※\s*", "", s)})
            continue
        cm = re.match(r"^([①②③④⑤⑥⑦⑧⑨])\s+(.+)$", s)
        if cm:
            out.append({"kind": "num", "marker": cm.group(1), "text": cm.group(2)})
            continue
        bm = re.match(r"^[•\-·]\s+(.+)$", s)
        if bm:
            out.append({"kind": "bullet", "marker": "•", "text": bm.group(1)})
            continue
        out.append({"kind": "text", "marker": "", "text": s})
    return out


def parse_core_summary_blocks(summary: str) -> list[dict]:
    raw = str(summary or "").strip()
    if not raw:
        return []

    code_masks: list[str] = []

    def _mask_code(m: re.Match) -> str:
        idx = len(code_masks)
        code_masks.append(m.group(0))
        return f"\u0002C{idx}\u0002"

    safe_raw = re.sub(r"`[^`\n]+`", _mask_code, raw)
    unmask = lambda s: re.sub(r"\u0002C(\d+)\u0002", lambda m: code_masks[int(m.group(1))], s)

    raw_blocks: list[tuple[str, str]] = []

    if re.search(r"(?:^|\s)\[[^\]\n]{2,56}\]\s+", safe_raw):
        parts = [
            unmask(p).strip()
            for p in re.sub(r"\s+(?=\[[^\]\n]{2,56}\]\s+)", "\n", safe_raw).split("\n")
            if p.strip()
        ]
        for part in parts:
            m = re.match(r"^\[([^\]\n]{2,56})\]\s+(.+)$", part)
            if m:
                raw_blocks.append((m.group(1).strip(), m.group(2).strip()))
            else:
                raw_blocks.append(("", part))
    elif re.search(r"(?:^|\s)■\s+", safe_raw):
        parts = [
            re.sub(r"^■\s*", "", unmask(p)).strip()
            for p in re.sub(r"\s+(?=■\s+)", "\n", safe_raw).split("\n")
            if p.strip()
        ]
        for part in parts:
            m = re.match(r"^([^:\n]{2,42}):\s+(.+)$", part)
            if m:
                raw_blocks.append((m.group(1).strip(), m.group(2).strip()))
            else:
                raw_blocks.append(("", part))
    elif re.search(r"(?:^|\s)[•\-]\s+\*\*[^*\n]{2,46}\*\*\s*:", safe_raw):
        parts = [
            re.sub(r"^[•\-]\s+", "", unmask(p)).strip()
            for p in re.sub(r"\s+(?=[•\-]\s+\*\*[^*\n]{2,46}\*\*\s*:)", "\n", safe_raw).split("\n")
            if p.strip()
        ]
        for part in parts:
            m = re.match(r"^\*\*([^*\n]{2,46})\*\*\s*:\s*(.+)$", part)
            if m:
                raw_blocks.append((m.group(1).strip(), m.group(2).strip()))
            else:
                raw_blocks.append(("", part))
    elif re.search(r"(?:^|\s)•\s+[^:\n]{2,36}:\s+", safe_raw):
        parts = [
            re.sub(r"^•\s+", "", unmask(p)).strip()
            for p in re.sub(r"\s+(?=•\s+[^:\n]{2,36}:\s+)", "\n", safe_raw).split("\n")
            if p.strip()
        ]
        for part in parts:
            m = re.match(r"^([^:\n]{2,36}):\s+(.+)$", part)
            if m:
                raw_blocks.append((m.group(1).strip(), m.group(2).strip()))
            else:
                raw_blocks.append(("", part))
    elif re.search(r"(?:^|\s)[①②③④⑤⑥]\s+", safe_raw):
        parts = [
            unmask(p).strip()
            for p in re.sub(r"\s+(?=[①②③④⑤⑥]\s+)", "\n", safe_raw).split("\n")
            if p.strip()
        ]
        for part in parts:
            m = re.match(r"^([①②③④⑤⑥])\s+\*\*([^*\n]{2,42})\*\*\s*[:：]?\s*(.+)$", part)
            if m:
                raw_blocks.append((f"{m.group(1)} {m.group(2).strip()}", m.group(3).strip()))
                continue
            m2 = re.match(r"^([①②③④⑤⑥])\s+([^:\n]{2,36}):\s+(.+)$", part)
            if m2:
                raw_blocks.append((f"{m2.group(1)} {m2.group(2).strip()}", m2.group(3).strip()))
                continue
            raw_blocks.append(("", part))
    else:
        raw_blocks.append(("핵심 이론 요약", raw))

    blocks = []
    for title, body in raw_blocks:
        items = split_sub_items(body)
        if items:
            blocks.append({"title": title, "items": items})
    return blocks


def compute_priority(topic: dict) -> dict:
    if topic.get("is_trend"):
        return {
            "tier": "T",
            "label": "T급 신유형",
            "reason": f"기술사 기출 {topic.get('pe_count', 0)}건 기반 차기 출제 유력",
            "score": 65,
        }
    rank = int(topic.get("frequency_rank") or 99)
    g_cnt = int(topic.get("gamrisa_count") or 0)
    recent = int(topic.get("gamrisa_recent_count") or 0)
    pe_cnt = int(topic.get("pe_count") or 0)
    score = g_cnt * 3 + recent * 5 + min(pe_cnt, 20)

    if rank <= 6 or recent >= 9:
        reason = f"과목 내 빈출 {rank}위 · 13개년 {g_cnt}회(최근 3년 {recent}회) — 최우선 필수 장악"
        return {"tier": "S", "label": "S급 필수", "reason": reason, "score": score}
    if rank <= 13 or recent >= 5:
        reason = f"과목 내 빈출 {rank}위 · 13개년 {g_cnt}회(최근 3년 {recent}회) — 안정 합격선(70+) 핵심"
        return {"tier": "A", "label": "A급 고빈출", "reason": reason, "score": score}
    reason = f"과목 내 빈출 {rank}위 · 13개년 {g_cnt}회(최근 3년 {recent}회) — 과락 방어·보강"
    return {"tier": "B", "label": "B급 보강", "reason": reason, "score": score}


def synthesize_exam_intent(
    subj_meta: dict,
    topic: dict,
    theory: dict,
    profile_list: list[dict],
    trap_techs: list[str],
    concept_blocks: list[dict],
) -> dict:
    is_trend = bool(topic.get("is_trend"))
    g_cnt = int(topic.get("gamrisa_count") or 0)
    recent = int(topic.get("gamrisa_recent_count") or 0)
    pe_cnt = int(topic.get("pe_count") or 0)
    raw_kws = [k for k in (topic.get("top_keywords") or []) if k]
    top_kws = []
    seen_kw_norm = set()
    for k in raw_kws:
        norm = re.sub(r"\s+", "", k).lower()
        if norm not in seen_kw_norm:
            seen_kw_norm.add(norm)
            top_kws.append(k)
        if len(top_kws) >= 6:
            break
    block_titles = [b["title"] for b in concept_blocks if b.get("title")][:4]

    tech_counter = Counter(trap_techs)
    top_techs = [t for t, _ in tech_counter.most_common(2)]

    if is_trend:
        goal = (
            f"최근 120~136회 기술사 기출({pe_cnt}건)에서 집중 출제된 신기술·신규 제도가 "
            f"감리사 4지선다 객관식으로 하향 출제될 때, 핵심 원리와 기존 기술과의 차별점을 정확히 판별하는지 검증합니다."
        )
        strategy = (
            "세부 구현 암기보다 '용어 정의 → 기존 기술 대비 차이점 → 감리·현장 적용 리스크' 3축으로 압축 정리해 낯선 선지를 소거하세요."
        )
    else:
        dom_type = profile_list[0]["type"] if profile_list else "개념선별(정답형)"
        dom_pct = profile_list[0]["pct"] if profile_list else 0
        focus_axes = " · ".join(block_titles) if block_titles else (topic.get("desc") or topic["topic"])
        tech_phrase = " 및 ".join(top_techs) if top_techs else "유사개념 혼동"

        trend_note = ""
        if recent >= 5:
            trend_note = f" 특히 최근 3개년(2024~2026)에만 {recent}문항이 집중 출제된 상승 핵심 영역입니다."
        elif recent >= 3:
            trend_note = f" 최근 3개년에도 {recent}회 꾸준히 재출제되고 있습니다."

        goal = (
            f"[{focus_axes}]의 핵심 기준을 정확히 구분할 수 있는지 평가합니다. "
            f"13개년 총 {g_cnt}문항 중 '{dom_type}'({dom_pct}%) 비중이 가장 높으며, "
            f"주로 '{tech_phrase}' 방식으로 변별력을 확보합니다.{trend_note}"
        )

        # Actionable 3-second decision rule matched to dominant question & trap types
        if "계산·추적형" == dom_type or "계산·단위 함정" in top_techs:
            strategy = "공식 대입 직전 '단위 환산(bit↔Byte, ns↔클록, 개월↔년)'과 '경계·예외 조건'을 먼저 동그라미 치고 계산하면 함정을 90% 차단합니다."
        elif "수치·경계값 변조" in top_techs:
            strategy = "비슷한 숫자와 경계어(이상↔초과, 미만↔이하, AND↔OR)를 표로 대조 암기하고, 선지에서 숫자·조사부터 먼저 검증하세요."
        elif "주체·역할 바꿔치기" in top_techs:
            strategy = "선지를 읽을 때 문장 끝이 아니라 맨 앞 '주어(발주자·사업자·감리법인·PMO / 주체)'와 '단계·시점'이 맞는지부터 대조하세요."
        elif dom_type == "오답찾기(부정형)":
            strategy = "부정형 출제 비중이 높습니다. '항상·반드시·모든·불가능' 같은 극단 표현과 개념의 주체·방향이 뒤바뀐 선지를 1순위로 의심하세요."
        elif "순서·단계·수위 역전" in top_techs:
            strategy = "단계·절차·처분 수위는 순서를 두문자나 화살표 흐름으로 고정해 두고, 인접 단계를 뒤바꾼 선지를 즉시 잡아내세요."
        else:
            strategy = "비교표의 1열(개념명)과 핵심 차별 속성 1개씩을 1:1 짝지어 외운 뒤, 블라인드 모드로 키워드만 가리고 30초 회상 훈련을 반복하세요."

    verify_points = []
    if block_titles:
        verify_points.extend(block_titles[:4])
    elif topic.get("desc"):
        verify_points.extend([x.strip() for x in re.split(r"[,·]", topic["desc"]) if x.strip()][:4])

    return {
        "goal": goal,
        "verify_points": verify_points,
        "strategy": strategy,
        "key_keywords": top_kws,
        "subject_focus": subj_meta["core_focus"],
    }


def extract_recent_evidence(topic: dict) -> list[dict]:
    if topic.get("is_trend"):
        pes = sorted(
            topic.get("pe_questions") or [],
            key=lambda p: (-(p.get("year") or 0), p.get("id", "")),
        )
        ev = []
        for p in pes[:5]:
            ev.append({
                "ref": f"{p.get('exam_type', '기술사')} {p.get('year_round', '')} {p.get('session', '')} {p.get('number', '')}번".strip(),
                "keywords": (p.get("keywords") or [])[:4],
                "summary": (p.get("relevance_note") or p.get("question") or "").strip(),
                "is_pe": True,
            })
        return ev

    qs = list(topic.get("gamrisa_questions") or [])

    def _yr_key(q: dict):
        m = re.search(r"(\d{4})년", q.get("year_round", ""))
        yr = int(m.group(1)) if m else 0
        return (-yr, int(q.get("number") or 0))

    qs.sort(key=_yr_key)
    ev = []
    seen_expl = set()
    for q in qs:
        expl = (q.get("short_explanation") or "").strip()
        if not expl or expl in seen_expl:
            continue
        seen_expl.add(expl)
        ev.append({
            "ref": f"{q.get('year_round', '')} {q.get('number', '')}번",
            "q_type": classify_question_type(q.get("question", "")),
            "keywords": (q.get("keywords") or [])[:4],
            "summary": expl,
            "is_pe": False,
        })
        if len(ev) >= 5:
            break
    return ev


def build_flashcards(subject_code: str, subject_short: str, topic: dict, theory: dict, priority: dict, traps_enriched: list[dict]) -> list[dict]:
    cards = []
    tcode = topic["topic_code"]
    tname = topic["topic"]

    # 1. Trap-killer flashcards (highest exam ROI)
    for idx, tr in enumerate(traps_enriched):
        pattern = tr["pattern"].strip()
        ref = tr["example_ref"].strip()
        # Mask parenthetical answers or quotes on the front so the user actively recalls the exact distinction
        masked = re.sub(r"\([^()]{5,}\)", "( ? )", pattern)
        masked = re.sub(r"'[^']{2,20}'", "' ? '", masked).strip()
        front_text = f"[{tname}]\n{masked}\n\n→ 실제 정답 기준과 기출 변조 포인트를 떠올려 보세요."
        back_title = f"정확한 함정 설계: {pattern}" if masked != pattern else "실제 기출 변조 근거 & 회피 기준"
        cards.append({
            "id": f"{tcode}_trap_{idx+1}",
            "kind": "trap",
            "subject_code": subject_code,
            "subject_short": subject_short,
            "topic_code": tcode,
            "topic_name": tname,
            "tier": priority["tier"],
            "tag": tr["technique"],
            "front": front_text,
            "hint": f"기출 출제 근거 확인 · {tname}",
            "back_main": back_title,
            "back_detail": ref or pattern,
        })

    # 2. High-value comparison table flashcards (up to 3 key rows per topic)
    tbl = theory.get("comparison_table") or {}
    headers = tbl.get("headers") or []
    rows = tbl.get("rows") or []
    if len(headers) >= 2 and rows:
        for r_idx, row in enumerate(rows[:3]):
            if not row or not str(row[0]).strip():
                continue
            item_name = str(row[0]).strip()
            details = []
            for h, cell in zip(headers[1:], row[1:]):
                c_str = str(cell or "").strip()
                if c_str:
                    details.append(f"• {h}: {c_str}")
            if not details:
                continue
            cards.append({
                "id": f"{tcode}_tbl_{r_idx+1}",
                "kind": "table",
                "subject_code": subject_code,
                "subject_short": subject_short,
                "topic_code": tcode,
                "topic_name": tname,
                "tier": priority["tier"],
                "tag": "핵심 비교 암기",
                "front": f"[{tbl.get('title') or tname}]\n'{item_name}'의 핵심 기준·특징·함정 포인트를 떠올려 보세요.",
                "hint": " / ".join(headers[1:]),
                "back_main": item_name,
                "back_detail": "\n".join(details),
            })

    return cards


def main() -> None:
    study = json.loads(STUDY_PATH.read_text(encoding="utf-8"))
    theory_map = json.loads(THEORY_PATH.read_text(encoding="utf-8"))

    subjects_out = []
    all_topics_out = []
    all_flashcards = []

    tier_counts = Counter()
    tech_counts = Counter()

    for s in study["subjects"]:
        scode = s["subject_code"]
        smeta = SUBJECT_META[scode]
        s_topics = []

        for t in s["topics"]:
            tcode = t["topic_code"]
            th = theory_map.get(tcode, {})

            # Year histogram (2014..2026)
            yr_hist = {y: 0 for y in YEARS}
            q_type_counter = Counter()
            for q in t.get("gamrisa_questions") or []:
                m = re.search(r"(\d{4})년", q.get("year_round", ""))
                if m and m.group(1) in yr_hist:
                    yr_hist[m.group(1)] += 1
                q_type_counter[classify_question_type(q.get("question", ""))] += 1

            total_q = sum(q_type_counter.values())
            profile_list = []
            if total_q > 0:
                for qtype, cnt in q_type_counter.most_common():
                    profile_list.append({
                        "type": qtype,
                        "count": cnt,
                        "pct": round(cnt / total_q * 100),
                    })

            concept_blocks = parse_core_summary_blocks(th.get("core_summary", ""))

            traps_enriched = []
            trap_techs = []
            for tp in th.get("trap_patterns") or []:
                pat = str(tp.get("pattern") or "").strip()
                ref = str(tp.get("example_ref") or "").strip()
                tech = classify_trap_technique(pat, ref)
                trap_techs.append(tech)
                tech_counts[tech] += 1
                traps_enriched.append({
                    "technique": tech,
                    "pattern": pat,
                    "example_ref": ref,
                })

            priority = compute_priority(t)
            tier_counts[priority["tier"]] += 1

            intent = synthesize_exam_intent(smeta, t, th, profile_list, trap_techs, concept_blocks)
            evidence = extract_recent_evidence(t)

            cards = build_flashcards(scode, smeta["short"], t, th, priority, traps_enriched)
            all_flashcards.extend(cards)

            topic_obj = {
                "topic_code": tcode,
                "subject_code": scode,
                "subject_short": smeta["short"],
                "subject_name": smeta["name"],
                "topic": t["topic"],
                "desc": t.get("desc", ""),
                "is_trend": bool(t.get("is_trend")),
                "frequency_rank": t.get("frequency_rank"),
                "gamrisa_count": int(t.get("gamrisa_count") or 0),
                "gamrisa_recent_count": int(t.get("gamrisa_recent_count") or 0),
                "pe_count": int(t.get("pe_count") or 0),
                "priority": priority,
                "year_series": [yr_hist[y] for y in YEARS],
                "question_profile": profile_list,
                "exam_intent": intent,
                "core_blocks": concept_blocks,
                "comparison_table": th.get("comparison_table") or None,
                "traps": traps_enriched,
                "recent_evidence": evidence,
                "cross_domain_links": th.get("cross_domain_links") or [],
                "pe_trend_alert": th.get("pe_trend_alert") or "",
                "flashcard_count": len(cards),
            }
            s_topics.append(topic_obj)
            all_topics_out.append(topic_obj)

        s_tier_s = sum(1 for x in s_topics if x["priority"]["tier"] == "S")
        subjects_out.append({
            "subject_code": scode,
            "day": smeta["day"],
            "short": smeta["short"],
            "name": smeta["name"],
            "display_name": s["display_name"],
            "exam_weight": smeta["exam_weight"],
            "core_focus": smeta["core_focus"],
            "gamrisa_count": s["gamrisa_count"],
            "pe_count": s["pe_count"],
            "topic_count": len(s_topics),
            "tier_s_count": s_tier_s,
            "topic_codes": [x["topic_code"] for x in s_topics],
        })

    # Compute Pareto coverage stats for S-tier and S+A-tier
    reg_total = sum(x["gamrisa_count"] for x in all_topics_out if not x["is_trend"])
    s_q_total = sum(x["gamrisa_count"] for x in all_topics_out if x["priority"]["tier"] == "S")
    sa_q_total = sum(x["gamrisa_count"] for x in all_topics_out if x["priority"]["tier"] in ("S", "A"))

    db = {
        "meta": {
            "title": "정보시스템 감리사 최단기 합격 개념서",
            "years": YEARS,
            "total_topics": len(all_topics_out),
            "total_gamrisa": reg_total,
            "total_pe": sum(s["pe_count"] for s in subjects_out),
            "total_traps": sum(len(t["traps"]) for t in all_topics_out),
            "total_flashcards": len(all_flashcards),
            "tier_counts": dict(tier_counts),
            "s_coverage_pct": round(s_q_total / reg_total * 100, 1) if reg_total else 0,
            "sa_coverage_pct": round(sa_q_total / reg_total * 100, 1) if reg_total else 0,
            "trap_technique_counts": dict(tech_counts.most_common()),
        },
        "subjects": subjects_out,
        "topics": all_topics_out,
        "flashcards": all_flashcards,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    js_payload = "window.CONCEPT_DB = " + json.dumps(db, ensure_ascii=False, separators=(",", ":")) + ";\n"
    OUT_JS_PATH.write_text(js_payload, encoding="utf-8")

    print(f"Generated {OUT_JS_PATH} ({OUT_JS_PATH.stat().st_size / 1024:.1f} KB)")
    print(f"  Topics: {db['meta']['total_topics']} | Tiers: {db['meta']['tier_counts']}")
    print(f"  S-tier coverage: {db['meta']['s_coverage_pct']}% | S+A coverage: {db['meta']['sa_coverage_pct']}%")
    print(f"  Total traps: {db['meta']['total_traps']} | Flashcards: {db['meta']['total_flashcards']}")
    print(f"  Trap techniques: {db['meta']['trap_technique_counts']}")


if __name__ == "__main__":
    main()
