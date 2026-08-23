# STANDBY — PRD (Claude 개정판)

| 항목 | 내용 |
|---|---|
| 문서 상태 | v1.1 — 2026-08-23 중간 멘토링·Upstage 확장 방향 반영 |
| 관계 | [PRD.md](PRD.md)의 verifier-first 원칙을 계승하되, **UI 모델과 무대 입력 범위를 대체**한다 |
| 트랙 | Upstage — Automate Paperwork |
| 1차 사용자 | 테크 리허설 전 실행 계획을 취합·검증하는 무대감독 |
| MVP 범위 | 한 장면과 전후 전환 · 화면 2개 |
| 제품 원칙 | Verifier first · Evidence always · Human decides |

> **문서 역할:** 이 문서는 제품 목표와 acceptance를 정의한다. 현재 구현 완료 여부는
> [FEATURE_SPEC_CURRENT.md](FEATURE_SPEC_CURRENT.md)에서 코드 기준으로 관리한다.

---

## 0. 이 문서가 PRD.md에서 바꾸는 것

| 영역 | PRD.md | **이 문서** |
|---|---|---|
| 무대 입력 | stage-spec 도면 fixture | **네모 + 좌우 + 통로 유무 + 초기 세팅** |
| 초기 상태 | 없음 | **`initial_state` 필수 입력 신설** |
| 화면 | `입력·검토` + `Finding·2D` | **`입력` + `워크스페이스`** |
| Finding 표시 | 좌측 목록 | **타임라인 카드 색 + 팝업** |
| 큐시트 | source drawer 인용 | **메인 패널 · 편집 가능** |
| 수정 반영 | 외부 수정 후 재업로드만 | **앱 내 편집 → 저장 → 재검증** |
| 제안 | P0 제외 (Stretch) | **팝업 안 문구 수준으로 P0 복귀** |

계승하는 것: verdict 3종 체계, 근거 강제, reviewed fact만 판정에 사용, `INSUFFICIENT_EVIDENCE` 기권, 결정론적 verifier, AI가 verdict를 바꾸지 못한다는 원칙.

---

## 1. 제품 요약

> **STANDBY는 대본·큐시트·무대 사양을 한 공연 순서로 대조해 시간·동선·상태·큐가 서로 모순되는 지점을 리허설 전에 찾고, 원문 근거와 2D 무대 위에서 재현하는 공연 프리플라이트 검증기다.**

### 결론의 범위

사고를 예측하지 않는다. 확인된 입력을 기준으로 세 가지만 말한다.

| verdict | 의미 |
|---|---|
| `VIOLATION` | 명시된 시간·경로·상태가 수학적으로 양립하지 않음 |
| `REVIEW` | 범위가 겹치거나 문서가 서로 다르게 말함 |
| `INSUFFICIENT_EVIDENCE` | 판정에 필요한 값이 문서에 없음 |

**세 번째가 제품의 정체성이다.** 모르면 모른다고 말하고, 무엇이 없어서 모르는지 밝힌다.

---

## 2. 세 논리 역할과 현재 MVP 입력

제품 검증 모델은 `SCRIPT`·`CUESHEET`·`STAGE_SPEC` 세 역할을 구분한다. 다만 현재 MVP의 물리 입력 슬롯은
`MASTER_CUE` 파일과 `STAGE_SPEC` 폼 두 개다. **입력 화면에 세 번째 SCRIPT 카드를 다시 만들지 않는다.**
workspace의 대본 보기는 패널 안에서 DOCX(우선) 또는 PDF(보조)를 연결해 Upstage가 구조화한 실제
대사·지문만 사용한다. 사용자에게 대본 JSON을 요구하지 않는다.

### 2-1. 대본 (SCRIPT)

- 대사, 지시문, 등·퇴장, 씬 구분
- 씬별 길이와 누적 타임코드 (레퍼런스 대본에 이미 존재)
- 화자는 **배역명**으로 기재됨 → 큐시트의 배우명과 매핑 필요
- 위 원문 대본은 입력 화면의 세 번째 카드가 아니라 Script Sidebar에서 연결한다. 서버의 Script Extractor가
  `standby.script-projection.v1`을 만들며, exact event ID가 없는 구간은 사람이 현재 event에 연결한다

### 2-2. 큐시트 (CUESHEET)

- 부서별 큐가 한 표에 모인 마스터
- 대사 트리거, 환복시간, 소품 반출입, 상하수 이동
- 화자는 **배우명**으로 기재됨
- MASTER_CUE의 XLSX·PDF·JSON은 Upstage가 구조화한 뒤 fact review를 거친다
- 별도 `RAW JSON` 입력은 이미 STANDBY CueSheet 계약을 만족하는 테스트·연동용 데이터만 받으며,
  strict validation 후 즉시 Editor로 열고 동일 데이터를 Agent로 재추출하지 않는다

