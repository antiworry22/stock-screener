"""
섹터·미국장 실시간 — 15분마다
  · 미국: S&P500·나스닥·SOX·업종 ETF·미 10년물·원/달러·VIX·미국 선물(S&P·나스닥) — 야후 파이낸스 차트(일봉, 오늘 봉은 실시간)
  · 국내: 네이버 금융 업종(약 80개) 실시간 등락률 · 상승/하락 종목 수, 종목→업종 연결표(하루 한 번 새로)
출력: livemkt/market.json · livemkt/status.json  → 보관 칸 live-market
"""
import datetime as dt
import json
import os
import re
import sys
import time

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.environ.get("MKT_DIR", os.path.join(ROOT, "livemkt"))
KST = dt.timezone(dt.timedelta(hours=9))
NOW = dt.datetime.now(KST)
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8"}
LOG, DIAG = [], {}
S = requests.Session()
S.headers.update(UA)

YAHOO = {  # 화면 이름 → 야후 기호
    "SP500": "^GSPC", "NASDAQ": "^IXIC", "SOX": "^SOX", "DOW": "^DJI", "VIX": "^VIX",
    "XLF": "XLF", "XLE": "XLE", "XBI": "XBI", "XLY": "XLY", "XLK": "XLK", "SMH": "SMH",
    "US10Y": "^TNX", "USDKRW": "KRW=X", "ES": "ES=F", "NQ": "NQ=F", "KOSPI": "^KS11", "KOSDAQ": "^KQ11",
}


def log(m):
    m = f"[{dt.datetime.now(KST).strftime('%H:%M:%S')}] {m}"
    LOG.append(m)
    print(m, flush=True)


def yahoo(sym):
    last_e = None
    for host in ("query1", "query2"):
        try:
            r = S.get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{requests.utils.quote(sym)}",
                      params={"range": "1mo", "interval": "1d", "includePrePost": "false"}, timeout=(5, 10))
            if r.status_code != 200:
                raise ValueError(f"HTTP {r.status_code}")
            res = r.json()["chart"]["result"][0]
            meta = res["meta"]
            closes = [c for c in (res.get("indicators", {}).get("quote", [{}])[0].get("close") or []) if c is not None]
            ts = res.get("timestamp") or []
            last = meta.get("regularMarketPrice") or (closes[-1] if closes else None)
            # 오늘 봉이 이미 목록에 있으면 그 전 날이 '전일'
            last_day = dt.datetime.fromtimestamp(ts[-1], dt.timezone.utc).date() if ts else None
            mkt_day = dt.datetime.fromtimestamp(meta.get("regularMarketTime", 0), dt.timezone.utc).date()
            prev = closes[-2] if len(closes) >= 2 and last_day == mkt_day else (closes[-1] if closes else None)
            first = closes[0] if closes else None
            t = dt.datetime.fromtimestamp(meta.get("regularMarketTime", 0), KST).strftime("%Y-%m-%d %H:%M")
            return {"v": round(last, 4), "prev": round(prev, 4) if prev else None,
                    "chg": round((last / prev - 1) * 100, 2) if prev else None,
                    "chg20": round((last / first - 1) * 100, 2) if first else None,
                    "t": t, "state": meta.get("marketState") or "", "cur": meta.get("currency")}
        except Exception as e:
            last_e = e
            time.sleep(0.8)
    raise last_e


UA_M = {"User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
        "Accept": "application/json, text/plain, */*", "Accept-Language": "ko-KR,ko;q=0.9", "Referer": "https://m.stock.naver.com/"}


def _num(x):
    try:
        return float(str(x).replace(",", "").replace("%", "").replace("+", "").strip())
    except Exception:
        return None


def _lists(o, out):
    """JSON 안의 '딕셔너리 목록'을 모두 찾음"""
    if isinstance(o, list):
        if o and all(isinstance(x, dict) for x in o[:3]):
            out.append(o)
        for x in o:
            _lists(x, out)
    elif isinstance(o, dict):
        for v in o.values():
            _lists(v, out)
    return out


def _key(d, *subs):
    for k in d:
        kl = k.lower()
        if any(s in kl for s in subs):
            return k
    return None


