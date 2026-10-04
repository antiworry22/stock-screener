"""
시장 뉴스 수집기 — 국내·해외 증시 뉴스를 모아서 '어떤 코스피·코스닥 종목에 영향이 있는지' 연결합니다.

실행:  python pipeline/market_news.py
입력:  site/data/latest.json  (종목 이름·코드·시장 — 코스피/코스닥 종목만 연결 대상)
출력:  site/data/news.json

수집원 (모두 키 불필요)
  · 구글 뉴스 RSS (한국어: 국내 증시·특징주·수주·실적 / 해외 증시·연준·빅테크·유가·관세·환율·지정학)
  · 구글 뉴스 RSS (영어 원문: 월가·엔비디아·연준·유가·한국 증시)
  · 언론사 RSS (연합뉴스 경제·국제, 한국경제 증권, 매일경제 증권)

연결 방법
  1) 기사 제목에 종목 이름(또는 별칭·영문명)이 직접 나오면 → '직접 언급'
  2) 기사에 테마 단어(반도체, 2차전지, 방산, 원전 …)가 나오면 → 그 테마 대표 종목
  3) 유가·금리·환율·전쟁 같은 '원인' 뉴스는 방향(오름/내림)을 읽어
     유리한 업종(+)과 불리한 업종(−)을 함께 표시  예) 유가 급등 → 정유 +, 항공 −
"""
import datetime as dt
import email.utils
import json
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LATEST = os.path.join(ROOT, "site", "data", "latest.json")
OUT = os.path.join(ROOT, "site", "data", "news.json")
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
KST = dt.timezone(dt.timedelta(hours=9))
NOW = dt.datetime.now(KST)
LOG = []


def log(m):
    m = f"[{time.strftime('%H:%M:%S')}] {m}"
    LOG.append(m)
    print(m, flush=True)


# ───────────────────────── 수집 대상 ─────────────────────────
WHEN = "3d" if NOW.weekday() in (0, 6) else "2d"  # 월·일요일엔 주말 뉴스까지
WINDOW_H = 72 if NOW.weekday() in (0, 6) else 48

GN_KO = [  # (지역, 분류, 검색어)
    ("국내", "증시 시황", "코스피 OR 코스닥 마감"),
    ("국내", "증시 시황", "증시 외국인 순매수 OR 기관 순매수"),
    ("국내", "특징주", "특징주"),
    ("국내", "특징주", "상한가 OR 급등주 OR 신고가"),
    ("국내", "수주·계약", "수주 OR 공급계약 OR 단일판매 공시"),
    ("국내", "실적", "영업이익 OR 어닝서프라이즈 OR 잠정실적"),
    ("국내", "정책·규제", "정부 정책 수혜주 OR 밸류업 OR 규제 완화 주가"),
    ("국내", "증권가 전망", "목표주가 상향 OR 투자의견 상향"),
    ("국내", "증권가 전망", "목표주가 하향 OR 투자의견 하향"),
    ("해외", "미국 증시", "뉴욕증시 OR 나스닥 OR S&P500"),
    ("해외", "금리·연준", "연준 OR FOMC OR 미국 금리 OR 미국 국채"),
    ("해외", "빅테크·AI", "엔비디아 OR 애플 OR 테슬라 OR 마이크로소프트 OR 오픈AI"),
    ("해외", "반도체", "TSMC OR 마이크론 OR 브로드컴 OR 미국 반도체"),
    ("해외", "중국", "중국 경기부양 OR 중국 증시 OR 중국 수출"),
    ("해외", "유가·원자재", "국제유가 OR 구리 가격 OR 리튬 가격 OR 금값"),
    ("해외", "관세·무역", "관세 OR 무역협상 OR 수출규제"),
    ("해외", "환율", "원달러 환율 OR 달러 강세 OR 엔화"),
    ("해외", "지정학", "중동 OR 우크라이나 OR 이스라엘 OR 북한 미사일"),
]
GN_EN = [
    ("해외", "미국 증시", "stock market today Wall Street"),
    ("해외", "반도체", "Nvidia OR semiconductor stocks OR chipmakers"),
    ("해외", "금리·연준", "Federal Reserve interest rates"),
    ("해외", "한국 관련", "South Korea stocks OR KOSPI OR \"Samsung Electronics\" OR \"SK Hynix\""),
    ("해외", "유가·원자재", "oil prices OPEC"),
    ("해외", "빅테크·AI", "Tesla OR Apple OR OpenAI OR Microsoft stock"),
]
PRESS = [  # (지역, 이름, 주소)  — 실패해도 무시
    ("국내", "연합뉴스", "https://www.yna.co.kr/rss/economy.xml"),
    ("해외", "연합뉴스", "https://www.yna.co.kr/rss/international.xml"),
    ("국내", "한국경제", "https://www.hankyung.com/feed/finance"),
    ("국내", "매일경제", "https://www.mk.co.kr/rss/50200011/"),
]

# ───────────────────────── 긍정·부정 단어 ─────────────────────────
POS_KO = ["급등", "상승", "강세", "신고가", "최고", "호실적", "흑자", "턴어라운드", "수주", "계약", "공급", "승인", "허가",
          "돌파", "반등", "개선", "증가", "확대", "호조", "수혜", "기대", "상향", "매수", "순매수", "성공", "선정", "특허",
          "협력", "MOU", "인수", "증설", "독점", "출시", "어닝서프라이즈", "서프라이즈", "역대", "회복", "훈풍", "랠리", "급증", "최대", "수출 계약", "수출 호조", "실적 개선"]
NEG_KO = ["급락", "하락", "약세", "신저가", "적자", "부진", "감소", "축소", "우려", "악재", "쇼크", "하향", "매도", "순매도",
          "취소", "중단", "실패", "소송", "리콜", "제재", "조사", "압수수색", "횡령", "배임", "유상증자", "전환사채", "감자",
          "상장폐지", "거래정지", "파업", "경고", "논란", "부담", "둔화", "충격", "폭락", "어닝쇼크", "적발", "규제", "관세", "공세", "잠식", "추격", "이탈"]