### 2-3. 무대 사양 (STAGE_SPEC) — MVP 최소 요구 ★

**도면을 받지 않는다.** MVP의 목적은 정밀 계측이 아니라 **육안 확인**이다.
받아야 하는 것은 네 가지뿐이다.

| 필드 | 내용 | 예 |
|---|---|---|
| `wings` | 상수 / 하수 존재 | `[상수, 하수]` |
| `crossover` | 백스테이지 통로 유무 | `true` / `false` / `UNKNOWN` |
| `route_times` | 존 간 이동 시간 범위 | `하수윙→환복소 3–4초` |
| **`initial_state`** | **시작 시점 배치** | 아래 |

#### `initial_state` — 신설 필수 입력

현업 용어로 **프리셋 리스트(preset list)**다. 이것이 없으면 소품 연속성을 판정할 수 없다.

```json
{
  "actors":   [{ "id": "혜원", "start_zone": "하수윙" }],
  "props":    [{ "id": "마루가방", "start_zone": "하수윙" }],
  "costumes": [{ "actor": "혜원", "item": "25살 잠옷", "stored_zone": "하수환복소" }]
}
```

**좌우 구분만 하면 된다.** 백스테이지 내부 구조, 정확한 좌표, 면적은 받지 않는다.

#### 왜 도면을 뺐는가

- PRD의 `SCHEMATIC / NOT TO SCALE` 원칙과 네모가 정확히 일치한다
- hero finding의 `route 3–4초` · `minimum change 60초` · `window 58–62초`는 전부 **숫자 입력값**이지 도면 측정값이 아니다. **도면 없이도 판정이 그대로 성립한다**
- 도면을 쓰면 AI가 CAD geometry를 확정한다는 오해를 산다

#### 언제 도면이 필요해지는가 — 향후 제품

**소품, 특히 대도구의 무대 위 위치는 인력 산정과 직결된다.** 큰 세트를 빼내려면 몇 명이 붙어야 하는지가 위치에서 나온다. 배우 동선보다 소품 위치가 실무 영향이 크다.
그 단계에서 실제 도면과 좌표값 입력이 정당해진다. **MVP 범위는 아니다.**

---

## 3. 검증 규칙

P0는 세 규칙 + 기권 규칙이다.

### VR-01. Quick-change feasibility

필요 fact: 이전 퇴장 시각·위치 / 다음 입장 시각·위치 / 환복 위치 / 최소 환복시간 / route time

```
required  = route(퇴장위치→환복소) + minimum_change + route(환복소→입장위치)
available = 다음 입장 시각 − 이전 퇴장 시각
```

| 조건 | verdict |
|---|---|
| 두 범위가 겹치지 않고 required > available | `VIOLATION` |
| 범위가 겹침 | `REVIEW / QUICK_CHANGE_TIGHT` |
| 필요 fact 하나라도 없음 | `INSUFFICIENT_EVIDENCE` |

### VR-02. Blocking / route conflict

- 같은 route를 capacity를 넘겨 동시 점유하면 `VIOLATION`
- **`crossover=false`인데 반대편 재등장이 필요하면 `VIOLATION`**
- `crossover=UNKNOWN`이면 `INSUFFICIENT_EVIDENCE`. 통로가 있다고 가정하지 않는다

### VR-03. Prop continuity

- `initial_state`에서 시작해 반입·반출·이동·인계를 상태 전이로 추적
- 다음 사용 위치까지 이어지는 경로가 없으면 `POSSIBLE_PROP_GAP` → `REVIEW`
- **이동 담당자가 명시되지 않은 좌우 교차는 `REVIEW`.** `VIOLATION`이 아니다 — 암묵적 인계가 있을 수 있다

> 레퍼런스 큐시트의 `상하수 이동` 열은 46행 중 1행만 채워져 있고, 그 1행이
> `마루 가방만 / 하수→상수 / (N7 전까지) / 남다현 담당`이다.
> 무대감독이 사람 머리로 찾아낸 결과다. 우리가 자동화하는 것이 정확히 그 사고 과정이다.

### VR-00. Abstention (기권)

필요 fact가 하나라도 없으면 물리 판정을 시도하지 않는다.
**어떤 fact가 없어서 판정하지 못했는지를 반드시 명시한다.**

---

## 4. Finding 계약

```json
{
  "finding_id": "...",
  "rule_id": "VR-01",
  "verdict": "VIOLATION | REVIEW | INSUFFICIENT_EVIDENCE",
  "event_id": "E3",
  "calculation": { "available": "58-62s", "required": "66-68s" },
  "missing_facts": [],
  "evidence": [
    { "role": "SCRIPT",     "locator": "...", "quote": "...", "origin": "...", "review_state": "..." },
    { "role": "CUESHEET",   "locator": "...", "quote": "...", "origin": "...", "review_state": "..." },
    { "role": "STAGE_SPEC", "locator": "...", "quote": "...", "origin": "...", "review_state": "..." }
  ],
  "target_locator": { "sheet": "...", "row": 43, "field": "환복시간" },
  "suggestion_text": "확인이 필요합니다 …"
}
```

