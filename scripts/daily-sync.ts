/**
 * Daily Batch: 전체 담당자 대상 전체 티켓 동기화
 *
 * 사용법:
 *   BATCH_MODE=true npx tsx scripts/daily-sync.ts
 *
 * 필요 환경변수:
 *   IGNITE_JIRA_EMAIL, IGNITE_JIRA_API_TOKEN
 *   HMG_JIRA_EMAIL, HMG_JIRA_API_TOKEN
 */

// 배치 모드 활성화
process.env.BATCH_MODE = 'true';

import { SyncOrchestrator } from '@/lib/services/sync/sync-orchestrator';
import { SyncSummary } from '@/lib/services/sync/types';
import { getAllUsers } from '@/lib/services/user-lookup';

interface UserSyncResult {
  name: string;
  summary: SyncSummary | null;
  error?: string;
}

async function main() {
  console.log('========================================');
  console.log('Daily Sync 시작');
  console.log(`실행 시각: ${new Date().toISOString()}`);
  console.log('========================================\n');

  // 환경변수 체크
  const requiredEnvVars = [
    'IGNITE_JIRA_EMAIL',
    'IGNITE_JIRA_API_TOKEN',
    'HMG_JIRA_EMAIL',
    'HMG_JIRA_API_TOKEN',
    'NEXT_PUBLIC_DB_URL',
    'DB_SERVICE_ROLE_KEY',
  ];

  const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
  if (missingVars.length > 0) {
    console.error(`필수 환경변수 누락: ${missingVars.join(', ')}`);
    process.exit(1);
  }

  const users = await getAllUsers();
  const results: UserSyncResult[] = [];

  console.log(`대상 담당자: ${users.length}명`);
  console.log(
    `담당자 목록: ${users.map((u) => u.name).join(', ')}\n`
  );

  // 담당자별 순차 실행
  for (const user of users) {
    console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`[${user.name}] 동기화 시작`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━`);

    try {
      const orchestrator = new SyncOrchestrator((log) => {
        const prefix =
          log.level === 'error'
            ? '[ERROR]'
            : log.level === 'warning'
              ? '[WARN] '
              : log.level === 'success'
                ? '[ OK  ]'
                : '[INFO ]';
        console.log(`  ${prefix} ${log.message}`);
      });

      const summary = await orchestrator.execute({
        assigneeAccountId: user.igniteAccountId,
        assigneeName: user.name,
        teamUsers: users,
        targetProjects: undefined, // 전체 (KQ, HDD, HB, AUTOWAY)
        chunkSize: 15,
      });

      results.push({ name: user.name, summary });

      console.log(
        `[${user.name}] 완료 - 처리: ${summary.totalProcessed}, 성공: ${summary.totalSuccess}, 실패: ${summary.totalFailed}`
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error(`[${user.name}] 치명적 오류: ${errorMessage}`);
      results.push({ name: user.name, summary: null, error: errorMessage });
    }
  }

  // 최종 요약
  console.log('\n========================================');
  console.log('Daily Sync 완료 요약');
  console.log('========================================');

  let totalProcessed = 0;
  let totalSuccess = 0;
  let totalFailed = 0;
  let totalCreated = 0;
  let userErrors = 0;

  for (const result of results) {
    if (result.summary) {
      totalProcessed += result.summary.totalProcessed;
      totalSuccess += result.summary.totalSuccess;
      totalFailed += result.summary.totalFailed;
      totalCreated += result.summary.totalCreated;
      const status =
        result.summary.totalFailed > 0 ? '(일부 실패)' : '(성공)';
      console.log(
        `  ${result.name}: 처리 ${result.summary.totalProcessed}건, 성공 ${result.summary.totalSuccess}건, 실패 ${result.summary.totalFailed}건 ${status}`
      );
    } else {
      userErrors++;
      console.log(`  ${result.name}: 실행 실패 - ${result.error}`);
    }
  }

  console.log(`\n전체 통계:`);
  console.log(`  총 처리: ${totalProcessed}건`);
  console.log(`  총 성공: ${totalSuccess}건 (업데이트: ${totalSuccess - totalCreated}, 신규 생성: ${totalCreated})`);
  console.log(`  총 실패: ${totalFailed}건`);
  console.log(`  실행 오류 담당자: ${userErrors}명`);

  // 실패가 있으면 exit code 1
  if (totalFailed > 0 || userErrors > 0) {
    console.log('\n일부 작업이 실패했습니다.');
    process.exit(1);
  }

  console.log('\n모든 동기화가 성공적으로 완료되었습니다.');
}

main().catch((error) => {
  console.error('예상치 못한 오류:', error);
  process.exit(1);
});
