"""
매일 장마감 후(또는 미국장 마감 직후 새벽) 실행하는 수집 파이프라인
→ site/data/latest.json 생성 → Netlify가 자동 배포 (GitHub 연동 시)

실행:  python pipeline/collect.py
환경변수:
  KRX_ID / KRX_PW       KRX 정보데이터시스템 계정 (필수: pykrx 1.2.x부터 로그인 필요)
  DART_API_KEY          OpenDART 인증키 (필수 권장: 실적·재무·공시)
  NAVER_CLIENT_ID/SECRET 네이버 검색 API (선택: 뉴스 감정점수)
  KIS_APP_KEY/SECRET    한국투자증권 KIS Developers (선택: 분봉 10분·60분)
  UNIVERSE_MIN_MCAP     유니버스 최소 시총(억원, 기본 1000)
  UNIVERSE_MIN_TV       최소 거래대금(억원, 기본 5)
  CANDIDATE_N           현금흐름·목표주가·뉴스를 추가 조회할 후보 수(기본 200)
"""
import io
import json
import os
import re
import sys
import time
import zipfile
import datetime as dt
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pandas as pd
import requests

sys.path.insert(0, os.path.dirname(__file__))
from features import tech_features, streak, macro_gate, us_impact, _f  # noqa: E402
try:
    from clx.engine import run as clx_run  # 차트랩 6축 엔진 (첨부 chartlab_engine 이식·보완)
except Exception as _e:  # 엔진이 없어도 기존 수집은 그대로
    clx_run = None
    print("차트랩 엔진 불러오기 실패:", _e)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
OUT = os.path.join(SITE, "data", "latest.json")
CL_DIR = os.path.join(SITE, "data", "cl")  # 종목별 차트 파일 (main에는 올리지 않고 live-cl 보관 칸에 덮어씀)
CFG = json.load(open(os.path.join(SITE, "config", "weights.json"), encoding="utf-8"))
USMAP = json.load(open(os.path.join(SITE, "config", "us_sector_map.json"), encoding="utf-8"))

DART_KEY = os.getenv("DART_API_KEY", "")
NAVER_ID, NAVER_SECRET = os.getenv("NAVER_CLIENT_ID", ""), os.getenv("NAVER_CLIENT_SECRET", "")
KIS_KEY, KIS_SECRET = os.getenv("KIS_APP_KEY", ""), os.getenv("KIS_APP_SECRET", "")
MIN_MCAP = float(os.getenv("UNIVERSE_MIN_MCAP", "1000"))
MIN_TV = float(os.getenv("UNIVERSE_MIN_TV", "5"))
CAND_N = int(os.getenv("CANDIDATE_N", "200"))
SHORT_N = int(os.getenv("SHORT_N", "300"))
UA = {"User-Agent": "Mozilla/5.0"}
LOG = []
FLOW_SRC = {"v": "krx"}


T0 = time.time()
BUDGET_MIN = float(os.getenv("BUDGET_MIN", "75"))  # 이 시간을 넘으면 선택 단계 건너뛰고 저장


def log(msg):
    msg = f"[{(time.time() - T0) / 60:5.1f}분] {msg}"
    print(msg, flush=True)
    LOG.append(msg)


def over_budget(stage):
    if (time.time() - T0) / 60 > BUDGET_MIN:
        log(f"  ! 시간 예산 {BUDGET_MIN:.0f}분 초과 → '{stage}' 건너뜀")
        return True
    return False


# 모든 HTTP 요청에 기본 시간 제한(연결 10초, 응답 30초) — pykrx 내부 요청 포함, 무한 대기 방지
_orig_request = requests.Session.request


def _request_with_timeout(self, method, url, **kw):
    if kw.get("timeout") is None:
        kw["timeout"] = (10, 30)
    return _orig_request(self, method, url, **kw)


requests.Session.request = _request_with_timeout


def ymd(d):
    return d.strftime("%Y%m%d")


def safe(fn, *a, default=None, **k):
    try:
        return fn(*a, **k)
    except Exception as e:  # 데이터 소스 하나가 실패해도 전체는 계속
        log(f"  ! {getattr(fn, '__name__', fn)} 실패: {e}")
        return default


# ═════════════ 1. 날짜·유니버스 ═════════════
def get_dates():
    from pykrx import stock
    today = dt.date.today()
    idx = stock.get_index_ohlcv(ymd(today - dt.timedelta(days=40)), ymd(today), "1001")
    days = [d.date() for d in idx.index]
    return days[-1], days  # asof, 최근 영업일 목록


def get_universe(asof):
    from pykrx import stock
    frames = []
    for mkt in ["KOSPI", "KOSDAQ"]:
        cap = stock.get_market_cap(ymd(asof), market=mkt)
        cap["market"] = mkt
        frames.append(cap)
    u = pd.concat(frames)
    u["name"] = [stock.get_market_ticker_name(t) for t in u.index]
    u["mcap"] = u["시가총액"] / 1e8
    u["tv"] = u["거래대금"] / 1e8
    excl = u["name"].str.contains("스팩|리츠|ETN|우$|우B$|우C$|\\d우", regex=True)
    u = u[(~excl) & (u.index.str.endswith("0")) & (u["mcap"] >= MIN_MCAP) & (u["tv"] >= MIN_TV)]
    log(f"유니버스 {len(u)}종목 (시총≥{MIN_MCAP}억, 거래대금≥{MIN_TV}억)")
    return u


# ═════════════ 2. 일봉 (수정주가) ═════════════
_PYKRX_FAILS = {"n": 0}


