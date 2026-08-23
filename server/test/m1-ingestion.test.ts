import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { DomainError } from "../src/domain/errors.js";
import type { FactCandidate, InternalSourceVersion, SourceRole } from "../src/domain/types.js";
import { HERO_SOURCE_CONTENT } from "../src/fixtures/hero.js";
import { sha256 } from "../src/lib/hash.js";
import { UpstageAgentProvider } from "../src/providers/upstage-agent-provider.js";
import type { ExtractionProvider } from "../src/providers/extraction-provider.js";

const TOKEN = "m1-test-token";
let app: FastifyInstance;

before(async () => {
  app = await buildApp({ apiToken: TOKEN, allowedOrigins: ["http://localhost:5173"] });
});

after(async () => {
  await app.close();
});

function auth(idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${TOKEN}`,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

function multipartFile(input: {
  boundary: string;
  origin: string;
  filename: string;
  mediaType: string;
  bytes: Buffer;
}): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${input.boundary}\r\nContent-Disposition: form-data; name="origin"\r\n\r\n${input.origin}\r\n` +
        `--${input.boundary}\r\nContent-Disposition: form-data; name="file"; filename="${input.filename}"\r\n` +
        `Content-Type: ${input.mediaType}\r\n\r\n`,
    ),
    input.bytes,
    Buffer.from(`\r\n--${input.boundary}--\r\n`),
  ]);
}

