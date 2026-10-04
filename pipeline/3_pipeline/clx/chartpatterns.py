"""
chartpatterns.py — 지지/저항, 추세선, 차트 패턴(가격 구조) 인식 엔진
스윙고점/저점(pivot)을 추출하고, 그 위에서 이중바닥·헤드앤숄더·삼각형·쐐기·깃발·박스 등
구조적 패턴을 탐지한다.
"""
from __future__ import annotations
import numpy as np
import pandas as pd


# ────────────────────────────────────────────────────────────
# 1. 스윙 포인트 (Pivot)
# ────────────────────────────────────────────────────────────
def pivot_flags(df: pd.DataFrame, left: int = 5, right: int = 5):
    """좌우 right봉보다 각각 높은/낮은 봉을 스윙고점/저점으로 표시. ([속도 개선] 중심 rolling 사용, 결과 동일)"""
    h, l = df["high"], df["low"]
    n, win = len(df), left + right + 1
    hmax = h.rolling(win, center=True).max()
    lmin = l.rolling(win, center=True).min()
    ph = (h >= hmax - 1e-9)
    pl = (l <= lmin + 1e-9)
    ok = pd.Series(False, index=df.index)
    ok.iloc[left:n - right] = True
    return (ph & ok), (pl & ok)


def swing_points(df: pd.DataFrame, left: int = 5, right: int = 5) -> list[dict]:
    ph, pl = pivot_flags(df, left, right)
    pts = []
    for idx in df.index[ph]:
        pts.append({"idx": idx, "pos": df.index.get_loc(idx), "price": float(df.loc[idx, "high"]), "type": "H"})
    for idx in df.index[pl]:
        pts.append({"idx": idx, "pos": df.index.get_loc(idx), "price": float(df.loc[idx, "low"]), "type": "L"})
    pts.sort(key=lambda x: x["pos"])
    return pts


# ────────────────────────────────────────────────────────────
# 2. 지지/저항 클러스터
# ────────────────────────────────────────────────────────────
def support_resistance(df: pd.DataFrame, left: int = 5, right: int = 5,
                       tol_pct: float = 1.5, top_n: int = 6,
                       lookback: int = 260) -> dict:
    d = df.iloc[-lookback:]
    pts = swing_points(d, left, right)
    if not pts:
        return {"resistance": [], "support": [], "levels": []}
    price = float(df["close"].iloc[-1])
    # 가격대 클러스터링 (tol_pct% 이내 묶음)
    levels = []
    for p in sorted(pts, key=lambda x: x["price"]):
        placed = False
        for lv in levels:
            if abs(p["price"] - lv["price"]) / lv["price"] * 100 <= tol_pct:
                lv["touches"] += 1
                lv["price"] = (lv["price"] * (lv["touches"] - 1) + p["price"]) / lv["touches"]
                lv["last_pos"] = max(lv["last_pos"], p["pos"])
                placed = True
                break
        if not placed:
            levels.append({"price": p["price"], "touches": 1, "last_pos": p["pos"]})
    # 최근성 가중 점수
    span = max(1, len(d))
    for lv in levels:
        recency = lv["last_pos"] / span
        lv["strength"] = round(lv["touches"] * (0.5 + recency), 2)
    levels.sort(key=lambda x: -x["strength"])
    resistance = sorted([l for l in levels if l["price"] > price * 1.002],
                        key=lambda x: x["price"])[:top_n]
    support = sorted([l for l in levels if l["price"] <= price * 0.998],
                     key=lambda x: -x["price"])[:top_n]
    return {"resistance": resistance, "support": support, "levels": levels}


# ────────────────────────────────────────────────────────────
# 3. 추세선 회귀
# ────────────────────────────────────────────────────────────
def trendline(pts: list[dict], kind: str, span: int):
    sel = [p for p in pts if p["type"] == kind]
    if len(sel) < 2:
        return None
    x = np.array([p["pos"] for p in sel], dtype=float)
    y = np.array([p["price"] for p in sel], dtype=float)
    slope, intercept = np.polyfit(x, y, 1)
    pred = slope * x + intercept
    ss_res = ((y - pred) ** 2).sum()
    ss_tot = ((y - y.mean()) ** 2).sum() + 1e-9
    return {"slope": slope, "intercept": intercept, "r2": 1 - ss_res / ss_tot,
            "at_now": slope * (span - 1) + intercept, "n": len(sel)}


