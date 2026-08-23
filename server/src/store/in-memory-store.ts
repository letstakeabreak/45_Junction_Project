import { extractControlledFixture } from "../domain/extraction.js";
import { DomainError } from "../domain/errors.js";
import { projectScriptSegments } from "../domain/script-projection.js";
import {
  validateProductionAgentOutput,
  type ProductionOutputAllowlist,
  type StoryboardEntityRule,
} from "../domain/production-agents.js";
import {
  NORMALIZED_FACT_TYPES,
  assertNormalizedFactSemantics,
  assertStageSpecSemantics,
} from "../contracts/semantic.js";
import type {
  CaseRecord,
  CellPatch,
  CueRowOperation,
  CueRevision,
  CueRow,
  ExtractionAdapter,
  ExtractionRunRecord,
  FactCandidate,
  FactReviewCommand,
  FactNormalizationRecommendationMap,
  FactNormalizerArtifactPayload,
  InternalSourceVersion,
  InternalReviewSnapshot,
  Operation,
  Origin,
  ProductionAgentFrozenInput,
  ProductionAgentRole,
  ProductionArtifact,
  ReviewRecord,
  ReviewSnapshot,
  ScriptProjection,
  SourceRole,
  SourceVersion,
  WorkspaceSnapshot,
} from "../domain/types.js";
import { compileEventGraph, workspaceEvents } from "../domain/compiler.js";
import { verifyProduction } from "../domain/verifier.js";
import { canonicalJson, hashJson, sha256 } from "../lib/hash.js";
import { cueRowsFromXlsx, exportXlsxRevision } from "../domain/xlsx-revision.js";
import { standardCueDocx, standardCuePrintHtml } from "../domain/standard-cue-export.js";
import type { ExtractionProvider } from "../providers/extraction-provider.js";
import type { ProductionAgentProvider } from "../providers/production-agent-provider.js";
import type { ScriptProjectionProvider } from "../providers/script-projection-provider.js";

const ROLES: SourceRole[] = ["SCRIPT", "MASTER_CUE", "STAGE_SPEC"];
const REQUIRED_SOURCE_ROLES: SourceRole[] = ["MASTER_CUE"];

type IdempotencyRecord = {
  fingerprint: string;
  response: unknown;
};

function cloneRows(rows: CueRow[]): CueRow[] {
  return rows.map((row) => ({ ...row }));
}

function cueRows(content: unknown): CueRow[] {
  if (content === null || typeof content !== "object") {
    throw new DomainError(422, "CONTRACT_VIOLATION", "MASTER_CUE content must be an object.");
  }
  const rows = (content as Record<string, unknown>).rows;
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new DomainError(422, "CONTRACT_VIOLATION", "MASTER_CUE rows are required.");
  }
  return rows.map((row, index) => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) {
      throw new DomainError(422, "CONTRACT_VIOLATION", `MASTER_CUE row ${index} is invalid.`);
    }
    const values = Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
    );
    if (!values.id) {
      throw new DomainError(422, "CONTRACT_VIOLATION", `MASTER_CUE row ${index} has no id.`);
    }
    return values as CueRow;
  });
}

export class InMemoryStore {
  private readonly cases = new Map<string, CaseRecord>();
  private readonly operations = new Map<string, Operation>();
  private readonly operationCaseIds = new Map<string, string>();
  private readonly operationActorIds = new Map<string, string>();
  private readonly extractionRuns = new Map<string, ExtractionRunRecord>();
  private readonly extractionCache = new Map<string, string>();
  private readonly productionArtifacts = new Map<string, ProductionArtifact>();
  private readonly productionArtifactCaseIds = new Map<string, string>();
  private readonly productionCache = new Map<string, string>();
  private readonly latestFactNormalizerArtifactByCase = new Map<string, string>();
  private readonly scriptProjections = new Map<string, ScriptProjection>();
  private readonly scriptProjectionOwnerIds = new Map<string, string>();
  private readonly caseScriptProjectionIds = new Map<string, string>();
  private readonly idempotency = new Map<string, IdempotencyRecord>();
  private sequence = 0;

  constructor(
    private readonly upstageProvider: ExtractionProvider | null = null,
    private readonly productionAgentProvider: ProductionAgentProvider | null = null,
    private readonly scriptProjectionProvider: ScriptProjectionProvider | null = null,
  ) {}

