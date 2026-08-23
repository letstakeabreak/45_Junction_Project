---
name: STANDBY
colors:
  surface: '#fbf9f8'
  surface-dim: '#dbdad9'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f5f3f3'
  surface-container: '#efeded'
  surface-container-high: '#e9e8e7'
  surface-container-highest: '#e4e2e2'
  on-surface: '#1b1c1c'
  on-surface-variant: '#444748'
  inverse-surface: '#303031'
  inverse-on-surface: '#f2f0f0'
  outline: '#747878'
  outline-variant: '#c4c7c7'
  primary: '#000000'
  on-primary: '#ffffff'
  secondary: '#5d5f5f'
  on-secondary: '#ffffff'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  warning: '#8a5a00'
  warning-container: '#ffe08a'
  success: '#1f6b3a'
  success-container: '#cfe9d8'
  unknown: '#747878'
  unknown-container: '#eceded'
  edited: '#3b4cca'
  edited-container: '#dfe3ff'
  background: '#fbf9f8'
  on-background: '#1b1c1c'
typography:
  display-brand: { fontFamily: JetBrains Mono, fontSize: 20px, fontWeight: '700', lineHeight: 24px, letterSpacing: 0.05em }
  loading-brand: { fontFamily: JetBrains Mono, fontSize: 36px, fontWeight: '700', lineHeight: 44px, letterSpacing: 0.2em }
  headline-page: { fontFamily: system-ui, fontSize: 18px, fontWeight: '600', lineHeight: 24px }
  panel-title:   { fontFamily: system-ui, fontSize: 14px, fontWeight: '600', lineHeight: 20px }
  body-main:     { fontFamily: system-ui, fontSize: 14px, fontWeight: '400', lineHeight: 20px }
  data-mono:     { fontFamily: ui-monospace, fontSize: 12px, fontWeight: '400', lineHeight: 16px }
  cell-text:     { fontFamily: system-ui, fontSize: 12px, fontWeight: '400', lineHeight: 16px }
  label-caps:    { fontFamily: system-ui, fontSize: 11px, fontWeight: '600', lineHeight: 16px, letterSpacing: 0.02em }
spacing:
  header-height: 56px
  container-padding: 20px
  panel-gap: 8px
  timeline-height: 132px
  cell-padding-v: 6px
  cell-padding-h: 10px
---

# STANDBY — Design Contract

> **개정 2026-08-22.** 팀 설계 검토 결과를 반영해 전면 개정했다.
> 이전 5단계 헤더, 6항목 사이드바, 좌측 finding 목록, 별도 제안 화면,
> Master v2 재검증 화면, 독립 Final 2D 화면은 **모두 폐기**했다.
> Stitch Lo-Fi 2종도 폐기하고 아래 계약을 유일한 기준으로 삼는다.

## Brand & Style

STANDBY는 공연 제작 검증 워크스페이스다. 시각 언어는 **Technical Blueprint / Compiler IDE**.
밀도 높고, 근거가 붙어 있고, 의도적으로 저채도다.
분석 대시보드나 장식적 디지털 트윈처럼 보이면 실패다.

참조 메타포는 **영상편집기(NLE)**다. 위는 프리뷰, 가운데는 편집 대상, 아래는 트랙.

본문·라벨·입력은 운영체제의 시스템 서체를 쓴다. 별도 Noto Sans KR 웹폰트를 로드하지 않는다.
JetBrains Mono는 `STANDBY` 워드마크와 extraction loading wordmark에만 사용해 제품 식별자로 남긴다.

---

## Canonical Screen Set

P0는 화면 **두 개**뿐이다.

| # | 이름 | 역할 |
|---|---|---|
| 1 | `입력` | 세 문서 업로드 · 역할 확인 · 추출 시작 |
| 2 | `워크스페이스` | 무대 · 큐시트 · 타임라인 3분할. 검증·검토·수정이 전부 여기서 일어난다 |

그 이상의 화면은 편의 기능이며 **보류**다.

---

## 화면 1 — 입력

세 입력을 받고 역할을 확정하는 것 외의 일을 하지 않는다.

