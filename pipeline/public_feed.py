"""
공공기관 자료 수집기 — 정부 부처·기관 발표와 거래소 시장경보를 모아 '영향받을 코스피·코스닥 종목'과 연결합니다.

실행:  python pipeline/public_feed.py      (GitHub Actions에서 15분마다)
입력:  site/data/latest.json (종목 사전), site/data/public.json (이전 결과 — 이미 읽은 본문은 다시 받지 않음)
출력:  site/data/public.json

수집원
  1) 정책브리핑(korea.kr) 보도자료 — 전 부처·청·위원회 보도자료 목록 + 본문 앞부분(요약)
  2) DART 거래소공시 — 투자주의·경고·위험, 단기과열, 매매거래정지, 관리종목, 조회공시 요구 등 시장경보 (DART_API_KEY 필요)
  3) 기관 발표 보도(구글 뉴스) — 금융위·금감원·공정위·식약처·한국은행·산업부·국토부·방사청·관세청 등 발표 기사 (1·2 보완)
"""
import datetime as dt
import hashlib
import html as htmllib
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import requests

sys.path.insert(0, os.path.dirname(__file__))
import market_news as mn  # noqa: E402  (종목 사전·테마·방향 판단 재사용)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "site", "data", "public.json")
DART_KEY = os.getenv("DART_API_KEY", "")
UA = mn.UA
KST = mn.KST
NOW = dt.datetime.now(KST)
KEEP_DAYS = 7
VER = 2
LOG = []
KR = "https://www.korea.kr/briefing"


def log(m):
    m = f"[{NOW.strftime('%H:%M')}+{time.time() - T0:4.0f}s] {m}"
    LOG.append(m)
    print(m, flush=True)


T0 = time.time()
S = requests.Session()
S.headers.update({**UA, "Accept-Language": "ko-KR,ko;q=0.9"})


def get(url, **kw):
    kw.setdefault("timeout", 15)
    return S.get(url, **kw)


def strip(h):
    h = re.sub(r"(?is)<(script|style|noscript)[^>]*>.*?</\1>", " ", h)
    h = re.sub(r"(?i)<br\s*/?>|</(p|div|li|tr|h\d|dd|dt|span)>", "\n", h)
    h = re.sub(r"<[^>]+>", " ", h)
    h = htmllib.unescape(h)
    return h


ORG_RE = re.compile(r"^[가-힣·]{2,14}(부|처|청|원|위원회|실|본부|공사|은행|공단|재단)$")
ORGS = set("""기획재정부 재정경제부 기획예산처 교육부 과학기술정보통신부 외교부 통일부 법무부 국방부 행정안전부 국가보훈부 문화체육관광부
농림축산식품부 산업통상부 산업통상자원부 보건복지부 환경부 기후에너지환경부 고용노동부 성평등가족부 여성가족부 국토교통부 해양수산부 중소벤처기업부
인사혁신처 법제처 식품의약품안전처 국세청 관세청 조달청 통계청 국가데이터처 재외동포청 검찰청 병무청 방위사업청 경찰청 소방청 국가유산청 농촌진흥청
산림청 특허청 지식재산처 기상청 행정중심복합도시건설청 새만금개발청 해양경찰청 우주항공청 질병관리청 국무조정실 국무총리비서실 공정거래위원회 금융위원회
국민권익위원회 개인정보보호위원회 원자력안전위원회 방송미디어통신위원회 방송통신위원회 금융감독원 한국은행 국민연금공단 한국거래소 대통령실 범정부 범부처""".split())
DATE_RE = re.compile(r"(20\d\d)[.\-/](\d{1,2})[.\-/](\d{1,2})")