POS_EN = ["surge", "soar", "jump", "rally", "beat", "beats", "record", "gain", "gains", "upgrade", "rise", "rises", "boost",
          "strong", "wins", "approve", "approval", "deal", "growth", "rebound", "climb", "higher", "tops", "bullish", "outperform"]
NEG_EN = ["plunge", "fall", "falls", "drop", "drops", "slump", "miss", "misses", "downgrade", "tariff", "tariffs", "lawsuit",
          "recall", "ban", "probe", "weak", "loss", "crash", "slide", "tumble", "fears", "concern", "selloff", "sell-off",
          "lower", "warns", "warning", "delay", "halt", "bearish", "slowdown", "recession", "dump", "dumps", "outflow", "outflows", "profit-taking", "worst"]


def _en_has(words, low):
    return [w for w in words if re.search(r"\b" + re.escape(w) + r"\b", low)]


def tone_of(title, lang):
    if lang == "en":
        low = title.lower()
        p, n = _en_has(POS_EN, low), _en_has(NEG_EN, low)
    else:
        p = [w for w in POS_KO if w in title]
        n = [w for w in NEG_KO if w in title]
    t = 1 if len(p) > len(n) else -1 if len(n) > len(p) else 0
    return t, (p + n)[:4]


# ───────────────────────── 원인(드라이버): 방향을 읽는 뉴스 ─────────────────────────
DRIVERS = {
    "유가": {"ko": ["유가", "원유", "WTI", "브렌트", "OPEC", "석유값"], "en": ["oil", "crude", "opec", "brent", "wti"],
             "rules": [],
             "up": ["상승", "급등", "올라", "오름", "치솟", "최고", "강세", "반등", "surge", "jump", "rise", "rises", "rally", "soar", "climb", "spike", "higher"],
             "down": ["하락", "급락", "내려", "내림", "떨어", "약세", "최저", "plunge", "fall", "falls", "drop", "slump", "tumble", "lower", "slide"]},
    "금리": {"ko": ["금리", "국채", "연준", "FOMC", "기준금리", "통화정책"], "en": ["fed", "federal reserve", "rate", "rates", "treasury", "yield", "yields", "fomc"],
             "rules": [("동결", 0), ("hold", 0), ("rate cut", -1), ("rate hike", 1)],
             "up": ["인상", "상승", "급등", "올려", "올라", "hike", "hikes", "raise", "surge", "jump", "rise", "higher"],
             "down": ["인하", "하락", "내려", "내린", "완화", "cut", "cuts", "lower", "fall", "drop", "ease", "easing"]},
    "환율": {"ko": ["환율", "원달러", "원·달러", "원/달러", "원화", "달러 강세", "달러 약세"], "en": ["won", "dollar"],
             "rules": [("원화 약세", 1), ("원화값 하락", 1), ("원화 가치 하락", 1), ("달러 강세", 1), ("원화 강세", -1),
                       ("원화값 상승", -1), ("원화 가치 상승", -1), ("달러 약세", -1)],
             "up": ["상승", "급등", "돌파", "올라", "치솟", "최고", "strengthens", "rises", "surge"],
             "down": ["하락", "급락", "내려", "떨어", "weakens", "falls", "drop"]},
    "지정학": {"ko": ["전쟁", "공습", "미사일", "중동", "이란", "이스라엘", "우크라이나", "러시아", "북한", "확전", "휴전", "종전"],
               "en": ["war", "missile", "airstrike", "iran", "israel", "ukraine", "russia", "ceasefire", "north korea"],
               "rules": [("휴전", -1), ("종전", -1), ("평화", -1), ("ceasefire", -1), ("truce", -1), ("peace", -1)],
               "up": ["공습", "공격", "확전", "고조", "격화", "발사", "충돌", "도발", "attack", "strike", "strikes", "escalat", "launch"],
               "down": ["합의", "완화", "협상", "철수", "talks", "deal"]},
}
DRV_UPWORD = {"유가": ("상승", "하락"), "금리": ("상승·인상", "하락·인하"), "환율": ("상승(원화 약세)", "하락(원화 강세)"), "지정학": ("긴장 고조", "긴장 완화")}


def driver_dirs(title, lang):
    """제목에서 유가·금리·환율·지정학 '원인' 뉴스와 그 방향(+1 오름/−1 내림)을 읽습니다."""
    low = title.lower()
    out = {}
    for name, d in DRIVERS.items():
        hit = _en_has(d["en"], low) if lang == "en" else [k for k in d["ko"] if k in title]
        if not hit:
            continue
        val = None
        for ph, v in d["rules"]:
            if (lang == "en" and ph in low) or (lang != "en" and ph in title):
                val = v
                break
        if val is None:
            if lang == "en":
                u = sum(1 for w in d["up"] if re.search(r"\b" + re.escape(w), low))
                dn = sum(1 for w in d["down"] if re.search(r"\b" + re.escape(w), low))
            else:
                u = sum(1 for w in d["up"] if w in title)
                dn = sum(1 for w in d["down"] if w in title)
            val = 1 if u > dn else -1 if dn > u else 0
        if val:
            out[name] = val
    return out


