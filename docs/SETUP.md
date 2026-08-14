# Jira 통합 관리 도구 - 프로젝트 구조 가이드

> 이 문서는 소스를 클론해서 자기 팀 환경에 맞게 재구성하려는 사람을 위한 가이드입니다.

## 빠른 시작

```bash
git clone <repo-url>
npm install
cp .env.example .env.local  # 환경변수 설정 후
npm run dev
```

## 환경변수 (.env.local)

| 변수명 | 용도 | 필수 |
|--------|------|------|
| `NEXT_PUBLIC_DB_URL` | DB URL (Supabase 또는 호환 서비스) | O |
| `NEXT_PUBLIC_DB_ANON_KEY` | DB 익명 키 (브라우저용) | O |
| `DB_SERVICE_ROLE_KEY` | DB 서비스 롤 키 (서버/배치용) | △ |
| `IGNITE_JIRA_EMAIL` | Jira 인증 이메일 (배치 전용) | △ |
| `IGNITE_JIRA_API_TOKEN` | Jira API 토큰 (배치 전용) | △ |
| `HMG_JIRA_EMAIL` | 2번째 Jira 인스턴스 이메일 (배치 전용) | △ |
| `HMG_JIRA_API_TOKEN` | 2번째 Jira 인스턴스 토큰 (배치 전용) | △ |

> 배치(`daily-sync`)를 사용하지 않으면 Jira 환경변수는 불필요합니다.
> 브라우저에서는 사용자별로 DB에 저장된 인증 정보를 사용합니다.

---

## 주요 파일

커스터마이징 시 가장 먼저 확인해야 할 파일들입니다.

| 파일 | 역할 | 수정 시점 |
|------|------|----------|
| `lib/db.ts` | DB 클라이언트 설정 | DB 서비스 변경 시 |
| `lib/constants/jira.ts` | Jira 인스턴스 URL/상수 | Jira 엔드포인트 변경 시 |
| `lib/services/jira/client.ts` | Jira API 클라이언트 (프록시/직접 호출) | API 호출 방식 변경 시 |
| `lib/services/sync/sync-orchestrator.ts` | 동기화 전체 흐름 관리 | 동기화 순서/조건 변경 시 |
| `lib/services/sync/db-field-mapper.ts` | DB 기반 필드 매핑 변환 | 필드 변환 방식 변경 시 |
| `lib/services/sync/transition-helper.ts` | 상태 전이 (BFS 최단경로) | 워크플로우 전이 로직 변경 시 |
| `proxy.ts` | IP 접근 제한 | 허용 IP 대역 변경 시 |
| `scripts/daily-sync.ts` | 일일 배치 동기화 스크립트 | 배치 로직 변경 시 |
| `.github/workflows/daily-sync.yml` | 배치 스케줄 (GitHub Actions) | 실행 주기 변경 시 |
| `db/supabase-init.sql` | DB 테이블 초기화 스크립트 | DB 스키마 확인/변경 시 |

---

## 프로젝트 구조

