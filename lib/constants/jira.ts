// Jira 엔드포인트 및 상수

export const JIRA_ENDPOINTS = {
  IGNITE: 'https://ignitecorp.atlassian.net',
  HMG: 'https://hmg.atlassian.net',
  HMG_OLD: 'https://jira.hmg-corp.io', // 구 URL (deprecated)
} as const;

export const JIRA_API_VERSION = '/rest/api/3';

// 프로젝트 정보
export const JIRA_PROJECTS = {
  // Ignite Jira 프로젝트
  IGNITE: {
    FEHG: {
      key: 'FEHG',
      id: '10247',
      name: '[FE1] 프로젝트 통합 JIRA',
      description: '기준 프로젝트 - 개발자들이 직접 관리',
    },
    HB: {
      key: 'HB',
      id: '10411',
      name: 'HMG Board',
      description: 'FEHG 기준으로 자동 업데이트',
    },
    HDD: {
      key: 'HDD',
      id: '10135',
      name: '현대디벨로퍼',
      description: 'FEHG 기준으로 자동 업데이트',
    },
    KQ: {
      key: 'KQ',
      id: '10109',
      name: 'kiacpo_qa',
      description: 'FEHG 기준으로 자동 업데이트',
    },
  },
  // HMG Jira 프로젝트
  HMG: {
    AUTOWAY: {
      key: 'AUTOWAY',
      id: '10363',
      name: '[프로젝트] 차세대 그룹웨어 포털 구축',
      description: 'FEHG 기준으로 자동 업데이트',
    },
    ICTQMSCHE: {
      key: 'ICTQMSCHE',
      id: '10464',
      name: 'ICT 3자 통합(서비스QA)테스트/성능테스트',
      description: '읽기 전용 - 자동 업데이트 안 함',
    },
  },
} as const;

// 자동화 대상 프로젝트 (FEHG 제외)
export const AUTO_SYNC_PROJECTS = {
  IGNITE: ['HB', 'HDD', 'KQ'] as const,
  HMG: ['AUTOWAY'] as const,
} as const;

// 읽기 전용 프로젝트
export const READ_ONLY_PROJECTS = {
  HMG: ['ICTQMSCHE'] as const,
} as const;

export const JIRA_ROUTES = {
  // 서버 정보
  SERVER_INFO: '/serverInfo',

  // 프로젝트 관련
  PROJECTS: '/project',
  PROJECT_BY_KEY: (key: string) => `/project/${key}`,

  // 이슈 관련
  ISSUE: (issueIdOrKey: string) => `/issue/${issueIdOrKey}`,
  ISSUE_SEARCH: '/search/jql', // Jira Cloud API v3 업데이트
  ISSUE_TRANSITIONS: (issueIdOrKey: string) =>
    `/issue/${issueIdOrKey}/transitions`,

  // 첨부파일 관련
  ISSUE_ATTACHMENTS: (issueIdOrKey: string) =>
    `/issue/${issueIdOrKey}/attachments`,
  ATTACHMENT_CONTENT: (attachmentId: string) =>
    `/attachment/content/${attachmentId}`,

  // 필드 관련
  FIELDS: '/field',

  // 사용자 관련
  MYSELF: '/myself',
  USER_SEARCH: '/user/search',

  // 스프린트 관련 (Jira Software API)
  SPRINT: (sprintId: number) => `/sprint/${sprintId}`,
  BOARD_SPRINTS: (boardId: number) => `/board/${boardId}/sprint`,
} as const;

// JQL 쿼리 빌더 헬퍼
export const JQL = {
  project: (key: string) => `project = ${key}`,
  assignee: (email: string) => `assignee = "${email}"`,
  status: (status: string) => `status = "${status}"`,
  statusNot: (status: string) => `status != "${status}"`,
  and: (...conditions: string[]) => conditions.join(' AND '),
  or: (...conditions: string[]) => conditions.join(' OR '),
  orderBy: (field: string, order: 'ASC' | 'DESC' = 'DESC') =>
    `ORDER BY ${field} ${order}`,
} as const;

// 기본 설정
export const JIRA_CONFIG = {
  MAX_RESULTS: 100,
  DEFAULT_FIELDS: [
    'summary',
    'description',
    'status',
    'assignee',
    'reporter',
    'priority',
    'created',
    'updated',
    'issuetype',
    'project',
    'parent',
    'subtasks',
    'issuelinks',
    'duedate',
    'timetracking',
    'customfield_10015', // 시작일
    'customfield_10020', // 스프린트
    'customfield_10438', // HMG Jira 링크
    'labels',
    'fixVersions',
    'attachment',
  ],
} as const;

