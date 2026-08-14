// 쓰기 페이로드 정리
//
// 매핑(sync_field_mappings)에는 "읽을 때는 존재하지만 쓸 수는 없는" 필드가 들어갈 수 있다.
// 대표적인 것이 추정치다. Jira 는 timeoriginalestimate 를 직접 설정하는 것을 거부한다:
//
//   {"errors":{"timeoriginalestimate":
//     "Field 'timeoriginalestimate' cannot be set. It is not on the appropriate screen, or unknown."}}
//
// 추정치는 반드시 timetracking 객체로 넣어야 한다. 그래서 쓰기 직전에
// 초 단위 필드를 timetracking 으로 접고, 계산 전용 필드는 떨어낸다.
//
// 비교(ticket-comparator)에는 이 정리를 적용하지 않는다. 비교는 "무엇이 다른가"를
// 그대로 보여줘야 하고, 여기는 "어떻게 써야 Jira 가 받아주는가"만 다룬다.

import { formatJiraDuration } from './field-canonicalizer';

/** 초 단위 필드 → timetracking 하위 키 */
const SECONDS_FIELD_TO_TIMETRACKING: Record<string, 'originalEstimate' | 'remainingEstimate'> = {
  timeoriginalestimate: 'originalEstimate',
  timeestimate: 'remainingEstimate',
};

/**
 * Jira 가 계산해서 내려주는 값들. 매핑에 들어가 있어도 쓰기는 불가능하다.
 * (timeSpent 계열은 worklog 로만 변경된다)
 */
const READ_ONLY_FIELDS = [
  'timespent',
  'aggregatetimespent',
  'aggregatetimeoriginalestimate',
  'aggregatetimeestimate',
  'progress',
  'aggregateprogress',
  'workratio',
];

/** timetracking 에서 실제로 설정 가능한 키 */
interface WritableTimetracking {
  originalEstimate?: string;
  remainingEstimate?: string;
}

/**
 * 매핑 결과를 Jira 가 받아주는 형태로 정리한다.
 *
 * - timeoriginalestimate / timeestimate → timetracking 으로 접는다
 * - timetracking 에서는 설정 가능한 두 키만 남긴다 (timeSpent, *Seconds 등 제거)
 * - 계산 전용 필드는 제거한다
 */
export function sanitizeWritePayload(
  fields: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...fields };

  // 1. 기존 timetracking 에서 쓰기 가능한 키만 추린다
  const timetracking: WritableTimetracking = {};
  const rawTimetracking = out.timetracking;
  if (rawTimetracking && typeof rawTimetracking === 'object') {
    const tt = rawTimetracking as Record<string, unknown>;
    if (typeof tt.originalEstimate === 'string' && tt.originalEstimate.trim()) {
      timetracking.originalEstimate = tt.originalEstimate.trim();
    }
    if (typeof tt.remainingEstimate === 'string' && tt.remainingEstimate.trim()) {
      timetracking.remainingEstimate = tt.remainingEstimate.trim();
    }
  }

  // 2. 초 단위 필드를 timetracking 으로 접는다 (이미 값이 있으면 그쪽을 유지)
  for (const [fieldId, key] of Object.entries(SECONDS_FIELD_TO_TIMETRACKING)) {
    const value = out[fieldId];
    delete out[fieldId];

    if (timetracking[key] !== undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      timetracking[key] = formatJiraDuration(value);
    } else if (typeof value === 'string' && value.trim()) {
      timetracking[key] = value.trim();
    }
  }

  // 3. 계산 전용 필드 제거
  for (const fieldId of READ_ONLY_FIELDS) {
    delete out[fieldId];
  }

  // 4. timetracking 반영
  if (Object.keys(timetracking).length > 0) {
    out.timetracking = timetracking;
  } else {
    delete out.timetracking;
  }

  return out;
}
