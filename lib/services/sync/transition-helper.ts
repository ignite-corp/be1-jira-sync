/**
 * 동적 상태 전이(Transition) 헬퍼
 * BFS를 사용하여 현재 상태에서 타겟 상태까지의 최단 경로를 찾아 순차 실행
 */

import { STATUS_WORKFLOW, STATUS_TARGET_MAPPING } from '@/lib/constants/jira';
import { dbServer } from '@/lib/db';

export type JiraInstance = 'ignite' | 'hmg';

// DB 기반 캐시 (동기화 세션 동안 유지)
const dbStatusMappingCache = new Map<string, Record<string, string>>();
const dbWorkflowCache = new Map<string, Record<string, Record<string, string>>>();

// 역방향 상태 매핑 캐시 (대상 → 소스)
const dbReverseStatusMappingCache = new Map<string, Record<string, string>>();

export function clearTransitionCache() {
  dbStatusMappingCache.clear();
  dbReverseStatusMappingCache.clear();
  dbWorkflowCache.clear();
}

/**
 * DB에서 프로필별 **역방향** 상태 매핑 조회 (대상 상태 ID → 소스 상태 ID, 캐시)
 *
 * 결정 4 와 같은 원칙: 새 매핑을 만들지 않고 기존 sync_profile_status_mappings 를 역으로 읽는다.
 * 대상 상태 하나에 소스 상태가 여러 개 걸려 있으면 먼저 등록된 것을 쓴다.
 */
async function getDbReverseStatusMapping(
  profileId: string
): Promise<Record<string, string>> {
  if (dbReverseStatusMappingCache.has(profileId)) {
    return dbReverseStatusMappingCache.get(profileId)!;
  }

  const { data } = await dbServer
    .from('sync_profile_status_mappings')
    .select('source_status_id, target_status_id')
    .eq('profile_id', profileId);

  const mapping: Record<string, string> = {};
  data?.forEach((row) => {
    if (mapping[row.target_status_id] === undefined) {
      mapping[row.target_status_id] = row.source_status_id;
    }
  });

  dbReverseStatusMappingCache.set(profileId, mapping);
  return mapping;
}

/**
 * 대상 상태 ID에 대응하는 소스(BEDEV1) 상태 ID 반환
 * 예: KQ "완료"(6) → BEDEV1 "완료"(10770)
 */
export async function getSourceStatusIdFromProfile(
  profileId: string,
  targetStatusId: string
): Promise<string | null> {
  const mapping = await getDbReverseStatusMapping(profileId);
  return mapping[targetStatusId] || null;
}

/**
 * 사용 가능한 transition 을 Jira 에서 직접 조회해 목표 상태까지 이동한다.
 *
 * sync_profile_workflows 는 **대상 프로젝트의** 워크플로우만 담고 있어서
 * 역방향(BEDEV1 쪽으로 쓰기)에는 쓸 수 없다. 그래서 매번 조회해서 길을 찾는다.
 * 직접 가는 transition 이 없으면 미방문 중간 상태를 거쳐 재시도한다.
 */
