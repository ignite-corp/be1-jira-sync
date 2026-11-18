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
  buildTargetSprintName,
  findSprintByYearMonth,
  formatYearMonth,
  initSprintCache,
} from './sprint-mapper';
import type { SprintInfo } from './types';
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
import { classifyIssueKind } from './issue-type-resolver';
import { getTargetStatusIdFromProfile } from './transition-helper';

export { extractLinkFieldKeys, findBlocksOutwardKeys, findLinkedSourceKeys };

export type SyncDirection = 'sourceToTarget' | 'targetToSource';

export interface TicketRef {
  key: string;
  summary: string;
  updated?: string;
  statusName?: string;
  /** Jira 상태 카테고리 키 (new | indeterminate | done) - 색 구분용, 언어 무관 */
  statusCategoryKey?: string;
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
  /** 실제로 비교한 연월 목록 (YYYYMM) - 양쪽에 스프린트가 다 있는 달만 들어간다 */
  sprintYearMonths: string[];
  /** 비교한 소스 스프린트 이름들 (연월 순) */
  sourceSprintNames: string[];
  /** 비교한 대상 스프린트 이름들 (연월 순) */
  targetSprintNames: string[];
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
  /**
   * 비교할 스프린트의 연월 목록 (YYYYMM, 예: ["202611", "202612"]).
   * 없으면 현재 월 하나만. 현재 월부터 미래 N개월까지 한 번에 줄 수 있다.
   * 양쪽에 스프린트가 다 있는 달만 실제 비교 대상이 된다.
   */
  yearMonths?: readonly string[];
  /** 현재 월 판정 기준 시각 (테스트용) */
  now?: Date;
}

/**
 * 비교 대상으로 고른 스프린트를 못 찾았을 때 던지는 오류.
 * 결정 3: 다른 스프린트로 대체하거나 전체를 훑는 폴백을 만들지 않는다.
 */