// 사용자 정보는 DB(`users` 테이블)가 정본이다.
// 서버에서는 `lib/services/user-lookup.ts`, 브라우저에서는 `/api/users` 를 사용할 것.

// 동기화 필드 설정
export const SYNC_FIELDS = {
  FEHG_TO_KQ: [
    'summary',
    'duedate',
    'customfield_10015', // 시작일
    'assignee',
    'timetracking',
    'customfield_10020', // 스프린트
  ] as const,
  FEHG_TO_HDD: [
    'summary',
    'duedate',
    'customfield_10015', // 시작일
    'assignee',
    'timetracking',
    'customfield_10020', // 스프린트
  ] as const,
  FEHG_TO_HB: [
    'summary',
    'duedate',
    'customfield_10015', // 시작일
    'assignee',
    'timetracking',
    'customfield_10020', // 스프린트
  ] as const,
  FEHG_TO_AUTOWAY: [
    'summary',
    'duedate',
    'customfield_10015', // 시작일
    'assignee',
    'timetracking',
    'customfield_10020', // 스프린트
  ] as const,
} as const;

// 상태 매핑 (FEHG status ID → 대상 프로젝트 transition ID)
// @deprecated - STATUS_TARGET_MAPPING + STATUS_WORKFLOW 조합으로 대체
export const STATUS_MAPPING = {
  // FEHG → HB/KQ/HDD (이그나이트 프로젝트)
  IGNITE: {
    '10373': '161', // 해야 할 일 → ToDo
    '10374': '171', // 진행 중 → In Progress
    '10375': '181', // 완료 → 완료
  },
  // FEHG → AUTOWAY (HMG 프로젝트 전용)
  HMG: {
    '10373': '41', // 해야 할 일 → 해야 할 일
    '10374': '11', // 진행 중 → 진행 중
    '10375': '31', // 완료 → 완료
  },
} as const;

/**
 * FEHG 상태 ID → 타겟 인스턴스 상태 ID 매핑
 * FEHG 상태가 어떤 타겟 상태와 동일한지 정의
 */
export const STATUS_TARGET_MAPPING: Record<
  'IGNITE' | 'HMG',
  Record<string, string>
> = {
  // FEHG status ID → Ignite 타겟 프로젝트(KQ/HB/HDD) status ID
  IGNITE: {
    '10373': '1', // 해야 할 일 → TO_DO
    '10374': '3', // 진행 중 → 진행 중
    '10375': '6', // 완료 → 완료
  },
  // FEHG status ID → HMG(AUTOWAY) status ID
  HMG: {
    '10373': '1', // 해야 할 일 → 미해결
    '10374': '3', // 진행 중 → 진행 중
    '10375': '6', // 완료 → 종료
  },
};

/**
 * 워크플로우 그래프: 각 상태에서 전이 가능한 다음 상태와 transition ID
 * 형식: { [현재상태ID]: { [다음상태ID]: transitionID } }
 *
 * BFS 경로 탐색에 사용됨
 */
export const STATUS_WORKFLOW: Record<
  'IGNITE' | 'HMG',
  Record<string, Record<string, string>>
> = {
  // Ignite 프로젝트 워크플로우 (KQ/HB/HDD)
  // 모든 상태에서 모든 상태로 직접 전이 가능 (매우 유연함)
  IGNITE: {
    '1': {
      // TO_DO에서 갈 수 있는 상태
      '3': '171', // → 진행 중 (In Progress)
      '6': '181', // → 완료
    },
    '3': {
      // 진행 중에서 갈 수 있는 상태
      '1': '161', // → TO_DO
      '6': '181', // → 완료
    },
    '6': {
      // 완료에서 갈 수 있는 상태
      '1': '161', // → TO_DO
      '3': '171', // → 진행 중 (In Progress)
    },
  },
  // HMG 프로젝트 워크플로우 (AUTOWAY)
  HMG: {
    '1': {
      // 미해결에서 갈 수 있는 상태
      '3': '11', // → 진행 중 (작업 시작)
      '6': '31', // → 종료 (티켓 종료 처리)
    },
    '3': {
      // 진행 중에서 갈 수 있는 상태
      '1': '41', // → 미해결 (Open)
      '6': '21', // → 종료 (작업 종료)
    },
    '6': {
      // 종료에서 갈 수 있는 상태
      '1': '41', // → 미해결 (Open, reopening)
    },
  },
};

