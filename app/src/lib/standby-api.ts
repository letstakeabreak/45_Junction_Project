import type { CueCellPatch, CueRevision, CueRowOperation, FactCandidate, FactNormalizerArtifact, WorkspaceSnapshot } from '@/types/standby';
import type { ScriptProjection } from '@/types/script';

export type SourceRole = "SCRIPT" | "MASTER_CUE" | "STAGE_SPEC";
export type SourceOrigin = "REAL_REFERENCE" | "USER_PROVIDED" | "CONTROLLED_FIXTURE";
export type ExtractionAdapter = "CONTROLLED_FIXTURE" | "UPSTAGE_AGENT";
export type OperationStatus = "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
export type ProductionAgentRole = "FACT_NORMALIZER" | "STORYBOARD_RECOMPOSER" | "REHEARSAL_BRIEF";

const DEMO_SESSION_KEY = "standby.demo-session.v1";
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type SourceVersion = {
  source_id: string;
  case_id: string;
  role: SourceRole;
  sha256: string;
  origin: SourceOrigin | "MUTATED_FIXTURE";
  authority: "UNREVIEWED" | "REVIEWED";
  media_type: string | null;
  original_filename: string | null;
};

export type StandbyOperation = {
  operation_id: string;
  status: OperationStatus;
  result_source: "CONTROLLED_FIXTURE" | "UPSTAGE" | "MIXED" | null;
  resource_ref:
    | { type: "extraction_run"; id: string }
    | { type: "production_artifact"; id: string }
    | { type: "script_projection"; id: string };
  error: { code: string; message: string } | null;
};

export type ExtractionOperation = StandbyOperation & {
  resource_ref: { type: "extraction_run"; id: string };
};

type ApiErrorBody = {
  error?: { code?: string; message?: string; request_id?: string; details?: unknown };
};

export class StandbyApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
  }
}

export type StandbyApiOptions = {
  baseUrl: string;
  getSessionId: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
};

export class StandbyApi {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: StandbyApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  createCase(title: string) {
    return this.request<{ case_id: string; title: string; created_at: string }>("/v1/cases", {
      method: "POST",
      body: JSON.stringify({ title }),
      idempotent: true,
    });
  }

  uploadSourceFile(
    caseId: string,
    role: "SCRIPT" | "MASTER_CUE",
    file: File,
    origin: SourceOrigin = "USER_PROVIDED",
  ) {
    const form = new FormData();
    form.append("origin", origin);
    form.append("file", file);
    return this.request<SourceVersion>(`/v1/cases/${caseId}/sources/${role}`, {
      method: "POST",
      body: form,
      idempotent: true,
    });
  }

  refreshMasterCueFile(caseId: string, file: File, origin: SourceOrigin = "USER_PROVIDED") {
    const form = new FormData();
    form.append("origin", origin);
    form.append("file", file);
    return this.request<SourceVersion>(`/v1/cases/${caseId}/source-refreshes/MASTER_CUE`, {
      method: "POST",
      body: form,
      idempotent: true,
    });
  }

  uploadStageSpec(caseId: string, content: unknown, origin: SourceOrigin = "USER_PROVIDED") {
    return this.request<SourceVersion>(`/v1/cases/${caseId}/sources/STAGE_SPEC`, {
      method: "POST",
      body: JSON.stringify({ origin, content, media_type: "application/json" }),
      idempotent: true,
    });
  }

  uploadSourceContent(
    caseId: string,
    role: SourceRole,
    content: unknown,
    options: { origin?: SourceOrigin; mediaType?: string; originalFilename?: string } = {},
  ) {
    return this.request<SourceVersion>(`/v1/cases/${caseId}/sources/${role}`, {
      method: "POST",
      body: JSON.stringify({
        origin: options.origin ?? "CONTROLLED_FIXTURE",
        content,
        media_type: options.mediaType ?? "application/json",
        original_filename: options.originalFilename ?? `${role.toLowerCase()}.fixture.json`,
      }),
      idempotent: true,
    });
  }

