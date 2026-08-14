# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## 빌드 / 검증

- **`npm run build` 는 env 없이 실패한다.** `lib/db.ts` 가 모듈 로드 시점에 `createClient()` 를 호출해서,
  `.env.local` 이 없으면 `Error: supabaseUrl is required.` 로 page-data 수집 단계에서 죽는다.
  TypeScript 컴파일은 그보다 먼저 통과하므로 이 실패는 코드 오류가 아니다.
  자격증명 없이 빌드만 확인하려면 더미 값을 준다:
  `NEXT_PUBLIC_DB_URL=https://placeholder.supabase.co NEXT_PUBLIC_DB_ANON_KEY=x npm run build`
- 필요한 환경변수 목록은 `.env.example` 참고. **README 는 다른 저장소(FE 팀 원본) 기준이라 근거로 쓰지 말 것.**
- 타입체크는 `./node_modules/.bin/tsc --noEmit` (`npx tsc` 는 엉뚱한 패키지를 받는다).
- 스크립트 실행 관례는 `npx tsx scripts/<name>.ts` (`.github/workflows/daily-sync.yml` 참고).

## 구조에서 놓치기 쉬운 것

- **동기화는 서버가 아니라 브라우저에서 돈다.** `app/page.tsx` 가 `SyncOrchestrator` 를 직접 생성하고,
  Jira 호출은 `lib/services/jira/client.ts` 가 `/api/jira/{ignite|hmg}/...` 프록시 라우트로 중계한다.
  동기화용 API 라우트나 서버 액션은 없다.
- **프로젝트 키를 하드코딩하지 말 것.** 소스/대상 프로젝트, 필드 매핑, 상태 매핑, 링크 필드는 전부 DB 정본이다
  (`sync_profiles`, `sync_field_mappings`, `sync_profile_status_mappings`, `sync_profile_workflows`).
  `lib/constants/jira.ts` 의 `FEHG`/`AUTOWAY` 상수와 `STATUS_MAPPING` 은 레거시 폴백이다.
- **필드 id 는 프로젝트마다 다르다.** 예: 스프린트가 BEDEV1 에서는 `customfield_10020` 이지만 KQ 에서는 그 필드가 `null` 이다.
  대상 쪽 필드는 반드시 `sync_field_mappings.target_field` 를 거쳐 읽고 쓸 것.
- **티켓 연결 규칙 (연결 테이블 없음)**
  - 같은 Atlassian 사이트: `Blocks` 이슈 링크. 같은 링크가 **소스에서는 `outwardIssue`, 대상에서는 `inwardIssue`** 로
    양쪽에 보이므로 역방향 조회에 추가 API 호출이 필요 없다.
  - 다른 사이트(HMG): 소스 티켓의 `link_field`(기본 `customfield_10438`)에 담긴 URL. **HMG 쪽에는 역참조가 없다.**
  - 판정 로직은 `lib/services/sync/link-resolver.ts` 에 순수 함수로 모여 있다.
- 스프린트 이름은 `<접두사> YYYYMM` (예: `BEDEV1 202608`, `AUTOWAY` → `GW 202608`).
  접두사 예외는 `lib/services/sync/sprint-mapper.ts` 의 `SPRINT_PREFIX_MAP`.
- `.github/workflows/daily-sync.yml` 은 현재 사용하지 않는다.

## 커밋

- 커밋 메시지는 **자유 형식 한국어 제목**. Conventional Commits 를 쓰지 말 것.
  예: `토큰 만료 시 팝업 알림 추가`, `스크린샷 인라인/비이미지 첨부 동기화 오류 수정`

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
