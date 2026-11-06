-- =====================================================================
-- PartyLink (파티링크) Database Schema  — v2 (검토 반영 개선판)
-- Target : PostgreSQL 14+ / Supabase
-- 금액 단위: KRW(원), BIGINT/INTEGER 정수 저장 (소수점 없음)
--
-- v1 대비 주요 변경
--   [보안] 모든 테이블 RLS 활성화 + anon/authenticated 쓰기 권한 회수 (Supabase anon 키로 잔액 조작 가능했음)
--   [버그] 소유권 검증 `<>` → `IS DISTINCT FROM` (p_store_id = NULL이면 검증이 통과되던 문제)
--   [버그] fee_per_guest = 0 슬롯 승인 시 CHECK(amount > 0) 위반으로 실패하던 문제
--   [버그] 노쇼 처리 시 관리자가 수동 차단한 게스트가 차단 해제되던 문제 / 음수 벌점 허용
--   [정합성] 상태 전이 트리거: 정의된 전이만 허용, COMPLETED는 정산 함수에서만 가능
--   [정합성] prepaid_balance는 원장 함수에서만 변경 가능, deposit_histories는 append-only
--   [로직] 정원(capacity) 초과 선정 방지, 수수료는 선정(APPROVED) 시점에 스냅샷
--   [기능] 신청 / 선정 / 반려 / 방문인증 / 미션제출 / 환불 함수 추가
--   [기타] 혼동 문자 없는 방문 코드, search_path에 pg_temp 명시, 저효율 인덱스 제거
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. ENUM 타입
-- ---------------------------------------------------------------------
CREATE TYPE application_status AS ENUM (
    'APPLIED',            -- 게스트 신청
    'APPROVED',           -- 점주 선정(방문 확정)  ← 이 시점에 수수료 스냅샷
    'VISITED',            -- visit_code 검증 완료(방문 인증)
    'MISSION_SUBMITTED',  -- 리뷰 미션 URL 제출
    'COMPLETED',          -- 점주 최종 승인 + 수수료 차감 완료
    'NOSHOW',             -- 노쇼
    'REJECTED',           -- [추가] 점주 미선정 (reject_reason 컬럼과 짝)
    'CANCELLED'           -- [추가] 게스트/점주 취소 (정원 반환)
);

-- CHARGE(+) / DEDUCT(-) / REFUND(-)
CREATE TYPE deposit_type AS ENUM ('CHARGE', 'DEDUCT', 'REFUND');

CREATE TYPE slot_status AS ENUM ('DRAFT', 'OPEN', 'CLOSED', 'CANCELLED', 'FINISHED');


-- ---------------------------------------------------------------------
-- 공통 함수
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$;

-- 원장/정산 함수 안에서만 켜지는 트랜잭션 로컬 플래그
--   (직접 UPDATE로 잔액·COMPLETED 를 바꾸는 실수를 막는 가드. 보안 경계는 RLS/권한이 담당)
CREATE OR REPLACE FUNCTION _ledger_write_allowed()
RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
    SELECT coalesce(current_setting('partylink.ledger_write', true), '') = 'on';
$$;

-- 방문 코드: Crockford Base32 (I, L, O, U 제외) × 10자리 = 50bit (v1: 16진수 40bit)
--   gen_random_uuid()(PG13+ 코어)의 랜덤 바이트만 사용 (버전/variant 바이트 6, 8 제외)
--   입력 시 O→0, I/L→1 로 정규화하므로 손으로 불러줘도 오인식이 적음 (normalize_visit_code)
CREATE OR REPLACE FUNCTION generate_visit_code()
RETURNS TEXT LANGUAGE sql VOLATILE AS $$
    SELECT string_agg(
               substr('0123456789ABCDEFGHJKMNPQRSTVWXYZ', (get_byte(b, i) % 32) + 1, 1), '' ORDER BY n)
      FROM (SELECT uuid_send(gen_random_uuid()) AS b) r,
           unnest(ARRAY[0,1,2,3,4,5,7,9,10,11]) WITH ORDINALITY AS t(i, n);
$$;

