import type { CueSheet, Direction } from '../types/cue-sheet';
import type { ScriptProjection } from '../types/script';
import type { Contradiction, ValidationResult } from '../types/validation';

interface CharacterTracking {
  on_stage: boolean;
  last_exit_direction: Direction | null;
  last_exit_cue: string | null;
  last_exit_scene: string | null;
}

interface PropTracking {
  on_stage: boolean;
  last_direction: Direction | null;
  last_cue: string | null;
  last_scene: string | null;
}

function dirName(direction: Direction | null | undefined): string {
  if (direction === 'stage_left') return '상수';
  if (direction === 'stage_right') return '하수';
  return '불명';
}

export function validateCueSheet(data: CueSheet): ValidationResult {
  const contradictions: Contradiction[] = [];
  const characterState: Record<string, CharacterTracking> = {};
  const propState: Record<string, PropTracking> = {};

  // Initialize states
  for (const char of data.characters) {
    characterState[char.id] = {
      on_stage: false,
      last_exit_direction: null,
      last_exit_cue: null,
      last_exit_scene: null,
    };
  }
  for (const prop of data.props) {
    propState[prop.id] = {
      on_stage: false,
      last_direction: null,
      last_cue: null,
      last_scene: null,
    };
  }

  const charNames = Object.fromEntries(data.characters.map(c => [c.id, c.name]));
  const propNames = Object.fromEntries(data.props.map(p => [p.id, p.name]));

  for (const cue of data.cues) {

    for (const event of cue.events) {
      for (const action of event.actions) {
        // Check each action type
        switch (action.type) {
          case 'character_enter': {
            const charId = action.character_id;
            if (!charId || !characterState[charId]) break;
            const state = characterState[charId];
            const name = charNames[charId] ?? charId;

            // Rule: duplicate_enter
            if (state.on_stage) {
              contradictions.push({
                severity: 'ERROR',
                rule: 'duplicate_enter',
                cue_id: cue.cue_id,
                scene_number: cue.scene_number,
                event_id: event.event_id,
                description: `'${name}'이(가) 퇴장하지 않고 재등장합니다.`,
                details: { character_id: charId, character_name: name },
              });
            }

            // Rule: no_backstage_crossover. Timing is not inferred from cue duration.
            if (!state.on_stage && state.last_exit_direction && action.direction && state.last_exit_direction !== action.direction) {
              if (!data.venue.has_backstage_crossover) {
                contradictions.push({
                  severity: 'ERROR',
                  rule: 'no_backstage_crossover',
                  cue_id: cue.cue_id,
                  scene_number: cue.scene_number,
                  event_id: event.event_id,
                  description: `'${name}'이(가) ${dirName(state.last_exit_direction)}로 퇴장 후 ${dirName(action.direction)}에서 등장하지만, 백스테이지 통로가 없습니다.`,
                  details: { character_id: charId, character_name: name, exit_direction: state.last_exit_direction, enter_direction: action.direction, exited_at_cue: state.last_exit_cue ?? '', exited_at_scene: state.last_exit_scene ?? '' },
                });
              }
            }

            state.on_stage = true;
            break;
          }
          case 'character_exit': {
            const charId = action.character_id;
            if (!charId || !characterState[charId]) break;
            const state = characterState[charId];
            const name = charNames[charId] ?? charId;

            if (!state.on_stage) {
              contradictions.push({
                severity: 'WARNING',
                rule: 'exit_without_enter',
                cue_id: cue.cue_id,
                scene_number: cue.scene_number,
                event_id: event.event_id,
                description: `'${name}'이(가) 무대에 없는 상태에서 퇴장합니다.`,
                details: { character_id: charId, character_name: name },
              });
            }

            state.on_stage = false;
            state.last_exit_direction = action.direction ?? null;
            state.last_exit_cue = cue.cue_id;
            state.last_exit_scene = cue.scene_number;
            break;
          }
          case 'backstage_crossover': {
            const charId = action.character_id;
            if (!charId || !characterState[charId]) break;
            const name = charNames[charId] ?? charId;

            if (!data.venue.has_backstage_crossover) {
              contradictions.push({
                severity: 'ERROR',
                rule: 'no_backstage_crossover',
                cue_id: cue.cue_id,
                scene_number: cue.scene_number,
                event_id: event.event_id,
                description: `'${name}'이(가) 백스테이지 이동(${dirName(action.from)}→${dirName(action.to)})을 하지만 백스테이지 통로가 없습니다.`,
                details: { character_id: charId, character_name: name, from: action.from ?? '', to: action.to ?? '' },
              });
            }

            characterState[charId].last_exit_direction = action.to ?? null;
            break;
          }
          case 'prop_in': {
            const propId = action.prop_id;
            if (!propId || !propState[propId]) break;
            const state = propState[propId];
            const name = propNames[propId] ?? propId;

            if (state.on_stage) {
              contradictions.push({
                severity: 'WARNING',
                rule: 'prop_already_on_stage',
                cue_id: cue.cue_id,
                scene_number: cue.scene_number,
                event_id: event.event_id,
                description: `소품 '${name}'이(가) 이미 무대 위에 있는데 다시 진입합니다.`,
                details: { prop_id: propId, prop_name: name, last_cue: state.last_cue ?? '', last_scene: state.last_scene ?? '' },
              });
            }

            if (!state.on_stage && state.last_direction && action.direction && state.last_direction !== action.direction) {
              if (!data.venue.has_backstage_crossover) {
                contradictions.push({
                  severity: 'ERROR',
                  rule: 'prop_location_contradiction',
                  cue_id: cue.cue_id,
                  scene_number: cue.scene_number,
                  event_id: event.event_id,
                  description: `소품 '${name}'이(가) ${dirName(state.last_direction)}로 퇴장했는데 ${dirName(action.direction)}에서 진입합니다. 백스테이지 통로가 없습니다.`,
                  details: { prop_id: propId, prop_name: name, exit_direction: state.last_direction, enter_direction: action.direction },
                });
              }
            }

            state.on_stage = true;
            state.last_direction = action.direction ?? null;
            state.last_cue = cue.cue_id;
            state.last_scene = cue.scene_number;
            break;
          }
          case 'prop_out': {
            const propId = action.prop_id;
            if (!propId || !propState[propId]) break;
            const state = propState[propId];
            const name = propNames[propId] ?? propId;

            if (!state.on_stage) {
              contradictions.push({
                severity: 'WARNING',
                rule: 'prop_not_on_stage',
                cue_id: cue.cue_id,
                scene_number: cue.scene_number,
                event_id: event.event_id,
                description: `소품 '${name}'이(가) 무대에 없는 상태에서 퇴장합니다.`,
                details: { prop_id: propId, prop_name: name },
              });
            }

            state.on_stage = false;
            state.last_direction = action.direction ?? null;
            state.last_cue = cue.cue_id;
            state.last_scene = cue.scene_number;
            break;
          }
          case 'costume_change': {
            const charId = action.character_id;
            if (!charId || !characterState[charId]) break;
            // The JSON contract records that a change occurs, not an estimated duration.
            // Timing findings require separately reviewed min/max evidence in the verifier path.
            break;
          }
        }
      }
    }
  }

  return {
    total_cues: data.cues.length,
    total_contradictions: contradictions.length,
    errors: contradictions.filter(c => c.severity === 'ERROR').length,
    warnings: contradictions.filter(c => c.severity === 'WARNING').length,
    contradictions,
  };
}

