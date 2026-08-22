import { useMemo, useRef, useEffect, useState } from 'react';
import { useCueSheetStore, useReviewFlowStore, useStandbyWorkspaceStore } from '@/store';
import { PanelHeader } from '@/components/ui';
import {
  CueEventPopup,
  CueSheetEditorPanel,
  ScriptSidebar,
  StageSimulator,
  VerifiedWorkspace,
} from '@/components/domain';
import type { CueCellEdit, CueEditorChange } from '@/components/domain';
import type { StageMotion } from '@/components/domain/StageSimulator';
import type { StageEntity } from '@/types';
import type { Action, CueSheet, Direction } from '@/types/cue-sheet';
import type { Contradiction } from '@/types/validation';
import type { StoryboardAgentArtifact, StoryboardAgentState } from '@/types/standby';
import { cn } from '@/lib/utils';
import { createStandbyBrowserApi, StandbyApiError } from '@/lib/standby-api';
import { useNavigate } from '@tanstack/react-router';
import { useI18n } from '@/lib/i18n';
import { buildScriptSidebarEntries, unlinkedScriptSegments } from '@/lib/script-projection';
import type { ScriptEventLinks, ScriptProjection } from '@/types/script';
import { idealDemoScriptProjection, idealDemoStoryboard } from '@/fixtures/ideal-demo';

// ─── Helpers ───────────────────────────────────────────────

function cueEditKey(edit: Omit<CueCellEdit, 'value'>): string {
  return `${edit.eventId}:${edit.actionIndex === null ? 'event' : edit.actionIndex}:${edit.field}`;
}

function cueEditColumn(edit: Omit<CueCellEdit, 'value'>): string {
  const action = edit.actionIndex === null ? '' : `action[${edit.actionIndex}].`;
  return `${action}${edit.field}`;
}

function cueEditValue(cueSheet: CueSheet, edit: Omit<CueCellEdit, 'value'>): string {
  const cue = cueSheet.cues.find((item) => item.cue_id === edit.cueId);
  const event = cue?.events.find((item) => item.event_id === edit.eventId);
  if (!cue || !event) return '';
  if (edit.field === 'scene_number') return cue.scene_number;
  if (edit.field === 'scene_type') return cue.scene_type;
  if (edit.field === 'trigger_type') return event.trigger.type;
  if (edit.field === 'trigger_description') return event.trigger.description ?? '';
  if (edit.field === 'event_notes') return event.notes ?? '';
  if (edit.actionIndex === null) return '';
  const action = event.actions[edit.actionIndex];
  if (!action) return '';
  if (edit.field === 'action_type') return action.type;
  if (edit.field === 'action_entity') {
    return action.type === 'prop_in' || action.type === 'prop_out'
      ? action.prop_id ?? ''
      : action.character_id ?? '';
  }
  if (edit.field === 'action_direction') {
    return action.type === 'backstage_crossover'
      ? action.from && action.to ? `${action.from}>${action.to}` : ''
      : action.direction ?? '';
  }
  return '';
}

function changeActionType(action: Action, nextType: Action['type']): Action {
  const direction = action.direction ?? action.to ?? action.from;
  if (nextType === 'prop_in' || nextType === 'prop_out') {
    return {
      type: nextType,
      prop_id: action.prop_id,
      direction,
      carried_by: action.carried_by,
    };
  }
  if (nextType === 'backstage_crossover') {
    return {
      type: nextType,
      character_id: action.character_id,
      from: action.from ?? direction,
      to: action.to ?? (direction === 'stage_left' ? 'stage_right' : direction === 'stage_right' ? 'stage_left' : undefined),
    };
  }
  if (nextType === 'costume_change') {
    return {
      type: nextType,
      character_id: action.character_id,
      costume_description: action.costume_description,
    };
  }
  return {
    type: nextType,
    character_id: action.character_id,
    direction,
  };
}

