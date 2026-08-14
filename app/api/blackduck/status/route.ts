import { NextRequest, NextResponse } from 'next/server';
import axios, { AxiosError } from 'axios';
import https from 'https';

// SSL 인증서 검증 비활성화 (내부 네트워크용)
const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

// Bearer token 캐시 (server runtime에서만 유지; 재시작/재배포 시 초기화)
// 토큰이 프로젝트별로 달라질 수 있어 key별로 캐시합니다.
const cachedBearerByKey: Record<string, { token: string; expiresAt: number }> =
  {};

type BlackDuckStep =
  | 'authenticate'
  | 'project'
  | 'versions'
  | 'policy'
  | 'risk';

class BlackDuckStepError extends Error {
  step: BlackDuckStep;
  url: string;
  status?: number;
  contentType?: string | null;
  responseSnippet?: string;

  constructor(args: {
    step: BlackDuckStep;
    url: string;
    message: string;
    status?: number;
    contentType?: string | null;
    responseSnippet?: string;
  }) {
    super(args.message);
    this.step = args.step;
    this.url = args.url;
    this.status = args.status;
    this.contentType = args.contentType ?? null;
    this.responseSnippet = args.responseSnippet;
  }
}

type BlackDuckHalList<T> = {
  items?: T[];
  totalCount?: number;
};

type BlackDuckMeta = {
  href?: string;
  links?: Array<{
    rel?: string;
    href?: string;
  }>;
};

type BlackDuckProject = {
  name?: string;
  _meta?: BlackDuckMeta;
};

type BlackDuckVersion = {
  versionName?: string;
  distribution?: string;
  _meta?: BlackDuckMeta;
  // Some installations may include timestamps on version items; optional.
  createdAt?: string;
  updatedAt?: string;
};

function pickLink(meta: BlackDuckMeta | undefined, rel: string): string | null {
  const href = meta?.links?.find((l) => l.rel === rel)?.href;
  return href && href.trim() ? href.trim() : null;
}

function absoluteUrl(base: string, maybeRelative: string): string {
  if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
  return new URL(maybeRelative.replace(/^\//, '/'), base).toString();
}

function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host}`;
  } catch {
    // Not a full URL
    return trimmed.replace(/\/+$/, '');
  }
}

function getApiTokenAuthHeader(projectKey: string | null): string | null {
  // Explicit header can be either:
  // - "token <api-token>" (used for /api/tokens/authenticate)
  // - or even "Bearer <bearer-token>" (if you already exchanged it elsewhere)
  const explicit = process.env.BLACKDUCK_AUTH_HEADER?.trim();
  if (explicit) return explicit;

  const normalizedProjectKey = projectKey?.trim().toLowerCase() || null;

  const hbGroupwareToken =
    process.env.BLACKDUCK_HB_GROUPWARE_TOKEN?.trim() ||
    process.env.BLACKDUCK_HB_GROUPWARE_API_TOKEN?.trim();
  const cpoToken =
    process.env.BLACKDUCK_CPO_TOKEN?.trim() ||
    process.env.BLACKDUCK_CPO_API_TOKEN?.trim();

  const defaultToken =
    process.env.BLACKDUCK_API_TOKEN?.trim() ||
    process.env.BLACKDUCK_TOKEN?.trim();

  const apiToken =
    normalizedProjectKey === 'cpo'
      ? cpoToken
      : normalizedProjectKey === 'hmg-board' ||
          normalizedProjectKey === 'groupware'
        ? hbGroupwareToken
        : defaultToken;
  if (!apiToken) return null;

  // Per Black Duck docs: Authorization: token <your-api-token>
  return `token ${apiToken}`;
}

function getBlackDuckBaseUrl(): string | null {
  const base = process.env.BLACKDUCK_BASE_URL;
  if (base && base.trim()) return normalizeBaseUrl(base);

  // Also allow providing a full project URL like:
  // https://blackduck.example.com/api/projects/<uuid>
  const projectUrl = process.env.BLACKDUCK_PROJECT_URL?.trim();
  if (projectUrl) {
    try {
      const u = new URL(projectUrl);
      return `${u.protocol}//${u.host}`;
    } catch {
      return null;
    }
  }
  return null;
}

