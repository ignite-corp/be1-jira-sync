/**
 * "반영했다고 나오는데 값이 안 바뀐다" 진단 (읽기 전용)
 *
 * 사용법:
 *   npx tsx --env-file=.env.local scripts/check-field-write.ts BEDEV1-983 --user 정용석
 *   npx tsx --env-file=.env.local scripts/check-field-write.ts BEDEV1-983 --target MEMBERSHIP-1067 --user 정용석
 *
 * 매핑된 필드 하나하나에 대해 네 가지를 나란히 보여준다.
 *   1. 소스 티켓이 실제로 가진 값        (없으면 쓰기 자체가 생략된다)
 *   2. 쓰기 페이로드에 들어가는 값        (매핑/변환 결과)
 *   3. 대상 티켓이 지금 갖고 있는 값      (반영 여부)
 *   4. 대상 필드가 편집 화면에 있는지      (없으면 Jira 가 조용히 버릴 수 있다)
 *
 * 티켓을 수정하지 않는다.
 */

process.env.BATCH_MODE = 'true';

import { dbServer } from '@/lib/db';
import { jira, JiraClient } from '@/lib/services/jira';
import { getFieldMappings, getSyncProfileInfo, mapFieldsFromDb } from '@/lib/services/sync/db-field-mapper';
import { sanitizeWritePayload } from '@/lib/services/sync/write-payload';
import { extractLinkFieldKeys, findBlocksOutwardKeys } from '@/lib/services/sync/link-resolver';
import { buildFieldProbes, formatFieldValue } from '@/lib/services/jira/field-probe';
import type { JiraIssue } from '@/lib/types/jira';

type Instance = 'ignite' | 'hmg';

function normalizeInstance(v: string | null | undefined): Instance {
  return v === 'hmg' ? 'hmg' : 'ignite';
}

async function loadUserCredentials(userName: string): Promise<void> {
  const { data, error } = await dbServer
    .from('users')
    .select('name, ignite_jira_email, ignite_jira_api_token, hmg_jira_email, hmg_jira_api_token')
    .eq('name', userName)
    .single();

  if (error || !data) {
    console.error(`사용자 "${userName}" 를 찾을 수 없다: ${error?.message ?? ''}`);
    process.exit(1);
  }
  if (data.ignite_jira_email && data.ignite_jira_api_token) {
    process.env.IGNITE_JIRA_EMAIL = data.ignite_jira_email;
    process.env.IGNITE_JIRA_API_TOKEN = data.ignite_jira_api_token;
  }
  if (data.hmg_jira_email && data.hmg_jira_api_token) {
    process.env.HMG_JIRA_EMAIL = data.hmg_jira_email;
    process.env.HMG_JIRA_API_TOKEN = data.hmg_jira_api_token;
  }
  console.warn(`인증: ${data.name}`);
}