# ───────────────────────── 테마 사전 (코스피·코스닥 대표 종목) ─────────────────────────
# drivers: {원인: 부호}  +1 = 그 원인이 '오르면' 이 테마에 유리, −1 = 불리
THEMES = [
    {"name": "반도체·AI칩", "ko": ["반도체", "HBM", "D램", "디램", "낸드", "파운드리", "엔비디아", "AI칩", "AI 칩", "TSMC", "마이크론", "메모리", "브로드컴", "칩스법", "웨이퍼"],
     "en": ["nvidia", "semiconductor", "semiconductors", "chip", "chips", "chipmaker", "chipmakers", "hbm", "tsmc", "micron", "memory", "broadcom", "amd"],
     "stocks": ["삼성전자", "SK하이닉스", "한미반도체", "이수페타시스", "리노공업", "ISC", "주성엔지니어링", "원익IPS", "HPSP", "이오테크닉스",
                "피에스케이", "하나마이크론", "솔브레인", "동진쎄미켐", "티씨케이", "DB하이텍", "대덕전자", "심텍", "테크윙", "유진테크", "파두"]},
    {"name": "AI 전력·전선", "ko": ["데이터센터", "전력망", "변압기", "전력기기", "전선업", "전선주", "전선 업체", "케이블", "송전", "전력 수요", "초고압", "전력 인프라", "AI 전력"],
     "en": ["data center", "data centers", "power grid", "transformer", "transformers", "electricity demand"],
     "stocks": ["HD현대일렉트릭", "LS ELECTRIC", "효성중공업", "산일전기", "대한전선", "LS", "일진전기", "가온전선", "대원전선", "제룡전기", "LS에코에너지"]},
    {"name": "2차전지·전기차", "ko": ["2차전지", "이차전지", "배터리", "전기차", "리튬", "양극재", "음극재", "ESS", "테슬라", "전고체", "캐즘"],
     "en": ["battery", "batteries", "ev", "evs", "electric vehicle", "electric vehicles", "lithium", "tesla"],
     "stocks": ["LG에너지솔루션", "삼성SDI", "에코프로비엠", "에코프로", "포스코퓨처엠", "엘앤에프", "에코프로머티", "SK이노베이션",
                "코스모신소재", "롯데에너지머티리얼즈", "엔켐", "대주전자재료", "솔루스첨단소재", "SK아이이테크놀로지"]},
    {"name": "바이오·제약", "ko": ["바이오", "신약", "임상", "FDA", "기술이전", "기술수출", "제약", "항체", "ADC", "비만약", "비만치료제", "GLP", "품목허가", "바이오시밀러"],
     "en": ["fda", "biotech", "drug", "drugs", "pharma", "clinical trial", "obesity", "glp-1"],
     "stocks": ["삼성바이오로직스", "셀트리온", "알테오젠", "유한양행", "HLB", "리가켐바이오", "SK바이오팜", "한미약품", "에이비엘바이오",
                "펩트론", "삼천당제약", "보로노이", "올릭스", "한올바이오파마", "파마리서치", "휴젤", "녹십자", "대웅제약"],
     "drivers": {"금리": -1}},
    {"name": "방산·우주", "ko": ["방산", "방위산업", "K9", "K2 전차", "국방", "무기", "미사일", "나토", "NATO", "우주", "위성", "누리호", "전투기", "레드백"],
     "en": ["defense", "missile", "nato", "pentagon", "weapons"],
     "stocks": ["한화에어로스페이스", "현대로템", "LIG디펜스앤에어로스페이스", "한국항공우주", "한화시스템", "풍산", "SNT다이내믹스", "퍼스텍",
                "엠앤씨솔루션", "쎄트렉아이", "인텔리안테크"],
     "drivers": {"지정학": 1}},
    {"name": "조선", "ko": ["조선주", "조선업", "조선사", "조선 3사", "조선 빅3", "K조선", "K-조선", "조선·방산", "조선기자재", "선박", "LNG선", "컨테이너선", "조선소", "함정", "잠수함", "마스가", "MASGA", "특수선", "MRO"],
     "en": ["shipbuilding", "shipbuilder", "shipbuilders", "shipyard", "shipyards", "lng carrier"],
     "stocks": ["HD한국조선해양", "HD현대중공업", "삼성중공업", "한화오션", "HD현대마린솔루션", "한화엔진", "HD현대마린엔진", "대한조선",
                "HJ중공업", "STX엔진", "세진중공업", "한국카본", "동성화인텍"],
     "drivers": {"환율": 1}},
    {"name": "해운", "ko": ["해운", "운임", "SCFI", "벌크선", "홍해", "컨테이너 운임", "BDI"], "en": ["shipping rates", "freight rates", "red sea"],
     "stocks": ["HMM", "팬오션", "대한해운", "KSS해운", "흥아해운"]},
    {"name": "원전·SMR", "ko": ["원전", "원자력", "SMR", "소형모듈원자로", "우라늄", "체코 원전", "원전 수출"], "en": ["nuclear", "smr", "uranium"],
     "stocks": ["두산에너빌리티", "한전기술", "한전KPS", "한국전력", "비에이치아이", "우진", "현대건설", "일진파워"]},
    {"name": "자동차·부품", "ko": ["자동차", "완성차", "현대차그룹", "車", "하이브리드", "자동차 관세", "자동차 판매"],
     "en": ["automaker", "automakers", "auto tariffs", "car sales", "hyundai", "kia"],
     "stocks": ["현대차", "기아", "현대모비스", "HL만도", "현대위아", "한온시스템", "에스엘", "한국타이어앤테크놀로지", "금호타이어",
                "명신산업", "현대글로비스", "DN오토모티브", "성우하이텍"],
     "drivers": {"환율": 1}},
    {"name": "로봇", "ko": ["로봇", "휴머노이드", "로보틱스", "옵티머스"], "en": ["robot", "robots", "robotics", "humanoid", "optimus"],
     "stocks": ["레인보우로보틱스", "두산로보틱스", "로보티즈", "유일로보틱스", "클로봇", "로보스타", "뉴로메카", "티로보틱스", "에스피지", "휴림로봇"]},
    {"name": "인터넷·AI서비스", "ko": ["플랫폼", "AI 에이전트", "생성형 AI", "소버린 AI", "LLM", "챗GPT", "오픈AI", "클라우드", "AI 서비스", "피지컬 AI"],
     "en": ["openai", "chatgpt", "generative ai", "cloud", "ai agent"],
     "stocks": ["NAVER", "카카오", "삼성에스디에스", "LG씨엔에스", "포스코DX", "카카오페이", "루닛", "셀바스AI", "솔트룩스", "마키나락스", "SOOP"]},
    {"name": "게임", "ko": ["게임", "신작", "넥슨", "e스포츠", "게임사"], "en": ["video game", "gaming"],
     "stocks": ["크래프톤", "NC", "넷마블", "펄어비스", "시프트업", "더블유게임즈", "카카오게임즈", "위메이드", "넥슨게임즈", "컴투스", "데브시스터즈", "네오위즈"]},
    {"name": "엔터·콘텐츠", "ko": ["엔터", "K팝", "케이팝", "아이돌", "BTS", "방탄소년단", "블랙핑크", "콘서트", "드라마", "K콘텐츠", "한한령", "웹툰"],
     "en": ["k-pop", "bts", "blackpink"],
     "stocks": ["하이브", "JYP Ent.", "에스엠", "와이지엔터테인먼트", "CJ ENM", "스튜디오드래곤", "디어유", "SAMG엔터"]},
    {"name": "화장품·K뷰티", "ko": ["화장품", "K뷰티", "K-뷰티", "뷰티", "인디 브랜드", "선크림"], "en": ["k-beauty", "cosmetics"],
     "stocks": ["에이피알", "아모레퍼시픽", "LG생활건강", "코스맥스", "한국콜마", "실리콘투", "달바글로벌", "코스메카코리아", "펌텍코리아", "브이티", "클래시스"]},
    {"name": "음식료·K푸드", "ko": ["라면", "K푸드", "K-푸드", "식품", "불닭", "음식료", "곡물가", "빼빼로"], "en": ["k-food", "ramen"],
     "stocks": ["삼양식품", "농심", "CJ제일제당", "오리온", "오뚜기", "빙그레", "롯데웰푸드", "동원산업", "하림지주"]},
    {"name": "은행·보험·밸류업", "ko": ["은행", "금융지주", "밸류업", "배당", "자사주 소각", "주주환원", "보험사", "PBR", "상법 개정", "배당소득"],
     "en": ["bank", "banks", "value-up", "dividend"],
     "stocks": ["KB금융", "신한지주", "하나금융지주", "우리금융지주", "기업은행", "BNK금융지주", "JB금융지주", "iM금융지주", "카카오뱅크",
                "삼성생명", "삼성화재", "DB손해보험", "한화생명", "현대해상"],
     "drivers": {"금리": 1}},
    {"name": "증권", "ko": ["증권주", "거래대금", "증권사", "브로커리지", "IPO", "공모주", "증시 활황", "개인 투자자"], "en": ["brokerage", "ipo"],
     "stocks": ["미래에셋증권", "키움증권", "한국금융지주", "NH투자증권", "삼성증권", "한화투자증권", "유안타증권", "SK증권", "신영증권"]},
    {"name": "정유·에너지", "ko": ["정유", "정제마진", "석유", "LPG", "가스요금", "천연가스", "LNG 가격"], "en": ["refining", "refiner", "natural gas"],
     "stocks": ["S-Oil", "SK이노베이션", "GS", "E1", "SK가스", "한국가스공사", "흥구석유", "한국석유"],
     "drivers": {"유가": 1}},
    {"name": "석유화학", "ko": ["석유화학", "화학업계", "에틸렌", "NCC", "화학 공급과잉", "구조조정 화학"], "en": ["petrochemical", "petrochemicals"],
     "stocks": ["LG화학", "롯데케미칼", "금호석유화학", "대한유화", "한화솔루션", "효성화학", "SKC", "롯데정밀화학"],
     "drivers": {"유가": -1}},
    {"name": "항공·여행·카지노", "ko": ["항공", "항공사", "여행", "면세", "관광", "방한 관광객", "단체관광", "무비자", "카지노", "유커", "여객"],
     "en": ["airline", "airlines", "travel", "tourism", "casino"],
     "stocks": ["대한항공", "제주항공", "한진칼", "호텔신라", "파라다이스", "GKL", "강원랜드", "롯데관광개발", "아난티", "글로벌텍스프리"],
     "drivers": {"유가": -1, "환율": -1, "지정학": -1}},
    {"name": "철강·비철", "ko": ["철강", "후판", "열연", "철광석", "반덤핑", "구리", "알루미늄", "아연", "희토류", "고려아연"],
     "en": ["steel", "copper", "aluminum", "zinc", "rare earth", "rare earths"],
     "stocks": ["POSCO홀딩스", "현대제철", "고려아연", "동국제강", "세아베스틸지주", "풍산", "영풍", "KG스틸", "포스코인터내셔널", "삼아알미늄"]},
    {"name": "건설·부동산", "ko": ["건설", "부동산", "분양", "주택", "재건축", "재개발", "SOC", "PF", "해외건설", "네옴", "공급대책", "집값"],
     "en": ["construction", "housing"],
     "stocks": ["현대건설", "삼성물산", "DL이앤씨", "GS건설", "대우건설", "IPARK현대산업개발", "HDC", "금호건설", "계룡건설", "삼성E&A", "한미글로벌"],
     "drivers": {"금리": -1}},
    {"name": "통신", "ko": ["통신사", "이동통신", "5G", "6G", "통신요금", "통신3사"], "en": ["telecom"],
     "stocks": ["SK텔레콤", "KT", "LG유플러스", "케이엠더블유", "RFHIC", "쏠리드"]},
    {"name": "유통·내수", "ko": ["유통", "백화점", "편의점", "이커머스", "내수", "소비쿠폰", "민생", "소비심리", "소매판매"], "en": ["retail sales", "consumer spending"],
     "stocks": ["이마트", "롯데쇼핑", "신세계", "현대백화점", "BGF리테일", "GS리테일", "F&F", "한섬", "LF"]},
    {"name": "중국 소비", "ko": ["중국 소비", "중국 단체관광", "중국인 관광객", "중국 경기부양", "중국 부양책", "한중", "방한 중국인", "시진핑 방한"],
     "en": ["china stimulus", "chinese consumers", "chinese tourists"],
     "stocks": ["아모레퍼시픽", "LG생활건강", "호텔신라", "오리온", "파라다이스", "롯데관광개발", "코스맥스"]},
    {"name": "신재생·수소", "ko": ["태양광", "풍력", "해상풍력", "신재생", "수소", "연료전지", "탄소중립", "IRA"], "en": ["solar", "wind power", "hydrogen", "renewable", "renewables"],
     "stocks": ["한화솔루션", "OCI홀딩스", "씨에스윈드", "HD현대에너지솔루션", "SK오션플랜트", "두산퓨얼셀", "범한퓨얼셀", "SK이터닉스", "LS마린솔루션"]},
]

