"""
scoring.py — 차트랩 종합 판단 엔진
지표·캔들패턴·차트패턴·지지저항·거래량·다중시간프레임 신호를 하나의 점수(-100~+100)로 융합하고
'공격적' 매매 판단(방향·진입가·손절가·목표가·손익비·무효화 조건)을 산출한다.
"""
from __future__ import annotations
import numpy as np
import pandas as pd

WEIGHTS = {
    "trend": 26,      # 이동평균 정배열/추세
    "momentum": 20,   # RSI/MACD/스토캐스틱
    "volume": 16,     # 거래량·자금흐름
    "structure": 20,  # 지지저항 위치·돌파
    "patterns": 12,   # 캔들·차트패턴
    "mtf": 6,         # 다중시간프레임 정합
}


def _clip(x, lo=-1.0, hi=1.0):
    return float(max(lo, min(hi, x)))


# ────────────────────────────────────────────────────────────
# 개별 축 점수
# ────────────────────────────────────────────────────────────
def axis_trend(d):
    last = d.iloc[-1]
    c = last["close"]
    s, notes = 0.0, []
    order = ["ma5", "ma10", "ma20", "ma60", "ma120", "ma200"]
    vals = [last.get(k, np.nan) for k in order]
    vals = [v for v in vals if not pd.isna(v)]
    if len(vals) >= 3:
        if all(vals[i] > vals[i + 1] for i in range(len(vals) - 1)):
            s += 0.6
            notes.append("이동평균 완전 정배열")
        elif all(vals[i] < vals[i + 1] for i in range(len(vals) - 1)):
            s -= 0.6
            notes.append("이동평균 완전 역배열")
    for n in (20, 60, 200):
        ma = last.get(f"ma{n}", np.nan)
        if not pd.isna(ma):
            s += 0.15 if c > ma else -0.15
    ma200 = last.get("ma200", np.nan)
    if not pd.isna(ma200):
        s += 0.2 if c > ma200 else -0.2
        notes.append("장기선 상단" if c > ma200 else "장기선 하단")
    # 기울기
    if len(d) > 21:
        ma20_now, ma20_prev = d["ma20"].iloc[-1], d["ma20"].iloc[-21]
        if not pd.isna(ma20_prev):
            s += 0.15 if ma20_now > ma20_prev else -0.15
            notes.append("20선 상향" if ma20_now > ma20_prev else "20선 하향")
    adx = last.get("adx14", np.nan)
    if not pd.isna(adx):
        if adx > 25:
            notes.append(f"추세 강도 강함(ADX {adx:.0f})")
        elif adx < 20:
            notes.append(f"추세 약함·횡보(ADX {adx:.0f})")
    return _clip(s), notes


def axis_momentum(d):
    last = d.iloc[-1]
    s, notes = 0.0, []
    r = last.get("rsi14", float("nan"))
    if not pd.isna(r):
        if r >= 70:
            s -= 0.25
            notes.append(f"RSI 과매수({r:.0f})")
        elif r <= 30:
            s += 0.25
            notes.append(f"RSI 과매도({r:.0f})")
        elif 50 <= r < 70:
            s += 0.2
            notes.append(f"RSI 강세권({r:.0f})")
        elif 30 < r < 50:
            s -= 0.2
            notes.append(f"RSI 약세권({r:.0f})")
    hist = d["macd_hist"].dropna()
    if len(hist) >= 3:
        if hist.iloc[-1] > 0 and hist.iloc[-1] > hist.iloc[-2]:
            s += 0.3
            notes.append("MACD 상승 확대")
        elif hist.iloc[-1] < 0 and hist.iloc[-1] < hist.iloc[-2]:
            s -= 0.3
            notes.append("MACD 하락 확대")
        if (hist.iloc[-3] < 0) and (hist.iloc[-1] > 0):
            s += 0.2
            notes.append("MACD 골든크로스")
        if (hist.iloc[-3] > 0) and (hist.iloc[-1] < 0):
            s -= 0.2
            notes.append("MACD 데드크로스")
    k = last.get("stoch_k", float("nan"))
    d_ = last.get("stoch_d", float("nan"))
    if not pd.isna(k) and not pd.isna(d_):
        if k < 20 and k > d_:
            s += 0.2
            notes.append("스토캐스틱 과매도 반등")
        elif k > 80 and k < d_:
            s -= 0.2
            notes.append("스토캐스틱 과매수 반락")
    return _clip(s), notes


