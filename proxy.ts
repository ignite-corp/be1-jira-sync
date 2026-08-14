import { NextRequest, NextResponse } from 'next/server';

/**
 * 허용된 VPN 공인 IP 대역 (CIDR)
 *
 * 값은 저장소에 두지 않는다. `ALLOWED_CIDRS` 환경변수에 쉼표로 구분해 넣을 것.
 * 예: ALLOWED_CIDRS="203.0.113.0/24,198.51.100.0/24"
 *
 * 미설정 시 전면 차단(fail-closed)이다. 로컬 개발은 NODE_ENV=development,
 * 예외 허용이 필요하면 DISABLE_IP_RESTRICTION=true 를 쓴다.
 */
const ALLOWED_CIDRS = (process.env.ALLOWED_CIDRS ?? '')
  .split(',')
  .map((cidr) => cidr.trim())
  .filter(Boolean);

function ipToNumber(ip: string): number {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isIpInCidr(ip: string, cidr: string): boolean {
  const [network, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr, 10);
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipToNumber(ip) & mask) === (ipToNumber(network) & mask);
}

function isAllowedIp(ip: string): boolean {
  return ALLOWED_CIDRS.some((cidr) => isIpInCidr(ip, cidr));
}

export function proxy(request: NextRequest) {
  // 개발 환경에서는 IP 제한 미적용
  if (process.env.NODE_ENV === 'development') {
    return NextResponse.next();
  }

  // IP 제한 비활성화 옵션 (환경변수로 제어)
  if (process.env.DISABLE_IP_RESTRICTION === 'true') {
    return NextResponse.next();
  }

  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    '';

  // API 배치 호출은 허용 (GitHub Actions 등)
  if (request.nextUrl.pathname.startsWith('/api/batch')) {
    return NextResponse.next();
  }

  if (!ip || !isAllowedIp(ip)) {
    const html = `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>접근 제한</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #f8fafc;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #1e293b;
    }
    .container {
      text-align: center;
      padding: 3rem 2rem;
      max-width: 420px;
    }
    .icon {
      font-size: 3.5rem;
      margin-bottom: 1.5rem;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 700;
      margin-bottom: 0.75rem;
    }
    p {
      font-size: 0.925rem;
      color: #64748b;
      line-height: 1.6;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">🔒</div>
    <h1>VPN 환경에서 접속해주세요</h1>
    <p>이 서비스는 사내 VPN에 연결된 환경에서만<br>이용할 수 있습니다.</p>
  </div>
</body>
</html>`;
    return new NextResponse(html, {
      status: 403,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * 정적 파일(_next/static, favicon 등)과 API 배치 경로를 제외한 모든 경로에 적용
     */
    '/((?!_next/static|_next/image|favicon.ico).*)',
  ],
};
