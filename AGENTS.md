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
- 스크립트 실행 관례는 `npx tsx scripts/<name>.ts` (`scripts/` 각 파일 상단 주석 참고).

## 구조에서 놓치기 쉬운 것

- **동기화는 서버가 아니라 브라우저에서 돈다.** `app/page.tsx` 가 `SyncOrchestrator` 를 직접 생성하고,
  Jira 호출은 `lib/services/jira/client.ts` 가 `/api/jira/{ignite|hmg}/...` 프록시 라우트로 중계한다.
  동기화용 API 라우트나 서버 액션은 없다.
- **프로젝트 키를 하드코딩하지 말 것.** 소스/대상 프로젝트, 필드 매핑, 상태 매핑, 링크 필드는 전부 DB 정본이다
  (`sync_profiles`, `sync_field_mappings`, `sync_profile_status_mappings`, `sync_profile_workflows`).
  `lib/constants/jira.ts` 의 `FEHG`/`AUTOWAY` 상수와 `STATUS_MAPPING` 은 레거시 폴백이다.
- **필드 id 는 프로젝트마다 다르다.** 예: 스프린트가 BEDEV1 에서는 `customfield_10020` 이지만 KQ 에서는 그 필드가 `null` 이다.
  대상 쪽 필드는 반드시 `sync_field_mappings.target_field` 를 거쳐 읽고 쓸 것.
- **이름이 같은 필드가 수십 개다.** HMG 사이트 필드는 1072개고 "시작 날짜/Start date/Start Dateㅤㅤ" 처럼
  (뒤에 공백이 붙은) 똑같아 보이는 이름이 흔하다. 엉뚱한 쪽에 매핑하면 **쓰기는 성공하고 화면만 비어 있어서**
  "반영했다는데 안 된다" 가 된다. 근거는 두 가지뿐이다: `issue/{key}/editmeta`(그 화면에 실제로 있는 필드)와
  `issue/{key}?expand=names`(그 티켓이 들고 있는 값). 판정은 `lib/services/jira/field-probe.ts`,
  설정 화면의 "값 확인" 버튼과 `scripts/check-field-write.ts` 가 이걸 쓴다.
  증상이 의심되면 대상 티켓 **변경 이력(changelog)** 을 먼저 볼 것 - 어느 필드에 들어갔는지 바로 나온다.
- **티켓 연결 규칙 (연결 테이블 없음)**
  - 같은 Atlassian 사이트: `Blocks` 이슈 링크. 같은 링크가 **소스에서는 `outwardIssue`, 대상에서는 `inwardIssue`** 로
    양쪽에 보이므로 역방향 조회에 추가 API 호출이 필요 없다.
  - 다른 사이트(HMG): 소스 티켓의 `link_field`(기본 `customfield_10438`)에 담긴 URL. **HMG 쪽에는 역참조가 없다.**
  - 판정 로직은 `lib/services/sync/link-resolver.ts` 에 순수 함수로 모여 있다.
- **하위 작업은 스프린트 JQL 로 안 잡힌다.** 화면에는 부모의 스프린트가 보이지만 검색 색인에는 없다
  (실측 2026-11: `key = BEDEV1-983 AND sprint = 3717` → 0건). 그래서 비교 조회는 스프린트 질의 뒤에
  `parent IN (...)` 로 하위 작업을 한 번 더 가져온다. 또 하위 작업에는 프로젝트 라벨을 안 다는 것이 보통이라
  라벨 판정도 **부모의 라벨**을 따른다. 둘 다 `bidirectional-orchestrator.ts` 에 있다.
- 스프린트 이름은 `<접두사> YYYYMM` (예: `BEDEV1 202608`, `AUTOWAY` → `GW 202608`).
  접두사 예외는 `lib/services/sync/sprint-mapper.ts` 의 `SPRINT_PREFIX_MAP`.

## 커밋

- 커밋 메시지는 **자유 형식 한국어 제목**. Conventional Commits 를 쓰지 말 것.
  예: `토큰 만료 시 팝업 알림 추가`, `스크린샷 인라인/비이미지 첨부 동기화 오류 수정`

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
