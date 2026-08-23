import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import {
  AlertTriangle,
  FileDown,
  FileSpreadsheet,
  Info,
  LoaderCircle,
  Plus,
  UploadCloud,
  X,
} from 'lucide-react';
import {
  StandbyApiError,
  createStandbyBrowserApi,
  type SourceOrigin,
} from '@/lib/standby-api';
import exampleMasterCueText from '@/assets/standby-example-master-cue.json?raw';
import { useCueSheetStore, useReviewFlowStore, useStandbyWorkspaceStore } from '@/store';
import { parseCueSheetJson } from '@/lib/cue-sheet-json';
import { useI18n, type Locale } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useNavigate } from '@tanstack/react-router';
import type { CueSheet } from '@/types/cue-sheet';

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const SOURCE_ORIGIN: SourceOrigin = 'USER_PROVIDED';

const ZONES = [
  ['STAGE', '무대'],
  ['STAGE_RIGHT_WING', '상수윙'],
  ['STAGE_LEFT_WING', '하수윙'],
  ['STAGE_RIGHT_CHANGE', '상수 환복소'],
  ['STAGE_LEFT_CHANGE', '하수 환복소'],
] as const;

type SourceInputKind = 'MASTER_CUE';
type InputErrorKind = SourceInputKind | 'RAW_JSON';
type Crossover = 'UNKNOWN' | 'AVAILABLE' | 'UNAVAILABLE';
type SubmitPhase = 'IDLE' | 'UPLOADING' | 'EXTRACTING' | 'NORMALIZING' | 'REVIEW' | 'FAILED';

type SelectedSource = {
  file: File;
  sha256: string;
  origin: SourceOrigin;
  batchSize: number;
};

type RouteDraft = {
  id: string;
  routeId: string;
  capacity: string;
  from: string;
  to: string;
  minSeconds: string;
  maxSeconds: string;
};

type EntityDraft = {
  id: string;
  entityId: string;
  kind: 'PERSON' | 'PROP';
  zone: string;
};

const SOURCE_CONFIG: Record<SourceInputKind, {
  label: string;
  accept: string;
  extensions: string[];
}> = {
  MASTER_CUE: {
    label: 'MASTER CUE',
    accept: '.xlsx,.pdf,.json',
    extensions: ['xlsx', 'pdf', 'json'],
  },
};

function newRoute(
  from = 'STAGE_LEFT_WING',
  to = 'STAGE_LEFT_CHANGE',
  routeId = '',
): RouteDraft {
  return {
    id: crypto.randomUUID(),
    routeId,
    capacity: '1',
    from,
    to,
    minSeconds: '',
    maxSeconds: '',
  };
}

function newEntity(): EntityDraft {
  return {
    id: crypto.randomUUID(),
    entityId: '',
    kind: 'PERSON',
    zone: 'STAGE',
  };
}

function extensionOf(filename: string) {
  return filename.split('.').pop()?.toLowerCase() ?? '';
}

function bytesToHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

async function sha256(bytes: BufferSource) {
  return bytesToHex(await crypto.subtle.digest('SHA-256', bytes));
}

async function inspectSourceFile(
  kind: SourceInputKind,
  file: File,
  locale: Locale,
  origin: SourceOrigin = SOURCE_ORIGIN,
): Promise<SelectedSource> {
  const config = SOURCE_CONFIG[kind];
  const extension = extensionOf(file.name);

  if (!config.extensions.includes(extension)) {
    throw new Error(locale === 'ko'
      ? `${config.accept.replaceAll(',', ', ')} 형식만 사용할 수 있습니다.`
      : `Only ${config.accept.replaceAll(',', ', ')} files are supported.`);
  }
  if (file.size === 0) throw new Error(locale === 'ko' ? '빈 파일은 사용할 수 없습니다.' : 'Empty files are not supported.');
  if (file.size > MAX_SOURCE_BYTES) throw new Error(locale === 'ko' ? '파일은 50MB 이하여야 합니다.' : 'Files must be 50MB or smaller.');

  const bytes = await file.arrayBuffer();
  const signature = new Uint8Array(bytes.slice(0, 5));
  const isPdf = String.fromCharCode(...signature) === '%PDF-';
  const isZip = signature[0] === 0x50 && signature[1] === 0x4b;
  const text = new TextDecoder().decode(bytes);
  if (extension === 'pdf' && !isPdf) throw new Error(locale === 'ko' ? '확장자와 PDF 파일 서명이 일치하지 않습니다.' : 'The extension does not match the PDF file signature.');
  if ((extension === 'docx' || extension === 'xlsx') && !isZip) {
    throw new Error(locale === 'ko' ? '확장자와 Office 파일 서명이 일치하지 않습니다.' : 'The extension does not match the Office file signature.');
  }
  if (extension === 'json') parseCueSheetJson(text, locale);
  return { file, sha256: await sha256(bytes), origin, batchSize: 1 };
}

