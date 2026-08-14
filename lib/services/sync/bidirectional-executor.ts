// 양방향 동기화 실행 (사람이 확인한 뒤에만 호출된다)
//
// 계획 수립은 bidirectional-orchestrator.ts 가 한다. 이 파일은 실제 쓰기만 담당한다.
//   - createInTarget : 요구사항 1 (BEDEV1 → 대상 생성 및 연결)
//   - createInSource : 요구사항 2 (대상 → BEDEV1 생성 및 연결)
//   - overwrite      : 요구사항 3 (사람이 고른 방향으로 덮어쓰기)

import { JiraIssue, JiraIssueCreatePayload } from '@/lib/types/jira';
import { SyncLogger } from './logger';
import { jira } from '@/lib/services/jira';
import { mapFieldsFromDb, getSyncProfileInfo, type SyncProfileInfo } from './db-field-mapper';
import { mapFieldsToSource } from './reverse-field-mapper';
import { sanitizeWritePayload } from './write-payload';
import { withProjectLabel } from './project-label';
import { JIRA_ENDPOINTS, IGNITE_CUSTOM_FIELDS } from '@/lib/constants/jira';
import {
  chooseCreateIssueType,
  getConfiguredIssueTypeName,
  type JiraIssueTypeOption,
} from './issue-type-resolver';
import {
  getSourceStatusIdFromProfile,
  getTargetStatusIdFromProfile,
  transitionToStatus,
} from './transition-helper';
import type { SyncDirection } from './bidirectional-orchestrator';

/** 연결에 사용하는 이슈 링크 타입 (결정 1) */
const LINK_TYPE_BLOCKS = 'Blocks';

export interface BidirectionalActionResult {
  success: boolean;
  sourceKey?: string;
  targetKey?: string;
  message?: string;
  error?: string;
  /**
   * 성공했지만 일부 값을 반영하지 못한 경우의 사유.
   * (예: 대상에만 있는 수정 버전 이름이 상대 프로젝트에 없음)
   * 조용히 넘어가면 "반영됐다" 고 오해하게 되므로 결과에 실어 보낸다.
   */
  warnings?: string[];
}

// 프로젝트별 생성용 issuetype 캐시
const createIssueTypeCache = new Map<string, { id: string } | { name: string }>();

export class BidirectionalExecutor {
  constructor(private logger: SyncLogger) {}

  /**
   * 요구사항 1: BEDEV1 티켓을 대상 프로젝트에 생성하고 연결한다.
   */
  async createInTarget(
    sourceTicket: JiraIssue,
    profileId: string
  ): Promise<BidirectionalActionResult> {
    const profile = await getSyncProfileInfo(profileId);
    if (!profile) {
      return { success: false, error: `프로필을 찾을 수 없습니다: ${profileId}` };
    }

    const targetInstance = normalizeInstance(profile.targetInstance);

    try {
      this.logger.info(`${sourceTicket.key}: ${profile.targetProjectKey} 티켓 생성 시작...`);

      const warnings: string[] = [];
      const mappedFields = sanitizeWritePayload(
        await mapFieldsFromDb(sourceTicket, profileId, profile.targetProjectKey, {
          onWarning: (w) => warnings.push(w),
          // 실제 쓰기 경로이므로 없는 수정 버전은 만들어서 반영한다
          createMissingVersions: true,
        })
      );

      const issuetype = await this.resolveCreateIssueType(
        profile.targetProjectKey,
        targetInstance
      );

      const payload: JiraIssueCreatePayload = {
        fields: {
          project: { key: profile.targetProjectKey },
          issuetype,
          summary: sourceTicket.fields.summary,
          ...mappedFields,
        },
      };

      const created = await jira[targetInstance].createIssue(payload);
      if (!created.success || !created.data) {
        this.logCreateError(sourceTicket.key, created);
        throw new Error(created.error || '티켓 생성 실패');
      }

      const createdKey = created.data.key;
      this.logger.success(`${createdKey}: ${profile.targetProjectKey} 티켓 생성 완료`);

      await this.link(sourceTicket.key, createdKey, profile);

      // 생성 시에는 상태를 지정할 수 없으므로 만든 뒤 옮긴다
      const sourceStatusId = sourceTicket.fields.status?.id;
      await this.applyStatus({
        instance: targetInstance,
        issueKey: createdKey,
        currentStatusId: await this.fetchStatusId(targetInstance, createdKey),
        desiredStatusId: sourceStatusId
          ? await getTargetStatusIdFromProfile(profileId, sourceStatusId)
          : null,
        desiredStatusName: sourceTicket.fields.status?.name,
      });

      this.reportWarnings(createdKey, warnings);

      return {
        success: true,
        sourceKey: sourceTicket.key,
        targetKey: createdKey,
        message: '생성 및 연결 완료',
        warnings,
      };
    } catch (error) {
      const message = toMessage(error);
      this.logger.error(`${sourceTicket.key}: 대상 생성 실패 - ${message}`);
      return { success: false, sourceKey: sourceTicket.key, error: message };
    }
  }

