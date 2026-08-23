export type Severity = 'ERROR' | 'WARNING';

export type RuleId = 
  | 'duplicate_enter'
  | 'no_backstage_crossover'
  | 'prop_location_contradiction'
  | 'prop_already_on_stage'
  | 'prop_not_on_stage'
  | 'exit_without_enter'
  | 'script_costume_state_conflict';

export interface Contradiction {
  severity: Severity;
  rule: RuleId;
  cue_id: string;
  scene_number: string;
  event_id: string;
  description: string;
  details: Record<string, string | number>;
}

export interface ValidationResult {
  total_cues: number;
  total_contradictions: number;
  errors: number;
  warnings: number;
  contradictions: Contradiction[];
}
