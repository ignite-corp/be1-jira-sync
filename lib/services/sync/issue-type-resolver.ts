// 티켓 생성 시 사용할 이슈 타입 결정
//
// 주의: Jira 의 /project/{key} 응답에서 issueTypes 배열 순서는 프로젝트마다 제각각이다.
// 실측 (2026-08):
//   KQ     : [버그, Ask, 개선, Design Issues, 작업, 스토리, 하위작업, 에픽, 운영업무, 기획, 개발처리]
//   BEDEV1 : [작업, 버그, 스토리, 에픽, 하위작업]
//   HB     : [작업, 하위작업, 스토리, 버그, 에픽, Design Issue]
//
// 그래서 "프로젝트 목록을 훑으며 선호 이름에 들어있는 첫 항목" 을 고르면
// KQ 에서는 버그가 뽑힌다. 반드시 **선호 순서 기준**으로 찾아야 한다.

import { CREATE_ISSUE_TYPE_MAP, CREATE_ISSUE_TYPE_PREFERENCE } from '@/lib/constants/jira';

export interface JiraIssueTypeOption {
  id: string;
  name: string;
  subtask?: boolean;
  hierarchyLevel?: number;
}

export interface ChosenIssueType {
  id: string;
  name: string;
  /** 어떻게 골랐는지 (로그용) */
  reason: 'configured' | 'preference';
}

/**
 * 생성 가능한 이슈 타입만 남긴다.
 * - 하위 작업: 부모가 필요하므로 제외
 * - 에픽(hierarchyLevel >= 1): 일반 티켓 생성에 쓰면 안 되므로 제외
 */
function selectableTypes(issueTypes: JiraIssueTypeOption[]): JiraIssueTypeOption[] {
  return issueTypes.filter((t) => {
    if (t.subtask) return false;
    if (typeof t.hierarchyLevel === 'number' && t.hierarchyLevel !== 0) return false;
    // hierarchyLevel 이 없는 응답을 대비한 이름 기반 방어
    if (t.name === '에픽' || t.name === 'Epic') return false;
    return true;
  });
}

/**
 * 대상 프로젝트에서 생성에 쓸 이슈 타입을 고른다.
 *
 * 우선순위
 *   1. CREATE_ISSUE_TYPE_MAP 에 프로젝트별로 지정된 이름 (예: KQ → 개발처리)
 *   2. CREATE_ISSUE_TYPE_PREFERENCE 의 **선호 순서**대로 매칭 (작업 → 개발처리 → Dev Task)
 *
 * 둘 다 실패하면 **null 을 돌려준다.** 임의의 타입을 고르지 않는다.
 * 아무거나 고르면 KQ-18190 처럼 엉뚱한 타입(버그)으로 티켓이 만들어진다.
 */
export function chooseCreateIssueType(
  projectKey: string,
  issueTypes: JiraIssueTypeOption[]
): ChosenIssueType | null {
  const candidates = selectableTypes(issueTypes);
  if (candidates.length === 0) return null;

  // 1. 프로젝트별 지정 타입
  const configuredName = CREATE_ISSUE_TYPE_MAP[projectKey];
  if (configuredName) {
    const configured = candidates.find((t) => t.name === configuredName);
    if (configured) {
      return { id: configured.id, name: configured.name, reason: 'configured' };
    }
    // 지정했는데 없으면 아래 우선순위로 내려간다 (호출부에서 경고를 남긴다)
  }

  // 2. 선호 순서대로 (프로젝트 응답 순서가 아니라 이 배열 순서를 따른다)
  for (const preferredName of CREATE_ISSUE_TYPE_PREFERENCE) {
    const match = candidates.find((t) => t.name === preferredName);
    if (match) {
      return { id: match.id, name: match.name, reason: 'preference' };
    }
  }

  // 임의로 고르지 않는다. 호출부가 명확한 오류를 내도록 null 을 돌려준다.
  return null;
}

/** 프로젝트에 지정된 이슈 타입 이름이 있는지 (경고 로그 판단용) */
export function getConfiguredIssueTypeName(projectKey: string): string | undefined {
  return CREATE_ISSUE_TYPE_MAP[projectKey];
}
