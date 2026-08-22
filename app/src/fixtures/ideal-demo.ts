import type { FactCandidate, FactNormalizerArtifact, StageEntityState } from '@/types/standby';

const rows = [
  ['R1', 'E1 / Q54', '-', '혜원 퇴장', '-', '우주복 A', 'LX Q54', 'SFX 12', '-', '00:00', 'S#16 종료'],
  ['R2', 'E2 / Q56', '-', '-', '-', '-', 'LX Q56 암전', 'SFX 13', '2인 대기', '00:04', '암전 58-62s'],
  ['R3', 'E3 / Q56a', '-', '혜원 → 하수환복소', '58s', '우주복 A 해제', '-', '-', '드레서 1', '00:08', '3-4s 이동'],
  ['R4', 'E4', '-', '환복 진행', '60s', '우주복 B', '-', '-', '드레서 1', '00:16', 'min 60s'],
  ['R5', 'E5 / P12', '마루가방 대기', '은비 인계', '-', '-', '-', 'SFX 14', '미표기', '00:44', '좌우 교차'],
  ['R6', 'E6 / C04', '크루 해제', '-', '-', '-', '-', '-', '?', '00:52', 'capacity 미상'],
  ['R7', 'E7 / Q58', '-', '혜원 재입장', '-', '우주복 B', 'LX Q58', 'SFX 15', '-', '01:02', 'S#17 시작'],
  ['R8', 'E8', '마루가방 복귀', '-', '-', '-', '-', '-', '런크루 1', '01:10', '-'],
].map(([id, marker, right, left, change, costume, light, sound, crew, timecode, note]) => ({
  id, 마커: marker, 무대_상수: right, 무대_하수: left, 환복시간: change, 의상: costume,
  조명: light, 음향: sound, 크루: crew, 타임코드: timecode, 비고: note,
}));

const at = (
  hyewon: Omit<StageEntityState, 'kind'>,
  eunbi: Omit<StageEntityState, 'kind'>,
  bag: Omit<StageEntityState, 'kind'>,
) => ({
  hyewon: { kind: 'PERSON' as const, ...hyewon },
  eunbi: { kind: 'PERSON' as const, ...eunbi },
  bag: { kind: 'PROP' as const, ...bag },
});

const snapshots = {
  E1: at({ zone: 'STAGE_LEFT_WING', transition: 'EXIT' }, { zone: 'STAGE_LEFT_WING' }, { zone: 'STAGE_RIGHT_WING' }),
  E2: at({ zone: 'STAGE_LEFT_WING' }, { zone: 'STAGE_LEFT_WING' }, { zone: 'STAGE_RIGHT_WING' }),
  E3: at({ zone: 'STAGE_LEFT_CHANGE' }, { zone: 'STAGE_LEFT_WING' }, { zone: 'STAGE_RIGHT_WING' }),
  E4: at({ zone: 'STAGE_LEFT_CHANGE' }, { zone: 'STAGE_LEFT_WING' }, { zone: 'STAGE_RIGHT_WING' }),
  E5: at({ zone: 'STAGE_LEFT_CHANGE' }, { zone: 'STAGE_LEFT_WING' }, { zone: 'STAGE_LEFT_WING' }),
  E6: at({ zone: 'STAGE_LEFT_CHANGE' }, { zone: 'STAGE_LEFT_WING', transition: 'EXIT' }, { zone: 'STAGE_LEFT_WING' }),
  E7: at({ zone: 'STAGE', transition: 'ENTER' }, { zone: 'STAGE', transition: 'ENTER' }, { zone: 'STAGE_LEFT_WING' }),
  E8: at({ zone: 'STAGE' }, { zone: 'STAGE' }, { zone: 'STAGE', transition: 'ENTER' }),
} satisfies Record<string, Record<string, StageEntityState>>;

const labels = ['Exit', 'Blackout starts', 'Move to quick-change', 'Costume change', 'Prop handoff', 'Crew route release', 'Re-entry', 'Prop returns'];