# ───────────── 1) 정책브리핑 보도자료 ─────────────
def kr_list(page):
    r = get(f"{KR}/pressReleaseList.do", params={"pageIndex": page})
    r.raise_for_status()
    h = r.text
    out = []
    for m in re.finditer(r"""<a[^>]+href=["']([^"']*pressReleaseView\.do\?newsId=(\d+)[^"']*)["'][^>]*>(.*?)</a>""", h, re.S | re.I):
        href, nid, inner = m.group(1), m.group(2), m.group(3)
        pieces = [re.sub(r"\s+", " ", x).strip() for x in strip(inner).split("\n")]
        pieces = [x for x in pieces if x]
        after = [re.sub(r"\s+", " ", x).strip() for x in strip(h[m.end(): m.end() + 900]).split("\n")]
        after = [x for x in after if x][:8]
        date = org = None
        for x in pieces + after:
            if date is None and DATE_RE.search(x):
                date = DATE_RE.search(x)
        for x in pieces + after:  # 1순위: 짧은 칸 하나가 통째로 기관명
            if len(x) <= 16 and (x in ORGS or ORG_RE.match(x)):
                org = x
                break
        if org is None:  # 2순위: 제목 줄에 나온 기관명
            for tok in re.split(r"[\s|/·,]+", (pieces or [""])[0]):
                tok = re.sub(r"(은|는|이|가|의|에서|,)$", "", tok)
                if tok in ORGS:
                    org = tok
                    break
        cand = [x for x in pieces if not DATE_RE.fullmatch(x) and x != org and len(x) >= 6]
        title = cand[0] if cand else None  # 첫 줄 = 제목 (그 뒤는 본문 미리보기)
        if not title:
            continue
        title = re.sub(r"\s+", " ", title).strip()
        d = dt.date(int(date.group(1)), int(date.group(2)), int(date.group(3))) if date else NOW.date()
        out.append({"id": "kr:" + nid, "nid": nid, "t": title, "org": org or "정부", "date": d.isoformat(),
                    "u": f"{KR}/pressReleaseView.do?newsId={nid}"})
    # 같은 newsId 중복 링크 제거
    seen, uniq = set(), []
    for x in out:
        if x["id"] not in seen:
            seen.add(x["id"]); uniq.append(x)
    return uniq


SKIP_LINE = re.compile(r"담당\s*부서|문의|첨부|저작권|공공누리|이 누리|무단|바로가기|목록|이전글|다음글|페이지|공유|인쇄|글자|정책브리핑|보도자료$|자료제공|출처")


def kr_body(it):
    r = get(it["u"])
    r.raise_for_status()
    m = re.search(r"""<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)""", r.text) or re.search(r"<title>(.*?)</title>", r.text, re.S)
    if m:
        t = htmllib.unescape(re.sub(r"\s+", " ", m.group(1))).strip()
        t = re.split(r"\s+[|<\-–]\s+(?:보도자료|정책브리핑|대한민국)", t)[0].strip()
        if 6 <= len(t) <= 150:
            it["t"] = t
    lines = [re.sub(r"\s+", " ", x).strip() for x in strip(r.text).split("\n")]
    lines = [x for x in lines if x]
    key = it["t"][:12]
    start = next((i for i, x in enumerate(lines) if key and key in x), 0)
    body = [x for x in lines[start + 1: start + 120] if len(x) >= 15 and not SKIP_LINE.search(x)]
    text = " ".join(body)[:2500]
    sents = re.split(r"(?<=다\.)\s+|(?<=습니다\.)\s+", text)
    summ = ""
    for s_ in sents:
        if len(s_) < 20:
            continue
        summ += s_.strip() + " "
        if len(summ) > 180:
            break
    return {"body": text[:1200], "sum": summ.strip()[:320]}


def collect_kr(prev_ids):
    items, fails = [], 0
    cutoff = (NOW - dt.timedelta(days=KEEP_DAYS)).date().isoformat()
    for page in range(1, 31):  # 하루 100~200건 → 최근 것만 필요한 만큼
        try:
            got = kr_list(page)
        except Exception as e:
            fails += 1
            log(f"정책브리핑 목록 {page}쪽 실패: {type(e).__name__} {str(e)[:80]}")
            break
        if not got:
            log(f"정책브리핑 목록 {page}쪽: 항목을 찾지 못함(페이지 구조 변경 가능)")
            break
        items += got
        known = sum(1 for x in got if x["id"] in prev_ids)
        if known >= len(got) * 0.8 and page >= 2:
            break  # 이미 아는 자료까지 왔으면 멈춤
        if min(x["date"] for x in got) < cutoff:
            break
        time.sleep(0.3)
    log(f"정책브리핑 목록 {len(items)}건")
    return items, fails


