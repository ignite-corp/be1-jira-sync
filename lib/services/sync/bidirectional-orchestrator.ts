// 양방향 동기화 계획 수립 (BEDEV1 ↔ 대상 프로젝트)
//
// 요구사항
//   1. BEDEV1 에 있고 대상에 없으면 → 대상에 생성 및 연결   (createInTarget)
//   2. 대상에 있고 BEDEV1 에 없으면 → BEDEV1 에 생성 및 연결 (createInSource)
//   3. 양쪽에 다 있으면 → 덮어쓸지 사람에게 묻는다            (conflict)
//
// 이 파일은 **계획만 세운다.** 실제 쓰기는 bidirectional-executor.ts 가 사람의 확인을 받은 뒤 수행한다.

import { JiraIssue } from '@/lib/types/jira';
import { SyncLogger } from './logger';
import { jira } from '@/lib/services/jira';
import {
  getFieldMappings,
  getSyncProfileInfo,
  lookupHmgAccountId,
  lookupIgniteAccountId,
  mapFieldsFromDb,
  type SyncProfileInfo,
} from './db-field-mapper';
import {
  currentMonthSprintName,
  findCurrentMonthSprint,
  initSprintCache,
} from './sprint-mapper';
import {
  compareMappedFields,
  suggestDirection,
  type TicketComparison,
} from './ticket-comparator';
import {
  extractLinkFieldKeys,
  findBlocksOutwardKeys,
  findLinkedSourceKeys,
} from './link-resolver';
import { hasProjectLabel } from './project-label';
import { getTargetStatusIdFromProfile } from './transition-helper';

export { extractLinkFieldKeys, findBlocksOutwardKeys, findLinkedSourceKeys };

export type SyncDirection = 'sourceToTarget' | 'targetToSource';

export interface TicketRef {
  key: string;
  summary: string;
  updated?: string;
  statusName?: string;
}

/** 양쪽에 다 있는 티켓 쌍 (요구사항 3) */
export interface ConflictItem {
  source: TicketRef;
  target: TicketRef;
  /** 실행 단계에서 매핑을 다시 돌려야 해서 원본 티켓을 그대로 들고 있는다 */
  sourceRaw: JiraIssue;
  targetRaw: JiraIssue;
  comparison: TicketComparison;
  /** 최종수정이 늦은 쪽 — 어느 버튼을 먼저 보여줄지 고르는 힌트로만 쓴다 (결정 2) */
  suggestedDirection: SyncDirection;
}

/** 한쪽에만 있는 티켓 (요구사항 1, 2) */
export interface MissingItem {
  ticket: TicketRef;
  raw: JiraIssue;
}

/** 계획에서 제외된 티켓과 그 이유 */
export interface SkippedItem {
  key: string;
  reason: string;
}

export interface BidirectionalPlan {
  profileId: string;
  profileName: string;
  sourceProjectKey: string;
  targetProjectKey: string;
  sourceInstance: 'ignite' | 'hmg';
  targetInstance: 'ignite' | 'hmg';
  /** 같은 Atlassian 사이트인가 (연결 판정 방식이 갈린다 - 결정 1) */
  sameSite: boolean;
  sourceSprintName: string;
  targetSprintName: string;
  /** 요구사항 1: BEDEV1 에만 있음 → 대상에 생성 */
  createInTarget: MissingItem[];
  /** 요구사항 2: 대상에만 있음 → BEDEV1 에 생성 */
  createInSource: MissingItem[];
  /** 요구사항 3: 양쪽에 있고 내용이 다름 → 사람에게 확인 */
  conflicts: ConflictItem[];
  /** 양쪽에 있고 매핑된 내용이 같음 → 건너뜀 (결정 2) */
  inSync: ConflictItem[];
  skipped: SkippedItem[];
}

/**
 * 담당자 계정 매핑이 없어 대상 쪽 필터를 걸 수 없을 때 던지는 오류.
 * 필터 없이 진행하면 공용 프로젝트(KQ 등)의 남의 팀 티켓까지 생성 후보로 올라온다.
 */
