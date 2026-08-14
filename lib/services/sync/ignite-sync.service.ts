// Ignite Jira 프로젝트 동기화 (FEHG → KQ/HDD/HB)

import { JiraIssue } from '@/lib/types/jira';
import { SyncResult, SyncTargetProject } from './types';
import { SyncLogger } from './logger';
import { mapFieldsForIgniteProject } from './field-mapper';
import { mapFieldsFromDb } from './db-field-mapper';
import { migrateAttachments } from './attachment-migrator';
import {
  syncStatusWithPath,
  syncStatusWithPathFromDb,
} from './transition-helper';
import { jira } from '@/lib/services/jira';

/**
 * Ignite 프로젝트 동기화 서비스
 * FEHG → KQ/HDD/HB 동기화 담당
 */
export class IgniteSyncService {
  constructor(private logger: SyncLogger) {}

  /**
   * FEHG 티켓의 연결된 타겟 티켓 찾기 (blocks 관계)
   */
  private findLinkedTickets(
    fehgTicket: JiraIssue,
    targetProject: SyncTargetProject
  ): string[] {
    const issuelinks = fehgTicket.fields.issuelinks;
    if (!issuelinks || issuelinks.length === 0) {
      return [];
    }

    const linkedKeys: string[] = [];
    const projectPrefix = `${targetProject}-`;

    for (const link of issuelinks) {
      // Blocks 관계 확인
      if (link.type?.name === 'Blocks' && link.outwardIssue) {
        const targetKey = link.outwardIssue.key;
        // 프로젝트 prefix 매칭
        if (targetKey.startsWith(projectPrefix)) {
          linkedKeys.push(targetKey);
        }
      }
    }

    return linkedKeys;
  }

  /**
   * 단일 FEHG 티켓을 대상 프로젝트로 동기화
   */
  async syncTicket(
    fehgTicket: JiraIssue,
    targetProject: 'KQ' | 'HDD' | 'HB',
    syncProfileId?: string
  ): Promise<SyncResult[]> {
    const results: SyncResult[] = [];

    try {
      // 1. 연결된 티켓 찾기
      const linkedKeys = this.findLinkedTickets(fehgTicket, targetProject);

      if (linkedKeys.length === 0) {
        this.logger.warning(
          `${fehgTicket.key}: ${targetProject}와 연결된 티켓 없음`
        );
        return [];
      }

      this.logger.info(
        `${fehgTicket.key}: ${linkedKeys.length}개의 ${targetProject} 티켓 발견 (${linkedKeys.join(', ')})`
      );

      // 2. 각 연결된 티켓 업데이트
      for (const targetKey of linkedKeys) {
        const result = await this.updateTargetTicket(
          fehgTicket,
          targetKey,
          targetProject,
          syncProfileId
        );
        results.push(result);
      }

      return results;
    } catch (error) {
      this.logger.error(
        `${fehgTicket.key}: 동기화 중 예외 발생 - ${error instanceof Error ? error.message : String(error)}`
      );
      return results;
    }
  }

  /**
   * 대상 티켓 업데이트 (필드 + 상태)
   */
  private async updateTargetTicket(
    fehgTicket: JiraIssue,
    targetKey: string,
    targetProject: 'KQ' | 'HDD' | 'HB',
    syncProfileId?: string
  ): Promise<SyncResult> {
    try {
      this.logger.info(`${targetKey}: 업데이트 시작...${syncProfileId ? ' (DB 매핑)' : ''}`);

      // 1. 필드 매핑 (DB 기반 또는 하드코딩)
      const mappedFields = syncProfileId
        ? await mapFieldsFromDb(fehgTicket, syncProfileId, targetProject)
        : await mapFieldsForIgniteProject(fehgTicket, targetProject);

      // 2. 필드 업데이트
      const updateResult = await jira.ignite.updateIssueFields(
        targetKey,
        mappedFields
      );

      if (!updateResult.success) {
        const errorDetails = (updateResult as { details?: unknown }).details;
        if (errorDetails) {
          this.logger.error(
            `${targetKey}: Jira API 에러 상세 → ${JSON.stringify(errorDetails)}`
          );
        }
        throw new Error(updateResult.error || '필드 업데이트 실패');
      }

      this.logger.success(`${targetKey}: 필드 업데이트 완료`);

      // 3. 상태 동기화 (HDD는 권한 문제로 제외)
      if (targetProject !== 'HDD') {
        await this.syncIgniteStatus(fehgTicket, targetKey, syncProfileId);
      } else {
        this.logger.info(`${targetKey}: 상태 동기화 스킵 (HDD는 제외)`);
      }

      // 4. 첨부파일 동기화 (같은 Ignite 조직이라 본문 인라인은 그대로 유효 → 파일 복사만)
      try {
        await migrateAttachments({
          sourceInstance: 'ignite',
          targetInstance: 'ignite',
          sourceTicket: fehgTicket,
          targetKey,
          logger: this.logger,
          allowDescriptionRemap: false,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warning(`${targetKey}: 첨부 동기화 실패 - ${message}`);
      }

      return {
        fehgKey: fehgTicket.key,
        targetKey,
        targetProject,
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
        targetProject,
        success: false,
        error: errorMessage,
        isNewlyCreated: false,
      };
    }
  }

  /**
   * Ignite 타겟 티켓 상태 동기화 (동적 경로 탐색 사용)
   */
  private async syncIgniteStatus(
    fehgTicket: JiraIssue,
    targetKey: string,
    syncProfileId?: string
  ): Promise<void> {
    const fehgStatusId = fehgTicket.fields.status?.id;
    if (!fehgStatusId) return;

    try {
      // 1. 현재 타겟 티켓의 상태 조회
      const targetIssue = await jira.ignite.getIssue(targetKey);
      if (!targetIssue.success || !targetIssue.data) {
        this.logger.warning(`${targetKey}: 상태 조회 실패 - 상태 동기화 스킵`);
        return;
      }

      const currentStatusId = targetIssue.data.fields.status?.id;
      if (!currentStatusId) {
        this.logger.warning(`${targetKey}: 현재 상태 ID 없음 - 상태 동기화 스킵`);
        return;
      }

      // 2. 동적 경로 탐색 및 순차 실행
      const result = syncProfileId
        ? await syncStatusWithPathFromDb(
            syncProfileId,
            targetKey,
            fehgStatusId,
            currentStatusId,
            async (issueKey, transitionId) => {
              return await jira.ignite.updateIssueStatus(
                issueKey,
                transitionId
              );
            },
            this.logger
          )
        : await syncStatusWithPath(
            'ignite',
            targetKey,
            fehgStatusId,
            currentStatusId,
            async (issueKey, transitionId) => {
              return await jira.ignite.updateIssueStatus(
                issueKey,
                transitionId
              );
            },
            this.logger
          );

      if (!result.success && result.stepsExecuted > 0) {
        this.logger.warning(
          `${targetKey}: 상태 동기화 부분 완료 (${result.stepsExecuted}단계 실행 후 실패)`
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
