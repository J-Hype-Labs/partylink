-- =====================================================================
-- PartyLink — party-connect-mvp(웹) 연동용 마이그레이션
--   1) 파티 카드 표시용 컬럼 (카테고리 / 이미지 / 배지 / 추천)
--   2) Edge Function(partylink-api)이 호출하는 서버 전용 함수
--        list_open_parties()       공개 파티 목록 (+ 점포 정보, 선정 인원)
--        upsert_guest_profile()    카카오 로그인 사용자 → guests 프로필 생성/갱신
--        guest_applications()      내 신청 내역
--   모든 함수는 service_role 만 실행 가능 (브라우저 직접 호출 불가)
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. party_slots 표시용 컬럼
-- ---------------------------------------------------------------------
ALTER TABLE party_slots
    ADD COLUMN category     TEXT,
    ADD COLUMN images       TEXT[]  NOT NULL DEFAULT '{}',
    ADD COLUMN badges       TEXT[]  NOT NULL DEFAULT '{}',   -- 예: {'NEW','이벤트'} ('마감임박'/'마감'은 웹에서 자동 계산)
    ADD COLUMN is_featured  BOOLEAN NOT NULL DEFAULT FALSE,
    ADD CONSTRAINT chk_slots_category CHECK (category IS NULL OR category IN ('혼술바', '소개팅', '소셜파티'));


-- ---------------------------------------------------------------------
-- 2-1. 공개 파티 목록
--   selected_count : 정원을 차지하는 인원 (선정 이후 상태) → 웹의 currentRecruit
--   applicant_count: 신청 중인 인원 (반려/취소 제외)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION list_open_parties()
RETURNS TABLE (
    id                UUID,
    title             TEXT,
    description       TEXT,
    benefit           TEXT,
    category          TEXT,
    images            TEXT[],
    badges            TEXT[],
    is_featured       BOOLEAN,
    starts_at         TIMESTAMPTZ,
    ends_at           TIMESTAMPTZ,
    recruit_deadline  TIMESTAMPTZ,
    capacity          INTEGER,
    selected_count    INTEGER,
    applicant_count   INTEGER,
    mission_requirements JSONB,
    store_name        TEXT,
    store_address     TEXT,
    store_region      TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT s.id, s.title, s.description, s.benefit, s.category, s.images, s.badges, s.is_featured,
           s.starts_at, s.ends_at, s.recruit_deadline, s.capacity,
           coalesce(c.selected, 0)::int,
           coalesce(c.applicants, 0)::int,
           s.mission_requirements,
           st.name,
           concat_ws(' ', st.address, st.address_detail),
           st.region::text
      FROM party_slots s
      JOIN stores st ON st.id = s.store_id AND st.is_active
      LEFT JOIN LATERAL (
            SELECT count(*) FILTER (WHERE a.status IN ('APPROVED', 'VISITED', 'MISSION_SUBMITTED', 'COMPLETED', 'NOSHOW')) AS selected,
                   count(*) FILTER (WHERE a.status NOT IN ('REJECTED', 'CANCELLED'))                                     AS applicants
              FROM applications a
             WHERE a.slot_id = s.id
      ) c ON TRUE
     WHERE s.status = 'OPEN'
       AND s.recruit_deadline > now()
     ORDER BY s.is_featured DESC, s.starts_at;
$$;


-- ---------------------------------------------------------------------
-- 2-2. 게스트 프로필 생성/갱신
--   카카오는 전화번호를 기본 제공하지 않으므로, 첫 신청 폼의 이름·연락처로 프로필을 만들고
--   이후 신청 때 입력값으로 갱신합니다. p_user_id 는 Edge Function 이 검증한 auth.users.id.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION upsert_guest_profile(
    p_user_id  UUID,
    p_name     TEXT,
    p_phone    TEXT,
    p_email    TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_name   TEXT := btrim(coalesce(p_name, ''));
    v_phone  TEXT := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
    v_id     UUID;
BEGIN
    IF p_user_id IS NULL THEN
        RAISE EXCEPTION 'User id is required' USING ERRCODE = 'PL400';
    END IF;
    IF char_length(v_name) < 2 THEN
        RAISE EXCEPTION 'Name must be at least 2 characters' USING ERRCODE = 'PL400';
    END IF;
    IF v_phone !~ '^01[0-9]{8,9}$' THEN
        RAISE EXCEPTION 'Invalid phone number' USING ERRCODE = 'PL400';
    END IF;

    INSERT INTO guests (user_id, name, phone, email)
    VALUES (p_user_id, v_name, v_phone, nullif(btrim(p_email), ''))
    ON CONFLICT (user_id) DO UPDATE
       SET name  = EXCLUDED.name,
           phone = EXCLUDED.phone,
           email = coalesce(EXCLUDED.email, guests.email)
    RETURNING id INTO v_id;

    RETURN v_id;
EXCEPTION
    WHEN unique_violation THEN
        -- user_id 충돌은 ON CONFLICT 가 처리하므로 여기 오는 건 전화번호/인스타 중복
        RAISE EXCEPTION 'Phone number is already registered to another account' USING ERRCODE = 'PL409';
END;
$$;


-- ---------------------------------------------------------------------
-- 2-3. 내 신청 내역
--   visit_code 는 선정(APPROVED) 상태에서만 내려줌 (방문 전 코드 유출 최소화)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION guest_applications(p_user_id UUID)
RETURNS TABLE (
    id            UUID,
    slot_id       UUID,
    status        application_status,
    visit_code    TEXT,
    applied_at    TIMESTAMPTZ,
    approved_at   TIMESTAMPTZ,
    visited_at    TIMESTAMPTZ,
    mission_url   TEXT,
    reject_reason TEXT,
    title         TEXT,
    starts_at     TIMESTAMPTZ,
    ends_at       TIMESTAMPTZ,
    store_name    TEXT,
    guest_name    TEXT,
    guest_phone   TEXT
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
    SELECT a.id, a.slot_id, a.status,
           CASE WHEN a.status = 'APPROVED' THEN a.visit_code::text END,
           a.applied_at, a.approved_at, a.visited_at, a.mission_url, a.reject_reason,
           s.title, s.starts_at, s.ends_at, st.name, g.name, g.phone::text
      FROM guests g
      JOIN applications a ON a.guest_id = g.id
      JOIN party_slots s  ON s.id = a.slot_id
      JOIN stores st      ON st.id = s.store_id
     WHERE g.user_id = p_user_id
     ORDER BY a.applied_at DESC;
$$;


-- ---------------------------------------------------------------------
-- 3. 권한: service_role 만
-- ---------------------------------------------------------------------
REVOKE ALL ON FUNCTION list_open_parties()                          FROM PUBLIC;
REVOKE ALL ON FUNCTION upsert_guest_profile(UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION guest_applications(UUID)                     FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        REVOKE ALL ON FUNCTION list_open_parties()                          FROM anon, authenticated;
        REVOKE ALL ON FUNCTION upsert_guest_profile(UUID, TEXT, TEXT, TEXT) FROM anon, authenticated;
        REVOKE ALL ON FUNCTION guest_applications(UUID)                     FROM anon, authenticated;
        GRANT EXECUTE ON FUNCTION list_open_parties()                          TO service_role;
        GRANT EXECUTE ON FUNCTION upsert_guest_profile(UUID, TEXT, TEXT, TEXT) TO service_role;
        GRANT EXECUTE ON FUNCTION guest_applications(UUID)                     TO service_role;
    END IF;
END;
$$;

COMMIT;