- **evidence는 항상 세 role 모두**를 담는다. 비면 `INSUFFICIENT_EVIDENCE`다
- `suggestion_text`는 확인 요청 문구다. **단일 정답값을 확정하지 않는다**
- `target_locator`는 `이 위치로 이동`의 목적지다
- AI는 `suggestion_text`만 생성한다. `verdict` · `calculation` · `evidence`는 코드가 만든다

---

## 5. 화면 — 두 개

### 화면 1 — 입력

세 문서를 받고 역할을 확정한다. `STAGE_SPEC`은 파일 대신 **폼 입력**을 허용한다.
심사위원·첫 사용자가 별도의 큐시트를 갖고 있지 않아도 흐름을 시작할 수 있게
`MASTER_CUE` 카드에 **예시 큐시트 첨부** 버튼을 둔다. 버튼은 제품에 포함된 통제 샘플을
실제 `File` 입력처럼 로드하며, origin은 `CONTROLLED_FIXTURE`로 남겨 실제 공연 문서와 구분한다.

### 화면 2 — 워크스페이스 (메인)

```
헤더 56px
──────────────────────────
패널 A   무대 또는 큐시트     ← 높이 동일
──────────────────────────
패널 B   큐시트 또는 무대     ← 스왑 가능
──────────────────────────
이벤트 타임라인 E1…E8  132px
```

**세 패널은 하나의 상태를 세 방식으로 보여준다.**

```
타임라인 E3 선택 → 큐시트 해당 행 하이라이트 → 무대에 그 시점 배치
큐시트 셀 편집   → 영향 이벤트 표시 변경     → 무대 상태 갱신
```

한 값을 건드리면 세 곳이 동시에 반응한다. 이것이 컴파일러 서사의 시각적 실체다.

상세 UI 계약은 [`Lo-Fi/standby/DESIGN.md`](../Lo-Fi/standby/DESIGN.md)를 따른다.

### 시뮬레이터는 읽기 전용이다 ★

시뮬레이터에서 노드를 끌어 배치하는 편집은 **검토 후 폐기했다.**
E6에서 퇴장한 배우를 E9에서 무대로 끌어오면 그것은 **새 이벤트를 만드는 행위**이고,
트리거도 이벤트 번호도 정할 수 없다. 시뮬레이터가 이벤트 생성자가 되는 순간
편집 경로가 둘이 되어 **원본 불변 + revision layer 모델이 깨진다.**

> **편집은 큐시트에서만. 시뮬레이터는 결과를 비추는 거울이다.**

`initial_state`도 큐시트에서 도출한다. 시뮬레이터에서 손으로 세팅하지 않는다.

### 이벤트별 무대 상태 모델과 절제된 의미 전환

각 이벤트의 정본은 그 시점의 **정적 스냅샷**이다. 애니메이션은 새 상태를 만들거나 실제 blocking
경로를 추정하는 기능이 아니라, 검증된 두 스냅샷 사이에서 **무엇이 바뀌었는지 읽게 하는 짧은 전환**이다.

다만 정적 스냅샷만으로는 *"언제 퇴장했는지"*를 알 수 없으므로,
**그 이벤트에서 일어난 동작**을 노드 상태로 표시한다.

```ts
type Zone = "상수윙" | "무대" | "하수윙" | "하수환복소";
type Transition = "ENTER" | "EXIT";

type EntityStateAtEvent = {
  zone: Zone;
  transition?: Transition;   // 이 이벤트에서 일어난 동작. 없으면 그대로 있는 것
};

// 이벤트별 스냅샷 — 시뮬레이터의 유일한 입력
type StageSnapshots = Record<EventId, Record<EntityId, EntityStateAtEvent>>;
```

| `transition` | 표시 |
|---|---|
| `ENTER` | 무대 쪽(안쪽) 화살표 + `등장` |
| `EXIT` | 윙 쪽(바깥쪽) 화살표 + `퇴장` |
| 없음 | 화살표 없음 |

화살표 방향은 **좌/우 절대방향이 아니라 `무대 쪽 / 윙 쪽`**으로 정의한다.
상수는 화면 왼쪽, 하수는 오른쪽이므로 절대방향으로 정의하면 양쪽이 뒤집혀 혼동한다.

`ENTER`/`EXIT`는 `--enter: #22c55e` / `--exit: #ef4444`를 쓴다. MVP에서 색각 대응은 범위 밖이다.
verdict 색은 저채도 파스텔이라 정상 시야에서 구분되지만, **방향과 라벨이 여전히 주 신호**다.
(접근성을 다룰 때는 단일 색 + 방향·채움·라벨 3중 인코딩으로 되돌린다 — 측정상 보색 쌍은 존재하지 않는다.)