export function InputScreen() {
  const { locale, t } = useI18n();
  const navigate = useNavigate();
  const clearWorkspace = useStandbyWorkspaceStore((state) => state.clear);
  const loadCueSheet = useCueSheetStore((state) => state.loadCueSheet);
  const clearCueSheet = useCueSheetStore((state) => state.clearCueSheet);
  const setReviewFlowContext = useReviewFlowStore((state) => state.setReviewContext);
  const setNormalizerLoading = useReviewFlowStore((state) => state.setNormalizerLoading);
  const setNormalizerArtifact = useReviewFlowStore((state) => state.setNormalizerArtifact);
  const setNormalizerError = useReviewFlowStore((state) => state.setNormalizerError);
  const clearReviewFlow = useReviewFlowStore((state) => state.clear);
  const [masterCue, setMasterCue] = useState<SelectedSource | null>(null);
  const [masterCueBatchFiles, setMasterCueBatchFiles] = useState<File[]>([]);
  const [sourceErrors, setSourceErrors] = useState<Partial<Record<InputErrorKind, string>>>({});
  const [crossover, setCrossover] = useState<Crossover>('UNKNOWN');
  const [minimumChangeSeconds, setMinimumChangeSeconds] = useState('60');
  const [routes, setRoutes] = useState<RouteDraft[]>([
    newRoute('STAGE_LEFT_WING', 'STAGE_LEFT_CHANGE', 'ROUTE_TO_CHANGE'),
    newRoute('STAGE_LEFT_CHANGE', 'STAGE', 'ROUTE_TO_ENTRY'),
  ]);
  const [entities, setEntities] = useState<EntityDraft[]>([newEntity()]);
  const [stageHash, setStageHash] = useState('계산 중');
  const [phase, setPhase] = useState<SubmitPhase>('IDLE');
  const [message, setMessage] = useState<string | null>(null);

  const stageSpec = useMemo(() => ({
    contract_version: 'standby.stage-spec.v1',
    wings: ['STAGE_RIGHT_WING', 'STAGE_LEFT_WING'],
    crossover,
    route_times: routes.map((route) => ({
      from: route.from,
      to: route.to,
      min_ms: Math.round(Number(route.minSeconds) * 1000),
      max_ms: Math.round(Number(route.maxSeconds) * 1000),
    })),
    route_capacities: routes.map((route) => ({
      route_id: route.routeId.trim(),
      capacity: Number(route.capacity),
    })),
    minimum_change_ms: Math.round(Number(minimumChangeSeconds) * 1000),
    initial_state: entities.map((entity) => ({
      entity_id: entity.entityId.trim(),
      kind: entity.kind,
      zone: entity.zone,
    })),
    source_evidence: {
      quote: '사용자가 STANDBY 입력 화면에서 직접 확인한 무대 사양',
      locator: 'STAGE_SPEC_FORM',
    },
  }), [crossover, entities, minimumChangeSeconds, routes]);

  const stageErrors = useMemo(() => {
    const errors: string[] = [];
    const changeSeconds = Number(minimumChangeSeconds);
    if (!Number.isFinite(changeSeconds) || changeSeconds < 0) {
      errors.push(t('input.error.changeTime'));
    }
    if (routes.length < 2) errors.push(t('input.error.routes'));
    const routeIds = routes.map((route) => route.routeId.trim());
    if (routeIds.some((routeId) => !routeId)) errors.push(t('input.error.routeId'));
    if (new Set(routeIds).size !== routeIds.length) errors.push(t('input.error.routeIdDuplicate'));
    for (const route of routes) {
      const min = Number(route.minSeconds);
      const max = Number(route.maxSeconds);
      const capacity = Number(route.capacity);
      if (route.from === route.to) errors.push(t('input.error.routeSame'));
      if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < min) {
        errors.push(t('input.error.routeTime'));
      }
      if (!Number.isInteger(capacity) || capacity < 1) {
        errors.push(t('input.error.capacity'));
      }
    }
    if (entities.length === 0) errors.push(t('input.error.entity'));
    const entityIds = entities.map((entity) => entity.entityId.trim());
    if (entityIds.some((id) => !id)) errors.push(t('input.error.entityId'));
    if (new Set(entityIds).size !== entityIds.length) errors.push(t('input.error.entityDuplicate'));
    return [...new Set(errors)];
  }, [entities, locale, minimumChangeSeconds, routes]);

  useEffect(() => {
    let active = true;
    void sha256(new TextEncoder().encode(JSON.stringify(stageSpec))).then((hash) => {
      if (active) setStageHash(hash);
    });
    return () => { active = false; };
  }, [stageSpec]);

  const selectSources = async (
    kind: SourceInputKind,
    files: File[],
    origin: SourceOrigin = SOURCE_ORIGIN,
  ) => {
    setPhase('IDLE');
    setMessage(null);
    clearReviewFlow();
    clearWorkspace();
    clearCueSheet();
    setSourceErrors((current) => ({ ...current, [kind]: undefined }));
    setMasterCueBatchFiles([]);
    try {
      const candidates = files.filter((file) => SOURCE_CONFIG[kind].extensions.includes(extensionOf(file.name)));
      if (candidates.length === 0) {
        throw new Error(locale === 'ko' ? '선택한 파일에 큐시트가 없습니다.' : 'No cue sheet was found in the selected files.');
      }
      let selected: SelectedSource | null = null;
      for (const candidate of candidates) {
        try {
          selected = await inspectSourceFile(kind, candidate, locale, origin);
          break;
        } catch {
          // A mixed batch may contain unrelated files with a supported extension.
        }
      }
      if (!selected) {
        throw new Error(locale === 'ko' ? '선택한 파일에서 유효한 큐시트를 찾지 못했습니다.' : 'No valid cue sheet was found in the selected files.');
      }
      setMasterCue({ ...selected, batchSize: files.length });
      setMasterCueBatchFiles(files);
      setSourceErrors((current) => ({ ...current, MASTER_CUE: undefined }));
    } catch (error) {
      setMasterCue(null);
      setSourceErrors((current) => ({
        ...current,
        [kind]: error instanceof Error ? error.message : locale === 'ko' ? '파일을 확인할 수 없습니다.' : 'Could not inspect the file.',
      }));
    }
  };

  const attachExampleMasterCue = () => {
    const file = new File(
      [exampleMasterCueText],
      'STANDBY_example_master_cue.json',
      { type: 'application/json', lastModified: 0 },
    );
    void selectSources('MASTER_CUE', [file], 'CONTROLLED_FIXTURE');
  };

  const openRawJson = async (file: File) => {
    clearReviewFlow();
    clearWorkspace();
    clearCueSheet();
    setSourceErrors((current) => ({ ...current, RAW_JSON: undefined }));
    try {
      if (extensionOf(file.name) !== 'json') {
        throw new Error(locale === 'ko' ? '.json 형식만 사용할 수 있습니다.' : 'Only .json files are supported.');
      }
      if (file.size === 0) {
        throw new Error(locale === 'ko' ? '빈 파일은 사용할 수 없습니다.' : 'Empty files are not supported.');
      }
      if (file.size > MAX_SOURCE_BYTES) {
        throw new Error(locale === 'ko' ? '파일은 50MB 이하여야 합니다.' : 'Files must be 50MB or smaller.');
      }
      const text = await file.text();
      const cueSheet: CueSheet = parseCueSheetJson(text, locale);
      loadCueSheet(cueSheet);
      await navigate({ to: '/workspace' });
    } catch (error) {
      setSourceErrors((current) => ({
        ...current,
        RAW_JSON: error instanceof Error
          ? error.message
          : locale === 'ko' ? 'JSON 파일을 확인할 수 없습니다.' : 'Could not inspect the JSON file.',
      }));
    }
  };

  const ready = Boolean(masterCue);

  const apiClient = () => {
    return createStandbyBrowserApi();
  };

  const startExtraction = async () => {
    if (!masterCue) return;

    const api = apiClient();
    if (!api) {
      setPhase('FAILED');
      setMessage(
        t('input.error.api'),
      );
      return;
    }

    try {
      setPhase('UPLOADING');
      setMessage(t('input.status.upload'));
      const createdCase = await api.createCase(`STANDBY ${new Date().toLocaleString('ko-KR')}`);
      const uploads = [
        api.uploadSourceFile(createdCase.case_id, 'MASTER_CUE', masterCue.file, masterCue.origin),
      ];
      if (stageErrors.length === 0) {
        uploads.push(api.uploadStageSpec(createdCase.case_id, stageSpec, SOURCE_ORIGIN));
      }
      await Promise.all(uploads);

      setPhase('EXTRACTING');
      setMessage(t('input.status.extract'));
      const extractionStartedAt = Date.now();
      const operation = await api.startExtraction(createdCase.case_id, 'UPSTAGE_AGENT');
      await api.waitForOperation(operation.operation_id);
      const queue = await api.getReviewQueue(createdCase.case_id);
      if (masterCue.batchSize > 1) {
        const remaining = 12_000 - (Date.now() - extractionStartedAt);
        if (remaining > 0) await new Promise((resolve) => window.setTimeout(resolve, remaining));
      }
      setReviewFlowContext({
        caseId: createdCase.case_id,
        facts: queue.items,
        normalizerArtifact: null,
      });
      setPhase('REVIEW');
      setMessage(t('input.status.review', { count: queue.items.length }));
      setNormalizerLoading(createdCase.case_id);
      await navigate({ to: '/review/mode' });
      void (async () => {
        try {
          const normalizerOperation = await api.startProductionAgent(createdCase.case_id, 'FACT_NORMALIZER');
          const completedNormalizer = await api.waitForOperation(normalizerOperation.operation_id);
          if (completedNormalizer.resource_ref.type !== 'production_artifact') {
            throw new Error(locale === 'ko'
              ? 'Fact Normalizer 결과 위치가 올바르지 않습니다.'
              : 'The Fact Normalizer returned an invalid result reference.');
          }
          const artifact = await api.getFactNormalizerArtifact(completedNormalizer.resource_ref.id);
          setNormalizerArtifact(createdCase.case_id, artifact);
        } catch (error) {
          setNormalizerError(
            createdCase.case_id,
            error instanceof Error ? error.message : t('input.error.extract'),
          );
        }
      })();
    } catch (error) {
      setPhase('FAILED');
      setMessage(
        error instanceof StandbyApiError
          ? `${error.code}: ${error.message}`
          : error instanceof Error ? error.message : t('input.error.extract'),
      );
    }
  };

  if (phase === 'UPLOADING' || phase === 'EXTRACTING' || phase === 'NORMALIZING') {
    return <ExtractionLoadingScreen phase={phase} />;
  }

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-foreground lg:px-8">
      <div className="mx-auto max-w-[1500px]">
        <header className="border-b border-border pb-5">
          <h1 className="text-2xl font-medium">{t('input.title')}</h1>
        </header>

        <section className="mt-6 grid items-start gap-4 lg:grid-cols-2">
          <div className="grid gap-4">
            <SourceCard
              kind="MASTER_CUE"
              source={masterCue}
              error={sourceErrors.MASTER_CUE}
              batchFiles={masterCueBatchFiles}
              onFiles={(files) => void selectSources('MASTER_CUE', files)}
              onUseExample={attachExampleMasterCue}
            />
            <RawJsonCard
              error={sourceErrors.RAW_JSON}
              onFile={(file) => void openRawJson(file)}
            />
          </div>
          <StageSpecCard
            crossover={crossover}
            minimumChangeSeconds={minimumChangeSeconds}
            routes={routes}
            entities={entities}
            hash={stageHash}
            errors={stageErrors}
            onCrossover={setCrossover}
            onMinimumChange={setMinimumChangeSeconds}
            onRoutes={setRoutes}
            onEntities={setEntities}
          />
        </section>

        <footer className="mt-5 flex justify-end border border-border bg-surface p-4">
          <button
            type="button"
            disabled={!ready || phase === 'REVIEW'}
            onClick={() => void startExtraction()}
            className={cn(
              'flex min-w-52 items-center justify-center gap-2 border px-5 py-3 text-sm font-medium',
              ready && phase !== 'REVIEW'
                ? 'border-foreground bg-foreground text-background hover:bg-muted-foreground'
                : 'cursor-not-allowed border-border bg-muted text-muted-foreground',
            )}
          >
            {t('input.start')}
          </button>
        </footer>

        {message && <ExtractionStatus phase={phase} message={message} />}
      </div>
    </main>
  );
}

