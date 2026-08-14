// HMG Jira 프로젝트 동기화 (FEHG → AUTOWAY)

import { JiraIssue, JiraIssueCreatePayload } from '@/lib/types/jira';
import { SyncResult } from './types';
import { SyncLogger } from './logger';
import { mapFieldsForAutoway } from './field-mapper';
import { mapFieldsFromDb, getSyncProfileInfo } from './db-field-mapper';
import { migrateAttachments } from './attachment-migrator';
import { SyncOptions } from './types';
import { getTargetStatusId, getTargetStatusIdFromProfile } from './transition-helper';
import { jira } from '@/lib/services/jira';
import { IGNITE_CUSTOM_FIELDS, JIRA_ENDPOINTS } from '@/lib/constants/jira';
import { chooseCreateIssueType } from './issue-type-resolver';

/**
 * AUTOWAY 이슈 생성 시 사용할 issuetype 캐시
 * - HMG Jira에서 프로젝트별로 허용되는 이슈 타입(이름/로캘)이 다를 수 있어 name 하드코딩이 깨질 수 있음
 * - 가능하면 issuetype "id"로 생성하도록 함
 */
let autowayCreateIssueTypeIdCache: string | null = null;

/**
 * HMG 프로젝트 동기화 서비스
 * FEHG → AUTOWAY 동기화 담당
 */
export class HMGSyncService {
  constructor(private logger: SyncLogger) {}