// Ignite Jira 커스텀 필드
export const IGNITE_CUSTOM_FIELDS = {
  START_DATE: 'customfield_10015', // 시작일
  SPRINT: 'customfield_10020', // 스프린트
  HMG_JIRA_LINK: 'customfield_10438', // HMG Jira 티켓 URL (FEHG 전용)
} as const;

// HMG Jira 커스텀 필드 (AUTOWAY 프로젝트)
export const HMG_CUSTOM_FIELDS = {
  START_DATE: 'customfield_10187', // Start Date
  START_DATE_ALT: 'customfield_10753', // Start Date (duplicate)
  START_DATE_590: 'customfield_10590', // Start Date (세 번째 중복 필드)
  GANTT_START_DATE: 'customfield_10995', // Gantt Start Date
  GANTT_END_DATE: 'customfield_10996', // Gantt End Date
} as const;

/**
 * 프로젝트별 티켓 생성 시 사용할 이슈 타입 이름
 *
 * 프로젝트마다 쓰는 이슈 타입 체계가 달라서, 소스의 타입 이름을 그대로 옮기면 맞지 않는다.
 * (예: BEDEV1 은 "작업" 이지만 KQ 에서 대응되는 것은 "개발처리" 다)
 *
 * 여기에 없는 프로젝트는 CREATE_ISSUE_TYPE_PREFERENCE 순서로 고른다.
 * 스프린트 이름 접두사를 SPRINT_PREFIX_MAP 에 두는 것과 같은 방식이다.
 */
export const CREATE_ISSUE_TYPE_MAP: Record<string, string> = {
  KQ: '개발처리',
};

/**
 * 이슈 타입 선호 순서 (앞에 있을수록 우선)
 *
 * 기본: 작업 → 없으면 개발처리 → 없으면 Dev Task
 *
 * 주의 1: Jira /project/{key} 의 issueTypes 배열 순서는 프로젝트마다 다르다.
 * 반드시 이 배열 순서로 탐색해야 한다 - 프로젝트 응답 순서로 훑으면
 * KQ 처럼 "버그" 가 맨 앞인 프로젝트에서 버그 티켓이 생성된다.
 *
 * 주의 2: 버그/스토리 계열은 일부러 넣지 않았다.
 * 셋 중 하나도 없으면 임의로 고르지 않고 실패시킨다 - 엉뚱한 타입으로 티켓이
 * 만들어지는 것보다 낫다. 그런 프로젝트는 CREATE_ISSUE_TYPE_MAP 에 지정할 것.
 */
export const CREATE_ISSUE_TYPE_PREFERENCE = [
  '작업',
  '개발처리',
  'Dev Task',
] as const;

// 보드 ID (스프린트 조회용)
export const BOARD_IDS = {
  FEHG: 251,
  KQ: 20,
  HB: 350,
  HDD: 37,
  AUTOWAY: 521,
} as const;

// 헬퍼 함수
export const JiraProjectHelpers = {
  /**
   * 프로젝트 키로 프로젝트 정보 조회
   */
  getProjectInfo: (projectKey: string) => {
    // Ignite 프로젝트 검색
    const igniteProject = Object.values(JIRA_PROJECTS.IGNITE).find(
      (p) => p.key === projectKey
    );
    if (igniteProject) return { ...igniteProject, instance: 'ignite' as const };

    // HMG 프로젝트 검색
    const hmgProject = Object.values(JIRA_PROJECTS.HMG).find(
      (p) => p.key === projectKey
    );
    if (hmgProject) return { ...hmgProject, instance: 'hmg' as const };

    return null;
  },

  /**
   * 자동 동기화 대상 프로젝트인지 확인
   */
  isAutoSyncProject: (projectKey: string) => {
    return (
      AUTO_SYNC_PROJECTS.IGNITE.includes(projectKey as never) ||
      AUTO_SYNC_PROJECTS.HMG.includes(projectKey as never)
    );
  },

  /**
   * 읽기 전용 프로젝트인지 확인
   */
  isReadOnlyProject: (projectKey: string) => {
    return READ_ONLY_PROJECTS.HMG.includes(projectKey as never);
  },

  /**
   * 모든 자동 동기화 대상 프로젝트 목록 가져오기
   */
  getAllAutoSyncProjects: () => {
    return [
      ...AUTO_SYNC_PROJECTS.IGNITE.map((key) => JIRA_PROJECTS.IGNITE[key]),
      ...AUTO_SYNC_PROJECTS.HMG.map((key) => JIRA_PROJECTS.HMG[key]),
    ];
  },
} as const;