```
├── app/                          # Next.js App Router 페이지
│   ├── page.tsx                  # 메인 화면 (티켓 동기화)
│   ├── layout.tsx                # 전역 레이아웃
│   ├── select-user/              # 사용자 선택 화면
│   ├── deployment/               # 배포 관리
│   ├── settings/                 # 설정 페이지들
│   │   ├── users/                #   사용자 관리 (API Key 등록)
│   │   ├── teams/                #   팀 관리
│   │   ├── projects/             #   프로젝트 관리
│   │   └── field-mappings/       #   동기화 필드 매핑 설정
│   └── api/                      # API Routes (서버 프록시)
│       ├── jira/ignite/          #   1번째 Jira 인스턴스 프록시
│       ├── jira/hmg/             #   2번째 Jira 인스턴스 프록시
│       ├── jira/verify/          #   Jira 인증 검증
│       └── users/                #   사용자 조회 API
│
├── lib/                          # 핵심 라이브러리
│   ├── db.ts                     # ⭐ DB 클라이언트 (수정 포인트 #1)
│   ├── constants/jira.ts         # ⭐ Jira 인스턴스 URL/상수 (수정 포인트 #2)
│   ├── jira-credentials.ts       # 사용자별 Jira 인증 조회
│   ├── jira-fetch.ts             # Jira API fetch 유틸
│   ├── services/
│   │   ├── jira/                 # Jira API 클라이언트
│   │   │   ├── client.ts         # ⭐ API 클라이언트 (프록시/직접 호출)
│   │   │   ├── base.service.ts   # 공통 Jira 서비스
│   │   │   ├── ignite.service.ts # 1번째 인스턴스 서비스
│   │   │   └── hmg.service.ts    # 2번째 인스턴스 서비스
│   │   ├── sync/                 # ⭐ 동기화 엔진 (수정 포인트 #3)
│   │   │   ├── sync-orchestrator.ts  # 동기화 전체 흐름 관리
│   │   │   ├── ignite-sync.service.ts # 같은 Jira 내 프로젝트간 동기화
│   │   │   ├── hmg-sync.service.ts    # 다른 Jira 인스턴스로 동기화
│   │   │   ├── db-field-mapper.ts     # DB 기반 필드 매핑
│   │   │   ├── field-mapper.ts        # 필드 변환 로직
│   │   │   ├── sprint-mapper.ts       # 스프린트 매핑
│   │   │   ├── transition-helper.ts   # 상태 전이 (BFS 최단경로)
│   │   │   ├── logger.ts             # 실시간 로그
│   │   │   └── types.ts              # 동기화 관련 타입
│   │   ├── user-lookup.ts        # DB 사용자 조회
│   │   ├── confluence/           # Confluence 연동
│   │   └── deployment/           # 배포 관련 서비스
│   └── types/                    # 공통 타입 정의
│
├── components/                   # 공통 컴포넌트
│   ├── global-header-strip.tsx   # 상단 경고/안내 바
│   └── ui/                       # shadcn/ui 컴포넌트
│
├── contexts/
│   └── user-context.tsx          # 현재 사용자 Context
│
├── proxy.ts                      # Next.js Proxy (IP 접근 제한)
├── scripts/
│   └── daily-sync.ts             # 일일 배치 동기화 스크립트
└── .github/workflows/
    └── daily-sync.yml            # GitHub Actions 배치 스케줄
```

---

## DB 초기화

Supabase 프로젝트를 새로 생성한 뒤 아래 순서로 진행합니다.

