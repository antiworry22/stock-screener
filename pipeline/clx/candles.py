"""
candles.py — 캔들(봉) 패턴 인식 엔진
단일·2봉·3봉 패턴을 벡터 연산으로 탐지하고, 각 패턴에 신뢰도 가중치를 부여한다.
"""
from __future__ import annotations
import numpy as np
import pandas as pd

EPS = 1e-9


def _body(o, c):
    return (c - o).abs()


def _range(h, l):
    return (h - l).replace(0, EPS)


def _upper(h, o, c):
    return h - np.maximum(o, c)


def _lower(o, c, l):
    return np.minimum(o, c) - l


def _is_bull(o, c):
    return c > o


def _is_bear(o, c):
    return c < o


# ────────────────────────────────────────────────────────────
# 단일 봉
# ────────────────────────────────────────────────────────────
def doji(df):
    return (_body(df.open, df.close) / _range(df.high, df.low)) < 0.1


def hammer(df):
    b, r = _body(df.open, df.close), _range(df.high, df.low)
    shape = (r > 2 * b) & (_lower(df.open, df.close, df.low) / r > 0.6) & (_upper(df.high, df.open, df.close) / r < 0.25)
    prior_dn = df.close.shift(1) < df.close.shift(4)   # 하락추세 끝에서만 유효
    return shape & prior_dn


def inverted_hammer(df):
    b, r = _body(df.open, df.close), _range(df.high, df.low)
    return (r > 2 * b) & (_upper(df.high, df.open, df.close) / r > 0.6) & (_lower(df.open, df.close, df.low) / r < 0.25)


def shooting_star(df):
    b, r = _body(df.open, df.close), _range(df.high, df.low)
    return (r > 2 * b) & (_upper(df.high, df.open, df.close) / r > 0.6) & (_lower(df.open, df.close, df.low) / r < 0.25) & _is_bear(df.open, df.close)


def hanging_man(df):
    b, r = _body(df.open, df.close), _range(df.high, df.low)
    shape = (r > 2 * b) & (_lower(df.open, df.close, df.low) / r > 0.6) & (_upper(df.high, df.open, df.close) / r < 0.25)
    prior_up = df.close.shift(1) > df.close.shift(4)   # 상승추세 끝에서만 유효
    return shape & prior_up


def marubozu(df):
    b, r = _body(df.open, df.close), _range(df.high, df.low)
    return (b / r > 0.9) & (b / df.close > 0.01)


def spinning_top(df):
    b, r = _body(df.open, df.close), _range(df.high, df.low)
    return (b / r < 0.3) & (_upper(df.high, df.open, df.close) / r > 0.25) & (_lower(df.open, df.close, df.low) / r > 0.25)


# ────────────────────────────────────────────────────────────
# 2봉
# ────────────────────────────────────────────────────────────
def bullish_engulfing(df):
    o, c = df.open, df.close
    return (_is_bear(o.shift(1), c.shift(1)) & _is_bull(o, c)
            & (o <= c.shift(1)) & (c >= o.shift(1))
            & (_body(o, c) > _body(o.shift(1), c.shift(1)) * 1.05))


def bearish_engulfing(df):
    o, c = df.open, df.close
    return (_is_bull(o.shift(1), c.shift(1)) & _is_bear(o, c)
            & (o >= c.shift(1)) & (c <= o.shift(1))
            & (_body(o, c) > _body(o.shift(1), c.shift(1)) * 1.05))


def bullish_harami(df):
    o, c = df.open, df.close
    return (_is_bear(o.shift(1), c.shift(1)) & _is_bull(o, c)
            & (o > c.shift(1)) & (c < o.shift(1))
            & (_body(o, c) < _body(o.shift(1), c.shift(1)) * 0.6))


def bearish_harami(df):
    o, c = df.open, df.close
    return (_is_bull(o.shift(1), c.shift(1)) & _is_bear(o, c)
            & (o < c.shift(1)) & (c > o.shift(1))
            & (_body(o, c) < _body(o.shift(1), c.shift(1)) * 0.6))


def piercing(df):
    o, c = df.open, df.close
    mid = (o.shift(1) + c.shift(1)) / 2
    return (_is_bear(o.shift(1), c.shift(1)) & _is_bull(o, c)
            & (o < c.shift(1)) & (c > mid) & (c < o.shift(1)))


def dark_cloud(df):
    o, c = df.open, df.close
    mid = (o.shift(1) + c.shift(1)) / 2
    return (_is_bull(o.shift(1), c.shift(1)) & _is_bear(o, c)
            & (o > c.shift(1)) & (c < mid) & (c > o.shift(1)))


def tweezer_bottom(df):
    # [보완] 원본은 '저가가 같다'만 봐서 거의 매일 잡힘 → 하락 끝 + 음봉→양봉 전환일 때만
    same = (df.low - df.low.shift(1)).abs() / _range(df.high, df.low) < 0.1
    flip = _is_bear(df.open.shift(1), df.close.shift(1)) & _is_bull(df.open, df.close)
    return same & flip & (df.close.shift(1) < df.close.shift(5))


def tweezer_top(df):
    same = (df.high - df.high.shift(1)).abs() / _range(df.high, df.low) < 0.1
    flip = _is_bull(df.open.shift(1), df.close.shift(1)) & _is_bear(df.open, df.close)
    return same & flip & (df.close.shift(1) > df.close.shift(5))


