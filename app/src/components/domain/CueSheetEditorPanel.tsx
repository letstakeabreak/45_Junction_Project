import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Action,
  ActionType,
  CueEvent,
  CueSheet,
  Direction,
  SceneType,
  TriggerType,
} from '@/types/cue-sheet';
import type { Contradiction } from '@/types/validation';
import type { Revision } from '@/types/ui';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';

export type CueEditorField =
  | 'scene_number'
  | 'scene_type'
  | 'trigger_type'
  | 'trigger_description'
  | 'action_type'
  | 'action_entity'
  | 'action_direction'
  | 'event_notes';

export type CueCellEdit = {
  cueId: string;
  eventId: string;
  actionIndex: number | null;
  field: CueEditorField;
  value: string;
};

export type CueEditorChange = {
  rowId: string;
  column: string;
  from: string;
  to: string;
};

type FocusTarget = { eventId: string; requestId: number } | null;

type EditorRow = {
  key: string;
  cueId: string;
  sceneNumber: string;
  sceneType: SceneType;
  event: CueEvent;
  action: Action | null;
  actionIndex: number | null;
};

type EditingCell = {
  key: string;
  edit: Omit<CueCellEdit, 'value'>;
  value: string;
  kind: 'text' | 'scene-type' | 'trigger-type' | 'action-type' | 'entity' | 'direction';
  options?: Array<{ value: string; label: string }>;
};

const SCENE_TYPES: SceneType[] = ['scene', 'number', 'dark'];
const TRIGGER_TYPES: TriggerType[] = ['dialogue', 'scene_change', 'lighting_cue', 'sound_cue'];
const ACTION_TYPES: ActionType[] = [
  'character_enter',
  'character_exit',
  'backstage_crossover',
  'prop_in',
  'prop_out',
  'costume_change',
];

function eventRows(cueSheet: CueSheet): EditorRow[] {
  return cueSheet.cues.flatMap((cue) => cue.events.flatMap((event) => {
    const actions = event.actions.length > 0 ? event.actions : [null];
    return actions.map((action, actionIndex) => ({
      key: `${cue.cue_id}:${event.event_id}:${action ? actionIndex : 'event'}`,
      cueId: cue.cue_id,
      sceneNumber: cue.scene_number,
      sceneType: cue.scene_type,
      event,
      action,
      actionIndex: action ? actionIndex : null,
    }));
  }));
}

function statusFor(contradictions: Contradiction[]) {
  return {
    errors: contradictions.filter((item) => item.severity === 'ERROR').length,
    warnings: contradictions.filter((item) => item.severity === 'WARNING').length,
  };
}

function aiCurationFor(contradictions: Contradiction[], locale: 'ko' | 'en'): string {
  const suggestions = contradictions.map((item) => {
    if (locale === 'en') {
      if (item.rule === 'duplicate_enter') return 'Confirm whether the previous entrance should be removed.';
      if (item.rule === 'no_backstage_crossover') return 'Align the entrance side or confirm an approved crossover route.';
      if (item.rule === 'prop_location_contradiction') return 'Assign a crew handoff or align the prop entrance side.';
      if (item.rule === 'prop_already_on_stage') return 'Remove the duplicate prop entry or confirm the previous removal.';
      if (item.rule === 'prop_not_on_stage') return 'Add the missing prop preset or confirm its current location.';
      if (item.rule === 'script_costume_state_conflict') return 'Align whether the costume is worn before entrance or changed on stage.';
      return 'Confirm the matching entrance event before this exit.';
    }
    if (item.rule === 'duplicate_enter') return '이전 등장 큐를 유지할지 확인하세요.';
    if (item.rule === 'no_backstage_crossover') return '등장 방향을 맞추거나 승인된 백스테이지 통로를 확인하세요.';
    if (item.rule === 'prop_location_contradiction') return '소품 전달 담당자를 지정하거나 반입 방향을 맞추세요.';
    if (item.rule === 'prop_already_on_stage') return '중복 반입을 제거하거나 이전 반출 여부를 확인하세요.';
    if (item.rule === 'prop_not_on_stage') return '누락된 소품 프리셋을 추가하거나 현재 위치를 확인하세요.';
    if (item.rule === 'script_costume_state_conflict') return '등장 전 착용인지 무대 위 환복인지 대본과 큐시트를 맞추세요.';
    return '이 퇴장 전에 대응하는 등장 큐가 있는지 확인하세요.';
  });
  return [...new Set(suggestions)].join(' ');
}

