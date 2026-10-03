"""
지표 계산 모듈 (수집과 분리 — 백테스트·샘플 생성에서도 동일 로직 재사용)

입력 OHLCV DataFrame 컬럼: 시가, 고가, 저가, 종가, 거래량, (선택) 거래대금
반드시 pykrx adjusted=True(수정주가)로 받은 데이터를 넣어야 배당락·액면변경·증자로 인한 지표 왜곡이 없습니다.
"""
import math
import numpy as np
import pandas as pd


def _f(x, nd=2):
    """JSON 저장용 숫자 정리 (NaN/inf → None)"""
    if x is None:
        return None
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    return round(x, nd)


# ───────────── 기본 지표 ─────────────
def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.fillna(100)


def macd(close: pd.Series, fast=12, slow=26, sig=9):
    m = close.ewm(span=fast, adjust=False).mean() - close.ewm(span=slow, adjust=False).mean()
    s = m.ewm(span=sig, adjust=False).mean()
    return m, s


def bollinger(close: pd.Series, n=20, k=2):
    ma = close.rolling(n).mean()
    sd = close.rolling(n).std(ddof=0)
    up, lo = ma + k * sd, ma - k * sd
    pb = (close - lo) / (up - lo)
    return up, ma, lo, pb


def atr(df: pd.DataFrame, n=14) -> pd.Series:
    h, l, c = df["고가"], df["저가"], df["종가"]
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def count_low_tests(low: pd.Series, window=120, band=0.03, gap=5) -> int:
    """최근 6개월(약 120거래일) 저점 부근(+3%)을 몇 번 터치했는지 — 골든래 3회 = 매물대(지지) 확인"""
    s = low.tail(window)
    if len(s) < 20:
        return 0
    floor = s.min()
    touch_idx = np.where(s.values <= floor * (1 + band))[0]
    cnt, last = 0, -999
    for i in touch_idx:
        if i - last >= gap:
            cnt += 1
        last = i
    return cnt


def streak(values) -> int:
    """최근일부터 같은 부호가 연속된 일수. 순매수 연속 +N, 순매도 연속 -N"""
    vals = [v for v in values if v is not None and not (isinstance(v, float) and math.isnan(v))]
    if not vals:
        return 0
    last = vals[-1]
    if last == 0:
        return 0
    sign = 1 if last > 0 else -1
    n = 0
    for v in reversed(vals):
        if (v > 0 and sign > 0) or (v < 0 and sign < 0):
            n += 1
        else:
            break
    return n * sign