  /**
   * 요구사항 2: 대상 프로젝트 티켓을 BEDEV1 에 생성하고 연결한다.
   */
  async createInSource(
    targetTicket: JiraIssue,
    profileId: string
  ): Promise<BidirectionalActionResult> {
    const profile = await getSyncProfileInfo(profileId);
    if (!profile) {
      return { success: false, error: `프로필을 찾을 수 없습니다: ${profileId}` };
    }

    const sourceInstance = normalizeInstance(profile.sourceInstance);

    try {
      this.logger.info(`${targetTicket.key}: ${profile.sourceProjectKey} 티켓 생성 시작...`);

      // 결정 4: 기존 매핑을 역으로 적용한다 (두 번째 프로필을 만들지 않는다)
      const warnings: string[] = [];
      const mappedFields = sanitizeWritePayload(
        await mapFieldsToSource(targetTicket, profileId, {
          onWarning: (w) => warnings.push(w),
          createMissingVersions: true,
        })
      );

      // BEDEV1 은 모든 프로젝트의 중앙 관리처라, 어느 프로젝트 것인지 라벨로 구분한다.
      // 라벨 값은 DB 에 등록된 프로젝트 이름을 그대로 쓴다 (KQ → "KQ", AUTOWAY → "AUTOWAY").
      mappedFields.labels = withProjectLabel(
        mappedFields.labels,
        profile.targetProjectKey
      );

      const issuetype = await this.resolveCreateIssueType(
        profile.sourceProjectKey,
        sourceInstance
      );

      const payload: JiraIssueCreatePayload = {
        fields: {
          project: { key: profile.sourceProjectKey },
          issuetype,
          summary: targetTicket.fields.summary,
          ...mappedFields,
        },
      };

      const created = await jira[sourceInstance].createIssue(payload);
      if (!created.success || !created.data) {
        this.logCreateError(targetTicket.key, created);
        throw new Error(created.error || '티켓 생성 실패');
      }

      const createdKey = created.data.key;
      this.logger.success(`${createdKey}: ${profile.sourceProjectKey} 티켓 생성 완료`);

      await this.link(createdKey, targetTicket.key, profile);

      // 대상이 "완료" 인데 BEDEV1 이 "해야 할 일" 로 남지 않도록 상태도 맞춘다
      const targetStatusId = targetTicket.fields.status?.id;
      await this.applyStatus({
        instance: sourceInstance,
        issueKey: createdKey,
        currentStatusId: await this.fetchStatusId(sourceInstance, createdKey),
        desiredStatusId: targetStatusId
          ? await getSourceStatusIdFromProfile(profileId, targetStatusId)
          : null,
        desiredStatusName: targetTicket.fields.status?.name,
      });

      this.reportWarnings(createdKey, warnings);

      return {
        success: true,
        sourceKey: createdKey,
        targetKey: targetTicket.key,
        message: '생성 및 연결 완료',
        warnings,
      };
    } catch (error) {
      const message = toMessage(error);
      this.logger.error(`${targetTicket.key}: ${'소스'} 생성 실패 - ${message}`);
      return { success: false, targetKey: targetTicket.key, error: message };
    }
  }