def _sector_rows(j):
    best = []
    for L in _lists(j, []):
        d = L[0]
        nk = _key(d, "name", "nm")
        rk = _key(d, "changerate", "fluctuationsratio", "ratio", "rate")
        ck = _key(d, "industrycode", "groupno", "no", "code", "id")
        if nk and rk and ck and len(L) > len(best):
            best = [{"no": str(x.get(ck)), "name": str(x.get(nk)).strip(), "chg": _num(x.get(rk)),
                     "n": _num(x.get(_key(x, "total", "count") or "")), "up": _num(x.get(_key(x, "rise", "up") or "")),
                     "down": _num(x.get(_key(x, "fall", "down") or "")), "flat": _num(x.get(_key(x, "steady", "flat", "unchanged") or ""))} for x in L]
    return [r for r in best if r["name"] and r["chg"] is not None]


def naver_sectors():
    # ① 네이버 증권 모바일 업종 API
    for url in ("https://m.stock.naver.com/api/stocks/industry", "https://m.stock.naver.com/api/stocks/industry/list"):
        try:
            r = S.get(url, params={"page": 1, "pageSize": 200}, headers=UA_M, timeout=(5, 12))
            DIAG["업종 API " + url.rsplit("/", 1)[-1]] = f"HTTP {r.status_code} {r.text[:200]!r}"
            if r.status_code == 200:
                rows = _sector_rows(r.json())
                if len(rows) >= 20:
                    DIAG["업종 경로"] = url
                    return rows
        except Exception as e:
            DIAG["업종 API 오류"] = f"{type(e).__name__}: {str(e)[:100]}"
    # ② 새 네이버 금융 페이지 안에 들어 있는 자료(__NEXT_DATA__)
    r = S.get("https://finance.naver.com/sise/sise_group.naver", params={"type": "upjong"}, timeout=(5, 12))
    raw = r.content
    try:
        html = raw.decode("utf-8")
    except UnicodeDecodeError:
        html = raw.decode("euc-kr", errors="ignore")
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if m:
        rows = _sector_rows(json.loads(m.group(1)))
        if len(rows) >= 20:
            DIAG["업종 경로"] = "PC 페이지 내장 자료"
            return rows
        DIAG["PC 내장 자료"] = m.group(1)[:600]
    # ③ 옛 표 형식
    out = []
    for mm in re.finditer(r'sise_group_detail\.naver\?type=upjong&(?:amp;)?no=(\d+)"[^>]*>([^<]+)</a>(.*?)</tr>', html, re.S):
        txt = re.sub(r"<[^>]+>", " ", mm.group(3))
        pm = re.search(r"([+-]?\d+\.\d+)%", txt)
        nums = [int(x) for x in re.findall(r"(?<![\d.])(\d+)(?![\d.%])", txt)]
        row = {"no": mm.group(1), "name": mm.group(2).strip(), "chg": float(pm.group(1)) if pm else None}
        if len(nums) >= 4:
            row.update({"n": nums[0], "up": nums[1], "flat": nums[2], "down": nums[3]})
        out.append(row)
    if len(out) < 20:
        i = html.find("upjong")
        raise ValueError(f"업종 자료를 찾지 못함(길이 {len(html)}) 예: {html[max(0, i - 80):i + 220]!r}")
    return out


