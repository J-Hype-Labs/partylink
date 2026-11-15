# 정산 대조 운영 절차서

HypeConnect의 정산은 **수동**입니다. 점주가 입금하면 관리자가 확인해 **충전**하고, 관리자가 **최종 승인**하면 수수료가 자동으로 **차감**됩니다(자동 청구 없음). 이 문서는 관리자가 **매일** 입금·충전·차감이 서로 맞는지 확인하는 절차와, 맞지 않을 때의 대응을 정합니다.

이 문서의 SQL은 모두 `SELECT`만 쓰는 **읽기 전용**이라 Supabase SQL Editor에서 실행해도 데이터가 바뀌지 않습니다. 시각은 모두 한국 시간(KST) 기준입니다.

## 1. 매일 할 일 (체크리스트)

가능하면 매일 같은 시각(예: 영업 종료 후)에 합니다. 모든 항목이 맞으면 별도 조치는 없고, 하나라도 다르면 [5. 불일치 시 대응](#5-불일치-시-대응)으로 갑니다.

- [ ] **① 오늘의 입금 확인**: 은행 입금 내역에서 점주 입금을 확인하고, 관리자 화면 **점포·적립금 → 충전**으로 반영합니다. 입금자명은 은행 표기 그대로, 메모에는 입금일이나 참고 사항을 적습니다.
- [ ] **② 충전 대조**: 아래 SQL **3.1(일자별 합계)** 과 **3.2(충전 상세)** 를 실행해, 오늘 충전 합계와 입금자명·금액이 은행 입금 내역과 일치하는지 봅니다. 입금은 있는데 충전이 없거나(누락), 충전은 있는데 입금이 없으면(과충전·오입력) 불일치입니다.
- [ ] **③ 잔액 대조**: **SQL 3.3** 에서 모든 점포의 `diff`와 `chain_breaks`가 0인지 확인합니다.
- [ ] **④ 차감 대조**: **SQL 3.4(완료 건수 × 수수료 = 차감 합계)** 의 `diff`가 모두 0인지, **SQL 3.5(이상치)** 가 **0행**인지 확인합니다.
- [ ] **⑤ 밀린 일 확인**: **SQL 3.6** 에서 `final_approval_over_48h`가 있으면 최종 승인(차감)이 밀린 신청입니다. 처리하거나 사유를 남깁니다.
- [ ] **⑥ CSV 보관(선택, 주 1회 이상 권장)**: 관리자 화면에서 점포별 **CSV 저장**을 받아 날짜별로 보관합니다([4. CSV 대조](#4-관리자-화면-csv-대조)).
- [ ] **⑦ 기록**: 불일치를 발견·보정했다면 날짜, 점포, 원인, 보정 거래 ID를 운영 기록에 남깁니다.

## 2. SQL 사용법

- 각 쿼리 맨 위 `params`의 날짜 두 개(`from_day`, `to_day`)를 대조할 날로 바꿉니다. 하루만 볼 때는 둘을 같은 날짜로 둡니다.
- 쿼리 머리(`WITH params … ledger`)는 3.1·3.2·3.4·3.5에 똑같이 들어 있습니다. 그대로 복사해 쓰면 됩니다.
- 쿼리 3.3(잔액)과 3.6(대기)은 날짜와 무관합니다.

### 테스트 기록 제외

실거래 전 점검에서 남긴 **테스트 거래**(2026-11-13 18:20경 `[E2E] 테스트 바` 점포: 충전 30,000 · 차감 10,000 · 환불 20,000, 합계 0, 거래 ID 1~3)는 일일 대조에서 빼야 합니다. 쿼리 머리의 `excluded` 가 다음 거래를 제외합니다.
- **점포 이름이 `[E2E]`로 시작하는** 점포의 모든 거래 — 차감 거래의 메모는 시스템이 자동으로 `방문 미션 승인 수수료`를 쓰기 때문에, 메모 표시가 아니라 **점포 이름**으로 걸러야 차감까지 빠집니다.
- 그 밖에 **메모 또는 입금자명이 `[E2E]`로 시작하는** 거래
- 제외된 거래에 연결된 신청도 차감 대조(3.4·3.5)에서 같이 빠집니다. (수수료 0원이라 원장 행이 없는 테스트 신청은 연결 거래가 없어 제외되지 않으니, 그런 테스트는 만들지 않거나 3.4 결과에서 눈으로 거릅니다.)
- **무엇이 제외되는지 먼저 확인하세요(SQL 3.0).** 의도한 3건(거래 ID 1·2·3)만 나와야 합니다.
- 잔액 대조(3.3)는 테스트 기록을 **빼지 않습니다.** 잔액에는 모든 거래가 반영되어 있고, 테스트의 순 변화가 0(충전 30,000 − 차감 10,000 − 환불 20,000)이라 잔액에는 영향이 없습니다.
- **앞으로의 테스트 규칙:** 테스트 점포 이름을 `[E2E]`로 시작하게 만들고, 충전·환불 메모에도 `[E2E]`를 붙이면 따로 SQL을 고치지 않아도 자동으로 제외됩니다.

## 3. 대조 SQL

### 3.0 제외되는 테스트 기록 확인
```sql
WITH params AS (
  SELECT DATE '2026-11-20' AS from_day,      -- 대조할 첫날 (한국 날짜)
         DATE '2026-11-20' AS to_day         -- 마지막 날 (포함)
), excluded AS (                             -- 대조에서 뺄 테스트 기록 (아래 '테스트 기록 제외' 참고)
  SELECT id, application_id FROM deposit_histories
   WHERE store_id IN (SELECT id FROM stores WHERE name LIKE '[E2E]%')
      OR memo LIKE '[E2E]%' OR depositor_name LIKE '[E2E]%'
), ledger AS (
  SELECT d.*, st.name AS store, timezone('Asia/Seoul', d.created_at)::date AS day
    FROM deposit_histories d JOIN stores st ON st.id = d.store_id
   WHERE d.id NOT IN (SELECT id FROM excluded)
)
SELECT '제외됨' AS note, d.id, st.name AS store, d.type, d.amount,
       timezone('Asia/Seoul', d.created_at) AS kst_time, d.depositor_name, d.memo
  FROM deposit_histories d
  JOIN stores st ON st.id = d.store_id
 WHERE d.id IN (SELECT id FROM excluded)
 ORDER BY d.id;
```

### 3.1 점포별·일자별 충전·차감·환불 합계
은행 입금 내역의 일 합계와 `charge_sum`을, 오늘 승인한 건수·금액과 `deduct_*`를 맞춰 봅니다. `net_change`는 그날 잔액 변화입니다.
```sql
WITH params AS (
  SELECT DATE '2026-11-20' AS from_day,      -- 대조할 첫날 (한국 날짜)
         DATE '2026-11-20' AS to_day         -- 마지막 날 (포함)
), excluded AS (                             -- 대조에서 뺄 테스트 기록 (아래 '테스트 기록 제외' 참고)
  SELECT id, application_id FROM deposit_histories
   WHERE store_id IN (SELECT id FROM stores WHERE name LIKE '[E2E]%')
      OR memo LIKE '[E2E]%' OR depositor_name LIKE '[E2E]%'
), ledger AS (
  SELECT d.*, st.name AS store, timezone('Asia/Seoul', d.created_at)::date AS day
    FROM deposit_histories d JOIN stores st ON st.id = d.store_id
   WHERE d.id NOT IN (SELECT id FROM excluded)
)
SELECT l.day, l.store,
       count(*) FILTER (WHERE l.type = 'CHARGE')                    AS charge_cnt,
       coalesce(sum(l.amount) FILTER (WHERE l.type = 'CHARGE'), 0)  AS charge_sum,
       count(*) FILTER (WHERE l.type = 'DEDUCT')                    AS deduct_cnt,
       coalesce(sum(l.amount) FILTER (WHERE l.type = 'DEDUCT'), 0)  AS deduct_sum,
       count(*) FILTER (WHERE l.type = 'REFUND')                    AS refund_cnt,
       coalesce(sum(l.amount) FILTER (WHERE l.type = 'REFUND'), 0)  AS refund_sum,
       coalesce(sum(CASE l.type WHEN 'CHARGE' THEN l.amount ELSE -l.amount END), 0) AS net_change
  FROM ledger l, params p
 WHERE l.day BETWEEN p.from_day AND p.to_day
 GROUP BY l.day, l.store
 ORDER BY l.day, l.store;
```

### 3.2 충전 상세 (입금 내역 대조용)
은행 입금 내역과 **입금자명·금액·시각**을 한 줄씩 맞춥니다.
```sql
WITH params AS (
  SELECT DATE '2026-11-20' AS from_day,      -- 대조할 첫날 (한국 날짜)
         DATE '2026-11-20' AS to_day         -- 마지막 날 (포함)
), excluded AS (                             -- 대조에서 뺄 테스트 기록 (아래 '테스트 기록 제외' 참고)
  SELECT id, application_id FROM deposit_histories
   WHERE store_id IN (SELECT id FROM stores WHERE name LIKE '[E2E]%')
      OR memo LIKE '[E2E]%' OR depositor_name LIKE '[E2E]%'
), ledger AS (
  SELECT d.*, st.name AS store, timezone('Asia/Seoul', d.created_at)::date AS day
    FROM deposit_histories d JOIN stores st ON st.id = d.store_id
   WHERE d.id NOT IN (SELECT id FROM excluded)
)
SELECT l.day, to_char(timezone('Asia/Seoul', l.created_at), 'HH24:MI') AS kst_time,
       l.store, l.depositor_name, l.amount, l.memo, l.id AS ledger_id
  FROM ledger l, params p
 WHERE l.type = 'CHARGE' AND l.day BETWEEN p.from_day AND p.to_day
 ORDER BY l.day, l.created_at;
```

### 3.3 잔액 = 원장 합계 (`diff`·`chain_breaks`가 모두 0)
`diff`는 점포 잔액과 원장 합계의 차이, `chain_breaks`는 원장 각 줄의 '변경 전 잔액'이 직전 줄의 '변경 후 잔액'과 이어지지 않는 횟수입니다.
```sql
-- 테스트 기록을 빼지 않습니다(잔액은 모든 거래가 반영된 값이기 때문). 모든 줄의 diff 와 chain_breaks 가 0 이어야 합니다.
WITH chain AS (
  SELECT store_id, id, balance_before,
         lag(balance_after) OVER (PARTITION BY store_id ORDER BY id) AS prev_after
    FROM deposit_histories
)
SELECT st.name AS store, st.prepaid_balance,
       coalesce(sum(CASE d.type WHEN 'CHARGE' THEN d.amount ELSE -d.amount END), 0) AS ledger_balance,
       st.prepaid_balance - coalesce(sum(CASE d.type WHEN 'CHARGE' THEN d.amount ELSE -d.amount END), 0) AS diff,
       (SELECT count(*) FROM chain c WHERE c.store_id = st.id AND c.balance_before <> coalesce(c.prev_after, 0)) AS chain_breaks
  FROM stores st
  LEFT JOIN deposit_histories d ON d.store_id = st.id
 GROUP BY st.id
 ORDER BY st.name;
```

### 3.4 완료 신청 수 × 수수료 = 차감 합계 (`diff`가 모두 0)
수수료는 선정 시점에 저장된 `applications.fee_amount`이고, 완료(최종 승인)할 때 같은 금액이 원장에 `DEDUCT`로 한 번 기록됩니다. 수수료 0원 신청은 `completed`에는 들어가지만 원장 행이 없습니다(`fee_applications`와의 차이). 그래서 **건수는 달라도 금액 합은 같습니다.**
```sql
WITH params AS (
  SELECT DATE '2026-11-20' AS from_day,      -- 대조할 첫날 (한국 날짜)
         DATE '2026-11-20' AS to_day         -- 마지막 날 (포함)
), excluded AS (                             -- 대조에서 뺄 테스트 기록 (아래 '테스트 기록 제외' 참고)
  SELECT id, application_id FROM deposit_histories
   WHERE store_id IN (SELECT id FROM stores WHERE name LIKE '[E2E]%')
      OR memo LIKE '[E2E]%' OR depositor_name LIKE '[E2E]%'
), ledger AS (
  SELECT d.*, st.name AS store, timezone('Asia/Seoul', d.created_at)::date AS day
    FROM deposit_histories d JOIN stores st ON st.id = d.store_id
   WHERE d.id NOT IN (SELECT id FROM excluded)
)
SELECT timezone('Asia/Seoul', a.completed_at)::date AS day, st.name AS store,
       count(*)                                  AS completed,
       count(*) FILTER (WHERE a.fee_amount > 0)  AS fee_applications,
       coalesce(sum(a.fee_amount), 0)            AS fee_sum,
       coalesce(sum(d.amount), 0)                AS ledger_deduct_sum,
       coalesce(sum(a.fee_amount), 0) - coalesce(sum(d.amount), 0) AS diff
  FROM applications a
  JOIN party_slots ps ON ps.id = a.slot_id
  JOIN stores st      ON st.id = ps.store_id
  LEFT JOIN deposit_histories d ON d.application_id = a.id AND d.type = 'DEDUCT'
  CROSS JOIN params p
 WHERE a.status = 'COMPLETED'
   AND a.id NOT IN (SELECT application_id FROM excluded WHERE application_id IS NOT NULL)
   AND timezone('Asia/Seoul', a.completed_at)::date BETWEEN p.from_day AND p.to_day
 GROUP BY 1, 2
 ORDER BY 1, 2;
```

### 3.5 이상치 탐지 (0행이어야 함)
| anomaly | 의미 |
|---|---|
| 완료인데 차감 없음 | 수수료가 있는 신청이 `COMPLETED`인데 `DEDUCT`가 없음 |
| 완료 아닌데 차감 있음 | `DEDUCT`가 있는데 신청이 `COMPLETED`가 아님 |
| 차감 금액 ≠ 신청 수수료 | `amount` 열에 차이(원장 − 수수료)가 나옴 |
| 신청의 원장 연결 불일치 | 신청이 가리키는 원장 행이 실제 차감 행과 다름 |
| 다른 점포에 차감됨 | 신청의 점포와 차감된 점포가 다름 |

```sql
WITH params AS (
  SELECT DATE '2026-11-20' AS from_day,      -- 대조할 첫날 (한국 날짜)
         DATE '2026-11-20' AS to_day         -- 마지막 날 (포함)
), excluded AS (                             -- 대조에서 뺄 테스트 기록 (아래 '테스트 기록 제외' 참고)
  SELECT id, application_id FROM deposit_histories
   WHERE store_id IN (SELECT id FROM stores WHERE name LIKE '[E2E]%')
      OR memo LIKE '[E2E]%' OR depositor_name LIKE '[E2E]%'
), ledger AS (
  SELECT d.*, st.name AS store, timezone('Asia/Seoul', d.created_at)::date AS day
    FROM deposit_histories d JOIN stores st ON st.id = d.store_id
   WHERE d.id NOT IN (SELECT id FROM excluded)
)
SELECT '완료인데 차감 없음' AS anomaly, st.name AS store, a.id AS application_id, a.fee_amount AS amount, NULL::bigint AS ledger_id
  FROM applications a
  JOIN party_slots ps ON ps.id = a.slot_id
  JOIN stores st      ON st.id = ps.store_id
 WHERE a.status = 'COMPLETED' AND a.fee_amount > 0
   AND a.id NOT IN (SELECT application_id FROM excluded WHERE application_id IS NOT NULL)
   AND NOT EXISTS (SELECT 1 FROM deposit_histories d WHERE d.application_id = a.id AND d.type = 'DEDUCT')
UNION ALL
SELECT '완료 아닌데 차감 있음', l.store, l.application_id, l.amount, l.id
  FROM ledger l
  JOIN applications a ON a.id = l.application_id
 WHERE l.type = 'DEDUCT' AND a.status <> 'COMPLETED'
UNION ALL
SELECT '차감 금액 ≠ 신청 수수료', l.store, l.application_id, l.amount - a.fee_amount, l.id
  FROM ledger l
  JOIN applications a ON a.id = l.application_id
 WHERE l.type = 'DEDUCT' AND l.amount <> a.fee_amount
UNION ALL
SELECT '신청의 원장 연결 불일치', l.store, l.application_id, l.amount, l.id
  FROM ledger l
  JOIN applications a ON a.id = l.application_id
 WHERE l.type = 'DEDUCT' AND a.status = 'COMPLETED' AND a.deposit_history_id IS DISTINCT FROM l.id
UNION ALL
SELECT '다른 점포에 차감됨', l.store, l.application_id, l.amount, l.id
  FROM ledger l
  JOIN applications a  ON a.id = l.application_id
  JOIN party_slots ps  ON ps.id = a.slot_id
 WHERE l.type = 'DEDUCT' AND ps.store_id <> l.store_id;
```

### 3.6 처리 대기 (오늘 할 일)
```sql
-- 처리 대기 (이상치가 아니라 '오늘 할 일'입니다). 정산이 밀리지 않았는지 봅니다.
SELECT st.name AS store,
       count(*) FILTER (WHERE a.status = 'APPLIED')                                              AS waiting_selection,
       count(*) FILTER (WHERE a.status = 'MISSION_SUBMITTED')                                    AS waiting_final_approval,
       count(*) FILTER (WHERE a.status = 'MISSION_SUBMITTED' AND a.updated_at < now() - interval '48 hours') AS final_approval_over_48h,
       st.prepaid_balance
  FROM applications a
  JOIN party_slots ps ON ps.id = a.slot_id
  JOIN stores st      ON st.id = ps.store_id
 WHERE a.status IN ('APPLIED', 'MISSION_SUBMITTED') AND st.name NOT LIKE '[E2E]%'
 GROUP BY st.id
 ORDER BY final_approval_over_48h DESC, st.name;
```

### (월말) 점포·월별 요약
월말 수동 정산 전에 한 달 전체를 한 번에 맞춰 볼 때 씁니다. 3.4와 같은 기준을 월 단위로 묶은 것이며 날짜 매개변수가 필요 없습니다. 이 월별 SQL은 테스트 기록을 빼지 않지만, 신청과 원장 양쪽에 똑같이 들어가므로 `diff`에는 영향이 없습니다(건수·합계에는 테스트가 포함됩니다). 월 완료 신청이 500건 가까이 되면 관리자 화면의 **업체별 수수료 집계**는 최근 500건만 읽으므로, 화면 숫자 대신 이 SQL을 기준으로 삼으세요.

**월별: 신청 합계 vs 원장 합계 (`diff`가 모두 0)**

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


**월별: 점포 잔액 = 충전 − 차감 − 환불 (`diff`가 모두 0)**

```sql
SELECT st.name, st.prepaid_balance,
       coalesce(sum(CASE d.type WHEN 'CHARGE' THEN d.amount ELSE -d.amount END), 0) AS ledger_balance,
       st.prepaid_balance - coalesce(sum(CASE d.type WHEN 'CHARGE' THEN d.amount ELSE -d.amount END), 0) AS diff
  FROM stores st
  LEFT JOIN deposit_histories d ON d.store_id = st.id
 GROUP BY st.id
 ORDER BY st.name;
```


## 4. 관리자 화면 CSV 대조

관리자 화면 **점포·적립금 → 점포 카드 → CSV 저장** 으로 점포별 원장을 내려받습니다(파일 이름 `hypeconnect-ledger-<점포>-<YYYYMMDD>.csv`, UTF-8, 엑셀에서 한글이 깨지지 않음).

- 열: `일시(KST)`, `점포`, `구분`(충전/차감/환불), `금액`, `변경 전 잔액`, `변경 후 잔액`, `입금자명`, `메모`, `신청 ID`, `거래 ID`. 오래된 순입니다.
- **최근 500건까지만** 담깁니다. 저장할 때 500건이면 안내가 나오는데, 이때는 CSV가 일부일 수 있으니 날짜별 합계는 **SQL 3.1을 기준**으로 삼습니다.

대조 방법:
1. CSV를 열어 **일시**의 날짜로 필터 → `구분`별로 `금액`을 합산합니다. 이 값이 SQL 3.1의 해당 점포·날짜의 `charge_sum` / `deduct_sum` / `refund_sum`과 같아야 합니다.
2. **`거래 ID`**는 SQL의 `ledger_id`(3.2) 및 원장 `id`와 같은 번호입니다. 한 줄씩 어긋나는 거래를 찾을 때 씁니다.
3. 마지막 줄의 `변경 후 잔액`이 관리자 화면(점포 카드)의 현재 **잔액**과 같아야 합니다.
4. CSV는 점포별 파일이라 `[E2E] 테스트 바` 점포의 파일만 테스트 거래입니다. 실제 점포 파일에는 테스트 거래가 없으니 그대로 대조하면 됩니다(SQL은 `excluded`가 자동으로 뺌).
5. `입금자명`·`금액`을 은행 입금 내역과 대조해 3.2와 같은 결론이 나오는지 확인합니다. 엑셀에서 수식 문자로 시작하는 글자(`=`, `+`, `-`, `@`)는 앞에 `'`가 붙어 보일 수 있으며 정상입니다.

## 5. 불일치 시 대응

**원장은 수정·삭제할 수 없습니다**(데이터베이스가 막습니다). 잘못된 기록은 지우지 않고, **반대 방향 거래(환불·충전)로 보정**하고 이유를 메모에 남깁니다. 장부를 직접 고치는 SQL은 절대 실행하지 않습니다.

| 상황 | 원인 예 | 대응 |
|---|---|---|
| 입금은 있는데 충전이 없음 | 충전을 잊음 | 해당 점포에 **충전**(입금자명은 은행 표기, 메모에 `[보정]` 규칙) |
| 충전은 있는데 입금이 없음 | 입금 확인 전 충전, 다른 점포에 충전 | 입금이 확인되지 않으면 같은 금액을 **환불**로 정정(메모에 `[정정]`). 다른 점포로 잘못 충전했다면 그 점포에서 환불하고 맞는 점포에 충전 |
| 금액을 잘못 입력해 충전 | 오타 | **차액만큼** 환불(적게 충전했으면 차액을 충전) |
| 환불을 잘못 입력 | 오타·점포 착오 | 같은 금액을 **충전**(입금자명에 `정정`을 쓰고 메모에 원 거래 ID) |
| 잔액이 부족해 환불할 수 없음 | 이미 차감됨 | 보정 불가. 점주와 협의하고, 아래 개발 담당 전달 내용과 함께 기록 |
| 3.3 `diff`·`chain_breaks`가 0이 아님 | 시스템 이상 | 직접 고치지 말고 **개발 담당(BACK)** 에 전달 |
| 3.4 `diff` 또는 3.5 이상치 | 시스템 이상(차감은 최종 승인으로만 생기므로 사람이 만들 수 없음) | **개발 담당(BACK)** 에 전달. 신청 ID·거래 ID·SQL 결과를 함께 보냄 |

개발 담당에게 전달할 내용: 확인한 날짜, 실행한 SQL 이름(예: 3.5), 결과 행 전체(신청 ID·거래 ID 포함), 이미 한 보정 거래 ID.

### 메모 규칙
정정·보정 거래는 메모(최대 500자)에 아래 형식을 지킵니다. 나중에 원장만 보고도 이유를 알 수 있어야 합니다.

`[보정|정정] YYYY-MM-DD 원 거래 ID #123 사유 / 담당자 이니셜`

- `[보정]`: 누락된 거래를 채움. `[정정]`: 잘못 들어간 거래를 되돌림. `[E2E]`: 점검용 테스트 거래.
- 실제 송금이 없는 **장부상 정정 환불**이면 메모에 `송금 없음`을 적어 두세요. 환불 거래만으로는 실제 송금 여부를 알 수 없습니다.
- 보정한 날에는 3.1·3.3·3.4를 다시 실행해 맞는지 확인합니다.

## 왜 일치해야 하나
- 차감 원장(`DEDUCT`)은 `complete_application` 한 곳에서만 기록되고, 금액은 선정 시점에 저장된 `applications.fee_amount`(스냅샷)입니다.
- 원장 기록과 `completed_at`은 같은 트랜잭션이라 같은 시각입니다. 그래서 화면(완료 시각 기준 월)과 원장(기록 시각 기준 월)의 월이 같습니다.
- 신청당 차감은 1번만 가능합니다(`DEDUCT` 유니크 인덱스, 중복 승인은 `PL409`).
- 수수료 0원 신청은 완료 건수에는 포함되지만 원장 행은 없습니다. 그래서 **건수는 달라도 금액 합은 같습니다.**

## 검증 기록
- 2026-11-10: 로컬 Postgres(프로덕션 아님)에 마이그레이션을 모두 적용하고 점포 2곳·신청 5건(수수료 10,000 / 12,000 / 0 / 5,000, 잔액 부족 1건)으로 `complete_application`을 실행했습니다. 화면 방식의 집계와 원장이 점포별·월별로 일치했고(합계 27,000원), 잔액 부족은 `PL402`, 중복 승인은 `PL409`로 막혔습니다.
- 프로덕션에는 아직 완료된 신청이 없어(파티 0개) 실데이터 검증은 첫 정산 전에 위 SQL로 하면 됩니다.
