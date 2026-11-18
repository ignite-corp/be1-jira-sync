// 양방향 동기화 실행 (사람이 확인한 뒤에만 호출된다)
//
// 계획 수립은 bidirectional-orchestrator.ts 가 한다. 이 파일은 실제 쓰기만 담당한다.
//   - createInTarget : 요구사항 1 (BEDEV1 → 대상 생성 및 연결)
//   - createInSource : 요구사항 2 (대상 → BEDEV1 생성 및 연결)
//   - overwrite      : 요구사항 3 (사람이 고른 방향으로 덮어쓰기)

import { JiraIssue, JiraIssueCreatePayload } from '@/lib/types/jira';
import { SyncLogger } from './logger';
import { jira } from '@/lib/services/jira';
import {
  getFieldMappings,
  getSyncProfileInfo,
  mapFieldsFromDb,
  type SyncProfileInfo,
} from './db-field-mapper';
import { mapFieldsToSource } from './reverse-field-mapper';
import { sanitizeWritePayload } from './write-payload';
import { withProjectLabel } from './project-label';
import { JIRA_ENDPOINTS, IGNITE_CUSTOM_FIELDS } from '@/lib/constants/jira';
import {
  chooseCreateIssueType,
  classifyIssueKind,
  getConfiguredIssueTypeName,
  type IssueKind,
  type JiraIssueTypeOption,
} from './issue-type-resolver';
import { extractLinkFieldKeys, findBlocksOutwardKeys, findLinkedSourceKeys } from './link-resolver';
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
    profileId: string,
    sprintYearMonths?: readonly string[]
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
          sprintYearMonths,
          onWarning: (w) => warnings.push(w),
          // 실제 쓰기 경로이므로 없는 수정 버전은 만들어서 반영한다
          createMissingVersions: true,
        })
      );

      // 소스의 계층(일반/하위작업/에픽)을 그대로 보존한다.
      // 하위 작업을 일반 작업으로 만들면 부모와의 관계가 끊기고, 에픽도 마찬가지다.
      const kind = classifyIssueKind(sourceTicket.fields.issuetype);

      const issuetype = await this.resolveCreateIssueType(
        profile.targetProjectKey,
        targetInstance,
        kind
      );
      if (!issuetype) {
        throw new Error(
          `${profile.targetProjectKey} 에 ${kindLabel(kind)} 타입이 없어 생성하지 못했습니다`
        );
      }

      // 하위 작업은 부모 없이 만들 수 없다. 부모가 대상에 먼저 있어야 한다.
      let parent: { key: string } | undefined;
      if (kind === 'subtask') {
        const parentKey = await this.resolveTargetParentKey(sourceTicket, profile);
        if (!parentKey) {
          throw new Error(
            `부모 티켓(${sourceTicket.fields.parent?.key ?? '알 수 없음'})이 아직 ` +
              `${profile.targetProjectKey} 에 없습니다. 부모를 먼저 생성해 주세요.`
          );
        }
        parent = { key: parentKey };
      }

      // 하위 작업/에픽에는 스프린트 필드가 없다 (하위 작업은 부모의 스프린트를 따른다).
      // 그대로 보내면 "Field cannot be set" 으로 생성 자체가 실패한다.
      const createFields =
        kind === 'standard'
          ? mappedFields
          : await this.withoutSprintFields(mappedFields, profileId, 'target');

      const payload: JiraIssueCreatePayload = {
        fields: {
          project: { key: profile.targetProjectKey },
          issuetype,
          summary: sourceTicket.fields.summary,
          ...createFields,
          ...(parent ? { parent } : {}),
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
    profileId: string,
    sprintYearMonths?: readonly string[]
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
          sprintYearMonths,
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

      // 반대 방향도 계층을 보존한다 (대상의 하위 작업 → 소스의 하위 작업)
      const kind = classifyIssueKind(targetTicket.fields.issuetype);

      const issuetype = await this.resolveCreateIssueType(
        profile.sourceProjectKey,
        sourceInstance,
        kind
      );
      if (!issuetype) {
        throw new Error(
          `${profile.sourceProjectKey} 에 ${kindLabel(kind)} 타입이 없어 생성하지 못했습니다`
        );
      }

      let parent: { key: string } | undefined;
      if (kind === 'subtask') {
        const parentKey = await this.resolveSourceParentKey(targetTicket, profile);
        if (!parentKey) {
          throw new Error(
            `부모 티켓(${targetTicket.fields.parent?.key ?? '알 수 없음'})에 대응하는 ` +
              `${profile.sourceProjectKey} 티켓이 없습니다. 부모를 먼저 생성해 주세요.`
          );
        }
        parent = { key: parentKey };
      }

      const createFields =
        kind === 'standard'
          ? mappedFields
          : await this.withoutSprintFields(mappedFields, profileId, 'source');

      const payload: JiraIssueCreatePayload = {
        fields: {
          project: { key: profile.sourceProjectKey },
          issuetype,
          summary: targetTicket.fields.summary,
          ...createFields,
          ...(parent ? { parent } : {}),
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
    profileId: string,
    sprintYearMonths?: readonly string[]
  ): Promise<BidirectionalActionResult> {
    const profile = await getSyncProfileInfo(profileId);
    if (!profile) {
      return { success: false, error: `프로필을 찾을 수 없습니다: ${profileId}` };
    }

    const sourceInstance = normalizeInstance(profile.sourceInstance);
    const targetInstance = normalizeInstance(profile.targetInstance);

    const warnings: string[] = [];
    // 하위 작업/에픽에는 스프린트 필드가 없다 - 실으면 "cannot be set" 으로 수정이 통째로 실패한다
    const nonStandardPair =
      classifyIssueKind(sourceTicket.fields.issuetype) !== 'standard' ||
      classifyIssueKind(targetTicket.fields.issuetype) !== 'standard';

    try {
      if (direction === 'sourceToTarget') {
        this.logger.info(`${sourceTicket.key} → ${targetTicket.key}: 덮어쓰기 시작...`);

        const mapped = sanitizeWritePayload(
          await mapFieldsFromDb(sourceTicket, profileId, profile.targetProjectKey, {
            sprintYearMonths,
            onWarning: (w) => warnings.push(w),
            createMissingVersions: true,
          })
        );
        const fields = nonStandardPair
          ? await this.withoutSprintFields(mapped, profileId, 'target')
          : mapped;
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

        const mapped = sanitizeWritePayload(
          await mapFieldsToSource(targetTicket, profileId, {
            sprintYearMonths,
            onWarning: (w) => warnings.push(w),
            createMissingVersions: true,
          })
        );
        const fields = nonStandardPair
          ? await this.withoutSprintFields(mapped, profileId, 'source')
          : mapped;
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
   *
   * kind 는 소스 티켓의 계층이다. 하위작업/에픽은 그 계층 안에서만 고르고,
   * 못 찾으면 **null 을 돌려준다** - 일반 작업으로 떨어뜨리면 계층이 깨진 티켓이 생긴다.
   * (일반 티켓만 예전처럼 name "작업" 으로 폴백한다)
   */
  private async resolveCreateIssueType(
    projectKey: string,
    instance: 'ignite' | 'hmg',
    kind: IssueKind = 'standard'
  ): Promise<{ id: string } | { name: string } | null> {
    const cacheKey = `${instance}:${projectKey}:${kind}`;
    const cached = createIssueTypeCache.get(cacheKey);
    if (cached) return cached;

    // 계층이 깨지는 것보다 실패가 낫다 - 하위작업/에픽에는 폴백을 두지 않는다
    const fallback = kind === 'standard' ? ({ name: '작업' } as const) : null;

    try {
      const projectResult = await jira[instance].getProject(projectKey);
      const issueTypes = (projectResult.data as unknown as { issueTypes?: unknown })
        ?.issueTypes as JiraIssueTypeOption[] | undefined;

      if (!issueTypes || issueTypes.length === 0) {
        this.logger.warning(
          `${projectKey}: issueTypes 조회 실패 → ${
            fallback ? 'issuetype name "작업" 으로 폴백' : `${kindLabel(kind)} 생성 불가`
          }`
        );
        return fallback;
      }

      const chosen = chooseCreateIssueType(projectKey, issueTypes, kind);
      if (!chosen) {
        // 임의의 타입을 고르면 엉뚱한 타입(예: 버그)으로 티켓이 만들어진다.
        this.logger.error(
          `${projectKey}: 쓸 수 있는 ${kindLabel(kind)} 이슈 타입이 없습니다 ` +
            `(프로젝트의 타입: ${issueTypes.map((t) => t.name).join(', ')}). ` +
            `lib/constants/jira.ts 의 이슈 타입 상수에 "${projectKey}" 를 지정해 주세요.`
        );
        return fallback;
      }

      const configuredName = getConfiguredIssueTypeName(projectKey, kind);
      if (configuredName && chosen.reason !== 'configured') {
        this.logger.warning(
          `${projectKey}: 지정된 이슈 타입 "${configuredName}" 가 프로젝트에 없어 "${chosen.name}" 로 대체합니다`
        );
      }

      const resolved = { id: chosen.id };
      createIssueTypeCache.set(cacheKey, resolved);
      this.logger.info(
        `${projectKey}: ${kindLabel(kind)} issuetype 선택 → "${chosen.name}" (id=${chosen.id}, 근거=${chosen.reason})`
      );
      return resolved;
    } catch (error) {
      this.logger.warning(
        `${projectKey}: issuetype 조회 중 예외 → ${
          fallback ? 'name 폴백' : `${kindLabel(kind)} 생성 불가`
        } - ${toMessage(error)}`
      );
      return fallback;
    }
  }

  /**
   * 하위 작업의 부모를 대상 프로젝트에서 찾는다.
   *
   * 연결 판정은 일반 티켓과 똑같은 규칙을 쓴다 (link-resolver).
   *  - 같은 사이트: 부모의 Blocks outward 링크
   *  - 다른 사이트: 부모의 link field 에 담긴 URL
   * 부모가 아직 옮겨지지 않았으면 null - 호출부가 "부모 먼저" 라고 알린다.
   */
  private async resolveTargetParentKey(
    sourceTicket: JiraIssue,
    profile: SyncProfileInfo
  ): Promise<string | null> {
    const parentKey = sourceTicket.fields.parent?.key;
    if (!parentKey) return null;

    const sourceInstance = normalizeInstance(profile.sourceInstance);
    const targetInstance = normalizeInstance(profile.targetInstance);
    const linkField = profile.linkField || IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK;

    const parent = await this.fetchIssue(sourceInstance, parentKey, [linkField]);
    if (!parent) return null;

    const keys =
      sourceInstance === targetInstance
        ? findBlocksOutwardKeys(parent, profile.targetProjectKey)
        : extractLinkFieldKeys(parent, {
            linkField: profile.linkField,
            targetProjectKey: profile.targetProjectKey,
          });

    return keys[0] ?? null;
  }

  /**
   * 하위 작업의 부모를 소스 프로젝트에서 찾는다 (역방향 생성).
   *
   * 같은 사이트면 부모의 inward 링크로 바로 보인다.
   * 다른 사이트(HMG)는 역참조가 없어서, 소스 프로젝트에서 link field 가
   * 그 부모를 가리키는 티켓을 찾아야 한다.
   */
  private async resolveSourceParentKey(
    targetTicket: JiraIssue,
    profile: SyncProfileInfo
  ): Promise<string | null> {
    const parentKey = targetTicket.fields.parent?.key;
    if (!parentKey) return null;

    const sourceInstance = normalizeInstance(profile.sourceInstance);
    const targetInstance = normalizeInstance(profile.targetInstance);

    if (sourceInstance === targetInstance) {
      const parent = await this.fetchIssue(targetInstance, parentKey);
      if (!parent) return null;
      return findLinkedSourceKeys(parent, profile.sourceProjectKey)[0] ?? null;
    }

    // 다른 사이트: 소스에서 link field 로 되짚는다.
    const linkField = profile.linkField || IGNITE_CUSTOM_FIELDS.HMG_JIRA_LINK;
    const fieldNumber = linkField.replace(/^customfield_/, '');
    const jql = `project = ${profile.sourceProjectKey} AND cf[${fieldNumber}] ~ "${parentKey}"`;

    const result = await jira[sourceInstance].searchAllIssues(jql, [linkField]);
    if (!result.success || !result.data) {
      this.logger.warning(
        `${parentKey}: ${profile.sourceProjectKey} 에서 부모 역참조 조회 실패 - ${result.error ?? ''}`
      );
      return null;
    }

    // 텍스트 검색이라 부분 일치가 섞일 수 있어 링크 값을 다시 확인한다
    const matched = result.data.issues.find((issue) =>
      extractLinkFieldKeys(issue, {
        linkField: profile.linkField,
        targetProjectKey: profile.targetProjectKey,
      }).includes(parentKey)
    );

    return matched?.key ?? null;
  }

  /** 티켓 하나 조회 (매핑에 없는 필드도 받아야 해서 검색 API 를 쓴다) */
  private async fetchIssue(
    instance: 'ignite' | 'hmg',
    issueKey: string,
    extraFields: string[] = []
  ): Promise<JiraIssue | null> {
    const result = await jira[instance].searchAllIssues(`key = ${issueKey}`, extraFields);
    if (!result.success || !result.data?.issues?.length) {
      this.logger.warning(`${issueKey}: 조회 실패 - ${result.error ?? '결과 없음'}`);
      return null;
    }
    return result.data.issues[0];
  }

  /**
   * 스프린트 매핑 결과를 제거한다.
   *
   * 하위 작업은 부모의 스프린트를 따르고 에픽에는 스프린트가 없어서,
   * 스프린트 필드를 실으면 "Field 'customfield_xxxxx' cannot be set" 으로 생성이 통째로 실패한다.
   */
  private async withoutSprintFields(
    fields: Record<string, unknown>,
    profileId: string,
    side: 'source' | 'target'
  ): Promise<Record<string, unknown>> {
    const mappings = await getFieldMappings(profileId);
    const out = { ...fields };

    for (const mapping of mappings) {
      if (mapping.transform_type !== 'sprint_map') continue;
      const key = side === 'target' ? mapping.target_field : mapping.source_field;
      delete out[key];
    }

    return out;
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

/** 로그/오류 메시지에 쓰는 계층 이름 */
function kindLabel(kind: IssueKind): string {
  return kind === 'subtask' ? '하위 작업' : kind === 'epic' ? '에픽' : '일반';
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
