"""
투자자별 흐름 — 거래소(KRX) 투자자별 순매수(외국인·연기금·기관합계·개인)를 종목별 최근 20거래일 + 시장 전체로 모아
보관 칸(live-inv)에 올립니다.

실행:  python pipeline/investors.py           (GitHub Actions investors 작업)
입력:  site/data/latest.json (종목 목록), liveinv/hist.json (지난번까지 받은 날짜별 자료 — 있으면 빠진 날만 받음)
출력:  liveinv/investors.json (화면용), liveinv/hist.json (다음 실행용 저장), liveinv/status.json (진단)

장중에 돌면 오늘 값은 거래소 잠정치(장중 누적)이고, 장 마감 뒤(18시 이후) 다시 받아 확정합니다.
"""
import datetime as dt
import json
import os
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LATEST = os.path.join(ROOT, "site", "data", "latest.json")
OUT = os.environ.get("INV_DIR", os.path.join(ROOT, "liveinv"))
KST = dt.timezone(dt.timedelta(hours=9))
NOW = dt.datetime.now(KST)
TODAY = NOW.strftime("%Y%m%d")
INVS = [("외국인", "f"), ("연기금", "p"), ("기관합계", "i"), ("개인", "r")]
DEADLINE = time.time() + float(os.environ.get("INV_BUDGET_MIN", "14")) * 60
LOG, DIAG = [], {}


def log(m):
    m = f"[{dt.datetime.now(KST).strftime('%H:%M:%S')}] {m}"
    LOG.append(m)
    print(m, flush=True)


def weekdays(n):
    d, out = NOW.date(), []
    if NOW.hour < 9:
        d -= dt.timedelta(days=1)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.strftime("%Y%m%d"))
        d -= dt.timedelta(days=1)
    return out  # 최근 → 과거


def krx_login():
    uid, pw = os.environ.get("KRX_ID"), os.environ.get("KRX_PW")
    if not (uid and pw):
        DIAG["KRX 로그인"] = "아이디 없음 — 로그인 없이 시도"
        return
    try:  # pykrx 1.2.x 는 환경변수로 로그인
        os.environ.setdefault("KRX_USERNAME", uid)
        os.environ.setdefault("KRX_PASSWORD", pw)
        DIAG["KRX 로그인"] = "환경변수 설정"
    except Exception as e:
        DIAG["KRX 로그인"] = f"실패 {e}"


def day_by_investor(stock, d, inv):
    """하루 · 한 투자자 → {code: 순매수대금(억원)} (자료 없으면 None)"""
    out = {}
    for mkt in ("KOSPI", "KOSDAQ"):
        df = None
        for k in range(2):
            try:
                df = stock.get_market_net_purchases_of_equities(d, d, mkt, inv)
                break
            except Exception as e:
                DIAG.setdefault(f"{inv} 오류", f"{type(e).__name__}: {str(e)[:120]}")
                time.sleep(2)
        if df is None or not len(df):
            continue
        col = "순매수거래대금" if "순매수거래대금" in df.columns else df.columns[-1]
        for code, v in df[col].items():
            try:
                out[str(code)[-6:]] = round(float(v) / 1e8, 2)
            except Exception:
                pass
        time.sleep(0.6)
    return out or None


def market_flows(stock, start, end):
    """시장 전체 투자자별 순매수(억원) — 날짜별"""
    res = {}
    for mkt in ("KOSPI", "KOSDAQ"):
        try:
            df = stock.get_market_trading_value_by_date(start, end, mkt, detail=True)
        except Exception as e:
            DIAG[f"시장 {mkt}"] = f"실패 {type(e).__name__}: {str(e)[:120]}"
            continue
        if df is None or not len(df):
            DIAG[f"시장 {mkt}"] = "자료 없음"
            continue
        o = {"d": [i.strftime("%Y%m%d") for i in df.index]}
        for c in df.columns:
            o[str(c)] = [round(float(x) / 1e8, 0) for x in df[c].tolist()]
        res[mkt] = o
        DIAG[f"시장 {mkt}"] = f"{len(df)}일 · 열 {list(df.columns)[:12]}"
        time.sleep(0.6)
    return res


def main():
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    krx_login()
    from pykrx import stock
    stocks = json.load(open(LATEST, encoding="utf-8")).get("stocks", [])
    targets = [s["code"] for s in stocks if s.get("market") in ("KOSPI", "KOSDAQ")]
    try:
        hist = json.load(open(os.path.join(OUT, "hist.json"), encoding="utf-8"))
    except Exception:
        hist = {}
    H = hist.get("days", {})          # {date: {"t": 받은 시각, "f": {code: 억}, "p": ..., "i": ..., "r": ...}}
    log(f"대상 {len(targets)}종목 · 저장된 날 {len(H)}일")
    cand = weekdays(32)
    got, have = 0, 0
    for d in cand:
        if have >= 20:
            break
        done = H.get(d)
        final = bool(done) and (done.get("t", "")[:8] > d or done.get("t", "") >= d + "1800")
        if done and final:
            have += 1
            continue
        if time.time() > DEADLINE:
            log("시간 제한 — 여기까지")
            break
        rec = {"t": NOW.strftime("%Y%m%d%H%M")}
        for inv, k in INVS:
            v = day_by_investor(stock, d, inv)
            if v:
                rec[k] = v
            elif inv == "외국인":
                break     # 외국인부터 없으면 휴장일·아직 공개 전
        if len(rec) == 1:
            DIAG.setdefault("빈 날", []).append(d)
            if done:
                have += 1  # 예전에 받은 잠정치는 그대로 둠
            continue
        H[d] = rec
        got += 1
        have += 1
        log(f"{d} 받음 — 외국인 {len(rec.get('f', {}))} · 연기금 {len(rec.get('p', {}))} · 기관 {len(rec.get('i', {}))} · 개인 {len(rec.get('r', {}))}")
    days = sorted(H)[-20:]
    H = {d: H[d] for d in days}
    if not days:
        json.dump({"time": NOW.strftime("%Y-%m-%d %H:%M"), "msg": "자료 없음", "diag": DIAG, "log": LOG[-40:]},
                  open(os.path.join(OUT, "status.json"), "w", encoding="utf-8"), ensure_ascii=False)
        log("받은 자료 없음")
        return
    mk = market_flows(stock, days[0], max(days[-1], TODAY))
    out = {}
    for c in targets:
        o = {}
        for _, k in INVS:
            arr = [H[d].get(k, {}).get(c) for d in days]
            if any(v is not None for v in arr):
                o[k] = arr
        if o:
            out[c] = o
    partial = days[-1] == TODAY and NOW.hour < 18
    res = {"meta": {"time": NOW.strftime("%Y-%m-%d %H:%M"), "days": days, "partial": partial, "n": len(out), "new_days": got,
                    "elapsed_s": round(time.time() - t0)}, "mkt": mk, "s": out}
    json.dump(res, open(os.path.join(OUT, "investors.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    json.dump({"days": H}, open(os.path.join(OUT, "hist.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    json.dump({"time": NOW.strftime("%Y-%m-%d %H:%M"), "msg": "정상", "n": len(out), "diag": DIAG, "log": LOG[-40:]},
              open(os.path.join(OUT, "status.json"), "w", encoding="utf-8"), ensure_ascii=False)
    log(f"저장 — {len(out)}종목 · {days[0]}~{days[-1]}{' (오늘 잠정)' if partial else ''} · {round(time.time() - t0)}초")


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
