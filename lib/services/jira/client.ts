import { JiraApiResponse, JiraRequestOptions } from '@/lib/types/jira';
import { JIRA_ENDPOINTS, JIRA_API_VERSION } from '@/lib/constants/jira';
import { readCurrentUserId } from '@/lib/constants/storage';
import { toast } from 'sonner';

/** 토큰 만료 팝업 이벤트 이름 (TokenExpiredDialog가 구독) */
export const JIRA_TOKEN_EXPIRED_EVENT = 'jira:token-expired';

/**
 * API 토큰 만료를 전역 팝업으로 알린다.
 * 동기화 중 401이 연속으로 발생할 수 있으므로, 팝업 표시 여부(dedupe)는
 * 이벤트를 구독하는 다이얼로그 쪽에서 처리한다.
 */
function notifyTokenExpired(instance: 'ignite' | 'hmg') {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent(JIRA_TOKEN_EXPIRED_EVENT, { detail: { instance } })
  );
}

/**
 * Jira API 클라이언트
 * 브라우저: Next.js API Routes 프록시 경유
 * 배치 모드(BATCH_MODE=true): Jira API 직접 호출
 */
export class JiraClient {
  constructor(private instance: 'ignite' | 'hmg') {}

  private get isBatchMode(): boolean {
    return (
      typeof process !== 'undefined' && process.env?.BATCH_MODE === 'true'
    );
  }

  /**
   * API 요청 메서드
   */
  async request<T>(
    path: string,
    options: JiraRequestOptions & { body?: unknown } = {}
  ): Promise<JiraApiResponse<T>> {
    if (this.isBatchMode) {
      return this.directRequest<T>(path, options);
    }
    return this.proxyRequest<T>(path, options);
  }

  /**
   * 직접 호출 모드 (배치용)
   */
  private async directRequest<T>(
    path: string,
    options: JiraRequestOptions & { body?: unknown } = {}
  ): Promise<JiraApiResponse<T>> {
    try {
      const { method = 'GET', body, params } = options;
      const config = this.getDirectConfig();

      const queryString = params
        ? '?' +
          new URLSearchParams(
            Object.entries(params).reduce(
              (acc, [key, value]) => {
                acc[key] = String(value);
                return acc;
              },
              {} as Record<string, string>
            )
          ).toString()
        : '';

      const cleanPath = path.startsWith('/') ? path.slice(1) : path;
      const isAgileApi = cleanPath.startsWith('agile/');
      const baseUrl = isAgileApi
        ? `${config.baseUrl}/rest`
        : `${config.baseUrl}${JIRA_API_VERSION}`;
      const url = `${baseUrl}/${cleanPath}${queryString}`;

      const authHeader = Buffer.from(
        `${config.email}:${config.token}`
      ).toString('base64');

      const response = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Basic ${authHeader}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          success: false,
          error:
            (errorData as { errorMessages?: string[] }).errorMessages?.[0] ||
            (errorData as { message?: string }).message ||
            `HTTP ${response.status}`,
          details: errorData,
        };
      }

