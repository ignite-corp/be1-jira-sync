import { NextRequest, NextResponse } from 'next/server';
import axios, { AxiosError } from 'axios';
import https from 'https';

// SSL 인증서 검증 비활성화 (내부 네트워크용)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

type SonarQubeProjectStatusResponse = {
  projectStatus?: {
    status?: string;
    conditions?: Array<{
      status?: string;
      metricKey?: string;
      comparator?: string;
      errorThreshold?: string;
      actualValue?: string;
    }>;
  };
};

type SonarQubeProjectAnalysesSearchResponse = {
  analyses?: Array<{
    date?: string;
  }>;
};

function isHtmlLike(data: unknown): boolean {
  if (typeof data !== 'string') return false;
  const t = data.trim().toLowerCase();
  return t.startsWith('<!doctype html') || t.startsWith('<html');
}

function getSonarBaseUrl(): string | null {
  const raw = process.env.SONARQUBE_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function getSonarToken(): string | null {
  // Support both correct and typo env var names to reduce setup friction.
  const token =
    process.env.SONARQUBE_TOKEN?.trim() ||
    process.env.SONALQUBE_TOKEN?.trim() ||
    '';
  return token ? token : null;
}

function buildAuthHeader(token: string): string {
  // SonarQube token auth = Basic base64("<token>:")
  const basic = Buffer.from(`${token}:`).toString('base64');
  return `Basic ${basic}`;
}

export async function GET(request: NextRequest) {
  try {
    const baseUrl = getSonarBaseUrl();
    const token = getSonarToken();

    if (!baseUrl) {
      return NextResponse.json(
        {
          success: false,
          error: 'SONARQUBE_URL 환경 변수가 설정되지 않았습니다.',
        },
        { status: 500 }
      );
    }
    if (!token) {
      return NextResponse.json(
        {
          success: false,
          error:
            'SONARQUBE_TOKEN(또는 SONALQUBE_TOKEN) 환경 변수가 설정되지 않았습니다.',
        },
        { status: 500 }
      );
    }

    const { searchParams } = new URL(request.url);
    const projectKey = searchParams.get('projectKey');

    if (!projectKey) {
      return NextResponse.json(
        { success: false, error: 'projectKey가 필요합니다.' },
        { status: 400 }
      );
    }

    const authHeaders = {
      Accept: 'application/json',
      Authorization: buildAuthHeader(token),
    };

    const qgUrl = `${baseUrl}/api/qualitygates/project_status?projectKey=${encodeURIComponent(
      projectKey
    )}`;
    const analysesUrl = `${baseUrl}/api/project_analyses/search?project=${encodeURIComponent(
      projectKey
    )}&ps=1`;

    const [qgRes, analysesRes] = await Promise.all([
      axios.get<SonarQubeProjectStatusResponse>(qgUrl, {
        headers: authHeaders,
        httpsAgent,
        validateStatus: () => true,
      }),
      axios.get<SonarQubeProjectAnalysesSearchResponse>(analysesUrl, {
        headers: authHeaders,
        httpsAgent,
        validateStatus: () => true,
      }),
    ]);

    if (qgRes.status >= 400) {
      return NextResponse.json(
        {
          success: false,
          error: 'SonarQube(Quality Gate) 조회에 실패했습니다.',
          status: qgRes.status,
          details: typeof qgRes.data === 'string' ? qgRes.data : qgRes.data,
        },
        { status: qgRes.status }
      );
    }

    const status = qgRes.data?.projectStatus?.status ?? 'UNKNOWN';
    const ok = status === 'OK';
    const conditions = qgRes.data?.projectStatus?.conditions ?? [];
    const projectUrl = `${baseUrl}/dashboard?id=${encodeURIComponent(projectKey)}`;
    const analysisDate =
      analysesRes.status < 400 && !isHtmlLike(analysesRes.data)
        ? (analysesRes.data?.analyses?.[0]?.date ?? null)
        : null;

    return NextResponse.json(
      {
        success: true,
        data: {
          ok,
          projectKey,
          baseUrl,
          projectUrl,
          analysisDate,
          qualityGateStatus: status,
          conditions,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('SonarQube API Error:', error);

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<unknown>;
      if (axiosError.response) {
        return NextResponse.json(
          {
            success: false,
            error: 'SonarQube 조회에 실패했습니다.',
            status: axiosError.response.status,
            details: axiosError.response.data,
          },
          { status: axiosError.response.status }
        );
      }
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
