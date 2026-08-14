-- =============================================
-- Jira 통합 관리 도구 - DB 초기 스키마
-- Supabase SQL Editor에서 실행하세요
-- =============================================

-- 1. 프로젝트 테이블
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  jira_project_id TEXT NOT NULL UNIQUE,
  jira_instance TEXT NOT NULL DEFAULT 'ignite' CHECK (jira_instance IN ('ignite', 'hmg')),
  board_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. 팀 테이블
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  source_project_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE teams
  ADD CONSTRAINT fk_teams_source_project
  FOREIGN KEY (source_project_id) REFERENCES projects(id) ON DELETE SET NULL;

-- 3. 사용자 테이블
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
  ignite_account_id TEXT NOT NULL DEFAULT '',
  ignite_jira_email TEXT NOT NULL DEFAULT '',
  ignite_jira_api_token TEXT NOT NULL DEFAULT '',
  hmg_account_id TEXT NOT NULL DEFAULT '',
  hmg_jira_email TEXT NOT NULL DEFAULT '',
  hmg_jira_api_token TEXT NOT NULL DEFAULT '',
  hmg_user_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. 프로젝트-팀 연결 (N:N)
CREATE TABLE project_teams (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (project_id, team_id)
);

-- 5. 동기화 프로필
CREATE TABLE sync_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  source_project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  target_project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  link_field TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6. 팀별 동기화 대상 프로젝트
CREATE TABLE team_target_projects (
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sync_profile_id UUID REFERENCES sync_profiles(id) ON DELETE SET NULL,
  PRIMARY KEY (team_id, project_id)
);

-- 7. 필드 매핑 규칙
CREATE TABLE sync_field_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES sync_profiles(id) ON DELETE CASCADE,
  source_field TEXT NOT NULL,
  source_field_name TEXT NOT NULL DEFAULT '',
  target_field TEXT NOT NULL,
  target_field_name TEXT NOT NULL DEFAULT '',
  transform_type TEXT,
  transform_config JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 8. 상태 ID 매핑
CREATE TABLE sync_profile_status_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES sync_profiles(id) ON DELETE CASCADE,
  source_status_id TEXT NOT NULL,
  source_status_name TEXT NOT NULL DEFAULT '',
  target_status_id TEXT NOT NULL,
  target_status_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 9. 워크플로우 전이 규칙
CREATE TABLE sync_profile_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES sync_profiles(id) ON DELETE CASCADE,
  from_status_id TEXT NOT NULL,
  from_status_name TEXT NOT NULL DEFAULT '',
  to_status_id TEXT NOT NULL,
  to_status_name TEXT NOT NULL DEFAULT '',
  transition_id TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 10. 동기화 허용 에픽 목록
CREATE TABLE sync_profile_allowed_epics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES sync_profiles(id) ON DELETE CASCADE,
  epic_key TEXT NOT NULL,
  epic_summary TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =============================================
-- 트리거: updated_at 자동 갱신
-- =============================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_teams_updated_at
  BEFORE UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_projects_updated_at
  BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- 인덱스
-- =============================================

CREATE INDEX idx_users_team_id ON users(team_id);
CREATE INDEX idx_team_target_projects_team ON team_target_projects(team_id);
CREATE INDEX idx_team_target_projects_project ON team_target_projects(project_id);
CREATE INDEX idx_project_teams_project ON project_teams(project_id);
CREATE INDEX idx_project_teams_team ON project_teams(team_id);

-- =============================================
-- RLS (개발용 전체 허용)
-- =============================================

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_target_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_field_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_profile_status_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_profile_workflows ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_profile_allowed_epics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all for projects" ON projects FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for teams" ON teams FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for users" ON users FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for project_teams" ON project_teams FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for team_target_projects" ON team_target_projects FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for sync_profiles" ON sync_profiles FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for sync_field_mappings" ON sync_field_mappings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for sync_profile_status_mappings" ON sync_profile_status_mappings FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for sync_profile_workflows" ON sync_profile_workflows FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Allow all for sync_profile_allowed_epics" ON sync_profile_allowed_epics FOR ALL USING (true) WITH CHECK (true);
