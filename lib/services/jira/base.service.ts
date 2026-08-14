import { JiraClient } from './client';
import {
  JiraProject,
  JiraIssue,
  JiraIssueCreatePayload,
  JiraIssueCreateResponse,
  JiraSearchResult,
  JiraServerInfo,
} from '@/lib/types/jira';
import { JIRA_ROUTES, JIRA_CONFIG, JQL } from '@/lib/constants/jira';

/**
 * Jira Base Service
 * 모든 Jira 인스턴스에서 공통으로 사용하는 메서드를 제공합니다.
 */
export class BaseJiraService {
  protected client: JiraClient;

  constructor(instance: 'ignite' | 'hmg') {
    this.client = new JiraClient(instance);
  }

  /**
   * 서버 정보 조회
   */
  async getServerInfo() {
    return this.client.get<JiraServerInfo>(JIRA_ROUTES.SERVER_INFO);
  }

  /**
   * 프로젝트 목록 조회
   */
  async getProjects() {
    return this.client.get<JiraProject[]>(JIRA_ROUTES.PROJECTS);
  }

  /**
   * 특정 프로젝트 조회
   */
  async getProject(projectKey: string) {
    return this.client.get<JiraProject>(JIRA_ROUTES.PROJECT_BY_KEY(projectKey));
  }

  /**
   * 이슈 조회
   */
  async getIssue(issueKey: string) {
    return this.client.get<JiraIssue>(JIRA_ROUTES.ISSUE(issueKey), {
      fields: JIRA_CONFIG.DEFAULT_FIELDS.join(','),
    });
  }

  /**
   * JQL을 사용한 이슈 검색
   */
  async searchIssues(jql: string, maxResults?: number) {
    return this.client.get<JiraSearchResult>(JIRA_ROUTES.ISSUE_SEARCH, {
      jql,
      maxResults: maxResults || JIRA_CONFIG.MAX_RESULTS,
      fields: JIRA_CONFIG.DEFAULT_FIELDS.join(','),
    });
  }

  /**
   * 프로젝트에서 사용 가능한 모든 필드 조회
   */
  async getFields() {
    return this.client.get<{ id: string; name: string; custom: boolean; schema?: { type: string } }[]>(JIRA_ROUTES.FIELDS);
  }