async function fetchIssue(
  instance: Instance,
  key: string,
  extraFields: string[]
): Promise<JiraIssue | null> {
  const res = await jira[instance].searchAllIssues(`key = ${key}`, extraFields);
  if (!res.success || !res.data || res.data.issues.length === 0) {
    console.error(`${key} 조회 실패: ${res.error ?? '결과 없음'}`);
    return null;
  }
  return res.data.issues[0];
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const userName = opt('--user');
  const targetKeyArg = opt('--target');
  const sourceKey = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));

  if (!sourceKey || !userName) {
    console.error('사용법: check-field-write.ts <소스 티켓 키> --user <이름> [--target <대상 티켓 키>]');
    process.exit(1);
  }
  await loadUserCredentials(userName);

  const sourceProjectKey = sourceKey.split('-')[0];

  const { data: profileRows } = await dbServer.from('sync_profiles').select(`
      id, name, link_field,
      source:source_project_id(name, jira_instance),
      target:target_project_id(name, jira_instance)
    `);
  const profiles = (profileRows ?? []) as unknown as Array<{
    id: string;
    name: string;
    link_field: string | null;
    source: { name: string; jira_instance: string };
    target: { name: string; jira_instance: string };
  }>;

  const candidates = profiles.filter((p) => p.source?.name === sourceProjectKey);
  if (candidates.length === 0) {
    console.error(`소스 프로젝트 ${sourceProjectKey} 를 쓰는 프로필이 없다.`);
    process.exit(1);
  }
  const profile =
    candidates.find((p) => targetKeyArg?.startsWith(`${p.target?.name}-`)) ?? candidates[0];

  const sourceInstance = normalizeInstance(profile.source.jira_instance);
  const targetInstance = normalizeInstance(profile.target.jira_instance);
  console.warn(
    `프로필: "${profile.name}" ${profile.source.name}(${sourceInstance}) → ${profile.target.name}(${targetInstance})`
  );

  const mappings = await getFieldMappings(profile.id);
  const info = await getSyncProfileInfo(profile.id);
  const linkField = profile.link_field || info?.linkField || null;

  const sourceExtra = [...mappings.map((m) => m.source_field), 'issuelinks'];
  if (linkField) sourceExtra.push(linkField);
  const source = await fetchIssue(sourceInstance, sourceKey, sourceExtra);
  if (!source) process.exit(1);

  // 대상 티켓 찾기
  let targetKey = targetKeyArg;
  if (!targetKey) {
    const fromLinkField = extractLinkFieldKeys(source, {
      linkField,
      targetProjectKey: profile.target.name,
    });
    const fromBlocks = findBlocksOutwardKeys(source, profile.target.name);
    targetKey = [...fromLinkField, ...fromBlocks].find((k) =>
      k.startsWith(`${profile.target.name}-`)
    );
  }
  if (!targetKey) {
    console.error('연결된 대상 티켓을 찾지 못했다. --target <키> 로 지정할 것.');
    process.exit(1);
  }
  console.warn(`대상 티켓: ${targetKey}\n`);

  // 쓰기 페이로드 (실제 덮어쓰기가 보내는 것과 같은 계산)
  const payload = sanitizeWritePayload(
    await mapFieldsFromDb(source, profile.id, profile.target.name, {
      onWarning: (w) => console.warn(`  [경고] ${w}`),
    })
  );

  // 대상 티켓의 현재 값 + 편집 화면 포함 여부
  const targetClient = new JiraClient(targetInstance);
  const issueRes = await targetClient.get<{
    fields?: Record<string, unknown>;
    names?: Record<string, string>;
  }>(`/issue/${targetKey}`, { expand: 'names' });
  const metaRes = await targetClient.get<{ fields?: Record<string, unknown> }>(
    `/issue/${targetKey}/editmeta`
  );
  if (!issueRes.success || !issueRes.data) {
    console.error(`${targetKey} 조회 실패: ${issueRes.error}`);
    process.exit(1);
  }
  const probes = buildFieldProbes({
    issue: issueRes.data,
    editmeta: metaRes.success ? metaRes.data : null,
  });

  const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
  console.warn(
    pad('소스 필드', 26) + pad('소스 값', 22) + pad('→ 대상 필드', 26) + pad('보낼 값', 22) + pad('대상 현재 값', 22) + '화면'
  );
  console.warn('-'.repeat(130));

  const problems: string[] = [];

  for (const m of mappings) {
    const sourceValue = formatFieldValue(
      (source.fields as Record<string, unknown>)[m.source_field]
    );
    const sending = Object.prototype.hasOwnProperty.call(payload, m.target_field)
      ? formatFieldValue(payload[m.target_field])
      : null;
    const probe = probes[m.target_field];
    const current = probe?.preview ?? null;
    const onScreen = probe ? (probe.onEditScreen ? 'O' : 'X') : '?';

    console.warn(
      pad(m.source_field, 26) +
        pad(sourceValue ?? '(없음)', 22) +
        pad(m.target_field, 26) +
        pad(sending ?? '(안 보냄)', 22) +
        pad(current ?? '(비어 있음)', 22) +
        onScreen
    );

    // 추정치는 timetracking 으로 접어서 보낸다 (write-payload.ts) - 누락이 아니다
    const foldedIntoTimetracking =
      (m.target_field === 'timeoriginalestimate' || m.target_field === 'timeestimate') &&
      payload.timetracking !== undefined;

    if (sourceValue && !sending && !foldedIntoTimetracking) {
      problems.push(
        `${m.source_field}: 소스에 값이 있는데 쓰기 페이로드에 안 들어간다 (매핑/변환 단계에서 빠짐)`
      );
    }
    if (sending && !current) {
      problems.push(
        `${m.target_field}: 보내는데 대상 값이 비어 있다` +
          (probe && !probe.onEditScreen
            ? ' — 편집 화면에 없는 필드라 Jira 가 버렸을 수 있다'
            : ' — 화면에 보이는 필드가 같은 이름의 다른 필드일 수 있다')
      );
    }
    // 보내는 형태와 읽히는 형태가 원래 다른 필드들 (계정 객체 → 표시 이름, 스프린트 id → 이름 …)
    const formatDiffers =
      typeof payload[m.target_field] === 'object' ||
      typeof payload[m.target_field] === 'number' ||
      m.transform_type === 'sprint_map';

    if (sending && current && sending !== current && !formatDiffers) {
      problems.push(`${m.target_field}: 보낸 값(${sending}) 과 현재 값(${current}) 이 다르다`);
    }
  }

  // 대상에만 값이 있는 "같은 이름" 필드 찾아주기 (진짜 화면 필드 후보)
  const mappedTargets = new Set(mappings.map((m) => m.target_field));
  const names = issueRes.data.names ?? {};
  const sameNameCandidates = Object.entries(names).filter(([id, name]) => {
    if (mappedTargets.has(id)) return false;
    if (!probes[id]?.hasValue) return false;
    return mappings.some((m) => names[m.target_field] === name);
  });

  if (sameNameCandidates.length > 0) {
    console.warn('\n이름이 같은데 값이 들어 있는 다른 필드 (매핑 대상이 틀렸을 수 있다):');
    for (const [id, name] of sameNameCandidates) {
      console.warn(`  ${id}  "${name}"  = ${probes[id].preview}`);
    }
  }

  console.warn('\n=== 진단 ===');
  if (problems.length === 0) {
    console.warn('매핑된 필드가 모두 정상적으로 반영돼 있다.');
  } else {
    for (const p of problems) console.warn(`  - ${p}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