#### 허용되는 motion

- 시간순으로 **인접한 검증 event**를 앞/뒤로 이동할 때만, 두 snapshot에서 zone이 달라진 entity를
  180–360ms로 이동·등장·퇴장시킨다. 한 전환의 총 motion은 600ms를 넘지 않는다.
- AI가 좌표·곡선·보행 경로를 만들지 않는다. UI가 `from_zone → to_zone`의 schematic 차이만 표현한다.
- 여러 event를 건너뛰거나 과거로 크게 점프하면 이동 경로를 꾸미지 않고 정적 교체 또는 180ms 이하
  crossfade만 사용한다.
- 반복·bounce·particle·상시 pulse는 금지한다. 바뀐 entity와 현재 playhead만 움직인다.
- `prefers-reduced-motion`에서는 모든 전환을 정적 교체로 바꾼다.

### Upstage Agent 확장 — Studio 설정·서버 배선 구현, live smoke 대기

기존 Script/Master Cue 추출 외에 **네 Agent**를 추가한다. Studio에는 아래 Agent가 모두 Config `#1`로
저장됐고 서버 provider·strict contract·API 배선도 구현됐다. 아직 각 Agent의 실제 Agents API 응답을 확인하는
live smoke는 끝나지 않았으므로 운영 검증 또는 배포 완료라고 발표하지 않는다.

| Agent | Agent ID | Config | 현재 상태 |
|---|---|---:|---|
| Stage Spec Extractor | `agt_PxbxmhXXT8iqdzs5WmHfUz` | `1` | Studio 설정 · 서버 배선 구현 · live smoke 대기 |
| Fact Normalizer | `agt_6tn639gGApNdV9SdRfAjnE` | `1` | Studio 설정 · 서버 배선 구현 · live smoke 대기 |
| Storyboard Recomposer | `agt_go8aoJTVDvEwK8mwXh5gEi` | `1` | Studio 설정 · 서버 배선 구현 · live smoke 대기 |
| Rehearsal Brief | `agt_9iLkb7fqwdEtaBv48t9tQA` | `1` | Studio 설정 · 서버 배선 구현 · live smoke 대기 |

| Agent | 입력 | 출력 | trigger | cache | trust boundary |
|---|---|---|---|---|---|
| **Stage Spec Extractor** | 사용자가 확인한 stage-spec 문서 또는 폼 JSON의 임시 전송본 | locator·quote가 붙은 `stage_facts` 후보 | source extraction 시작 시 | source SHA-256 + Agent/Config ID + request-body hash | 전부 `UNREVIEWED`. route·시간·capacity·초기 상태를 추출할 뿐 verdict·좌표·경로를 만들지 않음 |
| **Fact Normalizer** | Script/Master Cue/Stage Spec의 raw extracted fact와 allowlist된 normalized schema | `NON_AUTHORITATIVE` normalized type·value 추천과 source fact ref | extraction 성공 뒤 review queue를 열기 전 | raw fact-set digest + schema version + Agent/Config ID + input hash | 추천은 자동 승인되지 않음. duration을 추정하지 않고 명시된 시간 범위만 보존. strict semantic validation 뒤에도 사람이 승인/거절해야 함. verdict·review state 변경 금지 |
| **Storyboard Recomposer** | reviewed event graph, 인접한 두 snapshot, allowlist된 action·source ref | event별 읽기 전용 `NON_AUTHORITATIVE` `beats`·요약·`missing_evidence` | reviewed workspace에서 timeline event가 바뀔 때 비동기 실행; 동일 frozen input은 서버 cache 사용 | review snapshot + revision + from/to event + Agent/Config ID + input hash | event/entity/zone/fact ID를 서버가 strict 검증. 검증 실패·timeout이면 정적 snapshot으로 fallback. deterministic snapshot·verdict·source 변경 금지 |
| **Rehearsal Brief** | reviewed graph와 결정론적 finding·calculation·missing fact·evidence ref | 무대감독용 요약, event/department별 확인 질문, unknown 목록 | verifier result가 새로 만들어질 때 | verifier result hash + locale + Agent/Config ID + input hash | 새 finding·severity·안전 결론을 만들지 않음. 기존 근거를 짧게 설명하는 읽기 전용 산출물 |

