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