  /**
   * 요구사항 3: 사람이 고른 방향으로 덮어쓴다.
   */
  async overwrite(
    direction: SyncDirection,
    sourceTicket: JiraIssue,
    targetTicket: JiraIssue,
    profileId: string
  ): Promise<BidirectionalActionResult> {
    const profile = await getSyncProfileInfo(profileId);
    if (!profile) {
      return { success: false, error: `프로필을 찾을 수 없습니다: ${profileId}` };
    }

    const sourceInstance = normalizeInstance(profile.sourceInstance);
    const targetInstance = normalizeInstance(profile.targetInstance);

    const warnings: string[] = [];

    try {
      if (direction === 'sourceToTarget') {
        this.logger.info(`${sourceTicket.key} → ${targetTicket.key}: 덮어쓰기 시작...`);

        const fields = sanitizeWritePayload(
          await mapFieldsFromDb(sourceTicket, profileId, profile.targetProjectKey, {
            onWarning: (w) => warnings.push(w),
            createMissingVersions: true,
          })
        );
        const result = await jira[targetInstance].updateIssueFields(targetTicket.key, fields);

        if (!result.success) {
          this.logUpdateError(targetTicket.key, result);
          throw new Error(result.error || '필드 업데이트 실패');
        }

        this.logger.success(`${targetTicket.key}: 덮어쓰기 완료`);

        const srcStatusId = sourceTicket.fields.status?.id;
        await this.applyStatus({
          instance: targetInstance,
          issueKey: targetTicket.key,
          currentStatusId: targetTicket.fields.status?.id,
          desiredStatusId: srcStatusId
            ? await getTargetStatusIdFromProfile(profileId, srcStatusId)
            : null,
          desiredStatusName: sourceTicket.fields.status?.name,
        });
      } else {
        this.logger.info(`${targetTicket.key} → ${sourceTicket.key}: 덮어쓰기 시작...`);

        const fields = sanitizeWritePayload(
          await mapFieldsToSource(targetTicket, profileId, {
            onWarning: (w) => warnings.push(w),
            createMissingVersions: true,
          })
        );
        const result = await jira[sourceInstance].updateIssueFields(sourceTicket.key, fields);

        if (!result.success) {
          this.logUpdateError(sourceTicket.key, result);
          throw new Error(result.error || '필드 업데이트 실패');
        }

        this.logger.success(`${sourceTicket.key}: 덮어쓰기 완료`);

        const tgtStatusId = targetTicket.fields.status?.id;
        await this.applyStatus({
          instance: sourceInstance,
          issueKey: sourceTicket.key,
          currentStatusId: sourceTicket.fields.status?.id,
          desiredStatusId: tgtStatusId
            ? await getSourceStatusIdFromProfile(profileId, tgtStatusId)
            : null,
          desiredStatusName: targetTicket.fields.status?.name,
        });
      }

      this.reportWarnings(
        direction === 'sourceToTarget' ? targetTicket.key : sourceTicket.key,
        warnings
      );

      return {
        success: true,
        sourceKey: sourceTicket.key,
        targetKey: targetTicket.key,
        message: direction === 'sourceToTarget' ? '대상에 반영 완료' : '소스에 반영 완료',
        warnings,
      };
    } catch (error) {
      const message = toMessage(error);
      this.logger.error(`${sourceTicket.key} ↔ ${targetTicket.key}: 덮어쓰기 실패 - ${message}`);
      return {
        success: false,
        sourceKey: sourceTicket.key,
        targetKey: targetTicket.key,
        error: message,
      };
    }
  }