function entityValue(action: Action | null): string {
  if (!action) return '';
  if (action.type === 'prop_in' || action.type === 'prop_out') return action.prop_id ?? '';
  return action.character_id ?? '';
}

function directionValue(action: Action | null): string {
  if (!action) return '';
  if (action.type === 'backstage_crossover') {
    return action.from && action.to ? `${action.from}>${action.to}` : '';
  }
  return action.direction ?? '';
}

function directionLabel(value: string, locale: 'ko' | 'en'): string {
  const label = (direction: string) => {
    if (direction === 'stage_left') return locale === 'ko' ? '상수' : 'Stage Left';
    if (direction === 'stage_right') return locale === 'ko' ? '하수' : 'Stage Right';
    return '—';
  };
  if (value.includes('>')) {
    const [from = '', to = ''] = value.split('>');
    return `${label(from)} → ${label(to)}`;
  }
  return label(value);
}

function actionEntityOptions(cueSheet: CueSheet, action: Action | null) {
  const propAction = action?.type === 'prop_in' || action?.type === 'prop_out';
  return (propAction ? cueSheet.props : cueSheet.characters).map((entity) => ({
    value: entity.id,
    label: entity.name,
  }));
}

function ActionRequiredToken({ contradictions }: { contradictions: Contradiction[] }) {
  const status = statusFor(contradictions);
  if (status.errors === 0 && status.warnings === 0) {
    return <span className="mono border border-consistent/50 px-1.5 py-0.5 text-[9px] text-consistent">OK</span>;
  }
  return (
    <div className="flex flex-col items-start gap-1">
      {status.errors > 0 && (
        <span className="mono border border-violation bg-violation-bg px-1.5 py-0.5 text-[9px] text-violation">
          ERROR {status.errors}
        </span>
      )}
      {status.warnings > 0 && (
        <span className="mono border border-review bg-review-bg px-1.5 py-0.5 text-[9px] text-review">
          ACTION REQUIRED {status.warnings}
        </span>
      )}
    </div>
  );
}