export async function transitionToStatus(params: {
  issueKey: string;
  currentStatusId: string;
  targetStatusId: string;
  getTransitions: (issueKey: string) => Promise<Array<{ id: string; to?: { id?: string } }>>;
  executeTransition: (
    issueKey: string,
    transitionId: string
  ) => Promise<{ success: boolean; error?: string }>;
  logger?: {
    info: (msg: string) => void;
    warning: (msg: string) => void;
    success: (msg: string) => void;
  };
  maxSteps?: number;
}): Promise<TransitionResult> {
  const {
    issueKey,
    currentStatusId,
    targetStatusId,
    getTransitions,
    executeTransition,
    logger,
    maxSteps = 5,
  } = params;

  if (currentStatusId === targetStatusId) {
    return { success: true, stepsExecuted: 0, finalStatusId: targetStatusId };
  }

  let current = currentStatusId;
  const visited = new Set<string>([current]);
  let stepsExecuted = 0;

  for (let step = 0; step < maxSteps && current !== targetStatusId; step++) {
    const transitions = await getTransitions(issueKey);

    // 목표 상태로 바로 가는 전이 우선
    const direct = transitions.find((t) => t.to?.id === targetStatusId);
    if (direct) {
      const result = await executeTransition(issueKey, direct.id);
      if (!result.success) {
        return {
          success: false,
          stepsExecuted,
          error: result.error || `transition ${direct.id} 실패`,
        };
      }
      stepsExecuted++;
      current = targetStatusId;
      break;
    }

    // 직접 경로가 없으면 미방문 중간 상태로 한 칸 이동 후 재시도
    const intermediate = transitions.find((t) => t.to?.id && !visited.has(t.to.id));
    if (!intermediate) {
      return {
        success: false,
        stepsExecuted,
        error: `${current} → ${targetStatusId}: 전이 경로 없음`,
      };
    }

    const result = await executeTransition(issueKey, intermediate.id);
    if (!result.success) {
      return {
        success: false,
        stepsExecuted,
        error: result.error || `중간 transition ${intermediate.id} 실패`,
      };
    }

    stepsExecuted++;
    current = intermediate.to!.id!;
    visited.add(current);
  }

  if (current !== targetStatusId) {
    return {
      success: false,
      stepsExecuted,
      error: `${maxSteps}단계 안에 ${targetStatusId} 에 도달하지 못했습니다 (현재 ${current})`,
    };
  }

  logger?.success(`${issueKey}: 상태 동기화 완료 → ${targetStatusId} (${stepsExecuted}단계)`);
  return { success: true, stepsExecuted, finalStatusId: targetStatusId };
}

/**
 * DB에서 프로필별 상태 매핑 조회 (캐시)
 */
async function getDbStatusMapping(profileId: string): Promise<Record<string, string>> {
  if (dbStatusMappingCache.has(profileId)) {
    return dbStatusMappingCache.get(profileId)!;
  }

  const { data } = await dbServer
    .from('sync_profile_status_mappings')
    .select('source_status_id, target_status_id')
    .eq('profile_id', profileId);

  const mapping: Record<string, string> = {};
  data?.forEach((row) => {
    mapping[row.source_status_id] = row.target_status_id;
  });

  dbStatusMappingCache.set(profileId, mapping);
  return mapping;
}

/**
 * DB에서 프로필별 워크플로우 그래프 조회 (캐시)
 */
async function getDbWorkflow(profileId: string): Promise<Record<string, Record<string, string>>> {
  if (dbWorkflowCache.has(profileId)) {
    return dbWorkflowCache.get(profileId)!;
  }

  const { data } = await dbServer
    .from('sync_profile_workflows')
    .select('from_status_id, to_status_id, transition_id')
    .eq('profile_id', profileId);

  const workflow: Record<string, Record<string, string>> = {};
  data?.forEach((row) => {
    if (!workflow[row.from_status_id]) {
      workflow[row.from_status_id] = {};
    }
    workflow[row.from_status_id][row.to_status_id] = row.transition_id;
  });

  dbWorkflowCache.set(profileId, workflow);
  return workflow;
}

/**
 * DB 기반 BFS 경로 탐색
 */
export async function findTransitionPathFromDb(
  profileId: string,
  currentStatusId: string,
  targetStatusId: string
): Promise<TransitionPath | null> {
  if (currentStatusId === targetStatusId) {
    return { statusPath: [], transitionPath: [] };
  }

  const workflow = await getDbWorkflow(profileId);

  const queue: Array<{ statusId: string; path: string[]; transitions: string[] }> = [
    { statusId: currentStatusId, path: [], transitions: [] },
  ];
  const visited = new Set<string>([currentStatusId]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const nextTransitions = workflow[current.statusId];
    if (!nextTransitions) continue;

    for (const [nextStatusId, transitionId] of Object.entries(nextTransitions)) {
      if (visited.has(nextStatusId)) continue;

      const newPath = [...current.path, nextStatusId];
      const newTransitions = [...current.transitions, transitionId];

      if (nextStatusId === targetStatusId) {
        return { statusPath: newPath, transitionPath: newTransitions };
      }

      visited.add(nextStatusId);
      queue.push({ statusId: nextStatusId, path: newPath, transitions: newTransitions });
    }
  }

  return null;
}