CREATE OR REPLACE FUNCTION normalize_visit_code(p_code TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
    SELECT translate(upper(regexp_replace(coalesce(p_code, ''), '[\s-]', '', 'g')), 'OIL', '011');
$$;


-- =====================================================================
-- 1. stores : 점주/업체 + 선불 적립금
-- =====================================================================
CREATE TABLE stores (
    id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id           UUID        NOT NULL UNIQUE,           -- Supabase: auth.users.id (1인 1점포 가정)
    name                    TEXT        NOT NULL,
    business_reg_no         VARCHAR(12) NOT NULL UNIQUE,           -- 000-00-00000
    owner_name              TEXT        NOT NULL,
    phone                   VARCHAR(20) NOT NULL,
    address                 TEXT        NOT NULL,
    address_detail          TEXT,
    region                  VARCHAR(50),
    instagram_handle        VARCHAR(50),

    prepaid_balance         BIGINT      NOT NULL DEFAULT 0,        -- 원장 함수로만 변경 (트리거 가드)
    default_fee_per_guest   INTEGER     NOT NULL DEFAULT 10000,    -- 슬롯 생성 시 fee 미지정이면 자동 적용

    is_active               BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_stores_balance_non_negative CHECK (prepaid_balance >= 0),
    CONSTRAINT chk_stores_default_fee          CHECK (default_fee_per_guest >= 0),
    CONSTRAINT chk_stores_brn_format           CHECK (business_reg_no ~ '^\d{3}-\d{2}-\d{5}$')
);

CREATE INDEX idx_stores_region ON stores (region) WHERE is_active;

CREATE TRIGGER trg_stores_updated_at
    BEFORE UPDATE ON stores FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 잔액은 0으로 생성, 이후 원장 함수 외 변경 금지
CREATE OR REPLACE FUNCTION guard_store_balance()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.prepaid_balance <> 0 THEN
        RAISE EXCEPTION 'prepaid_balance must start at 0; use charge_deposit()' USING ERRCODE = 'PL400';
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.prepaid_balance IS DISTINCT FROM OLD.prepaid_balance
       AND NOT _ledger_write_allowed() THEN
        RAISE EXCEPTION 'prepaid_balance can only be changed via ledger functions' USING ERRCODE = 'PL400';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_stores_guard_balance
    BEFORE INSERT OR UPDATE OF prepaid_balance ON stores
    FOR EACH ROW EXECUTE FUNCTION guard_store_balance();


-- =====================================================================
-- 2. party_slots
-- =====================================================================
CREATE TABLE party_slots (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id              UUID        NOT NULL REFERENCES stores (id) ON DELETE RESTRICT,

    title                 TEXT        NOT NULL,
    description           TEXT,
    starts_at             TIMESTAMPTZ NOT NULL,
    ends_at               TIMESTAMPTZ NOT NULL,
    recruit_deadline      TIMESTAMPTZ NOT NULL,

    capacity              INTEGER     NOT NULL,
    benefit               TEXT        NOT NULL,
    mission_requirements  JSONB       NOT NULL DEFAULT '{}'::jsonb,
        -- 예: {"platform":"instagram","type":"feed","min_photos":3,"hashtags":["#파티링크"],"keep_days":30}
    fee_per_guest         INTEGER     NOT NULL,                    -- 미지정 시 stores.default_fee_per_guest (트리거)

    status                slot_status NOT NULL DEFAULT 'DRAFT',
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_slots_time      CHECK (ends_at > starts_at),
    CONSTRAINT chk_slots_deadline  CHECK (recruit_deadline <= starts_at),
    CONSTRAINT chk_slots_capacity  CHECK (capacity > 0),
    CONSTRAINT chk_slots_fee       CHECK (fee_per_guest >= 0),
    CONSTRAINT chk_slots_mission   CHECK (jsonb_typeof(mission_requirements) = 'object')
);

CREATE INDEX idx_slots_store_starts ON party_slots (store_id, starts_at DESC);
CREATE INDEX idx_slots_open_starts  ON party_slots (starts_at) WHERE status = 'OPEN';

CREATE TRIGGER trg_party_slots_updated_at
    BEFORE UPDATE ON party_slots FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- fee_per_guest 미지정 시 점포 기본 수수료 적용 (NOT NULL 검사는 BEFORE 트리거 이후 수행됨)
CREATE OR REPLACE FUNCTION fill_slot_default_fee()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.fee_per_guest IS NULL THEN
        SELECT default_fee_per_guest INTO NEW.fee_per_guest FROM stores WHERE id = NEW.store_id;
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_party_slots_default_fee
    BEFORE INSERT ON party_slots FOR EACH ROW EXECUTE FUNCTION fill_slot_default_fee();


-- =====================================================================
-- 3. guests
-- ---------------------------------------------------------------------
--   차단 규칙 (v1에서 is_blocked 가 노쇼 처리로 덮어써지던 문제 수정)
--     is_blocked    : 관리자 수동 차단 (기간 없음, 관리자만 해제)
--     blocked_until : 벌점 누적 자동 차단 (시간이 지나면 자연 해제)
--   → 신청 가능 여부 = NOT is_blocked AND (blocked_until IS NULL OR blocked_until <= now())
-- =====================================================================
CREATE TABLE guests (
    id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID        NOT NULL UNIQUE,               -- Supabase: auth.users.id
    name                TEXT        NOT NULL,
    phone               VARCHAR(20) NOT NULL UNIQUE,               -- 숫자만 저장 권장 (01012345678)
    email               TEXT,
    birth_year          SMALLINT,

    instagram_handle    VARCHAR(50),
    sns_profile_url     TEXT,
    follower_count      INTEGER     NOT NULL DEFAULT 0,

    noshow_count        INTEGER     NOT NULL DEFAULT 0,
    penalty_count       INTEGER     NOT NULL DEFAULT 0,
    is_blocked          BOOLEAN     NOT NULL DEFAULT FALSE,
    blocked_until       TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_guests_counts     CHECK (noshow_count >= 0 AND penalty_count >= 0 AND follower_count >= 0),
    CONSTRAINT chk_guests_birth_year CHECK (birth_year IS NULL OR birth_year BETWEEN 1900 AND 2100)
);

CREATE UNIQUE INDEX uq_guests_instagram ON guests (lower(instagram_handle)) WHERE instagram_handle IS NOT NULL;

CREATE TRIGGER trg_guests_updated_at
    BEFORE UPDATE ON guests FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- =====================================================================
-- 4. applications
-- =====================================================================
CREATE TABLE applications (
    id                    UUID               PRIMARY KEY DEFAULT gen_random_uuid(),
    slot_id               UUID               NOT NULL REFERENCES party_slots (id) ON DELETE RESTRICT,
    guest_id              UUID               NOT NULL REFERENCES guests (id)      ON DELETE RESTRICT,

    status                application_status NOT NULL DEFAULT 'APPLIED',
    visit_code            VARCHAR(16)        NOT NULL DEFAULT generate_visit_code(),

    mission_url           TEXT,
    applied_at            TIMESTAMPTZ        NOT NULL DEFAULT now(),
    approved_at           TIMESTAMPTZ,
    visited_at            TIMESTAMPTZ,
    mission_submitted_at  TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ,
    noshow_at             TIMESTAMPTZ,
    closed_at             TIMESTAMPTZ,       -- REJECTED / CANCELLED 시각

    -- 정산
    fee_amount            INTEGER,           -- 선정(APPROVED) 시점 수수료 스냅샷 → 이후 슬롯 수수료를 바꿔도 불변
    settled_at            TIMESTAMPTZ,
    deposit_history_id    BIGINT,            -- 차감 원장 행 (fee 0원이면 NULL)

    reject_reason         TEXT,
    created_at            TIMESTAMPTZ        NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ        NOT NULL DEFAULT now(),

    CONSTRAINT uq_applications_slot_guest UNIQUE (slot_id, guest_id),
    CONSTRAINT uq_applications_visit_code UNIQUE (visit_code),
    CONSTRAINT chk_app_fee_non_negative   CHECK (fee_amount IS NULL OR fee_amount >= 0),
    CONSTRAINT chk_app_fee_snapshot       CHECK (
        status IN ('APPLIED', 'REJECTED', 'CANCELLED') OR (fee_amount IS NOT NULL AND approved_at IS NOT NULL)
    ),
    CONSTRAINT chk_app_visited            CHECK (
        status NOT IN ('VISITED', 'MISSION_SUBMITTED', 'COMPLETED') OR visited_at IS NOT NULL
    ),
    CONSTRAINT chk_app_mission_url        CHECK (
        status NOT IN ('MISSION_SUBMITTED', 'COMPLETED') OR (mission_url IS NOT NULL AND mission_submitted_at IS NOT NULL)
    ),
    CONSTRAINT chk_app_completed_settled  CHECK (
        status <> 'COMPLETED' OR (settled_at IS NOT NULL AND completed_at IS NOT NULL)
    ),
    CONSTRAINT chk_app_mission_url_format CHECK (mission_url IS NULL OR mission_url ~* '^https?://')
);

CREATE INDEX idx_applications_slot_status  ON applications (slot_id, status);
CREATE INDEX idx_applications_guest        ON applications (guest_id, created_at DESC);
CREATE INDEX idx_applications_pending_review
    ON applications (slot_id, mission_submitted_at) WHERE status = 'MISSION_SUBMITTED';

CREATE TRIGGER trg_applications_updated_at
    BEFORE UPDATE ON applications FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 상태 전이 가드: 정의된 전이만 허용 + COMPLETED 는 정산 함수에서만
--   (v1의 chk_app_completed_settled 는 settled_at 등을 같이 채우면 우회 가능했음)
CREATE OR REPLACE FUNCTION guard_application_status()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'APPLIED' THEN
            RAISE EXCEPTION 'New application must start as APPLIED' USING ERRCODE = 'PL409';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.status = OLD.status THEN
        RETURN NEW;
    END IF;

    IF NOT (
           (OLD.status = 'APPLIED'           AND NEW.status IN ('APPROVED', 'REJECTED', 'CANCELLED'))
        OR (OLD.status = 'APPROVED'          AND NEW.status IN ('VISITED', 'NOSHOW', 'CANCELLED'))
        OR (OLD.status = 'VISITED'           AND NEW.status =  'MISSION_SUBMITTED')
        OR (OLD.status = 'MISSION_SUBMITTED' AND NEW.status IN ('COMPLETED', 'VISITED'))  -- VISITED = 미션 보완 요청
    ) THEN
        RAISE EXCEPTION 'Invalid status transition: % -> %', OLD.status, NEW.status USING ERRCODE = 'PL409';
    END IF;

    IF NEW.status = 'COMPLETED' AND NOT _ledger_write_allowed() THEN
        RAISE EXCEPTION 'COMPLETED can only be set by complete_application()' USING ERRCODE = 'PL409';
    END IF;

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_applications_guard_status
    BEFORE INSERT OR UPDATE OF status ON applications
    FOR EACH ROW EXECUTE FUNCTION guard_application_status();


-- =====================================================================
-- 5. deposit_histories : 적립금 원장 (append-only)
-- =====================================================================
CREATE TABLE deposit_histories (
    id               BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    store_id         UUID         NOT NULL REFERENCES stores (id)       ON DELETE RESTRICT,
    application_id   UUID                  REFERENCES applications (id) ON DELETE RESTRICT,

    type             deposit_type NOT NULL,
    amount           BIGINT       NOT NULL,            -- 항상 양수, 방향은 type
    balance_before   BIGINT       NOT NULL,
    balance_after    BIGINT       NOT NULL,

    depositor_name   TEXT,                             -- CHARGE: 입금자명
    memo             TEXT,
    created_by       UUID,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),

    CONSTRAINT chk_dh_amount_positive    CHECK (amount > 0),
    CONSTRAINT chk_dh_balance_non_neg    CHECK (balance_before >= 0 AND balance_after >= 0),
    CONSTRAINT chk_dh_balance_math       CHECK (
        (type = 'CHARGE'              AND balance_after = balance_before + amount) OR
        (type IN ('DEDUCT', 'REFUND') AND balance_after = balance_before - amount)
    ),
    CONSTRAINT chk_dh_deduct_needs_app   CHECK (type <> 'DEDUCT' OR application_id IS NOT NULL),
    CONSTRAINT chk_dh_charge_depositor   CHECK (type <> 'CHARGE' OR depositor_name IS NOT NULL)
);

