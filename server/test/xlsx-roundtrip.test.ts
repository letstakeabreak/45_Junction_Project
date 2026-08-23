import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import ExcelJS from "exceljs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { CueRevision, SourceVersion } from "../src/domain/types.js";
import { cellText } from "../src/domain/xlsx-revision.js";
import { sha256 } from "../src/lib/hash.js";
import type { ExtractionProvider } from "../src/providers/extraction-provider.js";

const TOKEN = "xlsx-test-token";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
let app: FastifyInstance;
let sequence = 0;

before(async () => {
  app = await buildApp({ apiToken: TOKEN, allowedOrigins: ["http://localhost:5173"] });
});

after(async () => app.close());

function headers(idempotent = false): Record<string, string> {
  sequence += 1;
  return {
    authorization: `Bearer ${TOKEN}`,
    ...(idempotent ? { "idempotency-key": `xlsx-${sequence}` } : {}),
  };
}

function multipart(boundary: string, bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="origin"\r\n\r\nUSER_PROVIDED\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="master.xlsx"\r\n` +
      `Content-Type: ${XLSX}\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

test("dangling merged cells are read as blank instead of crashing the upload", () => {
  const cell = { value: null } as ExcelJS.Cell;
  Object.defineProperty(cell, "text", {
    get() {
      throw new TypeError("Cannot read properties of null (reading 'toString')");
    },
  });

  assert.equal(cellText(cell), "");
});

test("a failed XLSX revision parse does not lock the source slot", async () => {
  const created = await app.inject({
    method: "POST",
    url: "/v1/cases",
    headers: headers(true),
    payload: { title: "Transactional upload" },
  });
  const caseId = (created.json() as { case_id: string }).case_id;
  const upload = (bytes: Buffer, suffix: string) => {
    const boundary = `transactional-${suffix}`;
    return app.inject({
      method: "POST",
      url: `/v1/cases/${caseId}/sources/MASTER_CUE`,
      headers: { ...headers(true), "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: multipart(boundary, bytes),
    });
  };

  const failed = await upload(Buffer.from("PK invalid workbook"), "bad");
  assert.equal(failed.statusCode, 500, failed.body);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Cue");
  sheet.addRow(["Cue", "Action"]);
  sheet.addRow(["E1", "GO"]);
  const valid = await upload(Buffer.from(await workbook.xlsx.writeBuffer()), "valid");
  assert.equal(valid.statusCode, 201, valid.body);
});

test("XLSX revision export changes only the patched cell and preserves workbook shape", async () => {
  const workbook = new ExcelJS.Workbook();
  const cues = workbook.addWorksheet("큐시트");
  cues.addRow(["Cue", "환복시간", "비고"]);
  cues.addRow(["E3", "58s", "keep"]);
  cues.addRow([]);
  cues.addRow(["E4", "90s", "remove"]);
  cues.getCell("A1").font = { bold: true, color: { argb: "FFFF0000" } };
  cues.getColumn(3).width = 31;
  const notes = workbook.addWorksheet("Notes");
  notes.getCell("A1").value = "untouched";
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

  const created = await app.inject({
    method: "POST",
    url: "/v1/cases",
    headers: headers(true),
    payload: { title: "Roundtrip" },
  });
  const caseId = (created.json() as { case_id: string }).case_id;
  const boundary = "standby-xlsx-boundary";
  const uploaded = await app.inject({
    method: "POST",
    url: `/v1/cases/${caseId}/sources/MASTER_CUE`,
    headers: { ...headers(true), "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: multipart(boundary, bytes),
  });
  assert.equal(uploaded.statusCode, 201, uploaded.body);
  const source = uploaded.json() as SourceVersion;

  const revisions = await app.inject({
    method: "GET",
    url: `/v1/cases/${caseId}/cue-revisions`,
    headers: headers(),
  });
  const base = (revisions.json() as { items: CueRevision[] }).items[0];
  assert.ok(base);
  const changed = await app.inject({
    method: "POST",
    url: `/v1/cases/${caseId}/cue-revisions`,
    headers: headers(true),
    payload: {
      base_revision_id: base.revision_id,
      base_source_sha256: source.sha256,
      patches: [{ row_id: "t_0_r_2", column: "환복시간", from: "58s", to: "70s" }],
    },
  });
  assert.equal(changed.statusCode, 201, changed.body);
  const revision = changed.json() as CueRevision;

  const exported = await app.inject({
    method: "GET",
    url: `/v1/cases/${caseId}/cue-revisions/${revision.revision_id}/export.xlsx`,
    headers: headers(),
  });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.match(String(exported.headers["content-disposition"]), /master-standby\.xlsx/);

  const reopened = new ExcelJS.Workbook();
  await reopened.xlsx.load(exported.rawPayload as unknown as Parameters<typeof reopened.xlsx.load>[0]);
  assert.deepEqual(reopened.worksheets.map((sheet) => sheet.name), ["큐시트", "Notes"]);
  assert.equal(reopened.getWorksheet("큐시트")?.getCell("B2").text, "70s");
  assert.equal(reopened.getWorksheet("큐시트")?.getCell("C2").text, "keep");
  assert.equal(reopened.getWorksheet("큐시트")?.getCell("A1").font.bold, true);
  assert.equal(reopened.getWorksheet("큐시트")?.getColumn(3).width, 31);
  assert.equal(reopened.getWorksheet("Notes")?.getCell("A1").text, "untouched");

  const structural = await app.inject({
    method: "POST",
    url: `/v1/cases/${caseId}/cue-revisions`,
    headers: headers(true),
    payload: {
      base_revision_id: revision.revision_id,
      base_source_sha256: source.sha256,
      patches: [],
      row_operations: [
        {
          type: "ADD",
          after_row_id: "t_0_r_2",
          row: { id: "t_0_n_added", Cue: "E3B", 환복시간: "75s", 비고: "added" },
        },
        { type: "DELETE", row_id: "t_0_r_4" },
      ],
    },
  });
  assert.equal(structural.statusCode, 201, structural.body);
  const structuralRevision = structural.json() as CueRevision;
  const structuralExport = await app.inject({
    method: "GET",
    url: `/v1/cases/${caseId}/cue-revisions/${structuralRevision.revision_id}/export.xlsx`,
    headers: headers(),
  });
  assert.equal(structuralExport.statusCode, 200, structuralExport.body);
  const structuralBook = new ExcelJS.Workbook();
  await structuralBook.xlsx.load(structuralExport.rawPayload as unknown as Parameters<typeof structuralBook.xlsx.load>[0]);
  const structuralSheet = structuralBook.getWorksheet("큐시트");
  assert.equal(structuralSheet?.getCell("A2").text, "E3");
  assert.equal(structuralSheet?.getCell("A3").text, "E3B");
  assert.equal(structuralSheet?.getCell("A4").text, "");
  assert.equal(structuralSheet?.getCell("A5").text, "");
  assert.equal(structuralBook.getWorksheet("Notes")?.getCell("A1").text, "untouched");

  const word = await app.inject({
    method: "GET",
    url: `/v1/cases/${caseId}/cue-revisions/${structuralRevision.revision_id}/export.docx`,
    headers: headers(),
  });
  assert.equal(word.statusCode, 200, word.body);
  assert.equal(word.rawPayload.subarray(0, 2).toString(), "PK");
  assert.match(String(word.headers["content-disposition"]), /standby-standard-cue\.docx/);

  const print = await app.inject({
    method: "GET",
    url: `/v1/cases/${caseId}/cue-revisions/${structuralRevision.revision_id}/print`,
    headers: headers(),
  });
  assert.equal(print.statusCode, 200, print.body);
  assert.match(print.body, /STANDBY · STANDARD CUE/);
  assert.match(print.body, /________________/);
  assert.match(print.body, /window|print\(\)/);
});

test("refresh reuses an identical source and leaves changed-source facts UNREVIEWED", async () => {
  let calls = 0;
  const provider: ExtractionProvider = {
    async extract(sources) {
      calls += 1;
      const source = sources.get("MASTER_CUE");
      assert.ok(source);
      return {
        facts: [{
          fact_id: `fact_${source.sha256.slice(0, 8)}`,
          fact_type: "CUE_ROW",
          raw_value: { cue_id: "E1" },
          reviewed_value: null,
          source_role: "MASTER_CUE",
          source_id: source.source_id,
          locator: "t_0_r_2",
          quote: "E1",
          origin: source.origin,
          confidence: "NOT_PROVIDED",
          review_status: "UNREVIEWED",
        }],
        sourceRuns: [{
          source_id: source.source_id,
          role: "MASTER_CUE",
          provider: "UPSTAGE",
          provider_job_id: `job-${calls}`,
          agent_id: "agt-test",
          config_id: "1",
          adapter_version: "test.v1",
          schema_version: "standby.extraction.v1",
          raw_response_sha256: sha256(`response-${calls}`),
        }],
      };
    },
  };
  const live = await buildApp({ apiToken: TOKEN, allowedOrigins: [], extractionProvider: provider });
  try {
    const create = await live.inject({ method: "POST", url: "/v1/cases", headers: headers(true), payload: { title: "Refresh" } });
    const caseId = (create.json() as { case_id: string }).case_id;
    const makeWorkbook = async (value: string) => {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Cue");
      sheet.addRow(["Cue", "Value"]);
      sheet.addRow(["E1", value]);
      return Buffer.from(await workbook.xlsx.writeBuffer());
    };
    const original = await makeWorkbook("A");
    const upload = async (path: string, bytes: Buffer) => {
      const boundary = `refresh-${sequence}`;
      return live.inject({
        method: "POST",
        url: path,
        headers: { ...headers(true), "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: multipart(boundary, bytes),
      });
    };
    assert.equal((await upload(`/v1/cases/${caseId}/sources/MASTER_CUE`, original)).statusCode, 201);
    const extract = async () => {
      const response = await live.inject({
        method: "POST",
        url: `/v1/cases/${caseId}/extraction-runs`,
        headers: headers(true),
        payload: { adapter: "UPSTAGE_AGENT" },
      });
      assert.equal(response.statusCode, 202, response.body);
      await new Promise<void>((resolve) => setImmediate(resolve));
    };
    await extract();
    await extract();
    assert.equal(calls, 1);

    assert.equal((await upload(`/v1/cases/${caseId}/source-refreshes/MASTER_CUE`, original)).statusCode, 201);
    await extract();
    assert.equal(calls, 1);

    assert.equal((await upload(`/v1/cases/${caseId}/source-refreshes/MASTER_CUE`, await makeWorkbook("B"))).statusCode, 201);
    await extract();
    assert.equal(calls, 2);
    const queue = await live.inject({ method: "GET", url: `/v1/cases/${caseId}/review-queue`, headers: headers() });
    const facts = (queue.json() as { items: Array<{ review_status: string }> }).items;
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.review_status, "UNREVIEWED");
  } finally {
    await live.close();
  }
});