### 1. Supabase 프로젝트 생성
1. [supabase.com](https://supabase.com) 에서 새 프로젝트 생성
2. Project Settings > API에서 아래 값 확인:
   - `Project URL` → `NEXT_PUBLIC_DB_URL`
   - `anon public` → `NEXT_PUBLIC_DB_ANON_KEY`
   - `service_role` → `DB_SERVICE_ROLE_KEY`

### 2. 스키마 생성
Supabase 대시보드 > SQL Editor에서 `db/supabase-init.sql` 실행

이 파일 하나로 10개 테이블, 트리거, 인덱스, RLS 정책이 모두 생성됩니다.

### 3. 환경변수 설정
```bash
cp .env.example .env.local
```
`.env.local`에 위에서 확인한 URL/KEY 값을 입력합니다.

---

## 수정 가이드 (케이스별)

### 1. 다른 DB를 사용하고 싶을 때

**수정 파일:** `lib/db.ts` (1개)

현재 Supabase JS 클라이언트를 사용합니다. 동일한 API(`.from().select().eq()` 등)를 제공하는
다른 서비스로 교체하려면 이 파일만 수정하면 됩니다.

```typescript
// lib/db.ts - 예: 다른 Supabase 호환 서비스로 교체
import { createClient } from '@supabase/supabase-js';
const dbUrl = process.env.NEXT_PUBLIC_DB_URL!;
const dbAnonKey = process.env.NEXT_PUBLIC_DB_ANON_KEY!;
export const db = createClient(dbUrl, dbAnonKey);
export const dbServer = createClient(dbUrl, process.env.DB_SERVICE_ROLE_KEY || dbAnonKey);
```

### 2. Jira 인스턴스 URL을 변경하고 싶을 때

**수정 파일:** `lib/constants/jira.ts`

```typescript
export const JIRA_ENDPOINTS = {
  IGNITE: 'https://your-jira-instance.atlassian.net',  // 소스 Jira
  HMG: 'https://your-other-jira.atlassian.net',        // 대상 Jira
};
```

### 3. 동기화 대상 프로젝트를 변경하고 싶을 때

동기화 대상은 **DB(설정 페이지)**에서 관리됩니다.
1. `/settings/teams` - 팀 생성
2. `/settings/projects` - 프로젝트 등록 (Jira 프로젝트 키, 보드 ID 등)
3. `/settings/field-mappings` - 동기화 프로필 생성 (소스→대상 필드 매핑)

코드 수정 없이 UI에서 설정 가능합니다.

### 4. 동기화 로직(필드 매핑/상태 전이)을 커스터마이즈하고 싶을 때

**수정 파일:** `lib/services/sync/` 디렉토리

| 파일 | 역할 | 수정 시점 |
|------|------|----------|
| `sync-orchestrator.ts` | 전체 동기화 흐름 | 동기화 순서/조건 변경 시 |
| `ignite-sync.service.ts` | 같은 Jira 내 프로젝트간 동기화 | 같은 Jira 내 동기화 로직 변경 시 |
| `hmg-sync.service.ts` | 다른 Jira 인스턴스로 동기화 | 크로스 인스턴스 동기화 변경 시 |
| `db-field-mapper.ts` | DB 매핑 규칙으로 필드 변환 | 필드 변환 방식 변경 시 |
| `transition-helper.ts` | 상태 전이 (BFS) | 워크플로우/상태 전이 변경 시 |
| `sprint-mapper.ts` | 스프린트 이름 매핑 | 스프린트 매핑 규칙 변경 시 |

### 5. Jira 인스턴스가 1개만 필요할 때

1. `lib/constants/jira.ts` - `JIRA_ENDPOINTS`에서 불필요한 인스턴스 제거
2. `app/api/jira/hmg/` - 2번째 프록시 라우트 삭제
3. `lib/services/jira/hmg.service.ts` - 2번째 서비스 삭제
4. `lib/services/sync/hmg-sync.service.ts` - 크로스 인스턴스 동기화 삭제

### 6. IP 접근 제한을 변경하고 싶을 때

**수정 파일:** `proxy.ts`

```typescript
const ALLOWED_CIDRS = [
  '10.0.0.0/8',        // 허용할 IP 대역으로 변경
];
```

제한을 해제하려면 `DISABLE_IP_RESTRICTION=true` 환경변수를 설정하거나 `proxy.ts`를 삭제합니다.

### 7. 배치 스케줄을 변경하고 싶을 때

**수정 파일:** `.github/workflows/daily-sync.yml`

```yaml
schedule:
  - cron: '0 23 * * 0-4'  # UTC 기준 - 원하는 시간으로 변경
```

### 8. 사용자 인증 방식을 변경하고 싶을 때

현재 사용자별 Jira API Key를 DB에 저장하고, API 호출 시 서버에서 조회합니다.

- **인증 조회:** `lib/jira-credentials.ts`
- **API 프록시:** `app/api/jira/ignite/[...path]/route.ts`, `app/api/jira/hmg/[...path]/route.ts`
- **클라이언트 헤더:** `lib/services/jira/client.ts` (`x-user-id` 헤더로 사용자 식별)

---

## DB 테이블 구조

> 전체 스키마: `db/supabase-init.sql` (이 파일 하나로 모든 테이블 생성)

### teams — 팀 정보

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | UUID (PK) | 팀 ID |
| `name` | TEXT | 팀 이름 (UNIQUE) |
| `source_project_id` | UUID (FK → projects) | 동기화 소스 프로젝트 |
| `created_at` | TIMESTAMPTZ | 생성일시 |
| `updated_at` | TIMESTAMPTZ | 수정일시 (자동 갱신) |

### users — 사용자

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | UUID (PK) | 사용자 ID |
| `name` | TEXT | 사용자 이름 |
| `team_id` | UUID (FK → teams) | 소속 팀 |
| `ignite_account_id` | TEXT | Ignite Jira accountId |
| `ignite_jira_email` | TEXT | Ignite Jira 인증 이메일 |
| `ignite_jira_api_token` | TEXT | Ignite Jira API 토큰 |
| `hmg_account_id` | TEXT | HMG Jira accountId |
| `hmg_jira_email` | TEXT | HMG Jira 인증 이메일 |
| `hmg_jira_api_token` | TEXT | HMG Jira API 토큰 |
| `hmg_user_id` | TEXT | HMG 사번 |
| `created_at` | TIMESTAMPTZ | 생성일시 |
| `updated_at` | TIMESTAMPTZ | 수정일시 (자동 갱신) |

### projects — Jira 프로젝트

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | UUID (PK) | 프로젝트 ID |
| `name` | TEXT | 프로젝트 이름 (예: FEHG, KQ) |
| `jira_project_id` | TEXT | Jira 프로젝트 ID (UNIQUE) |
| `jira_instance` | TEXT | Jira 인스턴스 (`'ignite'` / `'hmg'`) |
| `board_id` | INTEGER | Jira 애자일 보드 ID |
| `created_at` | TIMESTAMPTZ | 생성일시 |
| `updated_at` | TIMESTAMPTZ | 수정일시 (자동 갱신) |

### project_teams — 프로젝트-팀 연결 (N:N)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `project_id` | UUID (PK, FK → projects) | 프로젝트 ID |
| `team_id` | UUID (PK, FK → teams) | 팀 ID |

### team_target_projects — 팀별 동기화 대상 프로젝트

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `team_id` | UUID (PK, FK → teams) | 팀 ID |
| `project_id` | UUID (PK, FK → projects) | 대상 프로젝트 ID |
| `sync_profile_id` | UUID (FK → sync_profiles) | 적용할 동기화 프로필 |

### sync_profiles — 동기화 프로필

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `id` | UUID (PK) | 프로필 ID |
| `name` | TEXT | 프로필 이름 |
| `source_project_id` | UUID (FK → projects) | 소스 프로젝트 |
| `target_project_id` | UUID (FK → projects) | 대상 프로젝트 |
| `link_field` | TEXT | 이슈 링크용 커스텀 필드 (HMG 대상 시) |
| `created_at` | TIMESTAMPTZ | 생성일시 |
| `updated_at` | TIMESTAMPTZ | 수정일시 |

### sync_field_mappings — 필드 매핑 규칙

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `profile_id` | UUID (FK → sync_profiles) | 소속 프로필 |
| `source_field` | TEXT | 소스 필드 ID (예: `summary`, `customfield_10001`) |
| `source_field_name` | TEXT | 소스 필드 표시명 |
| `target_field` | TEXT | 대상 필드 ID |
| `target_field_name` | TEXT | 대상 필드 표시명 |
| `transform_type` | TEXT | 변환 타입 |
| `transform_config` | JSONB | 변환 설정 (JSON) |

### sync_profile_status_mappings — 상태 ID 매핑

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `profile_id` | UUID (FK → sync_profiles) | 소속 프로필 |
| `source_status_id` | TEXT | 소스 상태 ID |
| `source_status_name` | TEXT | 소스 상태명 (예: `진행 중`) |
| `target_status_id` | TEXT | 대상 상태 ID |
| `target_status_name` | TEXT | 대상 상태명 |

### sync_profile_workflows — 워크플로우 전이 규칙

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `profile_id` | UUID (FK → sync_profiles) | 소속 프로필 |
| `from_status_id` | TEXT | 출발 상태 ID |
| `from_status_name` | TEXT | 출발 상태명 |
| `to_status_id` | TEXT | 도착 상태 ID |
| `to_status_name` | TEXT | 도착 상태명 |
| `transition_id` | TEXT | Jira 전이 ID |

> BFS 최단경로 탐색에 사용됩니다. 현재 상태에서 목표 상태로 가기 위해 거쳐야 하는 전이 경로를 자동 계산합니다.

### sync_profile_allowed_epics — 동기화 허용 에픽 목록

| 컬럼 | 타입 | 설명 |
|------|------|------|
| `profile_id` | UUID (FK → sync_profiles) | 소속 프로필 |
| `epic_key` | TEXT | 에픽 이슈 키 (예: `FEHG-100`) |
| `epic_summary` | TEXT | 에픽 제목 |

> 이 목록이 비어있으면 모든 에픽이 동기화 대상입니다.

### 테이블 관계도

```
teams ─────────┐
  │ source_project_id    │
  ▼              │
projects ◄──── project_teams (N:N)
  ▲
  │
team_target_projects ──► sync_profiles
                           │
                ┌──────────┼──────────┬──────────┐
                ▼          ▼          ▼          ▼
          field_mappings  status_mappings  workflows  allowed_epics
```

---

## 기술 스택

- **프레임워크:** Next.js 16 (App Router)
- **UI:** shadcn/ui + Tailwind CSS
- **DB:** Supabase (교체 가능)
- **배포:** Vercel
- **배치:** GitHub Actions
- **언어:** TypeScript
