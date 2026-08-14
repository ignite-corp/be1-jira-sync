/**
 * localStorage 키 정본.
 *
 * 현재 사용자 정보는 `contexts/user-context.tsx` 가 쓰고, Jira 프록시 호출부
 * (`lib/services/jira/client.ts`, `lib/jira-fetch.ts`)가 `x-user-id` 헤더를
 * 붙이려고 다시 읽는다. 키를 각자 하드코딩하면 한쪽만 바뀌었을 때
 * 인증이 통째로 끊기므로 반드시 여기서만 정의한다.
 */
export const CURRENT_USER_STORAGE_KEY = 'ignite-current-user-v2';

/**
 * 폐기된 키. v1 은 Jira 이메일/API 토큰까지 통째로 저장했기 때문에
 * 앱 진입 시 남아 있으면 지운다.
 */
export const LEGACY_CURRENT_USER_STORAGE_KEYS = ['ignite-current-user'];

/** 저장된 현재 사용자 ID 조회 (브라우저 전용, 실패 시 null) */
export function readCurrentUserId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(CURRENT_USER_STORAGE_KEY);
    if (!stored) return null;
    const user = JSON.parse(stored);
    return user?.id ?? null;
  } catch {
    return null;
  }
}