CREATE INDEX idx_dh_store_created ON deposit_histories (store_id, created_at DESC, id DESC);
CREATE UNIQUE INDEX uq_dh_deduct_per_application
    ON deposit_histories (application_id) WHERE type = 'DEDUCT';

ALTER TABLE applications
    ADD CONSTRAINT fk_app_deposit_history
    FOREIGN KEY (deposit_history_id) REFERENCES deposit_histories (id) ON DELETE RESTRICT;

-- 원장은 수정/삭제 불가 (정정은 반대 방향 거래로)
CREATE OR REPLACE FUNCTION forbid_ledger_mutation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'deposit_histories is append-only' USING ERRCODE = 'PL400';
END;
$$;

CREATE TRIGGER trg_dh_append_only
    BEFORE UPDATE OR DELETE ON deposit_histories
    FOR EACH ROW EXECUTE FUNCTION forbid_ledger_mutation();

CREATE TRIGGER trg_dh_no_truncate
    BEFORE TRUNCATE ON deposit_histories
    FOR EACH STATEMENT EXECUTE FUNCTION forbid_ledger_mutation();


-- =====================================================================
-- 6. 업무 함수
-- ---------------------------------------------------------------------
--   * 모든 함수는 호출 트랜잭션 안에서 원자적으로 실행 (RAISE 시 전부 롤백)
--   * 락 순서 고정: party_slots → applications → stores / guests  (데드락 방지)
--   * 소유권 비교는 IS DISTINCT FROM (NULL 입력 시 통과되던 v1 버그 수정)
--
--   SQLSTATE (백엔드 분기용)
--     PL400 잘못된 입력 · PL402 잔액 부족 · PL403 권한 없음 · PL404 없음
--     PL409 상태 전이 불가 · PL410 모집 마감/정원 초과 · PL423 게스트 차단 상태
-- =====================================================================