export class SprintNotFoundError extends Error {
  constructor(
    public readonly projectKey: string,
    public readonly expectedSprintName: string
  ) {
    super(
      `${projectKey}: 스프린트 "${expectedSprintName}" 를 찾을 수 없습니다. 스프린트를 먼저 만들어 주세요.`
    );
    this.name = 'SprintNotFoundError';
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
    this.parentCache.clear();

    const now = options.now ?? new Date();
    // 고르지 않으면 현재 월 하나. 범위를 주면 그 달들의 스프린트를 모두 비교한다.
    const requestedYearMonths =
      options.yearMonths && options.yearMonths.length > 0
        ? [...options.yearMonths].sort()
        : [formatYearMonth(now)];

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

    // 1. 고른 달들의 스프린트를 양쪽에서 찾는다.
    //
    // 결정 3 유지: 스프린트가 없으면 다른 스프린트로 대체하거나 전체를 훑지 않는다.
    // 다만 범위 비교에서는 **한쪽에만 없는 달은 건너뛰고** 나머지 달을 계속 본다.
    // (미래 스프린트는 아직 안 만들어진 달이 섞여 있는 것이 정상이다)
    // 쓸 수 있는 달이 하나도 없을 때만 오류로 멈춘다.
    const sprintPairs: Array<{
      yearMonth: string;
      source: SprintInfo;
      target: SprintInfo;
    }> = [];

    for (const yearMonth of requestedYearMonths) {
      const [source, target] = await Promise.all([
        findSprintByYearMonth(profile.sourceProjectKey, sourceInstance, yearMonth),
        findSprintByYearMonth(profile.targetProjectKey, targetInstance, yearMonth),
      ]);

      if (source && target) {
        sprintPairs.push({ yearMonth, source, target });
        continue;
      }

      const missing = [
        !source ? `${profile.sourceProjectKey} "${buildTargetSprintName(profile.sourceProjectKey, yearMonth)}"` : null,
        !target ? `${profile.targetProjectKey} "${buildTargetSprintName(profile.targetProjectKey, yearMonth)}"` : null,
      ].filter(Boolean);

      this.logger.info(`${yearMonth}: 스프린트가 없어 건너뜁니다 (${missing.join(', ')})`);
    }

    if (sprintPairs.length === 0) {
      // 어느 달도 양쪽에 다 있지 않다 - 가장 앞선 달 기준으로 무엇이 없는지 알린다.
      const firstYearMonth = requestedYearMonths[0];
      const firstSource = await findSprintByYearMonth(
        profile.sourceProjectKey,
        sourceInstance,
        firstYearMonth
      );
      throw new SprintNotFoundError(
        firstSource ? profile.targetProjectKey : profile.sourceProjectKey,
        buildTargetSprintName(
          firstSource ? profile.targetProjectKey : profile.sourceProjectKey,
          firstYearMonth
        )
      );
    }

    const yearMonths = sprintPairs.map((p) => p.yearMonth);
    const sourceSprintNames = sprintPairs.map((p) => p.source.name);
    const targetSprintNames = sprintPairs.map((p) => p.target.name);

    this.logger.info(
      `스프린트 확인 (${sprintPairs.length}개 달): ` +
        sprintPairs.map((p) => `"${p.source.name}" ↔ "${p.target.name}"`).join(', ')
    );

    // 2. 양쪽 티켓 조회 (비교 범위의 스프린트 전체 + 담당자로 한정)
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
        sprintPairs.map((p) => p.source.id),
        sourceInstance,
        sourceAssigneeId,
        sourceExtraFields
      ),
      this.fetchSprintTickets(
        profile.targetProjectKey,
        sprintPairs.map((p) => p.target.id),
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
    const sourceByKey = new Map(sourceTickets.map((t) => [t.key, t]));
    const linkedTargetKeys = new Set<string>();

    const plan: BidirectionalPlan = {
      profileId,
      profileName: profile.name,
      sourceProjectKey: profile.sourceProjectKey,
      targetProjectKey: profile.targetProjectKey,
      sourceInstance,
      targetInstance,
      sameSite,
      sprintYearMonths: yearMonths,
      sourceSprintNames,
      targetSprintNames,
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
        const belongs = await this.belongsToProfile(
          sourceTicket,
          profile,
          sourceInstance,
          sourceByKey
        );
        if (!belongs) {
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
          // 연결은 돼 있으나 대상의 비교 스프린트 밖 → 범위 밖이므로 건드리지 않는다.
          // (여기서 생성해 버리면 중복 티켓이 생긴다)
          plan.skipped.push({
            key: `${sourceTicket.key} → ${targetKey}`,
            reason: `연결된 대상 티켓이 비교 범위(${targetSprintNames.join(', ')}) 밖입니다`,
          });
          continue;
        }

        // 요구사항 3: 양쪽에 다 있음 → 매핑된 내용 비교
        const comparison = await this.compare(
          sourceTicket,
          targetTicket,
          profileId,
          profile,
          yearMonths
        );

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
          // 소스에는 연결이 있으나 소스의 비교 스프린트 밖
          plan.skipped.push({
            key: `${targetTicket.key} → ${inwardSourceKeys.join(', ')}`,
            reason: `연결된 ${profile.sourceProjectKey} 티켓이 비교 범위(${sourceSprintNames.join(', ')}) 밖입니다`,
          });
          continue;
        }
      }
      // 다른 사이트: HMG 티켓에는 역참조가 없으므로 소스 링크 집합과의 차집합이 곧 미연결이다.