# 기사에서 자주 쓰는 다른 이름 → 상장 종목 이름
ALIAS = {
    "네이버": "NAVER", "엔씨소프트": "NC", "엔씨": "NC", "LIG넥스원": "LIG디펜스앤에어로스페이스", "현대자동차": "현대차",
    "기아차": "기아", "포스코홀딩스": "POSCO홀딩스", "에쓰오일": "S-Oil", "S-OIL": "S-Oil", "삼성SDS": "삼성에스디에스",
    "한전": "한국전력", "카뱅": "카카오뱅크", "LS일렉트릭": "LS ELECTRIC", "SK이노": "SK이노베이션", "LG엔솔": "LG에너지솔루션",
    "삼성바이오": "삼성바이오로직스", "HD현대일렉": "HD현대일렉트릭", "두산에너빌": "두산에너빌리티", "한국항공우주산업": "한국항공우주",
    "KAI": "한국항공우주", "JYP": "JYP Ent.", "SM엔터": "에스엠", "SM엔터테인먼트": "에스엠", "YG엔터": "와이지엔터테인먼트",
    "한화에어로": "한화에어로스페이스", "한국조선해양": "HD한국조선해양", "고려아연㈜": "고려아연", "현대로템㈜": "현대로템",
    "한국타이어": "한국타이어앤테크놀로지", "아모레": "아모레퍼시픽", "LG생건": "LG생활건강", "셀트리온㈜": "셀트리온",
    "하이닉스": "SK하이닉스", "삼전": "삼성전자", "에코프로BM": "에코프로비엠", "현대건설㈜": "현대건설",
}
EN_ALIAS = {
    "samsung electronics": "삼성전자", "sk hynix": "SK하이닉스", "hynix": "SK하이닉스", "hyundai motor": "현대차", "kia": "기아",
    "lg energy solution": "LG에너지솔루션", "samsung sdi": "삼성SDI", "celltrion": "셀트리온", "naver": "NAVER", "kakao": "카카오",
    "hanwha aerospace": "한화에어로스페이스", "hanwha ocean": "한화오션", "samsung biologics": "삼성바이오로직스", "posco": "POSCO홀딩스",
    "korean air": "대한항공", "krafton": "크래프톤", "hybe": "하이브", "lg electronics": "LG전자", "lg chem": "LG화학",
    "doosan enerbility": "두산에너빌리티", "samsung heavy": "삼성중공업", "korea zinc": "고려아연", "hd hyundai heavy": "HD현대중공업",
    "hyundai rotem": "현대로템", "korea aerospace": "한국항공우주", "kepco": "한국전력", "samsung c&t": "삼성물산", "lg display": "LG디스플레이",
    "lg innotek": "LG이노텍", "hanmi semiconductor": "한미반도체", "ecopro": "에코프로", "alteogen": "알테오젠", "hmm": "HMM",
    "samsung life": "삼성생명", "kb financial": "KB금융", "shinhan": "신한지주", "hana financial": "하나금융지주", "kt&g": "KT&G",
}
# 다른 뜻으로 너무 자주 쓰이거나 그룹 이름과 겹치는 종목명 → 이름 직접 매칭에서 제외 (테마로는 연결됨)
EXCLUDE = {"SK", "LG", "CJ", "DB", "DL", "LS", "GS", "KT", "LF", "SG", "NC", "E1", "한화", "두산", "효성", "코오롱", "대상", "동서",
           "삼영", "혜인", "화신", "우진", "디아이", "케이씨", "대동", "광전자", "대덕", "넥센", "미래산업", "한국석유", "한국공항",
           "우리기술", "고영", "테스", "태광", "원익", "피노", "오로라", "일승", "서산", "야스", "워트", "디바이스", "그래피", "핑거",
           "채비", "노타", "아크릴", "머큐리", "모비스", "스피어", "디오", "태성", "아이엘", "제이오", "컨텍", "큐렉소", "레메디",
           "아톤", "아이텍", "에이스테크", "한컴", "삼현", "티앤엘", "엠플러스", "더즌", "이노테크", "태웅", "와이씨",
           "브이티", "브이엠", "나무가", "제우스", "원텍", "세보엠이씨", "인바디", "에스앤디", "메쥬", "링크솔루션", "그린리소스", "센서뷰", "레이언스"}