# ───────────── 2) DART 거래소 시장경보 ─────────────
MEASURE = [
    (r"투자위험종목지정", "투자위험 지정", -1, 3), (r"투자경고종목지정", "투자경고 지정", -1, 3), (r"투자주의환기종목", "투자주의환기 지정", -1, 3),
    (r"단기과열", "단기과열 지정", -1, 3), (r"매매거래정지", "매매거래 정지", -1, 3), (r"관리종목", "관리종목 지정", -1, 3),
    (r"상장적격성|상장폐지", "상장적격성·상장폐지 관련", -1, 3), (r"불성실공시", "불성실공시법인 지정", -1, 3),
    (r"조회공시요구|현저한시황변동", "조회공시 요구(주가 급변)", 0, 3), (r"공매도과열", "공매도 과열 지정", -1, 2),
    (r"정리매매", "정리매매", -1, 3), (r"투자유의", "투자유의 안내", -1, 2), (r"풍문|보도", "풍문·보도 해명 요구", 0, 2),
]


def collect_dart():
    if not DART_KEY:
        log("DART_API_KEY 없음 → 거래소 시장경보 건너뜀")
        return [], 0
    out, fails = [], 0
    bgn = (NOW - dt.timedelta(days=3)).strftime("%Y%m%d")
    for cls in ("Y", "K"):
        for page in range(1, 11):
            try:
                r = get("https://opendart.fss.or.kr/api/list.json", params={"crtfc_key": DART_KEY, "bgn_de": bgn, "end_de": NOW.strftime("%Y%m%d"),
                        "pblntf_ty": "I", "corp_cls": cls, "page_no": page, "page_count": 100}, timeout=20)
                j = r.json()
            except Exception as e:
                fails += 1
                log(f"DART 거래소공시 실패({cls} {page}쪽): {type(e).__name__}")
                break
            for it in j.get("list", []) or []:
                rn = (it.get("report_nm") or "").replace(" ", "")
                sc = it.get("stock_code") or ""
                for pat, label, sgn, imp in MEASURE:
                    if re.search(pat, rn):
                        lift = "해제" in rn
                        out.append({"id": "dart:" + it["rcept_no"], "src": "거래소 시장경보", "org": "한국거래소",
                                    "t": f"{it.get('corp_name', '')} — {(it.get('report_nm') or '').strip()}",
                                    "u": f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={it['rcept_no']}",
                                    "date": f"{it['rcept_dt'][:4]}-{it['rcept_dt'][4:6]}-{it['rcept_dt'][6:]}",
                                    "kind": "시장경보", "label": label + (" 해제" if lift else ""), "code": sc,
                                    "tone": (1 if lift else sgn), "imp": imp})
                        break
            if page >= int(j.get("total_page", 1) or 1):
                break
            time.sleep(0.2)
    log(f"DART 거래소 시장경보 {len(out)}건")
    return out, fails


# ───────────── 3) 기관 발표 보도 (구글 뉴스) ─────────────
GN_GOV = [
    ("금융위원회", "금융위원회 OR 금융위 발표 OR 금융위 의결"), ("금융감독원", "금감원 제재 OR 금감원 검사 OR 금융감독원 조사"),
    ("공정거래위원회", "공정위 과징금 OR 공정위 제재 OR 공정위 조사"), ("식품의약품안전처", "식약처 허가 OR 식약처 승인 OR 식약처 품목허가"),
    ("한국은행", "한국은행 기준금리 OR 한은 금통위"), ("산업통상부", "산업부 발표 OR 산업통상부 지원 OR 수출입동향"),
    ("국토교통부", "국토부 대책 OR 국토교통부 발표"), ("방위사업청", "방위사업청 계약 OR 방사청 사업"),
    ("관세청", "관세청 수출 OR 1~10일 수출 OR 1~20일 수출"), ("과학기술정보통신부", "과기정통부 지원 OR 과기정통부 발표"),
    ("기획재정부", "기재부 발표 OR 재정경제부 발표 OR 세법개정"), ("한국거래소", "거래소 투자경고 OR 거래소 매매정지 OR 거래소 시장경보"),
    ("보건복지부", "복지부 약가 OR 건강보험 급여 결정"), ("해양수산부", "해수부 발표 해운"), ("기후에너지환경부", "기후에너지환경부 OR 원전 정책 발표"),
    ("국민연금", "국민연금 기금운용 OR 국민연금 지분"),
]