/**
 * DB에서 FEHG 상태 ID에 매핑된 타겟 상태 ID 반환
 */
export async function getTargetStatusIdFromProfile(
  profileId: string,
  fehgStatusId: string
): Promise<string | null> {
  const mapping = await getDbStatusMapping(profileId);
  return mapping[fehgStatusId] || null;
}

/**
 * DB 기반 상태 동기화 통합 함수
 */
export async function syncStatusWithPathFromDb(
  profileId: string,
  issueKey: string,
  fehgStatusId: string,
  currentTargetStatusId: string,
  executeTransition: (issueKey: string, transitionId: string) => Promise<{ success: boolean; error?: string }>,
  logger?: { info: (msg: string) => void; error: (msg: string) => void; success: (msg: string) => void }
): Promise<TransitionResult> {
  const mapping = await getDbStatusMapping(profileId);
  const targetStatusId = mapping[fehgStatusId] || null;

  if (!targetStatusId) {
    const error = `${fehgStatusId}: 매핑된 타겟 상태 없음 (DB)`;
    logger?.error(`${issueKey}: ${error}`);
    return { success: false, stepsExecuted: 0, error };
  }

  if (currentTargetStatusId === targetStatusId) {
    logger?.info(`${issueKey}: 이미 타겟 상태 (${targetStatusId})`);
    return { success: true, stepsExecuted: 0, finalStatusId: targetStatusId };
  }

  const path = await findTransitionPathFromDb(profileId, currentTargetStatusId, targetStatusId);

  if (!path) {
    const error = `${currentTargetStatusId} → ${targetStatusId}: 전이 경로 없음 (DB)`;
    logger?.error(`${issueKey}: ${error}`);
    return { success: false, stepsExecuted: 0, error };
  }

  logger?.info(
    `${issueKey}: 상태 전이 경로 발견 (${path.transitionPath.length}단계: ${path.transitionPath.join(' → ')})`
  );

  const result = await executeTransitionPath(issueKey, path.transitionPath, executeTransition);

  if (result.success) {
    logger?.success(`${issueKey}: 상태 동기화 완료 (${result.stepsExecuted}단계 실행)`);
  } else {
    logger?.error(`${issueKey}: 상태 동기화 실패 - ${result.error}`);
  }

  return result;
}

interface TransitionPath {
  /** 거쳐야 할 상태 ID 목록 (현재 상태 제외, 타겟 상태 포함) */
  statusPath: string[];
  /** 실행해야 할 transition ID 목록 */
  transitionPath: string[];
}

interface TransitionResult {
  success: boolean;
  stepsExecuted: number;
  finalStatusId?: string;
  error?: string;
}

/**
 * BFS로 현재 상태에서 타겟 상태까지의 최단 경로 탐색
 */
export function findTransitionPath(
  instance: JiraInstance,
  currentStatusId: string,
  targetStatusId: string
): TransitionPath | null {
  // 이미 타겟 상태인 경우
  if (currentStatusId === targetStatusId) {
    return { statusPath: [], transitionPath: [] };
  }

  const workflow = STATUS_WORKFLOW[instance.toUpperCase() as 'IGNITE' | 'HMG'];
  if (!workflow) {
    return null;
  }

  // BFS 탐색
  const queue: Array<{ statusId: string; path: string[]; transitions: string[] }> = [
    { statusId: currentStatusId, path: [], transitions: [] },
  ];
  const visited = new Set<string>([currentStatusId]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    const nextTransitions = workflow[current.statusId];

    if (!nextTransitions) continue;

    for (const [nextStatusId, transitionId] of Object.entries(nextTransitions)) {
      if (visited.has(nextStatusId)) continue;

      const newPath = [...current.path, nextStatusId];
      const newTransitions = [...current.transitions, transitionId];

      // 타겟 도달
      if (nextStatusId === targetStatusId) {
        return {
          statusPath: newPath,
          transitionPath: newTransitions,
        };
      }

      visited.add(nextStatusId);
      queue.push({
        statusId: nextStatusId,
        path: newPath,
        transitions: newTransitions,
      });
    }
  }

  // 경로 없음
  return null;
}