export const IDEAL_DEMO_SOURCES = {
  SCRIPT: {
    segment: 'S#16 → S#17',
    timing_anchor: { exit_event: 'E1', next_entry_event: 'E7', quote: 'HYEWON exits Stage Right. (Long blackout.)', locator: 'S#16 p.42 L.18' },
    blocking_sequence: { route_id: 'HASU_CROSSOVER', event_id: 'E6', complete: true, quote: 'HYEWON and run crew share the crossover during blackout.', locator: 'S#16 p.43 L.2' },
    prop_requirement: { event_id: 'E8', prop_id: 'bag', zone: 'STAGE', quote: 'The bag is used on stage.', locator: 'S#17 p.44 L.7' },
  },
  MASTER_CUE: {
    sheet: 'MASTER', rows,
    quick_change: { available_min_ms: 58000, available_max_ms: 62000, target: { row_id: 'R3', column: '환복시간' }, quote: 'LX Q56 blackout holds for 58-62s.', locator: 'MASTER!D3' },
    blocking_occupancies: [
      { route_id: 'HASU_CROSSOVER', event_id: 'E6', entity_id: 'hyewon', start_ms: 52000, end_ms: 58000, quote: 'HYEWON uses crossover at 52-58s.', locator: 'MASTER!F6' },
      { route_id: 'HASU_CROSSOVER', event_id: 'E6', entity_id: 'runcrew-1', start_ms: 54000, end_ms: 60000, quote: 'Run crew uses crossover at 54-60s.', locator: 'MASTER!G6' },
    ],
    prop_sequence: { prop_id: 'bag', through_event_id: 'E8', complete: true, quote: 'No handoff owner is recorded through E8.', locator: 'MASTER!H5:H8' },
    event_states: labels.map((label, index) => ({
      event_id: `E${index + 1}`, sequence_index: index, label,
      time_range_ms: { min_ms: index * 8000, max_ms: index * 8000 }, actions: [],
      stage_snapshot: snapshots[`E${index + 1}` as keyof typeof snapshots],
      quote: `E${index + 1} ${label}`, locator: `MASTER!A${index + 1}`,
    })),
  },
  STAGE_SPEC: {
    contract_version: 'standby.stage-spec.v1', wings: ['STAGE_RIGHT_WING', 'STAGE_LEFT_WING'], crossover: 'AVAILABLE',
    route_times: [
      { from: 'STAGE_LEFT_WING', to: 'STAGE_LEFT_CHANGE', min_ms: 3000, max_ms: 4000 },
      { from: 'STAGE_LEFT_CHANGE', to: 'STAGE', min_ms: 3000, max_ms: 4000 },
    ],
    route_capacities: [{ route_id: 'HASU_CROSSOVER', capacity: 1 }], minimum_change_ms: 60000,
    initial_state: [
      { entity_id: 'hyewon', kind: 'PERSON', zone: 'STAGE' },
      { entity_id: 'eunbi', kind: 'PERSON', zone: 'STAGE_LEFT_WING' },
      { entity_id: 'bag', kind: 'PROP', zone: 'STAGE_RIGHT_WING' },
    ],
    source_evidence: { quote: 'Minimum change 60s plus two 3-4s routes.', locator: 'stage_spec.quick_change' },
  },
} as const;

export function idealDemoNormalizer(facts: FactCandidate[]): FactNormalizerArtifact {
  return {
    contract_version: 'standby.production-artifact.v1', artifact_id: 'demo_fact_normalizer',
    role: 'FACT_NORMALIZER', authority: 'NON_AUTHORITATIVE', agent_id: 'CONTROLLED_DEMO', config_id: 'ideal-v1',
    payload: {
      recommendations: facts.map((fact) => ({
        fact_id: fact.fact_id,
        normalized_fact_type: fact.fact_type as FactNormalizerArtifact['payload']['recommendations'][number]['normalized_fact_type'],
        value: fact.raw_value as Record<string, unknown>, confidence: 'HIGH', authority: 'NON_AUTHORITATIVE',
      })),
      missing_evidence: [],
    },
  };
}
