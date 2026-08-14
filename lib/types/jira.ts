// Jira API 공통 타입 정의

// 프로젝트 정보 타입
export interface ProjectInfo {
  key: string;
  id: string;
  name: string;
  description: string;
}

// 사용자 정보 타입
export interface JiraUserInfo {
  name: string;
  igniteAccountId: string; // Ignite Jira에서 사용하는 accountId
  hmgAccountId: string; // HMG Jira에서 사용하는 accountId
  hmgUserId: string; // HMG Jira에서 사용하는 사번 형태 ID
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  emailAddress: string;
  avatarUrls: {
    '48x48': string;
    '24x24': string;
    '16x16': string;
    '32x32': string;
  };
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
  projectTypeKey: string;
  avatarUrls: {
    '48x48': string;
    '24x24': string;
    '16x16': string;
    '32x32': string;
  };
  lead?: JiraUser;
}

export interface JiraIssueType {
  id: string;
  name: string;
  description: string;
  iconUrl: string;
  subtask: boolean;
}

export interface JiraStatus {
  id: string;
  name: string;
  statusCategory: {
    id: number;
    key: string;
    name: string;
    colorName: string;
  };
}

export interface JiraPriority {
  id: string;
  name: string;
  iconUrl: string;
}

// Jira 첨부파일 타입
export interface JiraAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  content: string; // 다운로드 URL
  created?: string;
  author?: JiraUser;
}

// Jira Description 타입 (ADF - Atlassian Document Format)
export interface JiraDescription {
  type: string;
  version: number;
  content?: Array<{
    type: string;
    content?: unknown[];
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface JiraIssueFields {
  summary: string;
  description?: JiraDescription | string | null;
  issuetype: JiraIssueType;
  project: JiraProject;
  status: JiraStatus;
  priority?: JiraPriority;
  assignee?: JiraUser;
  reporter?: JiraUser;
  created: string;
  updated: string;
  duedate?: string | null; // 종료일
  parent?: {
    id: string;
    key: string;
    fields: {
      summary: string;
    };
  };
  subtasks?: JiraIssue[];
  issuelinks?: JiraIssueLink[];
  labels?: string[];
  attachment?: JiraAttachment[];
  fixVersions?: Array<{ id: string; name: string; archived?: boolean; released?: boolean }>;
  timetracking?: {
    originalEstimate?: string;
    remainingEstimate?: string;
    timeSpent?: string;
  };
  // 커스텀 필드는 동적이므로 인덱스 시그니처 추가
  [key: string]: unknown;
}

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: JiraIssueFields;
}

export interface JiraIssueLink {
  id: string;
  type: {
    id: string;
    name: string;
    inward: string;
    outward: string;
  };
  inwardIssue?: JiraIssue;
  outwardIssue?: JiraIssue;
}

export interface JiraSprint {
  id: number;
  name: string;
  state: 'future' | 'active' | 'closed';
  startDate?: string;
  endDate?: string;
  completeDate?: string;
  originBoardId: number;
}

export interface JiraSearchResult {
  expand?: string;
  startAt?: number;
  maxResults?: number;
  total?: number;
  issues: JiraIssue[];
  // 새로운 페이지네이션 방식 (Jira Cloud)
  nextPageToken?: string;
  isLast?: boolean;
}

export interface JiraServerInfo {
  baseUrl: string;
  version: string;
  versionNumbers: number[];
  deploymentType: string;
  buildNumber: number;
  buildDate: string;
  serverTime: string;
  scmInfo: string;
  serverTitle: string;
}

// API 응답 타입
export interface JiraApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  details?: unknown;
}

// 요청 옵션
export interface JiraRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  params?: Record<string, string | number>;
}

// 이슈 생성/업데이트 payload
export interface JiraIssueCreatePayload {
  fields: {
    project: { key: string } | { id: string };
    summary: string;
    description?: JiraDescription | string;
    issuetype: { id: string } | { name: string };
    priority?: { id: string } | { name: string };
    assignee?: { accountId: string };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface JiraIssueCreateResponse {
  id: string;
  key: string;
  self: string;
}

export interface JiraIssueUpdatePayload {
  fields?: Partial<JiraIssueFields>;
  transition?: {
    id: string;
  };
  [key: string]: unknown;
}
