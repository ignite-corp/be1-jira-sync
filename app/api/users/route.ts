import { NextResponse } from 'next/server';
import { dbServer } from '@/lib/db';

export async function GET() {
  const { data, error } = await dbServer
    .from('users')
    .select('*, teams:team_id(id, name, source_project:source_project_id(name))')
    .order('name');

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  const users = data.map((u: Record<string, unknown>) => {
    const team = u.teams as { id: string; name: string; source_project: { name: string } | null } | null;
    return {
      id: u.id,
      name: u.name,
      teamId: u.team_id,
      teamName: team?.name ?? null,
      sourceProject: team?.source_project?.name ?? null,
      igniteAccountId: u.ignite_account_id,
      hmgAccountId: u.hmg_account_id,
      hmgUserId: u.hmg_user_id,
      // Jira 자격증명은 응답에 담지 않는다. 실제 인증은 서버에서
      // `lib/jira-credentials.ts` 가 userId 로 DB 를 직접 조회해 처리하므로
      // 브라우저에는 설정 여부만 알려주면 충분하다.
      hasIgniteCredentials: Boolean(u.ignite_jira_email && u.ignite_jira_api_token),
      hasHmgCredentials: Boolean(u.hmg_jira_email && u.hmg_jira_api_token),
    };
  });

  return NextResponse.json({ success: true, data: users });
}