- 가로 3분할 소스 카드: `SCRIPT` · `CUESHEET` · `STAGE_SPEC`
- 각 카드: 파일명, revision/hash, origin 배지(`REAL_REFERENCE` / `CONTROLLED_FIXTURE` / `MUTATED_FIXTURE`), `REVIEWED | UNREVIEWED`
- `STAGE_SPEC` 카드는 파일 업로드 대신 **폼 입력**을 허용한다 (아래 무대 최소 입력 참조)
- Primary CTA: `Upstage 추출 시작` → 완료되면 화면 2로 전환
- `MASTER_CUE` 카드에 보조 액션 `예시 큐시트 첨부`를 둔다. 클릭 시 제품 내 통제 JSON 샘플을
  실제 파일처럼 선택하고 파일명·용량·`CONTROLLED_FIXTURE` origin을 같은 UI에서 보존한다
- **제외**: 입력 계약 체크리스트, `Source 교체`, `EXPORT LOG`, revision lineage, 5단계 진행 표시

### Extraction loading scene

- 추출 중에는 JetBrains Mono의 `S T A N D B Y` 일곱 글자를 보여 주고, `S`부터 `Y`까지 차례로
  낮은 명도에서 높은 명도로 밝아지는 짧은 loop를 사용한다.
- 제품 결과 예시는 보조 정보로 남기되, 장식 spinner·particle·과장된 진행률을 함께 쌓지 않는다.
- 이 효과는 실제 진행률을 뜻하지 않는다. 추출 상태·실패·timeout은 별도 상태 문구가 담당한다.
- `prefers-reduced-motion`에서는 순차 밝기 변화를 멈추고 모든 글자를 동일한 명도로 고정한다.

### Fact review — 같은 입력 화면 안의 gate

Fact Normalizer가 연결되더라도 review는 생략하지 않는다. review gate 전체에 선택지는 둘만 둔다.

- `추천값`: Agent가 추천한 normalized type·field를 **읽기 전용**으로 표시
- `사용자화`: 추천된 allowlist type은 고정하고 field 값만 편집. type dropdown 없음
- type이 잘못됐으면 다른 type을 고르는 대신 해당 추천을 `REJECTED` 처리
- `일괄 승인`: 사용자화 mode에서 validation을 통과한 현재 draft에만 사람이 명시적으로 실행. 각 fact의
  review record를 따로 남기며 snapshot freeze는 별도 CTA
- 추천값은 `NON_AUTHORITATIVE` token을 가진다. 추천이 보이는 것과 `REVIEWED`는 같은 상태가 아니다

mode는 fact card마다 반복하지 않는다. gate 상단의 한 선택이 전체 목록의 표현과 승인 동작을 바꾸며,
fact별 승인·거절 기록은 그대로 보존한다.

자동 승인, 화면 진입과 동시에 bulk approve, Normalizer 결과로 verdict 선반영은 금지한다.

---

## 화면 2 — 워크스페이스 (메인)

### 레이아웃

```
┌──────────────────────────────────────────────────────────┐  56px
│ STANDBY   [입력] [워크스페이스]               Production │
├──────────────┬───────────────────────────────────────────┤
│ Script       │                                           │
│ (접기 가능)   │  패널 A  (무대 시뮬레이터 또는 큐시트)      │  ─┐
│              │                                           │   │ 두 패널
│ event 발췌    ├───────────────────────────────────────────┤   │ 높이 동일
│              │                                           │   │ 순서 스왑 가능
│              │  패널 B  (큐시트 또는 무대 시뮬레이터)      │  ─┘
│              │                                           │
│              ├───────────────────────────────────────────┤
│              │  이벤트 타임라인  E1 … E8                  │  132px
└──────────────┴───────────────────────────────────────────┘
```

- **패널 A와 B는 높이가 같다.** 그래야 순서를 바꿔도 레이아웃이 흔들리지 않는다
- 헤더 우측에 **스왑 버튼**. 큐시트와 비교하려면 큐시트를 위로, 무대와 비교하려면 무대를 위로
- 전역 내비게이션 사이드바는 없다. 화면 이동은 상단 탭 2개만 쓴다
- **finding 목록을 위한 별도 영역은 두지 않는다**

