# Jira 통합 관리 도구

> 원본 레포: https://github.com/Ignite-FEDev1/jira-sync

Jira 자동화 및 통합 관리 도구입니다.

## 🚀 설치 및 실행

### 1. 프로젝트 클론

```bash
git clone https://github.com/Ignite-FEDev1/jira-sync.git
cd fe1-web
```

### 2. 의존성 설치

```bash
npm install
```

### 3. 환경 변수 설정

프로젝트 루트에 `.env.local` 파일을 생성하고 아래 내용을 추가:

```bash
# Ignite Jira 인증 정보
IGNITE_JIRA_EMAIL=your-email@ignitecorp.com
IGNITE_JIRA_API_TOKEN=your_ignite_api_token

# HMG Jira 인증 정보 (VPN 필요)
HMG_JIRA_EMAIL=your-email@hyundai-partners.com
HMG_JIRA_API_TOKEN=your_hmg_api_token

# Blackduck
BLACKDUCK_BASE_URL=
BLACKDUCK_HB_GROUPWARE_TOKEN=
BLACKDUCK_CPO_TOKEN=

# Sonarqube
SONALQUBE_TOKEN=
SONARQUBE_URL=
```

> 💡 **API 토큰 발급**: Jira → 프로필 → 보안 → API 토큰 생성

### 4. 개발 서버 실행

```bash
npm run dev
```

### 5. 접속

```
http://localhost:7591
```

---

## 📝 개발 스크립트

- `npm run dev` - 개발 서버 실행 (포트 7591)
- `npm run build` - 프로덕션 빌드
- `npm run start` - 프로덕션 서버 실행
- `npm run lint` - ESLint 검사
- `npm run lint:fix` - ESLint 자동 수정
- `npm run format` - Prettier 포맷팅

---

## 🛠️ 기술 스택

- **Framework**: Next.js 16
- **Language**: TypeScript (strict mode)
- **Styling**: Tailwind CSS v3
- **UI Components**: shadcn/ui
- **HTTP Client**: Axios
- **Code Quality**: ESLint + Prettier

---

## 📁 프로젝트 구조

```
fe1-web/
├── app/                    # Next.js App Router
│   ├── api/               # API Routes (Jira 프록시)
│   ├── create-ticket/     # 티켓 생성 페이지
│   └── test*/             # 테스트 페이지
├── components/            # React 컴포넌트
│   └── ui/               # shadcn/ui 컴포넌트
├── lib/
│   ├── services/
│   │   ├── jira/         # Jira API 서비스
│   │   └── sync/         # 동기화 로직
│   ├── types/            # TypeScript 타입 정의
│   ├── constants/        # 상수 및 설정
│   └── utils/            # 유틸리티 함수
└── .env.local           # 환경 변수 (생성 필요)
```

---

## ⚠️ 주의사항

- **HMG Jira**: VPN 연결 필수
- **로컬 실행**: 이 도구는 로컬 개발 서버에서만 작동합니다
- **SSL 인증서**: 내부 네트워크 환경에 최적화됨

---

## 📚 주요 기능

- ✅ FEHG → KQ/HB/HDD/AUTOWAY 자동 동기화
- ✅ 에픽/티켓 지정 모드
- ✅ 스프린트 자동 매핑
- ✅ 실시간 로그 및 결과 표시
- ✅ 신규 생성/업데이트 구분
- ✅ FEHG 티켓 생성