function RawJsonCard({ error, onFile }: { error?: string; onFile: (file: File) => void }) {
  const { locale } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <article className="border border-border bg-surface">
      <div className="flex items-start justify-between border-b border-border p-4">
        <div className="flex gap-3">
          <div className="border border-border p-2"><FileSpreadsheet className="h-4 w-4" /></div>
          <div>
            <p className="mono text-xs font-semibold tracking-[0.1em]">RAW JSON</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {locale === 'ko' ? '구조화된 큐시트 JSON을 바로 편집합니다.' : 'Open structured cue sheet JSON directly in the editor.'}
            </p>
          </div>
        </div>
      </div>
      <button
        type="button"
        className={cn(
          'm-4 flex min-h-28 w-[calc(100%-2rem)] flex-col items-center justify-center border border-dashed p-5 text-center',
          dragging ? 'border-foreground bg-muted' : error ? 'border-violation bg-violation-bg' : 'border-border bg-background',
        )}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const file = event.dataTransfer.files[0];
          if (file) onFile(file);
        }}
      >
        <UploadCloud className="h-6 w-6 text-muted-foreground" />
        <span className="mt-3 text-sm font-medium">
          {locale === 'ko' ? 'JSON 파일 선택 또는 놓기' : 'Choose or drop a JSON file'}
        </span>
        <span className="mono mt-1 text-[11px] text-muted-foreground">.json / MAX 50MB</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = '';
        }}
      />
      {error && (
        <div className="flex gap-2 border-t border-border p-4 text-xs leading-5 text-violation">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}
        </div>
      )}
    </article>
  );
}

