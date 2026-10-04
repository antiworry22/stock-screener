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


def fchart(symbol, count=380):
    """네이버 차트 일봉: <item data="YYYYMMDD|시가|고가|저가|종가|거래량" />"""
    for k in range(3):
        try:
            r = S.get("https://fchart.stock.naver.com/sise.nhn",
                      params={"symbol": symbol, "timeframe": "day", "count": count, "requestType": 0}, timeout=(5, 15))
            txt = r.content.decode("euc-kr", errors="ignore")
            rows = re.findall(r'data="(\d{8})\|([\d.]+)\|([\d.]+)\|([\d.]+)\|([\d.]+)\|(\d+)"', txt)
            if len(rows) < 80:
                raise ValueError(f"rows {len(rows)}")
            df = pd.DataFrame(rows, columns=["날짜", "시가", "고가", "저가", "종가", "거래량"])
            df["날짜"] = pd.to_datetime(df["날짜"], format="%Y%m%d")
            df = df.set_index("날짜").astype(float)
            return df
        except Exception:
            if k == 2:
                raise
            time.sleep(1.5 * (k + 1))


def one(code):
    df = fchart(code)
    cs, cf = clx_run(df)
    if not cs:
        return code, None, None
    c = df["종가"]
    cs["c"] = int(c.iloc[-1])
    cs["chg"] = round((c.iloc[-1] / c.iloc[-2] - 1) * 100, 2) if len(c) > 1 and c.iloc[-2] else None
    cs["d"] = df.index[-1].strftime("%Y-%m-%d")
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

    res, fails, first_err = {}, 0, None
    ex = ProcessPoolExecutor(max_workers=max(2, (os.cpu_count() or 2) + 2))  # 계산이 무거워 프로세스로 나눠 돌림
    if True:
        futs = {ex.submit(one, code): code for code in names}
        for f in as_completed(futs):
            code = futs[f]
            if time.time() > DEADLINE:
                fails += 1
                continue
            try:
                c, cs, cf = f.result(timeout=60)
                if cs:
                    res[c] = cs
                    with open(os.path.join(OUT, f"{c}.json"), "w", encoding="utf-8") as fp:
                        json.dump(cf, fp, ensure_ascii=False, separators=(",", ":"))
            except Exception as e:
                fails += 1
                first_err = first_err or f"{code}: {type(e).__name__} {str(e)[:80]}"
        ex.shutdown(wait=False, cancel_futures=True)
    log(f"판정 {len(res)}종목 · 실패 {fails}" + (f" (예: {first_err})" if first_err else ""))
    if len(res) < len(names) * 0.3:
        log("새로 계산된 종목이 너무 적음(시세 접속 문제) → 직전 결과 유지, 저장 안 함")
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
    out = {"meta": {"time": NOW.strftime("%Y-%m-%d %H:%M"), "asof": max((v.get("d", "") for v in res.values()), default=""),
                    "n": len(res), "fails": fails, "elapsed_s": round(time.time() - t0), "prev_time": prev.get("meta", {}).get("time"),
                    "log": LOG[-20:]},
           "idx": idx, "changes": changes[:200], "s": merged}
    with open(os.path.join(OUT, "summary.json"), "w", encoding="utf-8") as fp:
        json.dump(out, fp, ensure_ascii=False, separators=(",", ":"))
    log(f"저장 — 판정 변화 {len(changes)}건 · {round(time.time() - t0)}초")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"오류: {type(e).__name__}: {e}")
    sys.stdout.flush()
    os._exit(0)
