"""
실시간 차트 종합판정 — 장중 15분마다 전 종목 일봉(오늘 장중 봉 포함)을 새로 받아 6축 엔진을 다시 돌립니다.

실행:  python pipeline/live_chart.py          (GitHub Actions live-chart 작업)
입력:  site/data/latest.json (종목 목록), livecl/ (직전 결과 — 보관 칸 live-cl 에서 받아 둠)
출력:  livecl/{코드}.json (일봉 + 전체 분석), livecl/summary.json (전 종목 요약 + 판정 변화)
시세:  네이버 차트 데이터(fchart) — 수정주가 일봉, 장중에는 오늘 봉이 실시간으로 반영됨 (로그인 불필요)
"""
import datetime as dt
import json
import os
import re
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed

import pandas as pd
import requests

sys.path.insert(0, os.path.dirname(__file__))
from clx.engine import run as clx_run  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LATEST = os.path.join(ROOT, "site", "data", "latest.json")
OUT = os.environ.get("LIVE_DIR", os.path.join(ROOT, "livecl"))
KST = dt.timezone(dt.timedelta(hours=9))
NOW = dt.datetime.now(KST)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36",
      "Referer": "https://finance.naver.com/"}
DEADLINE = time.time() + float(os.environ.get("LIVE_BUDGET_MIN", "9")) * 60
LOG = []
S = requests.Session()
S.headers.update(UA)


def log(m):
    m = f"[{dt.datetime.now(KST).strftime('%H:%M:%S')}] {m}"
    LOG.append(m)
    print(m, flush=True)


def _fchart(symbol, count=380):
    """네이버 차트(fchart) 일봉: <item data="YYYYMMDD|시가|고가|저가|종가|거래량" />"""
    r = S.get("https://fchart.stock.naver.com/sise.nhn",
              params={"symbol": symbol, "timeframe": "day", "count": count, "requestType": 0}, timeout=(5, 12))
    txt = r.content.decode("euc-kr", errors="ignore")
    rows = re.findall(r'data="(\d{8})\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)\|(\d+)"', txt)
    if len(rows) < 80:
        raise ValueError(f"fchart HTTP {r.status_code}, 행 {len(rows)}")
    df = pd.DataFrame(rows, columns=["날짜", "시가", "고가", "저가", "종가", "거래량"])
    df["날짜"] = pd.to_datetime(df["날짜"], format="%Y%m%d")
    return df.set_index("날짜").astype(float)


def _napi(symbol, count=380):
    """네이버 증권 신규 차트 API (JSON)"""
    kind = "index" if symbol in ("KOSPI", "KOSDAQ") else "item"
    end = NOW.strftime("%Y%m%d") + "2359"
    start = (NOW - dt.timedelta(days=int(count * 1.5))).strftime("%Y%m%d") + "0000"
    r = S.get(f"https://api.stock.naver.com/chart/domestic/{kind}/{symbol}/day",
              params={"startDateTime": start, "endDateTime": end}, timeout=(5, 12))
    j = r.json()
    rows = j if isinstance(j, list) else (j.get("priceInfos") or j.get("result") or [])
    recs = []
    for x in rows:
        d = str(x.get("localDate") or x.get("localTradedAt") or x.get("date") or "")[:10].replace("-", "")
        try:
            recs.append([pd.to_datetime(d, format="%Y%m%d"), float(x.get("openPrice")), float(x.get("highPrice")), float(x.get("lowPrice")),
                         float(x.get("closePrice")), float(x.get("accumulatedTradingVolume") or x.get("volume") or 0)])
        except Exception:
            continue
    if len(recs) < 80:
        raise ValueError(f"napi HTTP {r.status_code}, 행 {len(recs)}")
    df = pd.DataFrame(recs, columns=["날짜", "시가", "고가", "저가", "종가", "거래량"]).set_index("날짜").sort_index()
    return df[~df.index.duplicated(keep="last")]


def _fdr(symbol, count=380):
    import FinanceDataReader as fdr
    sym = {"KOSPI": "KS11", "KOSDAQ": "KQ11"}.get(symbol, symbol)
    df = fdr.DataReader(sym, (NOW - dt.timedelta(days=int(count * 1.5))).strftime("%Y-%m-%d"))
    df = df.rename(columns={"Open": "시가", "High": "고가", "Low": "저가", "Close": "종가", "Volume": "거래량"})
    if len(df) < 80:
        raise ValueError(f"fdr 행 {len(df)}")
    return df[["시가", "고가", "저가", "종가", "거래량"]].astype(float)


SOURCES = {"네이버차트": _fchart, "네이버API": _napi, "FDR": _fdr}
SRC = {"name": None}


def fchart(symbol, count=380):
    fn = SOURCES[SRC["name"]] if SRC["name"] else _fchart
    for k in range(2):
        try:
            return fn(symbol, count)
        except Exception:
            if k == 1:
                raise
            time.sleep(1.0)


def pick_source():
    """삼성전자로 각 경로를 시험해 처음 되는 것을 씀"""
    for nm, fn in SOURCES.items():
        try:
            df = fn("005930")
            log(f"시세 경로 '{nm}' 사용 — 삼성전자 {len(df)}봉, 마지막 {df.index[-1].date()} 종가 {df['종가'].iloc[-1]:,.0f}")
            SRC["name"] = nm
            return nm
        except Exception as e:
            log(f"시세 경로 '{nm}' 실패: {type(e).__name__} {str(e)[:120]}")
    return None