export function CueSheetEditorPanel({
  cueSheet,
  contradictions,
  selectedEventId,
  focusTarget,
  editedKeys,
  changes,
  revisions,
  onSelectEvent,
  onEdit,
  onDiscardAll,
  onSave,
  onExportCsv,
  onLoadRevision,
}: {
  cueSheet: CueSheet;
  contradictions: Contradiction[];
  selectedEventId: string | null;
  focusTarget: FocusTarget;
  editedKeys: Set<string>;
  changes: CueEditorChange[];
  revisions: Revision[];
  onSelectEvent: (cueId: string, eventId: string) => void;
  onEdit: (edit: CueCellEdit) => void;
  onDiscardAll: () => void;
  onSave: () => void;
  onExportCsv?: () => void;
  onLoadRevision: (revisionId: string) => void;
}) {
  const { locale } = useI18n();
  const rows = useMemo(() => eventRows(cueSheet), [cueSheet]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState<EditingCell | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [previewRevisionId, setPreviewRevisionId] = useState<string | null>(null);

  const copy = locale === 'ko' ? {
    title: 'CUE SHEET',
    pending: `미반영 변경 ${changes.length}건`,
    discard: '모든 변경 취소',
    save: '저장',
    exportCsv: 'CSV 내보내기',
    history: '히스토리',
    historyEmpty: '저장된 revision이 없습니다.',
    changes: '변경',
    status: '상태',
    event: 'EVENT',
    scene: '씬',
    sceneType: '구분',
    triggerType: '트리거',
    trigger: '트리거 내용',
    action: '액션',
    entity: '인물 / 소품',
    direction: '방향',
    notes: '비고',
    aiCuration: 'AI 큐레이션 수정안',
    empty: '액션 없음',
  } : {
    title: 'CUE SHEET',
    pending: `${changes.length} UNSAVED`,
    discard: 'Discard all',
    save: 'Save',
    exportCsv: 'Export CSV',
    history: 'History',
    historyEmpty: 'No saved revisions.',
    changes: 'changes',
    status: 'Status',
    event: 'EVENT',
    scene: 'Scene',
    sceneType: 'Type',
    triggerType: 'Trigger',
    trigger: 'Trigger detail',
    action: 'Action',
    entity: 'Person / prop',
    direction: 'Direction',
    notes: 'Notes',
    aiCuration: 'AI curated edit',
    empty: 'No action',
  };

  useEffect(() => {
    if (!focusTarget) return;
    const target = [...(scrollRef.current?.querySelectorAll<HTMLElement>('[data-event-row]') ?? [])]
      .find((element) => element.dataset.eventRow === focusTarget.eventId);
    target?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
    target?.focus({ preventScroll: true });
  }, [focusTarget]);

  const beginEdit = (input: Omit<EditingCell, 'key'>, key: string) => {
    setEditing({ ...input, key });
  };

  const commitEditing = () => {
    if (!editing) return;
    onEdit({ ...editing.edit, value: editing.value });
    setEditing(null);
  };

  const cell = ({
    row,
    field,
    value,
    display = value,
    kind = 'text',
    options,
    widthClass,
    disabled = false,
  }: {
    row: EditorRow;
    field: CueEditorField;
    value: string;
    display?: string;
    kind?: EditingCell['kind'];
    options?: EditingCell['options'];
    widthClass: string;
    disabled?: boolean;
  }) => {
    const actionScoped = field === 'action_type'
      || field === 'action_entity'
      || field === 'action_direction';
    const editActionIndex = actionScoped ? row.actionIndex : null;
    const actionPart = editActionIndex === null ? 'event' : editActionIndex;
    const editKey = `${row.event.event_id}:${actionPart}:${field}`;
    const uiKey = `${row.key}:${field}`;
    const active = editing?.key === uiKey;
    const edited = editedKeys.has(editKey);
    return (
      <td
        className={cn(
          'relative border border-border px-2 py-1.5 align-top',
          widthClass,
          disabled ? 'text-muted-foreground' : 'cursor-text hover:bg-muted',
          edited && 'bg-edited-bg text-edited',
        )}
        onClick={() => {
          if (disabled || active) return;
          beginEdit({
            edit: {
              cueId: row.cueId,
              eventId: row.event.event_id,
              actionIndex: editActionIndex,
              field,
            },
            value,
            kind,
            options,
          }, uiKey);
        }}
      >
        {edited && (
          <span className="absolute top-0 left-0 h-0 w-0 border-t-[7px] border-r-[7px] border-t-edited border-r-transparent" aria-hidden="true" />
        )}
        {active ? (
          kind === 'text' ? (
            <input
              autoFocus
              value={editing.value}
              onChange={(event) => setEditing({ ...editing, value: event.target.value })}
              onBlur={commitEditing}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitEditing();
                if (event.key === 'Escape') setEditing(null);
              }}
              className="w-full min-w-0 border border-border-strong bg-background px-1 py-0.5 text-xs outline-none"
            />
          ) : (
            <select
              autoFocus
              value={editing.value}
              onChange={(event) => {
                onEdit({ ...editing.edit, value: event.target.value });
                setEditing(null);
              }}
              onBlur={() => setEditing(null)}
              className="w-full min-w-0 border border-border-strong bg-background px-1 py-0.5 text-xs outline-none"
            >
              {(options ?? []).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          )
        ) : (
          <span className="block min-h-4 whitespace-normal break-words text-xs leading-4">{display || '—'}</span>
        )}
      </td>
    );
  };

  return (
    <section className="relative flex h-full flex-col bg-surface" aria-label={copy.title}>
      <header className="flex min-h-9 shrink-0 items-center justify-between gap-3 border-b border-border px-3 py-1">
        <span className="mono text-[10px] tracking-[0.12em] text-muted-foreground">{copy.title}</span>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className={cn(
            'mono border px-2 py-1 text-[10px]',
            changes.length > 0
              ? 'border-edited bg-edited-bg text-edited'
              : 'border-border bg-muted text-muted-foreground',
          )}>
            {copy.pending}
          </span>
          <button type="button" disabled={changes.length === 0} onClick={onDiscardAll} className="border border-border px-2 py-1 text-[10px] hover:bg-muted disabled:cursor-not-allowed disabled:text-muted-foreground">
            {copy.discard}
          </button>
          <button type="button" disabled={changes.length === 0} onClick={onSave} className="border border-foreground bg-foreground px-3 py-1 text-[10px] text-background hover:bg-muted-foreground disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground">
            {copy.save}
          </button>
          {onExportCsv && (
            <button type="button" onClick={onExportCsv} className="border border-border px-2 py-1 text-[10px] hover:bg-muted">
              {copy.exportCsv}
            </button>
          )}
          <button
            type="button"
            aria-expanded={historyOpen}
            onClick={() => {
              setHistoryOpen((open) => !open);
              setPreviewRevisionId(null);
            }}
            className="border border-border px-2 py-1 text-[10px] hover:bg-muted"
          >
            {copy.history} {revisions.length}
          </button>
        </div>
      </header>

      {historyOpen && (
        <div className="absolute top-9 right-3 z-40 grid w-[560px] max-w-[calc(100%-24px)] grid-cols-2 border border-border-strong bg-elevated">
          <div className="max-h-56 overflow-y-auto border-r border-border p-2">
            {revisions.map((revision) => (
              <button
                key={revision.id}
                type="button"
                onMouseEnter={() => setPreviewRevisionId(revision.id)}
                onFocus={() => setPreviewRevisionId(revision.id)}
                onClick={() => {
                  onLoadRevision(revision.id);
                  setHistoryOpen(false);
                }}
                className="mb-1 block w-full border border-border bg-background p-2 text-left text-[10px] hover:border-foreground"
              >
                <span className="font-semibold">{revision.savedAt}</span>
                <span className="ml-2 text-muted-foreground">{revision.changes.length} {copy.changes}</span>
                <span className="mt-1 block truncate text-muted-foreground">{revision.author}</span>
              </button>
            ))}
            {revisions.length === 0 && (
              <p className="p-2 text-[10px] text-muted-foreground">{copy.historyEmpty}</p>
            )}
          </div>
          <div className="max-h-56 overflow-y-auto p-2">
            {(revisions.find((revision) => revision.id === previewRevisionId)?.changes ?? []).map((change) => (
              <div key={`${change.rowId}:${change.column}`} className="mb-1 border border-border bg-background p-2 text-[10px]">
                <p className="font-semibold">{change.rowId} · {change.column}</p>
                <p className="mt-1 break-words text-muted-foreground">{change.from || '—'} → {change.to || '—'}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <table className="w-max min-w-full border-collapse text-left">
          <thead className="sticky top-0 z-20 bg-muted">
            <tr>
              {[
                [copy.status, 'w-32'],
                [copy.event, 'w-36'],
                [copy.scene, 'w-24'],
                [copy.sceneType, 'w-24'],
                [copy.triggerType, 'w-32'],
                [copy.trigger, 'w-80'],
                [copy.action, 'w-44'],
                [copy.entity, 'w-44'],
                [copy.direction, 'w-32'],
                [copy.notes, 'w-72'],
                [copy.aiCuration, 'w-80'],
              ].map(([label, width], index) => (
                <th key={label} className={cn(
                  'mono border border-border bg-muted px-2 py-1.5 text-[10px] font-normal text-muted-foreground',
                  width,
                  index === 0 && 'sticky left-0 z-30',
                  index === 1 && 'sticky left-32 z-30',
                )}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rowContradictions = contradictions.filter((item) => item.event_id === row.event.event_id);
              const selected = row.event.event_id === selectedEventId;
              const focused = row.event.event_id === focusTarget?.eventId;
              const action = row.action;
              const aiCuration = aiCurationFor(rowContradictions, locale);
              const entityOptions = actionEntityOptions(cueSheet, action);
              const routeOptions = [
                { value: 'stage_left>stage_right', label: directionLabel('stage_left>stage_right', locale) },
                { value: 'stage_right>stage_left', label: directionLabel('stage_right>stage_left', locale) },
              ];
              const directionOptions = (['stage_left', 'stage_right'] as Direction[]).map((value) => ({
                value,
                label: directionLabel(value, locale),
              }));
              return (
                <tr
                  key={row.key}
                  data-event-row={row.event.event_id}
                  tabIndex={-1}
                  onClick={() => onSelectEvent(row.cueId, row.event.event_id)}
                  className={cn(
                    'outline-none',
                    selected && 'bg-muted/70',
                    focused && 'relative z-10 outline outline-2 -outline-offset-2 outline-foreground',
                  )}
                >
                  <td className={cn('sticky left-0 z-10 w-32 border border-border px-2 py-1.5 align-top', selected ? 'bg-muted' : 'bg-surface')}><ActionRequiredToken contradictions={rowContradictions} /></td>
                  <td className={cn('mono sticky left-32 z-10 w-36 border border-border px-2 py-1.5 align-top text-[10px]', selected ? 'bg-muted' : 'bg-surface')}>{row.event.event_id}</td>
                  {cell({ row, field: 'scene_number', value: row.sceneNumber, widthClass: 'w-24 mono' })}
                  {cell({
                    row,
                    field: 'scene_type',
                    value: row.sceneType,
                    kind: 'scene-type',
                    options: SCENE_TYPES.map((value) => ({ value, label: value.toUpperCase() })),
                    widthClass: 'w-24 mono',
                  })}
                  {cell({
                    row,
                    field: 'trigger_type',
                    value: row.event.trigger.type,
                    kind: 'trigger-type',
                    options: TRIGGER_TYPES.map((value) => ({ value, label: value })),
                    widthClass: 'w-32 mono',
                  })}
                  {cell({ row, field: 'trigger_description', value: row.event.trigger.description ?? '', widthClass: 'w-80' })}
                  {cell({
                    row,
                    field: 'action_type',
                    value: action?.type ?? '',
                    display: action?.type ?? copy.empty,
                    kind: 'action-type',
                    options: ACTION_TYPES.map((value) => ({ value, label: value })),
                    widthClass: 'w-44 mono',
                    disabled: !action,
                  })}
                  {cell({
                    row,
                    field: 'action_entity',
                    value: entityValue(action),
                    display: entityOptions.find((option) => option.value === entityValue(action))?.label ?? '',
                    kind: 'entity',
                    options: entityOptions,
                    widthClass: 'w-44',
                    disabled: !action,
                  })}
                  {cell({
                    row,
                    field: 'action_direction',
                    value: directionValue(action),
                    display: directionLabel(directionValue(action), locale),
                    kind: 'direction',
                    options: action?.type === 'backstage_crossover' ? routeOptions : directionOptions,
                    widthClass: 'w-32',
                    disabled: !action || action.type === 'costume_change',
                  })}
                  {cell({ row, field: 'event_notes', value: row.event.notes ?? '', widthClass: 'w-72' })}
                  <td className="w-80 border border-border bg-edited-bg/20 px-2 py-1.5 align-top">
                    {aiCuration ? (
                      <>
                        <span className="border border-edited/60 px-1.5 py-0.5 text-[8px] text-edited">NON_AUTHORITATIVE</span>
                        <p className="mt-2 text-xs leading-4">{aiCuration}</p>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