  startExtraction(caseId: string, adapter: ExtractionAdapter = "UPSTAGE_AGENT") {
    return this.request<ExtractionOperation>(`/v1/cases/${caseId}/extraction-runs`, {
      method: "POST",
      body: JSON.stringify({ adapter }),
      idempotent: true,
    });
  }

  startProductionAgent(caseId: string, role: ProductionAgentRole, eventId?: string) {
    return this.request<StandbyOperation>(`/v1/cases/${caseId}/production-agent-runs`, {
      method: "POST",
      body: JSON.stringify({ role, ...(eventId ? { event_id: eventId } : {}) }),
      idempotent: true,
    });
  }

  startScriptProjection(file: File) {
    const form = new FormData();
    form.append("file", file);
    return this.request<StandbyOperation>("/v1/script-projections", {
      method: "POST",
      body: form,
      idempotent: true,
    });
  }

  startCaseScriptProjection(caseId: string) {
    return this.request<StandbyOperation>(`/v1/cases/${caseId}/script-projections`, {
      method: "POST",
      body: "{}",
      idempotent: true,
    });
  }

  getOperation(operationId: string) {
    return this.request<StandbyOperation>(`/v1/operations/${operationId}`);
  }

  getFactNormalizerArtifact(artifactId: string) {
    return this.request<FactNormalizerArtifact>(`/v1/production-artifacts/${artifactId}`);
  }

  getProductionArtifact<T>(artifactId: string) {
    return this.request<T>(`/v1/production-artifacts/${artifactId}`);
  }

  getScriptProjection(projectionId: string) {
    return this.request<ScriptProjection>(`/v1/script-projections/${projectionId}`);
  }

  getCaseScriptProjection(caseId: string) {
    return this.request<ScriptProjection>(`/v1/cases/${caseId}/script-projection`);
  }