### Script Sidebar — 워크스페이스 내부의 읽기 전용 event 인덱스

- 좌측에서 접고 펼칠 수 있는 보조 패널이다. 새 화면·입력 화면의 세 번째 카드·다목적 내비게이션이 아니다
- 패널 안에서 DOCX(우선) 또는 PDF(보조)를 연결한다. 서버의 Upstage Script Extractor가 만든
  `standby.script-projection.v1`의 실제 대사·지문만 표시하고 MASTER_CUE 문구로 대신하지 않는다
- 파일은 현재 case의 SCRIPT source로 귀속된다. 연결 직후 기존 snapshot을 폐기하고 Fact Review로 돌아가며,
  새 snapshot 전에는 verified finding의 SCRIPT 근거로 사용하지 않는다
- exact `event_id`가 있는 구간만 자동 연결한다. 나머지는 `이벤트 연결 대기`에 남기고, 사람이 현재
  timeline event를 선택한 뒤 연결한다
- timeline에서 event를 고르면 해당 발췌가 보이도록 스크롤하고 강조한다
- 발췌를 누르면 같은 event의 timeline·stage snapshot으로 이동한다
- 발췌는 편집할 수 없고 localStorage에 남지 않으며 fact·review·snapshot·verdict authority를 갖지 않는다

### 패널 — 무대 시뮬레이터

MVP는 **도면이 아니라 네모**다. 목적은 정밀 계측이 아니라 **육안 확인**이다.

```
        ┌─────────────────────────┐
  상수  │                         │  하수
  WING  │        무대 (STAGE)      │  WING
        │                         │
        └─────────────────────────┘
              백스테이지 통로 ○/✕
```

- 무대는 단순 사각형. 좌우에 **상수 / 하수 날개**
- 두 날개 사이 **백스테이지 통로 유무**를 선/점선/차단선으로 표시
- 사람은 **원**, 소품은 **사각형**, 라벨은 이름
- 좌표 보간 금지. 존 안에서의 정확한 위치를 지어내지 않는다
- 배지: `SCHEMATIC · 좌우 구분만 · 실측 아님`

> 실제 도면과 좌표 계산은 **향후 제품 단계**다. 대도구 반출입 인력 산정에는 필요하지만 MVP 범위가 아니다.

#### 읽기 전용이다 — 드래그앤드롭을 만들지 마라 ★

시뮬레이터에서 노드를 끌어다 배치하는 기능은 **검토 후 폐기했다.** 이유:

- E6에서 퇴장한 은비를 E9에서 무대로 끌어오면, 그건 **새 이벤트를 만드는 행위**다
- 그 이벤트의 트리거는 무엇인가? 번호는 9인가 10인가? 답할 수 없다
- 시뮬레이터가 **이벤트 생성자**가 되면 큐시트(JSON)와 동시 수정이 필요해져 상태가 꼬인다
- 원본 불변 + revision layer 모델이 깨진다. 편집 경로가 두 개가 되기 때문이다

> **편집은 큐시트에서만 한다. 시뮬레이터는 그 결과를 비추는 거울이다.**
> 큐시트를 고치면 시뮬레이터가 즉시 반영한다. 그 반대 방향은 없다.

초기 배치(`initial_state`)도 마찬가지다. 큐시트가 제대로 작성돼 있으면 거기서 나온다.
시뮬레이터에서 손으로 세팅하지 않는다.

#### 이벤트별 상태 — 스냅샷이 정본, motion은 인접 차이만 ★

연출자가 확인할 정본은 여전히 *"은비가 지금 어디 있지"*에 답하는 이벤트별 정적 스냅샷이다.
motion은 실제 blocking 경로나 새 상태를 보여 주는 것이 아니라, **시간순으로 인접한 두 verified snapshot에서
무엇이 달라졌는지** 짧게 읽게 하는 보조 표현이다.