# ────────────────────────────────────────────────────────────
# 4. 차트 패턴 탐지
# ────────────────────────────────────────────────────────────
def _tolerance(a, b, prm=0.05):
    return abs(a - b) / ((abs(a) + abs(b)) / 2 + 1e-9) <= prm


def detect_chart_patterns(df: pd.DataFrame, left: int = 5, right: int = 5,
                          lookback: int = 180, atr: float | None = None) -> list[dict]:
    """구조 패턴 13종 + 가이드 5장의 '측정 목표가(Measured Move)'와 '돌파 확인' 여부.
    [보완] 원본 대비: 삼각형·쐐기 판정식 교정, 이중천장/바닥 최근성 조건, 목표가·확인 여부 추가."""
    d = df.iloc[-lookback:]
    if len(d) < 40:
        return []
    pts = swing_points(d, left, right)
    highs = [p for p in pts if p["type"] == "H"]
    lows = [p for p in pts if p["type"] == "L"]
    price = float(d["close"].iloc[-1])
    span = len(d)
    atr = atr or float((d["high"] - d["low"]).tail(14).mean())
    out = []

    def add(key, name, direction, weight, level, desc, target=None, neckline=None, confirmed=None):
        out.append({"key": key, "name": name, "direction": direction, "weight": weight,
                    "level": float(level) if level is not None else None,
                    "neckline": float(neckline) if neckline is not None else None,
                    "target": float(target) if target is not None else None,
                    "confirmed": bool(confirmed) if confirmed is not None else None, "desc": desc})

    recent = span - 30  # 두 번째 꼭지점이 최근 30봉 안에 있어야 '지금' 유효한 패턴
    w120 = d.iloc[-120:]
    lo120, hi120 = float(w120["low"].min()), float(w120["high"].max())
    rng_pos = lambda p: (p - lo120) / (hi120 - lo120) if hi120 > lo120 else 0.5

    # ---- 이중천장 / 이중바닥 ----  목표 = 넥라인 ∓ (꼭지 − 넥라인)
    if len(highs) >= 2:
        a, b = highs[-2], highs[-1]
        valley = [p for p in lows if a["pos"] < p["pos"] < b["pos"]]
        if _tolerance(a["price"], b["price"], 0.04) and b["pos"] - a["pos"] >= 8 and b["pos"] >= recent and valley:
            top = (a["price"] + b["price"]) / 2
            neck = min(p["price"] for p in valley)
            if top / neck < 1.05 or rng_pos(top) < 0.65:   # [보완] 골이 5% 이상 + 6개월 범위 위쪽에서만 '천장'
                neck = None
        else:
            neck = None
        if neck is not None:
            conf = price < neck
            add("double_top", "이중천장(M자)", -1, 3, top, f"고점 {top:,.0f} 두 번 막힘 · 넥라인 {neck:,.0f}" + (" 이탈(확정)" if conf else " 이탈 시 확정"),
                target=neck - (top - neck), neckline=neck, confirmed=conf)
    if len(lows) >= 2:
        a, b = lows[-2], lows[-1]
        peak = [p for p in highs if a["pos"] < p["pos"] < b["pos"]]
        if _tolerance(a["price"], b["price"], 0.04) and b["pos"] - a["pos"] >= 8 and b["pos"] >= recent and peak:
            bot = (a["price"] + b["price"]) / 2
            neck = max(p["price"] for p in peak)
            if neck / bot < 1.05 or rng_pos(bot) > 0.35:   # [보완] 봉우리 5% 이상 + 6개월 범위 아래쪽에서만 '바닥'
                neck = None
        else:
            neck = None
        if neck is not None:
            conf = price > neck
            add("double_bottom", "이중바닥(W자)", 1, 3, bot, f"저점 {bot:,.0f} 두 번 지지 · 넥라인 {neck:,.0f}" + (" 돌파(확정)" if conf else " 돌파 시 확정"),
                target=neck + (neck - bot), neckline=neck, confirmed=conf)

    # ---- 헤드앤숄더 / 역헤드앤숄더 ----  목표 = 목선 ∓ (머리 − 목선)
    if len(highs) >= 3:
        l_, m_, r_ = highs[-3], highs[-2], highs[-1]
        if (m_["price"] > max(l_["price"], r_["price"]) * 1.02 and _tolerance(l_["price"], r_["price"], 0.06) and r_["pos"] >= recent):
            vs = [p["price"] for p in lows if l_["pos"] < p["pos"] < r_["pos"]]
            neck = min(vs) if vs else min(l_["price"], r_["price"])
            conf = price < neck
            add("head_shoulders", "헤드앤숄더(천장형)", -1, 3, m_["price"], f"머리 {m_['price']:,.0f} · 목선 {neck:,.0f}" + (" 이탈(확정)" if conf else " 이탈 시 하락 반전"),
                target=neck - (m_["price"] - neck), neckline=neck, confirmed=conf)
    if len(lows) >= 3:
        l_, m_, r_ = lows[-3], lows[-2], lows[-1]
        if (m_["price"] < min(l_["price"], r_["price"]) * 0.98 and _tolerance(l_["price"], r_["price"], 0.06) and r_["pos"] >= recent):
            ps = [p["price"] for p in highs if l_["pos"] < p["pos"] < r_["pos"]]
            neck = max(ps) if ps else max(l_["price"], r_["price"])
            conf = price > neck
            add("inverse_head_shoulders", "역헤드앤숄더(바닥형)", 1, 3, m_["price"], f"머리 {m_['price']:,.0f} · 목선 {neck:,.0f}" + (" 돌파(확정)" if conf else " 돌파 시 상승 반전"),
                target=neck + (neck - m_["price"]), neckline=neck, confirmed=conf)

    # ---- 삼각형 / 쐐기 ---- (최근 75% 구간의 스윙 고점·저점 회귀선)
    hl = [p for p in highs if p["pos"] > span * 0.25]
    ll = [p for p in lows if p["pos"] > span * 0.25]
    tl_h = trendline(hl, "H", span) if len(hl) >= 2 else None
    tl_l = trendline(ll, "L", span) if len(ll) >= 2 else None
    if tl_h and tl_l:
        sh, sl = tl_h["slope"], tl_l["slope"]
        x0 = min(hl[0]["pos"], ll[0]["pos"])
        gap_start = (sh * x0 + tl_h["intercept"]) - (sl * x0 + tl_l["intercept"])
        gap_now = tl_h["at_now"] - tl_l["at_now"]
        converging = 0 < gap_now < gap_start * 0.85 and tl_h["r2"] >= 0.5 and tl_l["r2"] >= 0.5 and len(hl) >= 3 and len(ll) >= 3  # [보완] 선이 실제로 잘 맞을 때만
        flat = price * 0.0006  # 하루 0.06% 이하 기울기 = 수평
        width = max(gap_start, 0)
        up_brk, dn_brk = price > tl_h["at_now"], price < tl_l["at_now"]
        if converging:
            if abs(sh) <= flat and sl > flat:
                add("asc_triangle", "상승 삼각형", 1, 2, tl_h["at_now"], "수평 저항 + 올라오는 지지 — 위로 돌파 우세",
                    target=tl_h["at_now"] + width, confirmed=up_brk)
            elif abs(sl) <= flat and sh < -flat:
                add("desc_triangle", "하락 삼각형", -1, 2, tl_l["at_now"], "수평 지지 + 내려오는 저항 — 아래로 이탈 우세",
                    target=tl_l["at_now"] - width, confirmed=dn_brk)
            elif sh < -flat and sl > flat:
                dirn = 1 if up_brk else -1 if dn_brk else 0
                add("sym_triangle", "대칭 삼각형", dirn, 2, (tl_h["at_now"] + tl_l["at_now"]) / 2, "고점은 낮아지고 저점은 높아지는 수렴 — 터지는 방향을 따라감",
                    target=(tl_h["at_now"] + width) if dirn >= 0 else (tl_l["at_now"] - width), confirmed=bool(dirn))
            elif sh > flat and sl > sh:  # 둘 다 오르는데 아래선이 더 가팔라 좁혀짐
                add("rising_wedge", "상승 쐐기", -1, 2, tl_l["at_now"], "오르지만 폭이 좁아짐 — 힘 소진, 하락 반전 경계",
                    target=sl * x0 + tl_l["intercept"], confirmed=dn_brk)
            elif sl < -flat and sh < sl:  # 둘 다 내리는데 위선이 더 가팔라 좁혀짐
                add("falling_wedge", "하락 쐐기", 1, 2, tl_h["at_now"], "내리지만 폭이 좁아짐 — 매도 소진, 상승 반전 경계",
                    target=sh * x0 + tl_h["intercept"], confirmed=up_brk)

    # ---- 박스(레인지) ----  목표 = 박스 높이만큼
    if len(hl) >= 3 and len(ll) >= 3:
        hs = [p["price"] for p in hl[-3:]]
        ls = [p["price"] for p in ll[-3:]]
        if max(hs) / (min(hs) + 1e-9) < 1.03 and max(ls) / (min(ls) + 1e-9) < 1.03:
            top, bot = float(np.mean(hs)), float(np.mean(ls))
            dirn = 1 if price > top else -1 if price < bot else 0
            add("rectangle", "박스권(레인지)", dirn, 2, (top + bot) / 2, f"상단 {top:,.0f} / 하단 {bot:,.0f} 반복" + (" — 위로 돌파" if dirn > 0 else " — 아래로 이탈" if dirn < 0 else ""),
                target=(top + (top - bot)) if dirn >= 0 else (bot - (top - bot)), confirmed=bool(dirn))

    # ---- 깃발 ----  목표 = 깃대 길이만큼 추가
    if len(d) >= 60:
        pole_start, pole_end = float(d["close"].iloc[-40]), float(d["close"].iloc[-20])
        pole = (pole_end - pole_start) / pole_start * 100
        cons = d.iloc[-20:]
        cons_range = (cons["high"].max() - cons["low"].min()) / cons["low"].min() * 100
        if pole > 12 and cons_range < pole * 0.5:
            hi = float(cons["high"].iloc[:-1].max())
            add("bull_flag", "강세 깃발", 1, 2, hi, f"급등 +{pole:.0f}% 후 좁은 쉬기 — 위로 재돌파 대기",
                target=hi + (pole_end - pole_start), confirmed=price > hi)
        elif pole < -12 and cons_range < abs(pole) * 0.5:
            lo = float(cons["low"].iloc[:-1].min())
            add("bear_flag", "약세 깃발", -1, 2, lo, f"급락 {pole:.0f}% 후 좁은 쉬기 — 아래로 재이탈 대기",
                target=lo - (pole_start - pole_end), confirmed=price < lo)

    # ---- 컵앤핸들 ----  목표 = 컵 깊이만큼 상방
    if len(d) >= 120:
        w = d.iloc[-90:]
        left_hi = float(w["high"].iloc[:25].max())
        cup_lo = float(w["low"].iloc[15:70].min())
        right_hi = float(w["high"].iloc[55:80].max())
        handle = w.iloc[-15:]
        depth = left_hi - cup_lo
        if (_tolerance(left_hi, right_hi, 0.06) and 0.12 <= depth / left_hi <= 0.5
                and float(handle["low"].min()) > right_hi - depth / 3 and float(handle["high"].max()) <= right_hi * 1.03):
            rim = max(left_hi, right_hi)
            add("cup_handle", "컵앤핸들", 1, 2, rim, f"U자 컵(깊이 {depth / left_hi * 100:.0f}%) + 짧은 손잡이 — 테두리 {rim:,.0f} 돌파 시 장기 상승",
                target=rim + depth, confirmed=price > rim)

    # ---- 신고가 돌파 / 신저가 이탈 ----  목표 = 현재가 + 돌파폭×2 (최소 2ATR)
    recent_high = float(d["high"].iloc[-61:-1].max())
    recent_low = float(d["low"].iloc[-61:-1].min())
    vr = float(d["vol_ratio"].iloc[-1]) if "vol_ratio" in d.columns and not pd.isna(d["vol_ratio"].iloc[-1]) else None
    if price > recent_high:
        real = vr is None or vr >= 1.5
        add("breakout_high", "신고가 돌파", 1, 3 if real else 1, recent_high,
            f"직전 60봉 고점 {recent_high:,.0f} 돌파" + ("(거래량 동반)" if real else f" — 거래량 {vr:.1f}배로 부족, 가짜 돌파 주의"),
            target=price + max((price - recent_high) * 2, 2 * atr), confirmed=real)
    if price < recent_low:
        add("breakdown_low", "신저가 이탈", -1, 3, recent_low, f"직전 60봉 저점 {recent_low:,.0f} 이탈",
            target=price - max((recent_low - price) * 2, 2 * atr), confirmed=True)
    return out


def slope_label(tl):
    if not tl:
        return "n/a"
    if tl["slope"] > 0:
        return "상승"
    if tl["slope"] < 0:
        return "하락"
    return "수평"