test("SCRIPT multipart upload hashes bytes and never echoes file contents", async () => {
  const create = await app.inject({
    method: "POST",
    url: "/v1/cases",
    headers: auth("m1-case"),
    payload: { title: "M1 upload" },
  });
  const caseId = (create.json() as { case_id: string }).case_id;
  const boundary = "standby-m1-boundary";
  const fileBytes = Buffer.from("%PDF-1.7\nfixture only\n%%EOF");
  const payload = multipartFile({
    boundary,
    origin: "USER_PROVIDED",
    filename: "../script.pdf",
    mediaType: "application/pdf",
    bytes: fileBytes,
  });
  const upload = await app.inject({
    method: "POST",
    url: `/v1/cases/${caseId}/sources/SCRIPT`,
    headers: {
      ...auth("m1-script-upload"),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  assert.equal(upload.statusCode, 201, upload.body);
  const source = upload.json() as Record<string, unknown>;
  assert.equal(source.sha256, sha256(fileBytes));
  assert.equal(source.original_filename, "script.pdf");
  assert.equal("content" in source, false);
  assert.equal("bytes" in source, false);

  const replay = await app.inject({
    method: "POST",
    url: `/v1/cases/${caseId}/sources/SCRIPT`,
    headers: {
      ...auth("m1-script-upload"),
      "content-type": `multipart/form-data; boundary=${boundary}`,
    },
    payload,
  });
  assert.equal(replay.statusCode, 201, replay.body);
  assert.equal((replay.json() as { source_id: string }).source_id, source.source_id);
});

test("MASTER_CUE JSON file reaches Upstage extraction and human review", async () => {
  const provider: ExtractionProvider = {
    async extract(sources) {
      const roles = ["MASTER_CUE"] as const;
      const facts = roles.map((role) => {
        const current = sources.get(role);
        assert.ok(current);
        assert.equal(current.media_type, "application/json");
        assert.equal(current.original_filename, "master.json");
        assert.ok(current.bytes);
        return {
          fact_id: `fact_${role.toLowerCase()}`,
          fact_type: "QUICK_CHANGE_AVAILABLE_WINDOW",
          raw_value: {
            min_ms: 58_000,
            max_ms: 62_000,
            target: { row_id: "R3", column: "환복시간" },
          },
          reviewed_value: null,
          source_role: role,
          source_id: current.source_id,
          locator: "Cue!A1",
          quote: `${role} evidence`,
          origin: current.origin,
          confidence: "NOT_PROVIDED" as const,
          review_status: "UNREVIEWED" as const,
        };
      });
      return {
        facts,
        sourceRuns: roles.map((role) => {
          const current = sources.get(role);
          assert.ok(current);
          return {
            source_id: current.source_id,
            role,
            provider: "UPSTAGE" as const,
            provider_job_id: `job-${role}`,
            agent_id: `agt-${role}`,
            config_id: null,
            adapter_version: "test.v1",
            schema_version: "standby.extraction.v1" as const,
            raw_response_sha256: sha256(role),
          };
        }),
      };
    },
  };
  const liveApp = await buildApp({
    apiToken: TOKEN,
    allowedOrigins: ["http://localhost:5173"],
    extractionProvider: provider,
  });
  try {
    const create = await liveApp.inject({
      method: "POST",
      url: "/v1/cases",
      headers: auth("m1-live-case"),
      payload: { title: "Live input" },
    });
    const caseId = (create.json() as { case_id: string }).case_id;

    for (const upload of [
      {
        role: "MASTER_CUE",
        filename: "master.json",
        mediaType: "application/json",
        bytes: Buffer.from('{"events":[]}'),
      },
    ] as const) {
      const boundary = `boundary-${upload.role}`;
      const response = await liveApp.inject({
        method: "POST",
        url: `/v1/cases/${caseId}/sources/${upload.role}`,
        headers: {
          ...auth(`upload-${upload.role}`),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartFile({
          boundary,
          origin: "USER_PROVIDED",
          filename: upload.filename,
          mediaType: upload.mediaType,
          bytes: upload.bytes,
        }),
      });
      assert.equal(response.statusCode, 201, response.body);
    }
    const start = await liveApp.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/extraction-runs`,
      headers: auth("start-upstage"),
      payload: { adapter: "UPSTAGE_AGENT" },
    });
    assert.equal(start.statusCode, 202, start.body);
    const operationId = (start.json() as { operation_id: string }).operation_id;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const operation = await liveApp.inject({
      method: "GET",
      url: `/v1/operations/${operationId}`,
      headers: auth(),
    });
    assert.equal((operation.json() as { status: string }).status, "SUCCEEDED");

    const queue = await liveApp.inject({
      method: "GET",
      url: `/v1/cases/${caseId}/review-queue`,
      headers: auth(),
    });
    const facts = (queue.json() as { items: FactCandidate[] }).items;
    assert.equal(facts.length, 1);
    assert.ok(facts.every((fact) => fact.review_status === "UNREVIEWED"));

    const reviews = await liveApp.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/fact-reviews:batch`,
      headers: auth("review-live-facts"),
      payload: {
        reviews: facts.map((fact) => ({
          fact_id: fact.fact_id,
          decision: "REVIEWED",
          source: "CUSTOM",
          corrected_value: {
            normalized_fact_type: fact.fact_type,
            value: fact.raw_value,
          },
        })),
      },
    });
    assert.equal(reviews.statusCode, 201, reviews.body);
    const snapshot = await liveApp.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/review-snapshots`,
      headers: auth("freeze-live-facts"),
      payload: {},
    });
    assert.equal(snapshot.statusCode, 201, snapshot.body);
    assert.equal((snapshot.json() as { reviewed_fact_ids: string[] }).reviewed_fact_ids.length, 1);

    const workspace = await liveApp.inject({
      method: "GET",
      url: `/v1/cases/${caseId}/workspace`,
      headers: auth(),
    });
    assert.equal(workspace.statusCode, 200, workspace.body);
    const projection = workspace.json() as {
      cue_revision_id: string | null;
      event_graph: { events: unknown[] };
      findings: Array<{ verdict: string }>;
    };
    assert.equal(projection.cue_revision_id, null);
    assert.equal(projection.event_graph.events.length, 0);
    assert.equal(projection.findings.length, 3);
    assert.ok(projection.findings.every((finding) => finding.verdict === "INSUFFICIENT_EVIDENCE"));
  } finally {
    await liveApp.close();
  }
});

function source(
  role: SourceRole,
  input: {
    bytes: Uint8Array | null;
    content: unknown;
    mediaType: string | null;
    originalFilename?: string | null;
  },
): InternalSourceVersion {
  return {
    contract_version: "standby.source.v1",
    source_id: `source_${role.toLowerCase()}`,
    case_id: "case_upstage",
    role,
    sha256: input.bytes ? sha256(input.bytes) : sha256(JSON.stringify(input.content)),
    origin: "USER_PROVIDED",
    authority: "REVIEWED",
    media_type: input.mediaType,
    original_filename:
      input.originalFilename ??
      (role === "SCRIPT" ? "script.pdf" : role === "MASTER_CUE" ? "cue.xlsx" : null),
    created_at: "2026-08-22T00:00:00.000Z",
    content: input.content,
    bytes: input.bytes,
  };
}

test("Upstage adapter extracts a master cue without script or stage spec", async () => {
  const createBodies: Array<Record<string, unknown>> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer secret-test-key");
    const url = String(input);
    if (url.endsWith("/v2/files")) {
      return Response.json({ id: "file-cue" });
    }
    if (url.endsWith("/v2/responses") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      createBodies.push(body);
      assert.equal(body.config_id, "cfg_cue");
      assert.equal(body.model, "agt_cue");
      assert.equal("include" in body, false);
      return Response.json({ id: "job-cue" });
    }
    if (url.includes("job-cue")) {
      const pollUrl = new URL(url);
      assert.equal(pollUrl.pathname.endsWith("/v2/responses/job-cue"), true);
      assert.equal(pollUrl.searchParams.get("include[]"), "all");
      return Response.json({
        id: "job-cue",
        status: "completed",
        output: [{ content: [{
          type: "output_text",
          additional_values: {
            cue_facts: [{
              fact_type: "QUICK_CHANGE_AVAILABLE_WINDOW",
              locator: "Cue!C12",
              source_quote_raw: "58-62s",
              min_ms: 58000,
              max_ms: 62000,
            }],
          },
        }] }],
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const sources = new Map<SourceRole, InternalSourceVersion>([
    ["MASTER_CUE", source("MASTER_CUE", { bytes: Uint8Array.from([0x50, 0x4b, 1, 2]), content: null, mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })],
  ]);
  const provider = new UpstageAgentProvider({
    apiKey: "secret-test-key",
    agentIds: { MASTER_CUE: "agt_cue" },
    configIds: { MASTER_CUE: "cfg_cue" },
    fetchImpl: mockFetch,
    pollIntervalMs: 0,
    timeoutMs: 1_000,
  });
  const result = await provider.extract(sources);
  assert.equal(createBodies.length, 1);
  assert.equal(result.facts.length, 1);
  assert.ok(result.facts.some((fact) => fact.fact_type === "QUICK_CHANGE_AVAILABLE_WINDOW"));
  assert.ok(result.facts.every((fact) => fact.review_status === "UNREVIEWED"));
  assert.deepEqual(result.sourceRuns.map((run) => run.provider), ["UPSTAGE"]);
  assert.ok(result.sourceRuns.every((run) => /^[a-f0-9]{64}$/.test(run.raw_response_sha256)));
});

test("Upstage adapter reaches Extract output after a large XLSX Parse payload", async () => {
  const parseNoise = Array.from({ length: 10_001 }, (_, index) => ({
    row: index + 1,
    cells: [{ style_id: index % 8 }],
  }));
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v2/files")) return Response.json({ id: "file-large-cue" });
    if (url.endsWith("/v2/responses") && init?.method === "POST") {
      return Response.json({ id: "job-large-cue" });
    }
    return Response.json({
      id: "job-large-cue",
      status: "completed",
      output: [
        { type: "parse", additional_values: { rows: parseNoise } },
        {
          type: "extract",
          content: [{
            type: "output_text",
            additional_values: {
              cue_facts: [{
                fact_type: "CUE_TRIGGER",
                locator: "전체 큐시트!A6",
                source_quote_raw: "N#1",
              }],
            },
          }],
        },
      ],
    });
  };
  const provider = new UpstageAgentProvider({
    apiKey: "secret-test-key",
    agentIds: { MASTER_CUE: "agt_cue" },
    fetchImpl: mockFetch,
    pollIntervalMs: 0,
    timeoutMs: 1_000,
  });

  const result = await provider.extract(new Map<SourceRole, InternalSourceVersion>([
    ["MASTER_CUE", source("MASTER_CUE", {
      bytes: Uint8Array.from([0x50, 0x4b, 1, 2]),
      content: null,
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })],
  ]));

  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]?.fact_type, "CUE_TRIGGER");
  assert.equal(result.facts[0]?.locator, "전체 큐시트!A6");
});

test("Upstage adapter accepts the raw locator field from the frozen cue schema", async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v2/files")) return Response.json({ id: "file-raw-locator" });
    if (url.endsWith("/v2/responses") && init?.method === "POST") {
      return Response.json({ id: "job-raw-locator" });
    }
    return Response.json({
      id: "job-raw-locator",
      status: "completed",
      output: [{
        type: "extract",
        content: [{
          type: "output_text",
          additional_values: {
            cue_facts: [{
              record_kind: "ACTION",
              source_locator_raw: "cue:sheet0:r0046:c0013",
              source_quote_raw: "노래 시작하면 전체 on",
            }],
          },
        }],
      }],
    });
  };
  const provider = new UpstageAgentProvider({
    apiKey: "secret-test-key",
    agentIds: { MASTER_CUE: "agt_cue" },
    fetchImpl: mockFetch,
    pollIntervalMs: 0,
    timeoutMs: 1_000,
  });

  const result = await provider.extract(new Map<SourceRole, InternalSourceVersion>([
    ["MASTER_CUE", source("MASTER_CUE", {
      bytes: Uint8Array.from([0x50, 0x4b, 1, 2]),
      content: null,
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })],
  ]));

  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]?.fact_type, "ACTION");
  assert.equal(result.facts[0]?.locator, "cue:sheet0:r0046:c0013");
  assert.equal(result.facts[0]?.quote, "노래 시작하면 전체 on");
});

test("Upstage adapter prefers a fully evidenced Extract payload over intermediate cue data", async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v2/files")) return Response.json({ id: "file-multiple-candidates" });
    if (url.endsWith("/v2/responses") && init?.method === "POST") {
      return Response.json({ id: "job-multiple-candidates" });
    }
    return Response.json({
      id: "job-multiple-candidates",
      status: "completed",
      output: [{
        type: "extract",
        additional_values: {
          cue_facts: [{ fact_type: "INTERMEDIATE_ROW" }],
        },
        content: [{
          type: "output_text",
          text: JSON.stringify({
            cue_facts: [{
              fact_type: "CUE_ROW",
              locator: "t_0_r_5",
              source_quote_raw: "N#1 We're all adventurers",
            }],
          }),
        }],
      }],
    });
  };
  const provider = new UpstageAgentProvider({
    apiKey: "secret-test-key",
    agentIds: { MASTER_CUE: "agt_cue" },
    fetchImpl: mockFetch,
    pollIntervalMs: 0,
    timeoutMs: 1_000,
  });

  const result = await provider.extract(new Map<SourceRole, InternalSourceVersion>([
    ["MASTER_CUE", source("MASTER_CUE", {
      bytes: Uint8Array.from([0x50, 0x4b, 1, 2]),
      content: null,
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })],
  ]));

  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]?.fact_type, "CUE_ROW");
  assert.equal(result.facts[0]?.locator, "t_0_r_5");
});

test("Upstage adapter converts JSON master cues to a supported XLSX transport", async () => {
  const originalBytes = new TextEncoder().encode(JSON.stringify({
    cues: [{ cue_id: "E1", trigger: "LIGHT GO" }],
  }));
  const originalHash = sha256(originalBytes);
  let uploadedFile: File | null = null;
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v2/files")) {
      assert.ok(init?.body instanceof FormData);
      const file = init.body.get("file");
      assert.ok(file instanceof File);
      uploadedFile = file;
      assert.equal(file.name, "cue.upstage.xlsx");
      assert.equal(
        file.type,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      const bytes = new Uint8Array(await file.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 2)], [0x50, 0x4b]);
      return Response.json({ id: "file-json-cue" });
    }
    if (url.endsWith("/v2/responses") && init?.method === "POST") {
      return Response.json({ id: "job-json-cue" });
    }
    const pollUrl = new URL(url);
    assert.equal(pollUrl.searchParams.get("include[]"), "all");
    return Response.json({
      id: "job-json-cue",
      status: "completed",
      output: [{
        content: [{
          additional_values: JSON.stringify({
            cue_facts: [{
              fact_type: "CUE_TRIGGER",
              locator: "/cues/0/trigger",
              source_quote_raw: "LIGHT GO",
            }],
          }),
        }],
      }],
    });
  };
  const jsonSource = source("MASTER_CUE", {
    bytes: originalBytes,
    content: null,
    mediaType: "application/json",
    originalFilename: "cue.json",
  });
  const provider = new UpstageAgentProvider({
    apiKey: "secret-test-key",
    agentIds: { MASTER_CUE: "agt_cue" },
    fetchImpl: mockFetch,
    pollIntervalMs: 0,
    timeoutMs: 1_000,
  });

  const result = await provider.extract(
    new Map<SourceRole, InternalSourceVersion>([["MASTER_CUE", jsonSource]]),
  );

  assert.ok(uploadedFile);
  assert.equal(jsonSource.sha256, originalHash);
  assert.deepEqual(jsonSource.bytes, originalBytes);
  assert.equal(result.facts[0]?.locator, "/cues/0/trigger");
});

test("Upstage adapter fails closed when a generated fact has no evidence quote", async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v2/files")) return Response.json({ id: "file-1" });
    if (url.endsWith("/v2/responses") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal("config_id" in body, false);
      return Response.json({ id: "job-1" });
    }
    return Response.json({
      id: "job-1",
      status: "completed",
      output: [{ content: [{ text: JSON.stringify({ script_facts: [{ fact_type: "X", locator: "p.1" }] }) }] }],
    });
  };
  const provider = new UpstageAgentProvider({
    apiKey: "secret-test-key",
    agentIds: { SCRIPT: "agt_script", MASTER_CUE: "agt_cue" },
    fetchImpl: mockFetch,
    pollIntervalMs: 0,
    timeoutMs: 1_000,
  });
  const sources = new Map<SourceRole, InternalSourceVersion>([
    ["SCRIPT", source("SCRIPT", { bytes: new TextEncoder().encode("%PDF-fixture"), content: null, mediaType: "application/pdf" })],
    ["MASTER_CUE", source("MASTER_CUE", { bytes: Uint8Array.from([0x50, 0x4b]), content: null, mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" })],
    ["STAGE_SPEC", source("STAGE_SPEC", { bytes: null, content: HERO_SOURCE_CONTENT.STAGE_SPEC, mediaType: "application/json" })],
  ]);
  await assert.rejects(
    () => provider.extract(sources),
    (error: unknown) => error instanceof DomainError && error.code === "UPSTAGE_EVIDENCE_MISSING",
  );
});

test("Upstage adapter keeps evidenced facts when an extraction also contains an unevidenced row", async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v2/files")) return Response.json({ id: "file-mixed-evidence" });
    if (url.endsWith("/v2/responses") && init?.method === "POST") {
      return Response.json({ id: "job-mixed-evidence" });
    }
    return Response.json({
      id: "job-mixed-evidence",
      status: "completed",
      output: [{ content: [{ text: JSON.stringify({
        cue_facts: [
          { fact_type: "CUE_ROW", locator: "Cue!A2", source_quote_raw: "E1 GO" },
          { fact_type: "CUE_ROW", locator: "Cue!A3" },
        ],
      }) }] }],
    });
  };
  const provider = new UpstageAgentProvider({
    apiKey: "secret-test-key",
    agentIds: { MASTER_CUE: "agt_cue" },
    fetchImpl: mockFetch,
    pollIntervalMs: 0,
    timeoutMs: 1_000,
  });
  const result = await provider.extract(new Map<SourceRole, InternalSourceVersion>([
    ["MASTER_CUE", source("MASTER_CUE", {
      bytes: Uint8Array.from([0x50, 0x4b, 1, 2]),
      content: null,
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    })],
  ]));

  assert.equal(result.facts.length, 1);
  assert.equal(result.facts[0]?.quote, "E1 GO");
});

test("Upstage adapter reports only the failed upstream status", async () => {
  const provider = new UpstageAgentProvider({
    apiKey: "secret-test-key",
    agentIds: { MASTER_CUE: "agt_cue" },
    fetchImpl: async () => Response.json(
      { error: "sensitive upstream detail" },
      { status: 415 },
    ),
  });
  const sources = new Map<SourceRole, InternalSourceVersion>([
    ["MASTER_CUE", source("MASTER_CUE", {
      bytes: new TextEncoder().encode('{"rows":[]}'),
      content: null,
      mediaType: "application/json",
    })],
  ]);

  await assert.rejects(
    () => provider.extract(sources),
    (error: unknown) => error instanceof DomainError
      && error.code === "UPSTAGE_REQUEST_FAILED"
      && error.message === "Upstage API request failed with status 415."
      && !error.message.includes("sensitive upstream detail"),
  );
});
