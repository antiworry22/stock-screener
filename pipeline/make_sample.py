"""
샘플 데이터 생성기 — 실제 시세가 아닌 '가상 종목'으로 화면 구조를 확인하기 위한 데이터
실데이터는 collect.py 실행으로 교체됩니다.  (python pipeline/make_sample.py)
"""
import datetime as dt
import json
import os
import random
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from features import tech_features, streak, macro_gate, us_impact, _f  # noqa: E402
from backtest import run_backtest  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
CFG = json.load(open(os.path.join(SITE, "config", "weights.json"), encoding="utf-8"))
USMAP = json.load(open(os.path.join(SITE, "config", "us_sector_map.json"), encoding="utf-8"))
rng = np.random.default_rng(7)
random.seed(7)

SECTORS = ["전기·전자", "제약", "금융", "화학", "운송장비·부품", "기계·장비", "철강금속", "건설", "유통", "음식료·담배", "통신", "IT 서비스", "의료·정밀"]
SUFFIX = {"전기·전자": ["반도체", "전자", "테크", "디스플레이"], "제약": ["제약", "바이오", "파마"], "금융": ["금융지주", "증권", "캐피탈"],
          "화학": ["화학", "케미칼", "소재"], "운송장비·부품": ["모터스", "오토", "부품"], "기계·장비": ["기계", "중공업", "로보틱스"],
          "철강금속": ["철강", "메탈"], "건설": ["건설", "E&C"], "유통": ["리테일", "유통"], "음식료·담배": ["푸드", "식품"],
          "통신": ["텔레콤", "네트웍스"], "IT 서비스": ["소프트", "클라우드", "AI"], "의료·정밀": ["메디컬", "정밀"]}
PREFIX = ["가온", "나래", "다솜", "라온", "마루", "바름", "새빛", "아라", "자람", "차오름", "하늘", "누리", "한별", "온새미", "다올",
          "미르", "보람", "슬기", "여울", "윤슬", "이든", "푸르미", "해솔", "가람", "그린", "도담", "로운", "모아", "벼리", "세움"]


def synth_prices(n=400, start=10000, kind="random", sector_drift=0.0):
    mu = {"uptrend": 0.0012, "downtrend": -0.0010, "rebound": -0.0006, "base": 0.0, "random": 0.0002}[kind] + sector_drift
    vol = rng.uniform(0.015, 0.032)
    r = rng.normal(mu, vol, n)
    if kind == "rebound":  # 하락 후 최근 반등
        r[-12:-4] -= 0.012
        r[-4:] += 0.018
    if kind == "base":  # 바닥 다지기 (저점 반복)
        r = rng.normal(0, vol, n)
        r[:120] -= 0.004
    c = start * np.exp(np.cumsum(r))
    if kind == "base":
        floor = c[120:].min()
        c[120:] = np.maximum(c[120:], floor) + (c[120:] - floor) * 0.3
    o = c * (1 + rng.normal(0, vol / 3, n))
    h = np.maximum(o, c) * (1 + np.abs(rng.normal(0, vol / 2, n)))
    l = np.minimum(o, c) * (1 - np.abs(rng.normal(0, vol / 2, n)))
    v = rng.lognormal(12, 0.4, n)
    if kind in ("rebound", "uptrend"):
        v[-1] *= rng.uniform(1.5, 3.2)
    idx = pd.bdate_range(end=dt.date(2026, 10, 2), periods=n)
    return pd.DataFrame({"시가": o, "고가": h, "저가": l, "종가": c, "거래량": v.astype(int)}, index=idx)


