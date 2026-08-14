import { BaseJiraService } from './base.service';
import {
  JiraIssueCreatePayload,
  JiraIssueCreateResponse,
  JiraIssueUpdatePayload,
} from '@/lib/types/jira';

/**
 * HMG Jira Service
 * HMG Jira 전용 메서드를 제공합니다.
 * VPN 환경에서만 동작합니다.
 */
export class HMGJiraService extends BaseJiraService {
  constructor() {
    super('hmg');
  }

  /**
   * HMG 프로젝트의 모든 이슈 조회
   */
  async getAllIssues() {
    const projects = await this.getProjects();
    if (!projects.success || !projects.data) {
      return projects;
    }

    // 모든 프로젝트의 이슈를 조회할 수 있습니다
    // 필요에 따라 구현
    return projects;
  }

  /**
   * HMG Jira에 이슈 생성
   */
  async createIssue(payload: JiraIssueCreatePayload) {
    return this.client.post<JiraIssueCreateResponse>('issue', payload);
  }

  /**
   * HMG Jira 이슈 업데이트
   */
  async updateIssue(issueKey: string, payload: JiraIssueUpdatePayload) {
    return this.client.put(`issue/${issueKey}`, payload);
  }

  /**
   * HMG Jira 이슈 상태 변경 (transition)
   */
  async updateIssueStatus(issueKey: string, transitionId: string) {
    return this.client.post(`issue/${issueKey}/transitions`, {
      transition: { id: transitionId },
    });
  }

  // 추가적인 HMG 전용 메서드들을 여기에 정의할 수 있습니다.
}
