// DB 기반 필드 매핑 로직
// sync_field_mappings 테이블에서 매핑 규칙을 읽어 필드를 변환

import { JiraIssue } from '@/lib/types/jira';
import { dbServer } from '@/lib/db';
import { mapSprintToTarget } from './sprint-mapper';
import { JiraClient } from '@/lib/services/jira/client';

export interface DbFieldMapping {
  source_field: string;
  target_field: string;
  transform_type: string; // 'copy' | 'sprint_map' | 'account_map' | 'custom'
  transform_config: Record<string, unknown> | null;
  source_field_name?: string;
  target_field_name?: string;
}

// 프로필별 매핑 캐시 (동기화 세션 동안 유지)
const mappingCache = new Map<string, DbFieldMapping[]>();

/**
 * 프로필의 필드 매핑 조회 (캐시)
 *
 * 양방향 비교(ticket-comparator)와 역매핑(reverse-field-mapper)도 같은 캐시를 쓴다.
 */
export async function getFieldMappings(profileId: string): Promise<DbFieldMapping[]> {
  if (mappingCache.has(profileId)) {
    return mappingCache.get(profileId)!;
  }

  const { data } = await dbServer
    .from('sync_field_mappings')
    .select(
      'source_field, source_field_name, target_field, target_field_name, transform_type, transform_config'
    )
    .eq('profile_id', profileId);

  const mappings = data || [];
  mappingCache.set(profileId, mappings);
  return mappings;
}

/**
 * DB 매핑 캐시 초기화
 */
export function clearDbMappingCache() {
  mappingCache.clear();
  accountMapCache.clear();
  reverseAccountMapCache.clear();
  profileInfoCache.clear();
  versionCache.clear();
}

// 프로젝트 버전 캐시 (동기화 세션 동안 유지)
const versionCache = new Map<string, Array<{ id: string; name: string }>>();

export async function getProjectVersions(
  projectKey: string,
  instance: 'ignite' | 'hmg'
): Promise<Array<{ id: string; name: string }>> {
  const cacheKey = `${instance}:${projectKey}`;
  if (versionCache.has(cacheKey)) {
    return versionCache.get(cacheKey)!;
  }

  const client = new JiraClient(instance);
  const result = await client.get<Array<{ id: string; name: string }>>(
    `project/${projectKey}/versions`
  );

  const versions = result.success && result.data ? result.data : [];
  versionCache.set(cacheKey, versions);
  return versions;
}

// 프로젝트 이름 → Jira 프로젝트 숫자 id 캐시 (버전 생성에 필요)
const projectIdCache = new Map<string, string | null>();

async function getJiraProjectId(projectKey: string): Promise<string | null> {
  if (projectIdCache.has(projectKey)) {
    return projectIdCache.get(projectKey)!;
  }

  const { data } = await dbServer
    .from('projects')
    .select('jira_project_id')
    .eq('name', projectKey)
    .single();

  const id = data?.jira_project_id ?? null;
  projectIdCache.set(projectKey, id);
  return id;
}

/** 상대 프로젝트에 없는 수정 버전을 새로 만든다 */
export interface CreateVersionInput {
  name: string;
  description?: string;
  releaseDate?: string;
  released?: boolean;
}

/**
 * 이름으로 버전을 찾고, 없으면 만들어서 돌려준다.
 *
 * 버전 id 는 프로젝트마다 달라 이름으로 맞추는데, 프로젝트마다 명명 규칙이 달라
 * 상대 쪽에 같은 이름이 없는 경우가 실제로 있다 (예: AUTOWAY "release_260730" 은 BEDEV1 에 없음).
 * 그때 값이 조용히 빠지지 않도록 버전을 생성한다.
 *
 * **읽기 전용 경로(계획 수립)에서는 절대 호출하면 안 된다.** 프로젝트 설정을 바꾸는 쓰기다.
 * archived 는 따라 만들지 않는다 - 보관된 버전은 티켓에 지정할 수 없다.
 */