def main():
    asof = dt.date(2026, 10, 2)
    macro = {
        "usdkrw": {"v": 1388.5, "chg": 0.21, "chg1": 0.21, "chg20": 1.1, "date": "2026-10-02"},
        "us10y": {"v": 4.12, "chgbp": 3.0, "date": "2026-10-02"},
        "sp500": {"v": 6612.4, "chg": 0.48, "ret5": 1.2, "date": "2026-10-02"},
        "nasdaq": {"v": 22410.8, "chg": 0.92, "ret5": 2.1, "date": "2026-10-02"},
        "sox": {"v": 6120.3, "chg": 1.85, "ret5": 3.9, "date": "2026-10-02"},
        "kospi": {"v": 3412.6, "chg": 0.55, "ret5": 1.4, "date": "2026-10-02"},
        "kosdaq": {"v": 865.2, "chg": -0.18, "ret5": 0.3, "date": "2026-10-02"},
        "us_etf": {"XLF": {"chg": 0.31}, "XLE": {"chg": -0.62}, "XBI": {"chg": 1.12}, "XLY": {"chg": 0.44}},
    }
    us_rets = {"SP500": 0.48, "NASDAQ": 0.92, "SOX": 1.85, "XLF": 0.31, "XLE": -0.62, "XBI": 1.12, "XLY": 0.44}
    gate = macro_gate(macro, CFG)
    kospi5 = 1.4
    sec_ret = {s: _f(rng.normal(1.4, 2.2)) for s in SECTORS}
    sec_ret["전기·전자"] = 4.6
    sec_ret["음식료·담배"] = -0.8
    sectors = []
    for s in SECTORS:
        imp, cp, syms = us_impact(s, us_rets, USMAP)
        sectors.append({"code": "", "name": s, "market": "KOSPI", "ret5": sec_ret[s], "rel5": _f(sec_ret[s] - kospi5),
                        "count": 0, "us_impact": imp, "coupling": cp, "us_syms": syms})

    stocks, prices, flows_bt, used = [], {}, {}, set()
    kinds = ["uptrend"] * 25 + ["rebound"] * 20 + ["base"] * 20 + ["downtrend"] * 20 + ["random"] * 35
    for i, kind in enumerate(kinds):
        sec = SECTORS[i % len(SECTORS)]
        while True:
            name = random.choice(PREFIX) + random.choice(SUFFIX[sec])
            if name not in used:
                used.add(name)
                break
        code = f"S{i + 1:05d}"
        drift = 0.0004 if sec == "전기·전자" else (-0.0002 if sec == "음식료·담배" else 0)
        df = synth_prices(kind=kind, start=float(rng.choice([4000, 12000, 35000, 80000, 210000])), sector_drift=drift)
        prices[code] = df
        tf = tech_features(df, spark_len=120)
        mcap = float(rng.choice([1500, 3800, 9000, 24000, 85000, 320000])) * rng.uniform(0.7, 1.3)
        bias = {"uptrend": 1.2, "rebound": 0.6, "base": 0.3, "downtrend": -1.0, "random": 0}[kind]
        f_daily = rng.normal(bias, 1.2, 7) * mcap * 0.0004
        i_daily = rng.normal(bias * 0.8, 1.2, 7) * mcap * 0.0003
        p_daily = rng.normal(bias * 0.4, 1, 7) * mcap * 0.0001
        flows_bt[code] = pd.DataFrame({"외국인": rng.normal(bias, 1.2, len(df)), "기관": rng.normal(bias * 0.8, 1.2, len(df))}, index=df.index)
        s = {"code": code, "name": name, "market": "KOSPI" if i % 3 else "KOSDAQ", "mcap": _f(mcap, 0), "sector": sec}
        s.update(tf)
        s.update({
            "foreign_streak": streak(f_daily.tolist()), "foreign_net5": _f(f_daily[-5:].sum(), 1),
            "inst_streak": streak(i_daily.tolist()), "inst_net5": _f(i_daily[-5:].sum(), 1),
            "pension_streak": streak(p_daily.tolist()), "pension_net5": _f(p_daily[-5:].sum(), 1),
            "foreign_hold": _f(rng.uniform(2, 55), 1), "exhaustion": _f(rng.uniform(3, 60), 1),
            "short_ratio": _f(rng.uniform(0, 6), 2), "short_chg": _f(rng.normal(0, 0.25), 2),
            "sales_yoy": _f(rng.normal(8 + bias * 10, 18), 1), "op_yoy": _f(rng.normal(10 + bias * 15, 35), 1),
            "op_turn": bool(rng.random() < 0.05),
            "debt_ratio": _f(rng.uniform(20, 260), 1), "current_ratio": _f(rng.uniform(60, 320), 1),
            "ocf": _f(rng.normal(mcap * 0.01 * (1 + bias * 0.3), mcap * 0.01), 1),
            "profit_q": int(rng.choice([4, 4, 4, 3, 2, 1, 0])),
            "roe3": [_f(rng.normal(9 + bias * 3, 5), 1) for _ in range(3)],
            "disc_pos": int(rng.random() < 0.15), "disc_neg": int(rng.random() < 0.06),
            "pension_5pct": bool(rng.random() < 0.05),
            "news_score": _f(np.clip(rng.normal(bias * 0.3, 0.35), -1, 1)), "news_n": int(rng.integers(3, 30)),
        })
        if rng.random() < 0.7:  # 소형주 일부는 컨센서스 없음 (NaN 처리 확인용)
            tgt = tf["close"] * rng.uniform(0.95, 1.6)
            s["target"], s["upside"] = _f(tgt, 0), _f((tgt / tf["close"] - 1) * 100, 1)
        s["earn_date"] = (asof - dt.timedelta(days=int(rng.integers(1, 60)))).strftime("%Y%m%d") if rng.random() < 0.5 else None
        items = []
        if s["disc_pos"]:
            items.append({"date": s["earn_date"] or "20260925", "title": random.choice(["단일판매ㆍ공급계약체결", "자기주식취득결정", "현금ㆍ현물배당결정"]), "tag": "호재", "url": ""})
        if s["disc_neg"]:
            items.append({"date": "20260921", "title": random.choice(["유상증자결정", "전환사채권발행결정"]), "tag": "악재", "url": ""})
        if s["pension_5pct"]:
            items.append({"date": "20260918", "title": "주식등의대량보유상황보고서(국민연금공단)", "tag": "연기금5%", "url": ""})
        s["disclosures"] = items
        s["us_impact"], s["us_coupling"], _ = us_impact(sec, us_rets, USMAP)
        s["sector_rel5"] = _f(sec_ret[sec] - kospi5)
        if i < 30:  # 분봉(KIS) 연동 시 표시 예시
            s["m10_trend"] = random.choice(["상승", "하락"])
            s["m60_trend"] = random.choice(["상승", "하락"])
            s["absorb"] = bool(rng.random() < 0.5)
        stocks.append(s)

    for s in sectors:
        s["count"] = sum(1 for x in stocks if x["sector"] == s["name"])

    data = {"meta": {"asof": str(asof), "generated": dt.datetime.now().strftime("%Y-%m-%d %H:%M"), "sample": True,
                     "universe": len(stocks), "candidates": len(stocks), "dart": True, "news": True, "kis": True,
                     "note": "가상 종목으로 만든 샘플입니다. 종목명·수치는 실제와 무관합니다."},
            "macro": macro, "gate": gate, "us_rets": us_rets, "kospi5": kospi5,
            "sectors": sorted(sectors, key=lambda x: -x["rel5"]), "stocks": stocks}
    os.makedirs(os.path.join(SITE, "data"), exist_ok=True)
    json.dump(data, open(os.path.join(SITE, "data", "latest.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))

    bench = pd.Series(3000 * np.exp(np.cumsum(rng.normal(0.0003, 0.011, 400))), index=prices["S00001"].index)
    sub = dict(list(prices.items())[:80])
    bt = run_backtest(sub, flows_bt, bench, CFG, years=1, top_n=8, hold=15)
    bt["meta"]["sample"] = True
    json.dump(bt, open(os.path.join(SITE, "data", "backtest.json"), "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("샘플 생성:", len(stocks), "종목 / 백테스트", bt["metrics"])


if __name__ == "__main__":
    main()
