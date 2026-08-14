// 티켓 연결 판정 (결정 1: 새 연결 테이블 없이 현재 규칙을 그대로 쓴다)
//
//  - 같은 Atlassian 사이트  : `Blocks` 이슈 링크
//      소스에서는 outwardIssue, 대상에서는 inwardIssue 로 **같은 링크가 양쪽에 보인다.**
//      (BEDEV1-531 ↔ KQ-18184 의 링크 id 55023 으로 실측 확인)
//  - 다른 Atlassian 사이트  : 소스 티켓의 link_field(기본 customfield_10438) 에 담긴 URL
//      HMG 쪽에는 역참조가 없으므로 소스의 링크 집합과 차집합을 내야 한다.
//
// DB/네트워크에 의존하지 않는 순수 함수만 둔다. (scripts/verify-comparator.ts 로 단위 검증)

import type { JiraIssue } from '@/lib/types/jira';
import { IGNITE_CUSTOM_FIELDS } from '@/lib/constants/jira';

/** 연결에 사용하는 이슈 링크 타입 */
export const LINK_TYPE_BLOCKS = 'Blocks';

/**
 * 같은 사이트: 소스 티켓의 Blocks outward 링크에서 대상 프로젝트 키 추출
 * (기존 IgniteSyncService.findLinkedTickets 와 같은 규칙)
 */
export function findBlocksOutwardKeys(
  ticket: JiraIssue,
  targetProjectKey: string
): string[] {
  const links = ticket.fields.issuelinks;
  if (!Array.isArray(links)) return [];

  const prefix = `${targetProjectKey}-`;
  const keys: string[] = [];

  for (const link of links) {
    if (link?.type?.name === LINK_TYPE_BLOCKS && link.outwardIssue?.key?.startsWith(prefix)) {
      keys.push(link.outwardIssue.key);
    }
  }

  return keys;
}

/**
 * 같은 사이트: 대상 티켓의 Blocks inward 링크에서 소스 프로젝트 키 추출
 *
 * 2단계에서 실측 확인: 같은 링크(id 55023)가 BEDEV1 쪽에서는 outwardIssue,
 * KQ 쪽에서는 inwardIssue 로 보인다. 그래서 추가 호출 없이 역방향 판정이 된다.
 */
export function findLinkedSourceKeys(
  ticket: JiraIssue,
  sourceProjectKey: string
): string[] {
  const links = ticket.fields.issuelinks;
  if (!Array.isArray(links)) return [];

  const prefix = `${sourceProjectKey}-`;
  const keys: string[] = [];

  for (const link of links) {
    if (link?.type?.name === LINK_TYPE_BLOCKS && link.inwardIssue?.key?.startsWith(prefix)) {
      keys.push(link.inwardIssue.key);
    }
  }

  return keys;
}

/**
 * 다른 사이트: link field 값에서 대상 티켓 키 추출
 * 값이 문자열/배열/{value} 어느 형태로 와도 견디도록 한다 (HMGSyncService 와 같은 방어 로직)
 */
export function extractLinkFieldKeys(
  ticket: JiraIssue,
  profile: { linkField: string | null; targetProjectKey: string }
): string[] {
  const fieldId = profile.linkField || IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK;
  const raw = ticket.fields[fieldId];

  const text =
    typeof raw === 'string'
      ? raw.trim()
      : Array.isArray(raw)
        ? raw[0]
          ? String(raw[0]).trim()
          : ''
        : raw && typeof raw === 'object' && 'value' in raw
          ? String((raw as { value?: unknown }).value ?? '').trim()
          : '';

  if (!text) return [];

  const matches = text.match(new RegExp(`${profile.targetProjectKey}-\\d+`, 'g'));
  return matches ? Array.from(new Set(matches)) : [];
}
