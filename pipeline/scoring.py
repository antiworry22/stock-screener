"""
종합점수 계산 (웹앱 assets/app.js 의 scoreStock() 과 동일 로직 — 한쪽을 바꾸면 다른 쪽도 맞춰 주세요)
백테스트에서 사용합니다. 화면의 점수는 브라우저에서 설정파일 가중치로 실시간 계산됩니다.
"""
import math


def jsround(x):
    """JS Math.round 과 동일 (파이썬 round 는 은행가 반올림이라 결과가 달라짐)"""
    return math.floor(x + 0.5)


def _band(v, rules, default):
    for cond, pts in rules:
        if cond(v):
            return pts
    return default


def score_stock(s: dict, cfg: dict, weights: dict, gate_mult: float = 1.0, dart_on: bool = True) -> dict:
    T = cfg["thresholds"]
    parts = {}

    def add(group, pts, mx):
        g = parts.setdefault(group, [0, 0])
        g[0] += pts
        g[1] += mx

    g = s.get
    # ── 기술(지표) ──
    if g("vol_ratio") is not None:
        vr, ch = g("vol_ratio"), g("chg") or 0
        add("technical", 20 if (vr >= T["volume_ratio"] and ch > 0) else 12 if (vr >= 1.5 and ch > 0) else 8 if (vr < 0.7 and ch > 0) else 0, 20)
    if g("tech3") is not None:
        add("technical", g("tech3") * 10, 30)
    if g("sr20") is not None:
        add("technical", 25 if g("ma_align") else 15 if (g("sr20") == "지지" and (g("ma20_slope") or 0) > 0) else 8 if g("sr20") == "지지" else 0 if g("sr20") == "저항" else 3, 25)
    if g("pos52") is not None:
        p, lt = g("pos52"), g("low_tests") or 0
        add("technical", 25 if (p < T["pos52_undervalued"] and lt >= T["low_tests"]) else 12 if p < T["pos52_undervalued"] else 18 if (p >= 0.95 and g("ma_align")) else 6, 25)
    if g("rsi") is not None and g("rsi") > T["rsi_overbought"] + 5 and "technical" in parts:
        parts["technical"][0] = max(0, parts["technical"][0] - 10)

    # ── 수급 ──
    def streak_pts(v, full):
        if v is None:
            return None
        n = T["streak_days"]
        return full if v >= n else jsround(full * 0.66) if v >= 3 else jsround(full * 0.33) if v >= 1 else 0 if v <= -n else jsround(full * 0.15)

    for key, full in [("foreign_streak", 30), ("inst_streak", 25)]:
        p = streak_pts(g(key), full)
        if p is not None:
            add("supply", p, full)
    if g("pension_net5") is not None or g("pension_5pct"):
        add("supply", 20 if g("pension_5pct") else 12 if ((g("pension_streak") or 0) >= 3 or (g("pension_net5") or 0) > 0) else 0 if (g("pension_net5") or 0) < 0 else 4, 20)
    if g("exhaustion") is not None:
        add("supply", 0 if g("exhaustion") >= T["exhaustion_limit"] else 10, 10)
    if g("short_ratio") is not None:
        add("supply", 0 if (g("short_chg") or 0) > 0.3 else 4 if g("short_ratio") > 5 else 15, 15)

    # ── 실적·호재 ──
    if g("op_yoy") is not None or g("op_turn"):
        add("earnings", 30 if (g("op_turn") or (g("op_yoy") or 0) >= T["yoy_growth"]) else 15 if (g("op_yoy") or 0) > 0 else 0, 30)
    if g("sales_yoy") is not None:
        add("earnings", 20 if g("sales_yoy") >= T["yoy_growth"] else 10 if g("sales_yoy") > 0 else 0, 20)
    if g("upside") is not None:
        add("earnings", 20 if g("upside") >= T["upside_min"] else 10 if g("upside") >= 15 else 3, 20)
    if g("news_score") is not None:
        add("earnings", jsround((g("news_score") + 1) / 2 * 15), 15)
    if dart_on:
        add("earnings", 0 if (g("disc_neg") or 0) > 0 else 15 if (g("disc_pos") or 0) > 0 else 8, 15)
    roe = g("roe3") or []
    if len(roe) >= 3:
        add("earnings", 10 if all((r or 0) >= T["roe_min"] for r in roe) else 3, 10)

    # ── 섹터·미국장 ──
    if g("sector_rel5") is not None:
        r = g("sector_rel5")
        add("sector", max(0, min(50, 25 + r * 5)), 50)
    if g("us_impact") is not None:
        add("sector", 25 + max(-25, min(25, g("us_impact") * 10)), 50)

    # ── 재무안정성 ──
    if g("debt_ratio") is not None:
        add("stability", 25 if g("debt_ratio") <= T["debt_ratio_max"] else 10 if g("debt_ratio") <= 200 else 0, 25)
    if g("current_ratio") is not None:
        add("stability", 25 if g("current_ratio") >= T["current_ratio_min"] else 10 if g("current_ratio") >= 70 else 0, 25)
    if g("ocf") is not None:
        add("stability", 25 if g("ocf") > 0 else 0, 25)
    if g("profit_q") is not None and dart_on:
        q = g("profit_q")
        add("stability", 25 if q >= 4 else 15 if q == 3 else 5 if q >= 1 else 0, 25)

    subs = {k: (jsround(v[0] / v[1] * 100) if v[1] else None) for k, v in parts.items()}
    for k in ["technical", "supply", "earnings", "sector", "stability"]:
        subs.setdefault(k, None)
    wsum = sum(weights.values()) or 1
    total = sum(weights[k] * (subs[k] if subs[k] is not None else 50) for k in weights) / wsum * gate_mult
    subs["total"] = jsround(total * 10) / 10
    return subs