function ExtractionLoadingScreen({ phase }: { phase: 'UPLOADING' | 'EXTRACTING' | 'NORMALIZING' }) {
  const { t } = useI18n();
  return (
    <section
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-50 overflow-y-auto bg-background px-5 py-10"
    >
      <div className="mx-auto flex min-h-full max-w-5xl flex-col justify-center">
        <div className="standby-loading-wordmark brand-mono" aria-label="STANDBY">
          {'STANDBY'.split('').map((letter, index) => (
            <span
              key={letter}
              aria-hidden="true"
              className="standby-loading-letter"
              style={{ '--standby-letter-index': index } as CSSProperties}
            >
              {letter}
            </span>
          ))}
        </div>
        <div className="mt-8">
          <h2 className="text-2xl font-medium">
            {t(phase === 'UPLOADING'
              ? 'input.loading.upload'
              : phase === 'NORMALIZING'
                ? 'input.loading.normalize'
                : 'input.loading.extract')}
          </h2>
        </div>
        <p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">
          {t('input.loading.result')}
        </p>

        <div className="mt-10 grid gap-3 md:grid-cols-3" aria-hidden="true">
          <LoadingPreview title={t('input.loading.stage')}>
            <div className="grid h-36 grid-cols-[42px_1fr_42px] items-stretch border border-border bg-background">
              <div className="border-r border-border bg-muted" />
              <div className="relative">
                <span className="absolute left-[28%] top-[34%] h-4 w-4 rounded-full border border-person bg-person/20" />
                <span className="absolute right-[24%] top-[55%] h-4 w-4 border border-prop bg-prop/20" />
              </div>
              <div className="border-l border-border bg-muted" />
            </div>
          </LoadingPreview>
          <LoadingPreview title={t('input.loading.evidence')}>
            <div className="space-y-3">
              {[0, 1, 2].map((index) => (
                <div key={index} className="border border-border bg-background p-3">
                  <div className="h-2 w-20 animate-pulse bg-muted-foreground/30" />
                  <div className="mt-3 h-2 w-full animate-pulse bg-muted" />
                  <div className="mt-2 h-2 w-3/4 animate-pulse bg-muted" />
                </div>
              ))}
            </div>
          </LoadingPreview>
          <LoadingPreview title={t('input.loading.timeline')}>
            <div className="flex h-36 items-end gap-2 overflow-hidden border border-border bg-background p-3">
              {[48, 72, 58, 92, 66].map((height, index) => (
                <div
                  key={index}
                  className="min-w-12 flex-1 border border-border bg-muted"
                  style={{ height: `${height}%` }}
                />
              ))}
            </div>
          </LoadingPreview>
        </div>

        <p className="mt-6 text-xs text-muted-foreground">{t('input.loading.wait')}</p>
      </div>
    </section>
  );
}