- 인접 event 앞/뒤 이동: zone이 바뀐 entity만 180–360ms semantic transition. ENTER/EXIT opacity 보조 포함
- 한 전환의 총 motion은 600ms 이하. 현재 playhead와 바뀐 entity 외에는 움직이지 않음
- 여러 event jump 또는 비인접 back: 이동 경로를 꾸미지 않고 정적 교체 또는 180ms 이하 crossfade
- `prefers-reduced-motion`: 모든 이동·fade를 제거하고 target snapshot 즉시 표시
- 반복·bounce·particle·상시 pulse·노드별 장식 delay 금지
- 좌표·곡선은 Agent가 만들지 않는다. UI가 reviewed `from_zone → to_zone` 차이만 schematic으로 표시

Storyboard Recomposer는 인접 pair의 action 순서와 짧은 설명만 `NON_AUTHORITATIVE`로 제공한다. 현재
구현은 timeline 선택 시 frozen input으로 lazy 실행하고, 동일 입력 재요청은 서버 cache를 사용한다.
cache miss·timeout·strict decode 실패에서도 target snapshot을 먼저 표시하고 정적 상태를 유지한다.

#### 노드 상태 3종

정적 스냅샷만으로는 *"언제 퇴장했는지"*를 알 수 없다 —
E6에서 퇴장했어도 E7·E8·E9에서 똑같이 윙에 서 있기 때문이다.
그래서 **그 이벤트에서 일어난 동작**을 노드에 표시한다.

| 상태 | 표시 | 의미 |
|---|---|---|
| `ENTER` | **무대 쪽(안쪽) 화살표** + `등장` | 이 이벤트에서 등장했다 |
| `EXIT` | **윙 쪽(바깥쪽) 화살표** + `퇴장` | 이 이벤트에서 퇴장했다 |
| (없음) | 화살표 없음 | 그냥 그 자리에 있다 |

**화살표 방향은 좌/우 절대방향이 아니라 `무대 쪽 / 윙 쪽`으로 정의한다.**
상수는 화면 왼쪽, 하수는 오른쪽에 그려지므로 절대방향으로 정의하면 양쪽이 반대가 되어 혼동한다.
어느 윙에서 들고 나는지는 **노드가 놓인 위치로 이미 드러난다.**

#### 등장·퇴장 색

MVP 기준으로 **색각 대응은 범위 밖**이며, 관례적인 초록/빨강을 쓴다.

| 상태 | 색 | 방향 | 라벨 |
|---|---|---|---|
| `ENTER` | `--enter: #22c55e` | 무대 쪽(안쪽) | `등장` |
| `EXIT` | `--exit: #ef4444` | 윙 쪽(바깥쪽) | `퇴장` |