export async function findOrCreateProjectVersion(
  projectKey: string,
  instance: 'ignite' | 'hmg',
  input: CreateVersionInput
): Promise<{ id: string; name: string } | null> {
  const existing = (await getProjectVersions(projectKey, instance)).find(
    (v) => v.name === input.name
  );
  if (existing) return existing;

  const projectId = await getJiraProjectId(projectKey);
  if (!projectId) return null;

  const client = new JiraClient(instance);
  const result = await client.post<{ id: string; name: string }>('version', {
    name: input.name,
    projectId: Number(projectId),
    ...(input.description ? { description: input.description } : {}),
    ...(input.releaseDate ? { releaseDate: input.releaseDate } : {}),
    ...(input.released !== undefined ? { released: input.released } : {}),
  });

  if (!result.success || !result.data) return null;

  // 같은 세션에서 또 찾을 수 있게 캐시에 넣어 준다
  const created = { id: result.data.id, name: result.data.name };
  const cacheKey = `${instance}:${projectKey}`;
  versionCache.set(cacheKey, [...(versionCache.get(cacheKey) ?? []), created]);

  return created;
}

/** 매퍼 동작 옵션 */
export interface FieldMapOptions {
  /** 이름으로 해석하지 못해 빠진 값을 알린다 */
  onWarning?: (message: string) => void;
  /**
   * 상대 프로젝트에 없는 수정 버전을 새로 만든다.
   * 프로젝트 설정을 바꾸므로 **실제 쓰기 경로에서만** 켠다. 계획 수립에서는 꺼 둔다.
   */
  createMissingVersions?: boolean;
}

/**
 * 이름 기준으로 버전을 상대 프로젝트의 id 로 변환한다.
 * 정방향/역방향이 같은 규칙을 쓰도록 여기 하나로 모았다.
 */
export async function resolveVersionsByName(
  versions: Array<{ id: string; name: string; description?: string; releaseDate?: string; released?: boolean }> | undefined,
  projectKey: string,
  instance: 'ignite' | 'hmg',
  options?: FieldMapOptions
): Promise<Array<{ id: string }> | null> {
  if (!Array.isArray(versions) || versions.length === 0) return null;

  const projectVersions = await getProjectVersions(projectKey, instance);

  const matched: Array<{ id: string }> = [];
  const unmatched: string[] = [];

  for (const v of versions) {
    const found = projectVersions.find((pv) => pv.name === v.name);
    if (found) {
      matched.push({ id: found.id });
      continue;
    }

    if (options?.createMissingVersions) {
      const created = await findOrCreateProjectVersion(projectKey, instance, {
        name: v.name,
        description: v.description,
        releaseDate: v.releaseDate,
        released: v.released,
      });
      if (created) {
        matched.push({ id: created.id });
        options.onWarning?.(
          `수정 버전 "${v.name}" 이(가) ${projectKey} 에 없어 새로 만들었습니다`
        );
        continue;
      }
    }

    unmatched.push(v.name);
  }

  if (unmatched.length > 0) {
    options?.onWarning?.(
      `수정 버전 ${unmatched.map((n) => `"${n}"`).join(', ')} 은(는) ${projectKey} 에 없어 반영하지 못했습니다.`
    );
  }

  return matched.length > 0 ? matched : null;
}

/**
 * DB 기반 필드 매핑 실행
 * sync_field_mappings에 저장된 규칙에 따라 FEHG 티켓 필드를 대상 필드로 변환
 */
