# STANDBY — 데모 비디오 촬영 명세

> 보존 기록: 이 문서는 이미 끝난 촬영의 재현 명세다. R0 이후 **운영 production**에는 아래 SHA fast path와
> JSON Editor 직행이 존재하지 않는다. 영상 재현용 fast path는 운영판과 분리한 Vercel 고정 스냅샷에서만
> 제공하며 실제 Upstage 분석이나 공연 안전 판정으로 설명하지 않는다.

| 항목 | 값 |
|---|---|
| 목표 길이 | 75초 기준 |
| 데모 URL | `https://standby-demo-junctionx.vercel.app` |
| 고정 스냅샷 | `b9208a4` — Git 자동배포 없음 |
| 입력 파일 | 팀이 승인한 reference XLSX (`SHA-256 f8a8d43d…c0419`) |
| 촬영 해상도 | 1600×1000 이상, 브라우저 확대 100% |
| 핵심 서사 | 문서를 넣는다 → 충돌 지점을 본다 → Event로 이동한다 → 큐를 고친다 |

## 촬영 전 체크

1. 새 시크릿 창 또는 localStorage를 비운 브라우저에서 데모 URL을 연다.
2. 언어를 `ENG`로 한 번 전환한 뒤 `KOR`로 돌아와 국제대회 대응을 짧게 확인한다.
3. reference XLSX를 Finder의 Downloads 첫 화면에 둔다.
4. Stage Spec의 빈 초기 배치 행은 건드리지 않는다. fast path는 reference hash만 사용한다.
5. 화면 녹화는 마우스 포인터 표시, 알림·메신저 숨김, 오디오는 별도 녹음한다.

## 75초 원테이크 샷리스트

| 시간 | 화면 동작 | 내레이션 핵심 |
|---:|---|---|
| 0–7s | 입력 화면. MASTER CUE에 XLSX 첨부 | “현장에서 쓰던 마스터 큐시트를 그대로 넣습니다.” |
| 7–12s | `Upstage Fact 추출 시작` 클릭. `S T A N D B Y` 점등 | “STANDBY가 공연 문서를 event 단위로 구조화합니다.” |
| 12–23s | workspace E1. 무대·큐시트·timeline 한 화면 | “한 공연 순서를 표, 무대 상태, timeline으로 함께 봅니다.” |
| 23–35s | E5 클릭 → ERROR popup | “소품이 반대편에서 다시 등장하지만 이동 경로가 없습니다.” |
| 35–43s | `이 Event로 이동` → 해당 큐/셀 강조 | “문제를 발견하는 데서 끝나지 않고 원인 셀로 바로 이동합니다.” |
| 43–54s | 셀 값을 수정 → 미반영 변경 배지 → 저장 | “무대감독이 실행 값을 직접 고치고 revision으로 남깁니다.” |
| 54–64s | E7→E8 순서대로 클릭. 등장·퇴장 semantic motion | “event가 바뀌면 사람과 소품의 상태 변화만 절제된 motion으로 연결됩니다.” |
| 64–72s | WARNING popup 또는 Script Sidebar 펼침 | “오류, 확인 필요, 근거 부족을 구분해 사람이 최종 판단합니다.” |
| 72–75s | 전체 workspace 정지 화면 | “리허설 전에, 무대에서 꼬일 일을 문서에서 먼저 잡습니다.” |

## 반드시 잡아야 하는 화면

- `S T A N D B Y` 순차 점등 loading wordmark
- E1–E8이 분절된 Event Timeline
- Event popup의 `ERROR` 또는 `ACTION REQUIRED`
- `이 Event로 이동`
- 큐시트 셀 편집, 미반영 변경 수, 저장
- 인접 event 전환 시 등장·퇴장 motion
- KOR/ENG 메뉴

## 촬영용 fast path의 사실 경계

- reference XLSX의 bytes가 승인된 SHA-256과 정확히 일치할 때만 활성화된다.
- 3.2초 로딩 뒤 표시되는 데이터는 원문이 아니라 저장소의 `CONTROLLED_FIXTURE`다.
- 일반 XLSX/PDF는 Railway → Upstage Agent 실경로를 계속 사용한다.
- 영상에서는 “실제 안전을 보장한다”, “Upstage가 이 3.2초 동안 46개 fact를 모두 분석했다”라고 말하지 않는다.
- 허용 표현: “데모에서는 캐시된 통제 fixture로 편집 흐름을 재현한다.”

## 실패 시 즉시 전환

1. XLSX fast path가 열리지 않으면 `example-cue-with-light.json`을 넣어 Editor 직행을 사용한다.
2. 데모 배포가 열리지 않으면 Vercel `standby-demo-junctionx`의 고정 Production deployment를 확인한다.
3. Agent 지연은 기다리지 않는다. 입력부터 다시 찍지 말고 workspace 구간을 별도 테이크로 촬영해 연결한다.
