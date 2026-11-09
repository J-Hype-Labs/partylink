-- =====================================================================
-- PartyLink — 미션 보완 요청
--   request_mission_revision(app)  MISSION_SUBMITTED → VISITED
--   게스트가 같은 신청에 미션 URL 을 다시 제출할 수 있게 되돌린다 (재제출은 submit_mission 사용).
--   service_role(Edge Function 의 관리자 라우트)만 실행할 수 있다.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION request_mission_revision(p_application_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_status application_status;
BEGIN
    SELECT status INTO v_status FROM applications WHERE id = p_application_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Application % not found', p_application_id USING ERRCODE = 'PL404';
    END IF;
    IF v_status <> 'MISSION_SUBMITTED' THEN
        RAISE EXCEPTION 'Invalid status transition: % -> VISITED', v_status USING ERRCODE = 'PL409';
    END IF;

    UPDATE applications SET status = 'VISITED' WHERE id = p_application_id;
    RETURN jsonb_build_object('application_id', p_application_id, 'status', 'VISITED');
END;
$$;

REVOKE ALL ON FUNCTION request_mission_revision(UUID) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        REVOKE ALL ON FUNCTION request_mission_revision(UUID) FROM anon, authenticated;
        GRANT EXECUTE ON FUNCTION request_mission_revision(UUID) TO service_role;
    END IF;
END;
$$;

COMMIT;