def get_ohlcv(code, start, end):
    """pykrx adjusted=True 우선, 실패 시 FinanceDataReader 폴백.
    pykrx가 연속 5번 실패하면 이후로는 바로 FinanceDataReader만 사용(시간 낭비 방지)."""
    from pykrx import stock
    if _PYKRX_FAILS["n"] < 5:
        try:
            df = stock.get_market_ohlcv(ymd(start), ymd(end), code, adjusted=True)
            if df is not None and len(df) > 30:
                _PYKRX_FAILS["n"] = 0
                return df
        except Exception:
            pass
        _PYKRX_FAILS["n"] += 1
        if _PYKRX_FAILS["n"] == 5:
            log("  ! pykrx 일봉 연속 실패 → FinanceDataReader로 전환")
    import FinanceDataReader as fdr
    df = fdr.DataReader(code, start, end)
    return df.rename(columns={"Open": "시가", "High": "고가", "Low": "저가", "Close": "종가", "Volume": "거래량"})


# ═════════════ 3. 수급 (외국인·기관·연기금) ═════════════
def get_flows(days):
    """최근 7영업일 × 투자자별 순매수대금 → 종목별 일별 시계열"""
    from pykrx import stock
    flows = {}  # investor -> DataFrame(index=ticker, columns=date)
    for inv in ["외국인", "기관합계", "연기금"]:
        cols, fails = {}, 0
        for d in days[-7:]:
            if fails >= 4:  # 연속 실패 시 해당 투자자 건너뜀
                log(f"  ! 수급 {inv} 연속 실패 → 건너뜀")
                break
            parts = []
            for mkt in ["KOSPI", "KOSDAQ"]:
                df = safe(stock.get_market_net_purchases_of_equities, ymd(d), ymd(d), mkt, inv)
                if df is None or not len(df):
                    time.sleep(3)  # 일시 차단 대비 한 번 더
                    df = safe(stock.get_market_net_purchases_of_equities, ymd(d), ymd(d), mkt, inv)
                if df is not None and len(df):
                    parts.append(df["순매수거래대금"])
                    fails = 0
                else:
                    fails += 1
                time.sleep(1.0)
            if parts:
                cols[d] = pd.concat(parts)
        flows[inv] = pd.DataFrame(cols)
        log(f"수급 {inv}: {flows[inv].shape}")
    return flows


def get_foreign_limit(asof):
    from pykrx import stock
    parts = []
    for mkt in ["KOSPI", "KOSDAQ"]:
        df = safe(stock.get_exhaustion_rates_of_foreign_investment, ymd(asof), mkt)
        if df is not None:
            parts.append(df)
    return pd.concat(parts) if parts else pd.DataFrame()


def _short_by_date(fn, d):
    parts = []
    for m in ["KOSPI", "KOSDAQ"]:
        try:
            df = fn(ymd(d), m)
            if df is not None and len(df):
                parts.append(df)
        except Exception:
            pass
    return pd.concat(parts) if parts else None


def get_short_balance(days, codes):
    """공매도 잔고 비중(%)과 5영업일 변화.
    공매도 잔고는 2영업일 늦게 공시되므로(T+2) 최근 영업일부터 거꾸로 데이터가 있는 날을 찾는다."""
    from pykrx import stock
    out = {}
    fn = getattr(stock, "get_shorting_balance_by_ticker", None)
    if fn:
        now, idx = None, None
        for back in range(1, 7):
            now = _short_by_date(fn, days[-back])
            if now is not None:
                idx = len(days) - back
                break
        if now is not None:
            bef = _short_by_date(fn, days[max(0, idx - 5)])
            col = [c for c in now.columns if "비중" in c][0]
            for t in now.index:
                b = bef[col].get(t) if bef is not None else None
                out[t] = (float(now[col][t]), float(now[col][t] - b) if b is not None else None)
            log(f"공매도 잔고 {len(out)}종목 (기준 {days[idx]})")
            return out
        log("  ! 공매도 시장단위 조회 실패 → 상위 종목 개별 조회")
    fails = 0
    for t in codes[:SHORT_N]:
        if fails >= 5:
            log("  ! 공매도 잔고 개별 조회 연속 실패 → 이번 수집에서 제외")
            break
        try:
            df = stock.get_shorting_balance_by_date(ymd(days[-12]), ymd(days[-1]), t)
        except Exception:
            df = None
        if df is not None and len(df):
            col = [c for c in df.columns if "비중" in c][0]
            v = df[col].dropna()
            if len(v):
                out[t] = (float(v.iloc[-1]), float(v.iloc[-1] - v.iloc[max(0, len(v) - 6)]))
            fails = 0
        else:
            fails += 1
        time.sleep(0.2)
    log(f"공매도 잔고 {len(out)}종목")
    return out


# ═════════════ 4. 업종 지수 ═════════════
SIZE_WORDS = ["코스피", "코스닥", "대형", "중형", "소형", "200", "100", "150", "50", "배당", "우량", "TOP", "KRX", "벤처", "글로벌", "기술"]