SPAM_W = ["슬롯", "토토", "바카라", "포커", "룰렛", "배당표", "심벌", "먹튀", "파워볼", "경마", "카지노 사이트", "카지노게임", "잭팟",
          "꽁머니", "홀덤", "스포츠베팅", "betting", "casino bonus", "slot"]
BLOCK_SRC = {"Calgary Roughnecks", "Vietnam.vn", "vietnam.vn", "Pluang", "Unisba Media", "eyeonannapolis.net"}
MARKET_CATS = {"증시 시황", "특징주", "미국 증시", "금리·연준", "환율", "한국 관련", "실적", "수주·계약", "증권가 전망", "유가·원자재"}
CAP = {"국내": 320, "해외ko": 200, "en": 100}  # 묶음별 최대 기사 수 (해외 기사가 국내 기사를 밀어내지 않게)


def _words(t):
    return {w for w in re.split(r"[^0-9A-Za-z가-힣]+", t.lower()) if len(w) >= 2}


OVERSEAS_MARK = ["미국", "뉴욕", "월가", "나스닥", "S&P", "다우", "연준", "FOMC", "파월", "트럼프", "중국", "일본", "엔화", "유럽", "ECB",
                 "엔비디아", "애플", "테슬라", "마이크로소프트", "TSMC", "OPEC", "국제유가", "백악관", "베이징", "대만"]


