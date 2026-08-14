// 양방향 동기화 비교 로직
//
// 결정 2: 마지막 동기화 스냅샷을 저장하지 않는다. 양쪽 "현재" 내용을 직접 비교한다.
//
// 비교 방식:
//   1. 소스 티켓을 기존 정방향 매핑(mapFieldsFromDb)에 통과시킨다 → 대상 ID 공간의 값이 나온다.
//   2. 그 값과 대상 티켓의 실제 값을 필드별로 정규화해서 비교한다.
//
// 이 방식이 중요한 이유: 동기화가 실제로 쓰는 값과 똑같은 값으로 비교하므로
// **동기화 직후에는 정의상 diff 가 비게 된다.** 스냅샷 없이도 "같으면 건너뛴다" 가 성립한다.

import type { JiraIssue } from '@/lib/types/jira';
import {
  canonicalizeFieldValue,
  resolveFieldKind,
  type FieldKind,
} from './field-canonicalizer';
import type { DbFieldMapping } from './db-field-mapper';

/** 필드 하나의 비교 결과 */
export interface FieldDiff {
  sourceField: string;
  targetField: string;
  /** UI 라벨 (DB 의 필드 이름, 없으면 필드 id) */
  label: string;
  kind: FieldKind;
  /** 소스 값(매핑 통과 후)의 표시 문자열 */
  sourceDisplay: string;
  /** 대상 값의 표시 문자열 */
  targetDisplay: string;
  equal: boolean;
}

/**
 * 상태 비교 입력.
 * 상태는 sync_field_mappings 가 아니라 sync_profile_status_mappings 로 관리되므로
 * 호출부(오케스트레이터)가 매핑을 해석해서 넘겨준다.
 */
export interface StatusComparison {
  /** 소스 상태를 대상 상태 공간으로 매핑한 결과 */
  mappedSourceStatusId: string;
  sourceStatusName?: string;
  targetStatusId?: string;
  targetStatusName?: string;
}

/** 티켓 한 쌍의 비교 결과 */
export interface TicketComparison {
  /** 비교한 모든 필드 (같은 것 포함) */
  fields: FieldDiff[];
  /** 다른 필드만 */
  changed: FieldDiff[];
  /** 매핑된 내용이 완전히 같은가 */
  identical: boolean;
}

/**
 * 매핑된 소스 값과 대상 티켓의 실제 값을 비교한다.
 *
 * @param mappings          sync_field_mappings 행들 (정본, 결정 4)
 * @param mappedSourceFields mapFieldsFromDb() 결과 — 키가 target_field 인 대상 ID 공간의 값
 * @param targetFields      대상 티켓의 fields
 */
export function compareMappedFields(
  mappings: DbFieldMapping[],
  mappedSourceFields: Record<string, unknown>,
  targetFields: JiraIssue['fields'],
  status?: StatusComparison
): TicketComparison {
  const fields: FieldDiff[] = [];

  // 상태는 별도 매핑 테이블을 쓰므로 먼저 넣는다 (표에서도 맨 위에 보이는 편이 낫다)
  if (status) {
    const targetStatusId = status.targetStatusId ?? null;
    fields.push({
      sourceField: 'status',
      targetField: 'status',
      label: '상태',
      kind: 'scalar',
      sourceDisplay: status.sourceStatusName ?? `#${status.mappedSourceStatusId}`,
      targetDisplay: status.targetStatusName ?? (targetStatusId ? `#${targetStatusId}` : '(없음)'),
      equal: status.mappedSourceStatusId === targetStatusId,
    });
  }

  for (const mapping of mappings) {
    const kind = resolveFieldKind(mapping.transform_type, mapping.source_field);

    const source = canonicalizeFieldValue(kind, mappedSourceFields[mapping.target_field]);
    const target = canonicalizeFieldValue(kind, targetFields[mapping.target_field]);

    // 양쪽 다 비어 있으면 비교할 것이 없다.
    // (한쪽만 비어 있는 것은 **실제 차이**다 - 양방향에서는 한쪽에만 값이 생기는 일이 흔하고,
    //  그것을 반대쪽으로 가져오는 것이 이 화면의 목적이다.
    //  한때 "소스가 비면 건너뛴다" 로 두었더니 대상에만 추정치가 들어간 경우를 놓쳤다)
    if (source.canonical === null && target.canonical === null) continue;

    fields.push({
      sourceField: mapping.source_field,
      targetField: mapping.target_field,
      label:
        mapping.target_field_name ||
        mapping.source_field_name ||
        mapping.source_field,
      kind,
      sourceDisplay: source.display,
      targetDisplay: target.display,
      equal: source.canonical === target.canonical,
    });
  }

  const changed = fields.filter((f) => !f.equal);

  return {
    fields,
    changed,
    identical: changed.length === 0,
  };
}

/**
 * 어느 방향을 먼저 제안할지 결정한다.
 *
 * 결정 2: `updated` 는 **판정 근거가 아니라 방향 힌트로만** 쓴다.
 * 우리 쓰기에도 updated 가 갱신되므로 이것만 보면 방향이 계속 뒤집힌다.
 * 그래서 "무엇이 다른가"는 이미 compareMappedFields 가 판정했고,
 * 여기서는 사람에게 어느 버튼을 먼저 보여줄지만 고른다.
 */
export function suggestDirection(
  sourceUpdated: string | undefined,
  targetUpdated: string | undefined
): 'sourceToTarget' | 'targetToSource' {
  const s = sourceUpdated ? Date.parse(sourceUpdated) : NaN;
  const t = targetUpdated ? Date.parse(targetUpdated) : NaN;

  if (Number.isNaN(s) && Number.isNaN(t)) return 'sourceToTarget';
  if (Number.isNaN(t)) return 'sourceToTarget';
  if (Number.isNaN(s)) return 'targetToSource';

  // 동률이면 기존 동작(소스 기준)을 유지한다
  return t > s ? 'targetToSource' : 'sourceToTarget';
}