`추출 결과 확인(Extraction Review)`은 목록 전체에 적용되는 `추천값`과 `사용자화` 두 mode를 가진다. fact card마다 mode를
반복하지 않고, 한 번에 한 fact만 표시해 Extracted Fields 옆 좌우 chevron으로 이동한다. 승인·제외 뒤에는 다음 fact로 이동한다.
유효한 Upstage 추천이 없는 fact도 진행을 막지 않는다. 사용자가 `확인하고 다음`을 누르면 해당 fact를
`REJECTED`로 기록해 판정 authority에서 제외하며, 빈 추천값을 임의의 normalized fact로 승인하지 않는다.
추천 mode는 별도의 `Upstage Agent Recommendation` 패널을 표시하지 않고 원문 근거와 Extracted Fields만
검토 대상으로 보여 준다. 내부적으로 사용되는 normalized 추천은 승인 record의 provenance로만 남긴다. 사용자화 mode에서는
normalized type은 Agent가 고른 allowlist 값으로 고정하고 필드 값만 사람이 고친다. 정규화 type selector는
두지 않으며, type이 잘못되면 다른 type을 임의 선택하지 않고 해당 추천을 거절한다. `일괄 승인`은 검증을
통과한 사용자화 draft에만 사람이 명시적으로 누르는 bulk action이며, 각 fact의 개별 review record를 남긴다.
어떤 mode도 자동 승인하거나 review snapshot을 자동 freeze하지 않는다.
Fact Normalizer의 background 상태와 미결정 fact 수는 workspace 진입을 막지 않는다. 사용자가 `큐시트로 이동`을
누르면 현재 결정만 snapshot에 기록하고, 남은 fact는 `UNREVIEWED`로 유지해 관련 규칙이 `INSUFFICIENT_EVIDENCE`로 기권한다.

Storyboard는 timeline 클릭마다 긴 Upstage job을 동기 대기하지 않는다. 클릭 순간 target snapshot을 먼저
보여 주고, frozen input으로 비동기 재구성을 요청한다. 동일 요청은 서버 cache가 처리한다. 현재 구현은
인접 pair 사전 생성이 아니라 **선택 시 lazy 실행**이며, 늦게 도착한 이전 event 응답은 현재 선택을 덮을 수 없다. 화면에 보이는 `beats`와
`missing_evidence`는 읽기 전용 보조 결과이며, 정적 snapshot과 deterministic verdict가 언제나 정본이다.

구조화 JSON도 XLSX/PDF와 같은 case upload·review 경로로 수렴한다. 대본 DOCX/PDF는 workspace의
Sidebar에서 현재 case의 `SCRIPT` source로 연결하며, 새 raw fact는 `UNREVIEWED`로 review queue에 합류한다.
새 source digest로 snapshot을 다시 freeze하기 전에는 기존 verified workspace를 계속 사용하지 않는다.
향후 preview Agent를 붙이더라도 `PREVIEW / NON_AUTHORITATIVE`이며 verified workspace나 세 근거를 갖춘 finding으로 승격하지 않는다.
공개 CueSheet JSON에는 `estimated_duration_sec`와 `costume_change_duration_sec`를 두지 않는다. 시간 관련
verdict는 Agent가 장면 길이를 추정해서 만드는 대신, reviewed fact의 명시적 min/max 근거가 있을 때만 계산한다.

추출을 기다리는 동안에는 JetBrains Mono의 `S T A N D B Y` 글자가 `S`부터 `Y`까지 순서대로 밝아지는
loading scene을 사용한다. 이 loop는 실제 진행률이 아니며 상태·실패·timeout 문구를 대체하지 않는다.
본문과 조작 UI는 시스템 서체를 사용하고, JetBrains Mono는 로고와 loading wordmark에만 남긴다.
`prefers-reduced-motion`에서는 순차 밝기 변화를 중지하고 고정 wordmark를 표시한다.

### Script Sidebar — 읽기 전용 timeline 연결

- 워크스페이스 내부 좌측에서 접고 펼치는 보조 패널이다. 전역 내비게이션이나 세 번째 화면이 아니다
- 입력 화면에 SCRIPT 카드를 추가하지 않는다. 패널에서 DOCX(우선) 또는 PDF(보조)를 연결하고, 서버가
  Upstage Script Extractor 결과를 strict `standby.script-projection.v1`으로 투영한다
- projection과 raw fact는 현재 case ID에 귀속된다. 새 대본 연결은 기존 snapshot을 무효화하고 Fact Review로
  돌아가며, 사람이 새 snapshot을 freeze한 뒤에만 SCRIPT가 세 근거 중 하나로 사용된다
- RAW JSON 로컬 Editor에서는 standalone Script Projection을 사용한다. 이 projection은 JSON의 exact
  `event_id` 또는 유일한 장면명 일치로 자동 연결하고, 나머지는 사람이 현재 event에 연결한다. case review
  authority는 얻지 않지만 연결 결과를 표준 CSV 큐시트에 대사·지문 열로 내보낼 수 있다
- 자동 연결되지 않은 projection 구간은 장면 표기·화자·대사/트리거 토큰·공연 순서를 조합한 추천 event와
  신뢰도·근거를 표시한다. `추천 모두 적용`은 사람이 명시적으로 누른 bulk mapping이며 자동 승인이 아니다
