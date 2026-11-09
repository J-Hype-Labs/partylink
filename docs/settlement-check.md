# 정산 교차 검증 (읽기 전용)

관리자 화면 **점포·적립금 → 업체별 수수료 집계**의 숫자가 적립금 원장(`deposit_histories`)과 일치하는지 확인하는 SQL입니다. 모두 `SELECT`만 쓰므로 Supabase SQL Editor에서 실행해도 데이터가 바뀌지 않습니다. 정산(수동)을 하기 전에 돌려 보세요.

## 왜 일치해야 하나
- 차감 원장(`DEDUCT`)은 `complete_application` 한 곳에서만 기록되고, 금액은 선정 시점에 저장된 `applications.fee_amount`(스냅샷)입니다.
- 원장 기록과 `completed_at`은 같은 트랜잭션이라 같은 시각입니다. 그래서 화면(완료 시각 기준 월)과 원장(기록 시각 기준 월)의 월이 같습니다.
- 신청당 차감은 1번만 가능합니다(`DEDUCT` 유니크 인덱스, 중복 승인은 `PL409`).
- 수수료 0원 신청은 완료 건수에는 포함되지만 원장 행은 없습니다. 그래서 **건수는 달라도 금액 합은 같습니다.**

## 1) 점포·월별 차감 합계: 신청 vs 원장 (`diff`가 모두 0이어야 함)
```sql
SELECT st.name AS store,
       to_char(timezone('Asia/Seoul', a.completed_at), 'YYYY-MM') AS month,
       count(*)                           AS completed,
       sum(a.fee_amount)                  AS application_fee_sum,
       sum(coalesce(d.amount, 0))         AS ledger_deduct_sum,
       sum(a.fee_amount) - sum(coalesce(d.amount, 0)) AS diff
  FROM applications a
  JOIN party_slots ps ON ps.id = a.slot_id
  JOIN stores st      ON st.id = ps.store_id
  LEFT JOIN deposit_histories d ON d.application_id = a.id AND d.type = 'DEDUCT'
 WHERE a.status = 'COMPLETED'
 GROUP BY st.name, 2
 ORDER BY 2 DESC, 1;
```

## 2) 점포 잔액 = 충전 − 차감 − 환불 (`diff`가 모두 0이어야 함)
```sql
SELECT st.name, st.prepaid_balance,
       coalesce(sum(CASE d.type WHEN 'CHARGE' THEN d.amount ELSE -d.amount END), 0) AS ledger_balance,
       st.prepaid_balance - coalesce(sum(CASE d.type WHEN 'CHARGE' THEN d.amount ELSE -d.amount END), 0) AS diff
  FROM stores st
  LEFT JOIN deposit_histories d ON d.store_id = st.id
 GROUP BY st.id
 ORDER BY st.name;
```

## 검증 기록
- 2026-11-10: 로컬 Postgres(프로덕션 아님)에 마이그레이션을 모두 적용하고 점포 2곳·신청 5건(수수료 10,000 / 12,000 / 0 / 5,000, 잔액 부족 1건)으로 `complete_application`을 실행했습니다. 화면 방식의 집계와 원장이 점포별·월별로 일치했고(합계 27,000원), 잔액 부족은 `PL402`, 중복 승인은 `PL409`로 막혔습니다.
- 프로덕션에는 아직 완료된 신청이 없어(파티 0개) 실데이터 검증은 첫 정산 전에 위 SQL로 하면 됩니다.