-- 6-1. 신청 (게스트)
CREATE OR REPLACE FUNCTION apply_to_slot(p_slot_id UUID, p_guest_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_slot  party_slots%ROWTYPE;
    v_guest guests%ROWTYPE;
    v_app   applications%ROWTYPE;
BEGIN
    SELECT * INTO v_slot FROM party_slots WHERE id = p_slot_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Slot % not found', p_slot_id USING ERRCODE = 'PL404';
    END IF;
    IF v_slot.status <> 'OPEN' OR now() > v_slot.recruit_deadline THEN
        RAISE EXCEPTION 'Slot % is not accepting applications', p_slot_id USING ERRCODE = 'PL410';
    END IF;

    SELECT * INTO v_guest FROM guests WHERE id = p_guest_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Guest % not found', p_guest_id USING ERRCODE = 'PL404';
    END IF;
    IF v_guest.is_blocked OR v_guest.blocked_until > now() THEN
        RAISE EXCEPTION 'Guest % is blocked', p_guest_id
              USING ERRCODE = 'PL423', DETAIL = coalesce(v_guest.blocked_until::text, 'permanent');
    END IF;

    INSERT INTO applications (slot_id, guest_id) VALUES (p_slot_id, p_guest_id)
    RETURNING * INTO v_app;

    RETURN jsonb_build_object('application_id', v_app.id, 'status', v_app.status, 'visit_code', v_app.visit_code);
EXCEPTION
    WHEN unique_violation THEN
        -- visit_code 충돌(50bit, 극히 희박)도 여기로 오지만 재시도로 해결되므로 동일 응답
        RAISE EXCEPTION 'Guest already applied to slot % (or retry)', p_slot_id USING ERRCODE = 'PL409';
END;
$$;


-- 6-2. 선정 (점주) — 정원 검증 + 수수료 스냅샷
CREATE OR REPLACE FUNCTION approve_application(p_application_id UUID, p_store_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_slot_id UUID;
    v_slot    party_slots%ROWTYPE;
    v_app     applications%ROWTYPE;
    v_taken   INTEGER;
BEGIN
    SELECT slot_id INTO v_slot_id FROM applications WHERE id = p_application_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Application % not found', p_application_id USING ERRCODE = 'PL404';
    END IF;

    -- 슬롯 행 잠금 → 같은 슬롯 선정 요청 직렬화 (동시 선정으로 정원 초과 방지)
    SELECT * INTO v_slot FROM party_slots WHERE id = v_slot_id FOR UPDATE;
    IF v_slot.store_id IS DISTINCT FROM p_store_id THEN
        RAISE EXCEPTION 'Application % does not belong to store %', p_application_id, p_store_id USING ERRCODE = 'PL403';
    END IF;
    IF v_slot.status NOT IN ('OPEN', 'CLOSED') THEN
        RAISE EXCEPTION 'Slot % is %', v_slot.id, v_slot.status USING ERRCODE = 'PL410';
    END IF;

    SELECT * INTO v_app FROM applications WHERE id = p_application_id FOR UPDATE;
    IF v_app.status <> 'APPLIED' THEN
        RAISE EXCEPTION 'Invalid status transition: % -> APPROVED', v_app.status USING ERRCODE = 'PL409';
    END IF;

    SELECT count(*) INTO v_taken
      FROM applications
     WHERE slot_id = v_slot.id
       AND status IN ('APPROVED', 'VISITED', 'MISSION_SUBMITTED', 'COMPLETED', 'NOSHOW');
    IF v_taken >= v_slot.capacity THEN
        RAISE EXCEPTION 'Slot % is full (%/%)', v_slot.id, v_taken, v_slot.capacity USING ERRCODE = 'PL410';
    END IF;

    UPDATE applications
       SET status = 'APPROVED', approved_at = now(), fee_amount = v_slot.fee_per_guest
     WHERE id = p_application_id;

    RETURN jsonb_build_object('application_id', p_application_id, 'status', 'APPROVED',
                              'fee_amount', v_slot.fee_per_guest,
                              'approved_count', v_taken + 1, 'capacity', v_slot.capacity);
END;
$$;


-- 6-3. 반려 (점주)
CREATE OR REPLACE FUNCTION reject_application(p_application_id UUID, p_store_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_app        applications%ROWTYPE;
    v_slot_store UUID;
BEGIN
    SELECT * INTO v_app FROM applications WHERE id = p_application_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Application % not found', p_application_id USING ERRCODE = 'PL404';
    END IF;
    SELECT store_id INTO v_slot_store FROM party_slots WHERE id = v_app.slot_id;
    IF v_slot_store IS DISTINCT FROM p_store_id THEN
        RAISE EXCEPTION 'Application % does not belong to store %', p_application_id, p_store_id USING ERRCODE = 'PL403';
    END IF;

    UPDATE applications  -- 전이 가능 여부는 트리거가 검증 (APPLIED 에서만)
       SET status = 'REJECTED', reject_reason = p_reason, closed_at = now()
     WHERE id = p_application_id;

    RETURN jsonb_build_object('application_id', p_application_id, 'status', 'REJECTED');
END;
$$;


-- 6-3b. 취소 (게스트 본인, 파티 시작 전) — 선정 건 취소 시 정원 반환
CREATE OR REPLACE FUNCTION cancel_application(p_application_id UUID, p_guest_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_app      applications%ROWTYPE;
    v_starts   TIMESTAMPTZ;
BEGIN
    SELECT * INTO v_app FROM applications WHERE id = p_application_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Application % not found', p_application_id USING ERRCODE = 'PL404';
    END IF;
    IF v_app.guest_id IS DISTINCT FROM p_guest_id THEN
        RAISE EXCEPTION 'Application % does not belong to guest %', p_application_id, p_guest_id USING ERRCODE = 'PL403';
    END IF;
    SELECT starts_at INTO v_starts FROM party_slots WHERE id = v_app.slot_id;
    IF now() >= v_starts THEN
        RAISE EXCEPTION 'Cannot cancel after the party starts' USING ERRCODE = 'PL410';
    END IF;

    UPDATE applications SET status = 'CANCELLED', closed_at = now()   -- APPLIED/APPROVED 에서만 (트리거)
     WHERE id = p_application_id;

    RETURN jsonb_build_object('application_id', p_application_id, 'status', 'CANCELLED');
END;
$$;


-- 6-4. 방문 인증 (점주가 게스트 QR/코드 스캔)
--   타 점포 코드는 '없음'과 동일하게 응답 → 코드 존재 여부 탐색(oracle) 방지
CREATE OR REPLACE FUNCTION verify_visit(
    p_store_id      UUID,
    p_visit_code    TEXT,
    p_early_minutes INTEGER DEFAULT 60     -- 파티 시작 몇 분 전부터 인증 허용
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_app  applications%ROWTYPE;
    v_slot party_slots%ROWTYPE;
BEGIN
    SELECT a.* INTO v_app
      FROM applications a
      JOIN party_slots s ON s.id = a.slot_id
     WHERE a.visit_code = normalize_visit_code(p_visit_code)
       AND s.store_id = p_store_id
       FOR UPDATE OF a;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Visit code not found' USING ERRCODE = 'PL404';
    END IF;

    SELECT * INTO v_slot FROM party_slots WHERE id = v_app.slot_id;
    IF now() < v_slot.starts_at - make_interval(mins => p_early_minutes) OR now() > v_slot.ends_at THEN
        RAISE EXCEPTION 'Visit verification is only allowed during the party window' USING ERRCODE = 'PL410';
    END IF;

    IF v_app.status <> 'APPROVED' THEN
        RAISE EXCEPTION 'Invalid status transition: % -> VISITED', v_app.status USING ERRCODE = 'PL409';
    END IF;

    UPDATE applications SET status = 'VISITED', visited_at = now() WHERE id = v_app.id;

    RETURN jsonb_build_object('application_id', v_app.id, 'guest_id', v_app.guest_id, 'status', 'VISITED');
END;
$$;


-- 6-5. 미션 제출 (게스트)
CREATE OR REPLACE FUNCTION submit_mission(p_application_id UUID, p_guest_id UUID, p_mission_url TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_app applications%ROWTYPE;
BEGIN
    SELECT * INTO v_app FROM applications WHERE id = p_application_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Application % not found', p_application_id USING ERRCODE = 'PL404';
    END IF;
    IF v_app.guest_id IS DISTINCT FROM p_guest_id THEN
        RAISE EXCEPTION 'Application % does not belong to guest %', p_application_id, p_guest_id USING ERRCODE = 'PL403';
    END IF;
    IF p_mission_url IS NULL OR p_mission_url !~* '^https?://' THEN
        RAISE EXCEPTION 'Invalid mission URL' USING ERRCODE = 'PL400';
    END IF;

    UPDATE applications  -- VISITED 에서만 가능 (트리거 검증)
       SET status = 'MISSION_SUBMITTED', mission_url = p_mission_url, mission_submitted_at = now()
     WHERE id = p_application_id;

    RETURN jsonb_build_object('application_id', p_application_id, 'status', 'MISSION_SUBMITTED');
END;
$$;


-- 6-6. ★ 미션 최종 승인 → 수수료 차감 (원자적)
CREATE OR REPLACE FUNCTION complete_application(
    p_application_id  UUID,
    p_store_id        UUID,           -- 백엔드에서 인증 후 전달
    p_actor_user_id   UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_app          applications%ROWTYPE;
    v_slot_store   UUID;
    v_fee          INTEGER;
    v_balance      BIGINT;
    v_new_balance  BIGINT;
    v_history_id   BIGINT;
    v_now          TIMESTAMPTZ := now();
BEGIN
    -- 1) 신청 건 잠금
    SELECT * INTO v_app FROM applications WHERE id = p_application_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Application % not found', p_application_id USING ERRCODE = 'PL404';
    END IF;

    -- 2) 소유권 검증 (NULL-safe)
    SELECT store_id INTO v_slot_store FROM party_slots WHERE id = v_app.slot_id;
    IF v_slot_store IS DISTINCT FROM p_store_id THEN
        RAISE EXCEPTION 'Application % does not belong to store %', p_application_id, p_store_id
              USING ERRCODE = 'PL403';
    END IF;

    -- 3) 상태 검증
    IF v_app.status <> 'MISSION_SUBMITTED' THEN
        RAISE EXCEPTION 'Invalid status transition: % -> COMPLETED', v_app.status USING ERRCODE = 'PL409';
    END IF;

    -- 4) 선정 시점 스냅샷 수수료 사용 (승인 직전 슬롯 수수료를 0원으로 바꾸는 회피 차단)
    v_fee := v_app.fee_amount;

    -- 5) 잔액 잠금 + 검증
    SELECT prepaid_balance INTO v_balance FROM stores WHERE id = v_slot_store FOR UPDATE;

    IF v_balance < v_fee THEN
        RAISE EXCEPTION 'Insufficient prepaid balance: balance=%, required=%', v_balance, v_fee
              USING ERRCODE = 'PL402',
                    DETAIL  = json_build_object('balance', v_balance, 'required', v_fee,
                                                'shortage', v_fee - v_balance)::text,
                    HINT    = '적립금을 충전한 뒤 다시 승인해 주세요.';
    END IF;

    v_new_balance := v_balance - v_fee;

    PERFORM set_config('partylink.ledger_write', 'on', true);

    -- 6) ① 차감 + ② 이력 (수수료 0원 슬롯은 원장 기록 없이 완료만)
    IF v_fee > 0 THEN
        UPDATE stores SET prepaid_balance = v_new_balance WHERE id = v_slot_store;

        INSERT INTO deposit_histories (
            store_id, application_id, type, amount, balance_before, balance_after, memo, created_by
        ) VALUES (
            v_slot_store, p_application_id, 'DEDUCT', v_fee, v_balance, v_new_balance,
            '방문 미션 승인 수수료', p_actor_user_id
        )
        RETURNING id INTO v_history_id;
    END IF;

    -- 7) 완료 처리
    UPDATE applications
       SET status             = 'COMPLETED',
           completed_at       = v_now,
           settled_at         = v_now,
           deposit_history_id = v_history_id
     WHERE id = p_application_id;

    PERFORM set_config('partylink.ledger_write', 'off', true);

    RETURN jsonb_build_object(
        'application_id',     p_application_id,
        'status',             'COMPLETED',
        'fee_amount',         v_fee,
        'balance_before',     v_balance,
        'balance_after',      v_new_balance,
        'deposit_history_id', v_history_id,
        'completed_at',       v_now
    );