def naver_sector_map(secs):
    mp = {}
    # ① 업종별 종목 목록 API
    for s in secs:
        got = 0
        for page in (1, 2, 3):
            try:
                r = S.get(f"https://m.stock.naver.com/api/stocks/industry/{s['no']}", params={"page": page, "pageSize": 100}, headers=UA_M, timeout=(5, 12))
                if r.status_code != 200:
                    DIAG.setdefault("업종 구성 API", f"HTTP {r.status_code} {r.text[:150]!r}")
                    break
                L = [x for x in _lists(r.json(), []) if _key(x[0], "itemcode", "stockcode", "code")]
                items = max(L, key=len) if L else []
                for x in items:
                    c = str(x.get(_key(x, "itemcode", "stockcode", "code")) or "")[-6:]
                    if re.fullmatch(r"\d{6}", c):
                        mp.setdefault(c, s["name"]); got += 1
                if len(items) < 100:
                    break
            except Exception as e:
                DIAG.setdefault("업종 구성 오류", f"{s['name']}: {type(e).__name__}")
                break
            time.sleep(0.15)
        if not got and not mp and secs.index(s) >= 3:
            break  # API가 안 되면 ②로
    if len(mp) >= 500:
        return mp
    # ② 종목별 종합 API의 업종 코드 (느리지만 확실)
    from concurrent.futures import ThreadPoolExecutor
    names = {s["no"]: s["name"] for s in secs}
    try:
        codes = [x["code"] for x in json.load(open(os.path.join(ROOT, "site", "data", "latest.json"), encoding="utf-8"))["stocks"]]
    except Exception:
        codes = []

    def one(c):
        try:
            j = S.get(f"https://m.stock.naver.com/api/stock/{c}/integration", headers=UA_M, timeout=(5, 10)).json()
            ic = str(j.get("industryCode") or "")
            return c, names.get(ic) or (f"업종{ic}" if ic else None)
        except Exception:
            return c, None
    with ThreadPoolExecutor(max_workers=8) as ex:
        for c, nm in ex.map(one, codes):
            if nm:
                mp[c] = nm
    DIAG["업종 연결 방식"] = "종목별 업종 코드"
    return mp


def main():
    os.makedirs(OUT, exist_ok=True)
    t0 = time.time()
    try:
        prev = json.load(open(os.path.join(OUT, "market.json"), encoding="utf-8"))
    except Exception:
        prev = {}
    us, fails = {}, []
    for k, sym in YAHOO.items():
        try:
            us[k] = yahoo(sym)
        except Exception as e:
            fails.append(f"{k}: {type(e).__name__} {str(e)[:60]}")
        time.sleep(0.3)
    DIAG["야후"] = f"{len(us)}/{len(YAHOO)}" + (f" 실패 {fails[:3]}" if fails else "")
    log(DIAG["야후"])
    secs = []
    try:
        secs = naver_sectors()
        DIAG["네이버 업종"] = f"{len(secs)}개"
    except Exception as e:
        DIAG["네이버 업종"] = f"실패 {type(e).__name__}: {str(e)[:150]}"
    log(DIAG["네이버 업종"])
    mp, map_time = prev.get("map") or {}, prev.get("map_time")
    stale = not mp or not map_time or (NOW - dt.datetime.strptime(map_time, "%Y-%m-%d %H:%M").replace(tzinfo=KST)).total_seconds() > 20 * 3600
    if secs and (stale or os.environ.get("FORCE_MAP")):
        new = naver_sector_map(secs)
        if len(new) >= 500:
            mp, map_time = new, NOW.strftime("%Y-%m-%d %H:%M")
        DIAG["업종 구성"] = f"{len(new)}종목 연결"
        log(DIAG["업종 구성"])
    if not us and not secs:
        json.dump({"time": NOW.strftime("%Y-%m-%d %H:%M"), "msg": "모든 경로 실패", "diag": DIAG, "log": LOG},
                  open(os.path.join(OUT, "status.json"), "w", encoding="utf-8"), ensure_ascii=False)
        return
    out = {"meta": {"time": NOW.strftime("%Y-%m-%d %H:%M"), "elapsed_s": round(time.time() - t0)},
           "us": us or prev.get("us", {}), "sectors": secs or prev.get("sectors", []), "map": mp, "map_time": map_time}
    json.dump(out, open(os.path.join(OUT, "market.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    json.dump({"time": NOW.strftime("%Y-%m-%d %H:%M"), "msg": "정상", "diag": DIAG, "log": LOG},
              open(os.path.join(OUT, "status.json"), "w", encoding="utf-8"), ensure_ascii=False)
    log(f"저장 — 미국 {len(us)} · 업종 {len(secs)} · 연결 {len(mp)}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"오류: {type(e).__name__}: {e}")
        try:
            json.dump({"time": NOW.strftime("%Y-%m-%d %H:%M"), "msg": f"오류 {e}", "diag": DIAG, "log": LOG},
                      open(os.path.join(OUT, "status.json"), "w", encoding="utf-8"), ensure_ascii=False)
        except Exception:
            pass
    sys.stdout.flush()
    os._exit(0)