# ───────────── 종목 기술 피처 ─────────────
def tech_features(df: pd.DataFrame, spark_len: int = 120) -> dict:
    """일봉 OHLCV → 14개 항목 중 #1 #2 #5 #9 + 리스크관리(ATR) 피처"""
    df = df.dropna(subset=["종가"]).copy()
    df = df[df["종가"] > 0]
    if len(df) < 30:
        return {}
    c, v = df["종가"], df["거래량"]
    tv = df["거래대금"] if "거래대금" in df.columns else c * v

    r = rsi(c)
    m, s = macd(c)
    _, bb_mid, _, pb = bollinger(c)
    a = atr(df)
    ma5, ma20, ma120 = c.rolling(5).mean(), c.rolling(20).mean(), c.rolling(120).mean()

    last = c.iloc[-1]
    prev = c.iloc[-2]
    chg = (last / prev - 1) * 100

    vol_ratio = v.iloc[-1] / v.iloc[-21:-1].mean() if v.iloc[-21:-1].mean() > 0 else None
    tv_ratio = tv.iloc[-1] / tv.iloc[-21:-1].mean() if tv.iloc[-21:-1].mean() > 0 else None

    # MACD 골든크로스 경과일 (시그널 상향 돌파 후 며칠)
    diff = (m - s)
    cross_days = None
    for i in range(1, min(30, len(diff))):
        if diff.iloc[-i] > 0 and diff.iloc[-i - 1] <= 0:
            cross_days = i - 1
            break
    macd_above = bool(diff.iloc[-1] > 0)

    # RSI 과매도 반등: 최근 10일 내 30 이하 찍고 현재 30 위
    rsi_min10 = r.iloc[-10:].min()
    rsi_now = r.iloc[-1]

    # 볼린저: 최근 5일 내 하단(%b<0.05) 접근 후 회복(%b 상승, 0.2 위)
    pb_min5 = pb.iloc[-6:-1].min()
    bb_recover = bool(pb_min5 < 0.05 and pb.iloc[-1] > 0.2) if not math.isnan(pb_min5) else False

    rsi_sig = bool(rsi_now <= 30 or (rsi_min10 <= 30 and rsi_now > 30))
    macd_sig = bool(macd_above and cross_days is not None and cross_days <= 5)
    bb_sig = bool(bb_recover or (pb.iloc[-1] < 0.2 and pb.iloc[-1] > pb.iloc[-2]))
    tech3 = int(rsi_sig) + int(macd_sig) + int(bb_sig)

    def slope(ma):
        if len(ma.dropna()) < 6:
            return None
        return (ma.iloc[-1] / ma.iloc[-6] - 1) * 100

    s5, s20, s120 = slope(ma5), slope(ma20), slope(ma120)
    ma_ok = not any(math.isnan(x) for x in [ma5.iloc[-1], ma20.iloc[-1], ma120.iloc[-1]])
    ma_align = bool(ma_ok and last > ma5.iloc[-1] > ma20.iloc[-1] > ma120.iloc[-1]
                    and (s5 or 0) > 0 and (s20 or 0) > 0 and (s120 or 0) > 0)
    # 지지/저항: 종가가 MA 위 = 지지, MA 아래 + MA 하락 = 저항
    def sr(ma, sl):
        if math.isnan(ma.iloc[-1]):
            return None
        if last >= ma.iloc[-1]:
            return "지지"
        return "저항" if (sl or 0) < 0 else "이탈"

    hi52 = df["고가"].tail(250).max()
    lo52 = df["저가"].tail(250).min()

    ret = lambda n: (last / c.iloc[-n - 1] - 1) * 100 if len(c) > n else None

    return {
        "close": _f(last, 0), "chg": _f(chg), "ret5": _f(ret(5)), "ret20": _f(ret(20)), "ret60": _f(ret(60)),
        "volume": int(v.iloc[-1]), "tvalue": _f(tv.iloc[-1] / 1e8, 1),  # 거래대금(억원)
        "vol_ratio": _f(vol_ratio), "tv_ratio": _f(tv_ratio),
        "rsi": _f(rsi_now, 1), "rsi_min10": _f(rsi_min10, 1),
        "macd": _f(m.iloc[-1], 2), "macd_sig": _f(s.iloc[-1], 2), "macd_cross_days": cross_days, "macd_above": macd_above,
        "bb_pb": _f(pb.iloc[-1], 2), "bb_recover": bb_recover,
        "sig_rsi": rsi_sig, "sig_macd": macd_sig, "sig_bb": bb_sig, "tech3": tech3,
        "ma5": _f(ma5.iloc[-1], 0), "ma20": _f(ma20.iloc[-1], 0), "ma120": _f(ma120.iloc[-1], 0),
        "ma5_slope": _f(s5), "ma20_slope": _f(s20), "ma120_slope": _f(s120),
        "sr5": sr(ma5, s5), "sr20": sr(ma20, s20), "sr120": sr(ma120, s120) if len(ma120.dropna()) else None,
        "ma_align": ma_align,
        "high52": _f(hi52, 0), "low52": _f(lo52, 0), "pos52": _f(last / hi52, 3) if hi52 else None,
        "low_tests": count_low_tests(df["저가"]),
        "atr": _f(a.iloc[-1], 0), "atr_pct": _f(a.iloc[-1] / last * 100),
        "spark": [_f(x, 0) for x in c.tail(spark_len).tolist()],
        "spark_ma120": [_f(x, 0) for x in ma120.tail(spark_len).tolist()],
        "spark_vol": [int(x) for x in v.tail(spark_len).tolist()],
    }


# ───────────── 매크로 게이트 ─────────────
def macro_gate(macro: dict, cfg: dict) -> dict:
    """환율·금리·나스닥 → green/yellow/red. 섹터 반영보다 우선 적용."""
    g = cfg.get("macro_gate", {})
    reasons, level = [], "green"
    fx = macro.get("usdkrw") or {}
    if fx.get("chg1") is not None and fx["chg1"] >= g.get("usdkrw_chg1_red", 0.7):
        level = "red"; reasons.append(f"원/달러 전일 대비 +{fx['chg1']}% 급등")
    elif fx.get("chg20") is not None and fx["chg20"] >= g.get("usdkrw_chg20_yellow", 2.0):
        level = "yellow"; reasons.append(f"원/달러 20일 +{fx['chg20']}% 상승 추세")
    rate = macro.get("us10y") or {}
    if rate.get("chgbp") is not None and rate["chgbp"] >= g.get("us10y_chgbp_red", 10):
        level = "red"; reasons.append(f"미 10년물 +{rate['chgbp']}bp 급등")
    nq = macro.get("nasdaq") or {}
    if nq.get("chg") is not None and nq["chg"] <= g.get("nasdaq_chg_red", -2.0):
        level = "red" if level != "red" else level
        reasons.append(f"나스닥 {nq['chg']}% 급락")
    if not reasons:
        reasons.append("환율·금리 안정 — 정상 매매")
    mult = {"green": 1.0, "yellow": g.get("multiplier_yellow", 0.95), "red": g.get("multiplier_red", 0.85)}[level]
    return {"level": level, "multiplier": mult, "reasons": reasons}


def us_impact(sector_name: str, us_rets: dict, mapping: dict) -> tuple:
    """업종명 → 매핑표 → Σ beta × 미국 전일 수익률(%)"""
    entry = None
    for m in mapping.get("map", []):
        if any(k in (sector_name or "") for k in m["keywords"]):
            entry = m
            break
    if entry is None:
        entry = mapping.get("default", {"us": [], "coupling": "기본"})
    val = 0.0
    for u in entry.get("us", []):
        r = us_rets.get(u["sym"])
        if r is not None:
            val += u["beta"] * r
    return _f(val), entry.get("coupling", "기본"), [u["sym"] for u in entry.get("us", [])]