END;
$$;


-- 6-7. 적립금 충전 (관리자 입금 확인 후)
CREATE OR REPLACE FUNCTION charge_deposit(
    p_store_id        UUID,
    p_amount          BIGINT,
    p_depositor_name  TEXT,
    p_admin_user_id   UUID DEFAULT NULL,
    p_memo            TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_balance     BIGINT;
    v_history_id  BIGINT;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Charge amount must be positive' USING ERRCODE = 'PL400';
    END IF;
    IF coalesce(btrim(p_depositor_name), '') = '' THEN
        RAISE EXCEPTION 'Depositor name is required' USING ERRCODE = 'PL400';
    END IF;

    SELECT prepaid_balance INTO v_balance FROM stores WHERE id = p_store_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Store % not found', p_store_id USING ERRCODE = 'PL404';
    END IF;

    PERFORM set_config('partylink.ledger_write', 'on', true);
    UPDATE stores SET prepaid_balance = v_balance + p_amount WHERE id = p_store_id;
    PERFORM set_config('partylink.ledger_write', 'off', true);

    INSERT INTO deposit_histories (
        store_id, type, amount, balance_before, balance_after, depositor_name, memo, created_by
    ) VALUES (
        p_store_id, 'CHARGE', p_amount, v_balance, v_balance + p_amount, p_depositor_name, p_memo, p_admin_user_id
    )
    RETURNING id INTO v_history_id;

    RETURN jsonb_build_object('store_id', p_store_id, 'balance_before', v_balance,
                              'balance_after', v_balance + p_amount, 'deposit_history_id', v_history_id);
END;
$$;


-- 6-8. [추가] 적립금 환불 (점주 요청, 관리자 처리)
CREATE OR REPLACE FUNCTION refund_deposit(
    p_store_id       UUID,
    p_amount         BIGINT,
    p_admin_user_id  UUID DEFAULT NULL,
    p_memo           TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_balance     BIGINT;
    v_history_id  BIGINT;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Refund amount must be positive' USING ERRCODE = 'PL400';
    END IF;

    SELECT prepaid_balance INTO v_balance FROM stores WHERE id = p_store_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Store % not found', p_store_id USING ERRCODE = 'PL404';
    END IF;
    IF v_balance < p_amount THEN
        RAISE EXCEPTION 'Insufficient prepaid balance: balance=%, requested=%', v_balance, p_amount
              USING ERRCODE = 'PL402';
    END IF;

    PERFORM set_config('partylink.ledger_write', 'on', true);
    UPDATE stores SET prepaid_balance = v_balance - p_amount WHERE id = p_store_id;
    PERFORM set_config('partylink.ledger_write', 'off', true);

    INSERT INTO deposit_histories (
        store_id, type, amount, balance_before, balance_after, memo, created_by
    ) VALUES (
        p_store_id, 'REFUND', p_amount, v_balance, v_balance - p_amount, p_memo, p_admin_user_id
    )
    RETURNING id INTO v_history_id;

    RETURN jsonb_build_object('store_id', p_store_id, 'balance_before', v_balance,
                              'balance_after', v_balance - p_amount, 'deposit_history_id', v_history_id);
END;
$$;


-- 6-9. 노쇼 처리 (신청 상태 + 게스트 벌점, 원자적)
CREATE OR REPLACE FUNCTION mark_noshow(
    p_application_id  UUID,
    p_store_id        UUID,
    p_penalty_points  INTEGER DEFAULT 1,
    p_block_threshold INTEGER DEFAULT 3,       -- 누적 벌점이 이 값 이상이면 자동 차단
    p_block_days      INTEGER DEFAULT 30
)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_app         applications%ROWTYPE;
    v_slot        party_slots%ROWTYPE;
    v_guest       guests%ROWTYPE;
BEGIN
    IF p_penalty_points IS NULL OR p_penalty_points < 0 OR p_block_threshold IS NULL OR p_block_threshold <= 0 THEN
        RAISE EXCEPTION 'Invalid penalty parameters' USING ERRCODE = 'PL400';
    END IF;

    SELECT * INTO v_app FROM applications WHERE id = p_application_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Application % not found', p_application_id USING ERRCODE = 'PL404';
    END IF;

    SELECT * INTO v_slot FROM party_slots WHERE id = v_app.slot_id;
    IF v_slot.store_id IS DISTINCT FROM p_store_id THEN
        RAISE EXCEPTION 'Application % does not belong to store %', p_application_id, p_store_id
              USING ERRCODE = 'PL403';
    END IF;

    IF v_app.status <> 'APPROVED' THEN
        RAISE EXCEPTION 'Invalid status transition: % -> NOSHOW', v_app.status USING ERRCODE = 'PL409';
    END IF;

    -- 파티 시작 전에는 노쇼 처리 불가
    IF now() < v_slot.starts_at THEN
        RAISE EXCEPTION 'No-show can only be marked after the party starts (%)', v_slot.starts_at
              USING ERRCODE = 'PL410';
    END IF;

    UPDATE applications SET status = 'NOSHOW', noshow_at = now() WHERE id = p_application_id;

    -- is_blocked(수동 차단)는 건드리지 않음. 자동 차단은 blocked_until 로만 (기존 기간보다 짧아지지 않게)
    UPDATE guests
       SET noshow_count  = noshow_count + 1,
           penalty_count = penalty_count + p_penalty_points,
           blocked_until = CASE
                               WHEN penalty_count + p_penalty_points >= p_block_threshold
                               THEN greatest(coalesce(blocked_until, now()), now() + make_interval(days => p_block_days))
                               ELSE blocked_until
                           END
     WHERE id = v_app.guest_id
    RETURNING * INTO v_guest;

    RETURN jsonb_build_object(
        'application_id', p_application_id,
        'status',         'NOSHOW',
        'guest_id',       v_guest.id,
        'penalty_count',  v_guest.penalty_count,
        'blocked_until',  v_guest.blocked_until
    );
END;
$$;


-- =====================================================================
-- 7. 권한 + RLS
-- ---------------------------------------------------------------------
--   설계: 모든 쓰기는 백엔드(service_role) → 업무 함수 경유.
--         클라이언트(anon/authenticated)는 RLS 정책 범위의 SELECT 만.
--   Supabase 는 public 스키마 테이블에 anon/authenticated ALL 권한을 기본 부여하므로
--   RLS 를 켜지 않으면 anon 키만으로 prepaid_balance 수정·게스트 전화번호 조회가 가능했음.
-- =====================================================================
ALTER TABLE stores            ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_slots       ENABLE ROW LEVEL SECURITY;
ALTER TABLE guests            ENABLE ROW LEVEL SECURITY;
ALTER TABLE applications      ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposit_histories ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON FUNCTION apply_to_slot(UUID, UUID)                        FROM PUBLIC;
REVOKE ALL ON FUNCTION approve_application(UUID, UUID)                  FROM PUBLIC;
REVOKE ALL ON FUNCTION reject_application(UUID, UUID, TEXT)             FROM PUBLIC;
REVOKE ALL ON FUNCTION cancel_application(UUID, UUID)                   FROM PUBLIC;
REVOKE ALL ON FUNCTION verify_visit(UUID, TEXT, INTEGER)                FROM PUBLIC;
REVOKE ALL ON FUNCTION submit_mission(UUID, UUID, TEXT)                 FROM PUBLIC;
REVOKE ALL ON FUNCTION complete_application(UUID, UUID, UUID)           FROM PUBLIC;
REVOKE ALL ON FUNCTION charge_deposit(UUID, BIGINT, TEXT, UUID, TEXT)   FROM PUBLIC;
REVOKE ALL ON FUNCTION refund_deposit(UUID, BIGINT, UUID, TEXT)         FROM PUBLIC;
REVOKE ALL ON FUNCTION mark_noshow(UUID, UUID, INTEGER, INTEGER, INTEGER) FROM PUBLIC;

DO $$
DECLARE
    v_fn TEXT;
    v_fns TEXT[] := ARRAY[
        'apply_to_slot(UUID, UUID)',
        'approve_application(UUID, UUID)',
        'reject_application(UUID, UUID, TEXT)',
        'cancel_application(UUID, UUID)',
        'verify_visit(UUID, TEXT, INTEGER)',
        'submit_mission(UUID, UUID, TEXT)',
        'complete_application(UUID, UUID, UUID)',
        'charge_deposit(UUID, BIGINT, TEXT, UUID, TEXT)',
        'refund_deposit(UUID, BIGINT, UUID, TEXT)',
        'mark_noshow(UUID, UUID, INTEGER, INTEGER, INTEGER)'
    ];
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        RETURN;  -- 일반 PostgreSQL: PUBLIC 회수만 적용, 앱 계정에 별도 GRANT 필요
    END IF;

    -- 함수: service_role 만 실행
    FOREACH v_fn IN ARRAY v_fns LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon, authenticated', v_fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', v_fn);
    END LOOP;

    -- 테이블: 클라이언트는 읽기만
    REVOKE ALL ON stores, party_slots, guests, applications, deposit_histories FROM anon, authenticated;
    GRANT SELECT ON party_slots TO anon;
    GRANT SELECT ON stores, party_slots, guests, applications, deposit_histories TO authenticated;
    -- 점주에게 게스트 연락처 노출을 줄이려면 stores 의 사업자번호/잔액처럼 컬럼 단위 GRANT 또는 view 사용 권장

    -- 정책 (auth.uid() 는 Supabase 에만 있으므로 존재 확인 후 동적 SQL)
    IF to_regprocedure('auth.uid()') IS NULL THEN
        RAISE WARNING 'auth.uid() not found: RLS is enabled but no client policies were created';
        RETURN;
    END IF;

    EXECUTE $p$
        CREATE POLICY slots_public_read ON party_slots FOR SELECT TO anon, authenticated
        USING (status IN ('OPEN', 'CLOSED', 'FINISHED'))
    $p$;
    EXECUTE $p$
        CREATE POLICY slots_owner_read ON party_slots FOR SELECT TO authenticated
        USING (store_id IN (SELECT id FROM stores WHERE owner_user_id = auth.uid()))
    $p$;
    EXECUTE $p$
        CREATE POLICY stores_owner_read ON stores FOR SELECT TO authenticated
        USING (owner_user_id = auth.uid())
    $p$;
    EXECUTE $p$
        CREATE POLICY guests_self_read ON guests FOR SELECT TO authenticated
        USING (user_id = auth.uid())
    $p$;
    EXECUTE $p$
        CREATE POLICY apps_guest_read ON applications FOR SELECT TO authenticated
        USING (guest_id IN (SELECT id FROM guests WHERE user_id = auth.uid()))
    $p$;
    EXECUTE $p$
        CREATE POLICY apps_owner_read ON applications FOR SELECT TO authenticated
        USING (slot_id IN (SELECT ps.id FROM party_slots ps JOIN stores s ON s.id = ps.store_id
                           WHERE s.owner_user_id = auth.uid()))
    $p$;
    EXECUTE $p$
        CREATE POLICY dh_owner_read ON deposit_histories FOR SELECT TO authenticated
        USING (store_id IN (SELECT id FROM stores WHERE owner_user_id = auth.uid()))
    $p$;
END;
$$;

COMMIT;

-- =====================================================================
-- 흐름 / 사용 예시
-- =====================================================================
-- APPLIED ─approve─▶ APPROVED ─verify_visit─▶ VISITED ─submit_mission─▶ MISSION_SUBMITTED ─complete─▶ COMPLETED
--    │                  ├─mark_noshow─▶ NOSHOW                               └─(보완요청)─▶ VISITED
--    └─reject─▶ REJECTED └─cancel_application─▶ CANCELLED (APPLIED 에서도 가능)
--
-- SELECT charge_deposit('<store>', 300000, '홍길동(을지로바)', '<admin>');
-- SELECT apply_to_slot('<slot>', '<guest>');                -- visit_code 반환 → 클라이언트에서 QR 렌더
-- SELECT approve_application('<app>', '<store>');
-- SELECT cancel_application('<app>', '<guest>');
-- SELECT verify_visit('<store>', 'K7M2QX9HPA');
-- SELECT submit_mission('<app>', '<guest>', 'https://instagram.com/p/...');
-- SELECT complete_application('<app>', '<store>', '<owner_user>');
-- SELECT mark_noshow('<app>', '<store>');
--
-- Supabase JS (서버/Edge Function, service_role 키):
--   const { data, error } = await supabase.rpc('complete_application', {
--     p_application_id: appId, p_store_id: storeId, p_actor_user_id: userId
--   });
--   if (error?.code === 'PL402') { /* 잔액 부족 → 충전 안내 */ }