      plan.createInSource.push({ ticket: toRef(targetTicket), raw: targetTicket });
    }

    // 하위 작업은 부모가 대상에 먼저 있어야 만들 수 있다.
    // "전체 생성" 이 위에서부터 도는 것을 고려해 에픽 → 일반 → 하위작업 순으로 정렬해 둔다.
    sortParentsFirst(plan.createInTarget);
    sortParentsFirst(plan.createInSource);

    if (this.missingStatusMapping.size > 0) {
      this.logger.warning(
        `상태 매핑이 없는 소스 상태 ${this.missingStatusMapping.size}개는 상태 비교에서 제외했습니다 ` +
          `(상태 id: ${[...this.missingStatusMapping].join(', ')})`
      );
    }

    if (unlabeledCount > 0) {
      this.logger.info(
        `${profile.sourceProjectKey}: 라벨이 "${profile.targetProjectKey}" 가 아닌 미연결 티켓 ` +
          `${unlabeledCount}건은 이 프로필 대상이 아니라 제외했습니다 ` +
          `(하위 작업은 부모의 라벨로 판정합니다)`
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

  /**
   * 이 소스 티켓이 이 프로필(대상 프로젝트)의 것인지 판정한다.
   *
   * 기본은 프로젝트 라벨이다. 다만 **하위 작업에는 라벨을 달지 않는 것이 보통**이라
   * (실측: BEDEV1-983 은 labels=[] 이고 부모 BEDEV1-971 에만 MEMBERSHIP 라벨이 있다)
   * 라벨이 없는 하위 작업은 **부모의 라벨**을 따른다. 그러지 않으면 하위 작업이
   * 조용히 비교 목록에서 빠져 "만들었는데 안 뜬다" 가 된다.
   */
  private async belongsToProfile(
    ticket: JiraIssue,
    profile: SyncProfileInfo,
    sourceInstance: 'ignite' | 'hmg',
    sourceByKey: Map<string, JiraIssue>
  ): Promise<boolean> {
    if (hasProjectLabel(ticket.fields.labels, profile.targetProjectKey)) return true;

    if (classifyIssueKind(ticket.fields.issuetype) !== 'subtask') return false;

    const parentKey = ticket.fields.parent?.key;
    if (!parentKey) return false;

    const parent =
      sourceByKey.get(parentKey) ?? (await this.fetchParent(sourceInstance, parentKey));
    if (!parent) return false;

    return hasProjectLabel(parent.fields.labels, profile.targetProjectKey);
  }

  /** 부모 티켓 캐시 (계획 수립 1회 동안만 - 같은 부모를 여러 하위 작업이 공유한다) */
  private parentCache = new Map<string, JiraIssue | null>();

  /** 부모 티켓 조회 */
  private async fetchParent(
    instance: 'ignite' | 'hmg',
    parentKey: string
  ): Promise<JiraIssue | null> {
    const cacheKey = `${instance}:${parentKey}`;
    if (this.parentCache.has(cacheKey)) return this.parentCache.get(cacheKey)!;

    const result = await jira[instance].searchAllIssues(`key = ${parentKey}`);
    const parent = result.success ? (result.data?.issues?.[0] ?? null) : null;

    if (!parent) {
      this.logger.warning(`${parentKey}: 부모 티켓 조회 실패 - 하위 작업 판정에서 제외합니다`);
    }
    this.parentCache.set(cacheKey, parent);
    return parent;
  }

  /**
   * 스프린트(여러 개 가능) + 담당자 단위 티켓 조회.
   * 여러 달을 비교할 때도 질의는 한 번만 날린다 (sprint IN (...)).
   * 같은 티켓이 범위 안 두 스프린트에 걸쳐 있어도 Jira 가 한 번만 돌려준다.
   */
  private async fetchSprintTickets(
    projectKey: string,
    sprintIds: number[],
    instance: 'ignite' | 'hmg',
    assigneeAccountId: string,
    extraFields: string[]
  ): Promise<JiraIssue[]> {
    const jql =
      `project = ${projectKey} AND sprint IN (${sprintIds.join(', ')}) ` +
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
    profile: SyncProfileInfo,
    sprintYearMonths: readonly string[]
  ): Promise<TicketComparison> {
    const mappings = await getFieldMappings(profileId);
    // 하위 작업/에픽에는 스프린트 필드가 없다 - 비교에서 빼지 않으면 고칠 수 없는 diff 가 계속 뜬다
    const skipSprint =
      classifyIssueKind(sourceTicket.fields.issuetype) !== 'standard' ||
      classifyIssueKind(targetTicket.fields.issuetype) !== 'standard';
    // 이름으로 해석하지 못해 빠진 값(스프린트/버전)을 로그로 드러낸다.
    // 경고를 안 받으면 매핑에서 조용히 빠진 값이 "대상에만 값이 있음" 으로 보여
    // 고칠 방법 없는 diff 가 계속 뜬다.
    const mappedSourceFields = await mapFieldsFromDb(
      sourceTicket,
      profileId,
      profile.targetProjectKey,
      {
        sprintYearMonths,
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

    return compareMappedFields(mappings, mappedSourceFields, targetTicket.fields, status, {
      sprintYearMonths,
      skipSprint,
    });
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

/** 생성 순서: 에픽 → 일반 → 하위작업 (부모가 먼저 만들어지도록) */
function sortParentsFirst(items: MissingItem[]): void {
  const rank = (item: MissingItem) => {
    const kind = classifyIssueKind(item.raw.fields.issuetype);
    return kind === 'epic' ? 0 : kind === 'subtask' ? 2 : 1;
  };
  items.sort((a, b) => rank(a) - rank(b));
}

function toRef(ticket: JiraIssue): TicketRef {
  return {
    key: ticket.key,
    summary: ticket.fields.summary,
    updated: ticket.fields.updated,
    statusName: ticket.fields.status?.name,
    statusCategoryKey: ticket.fields.status?.statusCategory?.key,
  };
}

function normalizeInstance(instance: string): 'ignite' | 'hmg' {
  return instance === 'hmg' ? 'hmg' : 'ignite';
}
