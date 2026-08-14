// 스프린트 매핑 로직 (캐싱 포함)

import { SprintInfo } from './types';
import { JiraClient } from '@/lib/services/jira/client';
import { dbServer } from '@/lib/db';

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

  private async fetchSprints(boardId: number, instance: 'ignite' | 'hmg'): Promise<SprintInfo[]> {
    try {
      const client = new JiraClient(instance);
      const result = await client.get<{
        values: Array<{
          id: number;
          name: string;
          state: 'active' | 'future' | 'closed';
        }>;
      }>(`agile/1.0/board/${boardId}/sprint`, {
        state: 'active,future',
        maxResults: '50',
      });

      if (result.success && result.data?.values) {
        return result.data.values.map((sprint) => ({
          ...sprint,
          boardId,
        }));
      }
      return [];
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

/**
 * 소스 프로젝트 스프린트 이름에서 기간 추출
 * 예: "FEHG 2511" → "2511", "DEVBE1 202511" → "202511"
 */
function extractSprintPeriod(sprintName: string): string | null {
  const match = sprintName.match(/(?<=\s)(\d+)\s*$/);
  return match ? match[1] : null;
}

/**
 * 기간을 전체 연월 형식으로 변환
 * 예: "2511" → "202511"
 */
function convertToFullYearMonth(period: string): string {
  if (period.length === 4) {
    return '20' + period;
  }
  return period;
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
 * 날짜를 스프린트 이름에 쓰는 연월 형식(YYYYMM)으로 변환
 * 예: 2026-08-13 → "202608"
 */
export function formatYearMonth(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${year}${month}`;
}

/**
 * 프로젝트의 현재 월 스프린트를 조회한다.
 *
 * 결정 3: 대상 범위는 현재 스프린트로 한정한다. 스프린트 이름은 현재 월 형식이다.
 * **현재 월 스프린트가 없으면 null 을 반환한다 — 호출부는 오류로 처리하고 멈춰야 한다.**
 * (다른 스프린트로 대체하거나 전체를 훑는 폴백을 만들지 말 것)
 */
export async function findCurrentMonthSprint(
  projectKey: string,
  instance: 'ignite' | 'hmg' = 'ignite',
  now: Date = new Date()
): Promise<SprintInfo | null> {
  const boardId = await getBoardId(projectKey);
  if (!boardId) return null;

  const sprintName = buildTargetSprintName(projectKey, formatYearMonth(now));
  const sprints = await sprintCache.getSprintsForBoard(boardId, instance);

  return sprints.find((sprint) => sprint.name === sprintName) ?? null;
}

/**
 * 프로젝트의 현재 월 스프린트 이름 (조회 없이 이름만 필요할 때)
 */
export function currentMonthSprintName(projectKey: string, now: Date = new Date()): string {
  return buildTargetSprintName(projectKey, formatYearMonth(now));
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
