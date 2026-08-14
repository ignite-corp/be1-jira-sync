import { NextRequest, NextResponse } from 'next/server';
import { JIRA_ENDPOINTS, JIRA_API_VERSION } from '@/lib/constants/jira';
import { resolveJiraCredentials } from '@/lib/jira-credentials';
import axios, { AxiosError } from 'axios';
import https from 'https';
import FormData from 'form-data';

const JIRA_BASE = JIRA_ENDPOINTS.HMG;

// SSL 인증서 검증 비활성화 (내부 네트워크용)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const params = await context.params;
  return handleJiraRequest(request, params, 'GET');
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const params = await context.params;
  return handleJiraRequest(request, params, 'POST');
}

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const params = await context.params;
  return handleJiraRequest(request, params, 'PUT');
}

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ path: string[] }> }
) {
  const params = await context.params;
  return handleJiraRequest(request, params, 'DELETE');
}

async function handleJiraRequest(
  request: NextRequest,
  params: { path: string[] },
  method: string
) {
  try {
    const userId = request.headers.get('x-user-id');
    const credentials = await resolveJiraCredentials('hmg', userId);

    if (!credentials) {
      return NextResponse.json(
        {
          success: false,
          error: 'Jira 인증 정보가 설정되지 않았습니다. 사용자 설정에서 API Key를 등록해주세요.',
          code: 'CREDENTIALS_MISSING',
        },
        { status: 401 }
      );
    }

    const { email, apiToken } = credentials;

    // URL 경로 구성
    const path = params.path.join('/');

    // 내부 전용 쿼리(__binary, __media)는 Jira로 전달하지 않음
    const forwardParams = new URLSearchParams(request.nextUrl.searchParams);
    const wantBinary = forwardParams.get('__binary') === '1';
    const wantMediaUuid = forwardParams.get('__media') === 'uuid';
    forwardParams.delete('__binary');
    forwardParams.delete('__media');
    const searchParams = forwardParams.toString();

    /**
     * Jira Agile API는 /rest/agile/1.0 를 사용하고,
     * Jira Platform API는 /rest/api/3 를 사용합니다.
     *
     * 기존 구현은 무조건 /rest/api/3 를 붙여서
     * /rest/api/3/agile/... 형태의 잘못된 URL이 만들어졌습니다.
     */
    const isAgileApi = path.startsWith('agile/');
    const baseUrl = isAgileApi
      ? `${JIRA_BASE}/rest`
      : `${JIRA_BASE}${JIRA_API_VERSION}`;
    const url = `${baseUrl}/${path}${searchParams ? `?${searchParams}` : ''}`;

    const auth = { username: email, password: apiToken };

    // 1) 첨부 → Media Services UUID 조회 (302 Location 파싱)
    if (method === 'GET' && wantMediaUuid) {
      const res = await axios.get(url, {
        auth,
        httpsAgent,
        maxRedirects: 0,
        validateStatus: () => true,
      });
      const headers = res.headers as Record<string, string | undefined>;
      const location = headers.location || headers.Location || null;
      const match = location?.match(/\/file\/([0-9a-fA-F-]{36})/);
      return NextResponse.json({
        success: true,
        data: { uuid: match ? match[1] : null },
      });
    }

    // 2) 첨부 바이너리 다운로드 → base64
    if (method === 'GET' && wantBinary) {
      // attachment/content/{id} 는 보통 media CDN(api.media.atlassian.com)으로
      // 302 리다이렉트된다. 자격증명/커스텀 httpsAgent 를 media 도메인으로 넘기면
      // 연결이 리셋(ECONNRESET)되므로, 리다이렉트를 직접 처리해 토큰이 포함된
      // 서명 URL을 자격증명 없이 기본 TLS 로 받아온다.
      const first = await axios.get(url, {
        auth,
        httpsAgent,
        responseType: 'arraybuffer',
        maxRedirects: 0,
        maxContentLength: Infinity,
        validateStatus: (s) => s >= 200 && s < 400,
      });

      let payload = first.data;
      let resHeaders = first.headers as Record<string, string | undefined>;

      if (first.status >= 300) {
        const loc = resHeaders.location || resHeaders.Location;
        if (!loc) {
          return NextResponse.json(
            {
              success: false,
              error: '첨부 다운로드 리다이렉트 URL을 찾지 못했습니다.',
            },
            { status: 502 }
          );
        }
        const signed = await axios.get(loc, {
          responseType: 'arraybuffer',
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        });
        payload = signed.data;
        resHeaders = signed.headers as Record<string, string | undefined>;
      }

      return NextResponse.json({
        success: true,
        data: {
          base64: Buffer.from(payload).toString('base64'),
          mimeType: resHeaders['content-type'] || 'application/octet-stream',
        },
      });
    }

    // 3) 첨부 업로드 (multipart/form-data 패스스루)
    const contentType = request.headers.get('content-type') || '';
    if (method === 'POST' && contentType.includes('multipart/form-data')) {
      const inForm = await request.formData();
      const file = inForm.get('file');
      if (!file || typeof file === 'string') {
        return NextResponse.json(
          { success: false, error: '업로드할 파일이 없습니다.' },
          { status: 400 }
        );
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const outForm = new FormData();
      outForm.append('file', buf, {
        filename: file.name || 'attachment',
        contentType: file.type || 'application/octet-stream',
      });

      const res = await axios.post(url, outForm, {
        auth,
        httpsAgent,
        headers: {
          ...outForm.getHeaders(),
          'X-Atlassian-Token': 'no-check',
          Accept: 'application/json',
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      return NextResponse.json({ success: true, data: res.data });
    }

    // 요청 바디 읽기 (POST, PUT의 경우)
    let body;
    if (method === 'POST' || method === 'PUT') {
      try {
        body = await request.json();
      } catch {
        body = null;
      }
    }

    // Jira API 호출 (axios 사용)
    const response = await axios({
      method: method.toLowerCase() as 'get' | 'post' | 'put' | 'delete',
      url,
      auth,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      data: body,
      httpsAgent, // SSL 인증서 검증 비활성화
    });

    return NextResponse.json({
      success: true,
      data: response.data,
    });
  } catch (error) {
    // axios 에러 처리
    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<{
        errorMessages?: string[];
        errors?: Record<string, string>;
        message?: string;
      }>;
      console.error(
        'HMG Jira API Error:',
        axiosError.response?.status,
        JSON.stringify(axiosError.response?.data) || axiosError.message
      );

      if (axiosError.response) {
        const status = axiosError.response.status;
        const data = axiosError.response.data;
        const fieldErrors = data?.errors
          ? Object.values(data.errors).join('; ')
          : '';
        // Jira가 401을 반환하면 API 토큰이 만료/무효화된 경우다.
        // 클라이언트에서 팝업으로 안내할 수 있도록 코드를 부여한다.
        const isTokenExpired = status === 401;
        return NextResponse.json(
          {
            success: false,
            error: isTokenExpired
              ? 'Jira API 토큰이 만료되었거나 유효하지 않습니다. 사용자 설정에서 API Key를 다시 등록해주세요.'
              : data?.errorMessages?.[0] ||
                fieldErrors ||
                data?.message ||
                '요청 처리 중 오류가 발생했습니다.',
            code: isTokenExpired ? 'TOKEN_EXPIRED' : undefined,
            details: data,
          },
          { status }
        );
      }
    }

    console.error('HMG Jira API Error:', error);
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