def get_sectors(asof, days):
    from pykrx import stock
    sec_of, sec_info = {}, []
    k = stock.get_index_ohlcv(ymd(days[-8]), ymd(asof), "1001")["종가"]
    kospi5 = (k.iloc[-1] / k.iloc[-6] - 1) * 100
    kq = safe(stock.get_index_ohlcv, ymd(days[-8]), ymd(asof), "2001")
    kosdaq5 = (kq["종가"].iloc[-1] / kq["종가"].iloc[-6] - 1) * 100 if kq is not None and len(kq) >= 6 else kospi5
    for mkt in ["KOSPI", "KOSDAQ"]:
        base5 = kospi5 if mkt == "KOSPI" else kosdaq5  # 코스닥 업종은 코스닥 지수 대비
        for t in stock.get_index_ticker_list(ymd(asof), market=mkt):
            raw = stock.get_index_ticker_name(t)
            if any(w in raw for w in SIZE_WORDS):
                continue
            name = raw if mkt == "KOSPI" else f"{raw}(코스닥)"  # 같은 업종명 구분
            members = safe(stock.get_index_portfolio_deposit_file, t, default=[]) or []
            if not members:
                continue
            ix = safe(stock.get_index_ohlcv, ymd(days[-8]), ymd(asof), t)
            if ix is None or len(ix) < 6:
                continue
            r5 = (ix["종가"].iloc[-1] / ix["종가"].iloc[-6] - 1) * 100
            sec_info.append({"code": t, "name": name, "market": mkt, "ret5": _f(r5), "rel5": _f(r5 - base5), "count": len(members)})
            for m in members:
                if m not in sec_of or len(members) < sec_of[m][1]:
                    sec_of[m] = (name, len(members))
            time.sleep(0.2)
    log(f"업종 {len(sec_info)}개")
    return {k: v[0] for k, v in sec_of.items()}, sec_info, kospi5


FIN_SECTOR = ["금융", "은행", "증권", "보험"]
FIN_NAME = ["금융지주", "은행", "증권", "보험", "생명", "화재", "캐피탈", "카드", "투자", "저축", "리츠"]


def is_financial(sector, name):
    """은행·보험·증권·지주·캐피탈 등 — 부채가 본업이라 부채비율로 판단하면 안 되는 업종"""
    return any(k in (sector or "") for k in FIN_SECTOR) or any(k in (name or "") for k in FIN_NAME)


# ═════════════ 5. 매크로·미국장 ═════════════
def get_macro():
    import FinanceDataReader as fdr
    start = dt.date.today() - dt.timedelta(days=60)

    def series(*syms):
        for s in syms:
            try:
                df = fdr.DataReader(s, start)
                if df is not None and len(df) > 5:
                    return df["Close"].dropna()
            except Exception:
                continue
        return None

    def pack(s, kind="pct"):
        if s is None:
            return None
        o = {"v": _f(s.iloc[-1]), "date": str(s.index[-1].date())}
        if kind == "bp":
            o["chgbp"] = _f((s.iloc[-1] - s.iloc[-2]) * 100, 1)
        else:
            o["chg"] = _f((s.iloc[-1] / s.iloc[-2] - 1) * 100)
            o["chg1"] = o["chg"]
            if len(s) > 21:
                o["chg20"] = _f((s.iloc[-1] / s.iloc[-21] - 1) * 100)
            if len(s) > 6:
                o["ret5"] = _f((s.iloc[-1] / s.iloc[-6] - 1) * 100)
        return o

    m = {
        "usdkrw": pack(series("USD/KRW")),
        "us10y": pack(series("US10YT", "^TNX"), "bp"),
        "sp500": pack(series("US500", "^GSPC")),
        "nasdaq": pack(series("IXIC", "^IXIC")),
        "sox": pack(series("^SOX", "SOX", "SOXX")),
        "kospi": pack(series("KS11")),
        "kosdaq": pack(series("KQ11")),
    }
    etf = {s: pack(series(s)) for s in ["XLF", "XLE", "XBI", "XLY"]}
    us_rets = {"SP500": (m["sp500"] or {}).get("chg"), "NASDAQ": (m["nasdaq"] or {}).get("chg"),
               "SOX": (m["sox"] or {}).get("chg")}
    for s, v in etf.items():
        us_rets[s] = (v or {}).get("chg")
    m["us_etf"] = etf
    return m, us_rets


# ═════════════ 6. OpenDART ═════════════
DART = "https://opendart.fss.or.kr/api"


def dart_corp_map():
    r = requests.get(f"{DART}/corpCode.xml", params={"crtfc_key": DART_KEY}, timeout=60)
    z = zipfile.ZipFile(io.BytesIO(r.content))
    root = ET.fromstring(z.read(z.namelist()[0]))
    mp = {}
    for el in root.iter("list"):
        sc = (el.findtext("stock_code") or "").strip()
        if sc:
            mp[sc] = el.findtext("corp_code")
    return mp


def latest_reports(today):
    """공시 마감 고려한 최근 정기보고서 4개 (연도, 보고서코드) — 최신순"""
    y = today.year
    seq = [(y, "11014", dt.date(y, 11, 20)), (y, "11012", dt.date(y, 8, 20)), (y, "11013", dt.date(y, 5, 20)),
           (y - 1, "11011", dt.date(y, 4, 5)), (y - 1, "11014", dt.date(y - 1, 11, 20)),
           (y - 1, "11012", dt.date(y - 1, 8, 20)), (y - 1, "11013", dt.date(y - 1, 5, 20)),
           (y - 2, "11011", dt.date(y - 1, 4, 5))]
    return [(yy, rc) for yy, rc, avail in seq if today >= avail][:4]


def _num(x):
    try:
        return float(str(x).replace(",", ""))
    except Exception:
        return None


def dart_multi(corp_codes, year, rcode):
    """fnlttMultiAcnt: 100개씩 주요계정 (연결 우선)"""
    res = {}
    for i in range(0, len(corp_codes), 100):
        chunk = corp_codes[i:i + 100]
        r = safe(requests.get, f"{DART}/fnlttMultiAcnt.json",
                 params={"crtfc_key": DART_KEY, "corp_code": ",".join(chunk), "bsns_year": year, "reprt_code": rcode}, timeout=30)
        if r is None:
            continue
        for it in r.json().get("list", []):
            cc, fs = it["corp_code"], it.get("fs_div")
            d = res.setdefault(cc, {"CFS": {}, "OFS": {}})
            nm = it["account_nm"].replace(" ", "")
            cur = _num(it.get("thstrm_amount"))
            prev = _num(it.get("frmtrm_q_amount")) or _num(it.get("frmtrm_amount"))
            d.setdefault(fs, {})[nm] = (cur, prev)
        time.sleep(0.15)
    out = {}
    for cc, d in res.items():
        acc = d["CFS"] if d["CFS"] else d["OFS"]
        g = lambda *names: next((acc[n] for n in names if n in acc), (None, None))
        out[cc] = {"sales": g("매출액", "수익(매출액)", "영업수익"), "op": g("영업이익", "영업이익(손실)"),
                   "net": g("당기순이익", "당기순이익(손실)"), "assets": g("자산총계"), "liab": g("부채총계"),
                   "equity": g("자본총계"), "ca": g("유동자산"), "cl": g("유동부채")}
    return out


