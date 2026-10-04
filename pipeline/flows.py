"""
외국인·기관 수급 — 장중·장마감 후 여러 번 전 종목의 외국인·기관 순매매를 새로 받아 보관 칸(live-flow)에 올립니다.

실행:  python pipeline/flows.py            (GitHub Actions flows 작업)
입력:  site/data/latest.json (종목 목록), liveflow/flows.json (직전 결과)
출력:  liveflow/flows.json, liveflow/status.json (접속 진단 — 어느 경로가 되고 안 되는지 그대로 기록)

경로(앞에서부터 시도, 삼성전자로 먼저 시험해 되는 것만 씀)
  ① 네이버 증권 모바일 API  m.stock.naver.com/api/stock/{code}/trend
  ② 네이버 증권 모바일 종합 API  m.stock.naver.com/api/stock/{code}/integration (dealTrendInfos)
  ③ 네이버 금융 PC 페이지  finance.naver.com/item/frgn.naver
값: 일별 순매매 수량(주) → 금액은 종가를 곱해 억원으로. 장중에는 거래소 '잠정치'가 나오는 시각(09:30·11:00·13:20·14:30 무렵)에 맞춰 돌고,
    장 마감 뒤(15:45 잠정 · 18:10 확정) 한 번 더 돌아 그날 값을 확정합니다.
"""
import datetime as dt
import io
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LATEST = os.path.join(ROOT, "site", "data", "latest.json")
OUT = os.environ.get("FLOW_DIR", os.path.join(ROOT, "liveflow"))
KST = dt.timezone(dt.timedelta(hours=9))
NOW = dt.datetime.now(KST)
DEADLINE = time.time() + float(os.environ.get("FLOW_BUDGET_MIN", "8")) * 60
UA_PC = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
         "Accept-Language": "ko-KR,ko;q=0.9", "Referer": "https://finance.naver.com/"}