  /**
   * JQL을 사용한 모든 이슈 검색 (페이지네이션 자동 처리)
   */
  async searchAllIssues(
    jql: string,
    extraFields?: string[]
  ): Promise<{
    success: boolean;
    data?: { issues: JiraIssue[]; total: number };
    error?: string;
  }> {
    try {
      const allIssues: JiraIssue[] = [];
      const maxResults = 100;
      let nextPageToken: string | undefined = undefined;
      let pageCount = 0;

      // DB 매핑에 지정된 필드가 DEFAULT_FIELDS 에 없으면 Jira 가 값을 안 돌려준다.
      // (그러면 양쪽 다 undefined 라 "동일" 로 잘못 판정된다)
      const fields = Array.from(
        new Set([...JIRA_CONFIG.DEFAULT_FIELDS, ...(extraFields ?? [])])
      ).join(',');

      // 필드 목록 출력 (디버깅용)
      const fieldsResult = await this.getFields();
      if (fieldsResult.success && fieldsResult.data) {
        console.log('[searchAllIssues] 사용 가능한 필드 목록:');
        fieldsResult.data.forEach((f) => {
          console.log(`  [${f.id}] ${f.name}${f.custom ? ' (custom)' : ''}${f.schema ? ` - type: ${f.schema.type}` : ''}`);
        });
      }

      // 첫 번째 요청
      const firstResult = await this.client.get<JiraSearchResult>(
        JIRA_ROUTES.ISSUE_SEARCH,
        {
          jql,
          maxResults: String(maxResults),
          fields,
        }
      );

      if (!firstResult.success || !firstResult.data) {
        return {
          success: false,
          error: firstResult.error || '이슈 검색 실패',
        };
      }

      allIssues.push(...firstResult.data.issues);
      nextPageToken = firstResult.data.nextPageToken;
      let isLast = firstResult.data.isLast ?? true;
      pageCount++;

      // 첫 페이지 조회 완료

      // 나머지 페이지 요청 (isLast가 false이고 nextPageToken이 있는 동안)
      while (!isLast && nextPageToken) {
        const result = await this.client.get<JiraSearchResult>(
          JIRA_ROUTES.ISSUE_SEARCH,
          {
            jql,
            maxResults: String(maxResults),
            fields,
            nextPageToken,
          }
        );

        if (!result.success || !result.data) {
          console.warn(`페이지 ${pageCount + 1} 조회 실패:`, result.error);
          break;
        }

        allIssues.push(...result.data.issues);
        nextPageToken = result.data.nextPageToken;
        isLast = result.data.isLast ?? true;
        pageCount++;
      }

      return {
        success: true,
        data: {
          issues: allIssues,
          total: allIssues.length, // 새 방식에서는 total을 직접 계산
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : '알 수 없는 오류',
      };
    }
  }

  /**
   * 프로젝트의 모든 이슈 조회
   */
  async getProjectIssues(projectKey: string) {
    const jql = JQL.project(projectKey);
    return this.searchIssues(jql);
  }

  /**
   * 특정 사용자에게 할당된 이슈 조회
   */
  async getAssignedIssues(email: string) {
    const jql = JQL.assignee(email);
    return this.searchIssues(jql);
  }

  /**
   * 완료되지 않은 이슈 조회
   */
  async getIncompleteIssues(projectKey?: string) {
    const conditions = [JQL.statusNot('완료'), JQL.statusNot('Done')];
    if (projectKey) {
      conditions.push(JQL.project(projectKey));
    }
    const jql = JQL.and(...conditions);
    return this.searchIssues(jql);
  }

  /**
   * 이슈 상태 변경
   */
  async updateIssueStatus(issueKey: string, transitionId: string) {
    return this.client.post(JIRA_ROUTES.ISSUE_TRANSITIONS(issueKey), {
      transition: {
        id: transitionId,
      },
    });
  }

  /**
   * 이슈의 사용 가능한 전환(상태 변경) 목록 조회
   */
  async getIssueTransitions(issueKey: string) {
    return this.client.get(JIRA_ROUTES.ISSUE_TRANSITIONS(issueKey));
  }

  /**
   * 현재 로그인한 사용자 정보 조회
   */
  async getMyself() {
    return this.client.get(JIRA_ROUTES.MYSELF);
  }

  /**
   * 이슈 생성
   * 양방향 동기화에서 소스/대상 어느 쪽에도 생성할 수 있어야 해서 base 로 올렸다.
   */
  async createIssue(payload: JiraIssueCreatePayload) {
    return this.client.post<JiraIssueCreateResponse>('issue', payload);
  }

  /**
   * 이슈 필드 업데이트
   */
  async updateIssueFields(issueKey: string, fields: Record<string, unknown>) {
    return this.client.put(`issue/${issueKey}`, { fields });
  }

  /**
   * 이슈 링크 생성 (같은 사이트 연결용)
   *
   * 연결 규칙(결정 1)은 `Blocks` 이며, 소스가 대상을 blocks 하는 방향이다.
   * → inwardIssue = 소스, outwardIssue = 대상
   *   (소스에서는 outwardIssue, 대상에서는 inwardIssue 로 보인다 - 2단계에서 실측 확인)
   */
  async createIssueLink(params: {
    typeName: string;
    inwardIssueKey: string;
    outwardIssueKey: string;
  }) {
    return this.client.post('issueLink', {
      type: { name: params.typeName },
      inwardIssue: { key: params.inwardIssueKey },
      outwardIssue: { key: params.outwardIssueKey },
    });
  }
}