function applyCueEdit(cueSheet: CueSheet, edit: CueCellEdit): CueSheet {
  return {
    ...cueSheet,
    cues: cueSheet.cues.map((cue) => {
      if (cue.cue_id !== edit.cueId) return cue;
      if (edit.field === 'scene_number') return { ...cue, scene_number: edit.value };
      if (edit.field === 'scene_type') {
        return { ...cue, scene_type: edit.value as typeof cue.scene_type };
      }
      return {
        ...cue,
        events: cue.events.map((event) => {
          if (event.event_id !== edit.eventId) return event;
          if (edit.field === 'trigger_type') {
            return { ...event, trigger: { ...event.trigger, type: edit.value as typeof event.trigger.type } };
          }
          if (edit.field === 'trigger_description') {
            return { ...event, trigger: { ...event.trigger, description: edit.value } };
          }
          if (edit.field === 'event_notes') return { ...event, notes: edit.value };
          if (edit.actionIndex === null) return event;
          return {
            ...event,
            actions: event.actions.map((action, index) => {
              if (index !== edit.actionIndex) return action;
              if (edit.field === 'action_type') {
                return changeActionType(action, edit.value as Action['type']);
              }
              if (edit.field === 'action_entity') {
                return action.type === 'prop_in' || action.type === 'prop_out'
                  ? { ...action, prop_id: edit.value, character_id: undefined }
                  : { ...action, character_id: edit.value, prop_id: undefined };
              }
              if (edit.field === 'action_direction') {
                if (action.type === 'backstage_crossover') {
                  const [from, to] = edit.value.split('>') as [Direction, Direction];
                  return { ...action, from, to, direction: to };
                }
                return { ...action, direction: edit.value as Direction };
              }
              return action;
            }),
          };
        }),
      };
    }),
  };
}

// ─── Main Component ────────────────────────────────────────

