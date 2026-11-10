// 스프린트 매핑 로직 (캐싱 포함)

import { SprintInfo } from './types';
import { JiraClient } from '@/lib/services/jira/client';
import { dbServer } from '@/lib/db';
import {
  convertToFullYearMonth,
  extractSprintPeriod,
  formatYearMonth,
  pickScopedSprint,
} from './sprint-name';

// 이름/연월 계산은 순수 모듈에 모여 있다. 여기서 다시 내보내 기존 import 를 깨지 않는다.
export {
  addMonths,
  formatYearMonth,
  selectableYearMonths,
  sprintYearMonthOf,
} from './sprint-name';

/**
 * 스프린트 캐시 클래스
 * 동기화 세션 동안 스프린트 목록을 캐싱하여 API 호출 최소화
 * instance별로 구분하여 Ignite/HMG 모두 지원
 */
class SprintCache {
  private cache = new Map<string, SprintInfo[]>(); // key: "instance:boardId"

  async getSprintsForBoard(boardId: number, instance: 'ignite' | 'hmg' = 'ignite'): Promise<SprintInfo[]> {
    const key = `${instance}:${boardId}`;
    if (this.cache.has(key)) {
      return this.cache.get(key)!;
    }

    const sprints = await this.fetchSprints(boardId, instance);
    this.cache.set(key, sprints);
    return sprints;
  }

  /**
   * 보드의 active/future 스프린트를 모두 가져온다.
   *
   * **반드시 끝까지 페이지를 넘긴다.** 미래 스프린트까지 비교 대상이 되면서
   * 한 페이지(50개)만 받으면 몇 달 뒤 스프린트가 목록에서 빠져
   * "스프린트를 찾을 수 없습니다" 로 멈춘다.
   */
  private async fetchSprints(boardId: number, instance: 'ignite' | 'hmg'): Promise<SprintInfo[]> {
    try {
      const client = new JiraClient(instance);
      const pageSize = 50;
      const sprints: SprintInfo[] = [];

      for (let startAt = 0; ; startAt += pageSize) {
        const result = await client.get<{
          isLast?: boolean;
          values: Array<{
            id: number;
            name: string;
            state: 'active' | 'future' | 'closed';
          }>;
        }>(`agile/1.0/board/${boardId}/sprint`, {
          state: 'active,future',
          startAt: String(startAt),
          maxResults: String(pageSize),
        });

        const values = result.success ? (result.data?.values ?? []) : [];
        sprints.push(...values.map((sprint) => ({ ...sprint, boardId })));

        if (!result.success || result.data?.isLast !== false || values.length === 0) break;
      }

      return sprints;
    } catch {
      return [];
    }
  }

  clear() {
    this.cache.clear();
  }
}

// 싱글톤 인스턴스
const sprintCache = new SprintCache();

// 프로젝트별 board_id 캐시 (DB 조회 결과)
const boardIdCache = new Map<string, number>();

async function getBoardId(projectKey: string): Promise<number | null> {
  if (boardIdCache.has(projectKey)) {
    return boardIdCache.get(projectKey)!;
  }

  const { data } = await dbServer
    .from('projects')
    .select('board_id')
    .eq('name', projectKey)
    .single();

  if (data?.board_id) {
    boardIdCache.set(projectKey, data.board_id);
    return data.board_id;
  }
  return null;
}

// 프로젝트 키 → 스프린트 이름 prefix 매핑
// 프로젝트 키와 스프린트 prefix가 다른 경우 여기에 추가
const SPRINT_PREFIX_MAP: Record<string, string> = {
  AUTOWAY: 'GW',
  HMGBOARD: 'HB',
  MEMBERSHIP: 'HM',
};

/**
 * 대상 프로젝트의 스프린트 이름 생성
 * 예: "HB", "202511" → "HB 202511" / "AUTOWAY", "202511" → "GW 202511"
 */
export function buildTargetSprintName(projectKey: string, yearMonth: string): string {
  const prefix = SPRINT_PREFIX_MAP[projectKey] ?? projectKey;
  return `${prefix} ${yearMonth}`;
}

/**
 * 프로젝트의 특정 연월 스프린트를 조회한다.
 *
 * 결정 3: 대상 범위는 **고른 연월의 스프린트 하나**로 한정한다 (기본값은 현재 월).
 * **해당 스프린트가 없으면 null 을 반환한다 — 호출부는 오류로 처리하고 멈춰야 한다.**
 * (다른 스프린트로 대체하거나 전체를 훑는 폴백을 만들지 말 것)
 */
export async function findSprintByYearMonth(
  projectKey: string,
  instance: 'ignite' | 'hmg' = 'ignite',
  yearMonth: string = formatYearMonth()
): Promise<SprintInfo | null> {
  const boardId = await getBoardId(projectKey);
  if (!boardId) return null;

  const sprintName = buildTargetSprintName(projectKey, yearMonth);
  const sprints = await sprintCache.getSprintsForBoard(boardId, instance);

  return sprints.find((sprint) => sprint.name === sprintName) ?? null;
}

/**
 * 티켓의 스프린트 필드(배열)에서 기준 스프린트 하나를 고른다.
 * 규칙은 pickScopedSprint 에 있다 (비교 범위 안의 연월 → active → 첫 번째).
 */
export function pickSprint(
  sprints: Array<{ id: number; name: string; state?: string }> | undefined | null,
  preferredYearMonths?: readonly string[] | null
): { id: number; name: string } | null {
  if (!Array.isArray(sprints)) return null;
  return pickScopedSprint(sprints, preferredYearMonths);
}

/**
 * FEHG 스프린트를 대상 프로젝트 스프린트로 매핑
 * Ignite(KQ/HDD/HB) 및 HMG(AUTOWAY/HMGBOARD 등) 모두 지원
 */
export async function mapSprintToTarget(
  fehgSprintName: string | null,
  targetProject: string,
  instance: 'ignite' | 'hmg' = 'ignite'
): Promise<number | null> {
  if (!fehgSprintName) return null;

  // 1. FEHG 스프린트 이름에서 기간 추출
  const period = extractSprintPeriod(fehgSprintName);
  if (!period) return null;

  // 2. 전체 연월로 변환
  const fullYearMonth = convertToFullYearMonth(period);

  // 3. 대상 프로젝트 스프린트 이름 생성
  const targetSprintName = buildTargetSprintName(targetProject, fullYearMonth);

  // 4. 대상 보드의 스프린트 조회 (캐시 사용, instance별 클라이언트)
  const boardId = await getBoardId(targetProject);
  if (!boardId) return null;
  const targetSprints = await sprintCache.getSprintsForBoard(boardId, instance);

  // 5. 이름으로 매칭
  const matchedSprint = targetSprints.find(
    (sprint) => sprint.name === targetSprintName
  );

  return matchedSprint?.id || null;
}

/**
 * 캐시 초기화 (동기화 시작 시 호출)
 */
export function initSprintCache() {
  sprintCache.clear();
  boardIdCache.clear();
}

/**
 * 스프린트 캐시 프리로드 (선택적)
 */
export async function preloadSprintCache(
  projects: Array<{ key: string; instance: 'ignite' | 'hmg' }>
): Promise<void> {
  const entries = await Promise.all(
    projects.map(async ({ key, instance }) => ({ boardId: await getBoardId(key), instance }))
  );
  await Promise.all(
    entries
      .filter((e): e is { boardId: number; instance: 'ignite' | 'hmg' } => e.boardId !== null)
      .map(({ boardId, instance }) => sprintCache.getSprintsForBoard(boardId, instance))
  );
}
