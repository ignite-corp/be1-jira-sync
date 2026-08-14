// 역방향 필드 매핑 (대상 프로젝트 → BEDEV1)
//
// 결정 4: 새 프로필/새 매핑 UI 를 만들지 않는다.
// sync_field_mappings 의 **기존 매핑을 역으로 적용**한다.
//   정방향: source_field → target_field
//   역방향: target_field → source_field
//
// 값 변환도 정방향의 역을 취한다.
//   - sprint_map : 대상 스프린트 이름 → 소스 프로젝트의 같은 연월 스프린트 id
//   - version_map: 대상 버전 이름 → 소스 프로젝트의 같은 이름 버전 id
//   - assignee/reporter: HMG accountId → Ignite accountId
//   - description: 대상 인스턴스의 media 노드 제거 (소스에서는 유효하지 않은 id 라 업로드가 깨진다)

import { JiraIssue } from '@/lib/types/jira';
import { mapSprintToTarget } from './sprint-mapper';
import {
  getFieldMappings,
  getSyncProfileInfo,
  lookupIgniteAccountId,
  removeMediaSingleNodes,
  resolveVersionsByName,
  type FieldMapOptions,
} from './db-field-mapper';

/**
 * 대상 티켓의 필드를 소스(BEDEV1) 필드로 역매핑한다.
 *
 * @param targetTicket 대상 프로젝트의 티켓
 * @param profileId    동기화 프로필 id (정방향과 같은 프로필을 그대로 쓴다)
 * @param options      경고 콜백 / 없는 수정 버전 생성 여부
 * @returns 키가 source_field 인 소스 ID 공간의 필드 값
 */
export async function mapFieldsToSource(
  targetTicket: JiraIssue,
  profileId: string,
  options?: FieldMapOptions
): Promise<Record<string, unknown>> {
  const onWarning = options?.onWarning;
  const mappings = await getFieldMappings(profileId);
  const profileInfo = await getSyncProfileInfo(profileId);

  if (!profileInfo) return {};

  const sourceProjectKey = profileInfo.sourceProjectKey;
  const sourceInstance =
    profileInfo.sourceInstance === 'hmg' ? ('hmg' as const) : ('ignite' as const);
  const isHmgTarget = profileInfo.targetInstance === 'hmg';

  const fields: Record<string, unknown> = {};
  const targetFields = targetTicket.fields;

  for (const mapping of mappings) {
    const { source_field, target_field, transform_type } = mapping;
    const value = targetFields[target_field];

    switch (transform_type) {
      case 'sprint_map': {
        const sprints = value as Array<{ id: number; name: string; state?: string }> | undefined;
        const sprint = pickSprint(sprints);
        if (!sprint?.name) break;

        // mapSprintToTarget 은 "이름에서 연월 추출 → 대상 프로젝트 이름 규칙으로 재조립 → id 조회"
        // 라서 방향에 무관하게 그대로 재사용할 수 있다.
        const mappedSprintId = await mapSprintToTarget(
          sprint.name,
          sourceProjectKey,
          sourceInstance
        );
        if (mappedSprintId) {
          fields[source_field] = mappedSprintId;
        } else {
          onWarning?.(
            `스프린트 "${sprint.name}" 에 대응하는 ${sourceProjectKey} 스프린트가 없어 반영하지 못했습니다`
          );
        }
        break;
      }

      case 'version_map': {
        const mapped = await resolveVersionsByName(
          value as Array<{ id: string; name: string }> | undefined,
          sourceProjectKey,
          sourceInstance,
          options
        );
        if (mapped) fields[source_field] = mapped;
        break;
      }

      case 'copy':
      default: {
        if (value === undefined || value === null) break;

        // 본문: 대상 인스턴스의 media 노드는 소스에서 쓸 수 없다
        if (source_field === 'description' && target_field === 'description') {
          fields[source_field] = isHmgTarget
            ? removeMediaSingleNodes(value)
            : value;
          break;
        }

        // 사용자 필드: HMG 대상이면 계정을 되돌린다
        if (source_field === 'assignee' || source_field === 'reporter') {
          if (typeof value !== 'object' || !('accountId' in (value as object))) break;
          const accountId = (value as { accountId: string }).accountId;

          if (isHmgTarget) {
            const igniteAccountId = await lookupIgniteAccountId(accountId);
            if (igniteAccountId) fields[source_field] = { accountId: igniteAccountId };
            else
              onWarning?.(
                `${source_field}: HMG 계정(${accountId}) 에 대응하는 Ignite 계정이 없어 반영하지 못했습니다`
              );
          } else {
            // 같은 사이트면 accountId 가 동일
            fields[source_field] = { accountId };
          }
          break;
        }

        // fixVersions: 버전 id 는 프로젝트마다 다르므로 이름 기준으로 되돌린다
        if (source_field === 'fixVersions') {
          const mapped = await resolveVersionsByName(
            value as Array<{ id: string; name: string }> | undefined,
            sourceProjectKey,
            sourceInstance,
            options
          );
          if (mapped) fields[source_field] = mapped;
          break;
        }

        fields[source_field] = value;
        break;
      }
    }
  }

  return fields;
}

/** 배열이면 active 우선, 없으면 첫 번째 (canonicalizeSprint 와 같은 규칙) */
function pickSprint(
  sprints: Array<{ id: number; name: string; state?: string }> | undefined
): { id: number; name: string } | null {
  if (!Array.isArray(sprints) || sprints.length === 0) return null;
  const active = sprints.find((s) => s?.state === 'active');
  return active ?? sprints[0];
}