def dart_ocf(corp_code, year, rcode):
    r = requests.get(f"{DART}/fnlttSinglAcntAll.json", params={"crtfc_key": DART_KEY, "corp_code": corp_code,
                     "bsns_year": year, "reprt_code": rcode, "fs_div": "CFS"}, timeout=30).json()
    if r.get("status") != "000":
        r = requests.get(f"{DART}/fnlttSinglAcntAll.json", params={"crtfc_key": DART_KEY, "corp_code": corp_code,
                         "bsns_year": year, "reprt_code": rcode, "fs_div": "OFS"}, timeout=30).json()
    for it in r.get("list", []):
        if it.get("sj_div") == "CF" and "영업활동" in it.get("account_nm", "") and "현금흐름" in it.get("account_nm", ""):
            return _num(it.get("thstrm_amount"))
    return None


NEG = ["유상증자결정", "감자결정", "전환사채권발행결정", "신주인수권부사채권발행결정", "불성실공시", "관리종목", "상장적격성", "횡령", "배임"]
POS = ["무상증자결정", "자기주식취득결정", "단일판매", "공급계약", "현금ㆍ현물배당", "주식소각결정"]


def dart_disclosures(today):
    """최근 30일 공시 → 종목별 분류 (호재/악재/실적발표/국민연금 5% 대량보유)"""
    out = {}
    page, total = 1, 1
    while page <= total and page <= 80:
        r = safe(requests.get, f"{DART}/list.json", params={"crtfc_key": DART_KEY, "bgn_de": ymd(today - dt.timedelta(days=30)),
                 "end_de": ymd(today), "page_no": page, "page_count": 100}, timeout=30)
        if r is None:
            break
        j = r.json()
        total = j.get("total_page", 1)
        for it in j.get("list", []):
            sc = it.get("stock_code") or ""
            if not sc:
                continue
            rn, flr = it.get("report_nm", ""), it.get("flr_nm", "")
            d = out.setdefault(sc, {"pos": [], "neg": [], "earn_date": None, "pension": False, "items": []})
            tag = None
            if any(k in rn for k in NEG):
                d["neg"].append(rn); tag = "악재"
            elif any(k in rn for k in POS):
                d["pos"].append(rn); tag = "호재"
            if "영업(잠정)실적" in rn or "매출액또는손익구조" in rn:
                d["earn_date"] = d["earn_date"] or it["rcept_dt"]; tag = tag or "실적"
            if "대량보유" in rn and "국민연금" in flr:
                d["pension"] = True; tag = "연기금5%"
            if tag and len(d["items"]) < 6:
                d["items"].append({"date": it["rcept_dt"], "title": rn.strip(), "tag": tag,
                                   "url": f"https://dart.fss.or.kr/dsaf001/main.do?rcpNo={it['rcept_no']}"})
        page += 1
        time.sleep(0.15)
    log(f"공시 분류 {len(out)}종목")
    return out


