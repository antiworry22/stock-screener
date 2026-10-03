"""
백테스트 — 과거 3년 '시점화(point-in-time)' 적용
각 리밸런싱일 t에는 t일까지의 데이터만으로 점수를 계산하고, t+1일 시가에 진입합니다.

반영 항목: 거래량·기술 3종·이동평균 지지/저항·52주 위치·매물대(가격 기반) + 외국인/기관 연속 순매수(수급)
          + 손절가(진입가 − ATR×배수) + 보유기간 만료 청산
미반영(과거 시점 데이터 확보가 어려움): 컨센서스·뉴스·공시·재무(→ 해당 점수는 중립 50 처리)
주의: 현재 상장 종목으로 유니버스를 구성하므로 생존편향이 있습니다(상장폐지 종목 제외).

실행:  python pipeline/backtest.py            (기본: 시총 상위 300, 균형 모드)
      BT_MODE=supply BT_UNIVERSE=500 python pipeline/backtest.py
"""
import datetime as dt
import json
import os
import sys
import time

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(__file__))
from features import tech_features, streak, _f  # noqa: E402
from scoring import score_stock  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = os.path.join(ROOT, "site")
CFG = json.load(open(os.path.join(SITE, "config", "weights.json"), encoding="utf-8"))


def run_backtest(prices: dict, flows: dict, bench: pd.Series, cfg: dict, mode: str = "balanced",
                 years: int = 3, rebalance: int = 5, top_n: int = 10, hold: int = 20, min_score: float = None):
    """
    prices: {code: OHLCV DataFrame(수정주가)}, flows: {code: DataFrame[외국인, 기관]} (일별 순매수), bench: 코스피 종가
    반환: 결과 dict (웹앱 백테스트 탭 형식)
    """
    T = cfg["thresholds"]
    W = cfg["modes"][mode]["weights"]
    min_score = min_score if min_score is not None else T["whitelist_min_score"]
    atr_mult = T["atr_mult"]
    dates = bench.index[bench.index >= bench.index[-1] - pd.Timedelta(days=365 * years)]
    dates = [d for d in dates if d in bench.index]

    cash, equity_curve, trades, open_pos = 1.0, [], [], []  # 포지션: dict(code, entry, stop, qty, d_in, n)
    slot = 1.0 / top_n

    for i, d in enumerate(dates):
        # 1) 보유 포지션 손절/만료 체크
        for p in list(open_pos):
            df = prices[p["code"]]
            if d not in df.index:
                continue
            row = df.loc[d]
            p["n"] += 1
            exit_px, why = None, None
            if row["저가"] <= p["stop"]:
                exit_px, why = min(row["시가"], p["stop"]), "손절"
            elif p["n"] >= hold:
                exit_px, why = row["종가"], "기간만료"
            if exit_px:
                cash += p["qty"] * exit_px * (1 - 0.0025)  # 거래세·수수료 근사
                ret = exit_px / p["entry"] - 1
                trades.append({"code": p["code"], "in": str(p["d_in"].date()), "out": str(d.date()),
                               "entry": _f(p["entry"], 0), "exit": _f(exit_px, 0), "ret": _f(ret * 100), "why": why})
                open_pos.remove(p)

        # 2) 리밸런싱일: 점수 계산 → 다음날 시가 진입
        if i % rebalance == 0 and i + 1 < len(dates):
            nd = dates[i + 1]
            held = {p["code"] for p in open_pos}
            cands = []
            for code, df in prices.items():
                if code in held or d not in df.index or nd not in df.index:
                    continue
                hist = df.loc[:d].tail(260)
                if len(hist) < 130:
                    continue
                tf = tech_features(hist, spark_len=1)
                if not tf:
                    continue
                fl = flows.get(code)
                if fl is not None:
                    fh = fl.loc[:d].tail(7)
                    if len(fh):
                        tf["foreign_streak"] = streak(fh["외국인"].tolist())
                        tf["inst_streak"] = streak(fh["기관"].tolist())
                sc = score_stock(tf, cfg, W, 1.0, dart_on=False)
                if sc["total"] >= min_score and tf.get("sr20") == "지지":
                    cands.append((sc["total"], code, tf))
            cands.sort(reverse=True)
            free = top_n - len(open_pos)
            for total, code, tf in cands[:max(0, free)]:
                entry = prices[code].loc[nd]["시가"]
                if entry <= 0:
                    continue
                budget = min(cash, slot * (cash + sum(pp["qty"] * prices[pp["code"]].loc[:d]["종가"].iloc[-1] for pp in open_pos)))
                qty = budget / entry
                if qty <= 0:
                    continue
                cash -= qty * entry * 1.00015
                open_pos.append({"code": code, "entry": entry, "stop": entry - atr_mult * (tf["atr"] or entry * 0.05),
                                 "qty": qty, "d_in": nd, "n": -1})

        # 3) 평가액
        mv = sum(p["qty"] * prices[p["code"]].loc[:d]["종가"].iloc[-1] for p in open_pos)
        equity_curve.append((d, cash + mv))

    eq = pd.Series({d: v for d, v in equity_curve})
    b = bench.loc[eq.index] / bench.loc[eq.index].iloc[0]
    yrs = max((eq.index[-1] - eq.index[0]).days / 365, 0.1)
    cagr = eq.iloc[-1] ** (1 / yrs) - 1
    mdd = (eq / eq.cummax() - 1).min()
    bmdd = (b / b.cummax() - 1).min()
    rets = [t["ret"] for t in trades if t["ret"] is not None]
    monthly = eq.resample("ME").last().pct_change().dropna() * 100
    step = max(1, len(eq) // 250)
    return {
        "meta": {"mode": mode, "mode_label": cfg["modes"][mode]["label"], "years": years, "rebalance_days": rebalance,
                 "top_n": top_n, "hold_days": hold, "min_score": min_score, "atr_mult": atr_mult,
                 "universe": len(prices), "from": str(eq.index[0].date()), "to": str(eq.index[-1].date()),
                 "generated": dt.datetime.now().strftime("%Y-%m-%d %H:%M")},
        "metrics": {"total_ret": _f((eq.iloc[-1] - 1) * 100), "cagr": _f(cagr * 100), "mdd": _f(mdd * 100),
                    "bench_ret": _f((b.iloc[-1] - 1) * 100), "bench_mdd": _f(bmdd * 100),
                    "trades": len(rets), "win_rate": _f(np.mean([r > 0 for r in rets]) * 100 if rets else None),
                    "avg_ret": _f(np.mean(rets) if rets else None),
                    "avg_win": _f(np.mean([r for r in rets if r > 0]) if any(r > 0 for r in rets) else None),
                    "avg_loss": _f(np.mean([r for r in rets if r <= 0]) if any(r <= 0 for r in rets) else None),
                    "stop_rate": _f(np.mean([t["why"] == "손절" for t in trades]) * 100 if trades else None)},
        "curve": {"dates": [str(d.date()) for d in eq.index[::step]],
                  "strategy": [_f(v * 100, 1) for v in eq.values[::step]],
                  "bench": [_f(v * 100, 1) for v in b.values[::step]]},
        "monthly": [{"m": d.strftime("%Y-%m"), "r": _f(v)} for d, v in monthly.items()],
        "trades": trades[-40:],
    }


def main():
    from pykrx import stock
    mode = os.getenv("BT_MODE", "balanced")
    nuni = int(os.getenv("BT_UNIVERSE", "300"))
    today = dt.date.today()
    start = today - dt.timedelta(days=365 * 3 + 420)
    s, e = start.strftime("%Y%m%d"), today.strftime("%Y%m%d")
    bench = stock.get_index_ohlcv(s, e, "1001")["종가"]
    asof = bench.index[-1].strftime("%Y%m%d")
    cap = pd.concat([stock.get_market_cap(asof, market=m) for m in ["KOSPI", "KOSDAQ"]])
    cap = cap[cap.index.str.endswith("0")].sort_values("시가총액", ascending=False).head(nuni)
    prices, flows = {}, {}
    for i, code in enumerate(cap.index):
        try:
            df = stock.get_market_ohlcv(s, e, code, adjusted=True)
            if len(df) > 200:
                prices[code] = df
            fl = stock.get_market_trading_value_by_date(s, e, code)
            flows[code] = pd.DataFrame({"외국인": fl["외국인합계"], "기관": fl["기관합계"]})
        except Exception as ex:
            print("skip", code, ex)
        if i % 50 == 0:
            print(f"{i}/{len(cap)}", flush=True)
        time.sleep(0.2)
    res = run_backtest(prices, flows, bench, CFG, mode=mode)
    out = os.path.join(SITE, "data", "backtest.json")
    json.dump(res, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("저장:", out, res["metrics"])


if __name__ == "__main__":
    main()
