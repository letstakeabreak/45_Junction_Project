import { DomainError } from "../domain/errors.js";
import { extractStageSpec } from "../domain/extraction.js";
import type {
  FactCandidate,
  InternalSourceVersion,
  ProductionAgentFrozenInput,
  ProductionAgentRole,
  ProviderRunSummary,
  SourceRole,
} from "../domain/types.js";
import { canonicalJson, hashJson, sha256 } from "../lib/hash.js";
import type { ExtractionProvider, ExtractionProviderResult } from "./extraction-provider.js";
import type {
  ScriptProjectionProvider,
  ScriptProjectionProviderResult,
} from "./script-projection-provider.js";
import type {
  ProductionAgentProvider,
  ProductionAgentProviderResult,
} from "./production-agent-provider.js";
import {
  jsonToUpstageXlsx,
  jsonTransportFilename,
  XLSX_MEDIA_TYPE,
} from "./json-xlsx-transport.js";

const ADAPTER_VERSION = "upstage-agent.v2";
const DEFAULT_BASE_URL = "https://api.upstage.ai";
const DEFAULT_TIMEOUT_MS = 600_000;

type FetchLike = typeof fetch;
type JsonObject = Record<string, unknown>;

export type UpstageAgentProviderConfig = {
  apiKey: string;
  agentIds: Partial<Record<SourceRole, string>>;
  configIds?: Partial<Record<SourceRole, string>>;
  productionAgentIds?: Partial<Record<ProductionAgentRole, string>>;
  productionConfigIds?: Partial<Record<ProductionAgentRole, string>>;
  baseUrl?: string;
  pollIntervalMs?: number;
  timeoutMs?: number;
  fetchImpl?: FetchLike;
};

function objectValue(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError(502, "UPSTAGE_RESPONSE_INVALID", `${label} must be an object.`);
  }
  return value as JsonObject;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError(502, "UPSTAGE_RESPONSE_INVALID", `${label} is missing.`);
  }
  return value.trim();
}

function findResponseObject(
  job: JsonObject,
  matches: (value: JsonObject) => boolean,
): JsonObject | null {
  const output = job.output;
  if (!Array.isArray(output)) return null;

  // Upstage's include=all response can put tens of thousands of parsed XLSX
  // cells in an early Parse step. Search the latest (Extract) step first and
  // give every candidate its own bounded traversal budget so Parse noise can
  // never hide a later structured result.
  for (const step of [...output].reverse()) {
    if (step === null || typeof step !== "object" || Array.isArray(step)) continue;
    const stepObject = step as JsonObject;
    const values: unknown[] = [];
    if (stepObject.additional_values !== undefined) values.push(stepObject.additional_values);
    const content = stepObject.content;
    const contentItems = Array.isArray(content)
      ? [...content].reverse()
      : content !== null && typeof content === "object"
        ? [content]
        : [];
    for (const item of contentItems) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
      const itemObject = item as JsonObject;
      if (itemObject.additional_values !== undefined) {
        values.push(itemObject.additional_values);
      }
      if (typeof itemObject.text === "string" && itemObject.text.trim()) {
        values.push(itemObject.text);
      }
      values.push(itemObject);
    }
    values.push(stepObject);

    for (const value of values) {
      let visited = 0;
      const visit = (candidate: unknown, depth: number): JsonObject | null => {
        if (depth > 10 || visited >= 10_000) return null;
        visited += 1;
        if (typeof candidate === "string") {
          if (!candidate.trim() || candidate.length > 2_000_000) return null;
          try {
            return visit(JSON.parse(candidate) as unknown, depth + 1);
          } catch {
            // Instruct steps may contain prose; only valid JSON can become a payload candidate.
            return null;
          }
        }
        if (Array.isArray(candidate)) {
          for (const item of candidate) {
            const found = visit(item, depth + 1);
            if (found) return found;
          }
          return null;
        }
        if (candidate === null || typeof candidate !== "object") return null;
        const object = candidate as JsonObject;
        if (matches(object)) return object;
        for (const child of Object.values(object)) {
          const found = visit(child, depth + 1);
          if (found) return found;
        }
        return null;
      };

      const found = visit(value, 0);
      if (found) return found;
    }
  }

  return null;
}