  private async resolveCreateIssueType(targetProjectKey: string): Promise<
    { id: string } | { name: string }
  > {
    // 이미 한번 찾았으면 재사용
    if (autowayCreateIssueTypeIdCache) {
      return { id: autowayCreateIssueTypeIdCache };
    }

    try {
      const projectResult = await jira.hmg.getProject(targetProjectKey);
      const projectData = projectResult.success ? projectResult.data : null;

      // Jira /project/{key} 응답에는 issueTypes가 포함됨(타입 정의엔 빠져있어서 any 캐스팅)
      const issueTypes = (projectData as unknown as { issueTypes?: unknown })
        ?.issueTypes as Array<{
        id: string;
        name: string;
        subtask?: boolean;
      }> | null;

      if (!issueTypes || issueTypes.length === 0) {
        this.logger.warning(
          `${targetProjectKey}: 프로젝트 issueTypes 조회 실패(비어있음) → issuetype name으로 fallback`
        );
        return { name: '작업' };
      }

      // 프로젝트 응답 순서가 아니라 선호 순서로 고른다.
      // (예전에는 응답 순서를 훑어서, "버그" 가 맨 앞인 프로젝트에서 버그 티켓이 생성됐다)
      const chosen = chooseCreateIssueType(targetProjectKey, issueTypes);
      if (!chosen) {
        this.logger.warning(
          `${targetProjectKey}: 생성 가능한 이슈 타입이 없음 → issuetype name으로 fallback`
        );
        return { name: '작업' };
      }

      autowayCreateIssueTypeIdCache = chosen.id;
      this.logger.info(
        `${targetProjectKey}: issuetype 선택 → "${chosen.name}" (id=${chosen.id}, 근거=${chosen.reason})`
      );
      return { id: chosen.id };
    } catch (e) {
      this.logger.warning(
        `${targetProjectKey}: issuetype 조회 중 예외 → name fallback ("작업") - ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      return { name: '작업' };
    }
  }

  /**
   * FEHG 티켓을 AUTOWAY로 동기화
   */
  async syncTicket(
    fehgTicket: JiraIssue,
    assigneeAccountId: string,
    teamUsers?: SyncOptions['teamUsers'],
    syncProfileId?: string
  ): Promise<SyncResult | null> {
    try {
      // DB 기반: 프로필에서 link_field와 target project 조회
      const profileInfo = syncProfileId ? await getSyncProfileInfo(syncProfileId) : null;
      const linkFieldId = profileInfo?.linkField || IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK;
      const targetProjectKey = profileInfo?.targetProjectKey || 'AUTOWAY';

      const customFields = fehgTicket.fields;
      const rawLink = customFields[linkFieldId];
      const hmgLinkField =
        typeof rawLink === 'string'
          ? rawLink.trim()
          : Array.isArray(rawLink)
            ? rawLink[0]
              ? String(rawLink[0]).trim()
              : ''
            : rawLink && typeof rawLink === 'object' && 'value' in rawLink
              ? String((rawLink as { value?: unknown }).value ?? '').trim()
              : '';

      if (hmgLinkField) {
        this.logger.info(
          `${fehgTicket.key}: ${linkFieldId} 감지됨 → ${hmgLinkField}`
        );
      } else {
        this.logger.info(
          `${fehgTicket.key}: ${linkFieldId} 비어 있음 → 신규 생성`
        );
      }

      // link field 확인 및 분기
      const targetKeyPattern = new RegExp(`${targetProjectKey}-\\d+`);
      if (!hmgLinkField || !targetKeyPattern.test(hmgLinkField)) {
        return await this.createAndLinkAutowayTicket(
          fehgTicket,
          assigneeAccountId,
          teamUsers,
          syncProfileId,
          profileInfo
        );
      }

      // 기존 티켓 업데이트 플로우
      const match = hmgLinkField.match(new RegExp(`(${targetProjectKey}-\\d+)`));
      const targetKey = match ? match[1] : null;
      if (!targetKey) {
        this.logger.warning(
          `${fehgTicket.key}: ${targetProjectKey} 키 추출 실패 (${hmgLinkField}) - 신규 생성`
        );
        return await this.createAndLinkAutowayTicket(
          fehgTicket,
          assigneeAccountId,
          teamUsers,
          syncProfileId,
          profileInfo
        );
      }

      return await this.updateAutowayTicket(
        fehgTicket,
        targetKey,
        assigneeAccountId,
        teamUsers,
        syncProfileId,
        profileInfo
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `${fehgTicket.key}: AUTOWAY 동기화 실패 - ${errorMessage}`
      );
      return null;
    }
  }

  /**
   * AUTOWAY 티켓 신규 생성 및 FEHG에 링크
   */
  private async createAndLinkAutowayTicket(
    fehgTicket: JiraIssue,
    assigneeAccountId: string,
    teamUsers?: SyncOptions['teamUsers'],
    syncProfileId?: string,
    profileInfo?: { linkField: string | null; targetProjectKey: string; targetInstance: string } | null
  ): Promise<SyncResult> {
    const targetProjectKey = profileInfo?.targetProjectKey || 'AUTOWAY';
    const linkFieldId = profileInfo?.linkField || IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK;

    try {
      this.logger.info(`${fehgTicket.key}: ${targetProjectKey} 티켓 생성 시작...${syncProfileId ? ' (DB 매핑)' : ''}`);

      // 1. 필드 매핑 (DB 기반 또는 하드코딩)
      const mappedFields = syncProfileId
        ? await mapFieldsFromDb(fehgTicket, syncProfileId, targetProjectKey)
        : mapFieldsForAutoway(fehgTicket, assigneeAccountId, teamUsers);

      const autowayIssueType = await this.resolveCreateIssueType(targetProjectKey);

      // 2. 티켓 생성
      const createPayload: JiraIssueCreatePayload = {
        fields: {
          project: { key: targetProjectKey },
          issuetype: autowayIssueType,
          summary: fehgTicket.fields.summary,
          ...mappedFields,
        },
      };

      const createResult = await jira.hmg.createIssue(createPayload);

      if (!createResult.success || !createResult.data) {
        const errorDetails = (
          createResult as { details?: unknown; error?: string }
        ).details;
        if (errorDetails) {
          this.logger.error(
            `${fehgTicket.key}: Jira API 에러 상세 → ${JSON.stringify(errorDetails)}`
          );
        }
        throw new Error(createResult.error || `${targetProjectKey} 티켓 생성 실패`);
      }

      const createdKey = createResult.data.key;
      this.logger.success(`${createdKey}: ${targetProjectKey} 티켓 생성 완료`);

      // 3. FEHG 티켓의 link field에 URL 저장
      const targetUrl = `${JIRA_ENDPOINTS.HMG}/browse/${createdKey}`;
      const linkResult = await jira.ignite.updateIssueFields(fehgTicket.key, {
        [linkFieldId]: targetUrl,
      });

      if (!linkResult.success) {
        this.logger.warning(
          `${fehgTicket.key}: ${targetProjectKey} 링크 저장 실패 (티켓은 생성됨)`
        );
      } else {
        this.logger.success(`${fehgTicket.key}: ${targetProjectKey} 링크 저장 완료`);
      }

      // 4. 상태 동기화
      await this.syncAutowayStatus(fehgTicket, createdKey, syncProfileId);

      // 5. 첨부파일 / 인라인 스크린샷 동기화
      await this.migrateTicketAttachments(fehgTicket, createdKey, syncProfileId);

      return {
        fehgKey: fehgTicket.key,
        targetKey: createdKey,
        targetProject: 'AUTOWAY',
        success: true,
        message: '신규 생성 및 동기화 완료',
        isNewlyCreated: true,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(
        `${fehgTicket.key}: ${targetProjectKey} 생성 실패 - ${errorMessage}`
      );

      return {
        fehgKey: fehgTicket.key,
        targetKey: '',
        targetProject: 'AUTOWAY',
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 기존 AUTOWAY 티켓 업데이트
   */
  private async updateAutowayTicket(
    fehgTicket: JiraIssue,
    targetKey: string,
    assigneeAccountId: string,
    teamUsers?: SyncOptions['teamUsers'],
    syncProfileId?: string,
    profileInfo?: { targetProjectKey: string } | null
  ): Promise<SyncResult> {
    const targetProjectKey = profileInfo?.targetProjectKey || 'AUTOWAY';

    try {
      this.logger.info(`${targetKey}: 업데이트 시작...${syncProfileId ? ' (DB 매핑)' : ''}`);

      // 1. 필드 매핑 (DB 기반 또는 하드코딩)
      const mappedFields = syncProfileId
        ? await mapFieldsFromDb(fehgTicket, syncProfileId, targetProjectKey)
        : mapFieldsForAutoway(fehgTicket, assigneeAccountId, teamUsers);

      // 2. 필드 매핑 로그
      this.logger.info(
        `${targetKey}: 업데이트 필드 → ${JSON.stringify(Object.keys(mappedFields))}`
      );

      // 3. 필드 업데이트
      const updateResult = await jira.hmg.updateIssue(targetKey, {
        fields: mappedFields,
      });

      if (!updateResult.success) {
        const errorDetails = (
          updateResult as { details?: unknown; error?: string }
        ).details;
        if (errorDetails) {
          this.logger.error(
            `${targetKey}: Jira API 에러 상세 → ${JSON.stringify(errorDetails)}`
          );
        }
        throw new Error(updateResult.error || '필드 업데이트 실패');
      }

      this.logger.success(`${targetKey}: 필드 업데이트 완료`);

      // 4. 상태 동기화
      await this.syncAutowayStatus(fehgTicket, targetKey, syncProfileId);

      // 5. 첨부파일 / 인라인 스크린샷 동기화
      await this.migrateTicketAttachments(fehgTicket, targetKey, syncProfileId);

      return {
        fehgKey: fehgTicket.key,
        targetKey,
        targetProject: 'AUTOWAY',
        success: true,
        message: '동기화 완료',
        isNewlyCreated: false,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.error(`${targetKey}: 업데이트 실패 - ${errorMessage}`);

      return {
        fehgKey: fehgTicket.key,
        targetKey,
        targetProject: 'AUTOWAY',
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 첨부파일 + 인라인 스크린샷을 HMG 티켓으로 동기화
   * (실패해도 티켓 동기화 전체를 깨지 않도록 예외를 흡수한다)
   */
  private async migrateTicketAttachments(
    fehgTicket: JiraIssue,
    targetKey: string,
    syncProfileId?: string
  ): Promise<void> {
    try {
      await migrateAttachments({
        sourceInstance: 'ignite',
        targetInstance: 'hmg',
        sourceTicket: fehgTicket,
        targetKey,
        logger: this.logger,
        // DB 매핑 경로만 본문이 소스를 미러링 → 인라인 재매핑 허용.
        // 하드코딩 경로는 본문이 "원본 링크"라 본문을 덮어쓰면 안 됨.
        allowDescriptionRemap: !!syncProfileId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warning(`${targetKey}: 첨부 동기화 실패 - ${message}`);
    }
  }

  /**
   * HMG 티켓 상태 동기화 (Jira API에서 available transitions 동적 조회)
   * DB sync_profile_workflows의 transition ID에 의존하지 않으므로
   * AUTOWAY, HMGBOARD 등 프로젝트별 워크플로우 차이를 자동으로 처리
   */
  private async syncAutowayStatus(
    fehgTicket: JiraIssue,
    targetKey: string,
    syncProfileId?: string
  ): Promise<void> {
    const fehgStatusId = fehgTicket.fields.status?.id;
    if (!fehgStatusId) return;

    try {
      // 1. 현재 타겟 티켓의 상태 조회
      const targetIssue = await jira.hmg.getIssue(targetKey);
      if (!targetIssue.success || !targetIssue.data) {
        this.logger.warning(`${targetKey}: 상태 조회 실패 - 상태 동기화 스킵`);
        return;
      }

      const currentStatusId = targetIssue.data.fields.status?.id;
      if (!currentStatusId) {
        this.logger.warning(`${targetKey}: 현재 상태 ID 없음 - 상태 동기화 스킵`);
        return;
      }

      // 2. 타겟 상태 ID 결정 (DB 우선, 하드코딩 폴백)
      let targetStatusId: string | null = null;
      if (syncProfileId) {
        targetStatusId = await getTargetStatusIdFromProfile(syncProfileId, fehgStatusId);
      }
      if (!targetStatusId) {
        targetStatusId = getTargetStatusId('hmg', fehgStatusId);
      }

      if (!targetStatusId) {
        this.logger.info(`${targetKey}: 상태 매핑 없음 - 상태 동기화 스킵`);
        return;
      }

      if (currentStatusId === targetStatusId) {
        this.logger.info(`${targetKey}: 이미 타겟 상태 (${targetStatusId}) - 스킵`);
        return;
      }

      // 3. Jira API에서 available transitions 동적 조회 → 다단계 전이 지원
      type JiraTransition = { id: string; to?: { id: string } };
      let current = currentStatusId;
      const visited = new Set<string>([current]);

      for (let step = 0; step < 5 && current !== targetStatusId; step++) {
        const transResult = await jira.hmg.getIssueTransitions(targetKey);
        if (!transResult.success) {
          this.logger.warning(`${targetKey}: transitions 조회 실패 - 상태 동기화 스킵`);
          break;
        }

        const transitions =
          (transResult.data as { transitions?: JiraTransition[] })?.transitions ?? [];

        // 목표 상태로 직접 가는 transition 우선 시도
        const direct = transitions.find((t) => t.to?.id === targetStatusId);
        if (direct) {
          const result = await jira.hmg.updateIssueStatus(targetKey, direct.id);
          if (result.success) {
            current = targetStatusId;
          } else {
            this.logger.warning(`${targetKey}: transition 실패 - ${result.error}`);
          }
          break;
        }

        // 직접 전이 없음 → 미방문 중간 상태로 이동 후 재시도
        const intermediate = transitions.find((t) => t.to?.id && !visited.has(t.to.id));
        if (!intermediate) {
          this.logger.warning(
            `${targetKey}: ${current} → ${targetStatusId} 전이 경로 없음 - 상태 동기화 스킵`
          );
          break;
        }

        const result = await jira.hmg.updateIssueStatus(targetKey, intermediate.id);
        if (!result.success) {
          this.logger.warning(`${targetKey}: 중간 transition 실패 - ${result.error}`);
          break;
        }
        current = intermediate.to!.id!;
        visited.add(current);
      }

      if (current === targetStatusId) {
        this.logger.success(`${targetKey}: 상태 동기화 완료 → ${targetStatusId}`);
      } else {
        this.logger.warning(
          `${targetKey}: 상태 동기화 불완전 (현재: ${current}, 목표: ${targetStatusId})`
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      this.logger.warning(
        `${targetKey}: 상태 동기화 실패 (필드는 업데이트됨) - ${errorMessage}`
      );
    }
  }
}