export class AssigneeAccountNotMappedError extends Error {
  constructor(
    public readonly instance: 'ignite' | 'hmg',
    public readonly accountId: string
  ) {
    super(
      `담당자의 ${instance === 'hmg' ? 'HMG' : 'Ignite'} 계정 매핑이 없습니다. ` +
        `사용자 설정에서 계정을 등록해 주세요. (기준 accountId=${accountId})`
    );
    this.name = 'AssigneeAccountNotMappedError';
  }
}

export interface BuildPlanOptions {
  /** 소스 인스턴스 기준 담당자 accountId. 양쪽 조회를 이 담당자로 한정한다. */
  assigneeAccountId: string;
  /** 현재 월 스프린트 판정 기준 시각 (테스트용) */
  now?: Date;
}

/**
 * 현재 월 스프린트를 못 찾았을 때 던지는 오류.
 * 결정 3: 다른 스프린트로 대체하거나 전체를 훑는 폴백을 만들지 않는다.
 */
export class CurrentSprintNotFoundError extends Error {
  constructor(
    public readonly projectKey: string,
    public readonly expectedSprintName: string
  ) {
    super(
      `${projectKey}: 현재 월 스프린트 "${expectedSprintName}" 를 찾을 수 없습니다. 스프린트를 먼저 만들어 주세요.`
    );
    this.name = 'CurrentSprintNotFoundError';
  }
}

export class BidirectionalOrchestrator {
  constructor(private logger: SyncLogger) {}

