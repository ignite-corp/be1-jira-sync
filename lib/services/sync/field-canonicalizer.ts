// 필드 값 정규화 (양방향 비교용)
//
// 같은 논리적 내용이 두 사이트에서 다르게 표현되는 문제를 흡수한다.
//  - description: ADF 문서 vs 문자열, media 노드 유무
//  - 사용자: Ignite accountId vs HMG accountId (매핑 후 비교하므로 accountId 만 남기면 됨)
//  - 스프린트: "BEDEV1 202608" vs "GW 202608" (매핑이 대상 스프린트 id 로 해석해 주므로 id 로 비교)
//  - 수정버전: 버전 id 가 프로젝트마다 다름 (매핑이 대상 버전 id 로 해석)
//  - 작업시간: "1d" vs "8h" (초 단위로 환산)
//
// 핵심 전제: 비교는 항상 **매핑을 통과한 값(대상 ID 공간)** 과 **대상의 실제 값** 사이에서 이뤄진다.
// 그래서 동기화 직후에는 양쪽이 같은 값이 되어 diff 가 비게 된다. (결정 2)

/** 비교 대상 필드의 종류 */
export type FieldKind =
  | 'scalar'
  | 'adf'
  | 'user'
  | 'sprint'
  | 'versions'
  | 'timetracking';

/** 정규화 결과: canonical 은 동등성 판정용, display 는 사람에게 보여줄 문자열 */
export interface CanonicalValue {
  /** 동등성 판정에 쓰는 값. null 이면 "값 없음" */
  canonical: string | null;
  /** UI 에 보여줄 문자열 */
  display: string;
}

const EMPTY: CanonicalValue = { canonical: null, display: '(없음)' };

/**
 * sync_field_mappings 의 transform_type + source_field 로 필드 종류를 결정한다.
 *
 * mapFieldsFromDb() 의 분기와 1:1 로 맞춰져 있다.
 * (db-field-mapper.ts 의 copy/sprint_map/version_map 분기 및 assignee/reporter/description/fixVersions 특례)
 */
export function resolveFieldKind(
  transformType: string | null | undefined,
  sourceField: string
): FieldKind {
  if (transformType === 'sprint_map') return 'sprint';
  if (transformType === 'version_map') return 'versions';

  // copy (및 알 수 없는 타입 → copy 폴백) 에서의 특례들
  if (sourceField === 'assignee' || sourceField === 'reporter') return 'user';
  if (sourceField === 'description') return 'adf';
  if (sourceField === 'timetracking') return 'timetracking';
  if (sourceField === 'fixVersions') return 'versions';

  return 'scalar';
}

/**
 * 필드 값을 비교 가능한 형태로 정규화한다.
 * 쓰기 페이로드 형태(매핑 결과)와 읽기 응답 형태(Jira 조회 결과) 양쪽을 모두 받아들인다.
 */
export function canonicalizeFieldValue(
  kind: FieldKind,
  value: unknown
): CanonicalValue {
  if (value === undefined || value === null) return EMPTY;

  switch (kind) {
    case 'adf':
      return canonicalizeAdf(value);
    case 'user':
      return canonicalizeUser(value);
    case 'sprint':
      return canonicalizeSprint(value);
    case 'versions':
      return canonicalizeVersions(value);
    case 'timetracking':
      return canonicalizeTimetracking(value);
    case 'scalar':
    default:
      return canonicalizeScalar(value);
  }
}

// ---------------------------------------------------------------------------
// ADF / 본문
// ---------------------------------------------------------------------------

/**
 * ADF 문서를 비교용 평문으로 변환한다.
 *
 * - media / mediaInline / mediaSingle / mediaGroup 은 제거한다.
 *   (동기화 시 db-field-mapper.removeMediaSingleNodes 가 어차피 떼어내므로,
 *    남겨두면 "첨부 때문에 매번 다름" 이라는 거짓 diff 가 난다)
 * - hardBreak / paragraph 등 블록 경계는 줄바꿈으로 환원한다.
 * - 연속 공백은 한 칸으로 접는다.
 */
