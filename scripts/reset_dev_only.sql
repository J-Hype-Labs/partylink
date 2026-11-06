-- =====================================================================
-- PartyLink 초기화 스크립트
--   ⚠️  기존 파티링크 테이블/데이터를 전부 삭제합니다. (되돌릴 수 없음)
--   개발 단계에서 v1 → v2 로 새로 깔 때만 사용하세요.
--   실행 순서: 1) partylink_reset.sql  2) partylink_schema.sql
-- =====================================================================
BEGIN;

DROP TABLE IF EXISTS deposit_histories CASCADE;
DROP TABLE IF EXISTS applications      CASCADE;
DROP TABLE IF EXISTS guests            CASCADE;
DROP TABLE IF EXISTS party_slots       CASCADE;
DROP TABLE IF EXISTS stores            CASCADE;

-- v1 시그니처
DROP FUNCTION IF EXISTS mark_noshow(UUID, UUID, INTEGER, INTEGER);
-- v2 시그니처
DROP FUNCTION IF EXISTS mark_noshow(UUID, UUID, INTEGER, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS complete_application(UUID, UUID, UUID);
DROP FUNCTION IF EXISTS charge_deposit(UUID, BIGINT, TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS refund_deposit(UUID, BIGINT, UUID, TEXT);
DROP FUNCTION IF EXISTS apply_to_slot(UUID, UUID);
DROP FUNCTION IF EXISTS approve_application(UUID, UUID);
DROP FUNCTION IF EXISTS reject_application(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS cancel_application(UUID, UUID);
DROP FUNCTION IF EXISTS verify_visit(UUID, TEXT, INTEGER);
DROP FUNCTION IF EXISTS submit_mission(UUID, UUID, TEXT);

-- 트리거 함수 / 유틸 (테이블 삭제로 트리거는 이미 제거됨)
DROP FUNCTION IF EXISTS guard_store_balance();
DROP FUNCTION IF EXISTS fill_slot_default_fee();
DROP FUNCTION IF EXISTS guard_application_status();
DROP FUNCTION IF EXISTS forbid_ledger_mutation();
DROP FUNCTION IF EXISTS _ledger_write_allowed();
DROP FUNCTION IF EXISTS normalize_visit_code(TEXT);
DROP FUNCTION IF EXISTS generate_visit_code();
-- set_updated_at() 은 다른 테이블에서도 쓸 수 있는 공용 함수라 지우지 않음 (v2가 CREATE OR REPLACE)

DROP TYPE IF EXISTS application_status;
DROP TYPE IF EXISTS deposit_type;
DROP TYPE IF EXISTS slot_status;

COMMIT;
