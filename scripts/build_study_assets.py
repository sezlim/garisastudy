import collections
import datetime
import json
import os
import re

DAY_LABELS = {
    "01_월_감리및사업관리": "월요일 · 감리 및 사업관리",
    "02_화_소프트웨어공학": "화요일 · 소프트웨어 공학",
    "03_수_데이터베이스": "수요일 · 데이터베이스",
    "04_목_시스템구조": "목요일 · 시스템 구조",
    "05_금_보안": "금요일 · 보안",
}

TREND_TOPICS = {
    "01_월_감리및사업관리": {
        "code": "01-T",
        "name": "신규 출제 예상(트렌드)",
        "desc": "디지털플랫폼정부(DPG), AI기본법/EU AI Act, 마이데이터, 핀테크/레그테크, 공공SW 혁신·거버넌스, ESG/탄소중립 IT, 디지털트윈 정책 등 감리사 미출제·희소 최신 정책/사업관리 트렌드",
    },
    "02_화_소프트웨어공학": {
        "code": "02-T",
        "name": "신규 출제 예상(트렌드)",
        "desc": "MLOps/LLMOps/AIOps, DevSecOps/GitOps, 플랫폼 엔지니어링, 생성형AI 코딩/에이전트, Low-code/No-code, 카오스 엔지니어링, WebAssembly, 도메인주도설계(DDD)/이벤트소싱 심화 등 최신 SW공학 트렌드",
    },
    "03_수_데이터베이스": {
        "code": "03-T",
        "name": "신규 출제 예상(트렌드)",
        "desc": "벡터DB(Vector DB)·임베딩 검색, RAG 데이터 파이프라인/GraphRAG, 데이터 메시·데이터 패브릭, 레이크하우스(Delta/Iceberg), 합성데이터, 데이터 리니지/최신 데이터 거버넌스, 실시간 CDC/스트림 DB 등 최신 데이터 트렌드",
    },
    "04_목_시스템구조": {
        "code": "04-T",
        "name": "신규 출제 예상(트렌드)",
        "desc": "AI반도체(NPU/PIM/CXL/HBM), 온디바이스AI/멀티모달/AI에이전트 아키텍처, 6G/저궤도위성(LEO)/오픈랜, 엣지·포그컴퓨팅, 서비스메시/eBPF/FinOps, 디지털트윈 인프라/자율주행/메타버스·XR 등 최신 인프라/신기술 트렌드",
    },
    "05_금_보안": {
        "code": "05-T",
        "name": "신규 출제 예상(트렌드)",
        "desc": "양자내성암호(PQC)/양자암호통신(QKD), 공급망 보안/SBOM, 국가망보안체계(N2SF), LLM 프롬프트 인젝션/AI 레드팀/OWASP LLM Top 10, SOAR/XDR/ASM/CSPM, 프라이버시강화기술(PET/연합학습/차분프라이버시), 기밀컴퓨팅(TEE), 사이버복원력(CRA) 등 최신 보안 트렌드",
    },
}

CIRCLED = {"1": "①", "2": "②", "3": "③", "4": "④"}


def clean_md(text: str) -> str:
    if not text:
        return ""
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    lines = [ln.rstrip() for ln in text.splitlines()]
    return "\n".join(lines).strip()


def clean_inline(text: str) -> str:
    return re.sub(r"\s+", " ", clean_md(text)).strip()


def year_int(year_round: str) -> int:
    m = re.search(r"(\d{4})", year_round or "")
    return int(m.group(1)) if m else 0


def round_int(year_round: str) -> int:
    m = re.search(r"제(\d+)회", year_round or "")
    return int(m.group(1)) if m else 0


def session_int(session: str) -> int:
    m = re.search(r"(\d+)", session or "")
    return int(m.group(1)) if m else 0