# ────────────────────────────────────────────────────────────
# 3봉
# ────────────────────────────────────────────────────────────
def morning_star(df):
    o, c = df.open, df.close
    first_bear = _is_bear(o.shift(2), c.shift(2))
    body_mid = np.maximum(o.shift(1), c.shift(1))
    small_mid = _body(o.shift(1), c.shift(1)) < _body(o.shift(2), c.shift(2)) * 0.5
    return first_bear & small_mid & (body_mid < c.shift(2)) & _is_bull(o, c) & (c > c.shift(2))


def evening_star(df):
    o, c = df.open, df.close
    first_bull = _is_bull(o.shift(2), c.shift(2))
    body_mid = np.minimum(o.shift(1), c.shift(1))
    small_mid = _body(o.shift(1), c.shift(1)) < _body(o.shift(2), c.shift(2)) * 0.5
    return first_bull & small_mid & (body_mid > c.shift(2)) & _is_bear(o, c) & (c < c.shift(2))


def three_white_soldiers(df):
    o, c = df.open, df.close
    up = _is_bull(o, c) & _is_bull(o.shift(1), c.shift(1)) & _is_bull(o.shift(2), c.shift(2))
    rising = (c > c.shift(1)) & (c.shift(1) > c.shift(2))
    solid = (_body(o, c) / _range(df.high, df.low) > 0.6) & \
            (_body(o.shift(1), c.shift(1)) / _range(df.high, df.low) > 0.6)
    return up & rising & solid


def three_black_crows(df):
    o, c = df.open, df.close
    dn = _is_bear(o, c) & _is_bear(o.shift(1), c.shift(1)) & _is_bear(o.shift(2), c.shift(2))
    falling = (c < c.shift(1)) & (c.shift(1) < c.shift(2))
    solid = (_body(o, c) / _range(df.high, df.low) > 0.6) & \
            (_body(o.shift(1), c.shift(1)) / _range(df.high, df.low) > 0.6)
    return dn & falling & solid


def three_line_strike(df):
    o, c = df.open, df.close
    three_dn = _is_bear(o.shift(1), c.shift(1)) & _is_bear(o.shift(2), c.shift(2)) & _is_bear(o.shift(3), c.shift(3))
    return three_dn & _is_bull(o, c) & (c > o.shift(3)) & (o < c.shift(1))


# ────────────────────────────────────────────────────────────
# 갭 계열
# ────────────────────────────────────────────────────────────
def gap_up(df):
    return df.low > df.high.shift(1) * 1.003


def gap_down(df):
    return df.high < df.low.shift(1) * 0.997


# ────────────────────────────────────────────────────────────
# 레지스트리 & 요약
# ────────────────────────────────────────────────────────────
#  (키, 함수, 방향(+1/-1/0), 신뢰도(0~3), 한글명)
PATTERNS = [
    ("doji",                doji,                 0,  1, "도지(망설임)"),
    ("hammer",              hammer,               1,  2, "망치형"),
    ("inverted_hammer",     inverted_hammer,      1,  1, "역망치형"),
    ("shooting_star",       shooting_star,       -1,  2, "유성형(슈팅스타)"),
    ("hanging_man",         hanging_man,         -1,  2, "교수형"),
    ("marubozu",            marubozu,             0,  1, "마루보주"),
    ("spinning_top",        spinning_top,         0,  1, "팽이형"),
    ("bullish_engulfing",   bullish_engulfing,    1,  3, "상승장악형"),
    ("bearish_engulfing",   bearish_engulfing,   -1,  3, "하락장악형"),
    ("bullish_harami",      bullish_harami,       1,  2, "상승잉태형"),
    ("bearish_harami",      bearish_harami,      -1,  2, "하락잉태형"),
    ("piercing",            piercing,             1,  2, "관통형"),
    ("dark_cloud",          dark_cloud,          -1,  2, "흑운형"),
    ("tweezer_bottom",      tweezer_bottom,       1,  1, "쌍바닥(집게)"),
    ("tweezer_top",         tweezer_top,         -1,  1, "쌍봉(집게)"),
    ("morning_star",        morning_star,         1,  3, "샛별형"),
    ("evening_star",        evening_star,        -1,  3, "석별형"),
    ("three_white_soldiers", three_white_soldiers, 1, 3, "적삼병"),
    ("three_black_crows",   three_black_crows,   -1,  3, "흑삼병"),
    ("three_line_strike",   three_line_strike,    1,  2, "삼선반격형"),
    ("gap_up",              gap_up,               1,  1, "갭상승"),
    ("gap_down",            gap_down,            -1,  1, "갭하락"),
]


def detect(df: pd.DataFrame, lookback: int = 5) -> list[dict]:
    """최근 lookback 봉 내에서 발생한 캔들 패턴을 리스트로 반환."""
    hits = []
    df = df.iloc[-(lookback + 12):]  # [속도 개선] 최근 봉만 검사해도 결과 동일 (패턴은 최대 5봉 전까지만 참조)
    n = len(df)
    if n < 4:
        return hits
    for key, fn, direction, weight, name in PATTERNS:
        try:
            sig = fn(df).fillna(False).astype(bool)
        except Exception:
            continue
        recent = sig.iloc[-lookback:]
        if recent.any():
            idx = recent[recent].index[-1]
            pos = df.index.get_loc(idx)
            hits.append({
                "key": key, "name": name, "direction": direction,
                "weight": weight, "bars_ago": n - 1 - pos,
                "price": float(df["close"].iloc[pos]),
            })
    hits.sort(key=lambda x: (x["bars_ago"], -x["weight"]))
    return hits