export function adfToPlainText(doc: unknown): string {
  if (doc === null || doc === undefined) return '';
  if (typeof doc === 'string') return doc;
  if (typeof doc !== 'object') return String(doc);

  const parts: string[] = [];

  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }

    const n = node as {
      type?: string;
      text?: string;
      content?: unknown;
      attrs?: Record<string, unknown>;
    };

    // 미디어 노드는 통째로 제외
    if (
      n.type === 'media' ||
      n.type === 'mediaInline' ||
      n.type === 'mediaSingle' ||
      n.type === 'mediaGroup'
    ) {
      return;
    }

    if (n.type === 'hardBreak') {
      parts.push('\n');
      return;
    }

    if (typeof n.text === 'string') {
      parts.push(n.text);
    }

    // 멘션/이모지처럼 text 가 없고 attrs 에 표시값이 있는 노드
    if (!n.text && n.attrs) {
      const attrText = n.attrs.text ?? n.attrs.shortName;
      if (typeof attrText === 'string') parts.push(attrText);
    }

    if (n.content) {
      walk(n.content);
      // 블록 레벨 노드 뒤에는 줄바꿈
      if (isBlockNode(n.type)) parts.push('\n');
    }
  };

  walk(doc);

  return parts.join('');
}

function isBlockNode(type: string | undefined): boolean {
  if (!type) return false;
  return [
    'paragraph',
    'heading',
    'blockquote',
    'codeBlock',
    'listItem',
    'bulletList',
    'orderedList',
    'panel',
    'rule',
    'tableRow',
  ].includes(type);
}

/** 비교용 공백 정규화: 줄 끝 공백 제거, 빈 줄 축약, 앞뒤 trim */
export function normalizeText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function canonicalizeAdf(value: unknown): CanonicalValue {
  const text = normalizeText(adfToPlainText(value));
  if (!text) return EMPTY;
  return { canonical: text, display: text };
}

// ---------------------------------------------------------------------------
// 사용자
// ---------------------------------------------------------------------------

function canonicalizeUser(value: unknown): CanonicalValue {
  if (typeof value === 'string') {
    const v = value.trim();
    return v ? { canonical: v, display: v } : EMPTY;
  }
  if (typeof value === 'object' && value !== null && 'accountId' in value) {
    const user = value as { accountId?: string; displayName?: string };
    const accountId = user.accountId?.trim();
    if (!accountId) return EMPTY;
    return {
      canonical: accountId,
      display: user.displayName || accountId,
    };
  }
  return EMPTY;
}

// ---------------------------------------------------------------------------
// 스프린트
// ---------------------------------------------------------------------------

/**
 * 스프린트 이름에서 연월(YYYYMM) 추출. "BEDEV1 202608" → "202608", "GW 2608" → "202608"
 * sprint-mapper 의 extractSprintPeriod/convertToFullYearMonth 와 같은 규칙.
 */
export function extractSprintYearMonth(name: string): string | null {
  const match = name.match(/(?<=\s)(\d+)\s*$/);
  if (!match) return null;
  const period = match[1];
  return period.length === 4 ? `20${period}` : period;
}

/**
 * 스프린트 값을 대상 스프린트 id 로 정규화한다.
 *
 * 매핑 결과는 대상 보드의 스프린트 id(숫자) 이고, 조회 결과는 스프린트 객체 배열이다.
 * 배열이면 active 를 우선 선택하고, 없으면 첫 번째를 쓴다.
 * (mapFieldsFromDb 가 소스의 sprint[0] 를 기준으로 매핑하므로 대칭)
 */
function canonicalizeSprint(value: unknown): CanonicalValue {
  const pick = (v: unknown): { id?: unknown; name?: string } | null => {
    if (Array.isArray(v)) {
      if (v.length === 0) return null;
      const active = v.find(
        (s) => s && typeof s === 'object' && (s as { state?: string }).state === 'active'
      );
      return (active ?? v[0]) as { id?: unknown; name?: string };
    }
    if (typeof v === 'number') return { id: v };
    if (typeof v === 'string') return { id: v };
    if (typeof v === 'object' && v !== null) return v as { id?: unknown; name?: string };
    return null;
  };

  const sprint = pick(value);
  if (!sprint) return EMPTY;

  const id = sprint.id;
  if (id === undefined || id === null || id === '') return EMPTY;

  return {
    canonical: String(id),
    display: sprint.name ? sprint.name : `#${String(id)}`,
  };
}

// ---------------------------------------------------------------------------
// 수정버전 (fixVersions)
// ---------------------------------------------------------------------------