def axis_volume(d):
    last = d.iloc[-1]
    s, notes = 0.0, []
    vr = last.get("vol_ratio", np.nan)
    chg = d["close"].pct_change().iloc[-1]
    if not pd.isna(vr):
        if vr > 1.5 and chg > 0:
            s += 0.4
            notes.append(f"상승 + 거래량 {vr:.1f}배 급증(매수세)")
        elif vr > 1.5 and chg < 0:
            s -= 0.4
            notes.append(f"하락 + 거래량 {vr:.1f}배 급증(매도세)")
        elif vr < 0.6:
            notes.append("거래량 위축")
    cmf = last.get("cmf20", np.nan)
    if not pd.isna(cmf):
        s += 0.3 if cmf > 0.05 else (-0.3 if cmf < -0.05 else 0)
        notes.append("자금 유입" if cmf > 0.05 else ("자금 유출" if cmf < -0.05 else "자금 중립"))
    # OBV 다이버전스
    obv = d["obv"].dropna()
    if len(obv) > 20:
        price_up = d["close"].iloc[-1] > d["close"].iloc[-20]
        obv_up = obv.iloc[-1] > obv.iloc[-20]
        if price_up and not obv_up:
            s -= 0.3
            notes.append("OBV 약세 다이버전스(상승 미확인)")
        elif (not price_up) and obv_up:
            s += 0.3
            notes.append("OBV 강세 다이버전스(매집 신호)")
    return _clip(s), notes


def axis_structure(d, sr, price):
    s, notes = 0.0, []
    res = sr.get("resistance", [])
    sup = sr.get("support", [])
    if res:
        nr = res[0]["price"]
        dist = (nr - price) / price * 100
        if dist < 2:
            s -= 0.3
            notes.append(f"직상방 저항 {nr:,.0f} ({dist:.1f}% 거리) — 돌파 여부 주시")
        else:
            s += 0.15
            notes.append(f"저항까지 여유 {dist:.1f}%")
    if sup:
        ns = sup[0]["price"]
        dist = (price - ns) / price * 100
        if dist < 2:
            notes.append(f"직하방 지지 {ns:,.0f} ({dist:.1f}%) — 방어선")
        else:
            notes.append(f"지지까지 여유 {dist:.1f}%")
    if res and sup:
        hi, lo = res[0]["price"], sup[0]["price"]
        pos = (price - lo) / (hi - lo) if hi > lo else 0.5
        s += _clip((pos - 0.5) * 0.6)
        notes.append(f"레인지 내 위치 {pos*100:.0f}%")
    return _clip(s), notes


def axis_patterns(candle_hits, chart_hits):
    s, notes = 0.0, []
    for h in candle_hits[:4]:
        decay = 0.6 ** h["bars_ago"]
        s += h["direction"] * (h["weight"] / 3) * 0.35 * decay
        if h["bars_ago"] <= 1 and h["direction"] != 0:
            notes.append(f"{h['name']}({'상승' if h['direction']>0 else '하락'})")
    for c in chart_hits:
        # [보완] 가이드 5장: 넥라인·돌파선 돌파가 확인된 패턴만 온전히 반영, 미확인은 절반
        k = 0.5 if c.get("confirmed") is False else 1.0
        s += c["direction"] * (c["weight"] / 3) * 0.5 * k
        if c["direction"] != 0:
            notes.append(c["name"])
        else:
            notes.append(c["name"])
    return _clip(s), notes


def axis_mtf(weekly_score):
    if weekly_score is None:
        return 0.0, []
    v = _clip(weekly_score / 60.0)
    tag = "주봉 상승 정합" if v > 0.2 else ("주봉 하락 정합" if v < -0.2 else "주봉 중립")
    return v, [tag]