function LoadingPreview({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="border border-border bg-surface p-4">
      <h3 className="mb-4 text-sm font-medium">{title}</h3>
      {children}
    </article>
  );
}

function SourceCard({
  kind,
  source,
  error,
  batchFiles,
  onFiles,
  onUseExample,
}: {
  kind: SourceInputKind;
  source: SelectedSource | null;
  error?: string;
  batchFiles: File[];
  onFiles: (files: File[]) => void;
  onUseExample: () => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const config = SOURCE_CONFIG[kind];
  const helper = t('input.cue.fileHelper');

  return (
    <article className="border border-border bg-surface">
      <div className="flex items-start justify-between border-b border-border p-4">
        <div className="flex gap-3">
          <div className="border border-border p-2"><FileSpreadsheet className="h-4 w-4" /></div>
          <div>
            <p className="mono text-xs font-semibold tracking-[0.1em]">{config.label}</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{helper}</p>
          </div>
        </div>
        <AuthorityToken reviewed={Boolean(source)} />
      </div>

      <button
        type="button"
        className={cn(
          'm-4 flex min-h-40 w-[calc(100%-2rem)] flex-col items-center justify-center border border-dashed p-5 text-center',
          dragging ? 'border-foreground bg-muted' : error ? 'border-violation bg-violation-bg' : 'border-border bg-background',
        )}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          const files = Array.from(event.dataTransfer.files);
          if (files.length > 0) onFiles(files);
        }}
      >
        <UploadCloud className="h-6 w-6 text-muted-foreground" />
        <span className="mt-3 text-sm font-medium">{source ? t('input.replace') : t('input.choose')}</span>
        <span className="mono mt-1 text-[11px] text-muted-foreground">{config.accept.replaceAll(',', ' · ')} / MAX 50MB</span>
      </button>
      <input
        ref={inputRef}
        type="file"
        multiple
        accept={config.accept}
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) onFiles(files);
          event.target.value = '';
        }}
      />

      <div className="mx-4 mb-4 flex justify-end">
        <button
          type="button"
          onClick={onUseExample}
          className="flex items-center gap-2 border border-border bg-background px-3 py-2 text-xs font-medium hover:border-foreground"
        >
          <FileDown className="h-4 w-4" />
          {t('input.cue.useExample')}
        </button>
      </div>

      <div className="border-t border-border p-4">
        {error ? (
          <div className="flex gap-2 text-xs leading-5 text-violation">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{error}
          </div>
        ) : source ? (
          <div className="space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium">{t('input.cue.files')}</span>
              <span className="mono text-[10px] text-muted-foreground">{batchFiles.length}</span>
            </div>
            <div className="divide-y divide-border border border-border">
              {batchFiles.map((file, index) => (
                <div key={`${file.name}:${file.size}:${index}`} className="flex items-center gap-3 p-3">
                  <span className="border border-border p-2"><FileSpreadsheet className="h-4 w-4" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium">{file.name}</p>
                    <p className="mono mt-1 text-[10px] text-muted-foreground">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                  </div>
                </div>
              ))}
            </div>
            <button type="button" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)} className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground"><Info size={12} />{t('input.details')}</button>
            {detailsOpen && (
              <dl className="space-y-2 border-t border-border pt-2">
                <SourceRow label={t('input.origin')} value={source.origin} />
                <SourceRow label="SHA-256" value={`${source.sha256.slice(0, 12)}…`} mono />
              </dl>
            )}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function StageSpecCard({
  crossover,
  minimumChangeSeconds,
  routes,
  entities,
  hash,
  errors,
  onCrossover,
  onMinimumChange,
  onRoutes,
  onEntities,
}: {
  crossover: Crossover;
  minimumChangeSeconds: string;
  routes: RouteDraft[];
  entities: EntityDraft[];
  hash: string;
  errors: string[];
  onCrossover: (value: Crossover) => void;
  onMinimumChange: (value: string) => void;
  onRoutes: (value: RouteDraft[]) => void;
  onEntities: (value: EntityDraft[]) => void;
}) {
  const { t } = useI18n();
  const valid = errors.length === 0;
  const [detailsOpen, setDetailsOpen] = useState(false);

  return (
    <article className="border border-border bg-surface">
      <div className="flex items-start justify-between border-b border-border p-4">
        <div className="flex gap-3">
          <div className="border border-border p-2"><FileSpreadsheet className="h-4 w-4" /></div>
          <div>
            <p className="mono text-xs font-semibold tracking-[0.1em]">STAGE SPEC</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t('input.stage.helper')}</p>
          </div>
        </div>
        <AuthorityToken reviewed={valid} />
      </div>

      <div className="space-y-5 p-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('input.crossover')}>
            <select className="w-full border border-border bg-background px-2 py-2 text-xs" value={crossover} onChange={(event) => onCrossover(event.target.value as Crossover)}>
              <option value="UNKNOWN">{t('input.crossover.unknown')}</option>
              <option value="AVAILABLE">{t('input.crossover.available')}</option>
              <option value="UNAVAILABLE">{t('input.crossover.unavailable')}</option>
            </select>
          </Field>
          <Field label={t('input.minimumChange')}>
            <input className="w-full border border-border bg-background px-2 py-2 text-xs" type="number" min="0" value={minimumChangeSeconds} onChange={(event) => onMinimumChange(event.target.value)} />
          </Field>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">{t('input.routeTimes')}</p>
            <button type="button" className="flex items-center gap-1 text-[11px]" onClick={() => onRoutes([...routes, newRoute()])}><Plus className="h-3 w-3" />{t('input.addRoute')}</button>
          </div>
          <div className="space-y-2">
            {routes.map((route) => (
              <div key={route.id} className="border border-border bg-background p-2">
                <div className="mb-2 grid grid-cols-[1fr_100px] gap-2">
                  <Field label="ROUTE ID">
                    <input
                      aria-label="경로 ID"
                      placeholder="HASU_CROSSOVER"
                      className="w-full border border-border bg-surface px-2 py-1.5 text-xs"
                      value={route.routeId}
                      onChange={(event) => onRoutes(routes.map((item) => item.id === route.id ? { ...item, routeId: event.target.value } : item))}
                    />
                  </Field>
                  <Field label="CAPACITY">
                    <input
                      aria-label="경로 수용 인원"
                      className="w-full border border-border bg-surface px-2 py-1.5 text-xs"
                      type="number"
                      min="1"
                      step="1"
                      value={route.capacity}
                      onChange={(event) => onRoutes(routes.map((item) => item.id === route.id ? { ...item, capacity: event.target.value } : item))}
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-[1fr_1fr_auto] gap-2">
                  <ZoneSelect value={route.from} onChange={(from) => onRoutes(routes.map((item) => item.id === route.id ? { ...item, from } : item))} />
                  <ZoneSelect value={route.to} onChange={(to) => onRoutes(routes.map((item) => item.id === route.id ? { ...item, to } : item))} />
                  <button type="button" aria-label="경로 삭제" onClick={() => onRoutes(routes.filter((item) => item.id !== route.id))}><X className="h-4 w-4 text-muted-foreground" /></button>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <TimeInput label={t('input.min')} value={route.minSeconds} onChange={(minSeconds) => onRoutes(routes.map((item) => item.id === route.id ? { ...item, minSeconds } : item))} />
                  <TimeInput label={t('input.max')} value={route.maxSeconds} onChange={(maxSeconds) => onRoutes(routes.map((item) => item.id === route.id ? { ...item, maxSeconds } : item))} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">{t('input.initialState')}</p>
            <button type="button" className="flex items-center gap-1 text-[11px]" onClick={() => onEntities([...entities, newEntity()])}><Plus className="h-3 w-3" />{t('input.addEntity')}</button>
          </div>
          <div className="space-y-2">
            {entities.map((entity) => (
              <div key={entity.id} className="grid grid-cols-[1fr_90px_1fr_auto] gap-2 border border-border bg-background p-2">
                <input aria-label="Entity ID" placeholder={t('input.entityPlaceholder')} className="min-w-0 border border-border bg-surface px-2 py-2 text-xs" value={entity.entityId} onChange={(event) => onEntities(entities.map((item) => item.id === entity.id ? { ...item, entityId: event.target.value } : item))} />
                <select aria-label="엔티티 종류" className="border border-border bg-surface px-2 text-xs" value={entity.kind} onChange={(event) => onEntities(entities.map((item) => item.id === entity.id ? { ...item, kind: event.target.value as EntityDraft['kind'] } : item))}>
                  <option value="PERSON">{t('input.person')}</option><option value="PROP">{t('input.prop')}</option>
                </select>
                <ZoneSelect value={entity.zone} onChange={(zone) => onEntities(entities.map((item) => item.id === entity.id ? { ...item, zone } : item))} />
                <button type="button" aria-label="초기 배치 삭제" onClick={() => onEntities(entities.filter((item) => item.id !== entity.id))}><X className="h-4 w-4 text-muted-foreground" /></button>
              </div>
            ))}
          </div>
        </div>

        {errors.length > 0 && (
          <div className="border border-review bg-review-bg p-3 text-xs leading-5 text-review">
            {errors.map((error) => <p key={error}>· {error}</p>)}
          </div>
        )}

        <div className="border-t border-border pt-3 text-xs">
          <button type="button" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)} className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground"><Info size={12} />{t('input.details')}</button>
          {detailsOpen && (
            <dl className="mt-2 space-y-2">
              <SourceRow label={t('input.origin')} value="USER_PROVIDED" />
              <SourceRow label="SHA-256" value={hash === '계산 중' ? hash : `${hash.slice(0, 12)}…`} mono />
            </dl>
          )}
        </div>
      </div>
    </article>
  );
}