- exact `event_id`가 있거나, Script Extractor가 원문에서 보존한 `section_marker`가 큐시트의 장면명과
  유일하게 일치하는 실제 `DIALOGUE`·`STAGE_DIRECTION`만 자동으로 event별 발췌에 묶는다.
  근거가 없거나 둘 이상과 일치하는 구간은 사람이 선택한 현재 event에 연결한다
- MASTER_CUE trigger·note, finding evidence, reviewed event label을 대본 fallback으로 표시하지 않는다
- 대본은 event별로 재배열하지 않고 원문 `sequence_index` 순서를 모두 유지한다. timeline event 선택은
  연결된 첫 구간으로 스크롤하고 해당 구간들을 강조하며, 대본 구간 선택은 동일 event로 이동한다
- 발췌는 수정할 수 없고 localStorage에 남지 않으며 fact·review·snapshot·verdict를 만들거나 바꾸지 않는다


---

## 6. 큐시트 편집 모델 ★

PRD.md는 외부 수정 후 재업로드만 허용했다. **이 문서는 앱 내 편집을 P0로 승격한다.**

### 불변식

> **업로드된 원본 파일은 절대 변하지 않는다.**
> 편집은 원본 위에 쌓이는 revision layer다.

Git 비유가 정확하다.

| Git | STANDBY |
|---|---|
| 초기 커밋 | 업로드된 원본 (hash 고정) |
| 워킹 디렉토리 변경 | 편집한 셀 (`EDITED` 색) |
| `git add` 취소 | 셀 되돌리기 / 모든 변경 취소 |
| 커밋 | `저장` → 새 local revision |
| `git log` | 히스토리 |

### 규칙

1. 편집은 즉시 셀에 표시된다. 저장 전까지 **verdict를 바꾸지 않는다**
2. `저장`이 새 revision을 만들고, 그때 **재검증이 돌아 verdict가 갱신**된다
3. 원본 파일 hash는 어떤 경우에도 변하지 않는다. revision은 `parent_revision_id`로 연결된다
4. `CONSISTENT`는 현재 revision에서 blocker가 0일 때만 켜진다
5. 히스토리 항목은 저장 시각·변경 셀 수·저장자를 갖고, 호버 시 **변경 셀만** 미리 보여준다
6. 이벤트 행 추가·삭제도 cell edit과 같은 append-only revision으로 기록한다. 저장 전에는 verdict를 바꾸지 않는다

### 왜 바꿨는가

편집→저장→재검증이 앱 안에서 닫혀야 **"고치면 판정이 뒤집힌다"**를 보여줄 수 있다.
이것이 팀 문제정의 3번(*수정 시 연쇄 꼬임과 암산의 한계*)에 답하는 유일한 경로다.

---

## 7. MVP Acceptance

| # | 항목 | 합격 기준 |
|---|---|---|
| A1 | 현재 MVP 입력 수용 | MASTER_CUE PDF·XLSX·JSON + stage spec 폼. workspace에서 SCRIPT DOCX 우선·PDF 보조 연결 |
| A2 | Upstage 추출 | Parse → Classify → 유형별 Extract가 hero fact와 source quote 반환 |
| A3 | 사람 검토 | 핵심 fact와 event link를 사람이 승인. 미승인 값은 판정에 쓰이지 않음 |
| A4 | hero 판정 | `VR-01`이 `AVAILABLE 58–62s` vs `REQUIRED 66–68s`로 `VIOLATION` |
| A5 | 기권 | route 또는 minimum change를 제거하면 `INSUFFICIENT_EVIDENCE`로 내려감 |
| A6 | clean control | 정상 fixture에서 finding 0건 |
| A7 | 근거 | 모든 finding이 세 role의 quote + locator를 보유 |
| A8 | 3패널 동기화 | 타임라인 선택이 큐시트·무대에 동시 반영 |
| A9 | 팝업 → 이동 | `이 위치로 이동`이 큐시트 해당 셀로 이동하고 마커가 유지됨 |
| A10 | 편집 왕복 | 셀 편집 → 저장 → 재검증으로 verdict 변화 |
| A11 | 히스토리 | 저장 이력 조회 + 변경 셀 미리보기 |
| A12 | 결정론 | 같은 입력 3회에서 verdict와 calculation 동일 |
| A13 | fallback | API 장애 시 캐시된 성공 응답으로 데모 지속 |
| A14 | Agent coverage | Stage Spec Extractor·Fact Normalizer·Storyboard Recomposer·Rehearsal Brief가 각자 고정 input/output contract와 provenance를 남김 |
| A15 | 절제된 motion | 인접 verified snapshot만 의미 전환, jump/back·reduced-motion은 정적/crossfade, Agent 실패 시 snapshot fallback |
| A16 | Agent 관측성 | file upload·job submit·poll·decode·review-ready와 후처리 Agent별 duration/cache/outcome을 원문 없이 추적하고 timeout 병목을 구분 가능 |
| A17 | Script 연동 | timeline 선택이 MASTER_CUE 기반 읽기 전용 발췌를 스크롤·강조하고, 발췌 선택이 같은 event로 이동 |