# ───────────────────────── 종목 사전 ─────────────────────────
def load_universe():
    d = json.load(open(LATEST, encoding="utf-8"))
    stocks = [s for s in d.get("stocks", []) if s.get("market") in ("KOSPI", "KOSDAQ")]
    by_name = {s["name"]: s for s in stocks}
    return stocks, by_name


KO_NEXT = "은는이가을를의에와과도로만측주그서보까부처엔랑께한며및발향社"


def build_matchers(stocks, by_name):
    names = {}
    for s in stocks:
        nm = re.sub(r"\(.*?\)", "", s["name"]).strip()
        if nm and len(nm) >= 2:
            names[nm] = None if nm in EXCLUDE else s["code"]  # 제외 이름도 사전에 넣어 글자만 '소모'(더 짧은 이름으로 잘못 연결 방지)
    for a, real in ALIAS.items():
        if real in by_name:
            names[a] = by_name[real]["code"]
    pats = []
    for nm in sorted(names, key=len, reverse=True):
        p = re.escape(nm)
        if re.match(r"[A-Za-z0-9&.]$", nm[-1]):
            p += r"(?![A-Za-z0-9])"
        else:  # 한글로 끝나는 이름 뒤에는 조사·'그룹' 등만 허용 (하이브 ≠ 하이브리드)
            p += r"(?![가-힣])|" + p + r"(?=[" + KO_NEXT + r"])"
        pats.append(p)
    ko_re = re.compile(r"(?<![가-힣A-Za-z0-9])(" + "|".join(pats) + ")") if pats else None
    en_map = {k: by_name[v]["code"] for k, v in EN_ALIAS.items() if v in by_name}
    en_re = re.compile(r"\b(" + "|".join(re.escape(k) for k in sorted(en_map, key=len, reverse=True)) + r")\b", re.I) if en_map else None
    return names, ko_re, en_map, en_re


def match_stocks(title, lang, names, ko_re, en_map, en_re):
    found = []
    if lang == "en":
        if en_re:
            for m in en_re.finditer(title):
                c = en_map.get(m.group(1).lower())
                if c and c not in found:
                    found.append(c)
    elif ko_re:
        for m in ko_re.finditer(title):
            c = names.get(m.group(1))
            if c and c not in found:
                found.append(c)
    return found[:6]


# 테마 단어가 다른 낱말 속에 들어간 경우 (지방산림청의 '방산', 은행나무의 '은행' 등) — 매칭 전에 지움
FALSE_SUB = ["지방산림", "방산림", "은행나무", "게임체인저", "게임 체인저", "구리시", "최전선", "전선에서", "수출 전선", "무역 전선", "공급 전선",
             "대전선", "산림", "항공사진", "한국은행", "한은", "농식품부", "농림축산식품부", "식품의약품안전처", "위성도시", "화장실", "건설적", "로봇청소기 화재"]


def match_themes(title, lang):
    for w in FALSE_SUB:
        title = title.replace(w, " ")
    low = title.lower()
    hits = []
    for th in THEMES:
        ok = _en_has(th.get("en", []), low) if lang == "en" else [k for k in th["ko"] if k in title]
        if ok:
            hits.append(th["name"])
    return hits


# ───────────────────────── RSS 읽기 ─────────────────────────
def parse_rss(content, default_src=""):
    root = ET.fromstring(content)
    out = []
    for it in root.iter("item"):
        title = re.sub(r"\s+", " ", (it.findtext("title") or "")).strip()
        src = (it.findtext("source") or default_src or "").strip()
        if src and title.endswith(" - " + src):
            title = title[: -len(" - " + src)].strip()
        m_tail = re.search(r"\s[-|]\s([^-|]{1,25})$", title)  # 끝에 붙은 ' - 언론사명' 제거
        if m_tail and len(title) - len(m_tail.group(0)) >= 10:
            src = src or m_tail.group(1).strip()
            title = title[: m_tail.start()].strip()
        elif " - " in title and not default_src:
            title, _, src2 = title.rpartition(" - ")
            src = src or src2
        link = (it.findtext("link") or "").strip()
        ts = None
        pd_ = it.findtext("pubDate") or it.findtext("{http://purl.org/dc/elements/1.1/}date")
        if pd_:
            try:
                ts = email.utils.parsedate_to_datetime(pd_.strip())
            except Exception:
                try:
                    ts = dt.datetime.fromisoformat(pd_.strip().replace("Z", "+00:00"))
                except Exception:
                    ts = None
        if ts is not None and ts.tzinfo is None:
            ts = ts.replace(tzinfo=KST)
        desc = it.findtext("description") or ""
        desc = re.sub(r"<[^>]+>", " ", desc)
        desc = re.sub(r"&[a-z#0-9]+;", " ", desc)
        desc = re.sub(r"\s+", " ", desc).strip()
        if title:
            out.append({"t": title, "u": link, "s": src, "ts": ts, "desc": desc})
    return out


def fetch_google(job):
    reg, cat, q, lang = job
    params = {"q": f"{q} when:{WHEN}"}
    params.update({"hl": "ko", "gl": "KR", "ceid": "KR:ko"} if lang == "ko" else {"hl": "en-US", "gl": "US", "ceid": "US:en"})
    r = requests.get("https://news.google.com/rss/search", params=params, headers=UA, timeout=15)
    r.raise_for_status()
    items = parse_rss(r.content)
    for x in items:
        x.update({"reg": reg, "cat": cat, "lang": lang, "via": "구글뉴스", "desc": ""})  # 구글 설명란은 제목 반복이라 버림
    return items


def fetch_press(job):
    reg, name, url = job
    r = requests.get(url, headers=UA, timeout=15)
    r.raise_for_status()
    items = parse_rss(r.content, default_src=name)
    for x in items:
        x.update({"reg": reg, "cat": "", "lang": "ko", "via": name, "s": name})
    return items


