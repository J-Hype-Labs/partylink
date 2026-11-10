-- =====================================================================
-- PartyLink — 파티 상태 자동 전환
--   sync_party_slot_status()  시간이 지난 파티의 상태를 맞춘다
--     1) 종료 시각(ends_at)이 지난 OPEN / CLOSED  → FINISHED
--     2) 모집 마감(recruit_deadline)이 지난 OPEN   → CLOSED
--   * DRAFT(작성 중)·CANCELLED(취소)는 건드리지 않는다.
--   * 신청(applications)은 건드리지 않는다. 선정 대기 중인 신청은 파티가 CLOSED 인 동안 계속 선정할 수 있고,
--     FINISHED 이후에는 선정할 수 없지만 신청 상태는 그대로 남는다.
--   * 방문 인증·미션 제출·정산(complete_application)은 파티 상태를 보지 않으므로 FINISHED 가 되어도 이어서 처리된다.
--   * 멱등: 여러 번(동시에) 실행해도 결과가 같다. 반환값은 이번에 바뀐 건수.
--
--   실행 주기: pg_cron 이 있으면 5분마다(아래 DO 블록이 확장을 켜고 작업을 등록).
--   pg_cron 을 쓸 수 없는 환경이어도 마이그레이션은 성공하며, Edge Function 의 관리자 조회가
--   같은 함수를 호출해 관리자 화면은 항상 맞는 상태를 본다. 공개 목록(list_open_parties)과 신청(apply_to_slot)은
--   원래부터 recruit_deadline 을 직접 비교하므로 이 함수와 무관하게 마감된 파티가 나오지 않는다.
-- =====================================================================

BEGIN;

CREATE OR REPLACE FUNCTION sync_party_slot_status()
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_finished INTEGER;
    v_closed   INTEGER;
BEGIN
    -- 종료를 먼저: 마감과 종료가 모두 지난 파티는 한 번에 FINISHED 가 된다
    UPDATE party_slots SET status = 'FINISHED'
     WHERE status IN ('OPEN', 'CLOSED') AND ends_at <= now();
    GET DIAGNOSTICS v_finished = ROW_COUNT;

    UPDATE party_slots SET status = 'CLOSED'
     WHERE status = 'OPEN' AND recruit_deadline <= now();
    GET DIAGNOSTICS v_closed = ROW_COUNT;

    RETURN jsonb_build_object('finished', v_finished, 'closed', v_closed);
END;
$$;

REVOKE ALL ON FUNCTION sync_party_slot_status() FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        REVOKE ALL ON FUNCTION sync_party_slot_status() FROM anon, authenticated;
        GRANT EXECUTE ON FUNCTION sync_party_slot_status() TO service_role;
    END IF;
END;
$$;

-- 5분마다 실행하는 pg_cron 작업 등록 (같은 이름이면 덮어씀). 불가능하면 알림만 남기고 계속 진행한다.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
       AND EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_cron') THEN
        CREATE EXTENSION pg_cron WITH SCHEMA pg_catalog;
    END IF;

    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        PERFORM cron.schedule('partylink-sync-slot-status', '*/5 * * * *', 'SELECT public.sync_party_slot_status()');
    ELSE
        RAISE NOTICE 'pg_cron 을 쓸 수 없어 정기 작업을 등록하지 않았습니다. 관리자 조회 시 sync_party_slot_status() 가 호출됩니다.';
    END IF;
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron 작업 등록에 실패했습니다(%). 관리자 조회 시 sync_party_slot_status() 가 호출됩니다.', SQLERRM;
END;
$$;

COMMIT;