**A4·A5·A6·A7이 최우선이다.** 나머지가 반쯤 되어도 이 넷이 되면 발표가 성립한다.

---

## 8. 명시적 비목표

- 실제 도면 · CAD geometry · 좌표 계산
- 사고 확률 예측
- 배우 무대 위 미세 blocking
- 전체 85분 공연 타임라인
- 부서별 큐시트 자동 생성 (숙련 무대감독은 엑셀 링크로 이미 자동화)
- 마스터 vs 여러 부서 사본 동시 비교
- 손글씨 의미 추출
- 연속 scrub·비인접 event 경로 애니메이션 · 장식 motion · Ctrl+F 검색 · JSON raw 뷰

---

## 9. 리스크

| 리스크 | 대응 |
|---|---|
| 큐시트 17열 파싱 실패 | hero 구간 XLSX/PDF로 축소. 사진 입력 포기 |
| 셀 내부 줄바꿈 손실 | 셀 단위 재파싱 또는 Extract에 줄 분리 위임 |
| 3패널 밀도 초과 | 큐시트 기본 표시 열을 7개로 제한, 나머지는 토글 |
| 편집→재검증 미완성 | A10을 내리고 A4~A7로 데모 구성 |
| API 장애 | 성공 응답 캐시 (A13) |
| 회색이 비활성으로 보임 | `INSUFFICIENT_EVIDENCE` 팝업에 결측 fact 명시 (A5) |
| Storyboard가 실제 동선을 꾸밈 | reviewed snapshot/action allowlist 밖 출력 거절, jump/back은 정적 교체 |
| Agent latency가 timeline을 막음 | snapshot 선반영 + frozen-input cache, miss/timeout은 비차단 정적 fallback |

---

## 10. 엑셀 왕복 · Refresh · Upstage 지속 활용

> 2026-08-22 추가. 이 세 가지는 별개 기능이 아니라 **하나의 축**이다 —
> 큐시트는 한 번 검증하고 끝나는 문서가 아니라 리허설마다 바뀌는 살아있는 문서다.

### 10-1. 왜 Export가 포지셔닝의 완성인가 ★

[DOMAIN.md](DOMAIN.md)는 이미 결론을 갖고 있다.

> 경쟁 도구(Stage Write · Propared · Rundown Studio)는 전부 **자기 툴로 이주**를 요구한다.
> STANDBY의 차별점은 **"아무것도 안 바꿔도 됨"**이다.
> *"엑셀을 버리게 하는 제품은 실패한다. 엑셀을 그대로 먹는 제품이 이긴다."*

**그런데 현재 STANDBY는 엑셀을 먹기만 하고 돌려주지 않는다.**

무대감독이 STANDBY에서 환복시간을 고쳤다고 하자. 그걸 조명팀·음향팀·소품팀에 어떻게 배포하나?
현장의 배포 수단은 인쇄물과 공유 드라이브의 엑셀이다. 돌려줄 수 없으면 **STANDBY가 종착지**가 되고,
종착지가 된다는 건 곧 **이주를 요구하는 것**이다. 우리가 비판한 바로 그 자리에 서게 된다.

> **Export는 기능 추가가 아니라, 우리가 주장한 차별점을 실제로 성립시키는 마지막 조각이다.**

### 10-2. 엑셀 왕복 계약

```
XLSX in  →  Parse · Extract  →  검증 · 편집  →  XLSX out
 (원본)      Upstage Studio      STANDBY        (부서 배포용)
```

| 규칙 | 내용 |
|---|---|
| **원본 보존** | 업로드된 원본 파일과 hash는 변하지 않는다. export는 항상 **새 파일** |
| **최소 변경** | 사람이 고친 셀만 바뀐다. 열 구성·시트 이름·서식을 임의로 재배치하지 않는다 |
| **공백 구조 보존** | 원본의 빈 행·빈 열·셀 간 간격을 유지한다. 이벤트 행 추가·삭제가 아닌 공백 정리나 압축은 하지 않는다 |
| **이벤트 행 변경** | 추가·삭제는 revision의 명시적 row operation으로 기록하고 export에만 반영한다 |
| **변경 가시성** | export된 시트에서 수정 셀을 식별할 수 있어야 한다 (셀 노트 또는 별도 변경 이력 시트) |
| **왕복 안정성** | export한 파일을 다시 import하면 같은 fact가 나와야 한다 |
| **판정 미포함** | verdict는 문서에 쓰지 않는다. 큐시트는 실행 문서지 검증 리포트가 아니다 |

### 10-2-1. 표준 실행본