  /**
   * 양방향 동기화 계획을 세운다. 쓰기는 하지 않는다.
   */
  async buildPlan(
    profileId: string,
    options: BuildPlanOptions
  ): Promise<BidirectionalPlan> {
    initSprintCache();
    this.missingStatusMapping.clear();
    this.warnedMapping.clear();

    const now = options.now ?? new Date();

    const profile = await getSyncProfileInfo(profileId);
    if (!profile) {
      throw new Error(`동기화 프로필을 찾을 수 없습니다: ${profileId}`);
    }

    const sourceInstance = normalizeInstance(profile.sourceInstance);
    const targetInstance = normalizeInstance(profile.targetInstance);
    const sameSite = sourceInstance === targetInstance;

    this.logger.info(
      `양방향 비교 시작: ${profile.sourceProjectKey} ↔ ${profile.targetProjectKey} ` +
        `(${sameSite ? '같은 사이트 - Blocks 링크' : '다른 사이트 - link field'})`
    );

    // 담당자 계정을 양쪽 인스턴스 기준으로 각각 해석한다.
    // KQ 같은 공용 프로젝트는 스프린트에 여러 팀 티켓이 섞여 있어서
    // 담당자로 걸러 주지 않으면 남의 팀 티켓까지 생성 후보로 올라온다.
    const sourceAssigneeId = options.assigneeAccountId;
    const targetAssigneeId = await this.resolveAssigneeForInstance(
      sourceAssigneeId,
      sourceInstance,
      targetInstance
    );

    // 1. 양쪽 현재 월 스프린트 확인 (결정 3: 없으면 오류로 멈춘다)
    const [sourceSprint, targetSprint] = await Promise.all([
      findCurrentMonthSprint(profile.sourceProjectKey, sourceInstance, now),
      findCurrentMonthSprint(profile.targetProjectKey, targetInstance, now),
    ]);

    if (!sourceSprint) {
      throw new CurrentSprintNotFoundError(
        profile.sourceProjectKey,
        currentMonthSprintName(profile.sourceProjectKey, now)
      );
    }
    if (!targetSprint) {
      throw new CurrentSprintNotFoundError(
        profile.targetProjectKey,
        currentMonthSprintName(profile.targetProjectKey, now)
      );
    }

    this.logger.info(
      `스프린트 확인: "${sourceSprint.name}"(id=${sourceSprint.id}) ↔ "${targetSprint.name}"(id=${targetSprint.id})`
    );

    // 2. 양쪽 티켓 조회 (현재 스프린트 + 담당자로 한정)
    //
    // 매핑에 지정된 필드를 조회 필드에 반드시 포함시킨다.
    // DEFAULT_FIELDS 에만 의존하면 timeoriginalestimate 같은 매핑 필드가 안 넘어와서
    // 양쪽 다 undefined 가 되고, 값이 달라도 "동일" 로 판정된다.
    const mappings = await getFieldMappings(profileId);
    if (mappings.length === 0) {
      this.logger.warning(
        `${profile.name}: 필드 매핑이 하나도 없습니다 - 모든 쌍이 "같음"으로 판정됩니다`
      );
    }
    const sourceExtraFields = mappings.map((m) => m.source_field);
    const targetExtraFields = mappings.map((m) => m.target_field);

    const [sourceTickets, targetTickets] = await Promise.all([
      this.fetchSprintTickets(
        profile.sourceProjectKey,
        sourceSprint.id,
        sourceInstance,
        sourceAssigneeId,
        sourceExtraFields
      ),
      this.fetchSprintTickets(
        profile.targetProjectKey,
        targetSprint.id,
        targetInstance,
        targetAssigneeId,
        targetExtraFields
      ),
    ]);

    this.logger.info(
      `조회 완료: ${profile.sourceProjectKey} ${sourceTickets.length}개 / ` +
        `${profile.targetProjectKey} ${targetTickets.length}개 (담당자 한정)`
    );

    // 3. 연결 판정 (결정 1: 새 테이블 없이 현재 규칙 그대로)
    const targetByKey = new Map(targetTickets.map((t) => [t.key, t]));
    const linkedTargetKeys = new Set<string>();

    const plan: BidirectionalPlan = {
      profileId,
      profileName: profile.name,
      sourceProjectKey: profile.sourceProjectKey,
      targetProjectKey: profile.targetProjectKey,
      sourceInstance,
      targetInstance,
      sameSite,
      sourceSprintName: sourceSprint.name,
      targetSprintName: targetSprint.name,
      createInTarget: [],
      createInSource: [],
      conflicts: [],
      inSync: [],
      skipped: [],
    };

    // 4. 소스 기준 순회
    let unlabeledCount = 0;

    for (const sourceTicket of sourceTickets) {
      const linkedKeys = this.findLinkedTargetKeys(sourceTicket, profile, sameSite);

      if (linkedKeys.length === 0) {
        // 요구사항 1: 대상에 없음 → 생성 대상
        //
        // 단, BEDEV1 은 모든 프로젝트의 중앙 관리처라 티켓마다 어느 프로젝트 것인지
        // 라벨로 구분한다. 이 프로필의 대상 프로젝트 라벨이 없으면 남의 프로젝트 티켓이다.
        // (예: 라벨이 AUTOWAY 인 티켓은 KQ 비교 화면에 뜨면 안 된다)
        if (!hasProjectLabel(sourceTicket.fields.labels, profile.targetProjectKey)) {
          unlabeledCount++;
          continue;
        }

        plan.createInTarget.push({ ticket: toRef(sourceTicket), raw: sourceTicket });
        continue;
      }

      for (const targetKey of linkedKeys) {
        linkedTargetKeys.add(targetKey);

        const targetTicket = targetByKey.get(targetKey);
        if (!targetTicket) {
          // 연결은 돼 있으나 대상의 현재 스프린트 밖 → 범위 밖이므로 건드리지 않는다.
          // (여기서 생성해 버리면 중복 티켓이 생긴다)
          plan.skipped.push({
            key: `${sourceTicket.key} → ${targetKey}`,
            reason: `연결된 대상 티켓이 현재 스프린트("${targetSprint.name}") 밖입니다`,
          });
          continue;
        }

        // 요구사항 3: 양쪽에 다 있음 → 매핑된 내용 비교
        const comparison = await this.compare(sourceTicket, targetTicket, profileId, profile);

        const item: ConflictItem = {
          source: toRef(sourceTicket),
          target: toRef(targetTicket),
          sourceRaw: sourceTicket,
          targetRaw: targetTicket,
          comparison,
          suggestedDirection: suggestDirection(
            sourceTicket.fields.updated,
            targetTicket.fields.updated
          ),
        };

        if (comparison.identical) {
          // 결정 2: 매핑된 내용이 같으면 건너뛴다
          plan.inSync.push(item);
        } else {
          plan.conflicts.push(item);
        }
      }
    }

    // 5. 대상 기준 순회 (요구사항 2)
    for (const targetTicket of targetTickets) {
      if (linkedTargetKeys.has(targetTicket.key)) continue;

      if (sameSite) {
        // 같은 사이트: 대상 티켓의 issuelinks 에 inward 로 소스 키가 보인다 (2단계 실측 확인)
        const inwardSourceKeys = findLinkedSourceKeys(targetTicket, profile.sourceProjectKey);
        if (inwardSourceKeys.length > 0) {
          // 소스에는 연결이 있으나 소스의 현재 스프린트 밖
          plan.skipped.push({
            key: `${targetTicket.key} → ${inwardSourceKeys.join(', ')}`,
            reason: `연결된 ${profile.sourceProjectKey} 티켓이 현재 스프린트("${sourceSprint.name}") 밖입니다`,
          });
          continue;
        }
      }
      // 다른 사이트: HMG 티켓에는 역참조가 없으므로 소스 링크 집합과의 차집합이 곧 미연결이다.

      plan.createInSource.push({ ticket: toRef(targetTicket), raw: targetTicket });
    }

    if (this.missingStatusMapping.size > 0) {
      this.logger.warning(
        `상태 매핑이 없는 소스 상태 ${this.missingStatusMapping.size}개는 상태 비교에서 제외했습니다 ` +
          `(상태 id: ${[...this.missingStatusMapping].join(', ')})`
      );
    }

    if (unlabeledCount > 0) {
      this.logger.info(
        `${profile.sourceProjectKey}: 라벨이 "${profile.targetProjectKey}" 가 아닌 미연결 티켓 ` +
          `${unlabeledCount}건은 이 프로필 대상이 아니라 제외했습니다`
      );
    }

    this.logger.success(
      `계획 수립 완료 - 대상에 생성 ${plan.createInTarget.length}건, ` +
        `${profile.sourceProjectKey} 에 생성 ${plan.createInSource.length}건, ` +
        `확인 필요 ${plan.conflicts.length}건, 이미 동일 ${plan.inSync.length}건` +
        (plan.skipped.length > 0 ? `, 범위 밖 ${plan.skipped.length}건` : '')
    );

    return plan;
  }