def run_all(fn, jobs, label):
    out, fails = [], 0
    with ThreadPoolExecutor(max_workers=6) as ex:
        futs = {ex.submit(fn, j): j for j in jobs}
        for f, j in futs.items():
            try:
                res = f.result(timeout=40)
                out += res
            except Exception as e:
                fails += 1
                log(f"  {label} 실패: {j[2] if len(j) > 2 else j} → {type(e).__name__}: {str(e)[:80]}")
    log(f"{label}: {len(out)}건 (실패 {fails}/{len(jobs)})")
    return out, fails


# ───────────────────────── 한 줄 해석 ─────────────────────────
def names_of(codes, by_code, k=2):
    return "·".join(by_code[c]["name"] for c in codes[:k] if c in by_code)


def make_note(item, theme_eff, by_code, theme_stocks):
    """기사가 어떤 종목에 어떻게 영향을 줄 수 있는지 쉬운 말로 한 줄"""
    parts = []
    word = {1: "긍정적", -1: "부정적", 0: "관심"}
    if item["dr"]:
        for d, v in item["dr"].items():
            up, dn = DRV_UPWORD[d]
            good = [n for n, e in theme_eff if e > 0 and THEME_BY[n].get("drivers", {}).get(d)]
            bad = [n for n, e in theme_eff if e < 0 and THEME_BY[n].get("drivers", {}).get(d)]
            seg = f"{d} {up if v > 0 else dn}"
            sub = []
            if good:
                sub.append("유리: " + ", ".join(f"{g}({names_of(theme_stocks[g], by_code, 1)} 등)" for g in good[:3]))
            if bad:
                sub.append("부담: " + ", ".join(f"{b}({names_of(theme_stocks[b], by_code, 1)} 등)" for b in bad[:3]))
            if sub:
                parts.append(seg + " → " + " / ".join(sub))
    if item["st"]:
        t = item["tone"]
        parts.append(f"{names_of(item['st'], by_code, 3)} 직접 언급 · " + ("호재성 소식" if t > 0 else "악재성 소식" if t < 0 else "방향은 중립"))
    plain = [(n, e) for n, e in theme_eff if not (item["dr"] and any(THEME_BY[n].get("drivers", {}).get(d) for d in item["dr"]))]
    if plain:
        n, e = plain[0]
        tail = (f"{names_of(theme_stocks[n], by_code, 2)} 등 {n} 종목에 {word[e]} 영향 가능" if e
                else f"{names_of(theme_stocks[n], by_code, 2)} 등 {n} 종목 관련 소식 (좋고 나쁨은 불분명)")
        if len(plain) > 1:
            tail += f" (그 밖에 {', '.join(x for x, _ in plain[1:3])})"
        parts.append(tail)
    if not parts:
        t = item["tone"]
        parts.append("시장 전체 분위기 소식 · " + ("긍정적" if t > 0 else "부정적" if t < 0 else "중립"))
    return " | ".join(parts)


THEME_BY = {t["name"]: t for t in THEMES}


