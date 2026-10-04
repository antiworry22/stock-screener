"""
engine.py — CHARTLAB 6축 엔진을 스크리너 수집 파이프라인에 연결
  · 입력: pykrx/FinanceDataReader 일봉 DataFrame (시가·고가·저가·종가·거래량, 날짜 인덱스)
  · 출력: (요약 dict → latest.json의 s["cl"]),  (종목 파일 dict → 별도 보관 칸 cl/{code}.json)
원본: chartlab_engine (indicators·candles·chartpatterns·scoring) + 가이드(차트 하나로 전부 판단하는 실전 주식 분석 시스템)
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from . import candles as C
from . import chartpatterns as P
from . import indicators as I
from . import scoring as S

KR_COLS = {"시가": "open", "고가": "high", "저가": "low", "종가": "close", "거래량": "volume",
           "Open": "open", "High": "high", "Low": "low", "Close": "close", "Volume": "volume"}


def _num(x, nd=2):
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    if math.isnan(x) or math.isinf(x):
        return None
    return round(x, nd)


def standardize(df: pd.DataFrame) -> pd.DataFrame:
    d = df.rename(columns=KR_COLS).copy()
    d = d[[c for c in ("open", "high", "low", "close", "volume") if c in d.columns]]
    for c in ("open", "high", "low", "close", "volume"):
        d[c] = pd.to_numeric(d[c], errors="coerce")
    d = d.dropna(subset=["close"])
    d = d[d["close"] > 0]
    # 거래정지일 등 시가·고가·저가 0 → 종가로 메움
    for c in ("open", "high", "low"):
        d.loc[(d[c].isna()) | (d[c] <= 0), c] = d["close"]
    d["volume"] = d["volume"].fillna(0)
    d.index = pd.to_datetime(d.index)
    return d[~d.index.duplicated(keep="last")].sort_index()


def to_weekly(df: pd.DataFrame) -> pd.DataFrame:
    agg = {"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}
    return df.resample("W-FRI").agg(agg).dropna(subset=["close"])


def indicator_snapshot(d: pd.DataFrame) -> dict:
    last = d.iloc[-1]
    keys = ["ma5", "ma10", "ma20", "ma60", "ma120", "ma200", "ema9", "ema21", "ema50", "hull21", "vwma20",
            "rsi14", "rsi2", "macd", "macd_sig", "macd_hist", "stoch_k", "stoch_d", "stochrsi_k", "stochrsi_d",
            "cci20", "willr14", "roc10", "mfi14", "bb_up", "bb_mid", "bb_lo", "bb_pctb", "bb_bw", "atr14", "atr_pct",
            "hv20", "donchian_up", "donchian_lo", "adx14", "pdi", "mdi", "vol_ratio", "cmf20", "force13"]
    out = {k: _num(last.get(k), 4 if k in ("bb_pctb", "cmf20") else 2) for k in keys}
    try:
        sq = I.squeeze(d["close"])
        out["squeeze"] = bool(sq.iloc[-1])
        out["squeeze_days"] = int(sq.iloc[-20:].sum())
    except Exception:
        out["squeeze"] = None
    bw = d["bb_bw"].dropna()
    out["bb_bw_rank"] = _num((bw.iloc[-120:] < bw.iloc[-1]).mean() * 100, 0) if len(bw) > 20 else None
    obv = d["obv"].dropna()
    out["obv_up20"] = bool(obv.iloc[-1] > obv.iloc[-21]) if len(obv) > 21 else None
    out["close"] = _num(last["close"], 2)
    return out


def full_analysis(df: pd.DataFrame) -> dict:
    """df: standardize() 를 거친 일봉. 지표 부착 → 주봉 점수 → 6축 종합 판단."""
    d = I.add_all(df)
    atr = float(d["atr14"].iloc[-1]) if not pd.isna(d["atr14"].iloc[-1]) else float(d["close"].iloc[-1]) * 0.03
    weekly_score = None
    try:
        w = I.add_all(to_weekly(df))
        if len(w) > 30:
            wa = S.analyze(w, C.detect(w, lookback=3), P.detect_chart_patterns(w, lookback=120), P.support_resistance(w), None)
            weekly_score = wa["score"]
    except Exception:
        weekly_score = None
    candle_hits = C.detect(d, lookback=5)
    chart_hits = P.detect_chart_patterns(d, lookback=180, atr=atr)
    sr = P.support_resistance(d)
    r = S.analyze(d, candle_hits, chart_hits, sr, weekly_score)
    r["candle_patterns"] = [{k: (round(v, 2) if isinstance(v, float) else v) for k, v in h.items()} for h in candle_hits]
    r["chart_patterns"] = [{k: (_num(v) if isinstance(v, float) else v) for k, v in c.items()} for c in chart_hits]
    r["support"] = [{"price": _num(l["price"]), "strength": l["strength"], "touches": l["touches"]} for l in sr["support"]]
    r["resistance"] = [{"price": _num(l["price"]), "strength": l["strength"], "touches": l["touches"]} for l in sr["resistance"]]
    r["weekly_score"] = weekly_score
    r["last_date"] = str(d.index[-1].date())
    r["bars"] = len(d)
    r["ind"] = indicator_snapshot(d)
    return r


def clean(o):
    """numpy 자료형 → JSON 저장 가능한 기본형"""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return _num(o, 4)
    if isinstance(o, pd.Timestamp):
        return str(o.date())
    return o


def run(df_raw: pd.DataFrame, keep: int = 400):
    """수집 루프에서 종목마다 호출. 실패하면 (None, None)."""
    df = standardize(df_raw)
    if len(df) < 80:
        return None, None
    r = full_analysis(df)
    ax = r["axes"]
    summary = {
        "s": r["score"], "v": r["verdict"],
        "ax": [ax["trend"], ax["momentum"], ax["volume"], ax["structure"], ax["patterns"], ax["mtf"]],
        "pat": [("+" if c["direction"] > 0 else "-" if c["direction"] < 0 else "=") + c["key"] + ("!" if c.get("confirmed") else "") for c in r["chart_patterns"]],
        "cnd": [("+" if h["direction"] > 0 else "-") + h["key"] for h in r["candle_patterns"] if h["bars_ago"] <= 1 and h["direction"] != 0],
        "rr": r["plan"]["risk_reward"], "ck": r["check_yes"], "ckp": r["check_pass"],
        "w": r["weekly_score"], "pos": r["plan"]["position_size_pct"],
        "stop": _num(r["plan"]["stop"], 0), "t1": _num(r["plan"]["target1"], 0), "t2": _num(r["plan"]["target2"], 0),
        "atrp": r["atr_pct"], "nw": len(r["warnings"]),
    }
    tail = df.iloc[-keep:]
    rnd = lambda s: [None if pd.isna(x) else (int(round(x)) if abs(x) >= 100 else round(float(x), 2)) for x in s]
    file = {"d": [x.strftime("%Y-%m-%d") for x in tail.index], "o": rnd(tail["open"]), "h": rnd(tail["high"]),
            "l": rnd(tail["low"]), "c": rnd(tail["close"]), "v": [int(x) for x in tail["volume"]], "r": r}
    return clean(summary), clean(file)