  /**
   * 담당자 accountId 를 대상 인스턴스 기준으로 변환한다.
   * 같은 사이트면 그대로, 다른 사이트면 users 테이블의 계정 매핑을 쓴다.
   */
  private async resolveAssigneeForInstance(
    accountId: string,
    fromInstance: 'ignite' | 'hmg',
    toInstance: 'ignite' | 'hmg'
  ): Promise<string> {
    if (fromInstance === toInstance) return accountId;

    const mapped =
      toInstance === 'hmg'
        ? await lookupHmgAccountId(accountId)
        : await lookupIgniteAccountId(accountId);

    if (!mapped) {
      // 필터 없이 진행하면 공용 프로젝트의 남의 팀 티켓까지 후보에 올라오므로 멈춘다.
      throw new AssigneeAccountNotMappedError(toInstance, accountId);
    }

    return mapped;
  }

  /** 스프린트 + 담당자 단위 티켓 조회 */
  private async fetchSprintTickets(
    projectKey: string,
    sprintId: number,
    instance: 'ignite' | 'hmg',
    assigneeAccountId: string,
    extraFields: string[]
  ): Promise<JiraIssue[]> {
    const jql =
      `project = ${projectKey} AND sprint = ${sprintId} ` +
      `AND assignee = "${assigneeAccountId}" ORDER BY updated DESC`;
    const result = await jira[instance].searchAllIssues(jql, extraFields);

    if (!result.success || !result.data) {
      throw new Error(`${projectKey} 스프린트 티켓 조회 실패: ${result.error ?? '알 수 없는 오류'}`);
    }

    return result.data.issues;
  }

