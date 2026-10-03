# 매매 참고 스크리너

국내 주식 매매 판단에 참고할 데이터를 매일 정리해 보여주는 Netlify 웹앱입니다.
14개 판정 항목 + 보완 5개(환율·금리 게이트, 공매도 잔고, 수정주가, 손절·포지션, 백테스트)를 반영했고,
이용자가 조건을 직접 입력해 부합하는 종목을 뽑아 CSV·PDF로 받을 수 있습니다.

> 공개 데이터를 규칙대로 정리한 참고 자료이며 매매 권유가 아닙니다.

---

## 1. 구조 — 왜 두 부분으로 나뉘나

Netlify는 정적 사이트(HTML/JS)만 올라가고 파이썬(pykrx)은 돌지 않습니다. 그래서

| 부분 | 하는 일 | 실행 위치 |
|---|---|---|
| `pipeline/` (Python) | pykrx·OpenDART·FinanceDataReader·네이버·KIS에서 수집 → 지표 계산 → `site/data/latest.json` 생성 | GitHub Actions(자동) 또는 내 PC |
| `site/` (웹앱) | JSON을 읽어 **브라우저에서** 종합점수·목록·조건검색 계산 | Netlify |

점수는 브라우저에서 계산하므로 가중치·기준값을 바꾸면 재수집 없이 바로 반영됩니다.

```
stock-screener/
├─ site/                    ← Netlify에 올라가는 폴더 (index.html 최상위)
│  ├─ index.html
│  ├─ assets/ app.js · style.css · chart.umd.min.js
│  ├─ config/weights.json        ← 가중치·모드·판정 기준값 (설정파일 분리)
│  ├─ config/us_sector_map.json  ← 섹터별 US 지표 매핑 상수표
│  └─ data/latest.json · backtest.json
├─ pipeline/
│  ├─ collect.py     매일 수집 (메인)
│  ├─ features.py    지표 계산 (RSI·MACD·볼린저·MA·52주·매물대·ATR·매크로 게이트)
│  ├─ scoring.py     종합점수 (app.js와 동일 규칙)
│  ├─ backtest.py    과거 3년 시점화 백테스트
│  └─ make_sample.py 샘플(가상 종목) 생성
├─ .github/workflows/ daily.yml · weekly-backtest.yml
└─ netlify.toml      (GitHub 연동 시 publish = site)
```

---

## 2. 바로 써보기 (샘플 데이터)

`netlify_upload.zip`을 Netlify → **Sites → Add new site → Deploy manually** 화면에 압축 풀지 않고 그대로 끌어다 놓으면 됩니다.
가상 종목 샘플로 모든 화면이 동작합니다(상단에 '샘플 데이터' 표시).

---

## 3. 실제 데이터 자동 갱신 (권장: GitHub + Netlify 연동)

1. GitHub에 새 저장소를 만들고 `stock_screener_project.zip`을 풀어서 전부 올립니다.
2. 저장소 **Settings → Secrets and variables → Actions** 에 키 등록

   | 이름 | 필수 | 발급처 |
   |---|---|---|
   | `KRX_ID`, `KRX_PW` | ✅ | data.krx.co.kr 회원가입 (pykrx 1.2.x부터 로그인 필요) |
   | `DART_API_KEY` | 권장 | opendart.fss.or.kr → 인증키 신청 (실적·재무·공시·국민연금 5%) |
   | `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET` | 선택 | developers.naver.com → 검색 API (뉴스 감정점수) |
   | `KIS_APP_KEY`, `KIS_APP_SECRET` | 선택 | 한국투자증권 KIS Developers (10분·60분봉) |

3. Netlify → **Add new site → Import from Git** → 저장소 선택 (빌드 명령 없음, publish는 netlify.toml이 `site`로 지정)
4. GitHub **Actions** 탭 → `daily-collect` → **Run workflow** 로 첫 수집 실행 (30~60분)
5. 이후 자동 실행: 평일 **06:40**(미국장 마감 직후) · **16:50**(국내 장마감 직후). 결과가 커밋되면 Netlify가 자동 재배포합니다.
6. 백테스트는 매주 일요일 03:00 자동(`weekly-backtest`), 모드를 바꿔 수동 실행도 가능.

### 내 PC에서 돌리기 (GitHub 없이)

```bash
pip install -r pipeline/requirements.txt
set KRX_ID=아이디 & set KRX_PW=비번 & set DART_API_KEY=키     # macOS/Linux는 export
python pipeline/collect.py
```
→ 생성된 `site/data/latest.json`을 웹앱 **설정 → 데이터 파일**에서 불러오거나, `site` 폴더를 다시 zip으로 묶어 Netlify에 올립니다.

---

## 4. 화면 구성

| 탭 | 내용 |
|---|---|
| 대시보드 | 매크로 게이트(환율·금리·나스닥), 미국/국내 지수, **수급 조합 TOP 10 · 진입 화이트리스트+손절가 · 매수 금지 List**, 섹터 강도 |
| 조건검색 | 60여 개 항목(14개 판정 항목 전부 + 점수 + 보완)으로 조건 조합, AND/OR, 빠른 조건 15종, 조건 저장, 정렬, **CSV(엑셀)·인쇄/PDF 리포트** |
| 전체 종목 | 점수표 정렬·검색·CSV |
| 섹터·미국장 | 업종 상대강도, 섹터별 미국장 영향, 매핑 상수표 |
| 백테스트 | 누적수익·CAGR·MDD·승률·손절비율, 코스피 대비 곡선, 월별 수익률, 최근 거래 |
| 설정 | 모드(균형/수급/성장/스윙/안정) · 가중치 슬라이더 · 판정 기준값 · 자본·리스크% · weights.json 내려받기 · 데이터 파일 불러오기 |
| 판정 기준 | 19개 항목의 기준·데이터 소스·반영 위치·연동 상태 |

종목을 누르면 가격 차트(MA5/20/120·볼린저·손절선), 14개 항목 ✓/✗ 체크리스트, 손절가·권장수량 계산기, 최근 공시가 열립니다.

## 5. 종합점수

`종합 = (지표×30 + 수급×25 + 실적/호재×20 + 섹터/미국장×15 + 안정성×10) ÷ 100 × 매크로 배수`

- 각 부문은 0~100점, 데이터가 없는 항목은 해당 부문 만점에서 빠짐(예: 컨센서스 없는 소형주). 부문 전체가 없으면 중립 50.
- 매크로 게이트: 주의 ×0.95 / 경고 ×0.85 (`config/weights.json`의 `macro_gate`)
- 가중치·기준은 `config/weights.json`만 고치면 웹앱·백테스트에 공통 적용. 규칙을 바꿀 땐 `assets/app.js`의 `scoreStock()`과 `pipeline/scoring.py`를 함께 수정하세요.

## 6. 알아둘 한계

- 컨센서스(목표주가)는 네이버 금융 페이지에서 읽어 오므로 페이지 구조가 바뀌면 비게 됩니다.
- 실적 '컨센서스 초과(서프라이즈)'는 무료 소스로 안정적으로 얻기 어려워 YoY 증가율로 판정합니다.
- 분봉(⑫)은 KIS 호출 제한 때문에 후보 상위 60종목만 조회합니다.
- 백테스트는 가격·수급만 과거 시점으로 재현하고, 현재 상장 종목만 쓰므로 생존편향이 있습니다.
- pykrx·KRX 사이트 정책이 바뀌면 수집이 실패할 수 있습니다. 실패 시 Actions 로그와 `latest.json`의 `meta.log_tail`을 확인하세요.
