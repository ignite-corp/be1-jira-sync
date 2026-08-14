// 필드 매핑 및 변환 로직

import { JiraIssue } from '@/lib/types/jira';
import {
  STATUS_MAPPING,
  IGNITE_CUSTOM_FIELDS,
  HMG_CUSTOM_FIELDS,
  JIRA_ENDPOINTS,
} from '@/lib/constants/jira';
import { SyncTargetProject, SyncOptions } from './types';
import { mapSprintToTarget } from './sprint-mapper';

/**
 * FEHG 티켓 필드를 대상 프로젝트용으로 변환
 */
export async function mapFieldsForIgniteProject(
  fehgTicket: JiraIssue,
  targetProject: 'KQ' | 'HDD' | 'HB'
): Promise<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};
  const fehgFields = fehgTicket.fields;

  // summary
  fields.summary = fehgTicket.fields.summary;

  // duedate
  if (fehgFields.duedate) {
    fields.duedate = fehgFields.duedate;
  }

  // 시작일 (customfield_10015)
  if (fehgFields[IGNITE_CUSTOM_FIELDS.START_DATE]) {
    fields[IGNITE_CUSTOM_FIELDS.START_DATE] =
      fehgFields[IGNITE_CUSTOM_FIELDS.START_DATE];
  }

  // assignee (그대로 복사 - Ignite 내부라서 accountId 동일)
  if (fehgTicket.fields.assignee) {
    fields.assignee = {
      accountId: fehgTicket.fields.assignee.accountId,
    };
  }

  // timetracking (그대로 복사)
  if (fehgFields.timetracking) {
    fields.timetracking = fehgFields.timetracking;
  }

  // 스프린트 매핑
  const fehgSprint = fehgFields[IGNITE_CUSTOM_FIELDS.SPRINT] as
    | Array<{ id: number; name: string }>
    | undefined;

  if (fehgSprint && fehgSprint.length > 0) {
    const fehgSprintName = fehgSprint[0].name;
    const mappedSprintId = await mapSprintToTarget(
      fehgSprintName,
      targetProject
    );

    if (mappedSprintId) {
      fields[IGNITE_CUSTOM_FIELDS.SPRINT] = { id: mappedSprintId };
    }
  }

  return fields;
}

/**
 * FEHG 티켓 필드를 AUTOWAY용으로 변환
 */
export function mapFieldsForAutoway(
  fehgTicket: JiraIssue,
  assigneeAccountId: string,
  teamUsers?: SyncOptions['teamUsers']
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const fehgFields = fehgTicket.fields;

  // summary (prefix 없이 그대로)
  fields.summary = fehgTicket.fields.summary;

  // description (Atlassian Document Format)
  const fehgUrl = `${JIRA_ENDPOINTS.IGNITE}/browse/${fehgTicket.key}`;
  fields.description = {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [
          {
            type: 'text',
            text: '자동 생성된 FEHG 티켓 연동 (원본: ',
          },
          {
            type: 'text',
            text: fehgTicket.key,
            marks: [
              {
                type: 'link',
                attrs: {
                  href: fehgUrl,
                },
              },
            ],
          },
          {
            type: 'text',
            text: ')',
          },
        ],
      },
    ],
  };

  // 종료일 매핑 (Gantt End Date)
  if (fehgFields.duedate) {
    fields.duedate = fehgFields.duedate;
    fields[HMG_CUSTOM_FIELDS.GANTT_END_DATE] = fehgFields.duedate; // Gantt End Date
  }

  // 시작일 매핑 (Start Date x3, Gantt Start Date)
  if (fehgFields[IGNITE_CUSTOM_FIELDS.START_DATE]) {
    const startDate = fehgFields[IGNITE_CUSTOM_FIELDS.START_DATE];
    fields[HMG_CUSTOM_FIELDS.START_DATE] = startDate; // Start Date (customfield_10187)
    fields[HMG_CUSTOM_FIELDS.START_DATE_ALT] = startDate; // Start Date (customfield_10753)
    fields[HMG_CUSTOM_FIELDS.START_DATE_590] = startDate; // Start Date (customfield_10590)
    fields[HMG_CUSTOM_FIELDS.GANTT_START_DATE] = startDate; // Gantt Start Date (customfield_10995)
  }

  // assignee 매핑 (Ignite accountId → HMG accountId)
  const userInfo = teamUsers?.find(
    (user) => user.igniteAccountId === assigneeAccountId
  );

  if (userInfo) {
    fields.assignee = { accountId: userInfo.hmgAccountId };
    fields.reporter = { accountId: userInfo.hmgAccountId };
  }

  // timetracking (HMG에도 반영: estimate 계열만)
  // - timeSpent는 Jira에서 worklog로만 관리되는 값이라 필드 업데이트로는 일반적으로 설정 불가
  if (fehgFields.timetracking) {
    const tt = fehgFields.timetracking as {
      originalEstimate?: string;
      remainingEstimate?: string;
      timeSpent?: string;
    };

    const timetracking: Record<string, string> = {};
    if (tt.originalEstimate)
      timetracking.originalEstimate = tt.originalEstimate;
    if (tt.remainingEstimate)
      timetracking.remainingEstimate = tt.remainingEstimate;

    if (Object.keys(timetracking).length > 0) {
      fields.timetracking = timetracking;
    }
  }

  // 스프린트는 AUTOWAY에서 제외

  return fields;
}

/**
 * FEHG 상태 ID를 대상 프로젝트의 transition ID로 변환
 */
export function mapStatusTransition(
  fehgStatusId: string,
  targetProject: SyncTargetProject
): string | null {
  if (targetProject === 'AUTOWAY') {
    return (
      STATUS_MAPPING.HMG[fehgStatusId as keyof typeof STATUS_MAPPING.HMG] ||
      null
    );
  } else {
    return (
      STATUS_MAPPING.IGNITE[
        fehgStatusId as keyof typeof STATUS_MAPPING.IGNITE
      ] || null
    );
  }
}

/**
 * customfield_10438에서 AUTOWAY 티켓 키 추출
 * URL: "https://hmg.atlassian.net/browse/AUTOWAY-123" → "AUTOWAY-123"
 *
 * 참고: 구 HMG URL은 사전에 마이그레이션되어 모두 신 URL로 변환됨
 */
export function extractAutowayKey(url: string): string | null {
  if (!url) return null;

  // URL에서 티켓 키 추출 (AUTOWAY-숫자 패턴)
  const match = url.match(/AUTOWAY-(\d+)/);
  return match ? `AUTOWAY-${match[1]}` : null;
}

/**
 * customfield_10438이 유효한 AUTOWAY URL인지 확인
 */
export function isValidAutowayLink(url: string | null | undefined): boolean {
  if (!url) return false;
  // AUTOWAY-숫자 패턴이 있으면 유효
  return /AUTOWAY-\d+/.test(url);
}

/**
 * 청크 분할 유틸리티
 */
export function chunkArray<T>(array: T[], chunkSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}