def collect_gn():
    jobs = [("국내", org, q, "ko") for org, q in GN_GOV]
    items, fails = [], 0
    with ThreadPoolExecutor(6) as ex:
        futs = {ex.submit(mn.fetch_google, j): j for j in jobs}
        for f, j in futs.items():
            try:
                for x in f.result(timeout=40):
                    x["org"] = j[1]
                    items.append(x)
            except Exception as e:
                fails += 1
                log(f"기관 발표 보도 실패: {j[1]} {type(e).__name__}")
    log(f"기관 발표 보도 {len(items)}건")
    return items, fails


# ───────────── 분류 ─────────────
KIND_RULES = [
    ("거시지표", r"수출입\s*동향|수출\s*실적|\d+~\d+일\s*수출|소비자물가|생산자물가|기준금리|고용\s*동향|경상수지|산업활동동향|국내총생산|GDP|외환보유|국고채|가계부채|금통위"),
    ("허가·승인", r"허가|승인|인증|등재|급여\s*적용|지정\s*승인|임상\s*계획"),
    ("제재·조사", r"과징금|제재|고발|시정명령|조사\s*착수|압수수색|검찰\s*통보|영업정지|회수|판매\s*중지|리콜|경고\s*조치|불공정"),
    ("계약·선정", r"계약|선정|수주|낙찰|발주|체결|협약|MOU|양해각서"),
    ("지원·정책", r"지원|육성|투자|대책|방안|전략|추진|로드맵|특별법|완화|개편|세제|예산|펀드"),
    ("규제", r"규제|강화|제한|금지|의무화|상한"),
]
IMP_W = re.compile(r"기준금리|수출입\s*동향|품목허가|허가|승인|과징금|제재|고발|매매거래정지|투자경고|대책|특별법|발표|선정|계약|수주|지원")
GOV_POS = ["허가", "승인", "지원", "선정", "완화", "확대", "증가", "호조", "역대", "최대", "인하", "육성", "수주", "계약", "체결", "개선", "흑자", "돌파", "급여 적용"]
GOV_NEG = ["과징금", "제재", "고발", "시정명령", "회수", "판매중지", "판매 중지", "리콜", "감소", "둔화", "규제", "강화", "금지", "적발", "부진", "적자", "중단", "취소", "조사", "인상"]


def classify(text, title):
    kind = "정책·보도"
    for k, pat in KIND_RULES:
        if re.search(pat, title):
            kind = k
            break
    p = sum(1 for w in GOV_POS if w in title)
    n = sum(1 for w in GOV_NEG if w in title)
    tone = 1 if p > n else -1 if n > p else 0
    return kind, tone


