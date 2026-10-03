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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
OUT = os.path.join(SITE, "data", "latest.json")
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


def log(msg):
    print(msg, flush=True)
    LOG.append(msg)


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
    html = raw.decode("euc-kr", "ignore")
    seg = html[html.find("목표주가"):][:600] if "목표주가" in html else ""
    nums = [_num(x) for x in re.findall(r"<em[^>]*>\s*([\d,]+)\s*</em>", seg)]
    nums = [x for x in nums if x and x >= 100]  # 투자의견 점수(4.00 등) 제외
    return nums[0] if nums else None


POS_W = ["수주", "최대", "흑자", "상향", "호실적", "급증", "신고가", "계약", "승인", "돌파", "개선", "성장", "자사주"]
NEG_W = ["적자", "하향", "급락", "소송", "유상증자", "감자", "부진", "리콜", "횡령", "배임", "제재", "손실", "철회"]


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


def naver_flow(code):
    """네이버 금융 외국인·기관 일별 순매매(주) + 외국인 보유율 — KRX 수급이 막혔을 때 대체"""
    html = requests.get(f"https://finance.naver.com/item/frgn.naver?code={code}", headers=UA, timeout=8).content.decode("euc-kr", "ignore")
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
        t = t.iloc[::-1]  # 오래된 날짜 → 최근
        close = [_n(x) for x in t[c_close]] if c_close else [None] * len(t)
        return {"inst": [_n(x) for x in t[c_inst]], "frgn": [_n(x) for x in t[c_frgn]], "close": close,
                "hold": _n(t[c_hold].iloc[-1]) if c_hold else None}
    return None


def pmap(fn, items, workers=8, label=""):
    """병렬 실행 + 진행률 로그"""
    out, n = {}, len(items)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fn, it): it for it in items}
        for i, f in enumerate(futs):
            try:
                out[futs[f]] = f.result(timeout=60)
            except Exception:
                out[futs[f]] = None
            if label and (i + 1) % 100 == 0:
                log(f"  {label} {i + 1}/{n}")
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
    for s in sec_info:
        s["us_impact"], s["coupling"], s["us_syms"] = us_impact(s["name"], us_rets, USMAP)

    flows = get_flows(days)
    flim = get_foreign_limit(asof)
    codes_by_tv = list(uni.sort_values("tv", ascending=False).index)
    shorts = safe(get_short_balance, days, codes_by_tv, default={})

    # 일봉 + 기술 피처
    start = asof - dt.timedelta(days=420)
    stocks = []
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

    # 수급 대체: KRX 수급이 5일치 미만이면 네이버 금융에서 외국인·기관 가져오기
    def _cols(inv):
        f = flows.get(inv)
        return 0 if f is None else f.shape[1]
    if _cols("외국인") < 5 or _cols("기관합계") < 5:
        log("KRX 수급 부족 → 네이버 금융 외국인·기관 순매매로 대체")
        nf = pmap(naver_flow, [x["code"] for x in stocks], workers=6, label="네이버 수급")
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
        ocf = pmap(lambda c: dart_ocf(cmap[c], y, rc), [x["code"] for x in cand if x["code"] in cmap], workers=4, label="영업현금흐름")
        for x in cand:
            v = ocf.get(x["code"])
            if v is not None:
                x["ocf"] = _f(v / 1e8, 1)
    else:
        log("DART_API_KEY 없음 → 실적·재무·공시 항목 비움")
        cand = sorted(stocks, key=lambda x: x.get("tvalue", 0), reverse=True)[:CAND_N]

    # 목표주가 / 뉴스 / 분봉 (후보만)
    log(f"목표주가 조회 {len(cand)}종목")
    tps = pmap(naver_target, [x["code"] for x in cand], workers=8, label="목표주가")
    for x in cand:
        tp = tps.get(x["code"])
        if tp:
            x["target"] = tp
            x["upside"] = _f((tp / x["close"] - 1) * 100, 1)
    if NAVER_ID:
        log("뉴스 감정점수 조회")
        ns = pmap(naver_news_score, [x["name"] for x in cand], workers=4)
        for x in cand:
            r = ns.get(x["name"])
            if r:
                x["news_score"], x["news_n"] = r
    kis_ok = False
    if KIS_KEY:
        tok = safe(kis_token)
        if tok:
            kis_ok = True
            for s in cand[:60]:
                it = safe(kis_intraday, tok, s["code"])
                if it:
                    s.update(it)

    data = {
        "meta": {"asof": str(asof), "generated": dt.datetime.now().strftime("%Y-%m-%d %H:%M"), "sample": False,
                 "universe": len(stocks), "candidates": len(cand), "dart": bool(DART_KEY), "news": bool(NAVER_ID),
                 "kis": kis_ok, "flow_src": FLOW_SRC["v"], "elapsed_min": round((time.time() - t0) / 60, 1), "log_tail": LOG[-15:]},
        "macro": macro, "gate": gate, "us_rets": us_rets, "kospi5": _f(kospi5),
        "sectors": sorted(sec_info, key=lambda x: -(x["rel5"] or -99)),
        "stocks": stocks,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    log(f"저장 완료 {OUT} ({os.path.getsize(OUT) / 1e6:.1f}MB, {data['meta']['elapsed_min']}분)")


if __name__ == "__main__":
    main()