function canonicalizeVersions(value: unknown): CanonicalValue {
  if (!Array.isArray(value) || value.length === 0) return EMPTY;

  const ids: string[] = [];
  const names: string[] = [];

  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const v = item as { id?: unknown; name?: string };
    if (v.id !== undefined && v.id !== null) ids.push(String(v.id));
    if (v.name) names.push(v.name);
  }

  if (ids.length === 0) return EMPTY;

  const sortedIds = [...ids].sort();
  return {
    canonical: sortedIds.join(','),
    display: names.length > 0 ? [...names].sort().join(', ') : sortedIds.join(', '),
  };
}

// ---------------------------------------------------------------------------
// 작업시간 (timetracking)
// ---------------------------------------------------------------------------

/**
 * Jira 기간 문자열을 초로 환산한다. "1d 2h" → 36000 (1d = 8h, 1w = 5d)
 * 파싱 불가면 null.
 */
export function parseJiraDuration(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const unitSeconds: Record<string, number> = {
    w: 5 * 8 * 3600,
    d: 8 * 3600,
    h: 3600,
    m: 60,
  };

  const matches = trimmed.matchAll(/(\d+(?:\.\d+)?)\s*([wdhm])/gi);
  let total = 0;
  let found = false;

  for (const m of matches) {
    const amount = parseFloat(m[1]);
    const unit = m[2].toLowerCase();
    if (Number.isNaN(amount) || !unitSeconds[unit]) continue;
    total += amount * unitSeconds[unit];
    found = true;
  }

  return found ? Math.round(total) : null;
}

/**
 * 작업시간 정규화.
 * 동기화가 실제로 쓰는 값은 originalEstimate / remainingEstimate 두 개뿐이므로
 * (db-field-mapper 및 field-mapper.mapFieldsForAutoway 참고) 그 둘만 비교한다.
 * timeSpent 는 worklog 로만 관리돼 필드 업데이트로 못 옮기므로 비교에서 제외한다.
 */
function canonicalizeTimetracking(value: unknown): CanonicalValue {
  if (typeof value !== 'object' || value === null) return EMPTY;

  const tt = value as {
    originalEstimate?: string;
    remainingEstimate?: string;
    originalEstimateSeconds?: number;
    remainingEstimateSeconds?: number;
  };

  const toSeconds = (
    text: string | undefined,
    seconds: number | undefined
  ): number | null => {
    if (typeof seconds === 'number') return seconds;
    if (typeof text === 'string') return parseJiraDuration(text);
    return null;
  };

  const original = toSeconds(tt.originalEstimate, tt.originalEstimateSeconds);
  const remaining = toSeconds(tt.remainingEstimate, tt.remainingEstimateSeconds);

  if (original === null && remaining === null) return EMPTY;

  const fmt = (s: number | null) => (s === null ? '-' : formatJiraDuration(s));

  return {
    canonical: `o=${original ?? ''};r=${remaining ?? ''}`,
    display: `최초 ${fmt(original)} / 잔여 ${fmt(remaining)}`,
  };
}

/**
 * 초를 Jira 기간 문자열로 변환한다. 28800 → "1d" (1d = 8h, parseJiraDuration 의 역)
 */
export function formatJiraDuration(seconds: number): string {
  if (seconds === 0) return '0m';
  const days = Math.floor(seconds / (8 * 3600));
  const hours = Math.floor((seconds % (8 * 3600)) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  return parts.join(' ');
}

// ---------------------------------------------------------------------------
// 단순 값
// ---------------------------------------------------------------------------

function canonicalizeScalar(value: unknown): CanonicalValue {
  if (typeof value === 'string') {
    const v = normalizeText(value);
    return v ? { canonical: v, display: v } : EMPTY;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    const v = String(value);
    return { canonical: v, display: v };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return EMPTY;
    const items = value.map((v) => scalarToken(v)).filter(Boolean) as string[];
    if (items.length === 0) return EMPTY;
    const sorted = [...items].sort();
    return { canonical: sorted.join(','), display: sorted.join(', ') };
  }

  if (typeof value === 'object' && value !== null) {
    // {value: 'x'} / {name: 'x'} / {id: 'x'} 형태의 선택형 필드
    const token = scalarToken(value);
    if (token) return { canonical: token, display: token };
    const json = stableStringify(value);
    return json === '{}' ? EMPTY : { canonical: json, display: json };
  }

  return EMPTY;
}

function scalarToken(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const v = value as { value?: unknown; name?: unknown; id?: unknown };
    for (const candidate of [v.value, v.name, v.id]) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      if (typeof candidate === 'number') return String(candidate);
    }
  }
  return null;
}

/** 키 순서에 무관한 JSON 직렬화 (객체 비교 폴백용) */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}