const ALREADY_WEARING_PATTERN = /갖춰\s*입|착용한\s*채|입은\s*채|already\s+(?:wearing|dressed)/iu;

export function validateScriptCueAlignment(
  data: CueSheet,
  script: ScriptProjection | null,
): Contradiction[] {
  if (!script) return [];

  const stageDirectionsByEvent = new Map<string, string>();
  for (const segment of script.segments) {
    if (segment.kind !== 'STAGE_DIRECTION' || !segment.event_id) continue;
    const current = stageDirectionsByEvent.get(segment.event_id) ?? '';
    stageDirectionsByEvent.set(segment.event_id, `${current} ${segment.text}`.trim());
  }

  const contradictions: Contradiction[] = [];
  for (const cue of data.cues) {
    for (const event of cue.events) {
      const stageDirection = stageDirectionsByEvent.get(event.event_id);
      if (!stageDirection || !ALREADY_WEARING_PATTERN.test(stageDirection)) continue;
      for (const action of event.actions) {
        if (action.type !== 'costume_change') continue;
        contradictions.push({
          severity: 'WARNING',
          rule: 'script_costume_state_conflict',
          cue_id: cue.cue_id,
          scene_number: cue.scene_number,
          event_id: event.event_id,
          description: '대본은 이미 의상을 착용한 상태로 등장하지만 큐시트는 같은 이벤트에서 환복을 지시합니다.',
          details: {
            character_id: action.character_id ?? '',
            costume_description: action.costume_description ?? '',
            script_direction: stageDirection,
          },
        });
      }
    }
  }
  return contradictions;
}