function toSnippet(data: unknown, limit = 1200): string | undefined {
  if (data == null) return undefined;
  const s =
    typeof data === 'string'
      ? data
      : (() => {
          try {
            return JSON.stringify(data);
          } catch {
            return String(data);
          }
        })();
  return s.length > limit ? `${s.slice(0, limit)}...` : s;
}

function isHtmlLike(data: unknown): boolean {
  if (typeof data !== 'string') return false;
  const t = data.trim().toLowerCase();
  return t.startsWith('<!doctype html') || t.startsWith('<html');
}

function getStringProp(obj: unknown, key: string): string | null {
  if (typeof obj !== 'object' || obj === null) return null;
  if (!(key in obj)) return null;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : v != null ? String(v) : null;
}

function getNestedStringProp(obj: unknown, path: string[]): string | null {
  let cur: unknown = obj;
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return null;
    if (!(key in (cur as Record<string, unknown>))) return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'string' ? cur : cur != null ? String(cur) : null;
}

function parseDateMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

async function getBearerAuthHeader(
  baseUrl: string,
  projectKey: string | null
): Promise<string | null> {
  // If user already provides a Bearer token, just use it.
  const bearerFromEnv = process.env.BLACKDUCK_BEARER_TOKEN?.trim();
  if (bearerFromEnv) return `Bearer ${bearerFromEnv}`;

  const explicit = process.env.BLACKDUCK_AUTH_HEADER?.trim();
  if (explicit?.toLowerCase().startsWith('bearer ')) return explicit;

  // Cache
  const now = Date.now();
  const tokenHeader = getApiTokenAuthHeader(projectKey);
  if (!tokenHeader) return null;

  const cacheKey = `${baseUrl}|${tokenHeader}`;
  const cached = cachedBearerByKey[cacheKey];
  if (cached && cached.expiresAt > now) {
    return `Bearer ${cached.token}`;
  }

  // Exchange API token for Bearer token
  const authUrl = `${baseUrl.replace(/\/+$/, '')}/api/tokens/authenticate`;
  let res;
  try {
    res = await axios.post(authUrl, null, {
      headers: {
        Accept: 'application/vnd.blackducksoftware.user-4+json',
        Authorization: tokenHeader,
      },
      httpsAgent,
      validateStatus: () => true,
    });
  } catch {
    throw new BlackDuckStepError({
      step: 'authenticate',
      url: authUrl,
      message:
        'Black Duck 토큰 교환(/api/tokens/authenticate) 호출에 실패했습니다.',
    });
  }

  if (res.status >= 400) {
    throw new BlackDuckStepError({
      step: 'authenticate',
      url: authUrl,
      message:
        'Black Duck 토큰 교환(/api/tokens/authenticate)에 실패했습니다. (BASE_URL 또는 권한/게이트웨이 설정을 확인해주세요)',
      status: res.status,
      contentType: String(res.headers?.['content-type'] ?? ''),
      responseSnippet: toSnippet(res.data),
    });
  }
  if (isHtmlLike(res.data)) {
    throw new BlackDuckStepError({
      step: 'authenticate',
      url: authUrl,
      message:
        'Black Duck API 대신 HTML 페이지가 반환되었습니다. BLACKDUCK_BASE_URL 값(https://host 형태) 또는 접근 권한을 확인해주세요.',
      status: res.status,
      contentType: String(res.headers?.['content-type'] ?? ''),
      responseSnippet: toSnippet(res.data),
    });
  }

  const bearer =
    (res.data?.bearerToken as string | undefined) ||
    (res.data?.access_token as string | undefined) ||
    (res.data?.token as string | undefined);

  if (!bearer || !bearer.trim()) return null;

  // TTL: installations vary; keep short to be safe
  cachedBearerByKey[cacheKey] = {
    token: bearer.trim(),
    expiresAt: now + 10 * 60 * 1000,
  };
  return `Bearer ${cachedBearerByKey[cacheKey].token}`;
}