  async waitForOperation(
    operationId: string,
    options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<StandbyOperation> {
    const intervalMs = options.intervalMs ?? 1_000;
    const deadline = Date.now() + (options.timeoutMs ?? 660_000);
    while (Date.now() <= deadline) {
      options.signal?.throwIfAborted();
      const operation = await this.getOperation(operationId);
      if (operation.status === "SUCCEEDED") return operation;
      if (operation.status === "FAILED") {
        throw new StandbyApiError(
          502,
          operation.error?.code ?? "EXTRACTION_FAILED",
          operation.error?.message ?? "Extraction failed.",
          null,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const timeout = globalThis.setTimeout(resolve, intervalMs);
        options.signal?.addEventListener(
          "abort",
          () => {
            globalThis.clearTimeout(timeout);
            reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }
    throw new StandbyApiError(504, "OPERATION_TIMEOUT", "Extraction did not finish in time.", null);
  }

  getReviewQueue(caseId: string) {
    return this.request<{ items: FactCandidate[]; next_cursor: null }>(
      `/v1/cases/${caseId}/review-queue`,
    );
  }

  reviewFacts(
    caseId: string,
    reviews: Array<
      | {
          fact_id: string;
          decision: "REVIEWED";
          source: "UPSTAGE_RECOMMENDATION" | "CUSTOM";
          corrected_value: unknown;
        }
      | { fact_id: string; decision: "REJECTED" }
    >,
  ) {
    return this.request<{ items: unknown[] }>(`/v1/cases/${caseId}/fact-reviews:batch`, {
      method: "POST",
      body: JSON.stringify({ reviews }),
      idempotent: true,
    });
  }

  freezeReviewSnapshot(caseId: string) {
    return this.request<{ snapshot_id: string; reviewed_fact_ids: string[] }>(
      `/v1/cases/${caseId}/review-snapshots`,
      { method: "POST", body: "{}", idempotent: true },
    );
  }

  getWorkspace(caseId: string) {
    return this.request<WorkspaceSnapshot>(`/v1/cases/${caseId}/workspace`);
  }

  listCueRevisions(caseId: string) {
    return this.request<{ items: CueRevision[] }>(`/v1/cases/${caseId}/cue-revisions`);
  }

  getCueRevision(caseId: string, revisionId: string) {
    return this.request<CueRevision>(`/v1/cases/${caseId}/cue-revisions/${revisionId}`);
  }

  createCueRevision(
    caseId: string,
    input: { base_revision_id: string; base_source_sha256: string; patches: CueCellPatch[]; row_operations?: CueRowOperation[] },
  ) {
    return this.request<CueRevision>(`/v1/cases/${caseId}/cue-revisions`, {
      method: "POST",
      body: JSON.stringify(input),
      idempotent: true,
    });
  }

  async downloadCueRevision(caseId: string, revisionId: string) {
    const sessionId = await this.options.getSessionId();
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/cases/${caseId}/cue-revisions/${revisionId}/export.xlsx`,
      { headers: { "x-standby-session": sessionId } },
    );
    if (!response.ok) {
      const json = (await response.json()) as ApiErrorBody;
      throw new StandbyApiError(
        response.status,
        json.error?.code ?? "API_ERROR",
        json.error?.message ?? "XLSX export failed.",
        json.error?.request_id ?? null,
      );
    }
    return {
      blob: await response.blob(),
      disposition: response.headers.get("content-disposition"),
    };
  }

  async downloadStandardCueDocx(caseId: string, revisionId: string) {
    return this.downloadFile(`/v1/cases/${caseId}/cue-revisions/${revisionId}/export.docx`);
  }

  async getStandardCuePrintHtml(caseId: string, revisionId: string) {
    const sessionId = await this.options.getSessionId();
    const response = await this.fetchImpl(
      `${this.baseUrl}/v1/cases/${caseId}/cue-revisions/${revisionId}/print`,
      { headers: { "x-standby-session": sessionId } },
    );
    if (!response.ok) throw new StandbyApiError(response.status, "PRINT_EXPORT_FAILED", "Print export failed.", null);
    return response.text();
  }

  private async downloadFile(path: string) {
    const sessionId = await this.options.getSessionId();
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { "x-standby-session": sessionId },
    });
    if (!response.ok) {
      const json = (await response.json()) as ApiErrorBody;
      throw new StandbyApiError(response.status, json.error?.code ?? "API_ERROR", json.error?.message ?? "Export failed.", json.error?.request_id ?? null);
    }
    return { blob: await response.blob(), disposition: response.headers.get("content-disposition") };
  }

  private async request<T>(
    path: string,
    init: RequestInit & { idempotent?: boolean } = {},
  ): Promise<T> {
    const sessionId = await this.options.getSessionId();
    const headers = new Headers(init.headers);
    headers.set("x-standby-session", sessionId);
    if (typeof init.body === "string") headers.set("content-type", "application/json");
    if (init.idempotent) headers.set("idempotency-key", crypto.randomUUID());
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    const json = (await response.json()) as T & ApiErrorBody;
    if (!response.ok) {
      throw new StandbyApiError(
        response.status,
        json.error?.code ?? "API_ERROR",
        json.error?.message ?? "STANDBY API request failed.",
        json.error?.request_id ?? null,
      );
    }
    return json;
  }
}

function getDemoSessionId() {
  const current = localStorage.getItem(DEMO_SESSION_KEY);
  if (current && UUID_V4_PATTERN.test(current)) return current;
  const created = crypto.randomUUID();
  localStorage.setItem(DEMO_SESSION_KEY, created);
  return created;
}

export function createStandbyBrowserApi(): StandbyApi | null {
  const baseUrl = import.meta.env.VITE_STANDBY_API_BASE_URL as string | undefined;
  return baseUrl ? new StandbyApi({ baseUrl, getSessionId: getDemoSessionId }) : null;
}