export function WorkspaceScreen() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const verifiedWorkspace = useStandbyWorkspaceStore((state) => state.workspace);
  const verifiedCaseId = useStandbyWorkspaceStore((state) => state.caseId);
  const cueSheet = useCueSheetStore((s) => s.cueSheet);
  const validationResult = useCueSheetStore((s) => s.validationResult);
  const selectedCueId = useCueSheetStore((s) => s.selectedCueId);
  const selectedEventId = useCueSheetStore((s) => s.selectedEventId);
  const selectCue = useCueSheetStore((s) => s.selectCue);
  const selectEvent = useCueSheetStore((s) => s.selectEvent);
  const commitCueSheet = useCueSheetStore((s) => s.commitCueSheet);
  const revisions = useCueSheetStore((s) => s.revisions);
  const loadRevision = useCueSheetStore((s) => s.loadRevision);
  const clearVerifiedWorkspace = useStandbyWorkspaceStore((state) => state.clear);
  const setVerifiedWorkspace = useStandbyWorkspaceStore((state) => state.setWorkspace);
  const setReviewFlowContext = useReviewFlowStore((state) => state.setReviewContext);
  const [stageMotion, setStageMotion] = useState<StageMotion>();
  const [storyboardState, setStoryboardState] = useState<StoryboardAgentState>({ status: 'IDLE' });
  const [script, setScript] = useState<ScriptProjection | null>(null);
  const [scriptLinks, setScriptLinks] = useState<ScriptEventLinks>({});
  const [scriptBusy, setScriptBusy] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [draftCueSheet, setDraftCueSheet] = useState<CueSheet | null>(null);
  const [cueChanges, setCueChanges] = useState<Record<string, CueEditorChange>>({});
  const [popupEventId, setPopupEventId] = useState<string | null>(null);
  const [focusTarget, setFocusTarget] = useState<{ eventId: string; requestId: number } | null>(null);
  const [stageFirst, setStageFirst] = useState(true);
  const storyboardRequestVersion = useRef(0);
  const editorCueSheet = draftCueSheet ?? cueSheet;

  useEffect(() => {
    setDraftCueSheet(cueSheet ? structuredClone(cueSheet) : null);
    setCueChanges({});
  }, [cueSheet]);

  const selectedCue = useMemo(
    () => editorCueSheet?.cues.find((cue) => cue.cue_id === selectedCueId) ?? editorCueSheet?.cues[0] ?? null,
    [editorCueSheet, selectedCueId],
  );
  const selectedEvt = selectedCue?.events.find((event) => event.event_id === selectedEventId) ?? null;
  const timelineEvents = useMemo(
    () => editorCueSheet?.cues.flatMap((cue) => cue.events.map((event) => ({ cueId: cue.cue_id, event }))) ?? [],
    [editorCueSheet],
  );
  const scriptTimelineEvents = useMemo(() => verifiedWorkspace
    ? verifiedWorkspace.events.map((event) => ({ eventId: event.event_id, sceneLabel: event.label }))
    : editorCueSheet?.cues.flatMap((cue) => cue.events.map((event) => ({
      eventId: event.event_id,
      sceneLabel: cue.scene_number,
    }))) ?? [], [editorCueSheet, verifiedWorkspace]);
  const scriptEntries = useMemo(
    () => buildScriptSidebarEntries(script, scriptTimelineEvents, scriptLinks),
    [script, scriptLinks, scriptTimelineEvents],
  );
  const unlinkedSegments = useMemo(
    () => unlinkedScriptSegments(script, scriptTimelineEvents, scriptLinks),
    [script, scriptLinks, scriptTimelineEvents],
  );

  const connectScript = async (file: File) => {
    setScriptError(null);
    const extension = file.name.split('.').pop()?.toLowerCase();
    if (extension !== 'docx' && extension !== 'pdf') {
      setScriptError(t('workspace.scriptFileType'));
      return;
    }
    const api = createStandbyBrowserApi();
    if (!api) {
      setScriptError(t('workspace.scriptApiMissing'));
      return;
    }
    if (!verifiedCaseId) {
      setScriptError(t('workspace.scriptApiMissing'));
      return;
    }
    setScriptBusy(true);
    try {
      await api.uploadSourceFile(verifiedCaseId, 'SCRIPT', file);
      const operation = await api.startCaseScriptProjection(verifiedCaseId);
      const completed = await api.waitForOperation(operation.operation_id);
      if (completed.resource_ref.type !== 'script_projection') {
        throw new Error(t('workspace.scriptInvalid'));
      }
      const projection = await api.getScriptProjection(completed.resource_ref.id);
      setScript(projection);
      setScriptLinks({});
      const queue = await api.getReviewQueue(verifiedCaseId);
      const normalizerOperation = await api.startProductionAgent(verifiedCaseId, 'FACT_NORMALIZER');
      const completedNormalizer = await api.waitForOperation(normalizerOperation.operation_id);
      if (completedNormalizer.resource_ref.type !== 'production_artifact') {
        throw new Error(t('workspace.scriptInvalid'));
      }
      const artifact = await api.getFactNormalizerArtifact(completedNormalizer.resource_ref.id);
      setReviewFlowContext({ caseId: verifiedCaseId, facts: queue.items, normalizerArtifact: artifact });
      clearVerifiedWorkspace();
      await navigate({ to: '/review/mode' });
    } catch (error) {
      setScriptError(error instanceof StandbyApiError
        ? `${error.code}: ${error.message}`
        : error instanceof Error ? error.message : t('workspace.scriptInvalid'));
    } finally {
      setScriptBusy(false);
    }
  };

  const refreshMasterCue = async (file: File) => {
    if (!verifiedCaseId || !verifiedWorkspace) throw new Error(t('workspace.scriptApiMissing'));
    const api = createStandbyBrowserApi();
    if (!api) throw new Error(t('workspace.scriptApiMissing'));
    const previous = verifiedWorkspace.sources.find((source) => source.role === 'MASTER_CUE');
    const refreshed = await api.refreshMasterCueFile(verifiedCaseId, file);
    if (previous?.sha256 === refreshed.sha256) return false;

    const extraction = await api.startExtraction(verifiedCaseId, 'UPSTAGE_AGENT');
    await api.waitForOperation(extraction.operation_id);
    const queue = await api.getReviewQueue(verifiedCaseId);
    const normalizer = await api.startProductionAgent(verifiedCaseId, 'FACT_NORMALIZER');
    const completed = await api.waitForOperation(normalizer.operation_id);
    if (completed.resource_ref.type !== 'production_artifact') {
      throw new Error('Normalizer artifact is missing.');
    }
    const artifact = await api.getFactNormalizerArtifact(completed.resource_ref.id);
    setReviewFlowContext({ caseId: verifiedCaseId, facts: queue.items, normalizerArtifact: artifact });
    clearVerifiedWorkspace();
    await navigate({ to: '/review/mode' });
    return true;
  };

  useEffect(() => {
    if (!verifiedCaseId || script) return;
    if (import.meta.env.VITE_STANDBY_DEMO_MODE === 'ideal') {
      setScript(idealDemoScriptProjection(verifiedCaseId));
      return;
    }
    const api = createStandbyBrowserApi();
    if (!api) return;
    void api.getCaseScriptProjection(verifiedCaseId)
      .then((projection) => setScript(projection))
      .catch((error) => {
        if (error instanceof StandbyApiError && error.status === 404) return;
        setScriptError(error instanceof Error ? error.message : t('workspace.scriptInvalid'));
      });
  }, [script, t, verifiedCaseId]);

  const linkScriptSegment = (segmentId: string, eventId: string) => {
    setScriptLinks((current) => ({ ...current, [segmentId]: eventId }));
  };
  const entities = useMemo<StageEntity[]>(() => {
    if (!editorCueSheet || !selectedCue) return [];
    return buildStageEntities(editorCueSheet, selectedCue.cue_id, selectedEventId ?? undefined);
  }, [editorCueSheet, selectedCue, selectedEventId]);

  const requestStoryboard = async (eventId: string) => {
    const requestVersion = ++storyboardRequestVersion.current;
    if (import.meta.env.VITE_STANDBY_DEMO_MODE === 'ideal') {
      setStoryboardState({ status: 'RECONSTRUCTING', version: eventId });
      window.setTimeout(() => {
        if (requestVersion === storyboardRequestVersion.current) {
          setStoryboardState(idealDemoStoryboard(eventId));
        }
      }, 240);
      return;
    }
    const api = createStandbyBrowserApi();
    if (!api || !verifiedCaseId) {
      setStoryboardState({ status: 'FAILED', summary: 'Storyboard Agent is not connected.' });
      return;
    }
    setStoryboardState({ status: 'RECONSTRUCTING', version: eventId });
    try {
      const operation = await api.startProductionAgent(
        verifiedCaseId,
        'STORYBOARD_RECOMPOSER',
        eventId,
      );
      const completed = await api.waitForOperation(operation.operation_id);
      if (requestVersion !== storyboardRequestVersion.current) return;
      if (completed.resource_ref.type !== 'production_artifact') {
        throw new Error('Storyboard Agent returned an invalid result reference.');
      }
      const artifact = await api.getProductionArtifact<StoryboardAgentArtifact>(
        completed.resource_ref.id,
      );
      if (requestVersion !== storyboardRequestVersion.current) return;
      if (artifact.payload.event_id !== eventId) {
        throw new Error('Storyboard Agent returned a stale event.');
      }
      setStoryboardState({
        status: 'READY',
        summary: artifact.payload.summary,
        version: `Config ${artifact.config_id ?? 'latest'}`,
        eventId: artifact.payload.event_id,
        authority: artifact.authority,
        beats: artifact.payload.beats,
        missingEvidence: artifact.payload.missing_evidence,
      });
    } catch (error) {
      if (requestVersion !== storyboardRequestVersion.current) return;
      setStoryboardState({
        status: 'FAILED',
        summary: error instanceof Error ? error.message : 'Storyboard reconstruction failed.',
      });
    }
  };

  const editCueCell = (edit: CueCellEdit) => {
    if (!cueSheet || !editorCueSheet) return;
    const nextCueSheet = applyCueEdit(editorCueSheet, edit);
    const key = cueEditKey(edit);
    const baseValue = cueEditValue(cueSheet, edit);
    const nextValue = cueEditValue(nextCueSheet, edit);
    setDraftCueSheet(nextCueSheet);
    setCueChanges((current) => {
      const next = { ...current };
      if (nextValue === baseValue) {
        delete next[key];
      } else {
        next[key] = {
          rowId: edit.eventId,
          column: cueEditColumn(edit),
          from: baseValue,
          to: nextValue,
        };
      }
      return next;
    });
  };

  const discardCueChanges = () => {
    setDraftCueSheet(cueSheet ? structuredClone(cueSheet) : null);
    setCueChanges({});
  };

  const saveCueChanges = () => {
    if (!editorCueSheet || Object.keys(cueChanges).length === 0) return;
    commitCueSheet(editorCueSheet, Object.values(cueChanges), 'demo@standby');
    setCueChanges({});
  };

  if (verifiedWorkspace) {
    return (
      <VerifiedWorkspace
        workspace={verifiedWorkspace}
        script={script}
        scriptEntries={scriptEntries}
        unlinkedScriptSegments={unlinkedSegments}
        scriptBusy={scriptBusy}
        scriptError={scriptError}
        onLinkScriptSegment={linkScriptSegment}
        onScriptFile={(file) => void connectScript(file)}
        storyboardState={storyboardState}
        onStoryboardRequest={(eventId) => void requestStoryboard(eventId)}
        onWorkspaceUpdated={(workspace) => setVerifiedWorkspace(workspace.case_id, workspace)}
        onMasterCueRefresh={refreshMasterCue}
      />
    );
  }

  if (!cueSheet) {
    return (
      <div className="flex h-[calc(100vh-56px)] items-center justify-center">
        <div className="text-center">
          <p className="text-lg text-muted-foreground">{t('workspace.noSheet')}</p>
          <button
            onClick={() => navigate({ to: '/' })}
            className="mt-4 border border-foreground bg-foreground px-4 py-2 text-sm text-background hover:bg-muted-foreground"
          >
            {t('workspace.back')}
          </button>
        </div>
      </div>
    );
  }

  const currentCueSheet = editorCueSheet ?? cueSheet;
  const crossoverValue = currentCueSheet.venue.has_backstage_crossover ? 'true' : 'false';

  const handleSelectEvent = (cueId: string, eventId: string) => {
    const selectedIndex = timelineEvents.findIndex((item) => item.event.event_id === selectedEventId);
    const nextIndex = timelineEvents.findIndex((item) => item.event.event_id === eventId);
    const adjacentForward = selectedIndex >= 0 && nextIndex === selectedIndex + 1;
    const previousItem = timelineEvents[selectedIndex];
    const nextItem = timelineEvents[nextIndex];
    const previousEntities = adjacentForward && previousItem
      ? buildStageEntities(currentCueSheet, previousItem.cueId, previousItem.event.event_id)
      : [];
    const nextEntities = adjacentForward && nextItem
      ? buildStageEntities(currentCueSheet, nextItem.cueId, nextItem.event.event_id)
      : [];

    setStageMotion({
      eventKey: eventId,
      animate: adjacentForward,
      changedEntityIds: adjacentForward
        ? changedStageEntityIds(previousEntities, nextEntities)
        : [],
    });
    selectCue(cueId);
    selectEvent(eventId);
  };

  const popupTarget = popupEventId
    ? timelineEvents.find((item) => item.event.event_id === popupEventId) ?? null
    : null;
  const popupCue = popupTarget
    ? currentCueSheet.cues.find((cue) => cue.cue_id === popupTarget.cueId) ?? null
    : null;

  const stagePanel = (
    <>
      <PanelHeader
        title={t('workspace.stagePanel')}
        right={(
          <span className="text-[10px] text-muted-foreground">
            {selectedCue?.scene_number}{selectedEvt ? ` · ${selectedEvt.event_id}` : ''}
          </span>
        )}
      />
      <div className="min-h-0 flex-1">
        <StageSimulator crossover={crossoverValue} entities={entities} motion={stageMotion} />
      </div>
    </>
  );

  const cueSheetPanel = (
    <CueSheetEditorPanel
      cueSheet={currentCueSheet}
      contradictions={validationResult?.contradictions ?? []}
      selectedEventId={selectedEventId}
      focusTarget={focusTarget}
      editedKeys={new Set(Object.keys(cueChanges))}
      changes={Object.values(cueChanges)}
      revisions={revisions}
      onSelectEvent={handleSelectEvent}
      onEdit={editCueCell}
      onDiscardAll={discardCueChanges}
      onSave={saveCueChanges}
      onLoadRevision={loadRevision}
    />
  );

  const popupOverlay = popupTarget && popupCue ? (
    <>
      <button
        type="button"
        aria-label="Close event popup"
        className="absolute inset-0 z-30 bg-black/50"
        onClick={() => setPopupEventId(null)}
      />
      <CueEventPopup
        cue={popupCue}
        event={popupTarget.event}
        cueSheet={currentCueSheet}
        contradictions={validationResult?.contradictions.filter(
          (item) => item.event_id === popupTarget.event.event_id,
        ) ?? []}
        onClose={() => setPopupEventId(null)}
        onGoto={() => {
          handleSelectEvent(popupTarget.cueId, popupTarget.event.event_id);
          setFocusTarget({
            eventId: popupTarget.event.event_id,
            requestId: Date.now(),
          });
          setPopupEventId(null);
        }}
      />
    </>
  ) : null;

  return (
    <div className="flex h-[calc(100vh-56px)] flex-col">
      {/* Top bar */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface px-3">
        <span className="mono text-[11px] text-muted-foreground">
          {currentCueSheet.metadata.title}
        </span>
        <div className="flex items-center gap-3 text-[11px]">
          <button
            type="button"
            onClick={() => setStageFirst((current) => !current)}
            className="border border-border px-2 py-0.5 hover:bg-muted"
          >
            {locale === 'ko' ? '패널 전환' : 'Swap panels'}
          </button>
          {validationResult && (
            <>
            {validationResult.errors > 0 && (
              <span className="mono border border-violation bg-violation-bg px-2 py-0.5 text-violation">
                ERROR {validationResult.errors}
              </span>
            )}
            {validationResult.warnings > 0 && (
              <span className="mono border border-review bg-review-bg px-2 py-0.5 text-review">
                ACTION REQUIRED {validationResult.warnings}
              </span>
            )}
            {validationResult.total_contradictions === 0 && (
              <span className="mono border border-consistent/50 px-2 py-0.5 text-consistent">OK</span>
            )}
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <ScriptSidebar
          entries={scriptEntries}
          script={script}
          unlinkedSegments={unlinkedSegments}
          busy={scriptBusy}
          error={scriptError}
          selectedEventId={selectedEventId}
          onScriptFile={(file) => void connectScript(file)}
          onLinkSegment={linkScriptSegment}
          onSelectEvent={(eventId) => {
            const target = timelineEvents.find((item) => item.event.event_id === eventId);
            if (target) handleSelectEvent(target.cueId, eventId);
          }}
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex min-h-0 flex-1 basis-0 flex-col border-b border-border">
              {stageFirst ? stagePanel : cueSheetPanel}
            </div>

            <div className="relative flex min-h-0 flex-1 basis-0 flex-col border-b border-border">
              {stageFirst ? cueSheetPanel : stagePanel}
              {popupOverlay}
            </div>
          </div>

          <Timeline
            cueSheet={currentCueSheet}
            selectedEventId={selectedEventId}
            contradictions={validationResult?.contradictions ?? []}
            onSelectEvent={(cueId, eventId) => {
              handleSelectEvent(cueId, eventId);
              setPopupEventId(eventId);
            }}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Timeline Component ────────────────────────────────────

function Timeline({
  cueSheet,
  selectedEventId,
  contradictions,
  onSelectEvent,
}: {
  cueSheet: CueSheet;
  selectedEventId: string | null;
  contradictions: Contradiction[];
  onSelectEvent: (cueId: string, eventId: string) => void;
}) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const events = cueSheet.cues.flatMap((cue) => cue.events.map((event) => ({ cue, event })));

  // Auto-scroll to selected event
  useEffect(() => {
    if (!selectedEventId || !scrollRef.current) return;
    const el = scrollRef.current.querySelector(`[data-event="${selectedEventId}"]`);
    el?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [selectedEventId]);

  return (
    <div className="flex h-[156px] shrink-0 flex-col border-t border-border bg-surface">
      <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-3">
        <span className="text-[10px] tracking-[0.14em] text-muted-foreground uppercase">
          {t('workspace.timelinePanel')}
        </span>
        <span className="text-[10px] text-muted-foreground">{events.length} EVENTS</span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full min-w-max items-stretch gap-px p-2">
          {events.map(({ cue, event }, index) => {
            const eventContradictions = contradictions.filter((item) => item.event_id === event.event_id);
            const errorCount = eventContradictions.filter((item) => item.severity === 'ERROR').length;
            const warningCount = eventContradictions.filter((item) => item.severity === 'WARNING').length;
            const selected = event.event_id === selectedEventId;
            const sceneBoundary = index > 0 && events[index - 1]?.cue.cue_id !== cue.cue_id;
            return (
              <button
                key={`${cue.cue_id}:${event.event_id}`}
                type="button"
                data-event={event.event_id}
                onClick={() => onSelectEvent(cue.cue_id, event.event_id)}
                className={cn(
                  'timeline-event-cell relative flex w-48 shrink-0 flex-col justify-between overflow-hidden border p-2 text-left transition-[border-color,background-color,color] duration-150',
                  sceneBoundary && 'ml-3 border-l-2 border-l-border-strong',
                  selected
                    ? 'is-selected border-foreground bg-foreground/10 outline outline-1 outline-foreground'
                    : errorCount > 0
                      ? 'border-violation bg-violation-bg/30 hover:bg-violation-bg'
                      : warningCount > 0
                        ? 'border-review bg-review-bg/30 hover:bg-review-bg'
                        : 'border-border bg-background hover:bg-muted',
                )}
              >
                <span className="timeline-playhead" aria-hidden="true" />
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <span className="text-[9px] text-muted-foreground">{String(index + 1).padStart(2, '0')} · {cue.scene_number}</span>
                    <p className="mt-1 truncate text-[10px] font-semibold">{event.event_id}</p>
                  </div>
                  <span className="border border-border px-1 py-0.5 text-[8px] text-muted-foreground">{event.trigger.type}</span>
                </div>
                <p className="mt-2 line-clamp-2 text-[10px] leading-4 text-muted-foreground">
                  {event.trigger.description || '—'}
                </p>
                <div className="mt-2 flex items-end justify-between gap-2">
                  <span className="text-[9px] text-muted-foreground">{event.actions.length} ACTIONS</span>
                  <div className="flex flex-col items-end gap-1">
                    {errorCount > 0 && <span className="text-[8px] text-violation">ERROR {errorCount}</span>}
                    {warningCount > 0 && <span className="text-[8px] text-review">ACTION REQUIRED {warningCount}</span>}
                    {errorCount === 0 && warningCount === 0 && <span className="text-[8px] text-consistent">OK</span>}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Stage Entity Builder ──────────────────────────────────

function buildStageEntities(
  cueSheet: CueSheet,
  upToCueId: string,
  upToEventId?: string,
): StageEntity[] {
  type EntityState = {
    on_stage: boolean;
    last_direction: Direction | null;
    transition?: StageEntity['transition'];
    carried_by?: string;
  };

  const charState: Record<string, EntityState> = {};
  const propState: Record<string, EntityState> = {};

  for (const char of cueSheet.characters) {
    charState[char.id] = { on_stage: false, last_direction: null };
  }
  for (const prop of cueSheet.props) {
    propState[prop.id] = { on_stage: false, last_direction: null };
  }

  let done = false;
  for (const cue of cueSheet.cues) {
    if (done) break;
    for (const event of cue.events) {
      for (const state of Object.values(charState)) state.transition = undefined;
      for (const state of Object.values(propState)) state.transition = undefined;

      for (const action of event.actions) {
        switch (action.type) {
          case 'character_enter':
            if (action.character_id && charState[action.character_id]) {
              charState[action.character_id].on_stage = true;
              charState[action.character_id].last_direction = action.direction ?? null;
              charState[action.character_id].transition = 'ENTER';
            }
            break;
          case 'character_exit':
            if (action.character_id && charState[action.character_id]) {
              charState[action.character_id].on_stage = false;
              charState[action.character_id].last_direction = action.direction ?? null;
              charState[action.character_id].transition = 'EXIT';
            }
            break;
          case 'backstage_crossover':
            if (action.character_id && charState[action.character_id]) {
              charState[action.character_id].last_direction = action.to ?? null;
            }
            break;
          case 'prop_in':
            if (action.prop_id && propState[action.prop_id]) {
              propState[action.prop_id].on_stage = true;
              propState[action.prop_id].last_direction = action.direction ?? null;
              propState[action.prop_id].transition = 'ENTER';
              propState[action.prop_id].carried_by = action.carried_by ?? undefined;
            }
            break;
          case 'prop_out':
            if (action.prop_id && propState[action.prop_id]) {
              propState[action.prop_id].on_stage = false;
              propState[action.prop_id].last_direction = action.direction ?? null;
              propState[action.prop_id].transition = 'EXIT';
            }
            break;
        }
      }
      if (upToEventId && event.event_id === upToEventId) { done = true; break; }
    }
    if (!done && cue.cue_id === upToCueId) break;
  }

  const entities: StageEntity[] = [];

  for (const char of cueSheet.characters) {
    const state = charState[char.id];
    if (state.on_stage) {
      entities.push({
        id: char.id,
        label: char.name,
        kind: 'person',
        zone: '무대',
        transition: state.transition,
        lastDirection: state.last_direction ?? undefined,
      });
    } else if (state.last_direction) {
      entities.push({
        id: char.id,
        label: char.name,
        kind: 'person',
        zone: state.last_direction === 'stage_left' ? '상수윙' : '하수윙',
        transition: state.transition,
        lastDirection: state.last_direction,
      });
    }
  }

  for (const prop of cueSheet.props) {
    const state = propState[prop.id];
    if (state.on_stage) {
      entities.push({
        id: prop.id,
        label: prop.name,
        kind: 'prop',
        zone: '무대',
        transition: state.transition,
        lastDirection: state.last_direction ?? undefined,
        carriedBy: state.carried_by ?? undefined,
      });
    } else if (state.last_direction) {
      entities.push({
        id: prop.id,
        label: prop.name,
        kind: 'prop',
        zone: state.last_direction === 'stage_left' ? '상수윙' : '하수윙',
        transition: state.transition,
        lastDirection: state.last_direction,
      });
    }
  }

  return entities;
}

function changedStageEntityIds(previous: StageEntity[], next: StageEntity[]): string[] {
  const beforeById = new Map(previous.map((entity) => [entity.id, entity]));
  const afterById = new Map(next.map((entity) => [entity.id, entity]));

  return [...new Set([...beforeById.keys(), ...afterById.keys()])].filter((entityId) => {
    const before = beforeById.get(entityId);
    const after = afterById.get(entityId);
    return !before
      || !after
      || before.kind !== after.kind
      || before.zone !== after.zone
      || before.carriedBy !== after.carriedBy;
  });
}