function factEvidence(value: JsonObject): { locator: string; quote: string } | null {
  const quote = [value.source_quote_raw, value.source_quote, value.quote].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0,
  );
  const rawLocator =
    value.locator ??
    value.locator_copy ??
    value.source_locator ??
    value.source_locator_raw;
  const locator =
    typeof rawLocator === "string" && rawLocator.trim()
      ? rawLocator.trim()
      : rawLocator !== null && typeof rawLocator === "object"
        ? canonicalJson(rawLocator)
        : null;
  return quote && locator ? { locator, quote: quote.trim() } : null;
}

function locateFact(role: SourceRole, value: JsonObject): { locator: string; quote: string } {
  const evidence = factEvidence(value);
  if (evidence) return evidence;
  throw new DomainError(
    502,
    "UPSTAGE_EVIDENCE_MISSING",
    `${role} fact is missing an exact source locator or quote.`,
  );
}

function decodeFacts(
  role: SourceRole,
  source: InternalSourceVersion,
  payload: JsonObject,
): FactCandidate[] {
  const key = roleFactKey(role);
  const rawFacts = payload[key];
  if (!Array.isArray(rawFacts)) {
    throw new DomainError(502, "UPSTAGE_RESPONSE_INVALID", `${key} must be an array.`);
  }
  const facts = rawFacts.flatMap((rawFact, index) => {
    const value = objectValue(rawFact, `${key}[${index}]`);
    const evidence = factEvidence(value);
    if (!evidence) return [];
    const { locator, quote } = evidence;
    const rawConfidence = value.confidence;
    const confidence =
      rawConfidence === "HIGH" || rawConfidence === "LOW" ? rawConfidence : "NOT_PROVIDED";
    const factTypeValue = value.fact_type ?? value.record_kind ?? `${role}_FACT`;
    const factType = nonEmptyString(factTypeValue, `${key}[${index}].fact_type`);
    const digest = hashJson({ source_sha256: source.sha256, index, value });
    return [{
      fact_id: `fact_${role.toLowerCase()}_${digest.slice(0, 16)}`,
      fact_type: factType,
      raw_value: structuredClone(value),
      reviewed_value: null,
      source_role: role,
      source_id: source.source_id,
      locator,
      quote,
      origin: source.origin,
      confidence,
      review_status: "UNREVIEWED",
    } satisfies FactCandidate];
  });
  if (rawFacts.length > 0 && facts.length === 0) {
    locateFact(role, objectValue(rawFacts[0], `${key}[0]`));
  }
  return facts;
}

function roleFactKey(role: SourceRole): "script_facts" | "cue_facts" | "stage_facts" {
  if (role === "SCRIPT") return "script_facts";
  if (role === "MASTER_CUE") return "cue_facts";
  return "stage_facts";
}

function parseRolePayload(role: SourceRole, job: JsonObject): JsonObject {
  const key = roleFactKey(role);
  const evidencedPayload = findResponseObject(job, (object) => {
    const rawFacts = object[key];
    return Array.isArray(rawFacts) && rawFacts.length > 0 && rawFacts.every((rawFact) => (
      rawFact !== null &&
      typeof rawFact === "object" &&
      !Array.isArray(rawFact) &&
      factEvidence(rawFact as JsonObject) !== null
    ));
  });
  if (evidencedPayload) return evidencedPayload;

  // A real extraction may contain one blank or decorative row without a quote.
  // Prefer that final, partially evidenced result over an earlier Parse payload
  // whose rows have no source evidence at all; decodeFacts will discard only
  // the unsupported rows.
  const partiallyEvidencedPayload = findResponseObject(job, (object) => {
    const rawFacts = object[key];
    return Array.isArray(rawFacts) && rawFacts.some((rawFact) => (
      rawFact !== null &&
      typeof rawFact === "object" &&
      !Array.isArray(rawFact) &&
      factEvidence(rawFact as JsonObject) !== null
    ));
  });
  if (partiallyEvidencedPayload) return partiallyEvidencedPayload;

  // Keep the precise fail-closed error for a genuine malformed extraction.
  // The strict pass above only prevents an intermediate include=all payload
  // from shadowing a later, fully evidenced Extract result.
  const payload = findResponseObject(job, (object) => Array.isArray(object[key]));
  if (payload) return payload;
  throw new DomainError(502, "UPSTAGE_RESPONSE_INVALID", `No ${key} JSON output was found.`);
}