  /** 소스 티켓을 정방향 매핑에 통과시킨 뒤 대상의 실제 값과 비교 */
  private async compare(
    sourceTicket: JiraIssue,
    targetTicket: JiraIssue,
    profileId: string,
    profile: SyncProfileInfo
  ): Promise<TicketComparison> {
    const mappings = await getFieldMappings(profileId);
    // 이름으로 해석하지 못해 빠진 값(스프린트/버전)을 로그로 드러낸다.
    // 경고를 안 받으면 매핑에서 조용히 빠진 값이 "대상에만 값이 있음" 으로 보여
    // 고칠 방법 없는 diff 가 계속 뜬다.
    const mappedSourceFields = await mapFieldsFromDb(
      sourceTicket,
      profileId,
      profile.targetProjectKey,
      {
        onWarning: (message) => {
          if (this.warnedMapping.has(message)) return;
          this.warnedMapping.add(message);
          this.logger.warning(`${sourceTicket.key}: ${message}`);
        },
      }
    );

    // 상태는 sync_profile_status_mappings 로 따로 관리된다.
    // 매핑이 없으면 비교에서 뺀다 - 고칠 방법이 없는 diff 를 띄우지 않기 위해서다.
    const sourceStatusId = sourceTicket.fields.status?.id;
    const mappedStatusId = sourceStatusId
      ? await getTargetStatusIdFromProfile(profileId, sourceStatusId)
      : null;

    const status = mappedStatusId
      ? {
          mappedSourceStatusId: mappedStatusId,
          sourceStatusName: sourceTicket.fields.status?.name,
          targetStatusId: targetTicket.fields.status?.id,
          targetStatusName: targetTicket.fields.status?.name,
        }
      : undefined;

    if (sourceStatusId && !mappedStatusId) {
      this.missingStatusMapping.add(sourceStatusId);
    }

    return compareMappedFields(mappings, mappedSourceFields, targetTicket.fields, status);
  }

  /** 상태 매핑이 없어 비교에서 뺀 소스 상태 id (경고를 한 번만 내기 위해 모은다) */
  private missingStatusMapping = new Set<string>();

  /** 같은 매핑 경고를 티켓마다 반복해 찍지 않기 위한 중복 제거 */
  private warnedMapping = new Set<string>();

  /**
   * 소스 티켓에 연결된 대상 티켓 키 목록 (결정 1 의 규칙 그대로)
   *  - 같은 사이트: Blocks 이슈 링크의 outwardIssue
   *  - 다른 사이트: 프로필의 link_field (기본 customfield_10438) 에 담긴 URL
   */
  private findLinkedTargetKeys(
    sourceTicket: JiraIssue,
    profile: SyncProfileInfo,
    sameSite: boolean
  ): string[] {
    if (sameSite) {
      return findBlocksOutwardKeys(sourceTicket, profile.targetProjectKey);
    }
    return extractLinkFieldKeys(sourceTicket, profile);
  }
}

function toRef(ticket: JiraIssue): TicketRef {
  return {
    key: ticket.key,
    summary: ticket.fields.summary,
    updated: ticket.fields.updated,
    statusName: ticket.fields.status?.name,
  };
}

function normalizeInstance(instance: string): 'ignite' | 'hmg' {
  return instance === 'hmg' ? 'hmg' : 'ignite';
}