# ═════════════ 7. 목표주가(네이버 금융) · 뉴스 ═════════════
def _find_key(obj, keys):
    """중첩 JSON에서 키 이름으로 값 찾기"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k in keys and v not in (None, "", "-"):
                return v
            r = _find_key(v, keys)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = _find_key(v, keys)
            if r is not None:
                return r
    return None


def naver_target(code):
    """증권사 컨센서스 목표주가 — ① 네이버 모바일 API(JSON) ② PC 페이지(euc-kr) 순서로 시도"""
    try:
        j = requests.get(f"https://m.stock.naver.com/api/stock/{code}/integration", headers=UA, timeout=8).json()
        v = _num(_find_key(j, {"priceTargetMean", "targetPrice", "goalPrice"}))
        if v and v > 0:
            return v
    except Exception:
        pass
    raw = requests.get(f"https://finance.naver.com/item/main.naver?code={code}", headers=UA, timeout=8).content
    html = _decode(raw)
    seg = html[html.find("목표주가"):][:600] if "목표주가" in html else ""
    nums = [_num(x) for x in re.findall(r"<em[^>]*>\s*([\d,]+)\s*</em>", seg)]
    nums = [x for x in nums if x and x >= 100]  # 투자의견 점수(4.00 등) 제외
    return nums[0] if nums else None


POS_W = ["수주", "최대", "흑자", "상향", "호실적", "급증", "신고가", "계약", "승인", "돌파", "개선", "성장", "자사주"]
NEG_W = ["적자", "하향", "급락", "소송", "유상증자", "감자", "부진", "리콜", "횡령", "배임", "제재", "손실", "철회"]


POS_W += ["수혜", "기대", "호조", "신제품", "인수", "협력", "mou", "선정", "독점", "특허", "증설", "목표가 상향", "매수", "호실적", "신고가"]
NEG_W += ["하락", "우려", "악재", "경고", "적발", "중단", "감소", "부담", "매도", "취소", "논란", "조사", "파업", "하회", "쇼크"]


def _tone(text):
    p = [w for w in POS_W if w in text]
    n = [w for w in NEG_W if w in text]
    return (1 if len(p) > len(n) else -1 if len(n) > len(p) else 0), p, n


def google_news(name, days=7, limit=6):
    """구글 뉴스 RSS(키 불필요) — 최근 기사 제목·링크·출처·날짜 + 긍정/부정 분류"""
    q = f'"{name}" 주가 OR 주식 OR 실적 when:{days}d'
    r = requests.get("https://news.google.com/rss/search", params={"q": q, "hl": "ko", "gl": "KR", "ceid": "KR:ko"},
                     headers=UA, timeout=10)
    root = ET.fromstring(r.content)
    items, seen = [], set()
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        src = (it.findtext("source") or "").strip()
        if src and title.endswith(" - " + src):
            title = title[: -len(" - " + src)]
        if name not in title:  # 제목에 종목명이 있는 기사만
            continue
        key = re.sub(r"\W", "", title)[:30]
        if key in seen:
            continue
        seen.add(key)
        try:
            d = dt.datetime.strptime(it.findtext("pubDate")[:25], "%a, %d %b %Y %H:%M:%S").strftime("%m-%d")
        except Exception:
            d = ""
        tone, p, n = _tone(title)
        items.append({"t": title, "u": it.findtext("link"), "s": src, "d": d, "tone": tone, "kw": (p + n)[:3]})
        if len(items) >= limit:
            break
    if not items:
        return None
    pos = sum(1 for x in items if x["tone"] > 0)
    neg = sum(1 for x in items if x["tone"] < 0)
    kws = []
    for x in items:
        for k in x["kw"]:
            if k not in kws:
                kws.append(k)
    return {"items": items, "sum": {"n": len(items), "pos": pos, "neg": neg, "kw": kws[:5]},
            "score": _f(max(-1, min(1, (pos - neg) / max(3, len(items)))), 2)}


def naver_news_score(name):
    r = requests.get("https://openapi.naver.com/v1/search/news.json", params={"query": name, "display": 30, "sort": "date"},
                     headers={"X-Naver-Client-Id": NAVER_ID, "X-Naver-Client-Secret": NAVER_SECRET}, timeout=10).json()
    items = r.get("items", [])
    if not items:
        return None, 0
    s = 0
    for it in items:
        t = re.sub("<.*?>", "", it.get("title", "") + " " + it.get("description", ""))
        s += sum(w in t for w in POS_W) - sum(w in t for w in NEG_W)
    return _f(max(-1, min(1, s / max(5, len(items) / 2))), 2), len(items)


def _n(x):
    try:
        return float(str(x).replace(",", "").replace("%", "").replace("+", "").strip())
    except Exception:
        return None


def _decode(raw):
    """네이버 페이지 인코딩 자동 판별 (UTF-8 우선, 실패 시 EUC-KR)"""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode("euc-kr", "ignore")


def _pick(d, *must):
    """딕셔너리에서 키 이름에 must 문자열이 모두 들어간 첫 값"""
    for k, v in d.items():
        if all(m.lower() in k.lower() for m in must):
            return v
    return None


def naver_flow(code):
    """외국인·기관 일별 순매매(주) + 외국인 보유율 — KRX 수급이 막혔을 때 대체.
    ① 네이버 모바일 API(JSON) ② PC 페이지(HTML) 순서로 시도"""
    try:  # 실시간 수급 수집기(flows.py)와 같은 경로 — 모바일 브라우저 헤더로 요청해야 응답함
        from flows import src_m_trend
        rows = sorted(src_m_trend(code, requests), key=lambda r: r["d"])[-10:]
        if rows:
            return {"inst": [r["i"] for r in rows], "frgn": [r["f"] for r in rows], "close": [r["c"] for r in rows],
                    "hold": next((r["h"] for r in reversed(rows) if r.get("h") is not None), None)}
    except Exception:
        pass
    try:
        j = requests.get(f"https://m.stock.naver.com/api/stock/{code}/trend", params={"pageSize": 10},
                         headers=UA, timeout=8).json()
        rows = j if isinstance(j, list) else (j.get("result") or j.get("trends") or j.get("list") or [])
        rows = [r for r in rows if isinstance(r, dict)]
        if rows:
            date_k = next((k for k in rows[0] if "date" in k.lower()), None)
            if date_k:
                rows = sorted(rows, key=lambda r: str(r.get(date_k)))  # 오래된 → 최근
            frgn = [_n(_pick(r, "foreign", "pure")) for r in rows]
            inst = [_n(_pick(r, "organ", "pure")) for r in rows]
            close = [_n(_pick(r, "close")) for r in rows]
            hold = _n(_pick(rows[-1], "foreign", "ratio"))
            if any(v is not None for v in frgn):
                return {"inst": inst, "frgn": frgn, "close": close, "hold": hold}
    except Exception:
        pass
    raw = requests.get(f"https://finance.naver.com/item/frgn.naver?code={code}",
                       headers={**UA, "Referer": f"https://finance.naver.com/item/main.naver?code={code}"}, timeout=8).content
    html = _decode(raw)
    for t in pd.read_html(io.StringIO(html)):
        cols = [" ".join(str(x) for x in c) if isinstance(c, tuple) else str(c) for c in t.columns]
        if not (any("기관" in c for c in cols) and any("외국인" in c for c in cols)):
            continue
        t.columns = cols
        c_date = cols[0]
        c_close = next((c for c in cols if "종가" in c), None)
        c_inst = next((c for c in cols if "기관" in c), None)
        c_frgn = next((c for c in cols if "외국인" in c and "순매매" in c), None) or next((c for c in cols if "외국인" in c), None)
        c_hold = next((c for c in cols if "보유율" in c), None)
        t = t[t[c_date].astype(str).str.match(r"\d{4}\.\d{2}\.\d{2}")]
        if t.empty:
            continue
        t = t.iloc[::-1]
        close = [_n(x) for x in t[c_close]] if c_close else [None] * len(t)
        return {"inst": [_n(x) for x in t[c_inst]], "frgn": [_n(x) for x in t[c_frgn]], "close": close,
                "hold": _n(t[c_hold].iloc[-1]) if c_hold else None}
    raise ValueError(f"표 없음(길이 {len(html)}, 앞부분 {html[:80]!r})")


def pmap(fn, items, workers=8, label="", deadline_min=10):
    """병렬 실행 + 진행률 로그. 전체 제한시간(deadline_min)이 지나면 남은 작업은 버리고 진행."""
    from concurrent.futures import wait, FIRST_COMPLETED
    out, n, done_n, first_err = {}, len(items), 0, []
    end = time.time() + deadline_min * 60
    ex = ThreadPoolExecutor(max_workers=workers)
    futs = {ex.submit(fn, it): it for it in items}
    pending = set(futs)
    while pending and time.time() < end:
        done, pending = wait(pending, timeout=min(15, max(1, end - time.time())), return_when=FIRST_COMPLETED)
        for f in done:
            try:
                out[futs[f]] = f.result()
            except Exception as e:
                out[futs[f]] = None
                if not first_err:
                    first_err.append(str(e)[:200])
                    log(f"  ! {label} 첫 오류: {first_err[0]}")
            done_n += 1
            if label and done_n % 50 == 0:
                log(f"  {label} {done_n}/{n}")
    if pending:
        log(f"  ! {label or '병렬조회'} 제한시간 {deadline_min}분 초과 → 남은 {len(pending)}건 건너뜀")
    ex.shutdown(wait=False, cancel_futures=True)
    if label:
        ok = sum(1 for v in out.values() if v not in (None, (None, 0)))
        log(f"  {label} 완료 {ok}/{n}")
    return out


# ═════════════ 8. KIS 분봉 (선택) ═════════════
def kis_token():
    r = requests.post("https://openapi.koreainvestment.com:9443/oauth2/tokenP",
                      json={"grant_type": "client_credentials", "appkey": KIS_KEY, "appsecret": KIS_SECRET}, timeout=10)
    return r.json()["access_token"]


def kis_intraday(token, code):
    """당일 1분봉(최근 30개씩 역순 조회) → 10분/60분 집계 → 흡수(매도 흡수) 판정"""
    url = "https://openapi.koreainvestment.com:9443/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice"
    hdr = {"authorization": f"Bearer {token}", "appkey": KIS_KEY, "appsecret": KIS_SECRET, "tr_id": "FHKST03010200"}
    rows, t = [], "153000"
    for _ in range(13):
        j = requests.get(url, headers=hdr, params={"FID_ETC_CLS_CODE": "", "FID_COND_MRKT_DIV_CODE": "J", "FID_INPUT_ISCD": code,
                         "FID_INPUT_HOUR_1": t, "FID_PW_DATA_INCU_YN": "N"}, timeout=10).json()
        out = j.get("output2", [])
        if not out:
            break
        rows += out
        t = out[-1]["stck_cntg_hour"]
        time.sleep(0.06)  # 초당 호출 제한
    if not rows:
        return None
    df = pd.DataFrame(rows).drop_duplicates("stck_cntg_hour")
    df["t"] = pd.to_datetime(df["stck_bsop_date"] + df["stck_cntg_hour"])
    df = df.set_index("t").sort_index().astype({"stck_prpr": float, "stck_oprc": float, "cntg_vol": float})
    m10 = df["stck_prpr"].resample("10min").last().dropna()
    m60 = df["stck_prpr"].resample("60min").last().dropna()
    up_vol = df.loc[df["stck_prpr"] >= df["stck_oprc"], "cntg_vol"].sum()
    dn_vol = df.loc[df["stck_prpr"] < df["stck_oprc"], "cntg_vol"].sum()
    return {"m10_trend": "상승" if len(m10) > 3 and m10.iloc[-1] > m10.iloc[-4] else "하락",
            "m60_trend": "상승" if len(m60) > 2 and m60.iloc[-1] > m60.iloc[-3] else "하락",
            "absorb": bool(up_vol > dn_vol * 1.2)}


# ═════════════ 메인 ═════════════
def main():
    t0 = time.time()
    asof, days = get_dates()
    log(f"기준일 {asof}")
    uni = get_universe(asof)
    codes = list(uni.index)

    macro, us_rets = get_macro()
    gate = macro_gate(macro, CFG)
    log(f"매크로 게이트 {gate['level']} — {gate['reasons']}")

    sec_of, sec_info, kospi5 = safe(get_sectors, asof, days, default=({}, [], 0))
    if not sec_info:  # KRX 업종 조회 실패 → 직전 데이터의 업종 분류 재사용
        try:
            prev = json.load(open(OUT, encoding="utf-8"))
            if not prev.get("meta", {}).get("sample") and prev.get("sectors"):
                sec_info = prev["sectors"]
                for x in sec_info:
                    x["stale"] = True
                sec_of = {x["code"]: x["sector"] for x in prev.get("stocks", []) if x.get("sector") and x["sector"] != "기타"}
                log(f"  ! 업종 조회 실패 → 직전 데이터 업종 {len(sec_info)}개 재사용(수익률은 직전 값)")
        except Exception as e:
            log(f"  ! 직전 업종 데이터 없음: {e}")
    for s in sec_info:
        s["us_impact"], s["coupling"], s["us_syms"] = us_impact(s["name"], us_rets, USMAP)

    flows = get_flows(days)
    flim = get_foreign_limit(asof)
    codes_by_tv = list(uni.sort_values("tv", ascending=False).index)
    shorts = safe(get_short_balance, days, codes_by_tv, default={})

    # 일봉 + 기술 피처
    start = asof - dt.timedelta(days=560)  # 약 380거래일 — 200일선·주봉 판정에 필요
    stocks = []
    os.makedirs(CL_DIR, exist_ok=True)
    cl_ok = cl_fail = 0
    cl_t = 0.0
    for i, code in enumerate(codes):
        df = safe(get_ohlcv, code, start, asof)
        if df is None:
            continue
        tf = tech_features(df, spark_len=120)
        if not tf:
            continue
        row = uni.loc[code]
        s = {"code": code, "name": row["name"], "market": row["market"], "mcap": _f(row["mcap"], 0),
             "sector": sec_of.get(code, "기타")}
        s.update(tf)
        s["is_fin"] = is_financial(s["sector"], s["name"])
        if clx_run is not None:
            _t = time.time()
            try:
                cs, cf = clx_run(df)
                if cs:
                    s["cl"] = cs
                    with open(os.path.join(CL_DIR, f"{code}.json"), "w", encoding="utf-8") as f:
                        json.dump(cf, f, ensure_ascii=False, separators=(",", ":"))
                    cl_ok += 1
            except Exception as e:
                cl_fail += 1
                if cl_fail <= 3:
                    log(f"  ! 차트랩 분석 실패 {code}: {type(e).__name__} {str(e)[:80]}")
            cl_t += time.time() - _t
        # 수급
        for inv, key in [("외국인", "foreign"), ("기관합계", "inst"), ("연기금", "pension")]:
            f = flows.get(inv)
            if f is not None and code in f.index:
                vals = [float(x) for x in f.loc[code].tolist()]
                s[f"{key}_streak"] = streak(vals)
                s[f"{key}_net5"] = _f(sum(vals[-5:]) / 1e8, 1)  # 억원
        if len(flim) and code in flim.index:
            s["foreign_hold"] = _f(flim.loc[code].get("지분율"))
            s["exhaustion"] = _f(flim.loc[code].get("한도소진률"))
        if code in shorts:
            s["short_ratio"], s["short_chg"] = _f(shorts[code][0]), _f(shorts[code][1])
        s["us_impact"], s["us_coupling"], _ = us_impact(s["sector"], us_rets, USMAP)
        sec = next((x for x in sec_info if x["name"] == s["sector"]), None)
        s["sector_rel5"] = sec["rel5"] if sec else None
        stocks.append(s)
        if i % 100 == 0:
            log(f"  일봉 {i}/{len(codes)}")
        time.sleep(0.05)

    log(f"차트랩 6축 분석 {cl_ok}종목 (실패 {cl_fail}) · {cl_t / 60:.1f}분")
    cl_index = {}
    if clx_run is not None:
        for nm, kc, fc in (("코스피", "1001", "KS11"), ("코스닥", "2001", "KQ11")):
            try:
                idf = None
                try:
                    from pykrx import stock as _st
                    idf = _st.get_index_ohlcv(ymd(start), ymd(asof), kc)
                except Exception:
                    idf = None
                if idf is None or len(idf) < 100:
                    import FinanceDataReader as fdr
                    idf = fdr.DataReader(fc, start, asof)
                cs, cf = clx_run(idf)
                if cs:
                    cs["verdict_action"] = cf["r"]["action"]
                    cs["notes"] = cf["r"]["axis_notes"]
                    cl_index[nm] = cs
                    with open(os.path.join(CL_DIR, f"IDX_{fc}.json"), "w", encoding="utf-8") as f:
                        json.dump(cf, f, ensure_ascii=False, separators=(",", ":"))
            except Exception as e:
                log(f"  ! {nm} 지수 차트랩 실패: {type(e).__name__}")
        log("지수 차트랩: " + ", ".join(f"{k} {v['s']:+.1f}({v['v']})" for k, v in cl_index.items()))

    # 수급 대체: KRX 수급이 5일치 미만이면 네이버 금융에서 외국인·기관 가져오기
    def _cols(inv):
        f = flows.get(inv)
        return 0 if f is None else f.shape[1]
    if _cols("외국인") < 5 or _cols("기관합계") < 5:
        log("KRX 수급 부족 → 네이버 금융 외국인·기관 순매매로 대체")
        nf = pmap(naver_flow, [x["code"] for x in stocks], workers=6, label="네이버 수급", deadline_min=10)
        ok = 0
        for x in stocks:
            r = nf.get(x["code"])
            if not r:
                continue
            ok += 1
            cl = r["close"]
            for key, arr in [("foreign", r["frgn"]), ("inst", r["inst"])]:
                vals = [v for v in arr if v is not None]
                x[f"{key}_streak"] = streak(vals)
                amt = [(v or 0) * (c or x["close"]) for v, c in zip(arr[-5:], cl[-5:])]
                x[f"{key}_net5"] = _f(sum(amt) / 1e8, 1)
            if r["hold"] is not None:
                x["foreign_hold"] = _f(r["hold"])
        log(f"네이버 수급 {ok}/{len(stocks)}종목")
        FLOW_SRC["v"] = "naver" if ok else "none"

    # DART
    if DART_KEY:
        log("DART 기업코드 조회")
        cmap = safe(dart_corp_map, default={}) or {}
        reps = latest_reports(asof)
        ccs = [cmap[s["code"]] for s in stocks if s["code"] in cmap]
        log(f"DART 재무 조회 {len(ccs)}개사 · 보고서 {reps}")
        fin = [dart_multi(ccs, y, rc) for y, rc in reps]
        log("DART 연간(ROE) 조회")
        annual = [dart_multi(ccs, y, "11011") for y in [asof.year - 1, asof.year - 2, asof.year - 3]]
        log("DART 공시 조회")
        disc = dart_disclosures(asof)
        for s in stocks:
            cc = cmap.get(s["code"])
            if not cc:
                continue
            f0 = fin[0].get(cc) if fin else None
            if f0:
                (sa, sa_p), (op, op_p) = f0["sales"], f0["op"]
                s["sales_yoy"] = _f((sa / sa_p - 1) * 100) if sa and sa_p and sa_p > 0 else None
                s["op_yoy"] = _f((op / op_p - 1) * 100) if op and op_p and op_p > 0 else None
                s["op_turn"] = bool(op and op_p is not None and op > 0 and op_p <= 0)
                liab, eq = f0["liab"][0], f0["equity"][0]
                ca, cl = f0["ca"][0], f0["cl"][0]
                if not s.get("is_fin"):  # 금융업은 부채비율·유동비율 판정 제외
                    s["debt_ratio"] = _f(liab / eq * 100, 1) if liab and eq and eq > 0 else None
                    s["current_ratio"] = _f(ca / cl * 100, 1) if ca and cl else None
            s["profit_q"] = sum(1 for f in fin if f.get(cc) and (f[cc]["op"][0] or 0) > 0)
            roes = []
            for a in annual:
                x = a.get(cc)
                if x and x["net"][0] is not None and x["equity"][0]:
                    roes.append(_f(x["net"][0] / x["equity"][0] * 100, 1))
            s["roe3"] = roes
            d = disc.get(s["code"])
            if d:
                s["disc_pos"], s["disc_neg"] = len(d["pos"]), len(d["neg"])
                s["earn_date"], s["pension_5pct"], s["disclosures"] = d["earn_date"], d["pension"], d["items"]
        # 후보만: 영업현금흐름
        cand = sorted(stocks, key=lambda x: (x.get("tech3", 0), x.get("foreign_streak", 0) + x.get("inst_streak", 0), x.get("tvalue", 0)), reverse=True)[:CAND_N]
        y, rc = reps[0]
        log(f"영업현금흐름 조회 {len(cand)}종목")
        ocf = pmap(lambda c: dart_ocf(cmap[c], y, rc), [x["code"] for x in cand if x["code"] in cmap], workers=4, label="영업현금흐름", deadline_min=8)
        for x in cand:
            v = ocf.get(x["code"])
            if v is not None:
                x["ocf"] = _f(v / 1e8, 1)
    else:
        log("DART_API_KEY 없음 → 실적·재무·공시 항목 비움")
        cand = sorted(stocks, key=lambda x: x.get("tvalue", 0), reverse=True)[:CAND_N]

    def save(stage):
        data = {
            "meta": {"asof": str(asof), "generated": dt.datetime.now().strftime("%Y-%m-%d %H:%M"), "sample": False,
                     "universe": len(stocks), "candidates": len(cand), "dart": bool(DART_KEY), "news": bool(NAVER_ID),
                     "kis": kis_ok, "flow_src": FLOW_SRC["v"], "stage": stage,
                     "elapsed_min": round((time.time() - t0) / 60, 1), "log_tail": LOG[-25:], "log": LOG[-400:]},
            "macro": macro, "gate": gate, "us_rets": us_rets, "kospi5": _f(kospi5), "cl_index": cl_index,
            "sectors": sorted(sec_info, key=lambda x: -(x["rel5"] or -99)),
            "stocks": stocks,
        }
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        with open(OUT, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
        log(f"저장 ({stage}) {os.path.getsize(OUT) / 1e6:.1f}MB")

    kis_ok = False
    save("핵심 데이터")  # 이후 단계가 멈춰도 여기까지는 반영됨

    # 목표주가 / 뉴스 / 분봉 (후보만)
    log(f"목표주가 조회 {len(cand)}종목")
    tps = {} if over_budget("목표주가") else pmap(naver_target, [x["code"] for x in cand], workers=8, label="목표주가", deadline_min=8)
    for x in cand:
        tp = tps.get(x["code"])
        if tp:
            x["target"] = tp
            x["upside"] = _f((tp / x["close"] - 1) * 100, 1)
    # 관련 뉴스(구글 뉴스 RSS, 키 불필요): 후보 + 거래대금 상위 + 호재 공시 종목, 최대 300
    if not over_budget("관련 뉴스"):
        pool = {x["code"]: x for x in cand}
        for x in sorted(stocks, key=lambda z: -(z.get("tvalue") or 0))[:150]:
            pool.setdefault(x["code"], x)
        for x in stocks:
            if x.get("disc_pos"):
                pool.setdefault(x["code"], x)
        targets = list(pool.values())[:300]
        log(f"관련 뉴스 조회 {len(targets)}종목")
        gn = pmap(google_news, [x["name"] for x in targets], workers=6, label="관련 뉴스", deadline_min=7)
        for x in targets:
            r = gn.get(x["name"])
            if r:
                x["news"], x["news_sum"] = r["items"], r["sum"]
                if x.get("news_score") is None:
                    x["news_score"], x["news_n"] = r["score"], r["sum"]["n"]
    if NAVER_ID and not over_budget("뉴스"):
        log("뉴스 감정점수 조회")
        ns = pmap(naver_news_score, [x["name"] for x in cand], workers=4, label="뉴스", deadline_min=5)
        for x in cand:
            r = ns.get(x["name"])
            if r:
                x["news_score"], x["news_n"] = r
    if KIS_KEY and not over_budget("분봉"):
        tok = safe(kis_token)
        if tok:
            kis_ok = True
            for s in cand[:60]:
                it = safe(kis_intraday, tok, s["code"])
                if it:
                    s.update(it)

    save("완료")


if __name__ == "__main__":
    main()
    sys.stdout.flush()
    os._exit(0)  # 제한시간으로 버린 백그라운드 요청이 남아 있어도 바로 종료