export async function mapFieldsFromDb(
  fehgTicket: JiraIssue,
  profileId: string,
  targetProjectKey: string,
  options?: FieldMapOptions
): Promise<Record<string, unknown>> {
  const onWarning = options?.onWarning;
  const mappings = await getFieldMappings(profileId);
  const profileInfo = await getSyncProfileInfo(profileId);
  const isHmgTarget = profileInfo?.targetInstance === 'hmg';
  const fields: Record<string, unknown> = {};
  const fehgFields = fehgTicket.fields;

  for (const mapping of mappings) {
    const { source_field, target_field, transform_type } = mapping;

    switch (transform_type) {
      case 'copy': {
        // 단순 복사
        const value = getFieldValue(fehgTicket, fehgFields, source_field);

        if (source_field === 'description' && target_field === 'description' && isHmgTarget) {
          if (value !== undefined && value !== null) {
            fields[target_field] = removeMediaSingleNodes(value);
          }
          break;
        }

        // HMG 프로젝트(AUTOWAY, HMGBOARD 등)의 사용자 필드: Ignite → HMG 계정 매핑
        if ((source_field === 'assignee' || source_field === 'reporter') && isHmgTarget) {
          const sourceValue = getFieldValue(fehgTicket, fehgFields, source_field);
          if (sourceValue && typeof sourceValue === 'object' && 'accountId' in sourceValue) {
            const igniteAccountId = (sourceValue as { accountId: string }).accountId;
            const hmgAccountId = await lookupHmgAccountId(igniteAccountId);
            if (hmgAccountId) {
              fields[target_field] = { accountId: hmgAccountId };
            } else {
              onWarning?.(
                `${source_field}: Ignite 계정(${igniteAccountId}) 에 대응하는 HMG 계정이 없어 반영하지 못했습니다`
              );
            }
          }
          break;
        }

        // fixVersions: 버전 ID는 프로젝트마다 달라 copy 불가 → 이름 기반 매핑으로 자동 처리
        if (source_field === 'fixVersions') {
          const matched = await resolveVersionsByName(
            value as Array<{ id: string; name: string }> | undefined,
            targetProjectKey,
            isHmgTarget ? 'hmg' : 'ignite',
            options
          );
          if (matched) fields[target_field] = matched;
          break;
        }

        if (value !== undefined && value !== null) {
          // assignee는 accountId 형태로 래핑
          if (source_field === 'assignee' && typeof value === 'object' && value !== null && 'accountId' in value) {
            fields[target_field] = { accountId: (value as { accountId: string }).accountId };
          } else {
            fields[target_field] = value;
          }
        }
        break;
      }

      case 'version_map': {
        // 수정 버전 매핑 (소스 버전 이름 → 대상 프로젝트 버전 ID)
        const matched = await resolveVersionsByName(
          fehgFields[source_field] as Array<{ id: string; name: string }> | undefined,
          targetProjectKey,
          isHmgTarget ? 'hmg' : 'ignite',
          options
        );
        if (matched) fields[target_field] = matched;
        break;
      }

      case 'sprint_map': {
        // 스프린트 매핑 (FEHG 스프린트 이름 → 대상 프로젝트 스프린트 ID)
        const sprint = fehgFields[source_field] as
          | Array<{ id: number; name: string }>
          | undefined;

        if (sprint && sprint.length > 0) {
          const sprintInstance = isHmgTarget ? 'hmg' : 'ignite';
          const mappedSprintId = await mapSprintToTarget(
            sprint[0].name,
            targetProjectKey,
            sprintInstance
          );
          if (mappedSprintId) {
            fields[target_field] = mappedSprintId;
          } else {
            onWarning?.(
              `스프린트 "${sprint[0].name}" 에 대응하는 ${targetProjectKey} 스프린트가 없어 반영하지 못했습니다`
            );
          }
        }
        break;
      }

      default: {
        // 알 수 없는 transform_type → copy로 폴백
        const fallbackValue = getFieldValue(fehgTicket, fehgFields, source_field);
        if (fallbackValue !== undefined && fallbackValue !== null) {
          fields[target_field] = fallbackValue;
        }
        break;
      }
    }
  }

  return fields;
}

// 계정 매핑 캐시 (동기화 세션 동안 유지)
const accountMapCache = new Map<string, string | null>();

/**
 * Ignite accountId → HMG accountId 조회 (캐시)
 */
export async function lookupHmgAccountId(igniteAccountId: string): Promise<string | null> {
  if (accountMapCache.has(igniteAccountId)) {
    return accountMapCache.get(igniteAccountId)!;
  }

  const { data } = await dbServer
    .from('users')
    .select('hmg_account_id')
    .eq('ignite_account_id', igniteAccountId)
    .single();

  const hmgAccountId = data?.hmg_account_id || null;
  accountMapCache.set(igniteAccountId, hmgAccountId);
  return hmgAccountId;
}