# ───────────────────────── 메인 ─────────────────────────
def main():
    t0 = time.time()
    stocks, by_name = load_universe()
    by_code = {s["code"]: s for s in stocks}
    names, ko_re, en_map, en_re = build_matchers(stocks, by_name)
    log(f"연결 대상 코스피·코스닥 {len(stocks)}종목 · 이름 사전 {len(names)}개")

    theme_stocks = {}
    for th in THEMES:
        cs = [by_name[n]["code"] for n in th["stocks"] if n in by_name]  # 사전에 적은 순서(대표 종목 먼저) 유지
        theme_stocks[th["name"]] = cs
    missing = [n for th in THEMES for n in th["stocks"] if n not in by_name]
    if missing:
        log(f"테마 종목 중 유니버스에 없는 이름 {len(missing)}개(무시): {', '.join(missing[:15])}")

    raw = []
    jobs = [(r, c, q, "ko") for r, c, q in GN_KO] + [(r, c, q, "en") for r, c, q in GN_EN]
    got, f1 = run_all(fetch_google, jobs, "구글 뉴스")
    raw += got
    got, f2 = run_all(fetch_press, PRESS, "언론사 RSS")
    raw += got

    cutoff = NOW - dt.timedelta(hours=WINDOW_H)
    seen, items = {}, []
    for x in sorted(raw, key=lambda z: z["ts"] or NOW, reverse=True):
        if x["ts"] is not None and x["ts"] < cutoff:
            continue
        key = re.sub(r"[\W_]", "", x["t"]).lower()[:24]
        if len(key) < 6:
            continue
        if key in seen:
            prev = seen[key]
            if x["cat"] and x["cat"] not in prev["cats"]:
                prev["cats"].append(x["cat"])
            continue
        if x["s"] in BLOCK_SRC or any(w in x["t"].lower() for w in SPAM_W):
            continue  # 도박·광고성 가짜 기사, 기계번역 사이트 제외
        lang = x["lang"]
        if lang == "ko" and not re.search(r"[가-힣]", x["t"]):
            lang = "en"
        tone, kw = tone_of(x["t"], lang)
        st = match_stocks(x["t"], lang, names, ko_re, en_map, en_re)
        ths = match_themes(x["t"], lang)
        dr = driver_dirs(x["t"], lang)
        # 원인 뉴스면 그 원인에 민감한 테마를 자동으로 붙임
        for d in dr:
            for th in THEMES:
                if d in th.get("drivers", {}) and th["name"] not in ths:
                    ths.append(th["name"])
        theme_eff = []
        for n in ths:
            drv = THEME_BY[n].get("drivers", {})
            effs = [dr[d] * sgn for d, sgn in drv.items() if d in dr]
            e = (1 if sum(effs) > 0 else -1 if sum(effs) < 0 else 0) if effs else tone
            theme_eff.append((n, e))
        reg = x["reg"]
        if lang == "en":
            reg = "해외"
        elif x["via"] != "구글뉴스":  # 언론사 피드는 제목으로 국내/해외 판단
            reg = "해외" if (reg == "해외" or (not st and any(k in x["t"] for k in OVERSEAS_MARK))) else "국내"
        linked = bool(st or theme_eff)
        if x["via"] != "구글뉴스" and not linked:
            continue  # 언론사 전체 피드는 종목·테마와 이어지는 기사만
        if lang == "en" and not linked:
            continue  # 영문 기사는 한국 종목·테마와 이어질 때만
        if not linked and x["cat"] not in MARKET_CATS:
            continue  # 종목 연결 없는 기사는 증시·금리·환율 시황만
        # 같은 사건을 다룬 비슷한 기사(단어 60% 이상 겹침)는 하나로 묶음
        ws = _words(x["t"])
        dup = None
        for p in items[-250:]:
            pw = p["_w"]
            if ws and pw and len(ws & pw) / max(1, min(len(ws), len(pw))) >= 0.6:
                dup = p
                break
        if dup is not None:
            dup["more"] = dup.get("more", 0) + 1
            if x["cat"] and x["cat"] not in dup["cats"]:
                dup["cats"].append(x["cat"])
            continue
        it = {"t": x["t"], "u": x["u"], "s": x["s"], "lang": lang, "reg": reg,
              "cats": [x["cat"]] if x["cat"] else [], "tone": tone, "kw": kw, "st": st, "dr": dr,
              "ts": x["ts"].astimezone(KST).strftime("%Y-%m-%dT%H:%M") if x["ts"] else None,
              "desc": (x["desc"] or "")[:140], "linked": linked, "_w": ws}
        it["th"] = theme_eff
        seen[key] = it
        items.append(it)

    # 묶음별(국내 / 해외 한글 / 영문) 최대 개수 안에서 '종목 연결된 기사' 우선, 그다음 최신순
    grp = lambda i: "en" if i["lang"] == "en" else ("국내" if i["reg"] == "국내" else "해외ko")
    keep = []
    for g, cap in CAP.items():
        gi = [i for i in items if grp(i) == g]
        lk = [i for i in gi if i["linked"]]
        lo = [i for i in gi if not i["linked"]]
        keep += (lk + lo[: max(30, cap // 4)])[:cap]
    items = sorted(keep, key=lambda z: z["ts"] or "", reverse=True)
    for i in items:
        i.pop("_w", None)

    agg = {}
    for idx, it in enumerate(items):
        it["i"] = idx
        if not it["cats"]:
            it["cats"] = [it["th"][0][0]] if it["th"] else ["시장"]
        it["note"] = make_note(it, it["th"], by_code, theme_stocks)
        for c in it["st"]:
            a = agg.setdefault(c, {"n1": 0, "n2": 0, "pos": 0, "neg": 0, "sc": 0, "it": []})
            a["n1"] += 1
            a["pos"] += it["tone"] > 0
            a["neg"] += it["tone"] < 0
            a["sc"] += 2 * it["tone"]
            a["it"].append(idx)
        for n, e in it["th"]:
            for c in theme_stocks.get(n, []):
                if c in it["st"]:
                    continue
                a = agg.setdefault(c, {"n1": 0, "n2": 0, "pos": 0, "neg": 0, "sc": 0, "it": []})
                a["n2"] += 1
                a["pos"] += e > 0
                a["neg"] += e < 0
                a["sc"] += e
                if len(a["it"]) < 40:
                    a["it"].append(idx)
        it["th"] = [[n, e] for n, e in it["th"]]
        it["dr"] = [[d, v] for d, v in it["dr"].items()]
        del it["linked"]
    for a in agg.values():
        a["pos"], a["neg"] = int(a["pos"]), int(a["neg"])
        a["it"] = sorted(set(a["it"]))[:40]

    themes = {}
    for th in THEMES:
        n = th["name"]
        rel = [it for it in items if any(x[0] == n for x in it["th"])]
        pos = sum(1 for it in rel for x in it["th"] if x[0] == n and x[1] > 0)
        neg = sum(1 for it in rel for x in it["th"] if x[0] == n and x[1] < 0)
        themes[n] = {"stocks": theme_stocks[n], "n": len(rel), "pos": pos, "neg": neg,
                     "drivers": th.get("drivers", {})}

    rank = sorted(agg.items(), key=lambda kv: (-kv[1]["sc"], -kv[1]["n1"]))
    top_pos = [c for c, a in rank if a["sc"] > 0][:20]
    top_neg = [c for c, a in sorted(agg.items(), key=lambda kv: (kv[1]["sc"], -kv[1]["n1"])) if a["sc"] < 0][:20]
    top_direct = [c for c, a in sorted(agg.items(), key=lambda kv: -kv[1]["n1"]) if a["n1"] > 0][:20]

    src_cnt = {}
    for it in items:
        src_cnt[it["s"] or "기타"] = src_cnt.get(it["s"] or "기타", 0) + 1
    meta = {"generated": NOW.strftime("%Y-%m-%d %H:%M"), "window_h": WINDOW_H, "n": len(items),
            "n_kr": sum(1 for i in items if i["reg"] == "국내"), "n_os": sum(1 for i in items if i["reg"] == "해외"),
            "n_en": sum(1 for i in items if i["lang"] == "en"), "n_linked": sum(1 for i in items if i["st"] or i["th"]),
            "n_stocks": len(agg), "sources": dict(sorted(src_cnt.items(), key=lambda kv: -kv[1])[:20]),
            "fails": f1 + f2, "elapsed_s": round(time.time() - t0, 1), "log": LOG[-60:]}
    data = {"meta": meta, "themes": themes, "items": items, "stocks": agg,
            "top": {"pos": top_pos, "neg": top_neg, "direct": top_direct}}
    if not items and os.path.exists(OUT):
        log("새 기사를 하나도 못 가져와서 기존 news.json 유지")
        return
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    log(f"저장 news.json — 기사 {len(items)}건(국내 {meta['n_kr']}·해외 {meta['n_os']}) · 연결 종목 {len(agg)}개 · {os.path.getsize(OUT) / 1e3:.0f}KB")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"오류: {type(e).__name__}: {e}")
    sys.stdout.flush()
    os._exit(0)