verdict 색(`CONSISTENT` #7ee2a8 · `VIOLATION` #ff8a80)은 저채도 파스텔이라
위 고채도와 정상 시야에서 구분된다. 그래도 **방향과 텍스트 라벨이 주 신호**다 —
무대 패널의 빨간 화살표가 "퇴장"인지 "위반"인지 순간 헷갈릴 여지를 없앤다.

> 참고: 색각이상까지 만족시키려면 두 색을 쓸 수 없다는 측정 결과가 있다.
> 팔레트에서 색각이상·WCAG를 함께 통과하는 색상대는 210°–288° 하나뿐이고,
> 그 안의 두 색은 deuteranopia에서 상호 ΔE 11.9로 구분되지 않는다.
> 제품화 단계에서 접근성을 다룰 때 **단일 색 + 방향·채움·라벨 3중 인코딩**으로 되돌린다.

### 패널 — 큐시트

**읽기 전용이 아니다. 수정과 확인이 가능해야 한다.**

- 원본 표 형태를 유지한 표 뷰. 선택된 이벤트의 행을 하이라이트
- **hero 구간에 걸리는 열만 기본 표시**. 17열 전체를 펼치면 무너진다
  - 기본: `마커` `무대_상수` `무대_하수` `환복시간` `의상` `조명` `음향`
  - `열 표시` 토글로 나머지 열 확장
- 행 좌측 **gutter에 finding 마커** (🔴 / 🟡 / ⬜)
- 셀 편집 가능. 편집한 셀은 즉시 **`edited` 색 배경 + 좌상단 삼각 마커**
- 선택 이벤트 기준 `이벤트 추가`·`이벤트 삭제`. 둘 다 저장 전 draft이며 저장 시 새 revision으로 확정
- 패널 헤더: `저장` 버튼 + `히스토리` 버튼 + `미반영 변경 N건` 배지
- export: 원본 보존 `XLSX 내보내기` + 동일 표준 빈칸 양식의 `Word 실행본`·`PDF 실행본`
- 편집 취소 경로 두 개
  - 셀 단위 `되돌리기`
  - 상단 `모든 변경 취소`

### 패널 — 이벤트 타임라인

**보기 전용이다. 여기서 편집하지 않는다.**

- `E1` ~ `E8` 카드가 가로 일렬. 영상편집기의 트랙 클립처럼 배치
- 각 카드는 이벤트명과 **상태 색**을 가진다
- 좌우 스크롤, `이전 / 재생 / 다음` 컨트롤. **Zoom 없음**
- 현재 이벤트는 검은 채움 + 재생 헤드 세로선
- event 선택 시 stage snapshot을 먼저 바꾸고 cached Storyboard를 적용하며 Script Sidebar의 같은 event를
  스크롤·강조한다. Agent job을 기다리느라 선택을
  잠그거나 전체 화면 loader로 되돌아가지 않는다.
- 상태 표시는 패널 헤더 우측의 작은 토큰 하나만 쓴다: `STORYBOARD READY | UPDATING | FALLBACK`.
  Agent 설명문을 timeline 카드마다 반복하지 않는다.
- Storyboard `beats`와 `missing_evidence`는 펼쳐 보는 읽기 전용 `NON_AUTHORITATIVE` 정보다. 정적 stage
  snapshot과 deterministic verdict가 정본이며, 이 정보로 둘을 생성하거나 수정하지 않는다.

### Rehearsal Brief — 별도 화면 없음

- finding 상세 하단에 기본 접힘 `REHEARSAL BRIEF` 한 줄만 둔다.
- 펼치면 기존 finding/evidence에서 만든 확인 항목을 중요도순 **최대 3개** 표시한다.
- 새 verdict·severity·안전 결론처럼 보이는 배지나 색을 쓰지 않는다.
- Agent 호출 불가·실패 시 영역을 숨기며 workspace와 finding 검토는 그대로 동작한다.

### Finding 팝업

**타임라인 카드를 클릭하면 팝업이 위로 올라온다.**

- 팝업은 **패널 B(아래 패널)를 덮는다.** 패널 A는 계속 보인다
- 사용자는 그 카드가 궁금해서 누른 것이므로 아래가 가려져도 무방하다
- 비교 대상을 바꾸려면 **스왑**으로 원하는 패널을 위에 둔다
- 팝업 구성
  1. verdict 배지 + rule ID
  2. 계산: `AVAILABLE 58–62s` vs `REQUIRED 66–68s`
  3. Evidence Trace **정확히 3개** — `SCRIPT` · `CUESHEET` · `STAGE_SPEC` (각 quote + locator + origin + review state)
  4. 제안 문구 — *"이런 상황이 예상되니 확인이 필요합니다"* 수준. 단일 정답을 확정하지 않는다
  5. `DECISION_RECORDED` 단일 액션
  6. **하단 고정: `이 위치로 이동`**
- `이 위치로 이동` → 팝업이 닫히고 큐시트 해당 셀로 스크롤·선택
  - **이동 후에도 해당 셀에 finding 마커가 남아 있어야 한다.** 팝업이 닫혀도 근거가 붙어 있어야 수정할 수 있다

### 히스토리

`저장` 버튼 옆. 데스크톱 컨텍스트 메뉴처럼 뜨는 스크롤 리스트.

- 항목: 저장 시각, 변경 셀 수, 저장자
- **호버 → 미리보기**: 그 저장에서 바뀐 셀만 목록으로 우측에 표시
- **클릭 → 진입**: 해당 시점 상태로 큐시트를 연다
- 셀 수정뿐 아니라 이벤트 행 추가·삭제도 변경 목록과 복원 대상에 포함한다
- 웹에서 우클릭은 브라우저 메뉴와 충돌하므로 **쓰지 않는다**

---

## 상태 색

색은 verdict에만 쓴다. 그 외 전부 그레이스케일.

| 상태 | 색 | 의미 |
|---|---|---|
| `VIOLATION` | 빨강 | 명시된 값이 수학적으로 양립하지 않음 |
| `REVIEW` | 앰버 | 범위가 겹치거나 문서가 다르게 말함 |
| `CONSISTENT` | 초록 | 검토된 제약 범위에서 blocker 0 |
| **`INSUFFICIENT_EVIDENCE`** | **회색** | **판정에 필요한 값이 문서에 없음** |
| `EDITED` | 파랑 | 저장되지 않은 사용자 편집 |

> **회색이 제품의 차별점이다.** 비활성처럼 보이면 안 된다.
> 회색 카드의 팝업은 반드시 *"이 판정에는 X가 필요한데 문서에 없습니다"*를 명시한다.

`CONSISTENT` 초록은 **서버 검증을 통과한 뒤에만** 칠한다.
open finding이 있는 동안 무대 패널은 `EVIDENCE PREVIEW` 모드이며 `FINAL`이라 부르지 않는다.

---

## Components

### Status Token

대문자 모노스페이스, 사각 외곽선. Origin과 Authority는 **별도 토큰**이며 합치지 않는다.

### Technical Table

연회색 헤더, 굵은 라벨, 1px 구분선. 셀 패딩 6/10px.
선택 행은 검은 외곽선. 편집 셀은 `edited-container` 배경.

### Buttons

- Primary: 검정 배경 / 흰 글씨
- Secondary: 흰 배경 / 검정 1px
- Tertiary: 배경 없음 / 호버 시 밑줄
- 결정 UI는 **`DECISION_RECORDED` 하나**. 병렬 3버튼을 두지 않는다

### Shapes & Elevation

모서리 0px. 그림자 없음. 깊이는 톤 레이어와 1px 경계로만 표현한다.
팝업만 예외로 1px 검정 테두리 + 배경 딤 처리.

---

## Layout & Spacing

- 1600×1280 기준 캔버스, 데스크톱 우선
- 헤더 56px, 타임라인 132px, 나머지를 패널 A/B가 균등 분할
- 8px 그리드. 밀집 표 내부만 4px 허용
- 큐시트는 가로 스크롤 허용. **페이지 전체는 가로 스크롤 금지**

## 명시적 제외

5단계 헤더 · 전역/6항목 내비게이션 사이드바 · 좌측 finding 목록 · PROPOSAL Option A/B/C ·
병렬 3버튼 · 별도 Final 2D 화면 · Master v2 재검증 화면 · revision lineage 패널 ·
`EXPORT LOG` · `Source 교체` · 입력 계약 체크리스트 · Zoom 슬라이더 ·
Ctrl+F 검색 · JSON raw 뷰 · 실제 도면 · 연속 scrub 애니메이션 · 비인접 event 경로 animation ·
반복/bounce/particle motion · Agent가 만든 좌표/실제 blocking 경로 · 입력 화면의 Script 업로드 카드

## Upstage Agent 연결 상태

아래 네 Agent는 Studio에서 Config `#1`이 저장됐고 서버 배선도 구현됐다. **Agents API live smoke는 아직
완료하지 않았으므로** 화면의 success/fallback 동작을 운영 검증 완료로 표현하지 않는다.

| Agent | Agent ID | UI에 허용되는 결과 |
|---|---|---|
| Stage Spec Extractor | `agt_PxbxmhXXT8iqdzs5WmHfUz` | `UNREVIEWED` stage fact 후보 |
| Fact Normalizer | `agt_6tn639gGApNdV9SdRfAjnE` | 읽기 전용 추천값 또는 사용자화 초안 |
| Storyboard Recomposer | `agt_go8aoJTVDvEwK8mwXh5gEi` | 읽기 전용 `beats`·`missing_evidence` |
| Rehearsal Brief | `agt_9iLkb7fqwdEtaBv48t9tQA` | 기존 근거를 압축한 접이식 brief |
