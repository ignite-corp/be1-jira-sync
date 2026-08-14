import { NextRequest, NextResponse } from 'next/server';
import { JIRA_ENDPOINTS, JIRA_API_VERSION } from '@/lib/constants/jira';
import axios from 'axios';
import https from 'https';

const httpsAgent = new https.Agent({ rejectUnauthorized: false });

/**
 * Jira 인증 정보 검증 API
 * 입력된 email + apiToken으로 /myself를 호출해 유효성을 확인합니다.
 */
export async function POST(request: NextRequest) {
  try {
    const { instance, email, apiToken } = await request.json();

    if (!instance || !email || !apiToken) {
      return NextResponse.json(
        { success: false, error: 'instance, email, apiToken은 필수입니다.' },
        { status: 400 }
      );
    }

    const baseUrl =
      instance === 'hmg' ? JIRA_ENDPOINTS.HMG : JIRA_ENDPOINTS.IGNITE;

    const response = await axios({
      method: 'get',
      url: `${baseUrl}${JIRA_API_VERSION}/myself`,
      auth: { username: email, password: apiToken },
      headers: { Accept: 'application/json' },
      httpsAgent,
    });

    return NextResponse.json({
      success: true,
      data: {
        accountId: response.data.accountId,
        displayName: response.data.displayName,
        emailAddress: response.data.emailAddress,
      },
    });
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      const status = error.response.status;
      const msg =
        status === 401
          ? '인증 실패: 이메일 또는 API 토큰이 올바르지 않습니다.'
          : status === 403
            ? '권한이 없습니다. API 토큰 권한을 확인해주세요.'
            : `Jira API 오류 (${status})`;
      return NextResponse.json({ success: false, error: msg }, { status });
    }

    return NextResponse.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : '알 수 없는 오류가 발생했습니다.',
      },
      { status: 500 }
    );
  }
}
