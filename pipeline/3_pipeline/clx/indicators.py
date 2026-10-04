"""
indicators.py — 차트랩(CHARTLAB) 기술적 지표 엔진
외부 TA 라이브러리 없이 pandas/numpy만으로 계산한다.
모든 함수는 pandas Series/DataFrame을 반환하며 NaN은 min_periods 처리로 최소화한다.
"""
from __future__ import annotations
import numpy as np
import pandas as pd


# ────────────────────────────────────────────────────────────
# 1. 이동평균 계열
# ────────────────────────────────────────────────────────────
def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=max(2, n // 3)).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def wma(s: pd.Series, n: int) -> pd.Series:
    # [속도 개선] rolling.apply(파이썬 함수) → 합성곱(같은 결과, 수십 배 빠름)
    w = np.arange(1, n + 1, dtype=float)
    x = s.to_numpy(dtype=float)
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        out[n - 1:] = np.convolve(x, w[::-1], mode="valid") / w.sum()
    return pd.Series(out, index=s.index)


def hull(s: pd.Series, n: int = 21) -> pd.Series:
    return wma(2 * wma(s, n // 2) - wma(s, n), int(np.sqrt(n)))


def vwma(close: pd.Series, vol: pd.Series, n: int = 20) -> pd.Series:
    return (close * vol).rolling(n).sum() / vol.rolling(n).sum()


def donchian(high: pd.Series, low: pd.Series, n: int = 20):
    return high.rolling(n).max(), low.rolling(n).min()


def keltner(high, low, close, n=20, mult=2.0):
    mid = ema(close, n)
    rng = atr(high, low, close, n)
    return mid + mult * rng, mid, mid - mult * rng


# ────────────────────────────────────────────────────────────
# 2. 모멘텀 계열
# ────────────────────────────────────────────────────────────
def rsi(close: pd.Series, n: int = 14) -> pd.Series:
    d = close.diff()
    up = d.clip(lower=0)
    dn = -d.clip(upper=0)
    ru = up.ewm(alpha=1 / n, adjust=False).mean()
    rd = dn.ewm(alpha=1 / n, adjust=False).mean()
    rs = ru / rd.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)


def macd(close: pd.Series, fast=12, slow=26, signal=9):
    line = ema(close, fast) - ema(close, slow)
    sig = ema(line, signal)
    hist = line - sig
    return line, sig, hist


def stochastic(high, low, close, k=14, d=3, smooth=3):
    ll = low.rolling(k).min()
    hh = high.rolling(k).max()
    raw = 100 * (close - ll) / (hh - ll).replace(0, np.nan)
    kk = raw.rolling(smooth).mean()
    dd = kk.rolling(d).mean()
    return kk, dd


def stoch_rsi(close, n=14, k=3, d=3):
    r = rsi(close, n)
    lo, hi = r.rolling(n).min(), r.rolling(n).max()
    sr = 100 * (r - lo) / (hi - lo).replace(0, np.nan)
    kk = sr.rolling(k).mean()
    return kk, kk.rolling(d).mean()


def cci(high, low, close, n=20):
    tp = (high + low + close) / 3
    m = tp.rolling(n).mean()
    md = (tp - m).abs().rolling(n).mean()
    return (tp - m) / (0.015 * md.replace(0, np.nan))


def williams_r(high, low, close, n=14):
    hh = high.rolling(n).max()
    ll = low.rolling(n).min()
    return -100 * (hh - close) / (hh - ll).replace(0, np.nan)


def roc(close, n=10):
    return close.pct_change(n) * 100


def mfi(high, low, close, vol, n=14):
    tp = (high + low + close) / 3
    mf = tp * vol
    sign = tp.diff()
    pos = mf.where(sign > 0, 0).rolling(n).sum()
    neg = mf.where(sign < 0, 0).rolling(n).sum()
    return 100 - 100 / (1 + pos / neg.replace(0, np.nan))


# ────────────────────────────────────────────────────────────
# 3. 변동성 계열
# ────────────────────────────────────────────────────────────
def true_range(high, low, close):
    pc = close.shift(1)
    return pd.concat([(high - low), (high - pc).abs(), (low - pc).abs()], axis=1).max(axis=1)


def atr(high, low, close, n=14):
    return true_range(high, low, close).ewm(alpha=1 / n, adjust=False).mean()


def bollinger(close, n=20, k=2.0):
    mid = sma(close, n)
    sd = close.rolling(n).std()
    return mid + k * sd, mid, mid - k * sd, sd


def bollinger_bandwidth(close, n=20, k=2.0):
    up, mid, lo, _ = bollinger(close, n, k)
    return (up - lo) / mid * 100


def bollinger_pctb(close, n=20, k=2.0):
    up, mid, lo, _ = bollinger(close, n, k)
    return (close - lo) / (up - lo).replace(0, np.nan)


def squeeze(close, n=20):
    """볼린저밴드가 켈트너채널 안으로 수축하면 True (에너지 응축 = 폭발 임박)."""
    up, mid, lo, _ = bollinger(close, n, 2.0)
    ku, km, kl = keltner(close * 1.0, close * 1.0, close, n, 1.5)
    return (up < ku) & (lo > kl)


def historical_vol(close, n=20):
    return close.pct_change().rolling(n).std() * np.sqrt(252) * 100


# ────────────────────────────────────────────────────────────
# 4. 추세 강도 계열
# ────────────────────────────────────────────────────────────
def adx(high, low, close, n=14):
    up_move = high.diff()
    dn_move = -low.diff()
    plus_dm = np.where((up_move > dn_move) & (up_move > 0), up_move, 0.0)
    minus_dm = np.where((dn_move > up_move) & (dn_move > 0), dn_move, 0.0)
    tr = true_range(high, low, close)
    atr_ = tr.ewm(alpha=1 / n, adjust=False).mean()
    pdi = 100 * pd.Series(plus_dm, index=high.index).ewm(alpha=1 / n, adjust=False).mean() / atr_
    mdi = 100 * pd.Series(minus_dm, index=high.index).ewm(alpha=1 / n, adjust=False).mean() / atr_
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    return dx.ewm(alpha=1 / n, adjust=False).mean(), pdi, mdi


# ────────────────────────────────────────────────────────────
# 5. 거래량 계열
# ────────────────────────────────────────────────────────────
def obv(close: pd.Series, vol: pd.Series) -> pd.Series:
    return (np.sign(close.diff().fillna(0)) * vol).cumsum()


def volume_ma(vol, n=20):
    return vol.rolling(n, min_periods=1).mean()


def volume_ratio(vol, n=20):
    return vol / volume_ma(vol, n).replace(0, np.nan)


def cmf(high, low, close, vol, n=20):
    """Chaikin Money Flow — 종가 위치 기반 자금 흐름."""
    mfm = ((close - low) - (high - close)) / (high - low).replace(0, np.nan)
    mfv = mfm * vol
    return mfv.rolling(n).sum() / vol.rolling(n).sum()


def accum_dist(high, low, close, vol):
    mfm = ((close - low) - (high - close)) / (high - low).replace(0, np.nan)
    return (mfm.fillna(0) * vol).cumsum()


def force_index(close, vol, n=13):
    return ema(close.diff() * vol, n)


# ────────────────────────────────────────────────────────────
# 6. 종합 부착 함수
# ────────────────────────────────────────────────────────────
def add_all(df: pd.DataFrame) -> pd.DataFrame:
    """OHLCV(open/high/low/close/volume) DataFrame에 전 지표 컬럼을 부착."""
    d = df.copy()
    c, h, l, v = d["close"], d["high"], d["low"], d["volume"]

    for n in (5, 10, 20, 60, 120, 200):
        d[f"ma{n}"] = sma(c, n)
    for n in (9, 21, 50):
        d[f"ema{n}"] = ema(c, n)
    d["hull21"] = hull(c, 21)
    d["vwma20"] = vwma(c, v, 20)

    d["rsi14"] = rsi(c, 14)
    d["rsi2"] = rsi(c, 2)
    d["macd"], d["macd_sig"], d["macd_hist"] = macd(c)
    d["stoch_k"], d["stoch_d"] = stochastic(h, l, c)
    d["stochrsi_k"], d["stochrsi_d"] = stoch_rsi(c)
    d["cci20"] = cci(h, l, c)
    d["willr14"] = williams_r(h, l, c)
    d["roc10"] = roc(c, 10)
    d["mfi14"] = mfi(h, l, c, v)

    d["bb_up"], d["bb_mid"], d["bb_lo"], d["bb_sd"] = bollinger(c)
    d["bb_bw"] = bollinger_bandwidth(c)
    d["bb_pctb"] = bollinger_pctb(c)
    d["atr14"] = atr(h, l, c)
    d["atr_pct"] = d["atr14"] / c * 100
    d["hv20"] = historical_vol(c)
    d["donchian_up"], d["donchian_lo"] = donchian(h, l, 20)

    d["adx14"], d["pdi"], d["mdi"] = adx(h, l, c)

    d["obv"] = obv(c, v)
    d["vol_ma20"] = volume_ma(v, 20)
    d["vol_ratio"] = volume_ratio(v, 20)
    d["cmf20"] = cmf(h, l, c, v)
    d["force13"] = force_index(c, v)
    return d