/**
 * FEHG 상태 ID를 타겟 인스턴스의 상태 ID로 매핑
 */
export function getTargetStatusId(
  instance: JiraInstance,
  fehgStatusId: string
): string | null {
  const mapping = STATUS_TARGET_MAPPING[instance.toUpperCase() as 'IGNITE' | 'HMG'];
  return mapping?.[fehgStatusId] || null;
}

/**
 * 순차적으로 transition 실행
 * @param issueKey 이슈 키
 * @param transitionPath 실행할 transition ID 목록
 * @param executeTransition transition 실행 함수 (의존성 주입)
 * @param getCurrentStatus 현재 상태 조회 함수 (의존성 주입, 검증용)
 * @param delayMs 각 transition 사이 딜레이 (ms)
 */
export async function executeTransitionPath(
  issueKey: string,
  transitionPath: string[],
  executeTransition: (issueKey: string, transitionId: string) => Promise<{ success: boolean; error?: string }>,
  getCurrentStatus?: (issueKey: string) => Promise<string | null>,
  delayMs: number = 100
): Promise<TransitionResult> {
  if (transitionPath.length === 0) {
    return { success: true, stepsExecuted: 0 };
  }

  let stepsExecuted = 0;

  for (const transitionId of transitionPath) {
    try {
      const result = await executeTransition(issueKey, transitionId);

      if (!result.success) {
        return {
          success: false,
          stepsExecuted,
          error: result.error || `Transition ${transitionId} 실패`,
        };
      }

      stepsExecuted++;

      // 다음 transition 전 약간의 딜레이 (Jira API 안정성)
      if (stepsExecuted < transitionPath.length && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    } catch (error) {
      return {
        success: false,
        stepsExecuted,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // 최종 상태 검증 (선택적)
  let finalStatusId: string | undefined;
  if (getCurrentStatus) {
    finalStatusId = (await getCurrentStatus(issueKey)) || undefined;
  }

  return {
    success: true,
    stepsExecuted,
    finalStatusId,
  };
}

/**
 * 상태 동기화 통합 함수
 * FEHG 상태 ID를 받아서 타겟 인스턴스의 이슈를 해당 상태로 전이
 */
export async function syncStatusWithPath(
  instance: JiraInstance,
  issueKey: string,
  fehgStatusId: string,
  currentTargetStatusId: string,
  executeTransition: (issueKey: string, transitionId: string) => Promise<{ success: boolean; error?: string }>,
  logger?: { info: (msg: string) => void; error: (msg: string) => void; success: (msg: string) => void }
): Promise<TransitionResult> {
  // 1. FEHG 상태 → 타겟 상태 매핑
  const targetStatusId = getTargetStatusId(instance, fehgStatusId);

  if (!targetStatusId) {
    const error = `${fehgStatusId}: 매핑된 타겟 상태 없음`;
    logger?.error(`${issueKey}: ${error}`);
    return { success: false, stepsExecuted: 0, error };
  }

  // 2. 이미 타겟 상태인 경우 스킵
  if (currentTargetStatusId === targetStatusId) {
    logger?.info(`${issueKey}: 이미 타겟 상태 (${targetStatusId})`);
    return { success: true, stepsExecuted: 0, finalStatusId: targetStatusId };
  }

  // 3. 경로 탐색
  const path = findTransitionPath(instance, currentTargetStatusId, targetStatusId);

  if (!path) {
    const error = `${currentTargetStatusId} → ${targetStatusId}: 전이 경로 없음`;
    logger?.error(`${issueKey}: ${error}`);
    return { success: false, stepsExecuted: 0, error };
  }

  logger?.info(
    `${issueKey}: 상태 전이 경로 발견 (${path.transitionPath.length}단계: ${path.transitionPath.join(' → ')})`
  );

  // 4. 순차 실행
  const result = await executeTransitionPath(issueKey, path.transitionPath, executeTransition);

  if (result.success) {
    logger?.success(`${issueKey}: 상태 동기화 완료 (${result.stepsExecuted}단계 실행)`);
  } else {
    logger?.error(`${issueKey}: 상태 동기화 실패 - ${result.error}`);
  }

  return result;
}