  /**
   * 상태를 맞춘다.
   *
   * Jira 는 생성 시 상태를 지정할 수 없어 만든 뒤 transition 으로 옮겨야 한다.
   * sync_profile_workflows 는 대상 프로젝트 워크플로우만 담고 있어서 역방향에는 못 쓴다.
   * 그래서 Jira 에서 사용 가능한 transition 을 직접 조회해 길을 찾는다.
   *
   * 상태 동기화가 실패해도 필드는 이미 반영됐으므로 경고만 남기고 넘어간다.
   */
  private async applyStatus(params: {
    instance: 'ignite' | 'hmg';
    issueKey: string;
    currentStatusId: string | undefined;
    desiredStatusId: string | null;
    desiredStatusName?: string;
  }): Promise<void> {
    const { instance, issueKey, currentStatusId, desiredStatusId, desiredStatusName } = params;

    if (!desiredStatusId) {
      this.logger.info(`${issueKey}: 상태 매핑이 없어 상태 동기화를 건너뜁니다`);
      return;
    }
    if (!currentStatusId) {
      this.logger.warning(`${issueKey}: 현재 상태를 알 수 없어 상태 동기화를 건너뜁니다`);
      return;
    }
    if (currentStatusId === desiredStatusId) {
      this.logger.info(`${issueKey}: 이미 목표 상태입니다`);
      return;
    }

    const label = desiredStatusName ? `"${desiredStatusName}"` : desiredStatusId;
    this.logger.info(`${issueKey}: 상태 동기화 ${currentStatusId} → ${label}`);

    const result = await transitionToStatus({
      issueKey,
      currentStatusId,
      targetStatusId: desiredStatusId,
      getTransitions: async (key) => {
        const res = await jira[instance].getIssueTransitions(key);
        if (!res.success) return [];
        return (
          (res.data as { transitions?: Array<{ id: string; to?: { id?: string } }> })
            ?.transitions ?? []
        );
      },
      executeTransition: async (key, transitionId) => {
        const res = await jira[instance].updateIssueStatus(key, transitionId);
        return { success: res.success, error: res.error };
      },
      logger: this.logger,
    });

    if (!result.success) {
      this.logger.warning(
        `${issueKey}: 상태 동기화 실패 (필드는 반영됨) - ${result.error ?? ''}`
      );
    }
  }

  /** 생성 직후 이슈의 현재 상태 id 를 조회한다 */
  private async fetchStatusId(
    instance: 'ignite' | 'hmg',
    issueKey: string
  ): Promise<string | undefined> {
    const res = await jira[instance].getIssue(issueKey);
    return res.success ? res.data?.fields.status?.id : undefined;
  }

  /**
   * 두 티켓을 연결한다 (결정 1 의 규칙 그대로).
   *  - 같은 사이트: Blocks 이슈 링크 (소스가 대상을 blocks)
   *  - 다른 사이트: 소스의 link_field 에 대상 URL 저장
   */
  private async link(
    sourceKey: string,
    targetKey: string,
    profile: SyncProfileInfo
  ): Promise<void> {
    const sourceInstance = normalizeInstance(profile.sourceInstance);
    const targetInstance = normalizeInstance(profile.targetInstance);

    if (sourceInstance === targetInstance) {
      const result = await jira[sourceInstance].createIssueLink({
        typeName: LINK_TYPE_BLOCKS,
        inwardIssueKey: sourceKey,
        outwardIssueKey: targetKey,
      });

      if (!result.success) {
        this.logger.warning(
          `${sourceKey} → ${targetKey}: 이슈 링크 생성 실패 (티켓은 생성됨) - ${result.error ?? ''}`
        );
      } else {
        this.logger.success(`${sourceKey} → ${targetKey}: Blocks 링크 연결 완료`);
      }
      return;
    }

    // 다른 사이트: 소스 티켓의 link field 에 대상 URL 기록
    const linkFieldId = profile.linkField || IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK;
    const targetBaseUrl =
      targetInstance === 'hmg' ? JIRA_ENDPOINTS.HMG : JIRA_ENDPOINTS.IGNITE;
    const targetUrl = `${targetBaseUrl}/browse/${targetKey}`;

    const result = await jira[sourceInstance].updateIssueFields(sourceKey, {
      [linkFieldId]: targetUrl,
    });

    if (!result.success) {
      this.logger.warning(
        `${sourceKey}: 링크 필드(${linkFieldId}) 저장 실패 (티켓은 생성됨) - ${result.error ?? ''}`
      );
    } else {
      this.logger.success(`${sourceKey}: ${targetKey} 링크 저장 완료`);
    }
  }