원본 왕복본과 별도로 같은 revision에서 **하나의 표준 cue 양식**을 만든다. EVENT·TRIGGER·DEPARTMENT·
ACTION·CAST·LOCATION·NOTES 순서를 Word와 PDF에서 동일하게 유지하고, 값이 없는 칸은 삭제하지 않고
밑줄 빈칸으로 남긴다. Word는 `.docx`, PDF는 같은 인쇄 HTML을 브라우저의 PDF 저장으로 출력한다.
두 실행본에도 verdict는 포함하지 않는다.

RAW JSON Editor의 표준 CSV는 같은 이벤트·액션 행에 매핑된 `SCRIPT_KIND`·`SPEAKER`·`SCRIPT_TEXT`·
`SCRIPT_LOCATOR`를 추가한다. 자동·수동 연결이 끝난 대본 구간만 들어가며, 미연결 구간을 임의 배치하지 않는다.

마지막 항목이 중요하다. 큐시트에 `VIOLATION`을 찍어 배포하면 현장이 혼란스러워진다.
판정은 STANDBY 안에 남고, 나가는 것은 **합의된 실행 값**뿐이다.

### 10-3. Refresh — 일회성 검사기에서 지속 감시기로

DOMAIN.md §2가 근거다.

> *"이 전 과정에서 큐시트는 계속 수정된다. 최종본은 공연 전날 확정."*

큐시트는 페이퍼 테크 → 드라이 테크 → 큐투큐 → 테크 → 드레스를 거치며 **매번 바뀐다.**
따라서 "한 번 업로드하고 한 번 검증한다"는 모델은 현장과 맞지 않는다.

Refresh는 제품의 성격을 바꾼다.

| | 현재 | Refresh 이후 |
|---|---|---|
| 모델 | 일회성 배치 | 지속 감시 |
| 비유 | 로컬에서 린터 한 번 | **CI가 커밋마다 도는 것** |
| 사용 시점 | 업로드 직후 | 리허설 사이 매번 |

**MVP에서는 자동 폴링을 만들지 않는다.** `재검증` 버튼 + 원본 hash 비교로 충분하다.
Refresh rate를 사용자가 조절하는 UI는 P2 이후다.

### 10-4. Refresh 도중 Upstage 지속 활용

트랙 평가 항목(*"Studio와 API를 얼마나 깊이 활용했는가"* 30점)에 직결된다.

현재 워크플로우는 Upstage를 **한 번만** 부른다. Refresh 사이클이 생기면 갱신마다 다시 부른다.

> **"데모를 위해 한 번 호출하는 것이 아니라, 제품이 살아있는 동안 계속 호출합니다."**

다만 두 가지 제약을 반드시 건다.

**① hash 기반 캐시 — 크레딧 보호**

원본 hash가 그대로면 재파싱하지 않는다. 바뀐 문서만 Parse·Extract를 다시 태운다.
이 규칙이 없으면 refresh 빈도 × 페이지 수만큼 크레딧이 소모된다.

**② 새 fact는 자동으로 판정에 들어가지 않는다 — 원칙 보호**

이게 가장 중요한 설계 제약이다. 제품 원칙은 *"승인된 fact만 verifier에 들어간다"*이다.
Refresh가 만들어낸 새 fact를 자동으로 판정에 넣으면 **Human decides 원칙이 깨진다.**

```
Refresh → 새 fact 추출 → UNREVIEWED 상태로 대기 → 사람이 승인 → 그때 판정에 반영
```

승인 전에는 해당 항목이 `INSUFFICIENT_EVIDENCE`로 남는다. 이것이 올바른 동작이다.

### 10-5. 우선순위

| 순위 | 항목 | 근거 |
|---|---|---|
| **1** | **XLSX export** | 포지셔닝 완성. 독립 구현 가능하고 서사 가치가 가장 크다 |
| 2 | XLSX import | dropzone UI는 이미 있다. 실제 파싱은 Upstage 경로라 무겁다 |
| 3 | 재검증(refresh) 버튼 + hash 비교 | 개념이 핵심이나 MVP 구현은 얇아도 된다 |
| 4 | Refresh rate 설정 UI | P2 이후 |

시간이 부족하면 **1번만 해도 서사가 닫힌다.** *"받은 엑셀을 그대로 돌려드립니다."*

---

## 11. 관련 문서

- [`Lo-Fi/standby/DESIGN.md`](../Lo-Fi/standby/DESIGN.md) — UI 계약 (이 문서와 함께 개정)
- [PRD.md](PRD.md) — 이전 판. verifier 원칙·Finding 계약의 상세 서술은 여전히 유효
- [UPSTAGE_PLAYBOOK.md](UPSTAGE_PLAYBOOK.md) — Studio 적용법·smoke test
- [SCRIPT_INTEGRATION.md](SCRIPT_INTEGRATION.md) — 대본↔큐시트 연결 검증 결과
- [DOMAIN.md](DOMAIN.md) — 현업 워크플로우 근거
