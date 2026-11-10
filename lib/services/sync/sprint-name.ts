// 스프린트 이름/연월 계산 (순수 함수만 - DB·Jira 호출 없음)
//
// 비교·정규화 쪽에서도 쓰므로 db 의존이 있는 sprint-mapper 와 분리해 둔다.
// 스프린트 이름 규칙은 `<접두사> YYYYMM` (예: "BEDEV1 202611", 구형 "FEHG 2511").

/** 스프린트 이름 끝의 기간 숫자 추출. 예: "FEHG 2511" → "2511" */
export function extractSprintPeriod(sprintName: string): string | null {
  const match = sprintName.match(/(?<=\s)(\d+)\s*$/);
  return match ? match[1] : null;
}

/** 기간을 전체 연월 형식으로 변환. 예: "2511" → "202511" */
export function convertToFullYearMonth(period: string): string {
  if (period.length === 4) {
    return '20' + period;
  }
  return period;
}

/**
 * 스프린트 이름에서 연월(YYYYMM)을 뽑는다.
 * 예: "BEDEV1 202611" → "202611", "FEHG 2511" → "202511"
 */
export function sprintYearMonthOf(sprintName: string | null | undefined): string | null {
  if (!sprintName) return null;
  const period = extractSprintPeriod(sprintName);
  return period ? convertToFullYearMonth(period) : null;
}

/**
 * 날짜를 스프린트 이름에 쓰는 연월 형식(YYYYMM)으로 변환
 * 예: 2026-08-13 → "202608"
 */
export function formatYearMonth(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}${month}`;
}

/** 연월(YYYYMM)에 개월 수를 더한다. 예: addMonths("202611", 2) → "202701" */
export function addMonths(yearMonth: string, delta: number): string {
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(4, 6));
  return formatYearMonth(new Date(year, month - 1 + delta, 1));
}

/**
 * 비교 대상으로 고를 수 있는 연월 목록 (현재 월 + 미래 N개월).
 * 지난 스프린트는 고를 수 없다 - 이미 끝난 스프린트를 동기화할 일은 없다.
 */
export function selectableYearMonths(futureCount = 6, now: Date = new Date()): string[] {
  const base = formatYearMonth(now);
  return Array.from({ length: futureCount + 1 }, (_, i) => addMonths(base, i));
}

/** 스프린트 배열에서 하나를 고를 때 쓰는 최소 형태 */
interface SprintLike {
  name?: string;
  state?: string;
}

/**
 * 스프린트 배열에서 기준 스프린트 하나를 고른다.
 *
 * 티켓은 여러 스프린트에 속할 수 있고 배열 순서는 보장되지 않는다.
 * (예: BEDEV1-176 = [202608(closed), 202609(active), 202606(closed)])
 *
 * 고르는 순서는 **비교 범위 안의 연월 → active → 첫 번째** 다.
 *  - 비교 범위(여러 달)를 주면 그 안의 스프린트만 후보가 되고,
 *    후보가 여럿이면 active 를, 없으면 가장 이른 달을 쓴다.
 *  - 범위를 주지 않거나 범위 안에 없으면 예전 규칙(active 우선)으로 떨어진다.
 *
 * 매핑(pickSprint)과 비교(canonicalizeSprint)가 **반드시 같은 규칙**을 써야 해서
 * 여기 한 곳에 모아 둔다. (규칙이 다르면 매퍼가 쓰지 않는 값을 보고 거짓 diff 가 난다)
 */
export function pickScopedSprint<T extends SprintLike>(
  sprints: readonly T[],
  yearMonths?: readonly string[] | null
): T | null {
  if (sprints.length === 0) return null;

  if (yearMonths && yearMonths.length > 0) {
    const scope = new Set(yearMonths);
    const scoped = sprints.filter((s) => {
      const ym = sprintYearMonthOf(s?.name);
      return ym !== null && scope.has(ym);
    });

    if (scoped.length > 0) {
      const active = scoped.find((s) => s?.state === 'active');
      if (active) return active;
      return [...scoped].sort((a, b) =>
        (sprintYearMonthOf(a?.name) ?? '').localeCompare(sprintYearMonthOf(b?.name) ?? '')
      )[0];
    }
  }

  const active = sprints.find((s) => s?.state === 'active');
  return active ?? sprints[0];
}