def enrich(it, ctx):
    names, ko_re, en_map, en_re, by_code, theme_stocks = ctx
    title, body = it["t"], it.get("body", "")
    head = title + " " + (it.get("sum") or "")
    st = mn.match_stocks(head, "ko", names, ko_re, en_map, en_re) if it.get("kind") != "시장경보" else ([it["code"]] if it.get("code") in by_code else [])
    if it.get("kind") != "시장경보":
        kind, tone = classify(head, title)
        it["kind"], it["tone"] = kind, tone
    ths = mn.match_themes(title, "ko")  # 테마는 제목에서만 (본문·요약은 잡음이 많음)
    if not ths and it.get("src") == "기관 발표 보도":
        ths = mn.match_themes(it.get("sum") or "", "ko")[:1]
    dr = mn.driver_dirs(title, "ko")
    for d in dr:
        for th in mn.THEMES:
            if d in th.get("drivers", {}) and th["name"] not in ths:
                ths.append(th["name"])
    theme_eff = []
    for n in ths[:5]:
        drv = mn.THEME_BY[n].get("drivers", {})
        effs = [dr[d] * sgn for d, sgn in drv.items() if d in dr]
        e = (1 if sum(effs) > 0 else -1 if sum(effs) < 0 else 0) if effs else it["tone"]
        theme_eff.append((n, e))
    it["st"], it["dr"] = st, dr
    if it.get("kind") == "시장경보":
        nm = by_code[st[0]]["name"] if st else it["t"].split(" — ")[0]
        it["note"] = f"{nm} — {it['label']}: " + ("단기 매매에 큰 위험 신호예요. 신규 매수는 피하는 게 원칙이에요." if it["tone"] < 0 else "해제 소식이에요. 거래 제한이 풀려요." if it["tone"] > 0 else "거래소가 주가 급변 이유를 물었어요. 회사 답변 공시를 꼭 확인하세요.")
    else:
        it["note"] = mn.make_note(it, theme_eff, by_code, theme_stocks)
        imp = 1
        if st or theme_eff:
            imp = 2
        if (st and IMP_W.search(title)) or it["kind"] in ("거시지표",) or (theme_eff and it["kind"] in ("허가·승인", "제재·조사", "계약·선정") and it["tone"] != 0):
            imp = 3
        it["imp"] = imp
    it["th"] = [[n, e] for n, e in theme_eff]
    it["dr"] = [[d, v] for d, v in dr.items()]
    noise = re.search(r"동정|면담|접견|방문|간담회|훈련|캠페인|시상|기념식|개원|축제|공모전|봉사|청렴|채용|인사\s*발령|부고|브리핑\s*\(", title) and not st
    it["linked"] = bool(it.get("kind") in ("시장경보", "거시지표") or (not noise and (st or theme_eff)))
    return it


