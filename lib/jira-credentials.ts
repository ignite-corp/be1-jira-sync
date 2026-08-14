import { dbServer } from '@/lib/db';

interface JiraCredentials {
  email: string;
  apiToken: string;
}

/**
 * 사용자 ID로 Jira 인증 정보를 조회합니다.
 * DB에 사용자별 인증 정보가 없으면 null을 반환합니다.
 */
export async function resolveJiraCredentials(
  instance: 'ignite' | 'hmg',
  userId: string | null
): Promise<JiraCredentials | null> {
  if (!userId) {
    return null;
  }

  const { data } = await dbServer
    .from('users')
    .select('ignite_jira_email, ignite_jira_api_token, hmg_jira_email, hmg_jira_api_token')
    .eq('id', userId)
    .single();

  if (data) {
    const email =
      instance === 'ignite' ? data.ignite_jira_email : data.hmg_jira_email;
    const apiToken =
      instance === 'ignite'
        ? data.ignite_jira_api_token
        : data.hmg_jira_api_token;

    if (email && apiToken) {
      return { email, apiToken };
    }
  }

  return null;
}