function parseProductionPayload(role: ProductionAgentRole, job: JsonObject): JsonObject | null {
  const payload = findResponseObject(job, (object) => {
    if (role === "FACT_NORMALIZER" && Array.isArray(object.recommendations)) return true;
    if (
      role === "STORYBOARD_RECOMPOSER" &&
      typeof object.event_id === "string" &&
      Array.isArray(object.beats)
    ) {
      return true;
    }
    if (
      role === "REHEARSAL_BRIEF" &&
      typeof object.headline === "string" &&
      Array.isArray(object.sections)
    ) {
      return true;
    }
    return false;
  });
  return payload;
}

function productionFallback(role: ProductionAgentRole, input: ProductionAgentFrozenInput): JsonObject {
  if (role === "FACT_NORMALIZER") {
    const facts = Array.isArray(input.payload.facts) ? input.payload.facts : [];
    return {
      recommendations: facts.map((value) => {
        const fact = value as JsonObject;
        return {
          fact_id: fact.fact_id,
          normalized_fact_type: fact.fact_type,
          value: fact.raw_value,
          confidence: "NOT_PROVIDED",
          authority: "NON_AUTHORITATIVE",
        };
      }),
      missing_evidence: [],
    };
  }
  if (role === "STORYBOARD_RECOMPOSER") {
    const selected = input.payload.selected_event as JsonObject | undefined;
    return {
      event_id: selected?.event_id,
      beats: [],
      summary: "Static verified snapshot retained because the Agent response was rejected.",
      missing_evidence: [],
    };
  }
  return {
    headline: "Deterministic findings retained because the Agent response was rejected.",
    sections: [],
    missing_evidence: [],
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class UpstageAgentProvider implements
  ExtractionProvider,
  ProductionAgentProvider,
  ScriptProjectionProvider
{
  private readonly fetchImpl: FetchLike;
  private readonly baseUrl: string;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(private readonly config: UpstageAgentProviderConfig) {
    if (!config.apiKey.trim()) throw new Error("UPSTAGE_API_KEY is required.");
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.pollIntervalMs = config.pollIntervalMs ?? 2_000;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async extract(
    sources: Map<SourceRole, InternalSourceVersion>,
  ): Promise<ExtractionProviderResult> {
    const masterCue = this.requiredFileSource(sources, "MASTER_CUE");
    const script = sources.get("SCRIPT");
    if (script && script.bytes === null) {
      throw new DomainError(409, "SOURCE_FORMAT_INVALID", "SCRIPT must be uploaded as a file.");
    }
    const stageSpec = sources.get("STAGE_SPEC");
    if (stageSpec && stageSpec.bytes !== null) {
      throw new DomainError(409, "SOURCE_FORMAT_INVALID", "STAGE_SPEC must be structured JSON.");
    }

    const [scriptResult, cueResult, stageAgentResult] = await Promise.all([
      script ? this.extractFile("SCRIPT", script) : Promise.resolve(null),
      this.extractFile("MASTER_CUE", masterCue),
      stageSpec && this.config.agentIds.STAGE_SPEC
        ? this.extractFile("STAGE_SPEC", stageSpec)
        : Promise.resolve(null),
    ]);
    const stageFacts = stageAgentResult?.facts ?? (stageSpec ? extractStageSpec(stageSpec) : []);
    const stageRun: ProviderRunSummary | null = stageAgentResult?.run ?? (stageSpec
      ? {
          source_id: stageSpec.source_id,
          role: "STAGE_SPEC",
          provider: "STANDBY_FORM",
          provider_job_id: null,
          agent_id: null,
          config_id: null,
          adapter_version: "standby-form.v1",
          schema_version: "standby.extraction.v1",
          raw_response_sha256: hashJson({ source_sha256: stageSpec.sha256, facts: stageFacts }),
        }
      : null);

    return {
      facts: [...(scriptResult?.facts ?? []), ...cueResult.facts, ...stageFacts],
      sourceRuns: [
        ...(scriptResult ? [scriptResult.run] : []),
        cueResult.run,
        ...(stageRun ? [stageRun] : []),
      ],
    };
  }

  async projectScript(
    source: InternalSourceVersion,
  ): Promise<ScriptProjectionProviderResult> {
    if (source.role !== "SCRIPT" || source.bytes === null) {
      throw new DomainError(409, "SOURCE_FORMAT_INVALID", "SCRIPT must be uploaded as a file.");
    }
    return this.extractFile("SCRIPT", source);
  }

  configFingerprint(role: ProductionAgentRole): string {
    const agentId = this.config.productionAgentIds?.[role];
    if (!agentId) {
      throw new DomainError(
        503,
        "UPSTAGE_AGENT_NOT_CONFIGURED",
        `${role} Agent ID is missing.`,
      );
    }
    return hashJson({
      adapter_version: ADAPTER_VERSION,
      role,
      agent_id: agentId,
      config_id: this.config.productionConfigIds?.[role] ?? null,
    });
  }

  async run(
    role: ProductionAgentRole,
    input: ProductionAgentFrozenInput,
  ): Promise<ProductionAgentProviderResult> {
    const agentId = this.config.productionAgentIds?.[role];
    if (!agentId) {
      throw new DomainError(
        503,
        "UPSTAGE_AGENT_NOT_CONFIGURED",
        `${role} Agent ID is missing.`,
      );
    }
    const inputFingerprint = hashJson(input);
    const transport = await jsonToUpstageXlsx(
      new TextEncoder().encode(canonicalJson(input)),
    );
    const fileId = await this.uploadBytes(
      transport,
      XLSX_MEDIA_TYPE,
      `${role.toLowerCase().replaceAll("_", "-")}-${inputFingerprint.slice(0, 12)}.xlsx`,
    );
    const configId = this.config.productionConfigIds?.[role] ?? null;
    const job = await this.createJob(agentId, fileId, configId);
    const jobId = nonEmptyString(job.id, "Upstage job id");
    const completedJob = await this.pollJob(jobId);
    const parsed = parseProductionPayload(role, completedJob);
    return {
      output: parsed ?? productionFallback(role, input),
      provider_job_id: jobId,
      agent_id: agentId,
      config_id: configId,
      adapter_version: ADAPTER_VERSION,
      raw_response_sha256: hashJson(completedJob),
      ...(parsed ? {} : { fallback_reason: "UPSTAGE_RESPONSE_REJECTED" as const }),
    };
  }

  private requiredFileSource(
    sources: Map<SourceRole, InternalSourceVersion>,
    role: "SCRIPT" | "MASTER_CUE",
  ): InternalSourceVersion {
    const source = sources.get(role);
    if (!source || source.bytes === null) {
      throw new DomainError(409, "SOURCE_FORMAT_INVALID", `${role} must be uploaded as a file.`);
    }
    return source;
  }

  private async extractFile(
    role: SourceRole,
    source: InternalSourceVersion,
  ): Promise<{ facts: FactCandidate[]; run: ProviderRunSummary }> {
    const agentId = this.config.agentIds[role];
    if (!agentId) {
      throw new DomainError(503, "UPSTAGE_AGENT_NOT_CONFIGURED", `${role} Agent ID is missing.`);
    }
    const fileId = await this.uploadFile(source);
    const configId = this.config.configIds?.[role] ?? null;
    const job = await this.createJob(agentId, fileId, configId);
    const jobId = nonEmptyString(job.id, "Upstage job id");
    const completedJob = await this.pollJob(jobId);
    const payload = parseRolePayload(role, completedJob);
    const facts = decodeFacts(role, source, payload);
    const run: ProviderRunSummary = {
      source_id: source.source_id,
      role,
      provider: "UPSTAGE",
      provider_job_id: jobId,
      agent_id: agentId,
      config_id: configId,
      adapter_version: ADAPTER_VERSION,
      schema_version: "standby.extraction.v1",
      raw_response_sha256: hashJson(completedJob),
    };
    return { facts, run };
  }

  private async uploadFile(source: InternalSourceVersion): Promise<string> {
    const sourceBytes = source.bytes ?? new TextEncoder().encode(canonicalJson(source.content));
    const useJsonTransport =
      source.bytes === null ||
      source.media_type === "application/json" ||
      source.original_filename?.toLowerCase().endsWith(".json");
    const uploadBytes = useJsonTransport ? await jsonToUpstageXlsx(sourceBytes) : sourceBytes;
    const uploadMediaType = useJsonTransport ? XLSX_MEDIA_TYPE : source.media_type ?? "application/octet-stream";
    const uploadFilename = useJsonTransport
      ? jsonTransportFilename(
          source.original_filename ?? `${source.role.toLowerCase()}.json`,
          source.sha256,
        )
      : source.original_filename ?? `${source.role.toLowerCase()}-${source.sha256.slice(0, 8)}`;
    return this.uploadBytes(uploadBytes, uploadMediaType, uploadFilename);
  }

  private async uploadBytes(
    bytes: Uint8Array,
    mediaType: string,
    filename: string,
  ): Promise<string> {
    const form = new FormData();
    form.append(
      "file",
      new Blob([Uint8Array.from(bytes).buffer], {
        type: mediaType,
      }),
      filename,
    );
    form.append("purpose", "user_data");
    const response = await this.upstageFetch("/v2/files", { method: "POST", body: form });
    return nonEmptyString(response.id, "Upstage file id");
  }

  private async createJob(
    agentId: string,
    fileId: string,
    configId: string | null,
  ): Promise<JsonObject> {
    return this.upstageFetch("/v2/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: agentId,
        input: [{ role: "user", content: [{ type: "input_file", file_id: fileId }] }],
        ...(configId ? { config_id: configId } : {}),
      }),
    });
  }

  private async pollJob(jobId: string): Promise<JsonObject> {
    const deadline = Date.now() + this.timeoutMs;
    const query = new URLSearchParams();
    query.append("include[]", "all");
    while (Date.now() <= deadline) {
      const job = await this.upstageFetch(
        `/v2/responses/${encodeURIComponent(jobId)}?${query.toString()}`,
        { method: "GET" },
      );
      const status = nonEmptyString(job.status, "Upstage job status");
      if (status === "completed") return job;
      if (status === "failed") {
        throw new DomainError(502, "UPSTAGE_JOB_FAILED", "Upstage extraction job failed.");
      }
      if (status !== "queued" && status !== "in_progress") {
        throw new DomainError(502, "UPSTAGE_RESPONSE_INVALID", "Unknown Upstage job status.");
      }
      await delay(this.pollIntervalMs);
    }
    throw new DomainError(504, "UPSTAGE_JOB_TIMEOUT", "Upstage extraction job timed out.");
  }

  private async upstageFetch(path: string, init: RequestInit): Promise<JsonObject> {
    const attempts = init.method === "GET" ? 3 : 1;
    let response: Response | null = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: { ...init.headers, authorization: `Bearer ${this.config.apiKey}` },
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        if (attempt + 1 >= attempts) {
          throw new DomainError(502, "UPSTAGE_REQUEST_FAILED", "Upstage API request failed.", {
            reason:
              error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "network",
          });
        }
        await delay(200 * 2 ** attempt);
        continue;
      }
      if (response.ok) break;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt + 1 >= attempts) break;
      await delay(200 * 2 ** attempt);
    }
    if (!response) {
      throw new DomainError(502, "UPSTAGE_REQUEST_FAILED", "Upstage API request failed.");
    }
    if (!response.ok) {
      throw new DomainError(
        502,
        "UPSTAGE_REQUEST_FAILED",
        `Upstage API request failed with status ${response.status}.`,
        {
        upstream_status: response.status,
        },
      );
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new DomainError(502, "UPSTAGE_RESPONSE_INVALID", "Upstage returned invalid JSON.");
    }
    return objectValue(json, "Upstage response");
  }
}

export function fileSha256(bytes: Uint8Array): string {
  return sha256(bytes);
}
