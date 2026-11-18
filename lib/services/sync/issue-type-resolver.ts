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
//
// 또 하나: 소스 티켓의 **계층(일반/하위작업/에픽)** 은 반드시 보존해야 한다.
// 하위 작업을 일반 작업으로, 에픽을 작업으로 만들면 부모-자식 구조가 통째로 깨진다.
// 그래서 타입 선택은 "소스가 무엇인가(IssueKind)" 를 먼저 보고 그 계층 안에서만 고른다.

import {
  CREATE_EPIC_TYPE_PREFERENCE,
  CREATE_ISSUE_TYPE_MAP,
  CREATE_ISSUE_TYPE_PREFERENCE,
  CREATE_SUBTASK_TYPE_MAP,
  CREATE_SUBTASK_TYPE_PREFERENCE,
} from '@/lib/constants/jira';

export interface JiraIssueTypeOption {
  id: string;
  name: string;
  subtask?: boolean;
  hierarchyLevel?: number;
}

/** 소스 티켓의 계층 */
export type IssueKind = 'standard' | 'subtask' | 'epic';

export interface ChosenIssueType {
  id: string;
  name: string;
  /** 어떻게 골랐는지 (로그용) */
  reason: 'configured' | 'preference' | 'only';
}

/** 이름만으로 하위 작업/에픽을 알아보기 위한 방어용 목록 (hierarchyLevel 이 없는 응답 대비) */
const SUBTASK_TYPE_NAMES = [...CREATE_SUBTASK_TYPE_PREFERENCE] as string[];
const EPIC_TYPE_NAMES = [...CREATE_EPIC_TYPE_PREFERENCE] as string[];

/**
 * 티켓의 이슈 타입이 어느 계층인지 판정한다.
 * subtask 플래그 → hierarchyLevel → 이름 순으로 본다.
 */
export function classifyIssueKind(
  issuetype:
    | { name?: string; subtask?: boolean; hierarchyLevel?: number }
    | null
    | undefined
): IssueKind {
  if (!issuetype) return 'standard';

  if (issuetype.subtask === true) return 'subtask';
  if (typeof issuetype.hierarchyLevel === 'number') {
    if (issuetype.hierarchyLevel < 0) return 'subtask';
    if (issuetype.hierarchyLevel >= 1) return 'epic';
  }

  const name = issuetype.name?.trim();
  if (name) {
    if (SUBTASK_TYPE_NAMES.includes(name)) return 'subtask';
    if (EPIC_TYPE_NAMES.includes(name)) return 'epic';
  }
  return 'standard';
}

function isSubtaskType(t: JiraIssueTypeOption): boolean {
  if (t.subtask === true) return true;
  if (typeof t.hierarchyLevel === 'number') return t.hierarchyLevel < 0;
  return SUBTASK_TYPE_NAMES.includes(t.name);
}

function isEpicType(t: JiraIssueTypeOption): boolean {
  if (t.subtask === true) return false;
  if (typeof t.hierarchyLevel === 'number') return t.hierarchyLevel >= 1;
  return EPIC_TYPE_NAMES.includes(t.name);
}

/**
 * 일반 티켓 생성에 쓸 수 있는 타입만 남긴다.
 * - 하위 작업: 부모가 필요하므로 제외
 * - 에픽(hierarchyLevel >= 1): 일반 티켓 생성에 쓰면 안 되므로 제외
 */
function selectableTypes(issueTypes: JiraIssueTypeOption[]): JiraIssueTypeOption[] {
  return issueTypes.filter((t) => !isSubtaskType(t) && !isEpicType(t));
}

/** 계층별 후보 + 지정 이름 + 선호 순서 */
function rulesFor(kind: IssueKind, projectKey: string) {
  switch (kind) {
    case 'subtask':
      return {
        candidates: isSubtaskType,
        configuredName: CREATE_SUBTASK_TYPE_MAP[projectKey],
        preference: CREATE_SUBTASK_TYPE_PREFERENCE as readonly string[],
        /** 후보가 하나뿐이면 그걸 쓴다 (대부분의 프로젝트에 하위 작업 타입은 하나다) */
        allowOnlyCandidate: true,
      };
    case 'epic':
      return {
        candidates: isEpicType,
        configuredName: undefined,
        preference: CREATE_EPIC_TYPE_PREFERENCE as readonly string[],
        allowOnlyCandidate: true,
      };
    default:
      return {
        candidates: null,
        configuredName: CREATE_ISSUE_TYPE_MAP[projectKey],
        preference: CREATE_ISSUE_TYPE_PREFERENCE as readonly string[],
        // 일반 티켓은 후보가 여럿이라 임의로 고르면 버그/스토리가 잡힌다 - 고르지 않는다
        allowOnlyCandidate: false,
      };
  }
}

/**
 * 대상 프로젝트에서 생성에 쓸 이슈 타입을 고른다.
 *
 * 먼저 **소스와 같은 계층**(일반/하위작업/에픽)으로 후보를 좁히고, 그 안에서
 *   1. 프로젝트별로 지정된 이름 (예: KQ → 개발처리, MEMBERSHIP 하위작업 → Dev Sub-task)
 *   2. 선호 순서대로 매칭
 *   3. (하위작업/에픽만) 후보가 하나뿐이면 그것
 *
 * 다 실패하면 **null 을 돌려준다.** 임의의 타입을 고르지 않는다.
 * 아무거나 고르면 KQ-18190 처럼 엉뚱한 타입(버그)으로 티켓이 만들어진다.
 */
export function chooseCreateIssueType(
  projectKey: string,
  issueTypes: JiraIssueTypeOption[],
  kind: IssueKind = 'standard'
): ChosenIssueType | null {
  const rules = rulesFor(kind, projectKey);
  const candidates = rules.candidates
    ? issueTypes.filter(rules.candidates)
    : selectableTypes(issueTypes);
  if (candidates.length === 0) return null;

  // 1. 프로젝트별 지정 타입
  if (rules.configuredName) {
    const configured = candidates.find((t) => t.name === rules.configuredName);
    if (configured) {
      return { id: configured.id, name: configured.name, reason: 'configured' };
    }
    // 지정했는데 없으면 아래 우선순위로 내려간다 (호출부에서 경고를 남긴다)
  }

  // 2. 선호 순서대로 (프로젝트 응답 순서가 아니라 이 배열 순서를 따른다)
  for (const preferredName of rules.preference) {
    const match = candidates.find((t) => t.name === preferredName);
    if (match) {
      return { id: match.id, name: match.name, reason: 'preference' };
    }
  }

  // 3. 하위작업/에픽은 계층으로 이미 좁혀졌으니 하나뿐이면 그걸 쓴다
  if (rules.allowOnlyCandidate && candidates.length === 1) {
    return { id: candidates[0].id, name: candidates[0].name, reason: 'only' };
  }

  // 임의로 고르지 않는다. 호출부가 명확한 오류를 내도록 null 을 돌려준다.
  return null;
}

/** 프로젝트에 지정된 이슈 타입 이름이 있는지 (경고 로그 판단용) */
export function getConfiguredIssueTypeName(
  projectKey: string,
  kind: IssueKind = 'standard'
): string | undefined {
  return kind === 'subtask'
    ? CREATE_SUBTASK_TYPE_MAP[projectKey]
    : kind === 'epic'
      ? undefined
      : CREATE_ISSUE_TYPE_MAP[projectKey];
}
