import { BaseJiraService } from './base.service';

/**
 * Ignite Jira Service
 * 이그나이트 Jira 전용 메서드를 제공합니다.
 */
export class IgniteJiraService extends BaseJiraService {
  constructor() {
    super('ignite');
  }

  /**
   * 소스 프로젝트 이슈 조회
   */
  async getSourceProjectIssues(projectKey: string = 'FEHG') {
    return this.getProjectIssues(projectKey);
  }

  /**
   * 소스 프로젝트의 완료되지 않은 에픽 조회
   */
  async getIncompleteEpicsByProject(projectKey: string = 'FEHG') {
    const jql = `project = ${projectKey} AND issuetype = 에픽 AND status != Done AND status != 완료 ORDER BY created DESC`;
    return this.searchIssues(jql);
  }

  /**
   * @deprecated getFEHGIncompleteEpics → getIncompleteEpicsByProject 사용
   */
  async getFEHGIncompleteEpics(projectKey: string = 'FEHG') {
    return this.getIncompleteEpicsByProject(projectKey);
  }

  /**
   * 특정 프로젝트를 제외한 모든 프로젝트 조회
   */
  async getProjectsExcluding(excludeKey: string = 'FEHG') {
    const result = await this.getProjects();
    if (result.success && result.data) {
      return {
        success: true,
        data: result.data.filter((project) => project.key !== excludeKey),
      };
    }
    return result;
  }

  /**
   * @deprecated getNonFEHGProjects → getProjectsExcluding 사용
   */
  async getNonFEHGProjects() {
    return this.getProjectsExcluding('FEHG');
  }

  /**
   * 특정 프로젝트의 완료되지 않은 이슈 조회
   */
  async getProjectIncompleteIssues(projectKey: string) {
    return this.getIncompleteIssues(projectKey);
  }

  /**
   * 이슈 필드 업데이트
   */
  async updateIssueFields(issueKey: string, fields: Record<string, unknown>) {
    return this.client.put(`issue/${issueKey}`, { fields });
  }

  // 추가적인 이그나이트 전용 메서드들을 여기에 정의할 수 있습니다.
}