  /**
   * 생성용 issuetype 결정
   * 프로젝트마다 허용 이슈 타입 이름/로캘이 달라 name 하드코딩이 깨지므로 id 를 우선 쓴다.
   * (HMGSyncService.resolveCreateIssueType 과 같은 방식)
   */
  private async resolveCreateIssueType(
    projectKey: string,
    instance: 'ignite' | 'hmg'
  ): Promise<{ id: string } | { name: string }> {
    const cacheKey = `${instance}:${projectKey}`;
    const cached = createIssueTypeCache.get(cacheKey);
    if (cached) return cached;

    const fallback = { name: '작업' } as const;

    try {
      const projectResult = await jira[instance].getProject(projectKey);
      const issueTypes = (projectResult.data as unknown as { issueTypes?: unknown })
        ?.issueTypes as JiraIssueTypeOption[] | undefined;

      if (!issueTypes || issueTypes.length === 0) {
        this.logger.warning(
          `${projectKey}: issueTypes 조회 실패 → issuetype name "작업" 으로 폴백`
        );
        return fallback;
      }

      const chosen = chooseCreateIssueType(projectKey, issueTypes);
      if (!chosen) {
        // 임의의 타입을 고르면 엉뚱한 타입(예: 버그)으로 티켓이 만들어진다.
        this.logger.error(
          `${projectKey}: 쓸 수 있는 이슈 타입이 없습니다 ` +
            `(찾은 것: 작업/개발처리/Dev Task 중 없음). ` +
            `lib/constants/jira.ts 의 CREATE_ISSUE_TYPE_MAP 에 "${projectKey}" 를 지정해 주세요.`
        );
        return fallback;
      }

      const configuredName = getConfiguredIssueTypeName(projectKey);
      if (configuredName && chosen.reason !== 'configured') {
        this.logger.warning(
          `${projectKey}: 지정된 이슈 타입 "${configuredName}" 가 프로젝트에 없어 "${chosen.name}" 로 대체합니다`
        );
      }

      const resolved = { id: chosen.id };
      createIssueTypeCache.set(cacheKey, resolved);
      this.logger.info(
        `${projectKey}: issuetype 선택 → "${chosen.name}" (id=${chosen.id}, 근거=${chosen.reason})`
      );
      return resolved;
    } catch (error) {
      this.logger.warning(
        `${projectKey}: issuetype 조회 중 예외 → name 폴백 - ${toMessage(error)}`
      );
      return fallback;
    }
  }

  /** 반영하지 못한 값을 로그에 남긴다 (성공으로 묻히지 않도록) */
  private reportWarnings(issueKey: string, warnings: string[]) {
    for (const warning of warnings) {
      this.logger.warning(`${issueKey}: ${warning}`);
    }
  }

  private logCreateError(key: string, result: { details?: unknown }) {
    if (result.details) {
      this.logger.error(`${key}: Jira API 에러 상세 → ${JSON.stringify(result.details)}`);
    }
  }

  private logUpdateError(key: string, result: { details?: unknown }) {
    if (result.details) {
      this.logger.error(`${key}: Jira API 에러 상세 → ${JSON.stringify(result.details)}`);
    }
  }
}

/** 생성용 issuetype 캐시 초기화 */
export function clearCreateIssueTypeCache() {
  createIssueTypeCache.clear();
}

function normalizeInstance(instance: string): 'ignite' | 'hmg' {
  return instance === 'hmg' ? 'hmg' : 'ignite';
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