      // 204 No Content (PUT 성공 등)
      if (response.status === 204) {
        return { success: true, data: {} as T };
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error) {
      console.error(`[BATCH] Jira ${this.instance} API Error:`, error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : '알 수 없는 오류가 발생했습니다.',
      };
    }
  }

  /**
   * 직접 호출 설정
   */
  private getDirectConfig() {
    if (this.instance === 'ignite') {
      return {
        baseUrl: JIRA_ENDPOINTS.IGNITE,
        email: process.env.IGNITE_JIRA_EMAIL!,
        token: process.env.IGNITE_JIRA_API_TOKEN!,
      };
    }
    return {
      baseUrl: JIRA_ENDPOINTS.HMG,
      email: process.env.HMG_JIRA_EMAIL!,
      token: process.env.HMG_JIRA_API_TOKEN!,
    };
  }

  /**
   * 프록시 호출 모드 (브라우저용)
   */
  private async proxyRequest<T>(
    path: string,
    options: JiraRequestOptions & { body?: unknown } = {}
  ): Promise<JiraApiResponse<T>> {
    try {
      const { method = 'GET', body, params } = options;

      // 쿼리 파라미터 구성
      const queryString = params
        ? '?' +
          new URLSearchParams(
            Object.entries(params).reduce(
              (acc, [key, value]) => {
                acc[key] = String(value);
                return acc;
              },
              {} as Record<string, string>
            )
          ).toString()
        : '';

      // Next.js API Route를 통해 프록시 호출
      // path 앞의 슬래시 제거 (중복 방지)
      const cleanPath = path.startsWith('/') ? path.slice(1) : path;
      const url = `/api/jira/${this.instance}/${cleanPath}${queryString}`;

      // 현재 사용자 ID를 헤더에 포함
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      const userId = readCurrentUserId();
      if (userId) headers['x-user-id'] = userId;

      const response = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      const result = await response.json();

      if (!result.success) {
        // 인증 정보 미설정 시 toast 안내 (중복 방지)
        if (response.status === 401 && result.code === 'CREDENTIALS_MISSING') {
          toast.error('Jira API Key 인증이 필요합니다', {
            id: 'jira-credentials-missing',
            description: '사용자 설정에서 API Key를 등록해주세요.',
            action: {
              label: '설정으로 이동',
              onClick: () => { window.location.href = '/settings/users'; },
            },
          });
        }

        // API 토큰 만료/무효화 시 팝업으로 안내
        // (동기화 중 401이 여러 번 발생해도 팝업은 한 번만 뜨도록 이벤트에서 dedupe)
        if (response.status === 401 && result.code === 'TOKEN_EXPIRED') {
          notifyTokenExpired(this.instance);
        }

        return {
          success: false,
          error: result.error || '요청 처리 중 오류가 발생했습니다.',
          details: result.details,
        };
      }

      return { success: true, data: result.data };
    } catch (error) {
      console.error(`Jira ${this.instance} API Error:`, error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : '알 수 없는 오류가 발생했습니다.',
      };
    }
  }

  /**
   * GET 요청
   */
  async get<T>(path: string, params?: Record<string, string | number>) {
    return this.request<T>(path, { method: 'GET', params });
  }

  /**
   * POST 요청
   */
  async post<T, D = Record<string, unknown> | unknown[]>(
    path: string,
    body: D
  ) {
    return this.request<T>(path, { method: 'POST', body });
  }

  /**
   * PUT 요청
   */
  async put<T, D = Record<string, unknown> | unknown[]>(path: string, body: D) {
    return this.request<T>(path, { method: 'PUT', body });
  }

  /**
   * DELETE 요청
   */
  async delete<T>(path: string) {
    return this.request<T>(path, { method: 'DELETE' });
  }

  // ---------------------------------------------------------------------------
  // 첨부파일 / 미디어 (스크린샷 동기화용)
  // ---------------------------------------------------------------------------

  /**
   * 첨부파일 바이너리 다운로드 (base64로 반환하여 직접/프록시 모드 모두 직렬화 가능)
   */
  async downloadAttachment(
    attachmentId: string
  ): Promise<{ base64: string; mimeType: string } | null> {
    if (this.isBatchMode) {
      try {
        const config = this.getDirectConfig();
        const url = `${config.baseUrl}${JIRA_API_VERSION}/attachment/content/${attachmentId}`;
        const authHeader = Buffer.from(
          `${config.email}:${config.token}`
        ).toString('base64');
        const res = await fetch(url, {
          headers: { Authorization: `Basic ${authHeader}` },
        });
        if (!res.ok) return null;
        const buf = Buffer.from(await res.arrayBuffer());
        return {
          base64: buf.toString('base64'),
          mimeType:
            res.headers.get('content-type') || 'application/octet-stream',
        };
      } catch (error) {
        console.error('[BATCH] 첨부 다운로드 실패:', error);
        return null;
      }
    }

    const result = await this.proxyRequest<{ base64: string; mimeType: string }>(
      `attachment/content/${attachmentId}`,
      { method: 'GET', params: { __binary: '1' } }
    );
    return result.success && result.data ? result.data : null;
  }

  /**
   * 첨부파일에 대응하는 Media Services UUID 조회
   * (attachment/content/{id} 의 302 Location → api.media.atlassian.com/file/<UUID>/binary)
   * ADF media 노드의 attrs.id 로 사용됨
   */
  async resolveMediaUuid(attachmentId: string): Promise<string | null> {
    if (this.isBatchMode) {
      try {
        const config = this.getDirectConfig();
        const url = `${config.baseUrl}${JIRA_API_VERSION}/attachment/content/${attachmentId}`;
        // fetch의 redirect:'manual'은 스펙상 opaque 응답이라 Location 헤더를 숨긴다.
        // axios(maxRedirects:0)는 302 응답과 Location 헤더를 그대로 노출한다.
        const axios = (await import('axios')).default;
        const res = await axios.get(url, {
          auth: { username: config.email, password: config.token },
          maxRedirects: 0,
          validateStatus: () => true,
        });
        const headers = res.headers as Record<string, string | undefined>;
        const location = headers.location || headers.Location || null;
        return JiraClient.parseMediaUuid(location);
      } catch (error) {
        console.error('[BATCH] media UUID 조회 실패:', error);
        return null;
      }
    }

    const result = await this.proxyRequest<{ uuid: string | null }>(
      `attachment/content/${attachmentId}`,
      { method: 'GET', params: { __media: 'uuid' } }
    );
    return result.success && result.data ? result.data.uuid : null;
  }

  /**
   * 첨부파일 업로드 (multipart/form-data)
   * 반환: 생성된 첨부 객체 배열
   */
  async uploadAttachment(
    issueKey: string,
    filename: string,
    mimeType: string,
    base64: string
  ): Promise<Array<{ id: string; filename: string }> | null> {
    if (this.isBatchMode) {
      try {
        const config = this.getDirectConfig();
        const url = `${config.baseUrl}${JIRA_API_VERSION}/issue/${issueKey}/attachments`;
        const authHeader = Buffer.from(
          `${config.email}:${config.token}`
        ).toString('base64');

        const form = new FormData();
        const blob = new Blob([Buffer.from(base64, 'base64')], {
          type: mimeType || 'application/octet-stream',
        });
        form.append('file', blob, filename);

        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Basic ${authHeader}`,
            'X-Atlassian-Token': 'no-check',
            Accept: 'application/json',
          },
          body: form,
        });
        if (!res.ok) return null;
        return await res.json();
      } catch (error) {
        console.error('[BATCH] 첨부 업로드 실패:', error);
        return null;
      }
    }

    // 프록시 모드: multipart FormData 전송
    try {
      const byteChars = atob(base64);
      const bytes = new Uint8Array(byteChars.length);
      for (let i = 0; i < byteChars.length; i++) {
        bytes[i] = byteChars.charCodeAt(i);
      }
      const blob = new Blob([bytes], {
        type: mimeType || 'application/octet-stream',
      });
      const form = new FormData();
      form.append('file', blob, filename);

      const headers: Record<string, string> = {};
      const userId = readCurrentUserId();
      if (userId) headers['x-user-id'] = userId;

      const response = await fetch(
        `/api/jira/${this.instance}/issue/${issueKey}/attachments`,
        { method: 'POST', headers, body: form }
      );
      const result = await response.json();
      return result.success ? result.data : null;
    } catch (error) {
      console.error('첨부 업로드 실패:', error);
      return null;
    }
  }

  /**
   * api.media.atlassian.com/file/<UUID>/binary 형태의 URL에서 UUID 추출
   */
  static parseMediaUuid(location: string | null | undefined): string | null {
    if (!location) return null;
    const match = location.match(/\/file\/([0-9a-fA-F-]{36})/);
    return match ? match[1] : null;
  }
}