// 역방향 계정 매핑 캐시 (HMG → Ignite)
const reverseAccountMapCache = new Map<string, string | null>();

/**
 * HMG accountId → Ignite accountId 조회 (캐시)
 * 역방향 동기화(대상 → BEDEV1)에서 담당자를 되돌릴 때 사용한다.
 */
export async function lookupIgniteAccountId(
  hmgAccountId: string
): Promise<string | null> {
  if (reverseAccountMapCache.has(hmgAccountId)) {
    return reverseAccountMapCache.get(hmgAccountId)!;
  }

  const { data } = await dbServer
    .from('users')
    .select('ignite_account_id')
    .eq('hmg_account_id', hmgAccountId)
    .single();

  const igniteAccountId = data?.ignite_account_id || null;
  reverseAccountMapCache.set(hmgAccountId, igniteAccountId);
  return igniteAccountId;
}

/**
 * 동기화 프로필 정보 조회 (link_field, 타겟 프로젝트 정보)
 */
export interface SyncProfileInfo {
  id: string;
  name: string;
  linkField: string | null;
  targetProjectKey: string;
  targetInstance: string;
  sourceProjectKey: string;
  sourceInstance: string;
}

const profileInfoCache = new Map<string, SyncProfileInfo>();

export async function getSyncProfileInfo(profileId: string): Promise<SyncProfileInfo | null> {
  if (profileInfoCache.has(profileId)) {
    return profileInfoCache.get(profileId)!;
  }

  const { data } = await dbServer
    .from('sync_profiles')
    .select(`
      id, name, link_field,
      source:source_project_id(name, jira_instance),
      target:target_project_id(name, jira_instance)
    `)
    .eq('id', profileId)
    .single();

  if (!data) return null;

  const source = data.source as unknown as { name: string; jira_instance: string };
  const target = data.target as unknown as { name: string; jira_instance: string };

  const info: SyncProfileInfo = {
    id: data.id,
    name: data.name,
    linkField: data.link_field,
    targetProjectKey: target.name,
    targetInstance: target.jira_instance,
    sourceProjectKey: source.name,
    sourceInstance: source.jira_instance,
  };

  profileInfoCache.set(profileId, info);
  return info;
}


/**
 * description ADF 문서에서 모든 미디어 노드를 재귀적으로 제거
 *
 * 필드 업데이트 단계에서 본문에 소스 인스턴스의 media id가 남아 있으면
 * 대상(HMG)에서 ATTACHMENT_VALIDATION_ERROR 가 발생한다.
 * mediaSingle 뿐 아니라 mediaGroup(파일 카드) / media / mediaInline 까지
 * 깊이에 상관없이 제거한다. 이미지 인라인 재삽입은 첨부 복사 이후
 * attachment-migrator 가 별도로 처리한다.
 */
export function removeMediaSingleNodes(doc: unknown): unknown {
  const strip = (node: unknown): unknown | null => {
    if (!node || typeof node !== 'object') return node;
    const n = node as { type?: string; content?: unknown[]; [k: string]: unknown };

    if (n.type === 'media' || n.type === 'mediaInline') return null;

    if (Array.isArray(n.content)) {
      const newContent = n.content
        .map(strip)
        .filter((c): c is unknown => c !== null);
      // 내용이 비어버린 미디어 래퍼는 통째로 제거
      if ((n.type === 'mediaSingle' || n.type === 'mediaGroup') && newContent.length === 0) {
        return null;
      }
      return { ...n, content: newContent };
    }

    return n;
  };

  return strip(doc) ?? doc;
}

/**
 * FEHG 티켓에서 필드 값 추출
 */
function getFieldValue(
  ticket: JiraIssue,
  fields: JiraIssue['fields'],
  fieldId: string
): unknown {
  // 표준 필드
  switch (fieldId) {
    case 'summary':
      return ticket.fields.summary;
    case 'assignee':
      return ticket.fields.assignee;
    case 'duedate':
      return fields.duedate;
    case 'timetracking':
      return fields.timetracking;
    default:
      // 커스텀 필드 (customfield_XXXXX)
      return fields[fieldId];
  }
}
