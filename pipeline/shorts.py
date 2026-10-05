"""
공매도 — 거래소(KRX)가 발표하는 종목별 공매도 거래(당일 장 마감 뒤)와 공매도 잔고(2거래일 뒤 공개)를 모아 보관 칸(live-short)에 올립니다.

실행:  python pipeline/shorts.py        (GitHub Actions shorts 작업)
출력:  liveshort/shorts.json, liveshort/status.json (어느 경로가 되고 안 되는지 진단 기록)

경로(앞에서부터 시도)
  ① KRX 정보데이터시스템 직접 조회 (전 종목 한 번에) — KRX_ID/KRX_PW 가 있으면 로그인 후 조회
  ② pykrx 라이브러리 (같은 KRX 자료, 로그인 지원 버전)
  ③ 네이버 증권 모바일 API 의 종목별 공매도 (종목마다 조회 — 느림, ①②가 막혔을 때만)
참고: 공매도는 실시간 공개 자료가 없습니다. 거래는 당일 저녁, 잔고는 2거래일 뒤에 공개돼요.
"""
import datetime as dt
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LATEST = os.path.join(ROOT, "site", "data", "latest.json")
OUT = os.environ.get("SHORT_DIR", os.path.join(ROOT, "liveshort"))
KST = dt.timezone(dt.timedelta(hours=9))
NOW = dt.datetime.now(KST)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9", "Referer": "https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201"}
UA_M = {"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "application/json, text/plain, */*", "Referer": "https://m.stock.naver.com/"}
LOG, DIAG = [], {}


def log(m):
    m = f"[{dt.datetime.now(KST).strftime('%H:%M:%S')}] {m}"
    LOG.append(m)
    print(m, flush=True)


def num(x):
    try:
        return float(str(x).replace(",", "").replace("%", "").strip())
    except Exception:
        return None


def biz_days(n=12):
    d, out = NOW.date(), []
    if NOW.hour < 16:  # 오늘 공매도 거래는 장 마감 뒤(오후~저녁)에 공개 — 자료가 없으면 아래에서 건너뜀
        d -= dt.timedelta(days=1)
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.strftime("%Y%m%d"))
        d -= dt.timedelta(days=1)
    return out  # 최근 → 과거


# ── ① KRX 직접 ──
class KRX:
    URL = "https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd"

    def __init__(self):
        self.S = requests.Session()
        self.S.headers.update(UA)
        try:
            self.S.get("https://data.krx.co.kr/contents/MDC/MDI/mdiLoader/index.cmd?menuId=MDC0201", timeout=10)
        except Exception:
            pass
        uid, pw = os.environ.get("KRX_ID"), os.environ.get("KRX_PW")
        if uid and pw:
            try:
                r = self.S.post("https://data.krx.co.kr/contents/MDC/COMS/client/MDCCOMS001D1.cmd",
                                data={"mbrId": uid, "pw": pw, "mbrNm": "", "telNo": "", "di": "", "certType": ""}, timeout=10)
                DIAG["KRX 로그인"] = f"HTTP {r.status_code} {r.text[:120]!r}"
            except Exception as e:
                DIAG["KRX 로그인"] = f"실패 {type(e).__name__}"
        else:
            DIAG["KRX 로그인"] = "아이디 없음(KRX_ID·KRX_PW 비밀값 미설정) — 로그인 없이 시도"

    def q(self, bld, **p):
        r = self.S.post(self.URL, data={"bld": bld, "locale": "ko_KR", **p}, timeout=20)
        if r.status_code != 200:
            raise ValueError(f"HTTP {r.status_code} {r.text[:120]!r}")
        j = r.json()
        rows = j.get("OutBlock_1") or j.get("output") or j.get("block1")
        if rows is None:
            raise ValueError(f"응답 형식 다름: {str(j)[:160]!r}")
        return rows

    def trades(self, d, mkt):  # 전 종목 공매도 거래(하루)
        return self.q("dbms/MDC/STAT/srt/MDCSTAT30101", searchType="1", mktId=mkt, trdDd=d, inqCond="STMFRTSCIFDRFS", share="1", money="1")

    def balance(self, d, mkt):  # 전 종목 공매도 잔고(하루)
        return self.q("dbms/MDC/STAT/srt/MDCSTAT30501", searchType="1", mktId=mkt, trdDd=d, share="1", money="1")


def pick(r, *names):
    for n in names:
        if n in r and r[n] not in (None, "", "-"):
            return r[n]
    return None


def krx_collect(days):
    k = KRX()
    trade, bal = {}, {}
    # 거래: 최근 영업일부터 자료가 나오는 날까지
    tdays = []
    for d in days[:28]:
        rows = []
        for mkt in ("STK", "KSQ"):
            rows += k.trades(d, mkt)
            time.sleep(0.5)
        rows = [r for r in rows if num(pick(r, "CVSRTSELL_TRDVOL", "SRTSELL_TRDVOL")) is not None]
        if not rows:
            continue
        tdays.append(d)
        for r in rows:
            code = str(pick(r, "ISU_SRT_CD", "ISU_CD") or "")[-6:]
            trade.setdefault(code, []).append({"d": d, "sv": num(pick(r, "CVSRTSELL_TRDVOL", "SRTSELL_TRDVOL")),
                                               "sa": num(pick(r, "CVSRTSELL_TRDVAL", "SRTSELL_TRDVAL")),
                                               "tv": num(pick(r, "ACC_TRDVOL")), "w": num(pick(r, "TRDVOL_WT", "SRTSELL_WT"))})
        if len(tdays) >= 20:
            break
    DIAG["KRX 공매도 거래"] = f"{len(tdays)}일 · {len(trade)}종목" if tdays else "자료 없음"
    # 잔고: 2거래일 늦게 공개 → 자료 있는 최근 날 + 5거래일 전
    bdays = []
    for d in days[1:30]:
        rows = []
        for mkt in ("STK", "KSQ"):
            rows += k.balance(d, mkt)
            time.sleep(0.5)
        rows = [r for r in rows if num(pick(r, "BAL_QTY")) is not None]
        if not rows:
            continue
        bdays.append(d)
        for r in rows:
            code = str(pick(r, "ISU_SRT_CD", "ISU_CD") or "")[-6:]
            bal.setdefault(code, []).append({"d": d, "q": num(pick(r, "BAL_QTY")), "a": num(pick(r, "BAL_AMT")), "r": num(pick(r, "BAL_RTO"))})
        if len(bdays) >= 20:
            break
    DIAG["KRX 공매도 잔고"] = f"{len(bdays)}일 · {len(bal)}종목" if bdays else "자료 없음"
    return trade, bal


# ── ② pykrx ──
def pykrx_collect(days):
    from pykrx import stock
    trade, bal = {}, {}
    fv = getattr(stock, "get_shorting_volume_by_ticker", None)
    fb = getattr(stock, "get_shorting_balance_by_ticker", None)
    n = 0
    for d in days[:28]:
        got = False
        for mkt in ("KOSPI", "KOSDAQ"):
            try:
                df = fv(d, mkt)
            except Exception as e:
                DIAG.setdefault("pykrx 거래 오류", f"{type(e).__name__}: {str(e)[:120]}")
                continue
            if df is None or not len(df):
                continue
            got = True
            for code, r in df.iterrows():
                v = r.get("공매도", r.iloc[0])
                tv = r.get("매수", None) if "매수" in r else r.get("거래량", None)
                w = r.get("비중", None)
                trade.setdefault(str(code)[-6:], []).append({"d": d, "sv": num(v), "tv": num(tv), "w": num(w), "sa": None})
        if got:
            n += 1
        if n >= 20:
            break
    DIAG["pykrx 거래"] = f"{n}일 · {len(trade)}종목"
    m = 0
    for d in days[1:30]:
        got = False
        for mkt in ("KOSPI", "KOSDAQ"):
            try:
                df = fb(d, mkt)
            except Exception as e:
                DIAG.setdefault("pykrx 잔고 오류", f"{type(e).__name__}: {str(e)[:120]}")
                continue
            if df is None or not len(df):
                continue
            got = True
            for code, r in df.iterrows():
                bal.setdefault(str(code)[-6:], []).append({"d": d, "q": num(r.get("공매도잔고")), "a": num(r.get("공매도금액")), "r": num(r.get("비중"))})
        if got:
            m += 1
        if m >= 20:
            break
    DIAG["pykrx 잔고"] = f"{m}일 · {len(bal)}종목"
    return trade, bal


# ── ③ 네이버 모바일(종목별) ──
NAVER_PATHS = ["shortSelling", "shortSellings", "short", "shortSale"]


def naver_probe():
    S = requests.Session()
    for p in NAVER_PATHS:
        try:
            r = S.get(f"https://m.stock.naver.com/api/stock/005930/{p}", headers=UA_M, timeout=8)
            DIAG[f"네이버 {p}"] = f"HTTP {r.status_code} {r.text[:200]!r}"
            if r.status_code == 200 and r.text.strip().startswith(("[", "{")):
                return p
        except Exception as e:
            DIAG[f"네이버 {p}"] = f"실패 {type(e).__name__}"
    return None


def main():
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    stocks = json.load(open(LATEST, encoding="utf-8")).get("stocks", [])
    targets = {s["code"]: s for s in stocks if s.get("market") in ("KOSPI", "KOSDAQ")}
    days = biz_days(32)
    log(f"대상 {len(targets)}종목 · 기준 영업일 {days[0]}")
    trade, bal, src = {}, {}, None
    for nm, fn in (("KRX 직접", krx_collect), ("pykrx", pykrx_collect)):
        try:
            trade, bal = fn(days)
            log(f"{nm}: 거래 {len(trade)}종목 · 잔고 {len(bal)}종목")
            if len(trade) >= 100 or len(bal) >= 100:
                src = nm
                break
        except Exception as e:
            DIAG[nm] = f"실패 {type(e).__name__}: {str(e)[:200]}"
            log(f"{nm} 실패: {DIAG[nm]}")
    if not src:
        p = naver_probe()
        log(f"네이버 경로 시험: {p or '없음'}")
    status = {"time": NOW.strftime("%Y-%m-%d %H:%M"), "src": src, "diag": DIAG, "log": LOG[-40:]}
    if not src:
        status["msg"] = "모든 경로 실패 — 진단 기록 확인"
        json.dump(status, open(os.path.join(OUT, "status.json"), "w", encoding="utf-8"), ensure_ascii=False)
        log("저장 안 함")
        return
    out = {}
    for code in targets:
        t = sorted(trade.get(code, []), key=lambda x: x["d"])
        b = sorted(bal.get(code, []), key=lambda x: x["d"])
        if not t and not b:
            continue
        o = {}
        if t:
            last = t[-1]
            o.update({"td": last["d"], "sv": last["sv"], "sa": last.get("sa"), "w": last["w"] if last["w"] is not None else (round(last["sv"] / last["tv"] * 100, 2) if last.get("tv") else None),
                      "w5": round(sum(x["w"] or 0 for x in t[-5:]) / len(t[-5:]), 2) if any(x.get("w") is not None for x in t[-5:]) else None,
                      "w20": round(sum(x["w"] or 0 for x in t[-20:]) / len(t[-20:]), 2) if any(x.get("w") is not None for x in t[-20:]) else None,
                      "sv_h": [x["sv"] for x in t[-20:]], "w_h": [round(x["w"], 2) if x.get("w") is not None else None for x in t[-20:]],
                      "tv_h": [x.get("tv") for x in t[-20:]], "d_h": [x["d"] for x in t[-20:]]})
        if b:
            lb = b[-1]
            fb = b[-6] if len(b) >= 6 else b[0]      # 약 1주(5거래일) 전
            f20 = b[0]                                # 가장 오래된 것(최대 20거래일 전)
            o.update({"bd": lb["d"], "bq": lb["q"], "ba": lb["a"], "br": lb["r"],
                      "br_chg": round((lb["r"] or 0) - (fb["r"] or 0), 3) if lb.get("r") is not None and fb.get("r") is not None and lb is not fb else None,
                      "bq_chg": round(((lb["q"] or 0) / fb["q"] - 1) * 100, 1) if fb.get("q") else None,
                      "br_chg20": round((lb["r"] or 0) - (f20["r"] or 0), 3) if lb.get("r") is not None and f20.get("r") is not None and lb is not f20 else None,
                      "bq_chg20": round(((lb["q"] or 0) / f20["q"] - 1) * 100, 1) if f20.get("q") else None,
                      "bq_h": [x["q"] for x in b[-20:]], "br_h": [round(x["r"], 3) if x.get("r") is not None else None for x in b[-20:]], "bd_h": [x["d"] for x in b[-20:]]})
        out[code] = o
    res = {"meta": {"time": NOW.strftime("%Y-%m-%d %H:%M"), "src": src, "n": len(out), "trade_day": max((v.get("td", "") for v in out.values()), default=""),
                    "bal_day": max((v.get("bd", "") for v in out.values()), default=""), "elapsed_s": round(time.time() - t0)}, "s": out}
    json.dump(res, open(os.path.join(OUT, "shorts.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    status["msg"] = "정상"
    status["n"] = len(out)
    json.dump(status, open(os.path.join(OUT, "status.json"), "w", encoding="utf-8"), ensure_ascii=False)
    log(f"저장 — {len(out)}종목 · 거래 {res['meta']['trade_day']} · 잔고 {res['meta']['bal_day']}")


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
