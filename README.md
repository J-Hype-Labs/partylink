# PartyLink (파티링크) — Database

혼술바 점주와 파티 게스트를 연결하고, 방문 미션 승인 시 점주의 선불 적립금에서 인당 수수료를 차감하는 플랫폼의 PostgreSQL / Supabase 스키마입니다.

## 구조

```
supabase/migrations/20261105000000_partylink_schema_v2.sql   스키마 v2 (테이블, ENUM, 트리거, 업무 함수, RLS)
scripts/reset_dev_only.sql                                   ⚠️ 개발용 초기화 — 파티링크 테이블/데이터 전부 삭제
```

## 적용 방법

**Supabase 대시보드:** SQL Editor에 마이그레이션 파일 전체를 붙여 넣고 실행합니다.

**Supabase CLI:**

```bash
supabase link --project-ref <project-ref>
supabase db push
```

이미 v1 스키마가 있는 개발 DB라면 `scripts/reset_dev_only.sql`을 먼저 실행합니다. (데이터가 삭제되므로 운영 DB에는 사용 금지)

설치 확인 쿼리 — 결과가 `5 / 5 / 7 / 10`이면 정상입니다.

```sql
SELECT
  (SELECT count(*) FROM pg_tables WHERE schemaname='public'
     AND tablename IN ('stores','party_slots','guests','applications','deposit_histories')) AS tables,
  (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND rowsecurity
     AND tablename IN ('stores','party_slots','guests','applications','deposit_histories')) AS rls_on,
  (SELECT count(*) FROM pg_policies WHERE schemaname='public') AS policies,
  (SELECT count(*) FROM pg_proc WHERE proname IN ('apply_to_slot','approve_application','reject_application',
     'cancel_application','verify_visit','submit_mission','complete_application',
     'charge_deposit','refund_deposit','mark_noshow')) AS functions;
```

## 테이블

| 테이블 | 내용 |
|---|---|
| `stores` | 점주/업체, 선불 적립금 `prepaid_balance` |
| `party_slots` | 파티 일정, 정원, 혜택, 미션 조건, 인당 수수료 |
| `guests` | 게스트 인적사항, SNS, 노쇼/벌점, 차단 |
| `applications` | 신청, 방문 코드, 미션 URL, 상태, 정산 |
| `deposit_histories` | 적립금 충전/차감/환불 원장 (append-only) |

## 신청 상태 흐름

```
APPLIED ─approve─▶ APPROVED ─verify_visit─▶ VISITED ─submit_mission─▶ MISSION_SUBMITTED ─complete─▶ COMPLETED
   │                  ├─mark_noshow─▶ NOSHOW                               └─(보완 요청)─▶ VISITED
   └─reject─▶ REJECTED └─cancel─▶ CANCELLED   (APPLIED에서도 cancel 가능)
```

정의되지 않은 전이와, `complete_application()` 밖에서 `COMPLETED`로 바꾸는 것은 트리거가 막습니다.

## 업무 함수

모든 함수는 `service_role`(서버)만 실행할 수 있습니다. `store_id` / `guest_id`는 클라이언트 입력이 아니라 **서버가 로그인 세션에서 조회한 값**을 넘겨야 합니다.

| 함수 | 호출 주체 | 설명 |
|---|---|---|
| `apply_to_slot(slot, guest)` | 게스트 | 신청 (모집 상태·마감·차단 검사), `visit_code` 반환 |
| `approve_application(app, store)` | 점주 | 선정 (정원 검사, 수수료 스냅샷) |
| `reject_application(app, store, reason)` | 점주 | 반려 |
| `cancel_application(app, guest)` | 게스트 | 파티 시작 전 취소 |
| `verify_visit(store, code)` | 점주 | 방문 코드/QR 인증 (파티 시간대에만) |
| `submit_mission(app, guest, url)` | 게스트 | 리뷰 미션 URL 제출 |
| `complete_application(app, store, actor)` | 점주 | **최종 승인 → 잔액 검증 + 차감 + 원장 기록 (원자적)** |
| `mark_noshow(app, store, ...)` | 점주 | 노쇼 + 벌점, 기준 초과 시 30일 자동 차단 |
| `charge_deposit(store, amount, depositor, ...)` | 관리자 | 입금 확인 후 충전 |
| `refund_deposit(store, amount, ...)` | 관리자 | 잔액 환불 |

## 에러 코드 (SQLSTATE)

| 코드 | 의미 |
|---|---|
| `PL400` | 잘못된 입력 / 허용되지 않은 직접 수정 |
| `PL402` | 적립금 잔액 부족 (`details`에 `{balance, required, shortage}`) |
| `PL403` | 권한 없음 (다른 점포/게스트의 건) |
| `PL404` | 대상 없음 (잘못된 방문 코드 포함) |
| `PL409` | 상태 전이 불가 / 중복 신청 |
| `PL410` | 모집 마감 / 정원 초과 / 허용 시간 외 |
| `PL423` | 차단된 게스트 |

## 보안 / 정합성 요약

- 5개 테이블 모두 RLS 활성화. `anon`은 공개 파티 조회만, `authenticated`는 본인 데이터 조회만 가능, 쓰기는 불가.
- `prepaid_balance`는 원장 함수에서만 변경 가능, `deposit_histories`는 UPDATE/DELETE/TRUNCATE 차단.
- 수수료는 선정 시점에 `applications.fee_amount`로 고정되어, 이후 슬롯 수수료를 바꿔도 정산 금액은 바뀌지 않음.
- 차단: `is_blocked` = 관리자 수동 차단(영구), `blocked_until` = 벌점 누적 자동 차단(기간 만료 시 해제).

## TODO

- [ ] 정기 작업: 마감된 슬롯 `CLOSED` / 종료된 파티 `FINISHED` 전환, 미션 제출 후 N일 경과 시 자동 승인
- [ ] 점주용 지원자 목록 view (연락처 제외)
- [ ] 백엔드 API 연동
