-- =====================================================================
-- PartyLink — 관리자 API용 마이그레이션
--   admins : 관리자 계정 목록 (auth.users.id)
--   Edge Function(partylink-api /admin/*)이 service_role 로 조회해 관리자 여부를 판별합니다.
--   클라이언트(anon/authenticated)는 접근할 수 없고, 관리자 추가/삭제는 SQL 로만 합니다.
--
--   관리자 등록 (카카오 로그인 후 Authentication → Users 에서 User UID 확인):
--     INSERT INTO admins (user_id, note) VALUES ('<auth.users.id>', '대표');
-- =====================================================================

BEGIN;

CREATE TABLE admins (
    user_id     UUID        PRIMARY KEY,                -- Supabase: auth.users.id
    note        TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE admins ENABLE ROW LEVEL SECURITY;           -- 정책 없음 = service_role 외 접근 불가

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        REVOKE ALL ON admins FROM anon, authenticated;
        GRANT SELECT ON admins TO service_role;
    END IF;
END;
$$;

COMMIT;
