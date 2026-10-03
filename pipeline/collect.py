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
                if df is not None and len(df):
                    parts.append(df["순매수거래대금"])
                    fails = 0
                else:
                    fails += 1
                time.sleep(0.3)
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


def get_short_balance(days, codes):
    """공매도 잔고 비중(%)과 5영업일 변화. 시장 단위 함수가 없으면 후보 종목만 개별 조회."""
    from pykrx import stock
    out = {}
    fn = getattr(stock, "get_shorting_balance_by_ticker", None)
    if fn:
        try:
            now = pd.concat([fn(ymd(days[-1]), m) for m in ["KOSPI", "KOSDAQ"]])
            bef = pd.concat([fn(ymd(days[-6]), m) for m in ["KOSPI", "KOSDAQ"]])
            col = [c for c in now.columns if "비중" in c][0]
            for t in now.index:
                b = bef[col].get(t)
                out[t] = (float(now[col][t]), float(now[col][t] - b) if b is not None else None)
            return out
        except Exception as e:
            log(f"  ! 공매도 시장단위 조회 실패 → 개별 조회: {e}")
    fails = 0
    for t in codes[:SHORT_N]:  # 거래대금 상위 종목만 개별 조회
        if fails >= 5:  # 연속 5번 실패하면 KRX가 막힌 것 → 공매도 항목 비우고 진행
            log("  ! 공매도 잔고 개별 조회 연속 실패 → 이번 수집에서 제외")
            break
        try:
            df = stock.get_shorting_balance_by_date(ymd(days[-6]), ymd(days[-1]), t)
        except Exception:
            df = None
        if df is not None and len(df):
            col = [c for c in df.columns if "비중" in c][0]
            out[t] = (float(df[col].iloc[-1]), float(df[col].iloc[-1] - df[col].iloc[0]))
            fails = 0
        else:
            fails += 1
        time.sleep(0.2)
    return out


# ═════════════ 4. 업종 지수 ═════════════
SIZE_WORDS = ["코스피", "코스닥", "대형", "중형", "소형", "200", "100", "150", "50", "배당", "우량", "TOP", "KRX", "벤처", "글로벌", "기술"]


def get_sectors(asof, days):
    from pykrx import stock
    sec_of, sec_info = {}, []
    k = stock.get_index_ohlcv(ymd(days[-8]), ymd(asof), "1001")["종가"]
    kospi5 = (k.iloc[-1] / k.iloc[-6] - 1) * 100
    for mkt in ["KOSPI", "KOSDAQ"]:
        for t in stock.get_index_ticker_list(ymd(asof), market=mkt):
            name = stock.get_index_ticker_name(t)
            if any(w in name for w in SIZE_WORDS):
                continue
            members = safe(stock.get_index_portfolio_deposit_file, t, default=[]) or []
            if not members:
                continue
            ix = safe(stock.get_index_ohlcv, ymd(days[-8]), ymd(asof), t)
            if ix is None or len(ix) < 6:
                continue
            r5 = (ix["종가"].iloc[-1] / ix["종가"].iloc[-6] - 1) * 100
            sec_info.append({"code": t, "name": name, "market": mkt, "ret5": _f(r5), "rel5": _f(r5 - kospi5), "count": len(members)})
            for m in members:
                if m not in sec_of or len(members) < sec_of[m][1]:
                    sec_of[m] = (name, len(members))
            time.sleep(0.2)
    log(f"업종 {len(sec_info)}개")
    return {k: v[0] for k, v in sec_of.items()}, sec_info, kospi5


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
def naver_target(code):
    html = requests.get(f"https://finance.naver.com/item/main.naver?code={code}", headers=UA, timeout=10).text
    m = re.search(r"목표주가.*?<em[^>]*>\s*([\d,]+)\s*</em>", html, re.S)
    return _num(m.group(1)) if m else None


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

    # DART
    if DART_KEY:
        cmap = safe(dart_corp_map, default={}) or {}
        reps = latest_reports(asof)
        ccs = [cmap[s["code"]] for s in stocks if s["code"] in cmap]
        fin = [dart_multi(ccs, y, rc) for y, rc in reps]
        annual = [dart_multi(ccs, y, "11011") for y in [asof.year - 1, asof.year - 2, asof.year - 3]]
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
        for s in cand:
            cc = cmap.get(s["code"])
            if cc:
                s["ocf"] = _f((safe(dart_ocf, cc, y, rc) or 0) / 1e8, 1) if cc else None
                time.sleep(0.1)
    else:
        log("DART_API_KEY 없음 → 실적·재무·공시 항목 비움")
        cand = sorted(stocks, key=lambda x: x.get("tvalue", 0), reverse=True)[:CAND_N]

    # 목표주가 / 뉴스 / 분봉 (후보만)
    for s in cand:
        tp = safe(naver_target, s["code"])
        if tp:
            s["target"] = tp
            s["upside"] = _f((tp / s["close"] - 1) * 100, 1)
        if NAVER_ID:
            sc = safe(naver_news_score, s["name"], default=(None, 0))
            s["news_score"], s["news_n"] = sc
        time.sleep(0.2)
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
                 "kis": kis_ok, "elapsed_min": round((time.time() - t0) / 60, 1), "log_tail": LOG[-15:]},
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