# ────────────────────────────────────────────────────────────
# 종합 점수
# ────────────────────────────────────────────────────────────
def verdict_of(score):
    if score >= 55:
        return "강력 매수", "적극 비중 확대 — 추세·수급·구조 3박자 정렬"
    if score >= 28:
        return "매수 우위", "분할 진입 — 눌림목 대기 후 접근"
    if score >= 8:
        return "약한 매수", "소량 시험 진입 또는 관망"
    if score > -8:
        return "중립·관망", "방향성 부재 — 돌파/이탈 확인 후 대응"
    if score > -28:
        return "약한 매도", "비중 축소 — 반등 시 정리"
    if score > -55:
        return "매도 우위", "보유분 정리 — 반등은 매도 기회"
    return "강력 매도", "전량 정리·신규 진입 금지 — 하락 추세"


def analyze(df: pd.DataFrame, candle_hits, chart_hits, sr, weekly_score=None) -> dict:
    d = df
    price = float(d["close"].iloc[-1])
    atr = float(d["atr14"].iloc[-1]) if not pd.isna(d["atr14"].iloc[-1]) else price * 0.03

    ax = {}
    ax["trend"], n_t = axis_trend(d)
    ax["momentum"], n_m = axis_momentum(d)
    ax["volume"], n_v = axis_volume(d)
    ax["structure"], n_s = axis_structure(d, sr, price)
    ax["patterns"], n_p = axis_patterns(candle_hits, chart_hits)
    ax["mtf"], n_mtf = axis_mtf(weekly_score)

    total = sum(ax[k] * WEIGHTS[k] for k in WEIGHTS)  # -100 ~ +100
    total = round(total, 1)
    verdict, action = verdict_of(total)

    # ── 매매 계획 ──
    res = sr.get("resistance", [])
    sup = sr.get("support", [])
    if total >= 0:
        entry = price
        # [보완] 가이드 9장: '지지 하단 −0.5%'와 '진입가 − 2×ATR' 중 더 가까운 쪽 (원본 코드는 더 먼 쪽을 골랐음)
        #        단, 하루 흔들림에 털리지 않게 최소 1×ATR 거리는 확보
        stop = max(price - 2.0 * atr, sup[0]["price"] * 0.995) if sup else price - 2.0 * atr
        stop = min(stop, price - 1.0 * atr)
        # 목표가는 최소 2×ATR 이상 확보(근접 저항은 '돌파 시' 확장 목표로 대체)
        t1_cand = res[0]["price"] if res else price + 2 * atr
        target1 = max(t1_cand, entry + 2.0 * atr)
        # [보완] 바로 위 저항이 아주 멀면(큰 하락 뒤) 손익비가 비현실적으로 커짐 → 목표1은 최대 6×ATR
        target1 = min(target1, entry + 6.0 * atr)
        target2 = max(res[1]["price"] if len(res) > 1 else entry + 4 * atr, target1 + 2.0 * atr)
        target2 = min(target2, entry + 10.0 * atr)
    else:
        entry = price
        stop = min(price + 2.0 * atr, res[0]["price"] * 1.005) if res else price + 2.0 * atr
        stop = max(stop, price + 1.0 * atr)
        t1_cand = sup[0]["price"] if sup else price - 2 * atr
        target1 = max(min(t1_cand, entry - 2.0 * atr), entry - 6.0 * atr)
        target2 = max(min(sup[1]["price"] if len(sup) > 1 else entry - 4 * atr, target1 - 2.0 * atr), entry - 10.0 * atr)

    risk = abs(entry - stop)
    reward = abs(target1 - entry)
    rr = round(reward / risk, 2) if risk > 0 else 0.0

    # 포지션 사이즈: 계좌 리스크 1% 기준, 손절 도달 시 -1% 손실이 되는 비중(%)
    pos_size_pct = round(min(50.0, 100.0 / (risk / entry * 100)), 1) if risk > 0 else 0.0

    invalidation = []
    if total >= 0:
        if sup:
            invalidation.append(f"종가가 지지 {sup[0]['price']:,.0f} 하향 이탈 시 상승 시나리오 무효")
        invalidation.append("거래량 없는 반등 + MACD 데드크로스 전환 시 청산")
    else:
        if res:
            invalidation.append(f"종가가 저항 {res[0]['price']:,.0f} 상향 돌파 시 하락 시나리오 무효")
        invalidation.append("거래량 동반 반등 시 숏/관망 전환")

    # ── 진입 전 5초 체크리스트 (가이드 14장) ──
    last = d.iloc[-1]
    ma200 = last.get("ma200", np.nan)
    vr = last.get("vol_ratio", np.nan)
    chg = float(d["close"].pct_change().iloc[-1])
    near_res = bool(res) and (res[0]["price"] - price) / price * 100 < 2
    bull_pat = [c for c in chart_hits if c["direction"] > 0] + [h for h in candle_hits if h["direction"] > 0 and h["bars_ago"] <= 2]
    bear_pat = [c for c in chart_hits if c["direction"] < 0] + [h for h in candle_hits if h["direction"] < 0 and h["bars_ago"] <= 2]
    checklist = [
        {"q": "주봉과 일봉 추세가 같은 (상승) 방향인가?", "req": True,
         "ok": weekly_score is not None and weekly_score > 0 and ax["trend"] > 0.1},  # [보완] 매수 체크리스트 — 둘 다 하락인 경우는 통과 아님
        {"q": "지지선이 명확하고 현재가가 지지 위인가?", "req": True, "ok": bool(sup) and price > sup[0]["price"]},
        {"q": "손익비가 1.5 : 1 이상인가?", "req": True, "ok": rr >= 1.5},
        {"q": "거래량이 방향을 확인해주는가?", "req": False, "ok": ax["volume"] > 0.1},
        {"q": "캔들/구조 패턴이 방향과 일치하는가?", "req": False, "ok": len(bull_pat) > len(bear_pat)},
        {"q": "종합 점수가 +28 이상인가?", "req": False, "ok": total >= 28},
    ]
    yes = sum(1 for c in checklist if c["ok"])
    ck_pass = all(c["ok"] for c in checklist if c["req"]) and yes >= 4

    # ── 공격적 실전 10계명 위반 경고 ──
    warn = []
    if not pd.isna(ma200) and price < ma200:
        warn.append("① 200일선 아래 — 점수가 좋아도 비중을 줄이세요")
    if weekly_score is not None and weekly_score < 0 < total:
        warn.append("② 주봉은 하락인데 일봉만 반등 — 역행 매매(반등은 매도 기회로만)")
    if near_res and total > 0:
        warn.append(f"③ 바로 위 저항 {res[0]['price']:,.0f}(2% 이내) — 쫓지 말고 돌파+거래량 확인 후")
    brk = next((c for c in chart_hits if c["key"] == "breakout_high"), None)
    if brk and not brk.get("confirmed"):
        warn.append("⑤ 거래량 1.5배 미만 돌파 — 가짜 돌파일 수 있어요")
    if 0 < rr < 1.5:
        warn.append(f"⑦ 손익비 {rr} : 1 — 1.5 미만이면 진입하지 않는 것이 원칙")
    obv_note = [n for n in n_v if "다이버전스" in n]
    if obv_note:
        warn.append("⑨ " + obv_note[0])
    if total >= 8 and not ck_pass:
        warn.append("체크리스트 미통과 — 필수 3개(주봉 정합·지지 위·손익비 1.5)를 먼저 확인")
    act = action
    if total >= 8 and rr < 1.5:
        act = action + " · 단, 손익비 1.5 미만 → 지금은 진입 보류(눌림 또는 돌파 대기)"

    return {
        "price": round(price, 2),
        "checklist": checklist, "check_yes": yes, "check_pass": ck_pass, "warnings": warn, "action2": act,
        "score": total,
        "verdict": verdict,
        "action": action,
        "axes": {k: round(v, 3) for k, v in ax.items()},
        "axis_notes": {"trend": n_t, "momentum": n_m, "volume": n_v,
                       "structure": n_s, "patterns": n_p, "mtf": n_mtf},
        "atr": round(atr, 2),
        "atr_pct": round(atr / price * 100, 2),
        "plan": {
            "bias": "LONG" if total >= 0 else "SHORT/AVOID",
            "entry": round(entry, 2), "stop": round(stop, 2),
            "target1": round(target1, 2), "target2": round(target2, 2),
            "risk_reward": rr, "position_size_pct": pos_size_pct,
        },
        "invalidation": invalidation,
    }