UA_M = {"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "application/json, text/plain, */*", "Accept-Language": "ko-KR,ko;q=0.9", "Referer": "https://m.stock.naver.com/"}
LOG, DIAG = [], {}


def log(m):
    m = f"[{dt.datetime.now(KST).strftime('%H:%M:%S')}] {m}"
    LOG.append(m)
    print(m, flush=True)


def num(x):
    if x is None:
        return None
    try:
        return float(str(x).replace(",", "").replace("%", "").replace("+", "").replace("주", "").strip())
    except Exception:
        return None


def pick(d, *must):
    for k, v in d.items():
        if all(m.lower() in k.lower() for m in must):
            return v
    return None


def ymd(s):
    s = re.sub(r"\D", "", str(s or ""))[:8]
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}" if len(s) == 8 else None


def rows_from_json(rows):
    """[{bizdate, foreignerPureBuyQuant, organPureBuyQuant, foreignerHoldRatio, closePrice ...}] → 표준 행"""
    out = []
    for r in rows:
        if not isinstance(r, dict):
            continue
        dk = next((k for k in r if "date" in k.lower()), None)
        d = ymd(r.get(dk)) if dk else None
        f = num(pick(r, "foreign", "pure")) if pick(r, "foreign", "pure") is not None else num(pick(r, "frgn", "pure"))
        i = num(pick(r, "organ", "pure")) if pick(r, "organ", "pure") is not None else num(pick(r, "inst", "pure"))
        if d and (f is not None or i is not None):
            out.append({"d": d, "f": f, "i": i, "p": num(pick(r, "individual", "pure")), "c": num(pick(r, "close")),
                        "h": num(pick(r, "foreign", "ratio")) or num(pick(r, "hold", "ratio"))})
    return out


def src_m_trend(code, S):
    r = S.get(f"https://m.stock.naver.com/api/stock/{code}/trend", params={"pageSize": 20}, headers=UA_M, timeout=(5, 10))
    if r.status_code != 200:
        raise ValueError(f"HTTP {r.status_code}: {r.text[:120]!r}")
    j = r.json()
    rows = j if isinstance(j, list) else (j.get("result") or j.get("trends") or j.get("list") or j.get("items") or [])
    out = rows_from_json(rows)
    if not out:
        raise ValueError(f"행 없음: {str(j)[:160]!r}")
    return out


def src_m_integ(code, S):
    r = S.get(f"https://m.stock.naver.com/api/stock/{code}/integration", headers=UA_M, timeout=(5, 10))
    if r.status_code != 200:
        raise ValueError(f"HTTP {r.status_code}: {r.text[:120]!r}")
    j = r.json()
    rows = j.get("dealTrendInfos") or j.get("dealTrendInfo") or []
    out = rows_from_json(rows)
    if not out:
        raise ValueError(f"dealTrendInfos 없음: keys={list(j)[:12]}")
    return out


def src_pc(code, S):
    import pandas as pd
    r = S.get("https://finance.naver.com/item/frgn.naver", params={"code": code},
              headers={**UA_PC, "Referer": f"https://finance.naver.com/item/main.naver?code={code}"}, timeout=(5, 10))
    raw = r.content
    try:
        html = raw.decode("utf-8")
    except UnicodeDecodeError:
        html = raw.decode("euc-kr", "ignore")
    if r.status_code != 200:
        raise ValueError(f"HTTP {r.status_code}: {html[:120]!r}")
    for t in pd.read_html(io.StringIO(html)):
        cols = [" ".join(str(x) for x in c) if isinstance(c, tuple) else str(c) for c in t.columns]
        if not (any("기관" in c for c in cols) and any("외국인" in c for c in cols)):
            continue
        t.columns = cols
        cd = cols[0]
        cc = next((c for c in cols if "종가" in c), None)
        ci = next((c for c in cols if "기관" in c), None)
        cf = next((c for c in cols if "외국인" in c and "순매매" in c), None) or next((c for c in cols if "외국인" in c), None)
        ch = next((c for c in cols if "보유율" in c), None)
        t = t[t[cd].astype(str).str.match(r"\d{4}\.\d{2}\.\d{2}")]
        out = [{"d": ymd(x[cd]), "f": num(x[cf]), "i": num(x[ci]), "p": None, "c": num(x[cc]) if cc else None, "h": num(x[ch]) if ch else None}
               for _, x in t.iterrows()]
        if out:
            return out
    raise ValueError(f"표 없음(길이 {len(html)}, 앞부분 {html[:100]!r})")


SOURCES = [("네이버 모바일 trend", src_m_trend), ("네이버 모바일 integration", src_m_integ), ("네이버 PC frgn", src_pc)]


def probe():
    """삼성전자로 각 경로 시험 → 되는 경로 목록 (진단 기록 남김)"""
    S = requests.Session()
    ok = []
    for nm, fn in SOURCES:
        try:
            rows = fn("005930", S)
            rows.sort(key=lambda x: x["d"])
            DIAG[nm] = f"OK {len(rows)}행 · 최근 {rows[-1]['d']} 외국인 {rows[-1]['f']} 기관 {rows[-1]['i']}"
            ok.append((nm, fn))
        except Exception as e:
            DIAG[nm] = f"실패 {type(e).__name__}: {str(e)[:220]}"
        log(f"경로 {nm}: {DIAG[nm]}")
    return ok


def summarize(rows, close_now):
    """일별 행(오래된→최근) → 화면용 요약"""
    rows = sorted([r for r in rows if r["d"]], key=lambda x: x["d"])[-20:]

    def streak(vals):
        vals = [v for v in vals if v is not None]
        if not vals or vals[-1] == 0:
            return 0
        sg, n = (1 if vals[-1] > 0 else -1), 0
        for v in reversed(vals):
            if (v > 0) == (sg > 0) and v != 0:
                n += 1
            else:
                break
        return n * sg

    def amt5(key):
        tot = 0.0
        for r in rows[-5:]:
            q = r.get(key)
            if q is None:
                continue
            tot += q * (r.get("c") or close_now or 0)
        return round(tot / 1e8, 1)

    last = rows[-1]
    hold = next((r["h"] for r in reversed(rows) if r.get("h") is not None), None)
    return {
        "d": last["d"], "fs": streak([r["f"] for r in rows]), "is": streak([r["i"] for r in rows]),
        "fn5": amt5("f"), "in5": amt5("i"), "fh": hold,
        "f1": round((last["f"] or 0) * (last.get("c") or close_now or 0) / 1e8, 1) if last.get("f") is not None else None,
        "i1": round((last["i"] or 0) * (last.get("c") or close_now or 0) / 1e8, 1) if last.get("i") is not None else None,
        # 최근 10일 순매매 수량(주) — 그래프·연속일 검산용
        "ff": [r["f"] for r in rows[-10:]], "ii": [r["i"] for r in rows[-10:]], "dd": [r["d"] for r in rows[-10:]],
    }


def main():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    stocks = json.load(open(LATEST, encoding="utf-8")).get("stocks", [])
    targets = {s["code"]: s.get("close") for s in stocks if s.get("market") in ("KOSPI", "KOSDAQ")}
    try:
        prev = json.load(open(os.path.join(OUT, "flows.json"), encoding="utf-8"))
    except Exception:
        prev = {}
    log(f"대상 {len(targets)}종목 · 직전 {len(prev.get('s', {}))}종목 ({prev.get('meta', {}).get('time', '-')})")

    def status(msg, n=0):
        json.dump({"time": NOW.strftime("%Y-%m-%d %H:%M"), "msg": msg, "n": n, "diag": DIAG, "log": LOG[-40:]},
                  open(os.path.join(OUT, "status.json"), "w", encoding="utf-8"), ensure_ascii=False)

    ok = probe()
    if not ok:
        log("모든 수급 경로 실패 → 직전 결과 유지")
        status("모든 경로 실패")
        return
    S = requests.Session()
    res, fails, first_err = {}, 0, None

    def one(code):
        last_e = None
        for nm, fn in ok:
            for k in range(2):
                try:
                    return code, nm, fn(code, S)
                except Exception as e:
                    last_e = e
                    time.sleep(0.6)
        raise last_e

    used = {}
    ex = ThreadPoolExecutor(max_workers=8)
    if True:
        futs = {ex.submit(one, c): c for c in targets}
        try:
            for f in as_completed(futs, timeout=max(30, DEADLINE - time.time())):
                code = futs[f]
                try:
                    c, nm, rows = f.result()
                    res[c] = summarize(rows, targets.get(c))
                    used[nm] = used.get(nm, 0) + 1
                except Exception as e:
                    fails += 1
                    first_err = first_err or f"{code}: {type(e).__name__} {str(e)[:150]}"
                if (len(res) + fails) % 200 == 0:
                    log(f"  진행 {len(res) + fails}/{len(targets)}")
        except Exception:
            log(f"제한시간 도달 — {len(res)}종목까지 반영")
        ex.shutdown(wait=False, cancel_futures=True)
    log(f"수급 {len(res)}종목 · 실패 {fails}" + (f" (예: {first_err})" if first_err else "") + f" · 경로 {used}")
    if len(res) < len(targets) * 0.3:
        log("받은 종목이 너무 적음 → 직전 결과 유지")
        status("받은 종목 부족", len(res))
        return
    merged = {**prev.get("s", {}), **res}
    days = sorted({v["d"] for v in res.values() if v.get("d")})
    out = {"meta": {"time": NOW.strftime("%Y-%m-%d %H:%M"), "asof": days[-1] if days else None, "n": len(res), "fails": fails,
                    "src": used, "elapsed_s": round(time.time() - t0), "prev_time": prev.get("meta", {}).get("time"),
                    "intraday": 9 <= NOW.hour < 16 and NOW.weekday() < 5},
           "s": merged}
    json.dump(out, open(os.path.join(OUT, "flows.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    log(f"저장 — {len(merged)}종목 · 기준일 {out['meta']['asof']} · {round(time.time() - t0)}초")
    status("정상", len(res))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"오류: {type(e).__name__}: {e}")
        try:
            json.dump({"time": NOW.strftime("%Y-%m-%d %H:%M"), "msg": f"오류 {e}", "diag": DIAG, "log": LOG[-40:]},
                      open(os.path.join(OUT, "status.json"), "w", encoding="utf-8"), ensure_ascii=False)
        except Exception:
            pass
    sys.stdout.flush()
    os._exit(0)
