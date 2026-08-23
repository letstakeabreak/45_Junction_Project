export type ScriptSegmentKind = 'DIALOGUE' | 'STAGE_DIRECTION';

export type ScriptProjectionSegment = {
  segment_id: string;
  sequence_index: number;
  kind: ScriptSegmentKind;
  text: string;
  speaker: string | null;
  event_id: string | null;
  section_marker: string | null;
  locator: string;
  source_quote: string;
  provenance: {
    raw_fact_id: string;
    raw_fact_sha256: string;
  } | {
    fixture_segment_id: string;
    source_sha256: string;
  };
};

export type ScriptProjection = {
  contract_version: 'standby.script-projection.v1';
  projection_id: string;
  case_id: string | null;
  authority: 'NON_AUTHORITATIVE';
  source: {
    filename: string;
    media_type: string;
    sha256: string;
  };
  provenance: {
    provider: 'UPSTAGE_AGENT';
    source_role: 'SCRIPT';
    origin: 'USER_PROVIDED';
    provider_job_id: string;
    agent_id: string;
    config_id: string | null;
    adapter_version: string;
    raw_response_sha256: string;
  } | {
    provider: 'CONTROLLED_FIXTURE';
    source_role: 'SCRIPT';
    origin: 'CONTROLLED_FIXTURE';
    fixture_id: string;
    source_sha256: string;
  };
  segments: ScriptProjectionSegment[];
  created_at: string;
};

export type ScriptExcerptLine = Pick<
  ScriptProjectionSegment,
  'segment_id' | 'kind' | 'text' | 'speaker' | 'locator'
>;

export type ScriptSidebarEntry = {
  eventId: string;
  sceneLabel?: string;
  lines: ScriptExcerptLine[];
};

export type ScriptEventLinks = Record<string, string>;
