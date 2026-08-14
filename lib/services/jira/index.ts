// Jira Services 통합 Export

import { IgniteJiraService } from './ignite.service';
import { HMGJiraService } from './hmg.service';

export { JiraClient } from './client';
export { BaseJiraService } from './base.service';
export { IgniteJiraService } from './ignite.service';
export { HMGJiraService } from './hmg.service';

// 간편하게 사용할 수 있는 기본 인스턴스
export const jira = {
  ignite: new IgniteJiraService(),
  hmg: new HMGJiraService(),
};