def one(code):
    df = fchart(code)
    cs, cf = clx_run(df)
    if not cs:
        return code, None, None
    c = df["종가"]
    cs["c"] = int(c.iloc[-1])
    cs["chg"] = round((c.iloc[-1] / c.iloc[-2] - 1) * 100, 2) if len(c) > 1 and c.iloc[-2] else None
    cs["d"] = df.index[-1].strftime("%Y-%m-%d")
    # 최근 3봉(날짜·시가·고가·저가·종가·거래량) — 화면의 거래량·거래대금 실시간 분석용 (장중엔 마지막 봉이 진행 중)
    t3 = df.iloc[-3:]
    cs["bars"] = [[i.strftime("%Y-%m-%d"), int(r["시가"]), int(r["고가"]), int(r["저가"]), int(r["종가"]), int(r["거래량"])] for i, r in t3.iterrows()]
    return code, cs, cf


def main():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    stocks = json.load(open(LATEST, encoding="utf-8")).get("stocks", [])
    names = {s["code"]: (s["name"], s.get("market")) for s in stocks if s.get("market") in ("KOSPI", "KOSDAQ")}
    prev = {}
    try:
        prev = json.load(open(os.path.join(OUT, "summary.json"), encoding="utf-8"))
    except Exception:
        prev = {}
    prev_s = prev.get("s", {})
    log(f"대상 {len(names)}종목 · 직전 요약 {len(prev_s)}종목 ({prev.get('meta', {}).get('time', '-')})")

    def status(msg):
        with open(os.path.join(OUT, "status.json"), "w", encoding="utf-8") as fp:
            json.dump({"time": NOW.strftime("%Y-%m-%d %H:%M"), "msg": msg, "log": LOG[-40:]}, fp, ensure_ascii=False)

    if not pick_source():
        log("모든 시세 경로 실패 → 이번 회차 건너뜀(직전 결과 유지)")
        status("시세 접속 실패")
        return
    res, fails, first_err = {}, 0, None
    ex = ProcessPoolExecutor(max_workers=max(2, (os.cpu_count() or 2) + 2))  # 계산이 무거워 프로세스로 나눠 돌림
    futs = {ex.submit(one, code): code for code in names}
    try:
        for f in as_completed(futs, timeout=max(30, DEADLINE - time.time())):
            code = futs[f]
            try:
                c, cs, cf = f.result(timeout=60)
                if cs:
                    res[c] = cs
                    with open(os.path.join(OUT, f"{c}.json"), "w", encoding="utf-8") as fp:
                        json.dump(cf, fp, ensure_ascii=False, separators=(",", ":"))
            except Exception as e:
                fails += 1
                first_err = first_err or f"{code}: {type(e).__name__} {str(e)[:80]}"
    except Exception:  # 제한시간 도달 — 끝난 것까지만 반영
        log(f"제한시간 도달 — {len(res)}종목까지 반영")
    ex.shutdown(wait=False, cancel_futures=True)
    for p in list((getattr(ex, "_processes", None) or {}).values()):
        try:
            p.terminate()
        except Exception:
            pass
    log(f"판정 {len(res)}종목 · 실패 {fails}" + (f" (예: {first_err})" if first_err else ""))
    if len(res) < len(names) * 0.3:
        log("새로 계산된 종목이 너무 적음(시세 접속 문제) → 직전 결과 유지, 저장 안 함")
        status("계산 종목 부족")
        return

    idx = dict(prev.get("idx", {}))
    for nm, sym in (("코스피", "KOSPI"), ("코스닥", "KOSDAQ")):
        try:
            df = fchart(sym)
            cs, cf = clx_run(df)
            if cs:
                c = df["종가"]
                cs.update({"verdict_action": cf["r"]["action"], "c": round(float(c.iloc[-1]), 2),
                           "chg": round((c.iloc[-1] / c.iloc[-2] - 1) * 100, 2)})
                idx[nm] = cs
        except Exception as e:
            log(f"{nm} 지수 실패: {type(e).__name__}")

    # 판정 변화 (직전 실행 대비)
    rank = ["강력 매도", "매도 우위", "약한 매도", "중립·관망", "약한 매수", "매수 우위", "강력 매수"]
    changes = []
    for code, cs in res.items():
        p = prev_s.get(code)
        if not p:
            continue
        a, b = p.get("v"), cs.get("v")
        if a != b and a in rank and b in rank:
            changes.append({"code": code, "from": a, "to": b, "up": rank.index(b) > rank.index(a), "s0": p.get("s"), "s1": cs.get("s")})
        elif not p.get("ckp") and cs.get("ckp"):
            changes.append({"code": code, "from": "체크리스트 미통과", "to": "체크리스트 통과", "up": True, "s0": p.get("s"), "s1": cs.get("s")})
    changes.sort(key=lambda x: -abs((x["s1"] or 0) - (x["s0"] or 0)))
    merged = {**prev_s, **res}  # 이번에 실패한 종목은 직전 값 유지
    out = {"meta": {"src": SRC["name"], "time": NOW.strftime("%Y-%m-%d %H:%M"), "asof": max((v.get("d", "") for v in res.values()), default=""),
                    "n": len(res), "fails": fails, "elapsed_s": round(time.time() - t0), "prev_time": prev.get("meta", {}).get("time"),
                    "log": LOG[-20:]},
           "idx": idx, "changes": changes[:200], "s": merged}
    with open(os.path.join(OUT, "summary.json"), "w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False, separators=(",", ":"))
    log(f"저장 — 판정 변화 {len(changes)}건 · {round(time.time() - t0)}초 · 시세 경로 {SRC['name']}")
    status("정상")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"오류: {type(e).__name__}: {e}")
    sys.stdout.flush()
    os._exit(0)