def main():
    with open("data/taxonomy.json", encoding="utf-8") as f:
        taxonomy = json.load(f)
    with open("data/gamrisa_tagged.json", encoding="utf-8") as f:
        gamrisa = json.load(f)
    with open("data/pe_mapped.json", encoding="utf-8") as f:
        pe_items = json.load(f)

    # Index by (subject_code, topic_code)
    g_by_topic = collections.defaultdict(list)
    for g in gamrisa:
        g_by_topic[(g["subject_code"], g["topic_code"])].append(g)

    p_by_topic = collections.defaultdict(list)
    for p in pe_items:
        p_by_topic[(p["subject_code"], p["topic_code"])].append(p)

    # Build unified study_data structure
    subjects_out = []
    total_topics = 0
    total_pe_trend = 0

    for subj in taxonomy["subjects"]:
        sc = subj["subject_code"]
        regular_topics = []

        for t in subj["topics"]:
            tc = t["code"]
            g_list = sorted(
                g_by_topic[(sc, tc)],
                key=lambda x: (-year_int(x["year_round"]), -round_int(x["year_round"]), x["number"]),
            )
            p_list = sorted(
                p_by_topic[(sc, tc)],
                key=lambda x: (
                    -year_int(x["year_round"]),
                    -round_int(x["year_round"]),
                    x["exam_type"],
                    session_int(x["session"]),
                    x["number"],
                ),
            )
            recent_cnt = sum(1 for x in g_list if year_int(x["year_round"]) >= 2021)

            kw_counter = collections.Counter()
            for x in g_list:
                for kw in x.get("keywords", []):
                    kw_counter[kw] += 1
            for x in p_list:
                for kw in x.get("keywords", []):
                    kw_counter[kw] += 1
            top_kws = [k for k, _ in kw_counter.most_common(10)]

            regular_topics.append(
                {
                    "topic_code": tc,
                    "topic": t["name"],
                    "desc": t["desc"],
                    "is_trend": False,
                    "gamrisa_count": len(g_list),
                    "gamrisa_recent_count": recent_cnt,
                    "pe_count": len(p_list),
                    "top_keywords": top_kws,
                    "gamrisa_questions": g_list,
                    "pe_questions": p_list,
                }
            )

        # Sort regular topics by Gamrisa frequency desc (tie-break: recent desc, PE desc, code asc)
        regular_topics.sort(
            key=lambda x: (-x["gamrisa_count"], -x["gamrisa_recent_count"], -x["pe_count"], x["topic_code"])
        )
        for rank, item in enumerate(regular_topics, start=1):
            item["frequency_rank"] = rank

        # Build trend topic
        tr = TREND_TOPICS[sc]
        tr_code = tr["code"]
        tr_pe = sorted(
            p_by_topic[(sc, tr_code)],
            key=lambda x: (
                -year_int(x["year_round"]),
                -round_int(x["year_round"]),
                x["exam_type"],
                session_int(x["session"]),
                x["number"],
            ),
        )
        tr_kw_counter = collections.Counter()
        for x in tr_pe:
            for kw in x.get("keywords", []):
                tr_kw_counter[kw] += 1
        trend_topic = {
            "topic_code": tr_code,
            "topic": tr["name"],
            "desc": tr["desc"],
            "is_trend": True,
            "frequency_rank": None,
            "gamrisa_count": 0,
            "gamrisa_recent_count": 0,
            "pe_count": len(tr_pe),
            "top_keywords": [k for k, _ in tr_kw_counter.most_common(12)],
            "gamrisa_questions": [],
            "pe_questions": tr_pe,
        }

        all_topics = regular_topics + [trend_topic]
        total_topics += len(all_topics)
        total_pe_trend += len(tr_pe)

        subj_g_cnt = sum(t["gamrisa_count"] for t in all_topics)
        subj_p_cnt = sum(t["pe_count"] for t in all_topics)

        subjects_out.append(
            {
                "subject_code": sc,
                "display_name": DAY_LABELS.get(sc, sc),
                "raw_subject": subj["raw_subject"],
                "gamrisa_count": subj_g_cnt,
                "pe_count": subj_p_cnt,
                "pe_existing_count": subj_p_cnt - len(tr_pe),
                "pe_trend_count": len(tr_pe),
                "topics": all_topics,
            }
        )

    study_data = {
        "meta": {
            "generated_at": datetime.datetime.now().isoformat(timespec="seconds"),
            "gamrisa_total": len(gamrisa),
            "pe_total": len(pe_items),
            "pe_existing_total": len(pe_items) - total_pe_trend,
            "pe_trend_total": total_pe_trend,
            "subjects_count": len(subjects_out),
            "topics_count": total_topics,
        },
        "subjects": subjects_out,
    }

    # Verify zero dropped questions
    assert sum(s["gamrisa_count"] for s in subjects_out) == len(gamrisa), "Gamrisa count mismatch!"
    assert sum(s["pe_count"] for s in subjects_out) == len(pe_items), "PE count mismatch!"

    # Save Artifact A: web/data/study_data.json
    os.makedirs("web/data", exist_ok=True)
    study_json_path = "web/data/study_data.json"
    with open(study_json_path, "w", encoding="utf-8") as f:
        json.dump(study_data, f, ensure_ascii=False, indent=2)
    print(f"[A] Saved {study_json_path} ({os.path.getsize(study_json_path):,} bytes)")

    # Save Artifact B: docs_md/01_월_감리및사업관리.md ~ 05_금_보안.md
    os.makedirs("docs_md", exist_ok=True)
    for subj in subjects_out:
        sc = subj["subject_code"]
        md_path = os.path.join("docs_md", f"{sc}.md")
        lines = []
        lines.append(f"# {sc} ({subj['display_name']})")
        lines.append("")
        lines.append("> **정보시스템 감리사 학습용 통합 기출 데이터베이스 (Gemini Gem / NotebookLM 지식베이스용)**")
        lines.append(
            f"> - **감리사 기출 (2014~2026년, 제15~27회)**: 총 **{subj['gamrisa_count']}문항**"
        )
        lines.append(
            f"> - **연관 기술사 기출 (2020~2025년, 정보관리·컴응)**: 총 **{subj['pe_count']}문항** "
            f"(기존 토픽 연계 {subj['pe_existing_count']}문항 + 신규 출제 예상 트렌드 {subj['pe_trend_count']}문항)"
        )
        lines.append("> - **정렬 기준**: 감리사 기출 빈출순(내림차순), 각 토픽 내 기출은 최신순(2026→2014 / 2025→2020)")
        lines.append("")

        # Summary table
        lines.append("## 과목 토픽별 출제 빈도 요약표")
        lines.append("")
        lines.append("| 빈출 순위 | 토픽 코드 | 토픽명 | 감리사 전체 | 감리사 최근(21~26) | 연관 기술사 |")
        lines.append("|:---:|:---:|---|---:|---:|---:|")
        for t in subj["topics"]:
            rank_str = f"{t['frequency_rank']}위" if not t["is_trend"] else "트렌드"
            lines.append(
                f"| {rank_str} | `{t['topic_code']}` | {t['topic']} | {t['gamrisa_count']} | {t['gamrisa_recent_count']} | {t['pe_count']} |"
            )
        lines.append("")
        lines.append("---")
        lines.append("")

        # Detailed topic sections
        for t in subj["topics"]:
            if not t["is_trend"]:
                lines.append(f"## [빈출 {t['frequency_rank']}위] {t['topic_code']} {t['topic']}")
                lines.append("")
                lines.append(f"- **핵심 범위**: {t['desc']}")
                lines.append(
                    f"- **출제 현황**: 감리사 **{t['gamrisa_count']}문항** (최근 6년 `2021~2026`: **{t['gamrisa_recent_count']}문항**) / 연관 기술사 **{t['pe_count']}문항**"
                )
            else:
                lines.append(f"## [신규 출제 예상(트렌드)] {t['topic_code']} {t['topic']}")
                lines.append("")
                lines.append(f"- **트렌드 범위**: {t['desc']}")
                lines.append(
                    f"- **출제 현황**: 감리사 기출 희소·미출제 영역 / 최근 기술사 반복 출제 **{t['pe_count']}문항** (향후 감리사 신유형 대비 필수)"
                )

            if t["top_keywords"]:
                lines.append(f"- **주요 빈출 키워드**: {', '.join(t['top_keywords'])}")
            lines.append("")

            if t["gamrisa_questions"]:
                lines.append(f"### 감리사 기출문제 ({len(t['gamrisa_questions'])}문항 · 최신순)")
                lines.append("")
                for q in t["gamrisa_questions"]:
                    img_tag = f" `[그림/표 포함: {q['image_path']}]`" if q.get("has_image") else ""
                    lines.append(f"#### [{q['year_round']} {q['number']}번] (`{q['id']}`){img_tag}")
                    lines.append("")
                    lines.append(clean_md(q["question"]))
                    lines.append("")
                    opts = q.get("options") or {}
                    for k in ("1", "2", "3", "4"):
                        val = clean_inline(opts.get(k, ""))
                        if val:
                            lines.append(f"- {CIRCLED[k]} {val}")
                    lines.append("")
                    kws = ", ".join(q.get("keywords", []))
                    ans_nums = q.get("answers") or ([q["answer"]] if q.get("answer") else [])
                    if ans_nums:
                        ans_str = ", ".join(CIRCLED.get(str(a), str(a)) for a in ans_nums)
                        if len(ans_nums) == 4:
                            ans_str += " (모두정답)"
                        elif len(ans_nums) > 1:
                            ans_str += " (복수정답)"
                        lines.append(f"- **공식 정답**: {ans_str}")
                    lines.append(f"- **핵심 키워드**: {kws}")
                    lines.append(f"- **핵심 해설**: {clean_inline(q.get('short_explanation', ''))}")
                    lines.append("")

            if t["pe_questions"]:
                heading = (
                    f"### 신규 출제 예상 기술사 기출 ({len(t['pe_questions'])}문항 · 최신순)"
                    if t["is_trend"]
                    else f"### 연관 기술사 기출 참고 ({len(t['pe_questions'])}문항 · 최신순)"
                )
                lines.append(heading)
                lines.append("")
                for p in t["pe_questions"]:
                    q_txt = clean_md(p["question"]).replace("\n", "\n  ")
                    kws = ", ".join(p.get("keywords", []))
                    note = clean_inline(p.get("relevance_note", ""))
                    lines.append(
                        f"- **[{p['exam_type']} {p['year_round']} {p['session']} {p['number']}번]** (`{p['id']}`)\n"
                        f"  - **문제**: {q_txt}\n"
                        f"  - **키워드**: {kws}\n"
                        f"  - **감리사 출제 포인트**: {note}"
                    )
                lines.append("")

            lines.append("---")
            lines.append("")

        content = "\n".join(lines)
        with open(md_path, "w", encoding="utf-8") as f:
            f.write(content)
        print(f"[B] Saved {md_path} ({os.path.getsize(md_path):,} bytes, {len(lines):,} lines)")

    print("\n=== BUILD COMPLETE ===")
    print(json.dumps(study_data["meta"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
