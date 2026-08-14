import { readCurrentUserId } from '@/lib/constants/storage';

/**
 * Jira API 프록시 호출 시 현재 사용자 ID를 헤더에 포함하는 fetch wrapper
 */
export function jiraFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string>),
  };

  const userId = readCurrentUserId();
  if (userId) headers['x-user-id'] = userId;

  return fetch(url, { ...init, headers });
}