export async function GET(request: NextRequest) {
  try {
    const baseUrl = getBlackDuckBaseUrl();
    const { searchParams } = new URL(request.url);
    const projectKey = searchParams.get('projectKey');

    const bearerAuthHeader = baseUrl
      ? await getBearerAuthHeader(baseUrl, projectKey)
      : null;

    if (!baseUrl) {
      return NextResponse.json(
        {
          success: false,
          error:
            'BLACKDUCK_BASE_URL (또는 BLACKDUCK_PROJECT_URL) 환경 변수가 설정되지 않았습니다.',
        },
        { status: 500 }
      );
    }
    if (!bearerAuthHeader) {
      return NextResponse.json(
        {
          success: false,
          error:
            'BLACKDUCK_API_TOKEN(또는 BLACKDUCK_TOKEN) / BLACKDUCK_AUTH_HEADER / BLACKDUCK_BEARER_TOKEN 환경 변수가 설정되지 않았습니다.',
        },
        { status: 500 }
      );
    }

    const projectId =
      searchParams.get('projectId') || process.env.BLACKDUCK_PROJECT_ID;

    const projectUrlFromQuery = searchParams.get('projectUrl');
    const projectUrlFromEnv = process.env.BLACKDUCK_PROJECT_URL;

    const projectUrl =
      projectUrlFromQuery ||
      projectUrlFromEnv ||
      (projectId
        ? `${baseUrl}/api/projects/${encodeURIComponent(projectId)}`
        : null);

    if (!projectUrl) {
      return NextResponse.json(
        { success: false, error: 'projectId 또는 projectUrl이 필요합니다.' },
        { status: 400 }
      );
    }

    // 1) Project 조회
    let projectRes;
    try {
      projectRes = await axios.get<BlackDuckProject>(projectUrl, {
        headers: {
          Accept: 'application/vnd.blackducksoftware.project-detail-4+json',
          Authorization: bearerAuthHeader,
        },
        httpsAgent,
      });
    } catch (e) {
      const ax = e as AxiosError<unknown>;
      throw new BlackDuckStepError({
        step: 'project',
        url: projectUrl,
        message: 'Black Duck 프로젝트 조회에 실패했습니다.',
        status: ax.response?.status,
        contentType:
          (ax.response?.headers?.['content-type'] as string | undefined) ??
          null,
        responseSnippet: toSnippet(ax.response?.data),
      });
    }

    const project = projectRes.data;
    const projectName = project?.name;
    const versionsLink =
      pickLink(project?._meta, 'versions') || `${projectUrl}/versions`;

    // 2) Versions 중 최신 1개 조회 (정렬 파라미터는 설치마다 다를 수 있어, best-effort로 시도)
    const versionsUrl = new URL(absoluteUrl(baseUrl, versionsLink));
    // We'll fetch a small window so we can choose "latest scanned" when possible.
    if (!versionsUrl.searchParams.get('limit'))
      versionsUrl.searchParams.set('limit', '10');
    if (!versionsUrl.searchParams.get('offset'))
      versionsUrl.searchParams.set('offset', '0');
    // Some installations support sort=-bomLastUpdatedAt / -updatedAt / -createdAt; harmless if ignored
    if (!versionsUrl.searchParams.get('sort'))
      versionsUrl.searchParams.set('sort', '-updatedAt');

    let versionsData: BlackDuckHalList<BlackDuckVersion> | null = null;
    try {
      // Some Black Duck deployments return 406 for vendor-specific version media types on list endpoints.
      // Try vendor Accept first, then fall back to application/json and finally */*.
      const tryAccepts = [
        'application/vnd.blackducksoftware.project-version-4+json',
        'application/json',
        '*/*',
      ];

      let last: { status: number; contentType: string; data: unknown } | null =
        null;

      for (const accept of tryAccepts) {
        const res = await axios.get<BlackDuckHalList<BlackDuckVersion>>(
          versionsUrl.toString(),
          {
            headers: {
              Accept: accept,
              Authorization: bearerAuthHeader,
            },
            httpsAgent,
            validateStatus: () => true,
          }
        );

        last = {
          status: res.status,
          contentType: String(res.headers?.['content-type'] ?? ''),
          data: res.data,
        };
        if (res.status === 406) continue;
        if (res.status >= 400) {
          throw new BlackDuckStepError({
            step: 'versions',
            url: versionsUrl.toString(),
            message: 'Black Duck 버전 목록 조회에 실패했습니다.',
            status: res.status,
            contentType: last.contentType,
            responseSnippet: toSnippet(last.data),
          });
        }

        versionsData = res.data;
        break;
      }

      if (!versionsData && last) {
        throw new BlackDuckStepError({
          step: 'versions',
          url: versionsUrl.toString(),
          message:
            'Black Duck 버전 목록 조회가 406(Not Acceptable)로 실패했습니다. Accept 헤더 호환성 문제입니다.',
          status: last.status,
          contentType: last.contentType,
          responseSnippet: toSnippet(last.data),
        });
      }
    } catch (e) {
      if (e instanceof BlackDuckStepError) throw e;
      const ax = e as AxiosError<unknown>;
      throw new BlackDuckStepError({
        step: 'versions',
        url: versionsUrl.toString(),
        message: 'Black Duck 버전 목록 조회에 실패했습니다.',
        status: ax.response?.status,
        contentType:
          (ax.response?.headers?.['content-type'] as string | undefined) ??
          null,
        responseSnippet: toSnippet(ax.response?.data),
      });
    }

    const items = versionsData?.items ?? [];
    const fallbackLatest = items[0];

    const getVersionHref = (v: BlackDuckVersion | undefined): string | null => {
      if (!v) return null;
      return (
        v._meta?.href ||
        // fallback: sometimes version list items expose href under _meta.links self
        pickLink(v._meta, 'self')
      );
    };

    // Prefer "latest scanned" if possible:
    // - for a small window of versions, fetch each version's risk-profile and compare bomLastUpdatedAt
    // - fallback to first item if any step fails
    let selectedVersion: BlackDuckVersion | undefined = fallbackLatest;
    let selectedVersionHref: string | null = getVersionHref(selectedVersion);
    let selectedRiskProfile: unknown | null = null;

    if (items.length > 1) {
      const candidates = items
        .map((v) => ({ v, href: getVersionHref(v) }))
        .filter((x): x is { v: BlackDuckVersion; href: string } => !!x.href)
        .slice(0, 10);

      const riskResults = await Promise.allSettled(
        candidates.map(async ({ v, href }) => {
          const versionUrl = absoluteUrl(baseUrl, href);
          const riskUrl = `${versionUrl}/risk-profile`;
          const res = await axios.get(riskUrl, {
            headers: {
              Accept: 'application/json',
              Authorization: bearerAuthHeader,
            },
            httpsAgent,
            validateStatus: () => true,
          });
          if (res.status >= 400 || isHtmlLike(res.data)) {
            throw new Error(`risk-profile failed: ${res.status}`);
          }
          const bomLastUpdatedAt =
            getNestedStringProp(res.data, ['raw', 'bomLastUpdatedAt']) ||
            getStringProp(res.data, 'bomLastUpdatedAt');
          const ms = parseDateMs(bomLastUpdatedAt);
          return { v, href, ms, riskProfile: res.data };
        })
      );

      const okResults = riskResults
        .filter(
          (
            r
          ): r is PromiseFulfilledResult<{
            v: BlackDuckVersion;
            href: string;
            ms: number | null;
            riskProfile: unknown;
          }> => r.status === 'fulfilled'
        )
        .map((r) => r.value)
        .filter((x) => x.ms != null);

      if (okResults.length > 0) {
        okResults.sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0));
        selectedVersion = okResults[0].v;
        selectedVersionHref = okResults[0].href;
        selectedRiskProfile = okResults[0].riskProfile;
      }
    }

    if (!selectedVersionHref) {
      return NextResponse.json(
        {
          success: true,
          data: {
            project: { id: projectId, name: projectName },
            version: null,
            policy: null,
            riskProfile: null,
            ok: null,
            note: '프로젝트는 조회했지만 버전 정보를 찾지 못했습니다(스캔 결과가 없을 수 있음).',
          },
        },
        { headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const versionUrl = absoluteUrl(baseUrl, selectedVersionHref);

    // 3) Policy status / Risk profile (best-effort; endpoint names vary slightly)
    const policyUrl = `${versionUrl}/policy-status`;
    const riskUrl = `${versionUrl}/risk-profile`;

    const [policyRes, riskRes] = await Promise.allSettled([
      axios.get(policyUrl, {
        headers: {
          Accept: 'application/json',
          Authorization: bearerAuthHeader,
        },
        httpsAgent,
      }),
      selectedRiskProfile != null
        ? Promise.resolve({ data: selectedRiskProfile })
        : axios.get(riskUrl, {
            headers: {
              Accept: 'application/json',
              Authorization: bearerAuthHeader,
            },
            httpsAgent,
          }),
    ]);

    const policy =
      policyRes.status === 'fulfilled' ? policyRes.value.data : null;
    const riskProfile =
      riskRes.status === 'fulfilled' ? riskRes.value.data : null;

    const bomLastUpdatedAt =
      getNestedStringProp(riskProfile, ['raw', 'bomLastUpdatedAt']) ||
      getStringProp(riskProfile, 'bomLastUpdatedAt');
    const versionUpdatedAt = selectedVersion?.updatedAt ?? null;
    const versionCreatedAt = selectedVersion?.createdAt ?? null;
    const scannedAt =
      bomLastUpdatedAt || versionUpdatedAt || versionCreatedAt || null;

    const policyStatus: string | null =
      (policy?.overallStatus as string | undefined) ||
      (policy?.status as string | undefined) ||
      null;

    const ok =
      policyStatus != null
        ? !/violation|in_violation|fail/i.test(policyStatus)
        : null;

    return NextResponse.json(
      {
        success: true,
        data: {
          ok,
          project: { id: projectId, name: projectName, url: projectUrl },
          version: {
            name: selectedVersion?.versionName ?? null,
            url: versionUrl,
          },
          scan: {
            scannedAt,
            source: bomLastUpdatedAt
              ? 'bomLastUpdatedAt'
              : versionUpdatedAt
                ? 'version.updatedAt'
                : versionCreatedAt
                  ? 'version.createdAt'
                  : null,
          },
          policy: policy ? { status: policyStatus, raw: policy } : null,
          riskProfile: riskProfile ? { raw: riskProfile } : null,
        },
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('Black Duck API Error:', error);

    if (error instanceof BlackDuckStepError) {
      return NextResponse.json(
        {
          success: false,
          error: error.message,
          step: error.step,
          url: error.url,
          status: error.status,
          contentType: error.contentType,
          details: error.responseSnippet,
        },
        { status: error.status ?? 500 }
      );
    }

    if (axios.isAxiosError(error)) {
      const axiosError = error as AxiosError<unknown>;
      if (axiosError.response) {
        const data = axiosError.response.data;
        const message =
          typeof data === 'object' && data !== null && 'message' in data
            ? String((data as { message?: unknown }).message ?? '')
            : '';

        return NextResponse.json(
          {
            success: false,
            error: message || '요청 처리 중 오류가 발생했습니다.',
            details: data,
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
