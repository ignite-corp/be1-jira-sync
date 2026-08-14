// BEDEV1(소스) 티켓의 프로젝트 구분 라벨
//
// BEDEV1 은 모든 프로젝트의 중앙 관리처라, 티켓이 **어느 프로젝트 것인지를 라벨로** 구분한다.
//   BEDEV1-529 → 라벨 KQ
//   BEDEV1-523 → 라벨 AUTOWAY
//
// 라벨 값은 DB 에 등록된 프로젝트 이름(projects.name = 프로필의 targetProjectKey)을 쓴다.
// 하드코딩하지 않는다.
//
// 이 규칙은 기존 동기화에도 이미 있었다 (sync-orchestrator 의 HMG 대상 판정에서
// labels.includes(targetKey) 를 본다). 양방향에서는 아래 두 곳에 쓴다.
//   - 계획: "BEDEV1 에만 있음 → 대상에 생성" 후보를 해당 라벨이 붙은 것으로 한정
//   - 생성: "대상 → BEDEV1" 로 만들 때 새 BEDEV1 티켓에 라벨을 붙임

/** 티켓 fields.labels 에서 문자열 배열만 안전하게 꺼낸다 */
function readLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels.filter((l): l is string => typeof l === 'string');
}

/**
 * 이 티켓이 해당 프로젝트의 것인지 라벨로 판정한다.
 * Jira 라벨은 대소문자를 구분해 저장되지만, 운영 중 섞여 들어올 수 있어 대소문자 무시로 비교한다.
 */
export function hasProjectLabel(labels: unknown, projectKey: string): boolean {
  const target = projectKey.trim().toLowerCase();
  if (!target) return false;
  return readLabels(labels).some((l) => l.trim().toLowerCase() === target);
}

/**
 * 기존 라벨을 유지한 채 프로젝트 라벨을 추가한다.
 * 이미 있으면 그대로 둔다(중복 추가 방지).
 */
export function withProjectLabel(labels: unknown, projectKey: string): string[] {
  const existing = readLabels(labels);
  const key = projectKey.trim();
  if (!key) return existing;
  if (hasProjectLabel(existing, key)) return existing;
  return [...existing, key];
}
