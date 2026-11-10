-- =====================================================================
-- PartyLink — 가입 동의 (HypeConnect 첫 로그인 온보딩)
--   user_consents : 카카오 로그인 회원(auth.users.id)이 어떤 약관 버전에 동의했는지 기록
--   Edge Function(partylink-api  GET /me, POST /me/onboarding)이 service_role 로만 읽고 씁니다.
--   기존 테이블·데이터는 건드리지 않습니다. 클라이언트(anon/authenticated)는 접근할 수 없습니다.
--
--   약관 버전은 (user_id, terms_version) 이 키라서, 약관이 바뀌어 버전이 오르면
--   같은 회원의 새 행이 생기고 이전 동의 기록은 그대로 남습니다.
-- =====================================================================

BEGIN;

CREATE TABLE user_consents (
    user_id              UUID        NOT NULL,                       -- Supabase: auth.users.id
    terms_version        TEXT        NOT NULL,                       -- 예: 2026-11-10
    agreed_terms         BOOLEAN     NOT NULL,                       -- 이용약관 (필수)
    agreed_privacy       BOOLEAN     NOT NULL,                       -- 개인정보 수집·이용 (필수)
    agreed_marketing     BOOLEAN     NOT NULL DEFAULT FALSE,         -- 마케팅 수신 (선택)
    consented_at         TIMESTAMPTZ NOT NULL DEFAULT now(),         -- 최초 동의 시각 (재요청해도 유지)
    marketing_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),         -- 마케팅 동의 값이 마지막으로 정해진 시각

    PRIMARY KEY (user_id, terms_version),
    CONSTRAINT chk_user_consents_required CHECK (agreed_terms AND agreed_privacy),
    CONSTRAINT chk_user_consents_version  CHECK (length(btrim(terms_version)) BETWEEN 1 AND 30)
);

ALTER TABLE user_consents ENABLE ROW LEVEL SECURITY;               -- 정책 없음 = service_role 외 접근 불가

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        REVOKE ALL ON user_consents FROM anon, authenticated;
        GRANT SELECT, INSERT, UPDATE ON user_consents TO service_role;
    END IF;
END;
$$;

COMMIT;
