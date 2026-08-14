/**
 * 양방향 동기화 계획 점검 (읽기 전용)
 *
 * 사용법:
 *   npx tsx --env-file=.env.local scripts/check-bidirectional-plan.ts                    # 프로필 목록만
 *   npx tsx --env-file=.env.local scripts/check-bidirectional-plan.ts KQ --user 정용석    # 계획 수립
 *
 * 조회 범위는 UI 와 동일하게 **현재 월 스프린트 + 해당 담당자** 로 한정된다.
 *
 * 티켓을 생성하거나 수정하지 않는다. buildPlan() 만 돌려 무엇이 잡히는지 확인한다.
 * UI 를 띄우지 않고 동기화 대상 판정을 검증할 때 쓴다.
 *
 * 인증: `--user <이름>` 을 주면 브라우저와 똑같이 users 테이블의 개인 토큰을 쓴다.
 * 없으면 .env.local 의 IGNITE_JIRA_* / HMG_JIRA_* 를 쓴다.
 * (.env.example 을 그대로 복사해 두면 값이 placeholder 라 401 이 난다 - 그때 --user 를 쓸 것)
 */

// 배치 모드: 프록시 라우트 대신 Jira API 직접 호출
process.env.BATCH_MODE = 'true';

import { dbServer } from '@/lib/db';
import { SyncLogger } from '@/lib/services/sync/logger';
import { BidirectionalOrchestrator } from '@/lib/services/sync/bidirectional-orchestrator';

interface ProfileRow {
  id: string;
  name: string;
  source: { name: string; jira_instance: string };
  target: { name: string; jira_instance: string };
}

/**
 * users 테이블의 개인 Jira 토큰을 배치 모드 env 로 주입한다.
 * (API 라우트의 resolveJiraCredentials 가 하는 것과 같은 조회)
 */
async function loadUserCredentials(userName: string): Promise<string> {
  const { data, error } = await dbServer
    .from('users')
    .select(
      'name, ignite_account_id, ignite_jira_email, ignite_jira_api_token, hmg_jira_email, hmg_jira_api_token'
    )
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

  console.warn(
    `인증: ${data.name} (ignite=${!!data.ignite_jira_api_token}, hmg=${!!data.hmg_jira_api_token})`
  );

  if (!data.ignite_account_id) {
    console.error(`사용자 "${userName}" 의 ignite_account_id 가 없다.`);
    process.exit(1);
  }
  return data.ignite_account_id;
}

async function main() {
  const args = process.argv.slice(2);
  const userIdx = args.indexOf('--user');
  const userName = userIdx >= 0 ? args[userIdx + 1] : undefined;
  const targetFilter = args.filter((a, i) => a !== '--user' && i !== userIdx + 1)[0];

  let assigneeAccountId = '';
  if (userName) assigneeAccountId = await loadUserCredentials(userName);

  const { data, error } = await dbServer.from('sync_profiles').select(`
      id, name,
      source:source_project_id(name, jira_instance),
      target:target_project_id(name, jira_instance)
    `);

  if (error) {
    console.error('sync_profiles 조회 실패:', error.message);
    process.exit(1);
  }

  const profiles = (data ?? []) as unknown as ProfileRow[];

  console.warn('=== 동기화 프로필 ===');
  for (const p of profiles) {
    console.warn(
      `  ${p.source?.name}(${p.source?.jira_instance}) → ${p.target?.name}(${p.target?.jira_instance})  "${p.name}"  id=${p.id}`
    );
  }

  if (!targetFilter) {
    console.warn(
      '\n대상 프로젝트와 담당자를 주면 계획을 세운다. 예: ... check-bidirectional-plan.ts KQ --user 정용석'
    );
    return;
  }

  if (!assigneeAccountId) {
    console.error('\n--user <이름> 이 필요하다. 조회는 현재 스프린트 + 해당 담당자로 한정된다.');
    process.exit(1);
  }

  const profile = profiles.find((p) => p.target?.name === targetFilter);
  if (!profile) {
    console.error(`\n대상 "${targetFilter}" 프로필을 찾을 수 없다.`);
    process.exit(1);
  }

  console.warn(`\n=== 계획 수립: ${profile.source.name} ↔ ${profile.target.name} ===`);

  const logger = new SyncLogger((log) => {
    console.warn(`  [${log.level}] ${log.message}`);
  });

  const orchestrator = new BidirectionalOrchestrator(logger);

  try {
    const plan = await orchestrator.buildPlan(profile.id, { assigneeAccountId });

    console.warn('\n=== 결과 ===');
    console.warn(`  스프린트: "${plan.sourceSprintName}" ↔ "${plan.targetSprintName}"`);
    console.warn(`  연결 방식: ${plan.sameSite ? '같은 사이트(Blocks 링크)' : '다른 사이트(link field)'}`);
    console.warn(`  ${plan.targetProjectKey} 에 생성: ${plan.createInTarget.length}건`);
    for (const i of plan.createInTarget) console.warn(`      ${i.ticket.key}  ${i.ticket.summary}`);

    console.warn(`  ${plan.sourceProjectKey} 에 생성: ${plan.createInSource.length}건`);
    for (const i of plan.createInSource) console.warn(`      ${i.ticket.key}  ${i.ticket.summary}`);

    console.warn(`  확인 필요(내용 다름): ${plan.conflicts.length}건`);
    for (const c of plan.conflicts) {
      console.warn(
        `      ${c.source.key} ↔ ${c.target.key}  [${c.comparison.changed.map((d) => d.label).join(', ')}]  제안=${c.suggestedDirection}`
      );
    }

    console.warn(`  이미 동일: ${plan.inSync.length}건`);
    for (const s of plan.inSync) console.warn(`      ${s.source.key} ↔ ${s.target.key}`);

    console.warn(`  범위 밖: ${plan.skipped.length}건`);
    for (const s of plan.skipped) console.warn(`      ${s.key} — ${s.reason}`);
  } catch (error) {
    console.error(`\n계획 수립 실패: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

main();