  private id(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${this.sequence.toString().padStart(4, "0")}`;
  }

  private now(): string {
    return new Date().toISOString();
  }

  withIdempotency<T>(scope: string, key: string, input: unknown, create: () => T): T {
    const fingerprint = hashJson(input);
    const mapKey = `${scope}:${key}`;
    const existing = this.idempotency.get(mapKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new DomainError(
          409,
          "IDEMPOTENCY_KEY_REUSED",
          "The idempotency key was already used with a different request.",
        );
      }
      return existing.response as T;
    }

    const response = create();
    this.idempotency.set(mapKey, { fingerprint, response });
    return response;
  }

  createCase(title: string, ownerId: string): { case_id: string; title: string; created_at: string } {
    const caseId = this.id("case");
    const createdAt = this.now();
    this.cases.set(caseId, {
      case_id: caseId,
      owner_id: ownerId,
      title,
      sources: new Map(),
      facts: new Map(),
      reviews: [],
      snapshots: [],
      revisions: [],
      current_snapshot_id: null,
      current_revision_id: null,
      verification: null,
      created_at: createdAt,
    });
    return { case_id: caseId, title, created_at: createdAt };
  }

  uploadSource(input: {
    caseId: string;
    role: SourceRole;
    origin: Origin;
    content: unknown;
    mediaType: string | null;
    originalFilename: string | null;
  }): SourceVersion {
    const record = this.getCase(input.caseId);
    if (input.role === "STAGE_SPEC") {
      assertStageSpecSemantics(input.content);
    }
    const sha256 = hashJson(input.content);
    const existing = record.sources.get(input.role);
    if (existing) {
      if (existing.sha256 === sha256) return this.publicSource(existing);
      throw new DomainError(
        409,
        "SOURCE_SLOT_LOCKED",
        `${input.role} already has an immutable source in this case.`,
      );
    }

    const source = {
      contract_version: "standby.source.v1" as const,
      source_id: this.id("source"),
      case_id: record.case_id,
      role: input.role,
      sha256,
      origin: input.origin,
      authority: "REVIEWED" as const,
      media_type: input.mediaType,
      original_filename: input.originalFilename,
      created_at: this.now(),
      content: structuredClone(input.content),
      bytes: null,
    };
    record.sources.set(input.role, source);

    if (input.role === "MASTER_CUE") {
      const rows = cueRows(input.content);
      const baseRevision: CueRevision = {
        contract_version: "standby.revision.v1",
        revision_id: `rev_source_${sha256.slice(0, 12)}`,
        case_id: record.case_id,
        parent_revision_id: null,
        base_source_sha256: sha256,
        revision_hash: sha256,
        patches: [],
        created_by: "source-upload",
        created_at: source.created_at,
        rows,
      };
      record.revisions.push(baseRevision);
      record.current_revision_id = baseRevision.revision_id;
    }

    return this.publicSource(source);
  }

  async uploadFileSource(input: {
    caseId: string;
    role: "SCRIPT" | "MASTER_CUE";
    origin: Origin;
    bytes: Uint8Array;
    mediaType: string;
    originalFilename: string;
  }): Promise<SourceVersion> {
    const record = this.getCase(input.caseId);
    const sourceHash = sha256(input.bytes);
    const existing = record.sources.get(input.role);
    if (existing) {
      if (existing.sha256 === sourceHash) return this.publicSource(existing);
      throw new DomainError(
        409,
        "SOURCE_SLOT_LOCKED",
        `${input.role} already has an immutable source in this case.`,
      );
    }
    const source = {
      contract_version: "standby.source.v1" as const,
      source_id: this.id("source"),
      case_id: record.case_id,
      role: input.role,
      sha256: sourceHash,
      origin: input.origin,
      authority: "REVIEWED" as const,
      media_type: input.mediaType,
      original_filename: input.originalFilename,
      created_at: this.now(),
      content: null,
      bytes: Uint8Array.from(input.bytes),
    };
    const cueRowsForRevision =
      input.role === "MASTER_CUE" &&
      input.mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        ? await cueRowsFromXlsx(input.bytes)
        : null;
    record.sources.set(input.role, source);
    if (cueRowsForRevision) {
      const baseRevision: CueRevision = {
        contract_version: "standby.revision.v1",
        revision_id: `rev_source_${sourceHash.slice(0, 12)}`,
        case_id: record.case_id,
        parent_revision_id: null,
        base_source_sha256: sourceHash,
        revision_hash: sourceHash,
        patches: [],
        created_by: "source-upload",
        created_at: source.created_at,
        rows: cueRowsForRevision,
      };
      record.revisions.push(baseRevision);
      record.current_revision_id = baseRevision.revision_id;
    }
    return this.publicSource(source);
  }

  async refreshFileSource(input: {
    caseId: string;
    role: "MASTER_CUE";
    origin: Origin;
    bytes: Uint8Array;
    mediaType: string;
    originalFilename: string;
  }): Promise<SourceVersion> {
    const record = this.getCase(input.caseId);
    const current = record.sources.get(input.role);
    const nextHash = sha256(input.bytes);
    if (current?.sha256 === nextHash) return this.publicSource(current);

    const source = {
      contract_version: "standby.source.v1" as const,
      source_id: this.id("source"),
      case_id: record.case_id,
      role: input.role,
      sha256: nextHash,
      origin: input.origin,
      authority: "REVIEWED" as const,
      media_type: input.mediaType,
      original_filename: input.originalFilename,
      created_at: this.now(),
      content: null,
      bytes: Uint8Array.from(input.bytes),
    };
    const rows = input.mediaType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      ? await cueRowsFromXlsx(input.bytes)
      : [];
    record.sources.set(input.role, source);
    record.facts.clear();
    record.reviews = [];
    record.snapshots = [];
    record.current_snapshot_id = null;
    record.verification = null;
    const baseRevision: CueRevision = {
      contract_version: "standby.revision.v1",
      revision_id: `rev_source_${nextHash.slice(0, 12)}`,
      case_id: record.case_id,
      parent_revision_id: null,
      base_source_sha256: nextHash,
      revision_hash: nextHash,
      patches: [],
      created_by: "source-refresh",
      created_at: source.created_at,
      rows,
    };
    record.revisions.push(baseRevision);
    record.current_revision_id = baseRevision.revision_id;
    return this.publicSource(source);
  }

  private extractionCacheKey(record: CaseRecord, adapter: ExtractionAdapter): string {
    return hashJson({
      case_id: record.case_id,
      adapter,
      sources: ROLES.map((role) => [role, record.sources.get(role)?.sha256 ?? null]),
    });
  }

  startExtraction(caseId: string, adapter: ExtractionAdapter): Operation {
    const record = this.getCase(caseId);
    const missingRoles = REQUIRED_SOURCE_ROLES.filter((role) => !record.sources.has(role));
    if (missingRoles.length > 0) {
      throw new DomainError(409, "SOURCE_SLOT_MISSING", "MASTER_CUE is required.", {
        missing_roles: missingRoles,
      });
    }

    const cacheKey = this.extractionCacheKey(record, adapter);
    const cachedRunId = this.extractionCache.get(cacheKey);
    if (cachedRunId && this.extractionRuns.has(cachedRunId)) {
      const createdAt = this.now();
      const cached: Operation = {
        operation_id: this.id("operation"),
        kind: "EXTRACT_SOURCE",
        status: "SUCCEEDED",
        result_source: this.extractionRuns.get(cachedRunId)?.result_source ?? null,
        resource_ref: { type: "extraction_run", id: cachedRunId },
        error: null,
        created_at: createdAt,
        updated_at: createdAt,
      };
      this.operations.set(cached.operation_id, cached);
      this.operationCaseIds.set(cached.operation_id, record.case_id);
      return structuredClone(cached);
    }

    const runId = this.id("extract");
    const createdAt = this.now();
    const operation: Operation = {
      operation_id: this.id("operation"),
      kind: "EXTRACT_SOURCE",
      status: "QUEUED",
      result_source: null,
      resource_ref: { type: "extraction_run", id: runId },
      error: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    this.operations.set(operation.operation_id, operation);
    this.operationCaseIds.set(operation.operation_id, record.case_id);
    queueMicrotask(() => void this.executeExtraction(record, operation, runId, adapter, cacheKey));
    return structuredClone(operation);
  }

  startProductionAgent(input: {
    caseId: string;
    role: ProductionAgentRole;
    eventId: string | null;
  }): Operation {
    const record = this.getCase(input.caseId);
    if (!this.productionAgentProvider) {
      throw new DomainError(
        503,
        "UPSTAGE_NOT_CONFIGURED",
        "Production Agent adapter is not configured.",
      );
    }
    const prepared = this.productionAgentInput(record, input.role, input.eventId);
    const inputFingerprint = hashJson(prepared.input);
    const configFingerprint = this.productionAgentProvider.configFingerprint(input.role);
    const cacheKey = hashJson({
      role: input.role,
      input_fingerprint: inputFingerprint,
      config_fingerprint: configFingerprint,
    });
    const cachedOperationId = this.productionCache.get(cacheKey);
    if (cachedOperationId) {
      const cachedOperation = this.operations.get(cachedOperationId);
      if (cachedOperation && cachedOperation.status !== "FAILED") {
        return structuredClone(cachedOperation);
      }
      this.productionCache.delete(cacheKey);
    }

    const artifactId = this.id("artifact");
    const createdAt = this.now();
    const operation: Operation = {
      operation_id: this.id("operation"),
      kind: "RUN_PRODUCTION_AGENT",
      status: "QUEUED",
      result_source: null,
      resource_ref: { type: "production_artifact", id: artifactId },
      error: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    this.operations.set(operation.operation_id, operation);
    this.operationCaseIds.set(operation.operation_id, record.case_id);
    this.productionCache.set(cacheKey, operation.operation_id);
    queueMicrotask(() =>
      void this.executeProductionAgent({
        record,
        operation,
        artifactId,
        role: input.role,
        frozenInput: prepared.input,
        allowlist: prepared.allowlist,
        inputFingerprint,
        cacheKey,
      }),
    );
    return structuredClone(operation);
  }

  startScriptProjection(input: {
    actorId: string;
    bytes: Uint8Array;
    mediaType: string;
    originalFilename: string;
  }): Operation {
    if (!this.scriptProjectionProvider) {
      throw new DomainError(
        503,
        "UPSTAGE_NOT_CONFIGURED",
        "Script projection adapter is not configured.",
      );
    }

    const projectionId = this.id("script_projection");
    const sourceHash = sha256(input.bytes);
    const createdAt = this.now();
    const source: InternalSourceVersion = {
      contract_version: "standby.source.v1",
      source_id: this.id("source"),
      case_id: projectionId,
      role: "SCRIPT",
      sha256: sourceHash,
      origin: "USER_PROVIDED",
      authority: "UNREVIEWED",
      media_type: input.mediaType,
      original_filename: input.originalFilename,
      created_at: createdAt,
      content: null,
      bytes: Uint8Array.from(input.bytes),
    };
    const operation: Operation = {
      operation_id: this.id("operation"),
      kind: "PROJECT_SCRIPT",
      status: "QUEUED",
      result_source: null,
      resource_ref: { type: "script_projection", id: projectionId },
      error: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    this.operations.set(operation.operation_id, operation);
    this.operationActorIds.set(operation.operation_id, input.actorId);
    this.scriptProjectionOwnerIds.set(projectionId, input.actorId);
    queueMicrotask(() => void this.executeScriptProjection(source, operation, projectionId, null));
    return structuredClone(operation);
  }

  startCaseScriptProjection(caseId: string, actorId: string): Operation {
    if (!this.scriptProjectionProvider) {
      throw new DomainError(
        503,
        "UPSTAGE_NOT_CONFIGURED",
        "Script projection adapter is not configured.",
      );
    }
    const record = this.getCase(caseId);
    const source = record.sources.get("SCRIPT");
    if (!source || !source.bytes || !source.media_type || !source.original_filename) {
      throw new DomainError(409, "SOURCE_SLOT_MISSING", "Upload a SCRIPT DOCX or PDF first.");
    }
    const projectionId = this.id("script_projection");
    const createdAt = this.now();
    const operation: Operation = {
      operation_id: this.id("operation"),
      kind: "PROJECT_SCRIPT",
      status: "QUEUED",
      result_source: null,
      resource_ref: { type: "script_projection", id: projectionId },
      error: null,
      created_at: createdAt,
      updated_at: createdAt,
    };
    this.operations.set(operation.operation_id, operation);
    this.operationCaseIds.set(operation.operation_id, caseId);
    this.scriptProjectionOwnerIds.set(projectionId, actorId);
    queueMicrotask(() => void this.executeScriptProjection(source, operation, projectionId, record));
    return structuredClone(operation);
  }

  getOperation(operationId: string): Operation {
    const operation = this.operations.get(operationId);
    if (!operation) {
      throw new DomainError(404, "RESOURCE_NOT_FOUND", "Operation not found.");
    }
    return structuredClone(operation);
  }

  getCaseScriptProjection(caseId: string): ScriptProjection {
    const projectionId = this.caseScriptProjectionIds.get(caseId);
    if (!projectionId) {
      throw new DomainError(404, "RESOURCE_NOT_FOUND", "Case script projection not found.");
    }
    return this.getScriptProjection(projectionId);
  }

  getExtractionRun(runId: string): ExtractionRunRecord {
    const run = this.extractionRuns.get(runId);
    if (!run) throw new DomainError(404, "RESOURCE_NOT_FOUND", "Extraction run not found.");
    return structuredClone(run);
  }

  getProductionArtifact(artifactId: string): ProductionArtifact {
    const artifact = this.productionArtifacts.get(artifactId);
    if (!artifact) throw new DomainError(404, "RESOURCE_NOT_FOUND", "Production artifact not found.");
    return structuredClone(artifact);
  }

  getScriptProjection(projectionId: string): ScriptProjection {
    const projection = this.scriptProjections.get(projectionId);
    if (!projection) {
      throw new DomainError(404, "RESOURCE_NOT_FOUND", "Script projection not found.");
    }
    return structuredClone(projection);
  }

  getFactNormalizationRecommendations(caseId: string): FactNormalizationRecommendationMap {
    const record = this.getCase(caseId);
    const artifactId = this.latestFactNormalizerArtifactByCase.get(caseId);
    const artifact = artifactId ? this.productionArtifacts.get(artifactId) : null;
    if (!artifact || artifact.role !== "FACT_NORMALIZER") {
      throw new DomainError(
        404,
        "RESOURCE_NOT_FOUND",
        "Fact normalization recommendations not found.",
      );
    }
    const payload = artifact.payload as FactNormalizerArtifactPayload;
    const recommendationsByFactId = Object.fromEntries(
      payload.recommendations.map(({ fact_id: factId, ...recommendation }) => [
        factId,
        structuredClone(recommendation),
      ]),
    );
    let isCurrent = false;
    try {
      const current = this.productionAgentInput(record, "FACT_NORMALIZER", null);
      isCurrent = hashJson(current.input) === artifact.input_fingerprint;
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== "GATE_MISSING_INPUT") throw error;
    }
    return {
      contract_version: "standby.fact-normalization-recommendations.v1",
      artifact_id: artifact.artifact_id,
      authority: "NON_AUTHORITATIVE",
      input_fingerprint: artifact.input_fingerprint,
      is_current: isCurrent,
      recommendations_by_fact_id: recommendationsByFactId,
    };
  }

  approveFactNormalizationRecommendations(input: {
    caseId: string;
    actorId: string;
    factIds: string[];
  }): { items: ReviewRecord[] } {
    const record = this.getCase(input.caseId);
    if (input.factIds.length === 0 || new Set(input.factIds).size !== input.factIds.length) {
      throw new DomainError(
        422,
        "INVALID_ARGUMENT",
        "fact_ids must be a non-empty unique list.",
      );
    }
    const recommendationMap = this.getFactNormalizationRecommendations(input.caseId);
    if (!recommendationMap.is_current) {
      throw new DomainError(
        409,
        "NORMALIZATION_RECOMMENDATIONS_STALE",
        "Fact normalization recommendations no longer match the current fact queue.",
      );
    }
    const reviews = input.factIds.map((factId) => {
      const recommendation = recommendationMap.recommendations_by_fact_id[factId];
      const fact = record.facts.get(factId);
      if (!recommendation || !fact || fact.review_status !== "UNREVIEWED") {
        throw new DomainError(
          422,
          "NORMALIZATION_RECOMMENDATION_MISSING",
          "Every bulk-approved fact must have a current normalized recommendation.",
        );
      }
      return {
        fact_id: factId,
        decision: "REVIEWED" as const,
        source: "UPSTAGE_RECOMMENDATION" as const,
        corrected_value: {
          normalized_fact_type: recommendation.normalized_fact_type,
          value: structuredClone(recommendation.value),
        },
      };
    });
    return this.reviewFacts({
      caseId: input.caseId,
      actorId: input.actorId,
      reviews,
    });
  }

  assertCaseOwner(caseId: string, actorId: string): void {
    const record = this.getCase(caseId);
    if (record.owner_id !== actorId) {
      throw new DomainError(404, "RESOURCE_NOT_FOUND", "Case not found.");
    }
  }

  assertOperationOwner(operationId: string, actorId: string): void {
    const directOwnerId = this.operationActorIds.get(operationId);
    if (directOwnerId !== undefined) {
      if (directOwnerId !== actorId) {
        throw new DomainError(404, "RESOURCE_NOT_FOUND", "Operation not found.");
      }
      return;
    }
    const caseId = this.operationCaseIds.get(operationId);
    if (!caseId) throw new DomainError(404, "RESOURCE_NOT_FOUND", "Operation not found.");
    this.assertCaseOwner(caseId, actorId);
  }

  assertExtractionRunOwner(runId: string, actorId: string): void {
    const run = this.extractionRuns.get(runId);
    if (!run) throw new DomainError(404, "RESOURCE_NOT_FOUND", "Extraction run not found.");
    this.assertCaseOwner(run.case_id, actorId);
  }

  assertProductionArtifactOwner(artifactId: string, actorId: string): void {
    const caseId = this.productionArtifactCaseIds.get(artifactId);
    if (!caseId) throw new DomainError(404, "RESOURCE_NOT_FOUND", "Production artifact not found.");
    this.assertCaseOwner(caseId, actorId);
  }

  assertScriptProjectionOwner(projectionId: string, actorId: string): void {
    const ownerId = this.scriptProjectionOwnerIds.get(projectionId);
    if (!ownerId || ownerId !== actorId) {
      throw new DomainError(404, "RESOURCE_NOT_FOUND", "Script projection not found.");
    }
  }

  getReviewQueue(caseId: string): { items: FactCandidate[]; next_cursor: null } {
    const record = this.getCase(caseId);
    return { items: [...record.facts.values()], next_cursor: null };
  }

  reviewFacts(input: {
    caseId: string;
    actorId: string;
    reviews: FactReviewCommand[];
  }): { items: ReviewRecord[] } {
    const record = this.getCase(input.caseId);
    if (new Set(input.reviews.map((review) => review.fact_id)).size !== input.reviews.length) {
      throw new DomainError(422, "DUPLICATE_FACT_REVIEW", "A fact can be reviewed only once per batch.");
    }
    for (const review of input.reviews) {
      if (review.decision === "REVIEWED") {
        assertNormalizedFactSemantics(review.corrected_value);
      } else if (review.corrected_value !== null || review.source !== "HUMAN_REJECTION") {
        throw new DomainError(
          422,
          "FACT_REVIEW_COMMAND_INVALID",
          "Rejected facts cannot include a corrected value or review source.",
        );
      }
      if (!record.facts.has(review.fact_id)) {
        throw new DomainError(404, "RESOURCE_NOT_FOUND", `Fact ${review.fact_id} not found.`);
      }
    }
    const created: ReviewRecord[] = [];
    for (const review of input.reviews) {
      const fact = record.facts.get(review.fact_id);
      if (!fact) throw new Error("Prevalidated fact is missing.");
      fact.review_status = review.decision;
      fact.reviewed_value = review.corrected_value;
      const reviewRecord: ReviewRecord = {
        review_id: this.id("review"),
        fact_id: fact.fact_id,
        decision: review.decision,
        source: review.source,
        corrected_value: review.corrected_value,
        actor_id: input.actorId,
        created_at: this.now(),
      };
      record.reviews.push(reviewRecord);
      created.push(reviewRecord);
    }
    return { items: created };
  }

  commitFactReviewCommands(input: {
    caseId: string;
    actorId: string;
    reviews: FactReviewCommand[];
  }): { items: ReviewRecord[] } {
    let recommendationMap: FactNormalizationRecommendationMap | null = null;
    for (const review of input.reviews) {
      if (review.decision !== "REVIEWED" || review.source !== "UPSTAGE_RECOMMENDATION") {
        continue;
      }
      recommendationMap ??= this.getFactNormalizationRecommendations(input.caseId);
      if (!recommendationMap.is_current) {
        throw new DomainError(
          409,
          "NORMALIZATION_RECOMMENDATIONS_STALE",
          "Fact normalization recommendations no longer match the current fact queue.",
        );
      }
      const recommendation = recommendationMap.recommendations_by_fact_id[review.fact_id];
      const expectedValue = recommendation
        ? {
            normalized_fact_type: recommendation.normalized_fact_type,
            value: recommendation.value,
          }
        : null;
      if (!expectedValue || hashJson(expectedValue) !== hashJson(review.corrected_value)) {
        throw new DomainError(
          422,
          "NORMALIZATION_RECOMMENDATION_MISMATCH",
          "The reviewed value does not match the current Upstage recommendation.",
        );
      }
    }
    return this.reviewFacts(input);
  }

  createReviewSnapshot(caseId: string, actorId: string): ReviewSnapshot {
    const record = this.getCase(caseId);
    if (REQUIRED_SOURCE_ROLES.some((role) => !record.sources.has(role)) || record.facts.size === 0) {
      throw new DomainError(409, "GATE_MISSING_INPUT", "Extraction must finish before snapshot freeze.");
    }
    const frozenCandidates = structuredClone([...record.facts.values()]).sort((a, b) =>
      a.fact_id.localeCompare(b.fact_id),
    );
    const snapshot: ReviewSnapshot = {
      contract_version: "standby.review-snapshot.v1",
      snapshot_id: this.id("snapshot"),
      case_id: caseId,
      source_snapshot_digest: this.sourceSnapshotDigest(record),
      fact_snapshot_digest: hashJson(frozenCandidates),
      reviewed_fact_ids: [...record.facts.values()]
        .filter((fact) => fact.review_status === "REVIEWED")
        .map((fact) => fact.fact_id)
        .sort(),
      reviewed_link_ids: [],
      frozen_by: actorId,
      frozen_at: this.now(),
    };
    const internalSnapshot: InternalReviewSnapshot = {
      ...snapshot,
      frozen_candidates: frozenCandidates,
    };
    record.snapshots.push(internalSnapshot);
    record.current_snapshot_id = snapshot.snapshot_id;
    this.verifyCurrent(record);
    return snapshot;
  }

  createRevision(input: {
    caseId: string;
    actorId: string;
    baseRevisionId: string;
    baseSourceSha256: string;
    patches: CellPatch[];
    rowOperations?: CueRowOperation[];
  }): CueRevision {
    const record = this.getCase(input.caseId);
    const current = this.currentRevision(record);
    if (record.current_revision_id !== input.baseRevisionId) {
      throw new DomainError(412, "VERSION_PRECONDITION_FAILED", "Cue revision is stale.", {
        current_revision_id: record.current_revision_id,
      });
    }
    if (current.base_source_sha256 !== input.baseSourceSha256) {
      throw new DomainError(409, "SOURCE_HASH_MISMATCH", "Original MASTER_CUE hash does not match.");
    }
    const rowOperations = input.rowOperations ?? [];
    if (input.patches.length === 0 && rowOperations.length === 0) {
      throw new DomainError(422, "CONTRACT_VIOLATION", "At least one cell or row change is required.");
    }

    const rows = cloneRows(current.rows);
    for (const patch of input.patches) {
      const row = rows.find((candidate) => candidate.id === patch.row_id);
      if (!row || !(patch.column in row)) {
        throw new DomainError(422, "CELL_LOCATOR_INVALID", "Cell patch target does not exist.", {
          row_id: patch.row_id,
          column: patch.column,
        });
      }
      if (row[patch.column] !== String(patch.from ?? "")) {
        throw new DomainError(412, "VERSION_PRECONDITION_FAILED", "Cell value changed since edit began.", {
          row_id: patch.row_id,
          column: patch.column,
          current: row[patch.column],
        });
      }
      row[patch.column] = String(patch.to ?? "");
    }
    for (const operation of rowOperations) {
      if (operation.type === "DELETE") {
        const index = rows.findIndex((row) => row.id === operation.row_id);
        if (index < 0) throw new DomainError(422, "CELL_LOCATOR_INVALID", "Deleted event row does not exist.");
        rows.splice(index, 1);
        continue;
      }
      const index = rows.findIndex((row) => row.id === operation.after_row_id);
      if (index < 0) throw new DomainError(422, "CELL_LOCATOR_INVALID", "Event insertion anchor does not exist.");
      if (!/^t_\d+_n_[a-zA-Z0-9_-]+$/.test(operation.row.id) || rows.some((row) => row.id === operation.row.id)) {
        throw new DomainError(422, "CELL_LOCATOR_INVALID", "Added event row ID is invalid or duplicated.");
      }
      const anchorSheet = /^t_(\d+)_/.exec(operation.after_row_id)?.[1];
      const addedSheet = /^t_(\d+)_/.exec(operation.row.id)?.[1];
      if (!anchorSheet || anchorSheet !== addedSheet) {
        throw new DomainError(422, "CELL_LOCATOR_INVALID", "Added event must stay in its anchor sheet.");
      }
      rows.splice(index + 1, 0, structuredClone(operation.row));
    }

    const createdAt = this.now();
    const revisionHash = hashJson({
      base_source_sha256: current.base_source_sha256,
      parent_revision_id: current.revision_id,
      patches: input.patches,
      row_operations: rowOperations,
      rows,
    });
    const revision: CueRevision = {
      contract_version: "standby.revision.v1",
      revision_id: `rev_${revisionHash.slice(0, 16)}`,
      case_id: record.case_id,
      parent_revision_id: current.revision_id,
      base_source_sha256: current.base_source_sha256,
      revision_hash: revisionHash,
      patches: input.patches,
      row_operations: rowOperations,
      created_by: input.actorId,
      created_at: createdAt,
      rows,
    };
    record.revisions.push(revision);
    record.current_revision_id = revision.revision_id;
    if (record.current_snapshot_id) this.verifyCurrent(record);
    return revision;
  }

  getWorkspace(caseId: string): WorkspaceSnapshot {
    const record = this.getCase(caseId);
    const snapshot = this.currentSnapshot(record);
    const revision = this.findCurrentRevision(record);
    const verification = record.verification;
    if (!verification) {
      throw new DomainError(409, "VERIFICATION_NOT_RUN", "Freeze a review snapshot first.");
    }
    const masterCue = record.sources.get("MASTER_CUE");
    if (!masterCue) {
      throw new DomainError(409, "SOURCE_SLOT_MISSING", "MASTER_CUE is missing.");
    }

    const compiled = compileEventGraph(snapshot);
    return {
      case_id: record.case_id,
      title: record.title,
      source_snapshot_digest: snapshot.source_snapshot_digest,
      sources: ROLES.map((role) => record.sources.get(role))
        .filter((source) => source !== undefined)
        .map((source) => this.publicSource(source)),
      review_snapshot_id: snapshot.snapshot_id,
      cue_revision_id: revision?.revision_id ?? null,
      original_master_cue_sha256: masterCue.sha256,
      event_graph: compiled.graph,
      events: workspaceEvents(compiled.graph, compiled.stageSnapshots, verification.findings),
      findings: verification.findings,
      verification,
    };
  }

  listCueRevisions(caseId: string): CueRevision[] {
    const record = this.getCase(caseId);
    return record.revisions.map((revision) => structuredClone(revision));
  }

  getCueRevision(caseId: string, revisionId: string): CueRevision {
    const record = this.getCase(caseId);
    const revision = record.revisions.find((candidate) => candidate.revision_id === revisionId);
    if (!revision) throw new DomainError(404, "RESOURCE_NOT_FOUND", "Cue revision not found.");
    return structuredClone(revision);
  }

  async exportCueRevision(caseId: string, revisionId: string): Promise<{ bytes: Uint8Array; filename: string }> {
    const record = this.getCase(caseId);
    const revision = this.getCueRevision(caseId, revisionId);
    const source = record.sources.get("MASTER_CUE");
    if (!source?.bytes || source.media_type !== "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") {
      throw new DomainError(422, "XLSX_EXPORT_UNAVAILABLE", "The original MASTER_CUE is not an XLSX workbook.");
    }
    if (revision.base_source_sha256 !== source.sha256) {
      throw new DomainError(409, "SOURCE_HASH_MISMATCH", "Revision does not belong to the current MASTER_CUE.");
    }
    const base = record.revisions.find((candidate) => candidate.parent_revision_id === null
      && candidate.base_source_sha256 === source.sha256);
    if (!base) throw new DomainError(409, "SOURCE_SLOT_MISSING", "Base XLSX revision is missing.");
    const filename = (source.original_filename ?? "master-cue.xlsx").replace(/\.xlsx$/i, "") + "-standby.xlsx";
    return { bytes: await exportXlsxRevision(source.bytes, base.rows, revision.rows), filename };
  }

  async exportStandardCueDocx(caseId: string, revisionId: string): Promise<{ bytes: Uint8Array; filename: string }> {
    const record = this.getCase(caseId);
    const revision = this.getCueRevision(caseId, revisionId);
    return {
      bytes: await standardCueDocx(record.title, revision.revision_id, revision.rows),
      filename: "standby-standard-cue.docx",
    };
  }

  exportStandardCuePrint(caseId: string, revisionId: string): string {
    const record = this.getCase(caseId);
    const revision = this.getCueRevision(caseId, revisionId);
    return standardCuePrintHtml(record.title, revision.revision_id, revision.rows);
  }

  private productionAgentInput(
    record: CaseRecord,
    role: ProductionAgentRole,
    eventId: string | null,
  ): { input: ProductionAgentFrozenInput; allowlist: ProductionOutputAllowlist } {
    const emptyAllowlist = (): ProductionOutputAllowlist => ({
      fact_ids: new Set(),
      event_ids: new Set(),
      finding_ids: new Set(),
      storyboard_event_id: null,
      storyboard_entities: new Map(),
    });

    if (role === "FACT_NORMALIZER") {
      if (eventId !== null) {
        throw new DomainError(422, "INVALID_ARGUMENT", "FACT_NORMALIZER does not accept event_id.");
      }
      const facts = [...record.facts.values()]
        .filter((fact) => fact.review_status === "UNREVIEWED")
        .sort((left, right) => left.fact_id.localeCompare(right.fact_id))
        .map((fact) => ({
          fact_id: fact.fact_id,
          fact_type: fact.fact_type,
          raw_value: structuredClone(fact.raw_value),
          source_role: fact.source_role,
          source_id: fact.source_id,
          locator: fact.locator,
          quote: fact.quote,
          origin: fact.origin,
          confidence: fact.confidence,
        }));
      if (facts.length === 0) {
        throw new DomainError(
          409,
          "GATE_MISSING_INPUT",
          "Unreviewed extracted facts are required for normalization.",
        );
      }
      const allowlist = emptyAllowlist();
      allowlist.fact_ids = new Set(facts.map((fact) => fact.fact_id));
      return {
        input: {
          contract_version: "standby.production-agent-input.v1",
          role,
          case_id: record.case_id,
          review_snapshot_id: null,
          source_snapshot_digest: this.sourceSnapshotDigest(record),
          cue_revision_id: record.current_revision_id,
          verification_result_hash: null,
          payload: {
            facts,
            allowed_normalized_fact_types: [...NORMALIZED_FACT_TYPES],
            output_authority: "NON_AUTHORITATIVE",
          },
        },
        allowlist,
      };
    }

    const workspace = this.getWorkspace(record.case_id);
    const allowlist = emptyAllowlist();
    allowlist.event_ids = new Set(workspace.events.map((event) => event.event_id));
    allowlist.finding_ids = new Set(workspace.findings.map((finding) => finding.finding_id));
    const base = {
      contract_version: "standby.production-agent-input.v1" as const,
      role,
      case_id: record.case_id,
      review_snapshot_id: workspace.review_snapshot_id,
      source_snapshot_digest: workspace.source_snapshot_digest,
      cue_revision_id: workspace.cue_revision_id,
      verification_result_hash: workspace.verification.result_hash,
    };

    if (role === "REHEARSAL_BRIEF") {
      if (eventId !== null) {
        throw new DomainError(422, "INVALID_ARGUMENT", "REHEARSAL_BRIEF does not accept event_id.");
      }
      return {
        input: {
          ...base,
          payload: {
            title: workspace.title,
            events: workspace.events,
            findings: workspace.findings,
            output_authority: "NON_AUTHORITATIVE",
          },
        },
        allowlist,
      };
    }

    if (!eventId) {
      throw new DomainError(400, "INVALID_ARGUMENT", "event_id is required for STORYBOARD_RECOMPOSER.");
    }
    const eventIndex = workspace.events.findIndex((event) => event.event_id === eventId);
    if (eventIndex < 0) {
      throw new DomainError(422, "EVENT_ID_INVALID", "event_id is not in the frozen workspace.");
    }
    const selectedEvent = workspace.events[eventIndex];
    if (!selectedEvent) throw new Error("Selected workspace event is missing.");
    const previousEvent = workspace.events[eventIndex - 1] ?? null;
    const nextEvent = workspace.events[eventIndex + 1] ?? null;
    const previousSnapshot = previousEvent?.stage_snapshot ?? {};
    const currentSnapshot = selectedEvent.stage_snapshot;
    const entityIds = [...new Set([
      ...Object.keys(previousSnapshot),
      ...Object.keys(currentSnapshot),
    ])].sort();
    const storyboardEntities = new Map<string, StoryboardEntityRule>();
    for (const entityId of entityIds) {
      const previous = previousSnapshot[entityId];
      const current = currentSnapshot[entityId];
      let action: StoryboardEntityRule["action"];
      if (current?.transition) action = current.transition;
      else if (!current && previous) action = "EXIT";
      else if (!previous && current) action = "HOLD";
      else if (previous?.zone !== current?.zone) action = "MOVE";
      else action = "HOLD";
      storyboardEntities.set(entityId, {
        action,
        from_zone: previous?.zone ?? current?.zone ?? null,
        to_zone: current?.zone ?? null,
      });
    }
    allowlist.storyboard_event_id = selectedEvent.event_id;
    allowlist.storyboard_entities = storyboardEntities;
    const contextEventIds = new Set(
      [previousEvent?.event_id, selectedEvent.event_id, nextEvent?.event_id].filter(
        (value): value is string => Boolean(value),
      ),
    );
    const eventGraphContext = workspace.event_graph.events.filter((event) =>
      contextEventIds.has(event.event_id),
    );
    allowlist.fact_ids = new Set(
      eventGraphContext.flatMap((event) => event.source_refs.map((source) => source.fact_id)),
    );
    return {
      input: {
        ...base,
        payload: {
          previous_event: previousEvent,
          selected_event: selectedEvent,
          next_event: nextEvent,
          event_graph_context: eventGraphContext,
          findings: workspace.findings.filter((finding) => finding.event_id === selectedEvent.event_id),
          deterministic_transition_allowlist: Object.fromEntries(storyboardEntities),
          output_authority: "NON_AUTHORITATIVE",
        },
      },
      allowlist,
    };
  }

  private verifyCurrent(record: CaseRecord): void {
    const snapshot = this.currentSnapshot(record);
    const revision = this.findCurrentRevision(record);
    record.verification = verifyProduction({
      caseId: record.case_id,
      sources: record.sources,
      snapshot,
      revision,
    });
  }

  private async executeScriptProjection(
    source: InternalSourceVersion,
    operation: Operation,
    projectionId: string,
    record: CaseRecord | null,
  ): Promise<void> {
    operation.status = "RUNNING";
    operation.updated_at = this.now();
    try {
      if (!this.scriptProjectionProvider) {
        throw new DomainError(
          503,
          "UPSTAGE_NOT_CONFIGURED",
          "Script projection adapter is not configured.",
        );
      }
      const result = await this.scriptProjectionProvider.projectScript(source);
      if (
        result.run.role !== "SCRIPT" ||
        result.run.provider !== "UPSTAGE" ||
        result.run.source_id !== source.source_id ||
        result.run.schema_version !== "standby.extraction.v1" ||
        !result.run.provider_job_id ||
        !result.run.agent_id ||
        !/^[a-f0-9]{64}$/.test(result.run.raw_response_sha256) ||
        result.facts.some(
          (fact) => fact.source_id !== source.source_id || fact.origin !== source.origin,
        )
      ) {
        throw new DomainError(
          502,
          "UPSTAGE_SCRIPT_PROJECTION_INVALID",
          "Script projection provenance is incomplete.",
        );
      }
      if (!source.original_filename || !source.media_type) {
        throw new Error("Validated script projection source metadata is missing.");
      }
      const projection: ScriptProjection = {
        contract_version: "standby.script-projection.v1",
        projection_id: projectionId,
        case_id: record?.case_id ?? null,
        authority: "NON_AUTHORITATIVE",
        source: {
          filename: source.original_filename,
          sha256: source.sha256,
          media_type: source.media_type,
        },
        provenance: {
          provider: "UPSTAGE_AGENT",
          source_role: "SCRIPT",
          origin: "USER_PROVIDED",
          provider_job_id: result.run.provider_job_id,
          agent_id: result.run.agent_id,
          config_id: result.run.config_id,
          adapter_version: result.run.adapter_version,
          raw_response_sha256: result.run.raw_response_sha256,
        },
        segments: projectScriptSegments(result.facts),
        created_at: this.now(),
      };
      if (record) {
        for (const [factId, fact] of record.facts) {
          if (fact.source_role === "SCRIPT") record.facts.delete(factId);
        }
        for (const fact of result.facts) record.facts.set(fact.fact_id, structuredClone(fact));
        record.current_snapshot_id = null;
        record.verification = null;
      }
      this.scriptProjections.set(projectionId, projection);
      if (record) this.caseScriptProjectionIds.set(record.case_id, projectionId);
      operation.status = "SUCCEEDED";
      operation.result_source = "UPSTAGE";
      operation.updated_at = this.now();
    } catch (error) {
      operation.status = "FAILED";
      operation.error = {
        code: error instanceof DomainError ? error.code : "SCRIPT_PROJECTION_FAILED",
        message: error instanceof DomainError ? error.message : "Script projection failed.",
      };
      operation.updated_at = this.now();
    }
  }

  private async executeProductionAgent(input: {
    record: CaseRecord;
    operation: Operation;
    artifactId: string;
    role: ProductionAgentRole;
    frozenInput: ProductionAgentFrozenInput;
    allowlist: ProductionOutputAllowlist;
    inputFingerprint: string;
    cacheKey: string;
  }): Promise<void> {
    input.operation.status = "RUNNING";
    input.operation.updated_at = this.now();
    try {
      if (!this.productionAgentProvider) {
        throw new DomainError(
          503,
          "UPSTAGE_NOT_CONFIGURED",
          "Production Agent adapter is not configured.",
        );
      }
      const result = await this.productionAgentProvider.run(input.role, input.frozenInput);
      let fallbackReason: ProductionArtifact["fallback_reason"] = result.fallback_reason;
      let payload: ProductionArtifact["payload"];
      try {
        payload = validateProductionAgentOutput(input.role, result.output, input.allowlist);
      } catch (error) {
        if (!(error instanceof DomainError)
          || error.code !== "PRODUCTION_AGENT_RESPONSE_INVALID") throw error;
        if (input.role === "FACT_NORMALIZER"
          && error.message === "Fact normalization contains an unsupported normalized_fact_type.") {
          const facts = input.frozenInput.payload.facts;
          if (!Array.isArray(facts)) throw error;
          payload = validateProductionAgentOutput("FACT_NORMALIZER", {
            recommendations: facts.map((value) => {
              const fact = value as Record<string, unknown>;
              return {
                fact_id: fact.fact_id,
                normalized_fact_type: fact.fact_type,
                value: fact.raw_value,
                confidence: "NOT_PROVIDED",
                authority: "NON_AUTHORITATIVE",
              };
            }),
            missing_evidence: [],
          }, input.allowlist);
        } else if (input.role === "REHEARSAL_BRIEF"
          && error.message.includes("outside the frozen input")) {
          payload = validateProductionAgentOutput("REHEARSAL_BRIEF", {
            headline: "Deterministic findings retained because the Agent response referenced unknown evidence.",
            sections: [],
            missing_evidence: [],
          }, input.allowlist);
        } else {
          throw error;
        }
        fallbackReason = "UPSTAGE_RESPONSE_REJECTED";
      }
      const artifact: ProductionArtifact = {
        contract_version: "standby.production-artifact.v1",
        artifact_id: input.artifactId,
        case_id: input.record.case_id,
        role: input.role,
        authority: "NON_AUTHORITATIVE",
        input_fingerprint: input.inputFingerprint,
        review_snapshot_id: input.frozenInput.review_snapshot_id,
        cue_revision_id: input.frozenInput.cue_revision_id,
        provider: "UPSTAGE",
        provider_job_id: result.provider_job_id,
        agent_id: result.agent_id,
        config_id: result.config_id,
        adapter_version: result.adapter_version,
        raw_response_sha256: result.raw_response_sha256,
        ...(fallbackReason ? { fallback_reason: fallbackReason } : {}),
        payload,
        created_at: this.now(),
      };
      this.productionArtifacts.set(artifact.artifact_id, artifact);
      this.productionArtifactCaseIds.set(artifact.artifact_id, input.record.case_id);
      if (artifact.role === "FACT_NORMALIZER") {
        this.latestFactNormalizerArtifactByCase.set(input.record.case_id, artifact.artifact_id);
      }
      input.operation.status = "SUCCEEDED";
      input.operation.result_source = "UPSTAGE";
      input.operation.updated_at = this.now();
    } catch (error) {
      input.operation.status = "FAILED";
      input.operation.error = {
        code: error instanceof DomainError ? error.code : "PRODUCTION_AGENT_FAILED",
        message: error instanceof DomainError ? error.message : "Production Agent failed.",
      };
      input.operation.updated_at = this.now();
      if (this.productionCache.get(input.cacheKey) === input.operation.operation_id) {
        this.productionCache.delete(input.cacheKey);
      }
    }
  }

  private async executeExtraction(
    record: CaseRecord,
    operation: Operation,
    runId: string,
    adapter: ExtractionAdapter,
    cacheKey: string,
  ): Promise<void> {
    operation.status = "RUNNING";
    operation.updated_at = this.now();
    try {
      let facts: FactCandidate[];
      let sourceRuns: ExtractionRunRecord["source_runs"];
      let resultSource: ExtractionRunRecord["result_source"];
      if (adapter === "CONTROLLED_FIXTURE") {
        if ([...record.sources.values()].some((source) => source.bytes !== null)) {
          throw new DomainError(
            409,
            "ADAPTER_SOURCE_MISMATCH",
            "Controlled fixture extraction cannot process uploaded files.",
          );
        }
        facts = extractControlledFixture(record.sources);
        sourceRuns = [...record.sources.values()].map((source) => ({
          source_id: source.source_id,
          role: source.role,
          provider: "CONTROLLED_FIXTURE" as const,
          provider_job_id: null,
          agent_id: null,
          config_id: null,
          adapter_version: "controlled-fixture.v1",
          schema_version: "standby.extraction.v1" as const,
          raw_response_sha256: hashJson(source.content),
        }));
        resultSource = "CONTROLLED_FIXTURE";
      } else {
        if (!this.upstageProvider) {
          throw new DomainError(503, "UPSTAGE_NOT_CONFIGURED", "Upstage adapter is not configured.");
        }
        const result = await this.upstageProvider.extract(record.sources);
        facts = result.facts;
        sourceRuns = result.sourceRuns;
        resultSource = sourceRuns.some((run) => run.provider !== "UPSTAGE") ? "MIXED" : "UPSTAGE";
      }
      record.facts.clear();
      record.current_snapshot_id = null;
      record.verification = null;
      for (const fact of facts) {
        if (fact.review_status !== "UNREVIEWED") {
          throw new DomainError(502, "EXTRACTION_AUTHORITY_INVALID", "New facts must be UNREVIEWED.");
        }
        record.facts.set(fact.fact_id, fact);
      }
      const extractionRun: ExtractionRunRecord = {
        extraction_run_id: runId,
        case_id: record.case_id,
        adapter,
        result_source: resultSource,
        source_runs: sourceRuns,
        candidate_count: facts.length,
        created_at: this.now(),
      };
      this.extractionRuns.set(runId, extractionRun);
      this.extractionCache.set(cacheKey, runId);
      operation.status = "SUCCEEDED";
      operation.result_source = resultSource;
      operation.updated_at = this.now();
    } catch (error) {
      operation.status = "FAILED";
      operation.error = {
        code: error instanceof DomainError ? error.code : "EXTRACTION_FAILED",
        message: error instanceof DomainError ? error.message : "Extraction failed.",
      };
      operation.updated_at = this.now();
    }
  }

  private currentSnapshot(record: CaseRecord): InternalReviewSnapshot {
    const snapshot = record.snapshots.find((candidate) => candidate.snapshot_id === record.current_snapshot_id);
    if (!snapshot) {
      throw new DomainError(409, "GATE_UNREVIEWED_FACTS", "No frozen review snapshot exists.");
    }
    return snapshot;
  }

  private currentRevision(record: CaseRecord): CueRevision {
    const revision = this.findCurrentRevision(record);
    if (!revision) {
      throw new DomainError(409, "SOURCE_SLOT_MISSING", "MASTER_CUE revision is missing.");
    }
    return revision;
  }

  private findCurrentRevision(record: CaseRecord): CueRevision | null {
    return record.revisions.find((candidate) => candidate.revision_id === record.current_revision_id) ?? null;
  }

  private sourceSnapshotDigest(record: CaseRecord): string {
    return hashJson(
      ROLES.map((role) => {
        const source = record.sources.get(role);
        return { role, sha256: source?.sha256 ?? null };
      }),
    );
  }

  private publicSource(source: SourceVersion): SourceVersion {
    return {
      contract_version: source.contract_version,
      source_id: source.source_id,
      case_id: source.case_id,
      role: source.role,
      sha256: source.sha256,
      origin: source.origin,
      authority: source.authority,
      media_type: source.media_type,
      original_filename: source.original_filename,
      created_at: source.created_at,
    };
  }

  private getCase(caseId: string): CaseRecord {
    const record = this.cases.get(caseId);
    if (!record) {
      throw new DomainError(404, "RESOURCE_NOT_FOUND", "Case not found.");
    }
    return record;
  }
}

export function idempotencyBody(value: unknown): string {
  return canonicalJson(value);
}