function AuthorityToken({ reviewed }: { reviewed: boolean }) {
  return (
    <span className={cn('mono border px-2 py-1 text-[10px]', reviewed ? 'border-consistent text-consistent' : 'border-review text-review')}>
      {reviewed ? 'REVIEWED' : 'UNREVIEWED'}
    </span>
  );
}

function SourceRow({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-2">
      <dt className="mono text-[10px] text-muted-foreground">{label}</dt>
      <dd className={cn('truncate text-right', mono && 'mono')}>{value}</dd>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[11px] text-muted-foreground">{label}</span>{children}</label>;
}

function ZoneSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const { locale } = useI18n();
  return (
    <select aria-label="무대 구역" className="min-w-0 border border-border bg-surface px-2 py-2 text-xs" value={value} onChange={(event) => onChange(event.target.value)}>
      {ZONES.map(([zone, label]) => <option key={zone} value={zone}>{locale === 'ko' ? label : {
        STAGE: 'Stage',
        STAGE_RIGHT_WING: 'Stage Right Wing',
        STAGE_LEFT_WING: 'Stage Left Wing',
        STAGE_RIGHT_CHANGE: 'Stage Right Change Area',
        STAGE_LEFT_CHANGE: 'Stage Left Change Area',
      }[zone]}</option>)}
    </select>
  );
}

function TimeInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="grid grid-cols-[54px_1fr] items-center gap-2">
      <span className="mono text-[9px] text-muted-foreground">{label}</span>
      <input className="min-w-0 border border-border bg-surface px-2 py-1 text-xs" type="number" min="0" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function ExtractionStatus({ phase, message }: { phase: SubmitPhase; message: string }) {
  return (
    <div className={cn('mt-4 flex gap-3 border p-4', phase === 'FAILED' ? 'border-review bg-review-bg' : 'border-border bg-surface')}>
      {phase === 'FAILED' ? <AlertTriangle className="h-5 w-5 shrink-0 text-review" /> : <LoaderCircle className="h-5 w-5 shrink-0 animate-spin" />}
      <div><p className="mono text-[10px] text-muted-foreground">{phase}</p><p className="mt-1 text-sm leading-6">{message}</p></div>
    </div>
  );
}