def main():
    prev = {}
    if os.path.exists(OUT):
        try:
            pj = json.load(open(OUT, encoding="utf-8"))
            if pj.get("meta", {}).get("ver") == VER:  # 분류 규칙이 바뀌면 처음부터 다시
                prev = {x["id"]: x for x in pj.get("items", [])}
        except Exception:
            prev = {}
    stocks, by_name = mn.load_universe()
    by_code = {s["code"]: s for s in stocks}
    names, ko_re, en_map, en_re = mn.build_matchers(stocks, by_name)
    theme_stocks = {th["name"]: [by_name[n]["code"] for n in th["stocks"] if n in by_name] for th in mn.THEMES}
    ctx = (names, ko_re, en_map, en_re, by_code, theme_stocks)
    now_s = NOW.strftime("%Y-%m-%dT%H:%M")
    cutoff = (NOW - dt.timedelta(days=KEEP_DAYS)).date().isoformat()

    kr, f1 = collect_kr(set(prev))
    dart, f2 = collect_dart()
    gn, f3 = collect_gn()

    items = {}
    # 이전 결과 유지(본문 재요청 방지)
    for k, x in prev.items():
        if (x.get("date") or "") >= cutoff:
            items[k] = x
    # 정책브리핑: 새 자료만 본문 받기
    new_kr = [x for x in kr if x["id"] not in items and x["date"] >= cutoff]
    log(f"정책브리핑 새 자료 {len(new_kr)}건 본문 읽기")
    with ThreadPoolExecutor(6) as ex:
        bodies = list(ex.map(lambda x: (x, _safe_body(x)), new_kr[:150]))
    for x, b in bodies:
        x.update(b or {"body": "", "sum": ""})
        x.update({"src": "정책브리핑", "seen": now_s})
        items[x["id"]] = enrich(x, ctx)
    for x in dart:
        if x["id"] not in items:
            x["seen"] = now_s
            items[x["id"]] = enrich(x, ctx)
    # 기관 발표 보도: 정책브리핑과 겹치지 않는 것만
    have_words = [mn._words(x["t"]) for x in items.values()]
    for x in gn:
        if x["ts"] is not None and x["ts"] < NOW - dt.timedelta(days=3):
            continue
        hid = "gn:" + hashlib.md5(x["t"].encode()).hexdigest()[:12]
        if hid in items:
            continue
        ws = mn._words(x["t"])
        if any(ws and w and len(ws & w) / max(1, min(len(ws), len(w))) >= 0.6 for w in have_words):
            continue
        x["t"] = re.sub(r"\s*[:|]\s*(네이버|다음|티스토리)\s*블로그.*$", "", x["t"]).strip()
        if x["s"] in mn.BLOCK_SRC or any(w in x["t"].lower() for w in mn.SPAM_W) or "블로그" in (x["s"] or "") or "blog" in (x["u"] or ""):
            continue
        it = {"id": hid, "src": "기관 발표 보도", "org": x["org"], "t": x["t"], "u": x["u"], "s": x["s"],
              "date": (x["ts"] or NOW).astimezone(KST).date().isoformat(),
              "ts": (x["ts"] or NOW).astimezone(KST).strftime("%Y-%m-%dT%H:%M"), "seen": now_s, "sum": "", "body": ""}
        it = enrich(it, ctx)
        if it["linked"]:
            items[hid] = it
            have_words.append(ws)

    # 종목·테마와 연결된 것 + 시장경보 + 거시지표만 남김
    keep = [x for x in items.values() if x.get("linked")]
    keep.sort(key=lambda x: (x.get("date") or "", x.get("ts") or x.get("seen") or ""), reverse=True)
    keep = keep[:700]
    for x in keep:
        x.pop("body", None)
    agg = {}
    for x in keep:
        for c in x["st"]:
            a = agg.setdefault(c, {"n1": 0, "n2": 0, "pos": 0, "neg": 0, "warn": 0, "it": []})
            a["n1"] += 1; a["pos"] += x["tone"] > 0; a["neg"] += x["tone"] < 0
            a["warn"] += x.get("kind") == "시장경보" and x["tone"] < 0
            a["it"].append(x["id"])
        for n, e in x["th"]:
            for c in theme_stocks.get(n, [])[:12]:
                if c in x["st"]:
                    continue
                a = agg.setdefault(c, {"n1": 0, "n2": 0, "pos": 0, "neg": 0, "warn": 0, "it": []})
                a["n2"] += 1; a["pos"] += e > 0; a["neg"] += e < 0
                if len(a["it"]) < 30:
                    a["it"].append(x["id"])
    for a in agg.values():
        for k in ("pos", "neg", "warn"):
            a[k] = int(a[k])
    orgs = {}
    for x in keep:
        orgs[x["org"]] = orgs.get(x["org"], 0) + 1
    themes = {th["name"]: {"stocks": theme_stocks[th["name"]]} for th in mn.THEMES}
    meta = {"ver": VER, "generated": NOW.strftime("%Y-%m-%d %H:%M"), "n": len(keep), "new": sum(1 for x in keep if x.get("seen") == now_s),
            "by_src": {k: sum(1 for x in keep if x["src"] == k) for k in ("정책브리핑", "거래소 시장경보", "기관 발표 보도")},
            "kr_listed": len(kr), "dart": bool(DART_KEY), "fails": f1 + f2 + f3, "elapsed_s": round(time.time() - T0, 1), "log": LOG[-40:]}
    data = {"meta": meta, "items": keep, "stocks": agg, "orgs": dict(sorted(orgs.items(), key=lambda kv: -kv[1])), "themes": themes}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    log(f"저장 public.json — {len(keep)}건(새 자료 {meta['new']}) · 연결 종목 {len(agg)}개 · {os.path.getsize(OUT) / 1e3:.0f}KB")


def _safe_body(x):
    try:
        return kr_body(x)
    except Exception as e:
        log(f"본문 실패 {x['nid']}: {type(e).__name__}")
        return None


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        traceback.print_exc()
        log(f"오류: {type(e).__name__}: {e}")
    sys.stdout.flush()
    os._exit(0)
