// 샘플 티켓으로 "화면에 보이는 그 필드" 를 찾아내기 위한 순수 함수들
//
// 왜 필요한가: /field 는 사이트 전체 필드를 돌려준다 (HMG 는 1072개).
// "시작 날짜" 같은 이름은 10개 넘게 중복되므로 이름만으로는 고를 수 없다.
// 확실한 근거는 두 가지뿐이다.
//   1. editmeta: 그 티켓의 편집 화면에 실제로 올라와 있는 필드 (보통 수십 개)
//   2. issue?expand=names: 그 티켓이 실제로 들고 있는 값
// 화면에서 2026-11-18 이 보인다면, 그 값을 가진 필드가 찾는 필드다.

export interface FieldProbe {
  /** 편집 화면(editmeta)에 올라와 있는 필드인가 */
  onEditScreen: boolean;
  /** 이 티켓에서 값을 갖고 있는가 */
  hasValue: boolean;
  /** 값 미리보기 (없으면 null) */
  preview: string | null;
  /** 티켓 응답(expand=names)이 알려주는 표시 이름 */
  screenName: string | null;
}

const MAX_PREVIEW = 80;

function truncate(s: string): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > MAX_PREVIEW ? `${t.slice(0, MAX_PREVIEW)}…` : t;
}

/** ADF(문서 형식) 에서 텍스트만 뽑는다 */
function extractAdfText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; text?: string; content?: unknown[] };
  if (typeof n.text === 'string') return n.text;
  if (Array.isArray(n.content)) return n.content.map(extractAdfText).join(' ');
  return '';
}

/**
 * Jira 필드 값을 사람이 읽을 수 있는 한 줄로 만든다.
 * 값이 비어 있으면 null (= "이 필드는 이 티켓에서 안 쓰임").
 */
export function formatFieldValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  if (typeof value === 'string') {
    const t = value.trim();
    return t === '' ? null : truncate(t);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((v) => formatFieldValue(v))
      .filter((v): v is string => v !== null);
    if (parts.length === 0) return null;
    const shown = parts.slice(0, 3).join(', ');
    return truncate(parts.length > 3 ? `${shown} 외 ${parts.length - 3}` : shown);
  }

  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;

    // ADF 본문
    if (o.type === 'doc') {
      const text = extractAdfText(o);
      return text.trim() === '' ? null : truncate(text);
    }

    // 이름을 가진 객체 (사용자, 상태, 옵션, 스프린트 …)
    for (const key of ['displayName', 'name', 'value', 'key']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim() !== '') return truncate(v);
    }

    const json = JSON.stringify(o);
    return json === '{}' ? null : truncate(json);
  }

  return null;
}

export interface ProbeSource {
  /** GET issue/{key}?expand=names 응답 */
  issue?: {
    fields?: Record<string, unknown> | null;
    names?: Record<string, string> | null;
  } | null;
  /** GET issue/{key}/editmeta 응답 (권한이 없으면 생략 가능) */
  editmeta?: { fields?: Record<string, unknown> | null } | null;
}

/**
 * 필드 id → 근거 매핑을 만든다.
 * 두 응답 중 하나만 있어도 동작한다 (editmeta 는 권한에 따라 실패할 수 있다).
 */
export function buildFieldProbes(source: ProbeSource): Record<string, FieldProbe> {
  const probes: Record<string, FieldProbe> = {};

  const names = source.issue?.names ?? {};
  const fields = source.issue?.fields ?? {};
  const editable = source.editmeta?.fields ?? {};

  const ensure = (id: string): FieldProbe => {
    if (!probes[id]) {
      probes[id] = {
        onEditScreen: false,
        hasValue: false,
        preview: null,
        screenName: null,
      };
    }
    return probes[id];
  };

  for (const [id, value] of Object.entries(fields)) {
    const probe = ensure(id);
    const preview = formatFieldValue(value);
    probe.preview = preview;
    probe.hasValue = preview !== null;
    probe.screenName = names[id] ?? null;
  }

  for (const id of Object.keys(editable)) {
    ensure(id).onEditScreen = true;
  }

  for (const [id, name] of Object.entries(names)) {
    const probe = ensure(id);
    if (!probe.screenName) probe.screenName = name;
  }

  return probes;
}

/** 티켓 키 형식 검증 + 정규화 (대문자, 공백/URL 제거) */
export function normalizeIssueKey(input: string): string | null {
  const raw = input.trim();
  if (raw === '') return null;
  // 브라우저 URL 을 그대로 붙여넣는 경우도 받아준다
  const fromUrl = raw.match(/\/browse\/([A-Za-z][A-Za-z0-9_]*-\d+)/);
  const candidate = (fromUrl ? fromUrl[1] : raw).toUpperCase();
  return /^[A-Z][A-Z0-9_]*-\d+$/.test(candidate) ? candidate : null;
}
