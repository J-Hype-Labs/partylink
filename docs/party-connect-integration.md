# party-connect-mvp ↔ PartyLink DB 연동 가이드 (카카오 로그인)

웹사이트 [party-connect-mvp](https://github.com/J-Hype-Labs/party-connect-mvp)의 카카오 로그인과 체험단 신청을 이 저장소의 DB에 연결하는 방법입니다.

## 구조

```
[GitHub Pages 웹사이트]                [Supabase Edge Function]              [Postgres]
 party-connect-mvp/index.html   ──▶   partylink-api                 ──▶   SQL 함수
  - supabase-js 로 카카오 로그인        - 로그인 토큰 검증 (auth.getUser)        list_open_parties
  - anon 키만 보유                     - 토큰의 user id 로 게스트 식별           upsert_guest_profile
                                      - service_role 로 DB 함수 호출           apply_to_slot / cancel_application
                                                                             guest_applications
```

- 브라우저에는 **anon(publishable) 키만** 들어갑니다. service_role 키는 Edge Function 안에만 있습니다.
- 게스트는 요청 body가 아니라 **카카오 로그인 토큰**으로 식별합니다. 다른 사람 이름으로 신청할 수 없습니다.
- 카카오는 전화번호를 기본으로 주지 않기 때문에, 첫 신청 때 입력한 이름·연락처로 `guests` 프로필을 만들고 이후 신청할 때마다 갱신합니다.

## API

| 메서드 | 경로 | 로그인 | 설명 |
|---|---|---|---|
| GET | `/functions/v1/partylink-api/parties` | 불필요 | 모집 중인 파티 목록 (웹 카드 형태) |
| GET | `/functions/v1/partylink-api/applications` | 필요 | 내 신청 내역 (선정 시 방문 코드 포함) |
| POST | `/functions/v1/partylink-api/applications` | 필요 | 신청 `{ slotId, name, phone, agree }` |
| POST | `/functions/v1/partylink-api/applications/:id/cancel` | 필요 | 신청 취소 (파티 시작 전) |

에러는 `{ code, message }` 형태로 오고, `message`는 화면에 그대로 보여 줄 수 있는 한국어 문장입니다.

---

## 설정 순서

### 1. DB 마이그레이션 적용

Supabase SQL Editor에서 아래 파일 전체를 실행합니다. (v2 스키마가 이미 설치돼 있어야 합니다.)

```
supabase/migrations/20261106000000_party_connect_integration.sql
```

### 2. 카카오 디벨로퍼스 설정 — https://developers.kakao.com

1. **내 애플리케이션 → 애플리케이션 추가하기**로 앱을 만듭니다.
2. **앱 설정 → 플랫폼 → Web**에 사이트 도메인을 등록합니다.
   - `https://j-hype-labs.github.io`
   - (로컬 테스트용) `http://localhost:3000`
3. **제품 설정 → 카카오 로그인**
   - 활성화 설정을 **ON**으로 합니다.
   - **Redirect URI**에 `https://<프로젝트ref>.supabase.co/auth/v1/callback`을 추가합니다. (Supabase 대시보드 → Authentication → Providers → Kakao 화면에 정확한 주소가 나옵니다.)
4. **제품 설정 → 카카오 로그인 → 동의항목**
   - 닉네임, 프로필 사진: 필수 또는 선택 동의
   - 카카오계정(이메일): 비즈 앱이어야 설정할 수 있습니다. 비즈 앱이 아니면 6단계의 "이메일 없는 사용자 허용"을 켜세요.
5. **제품 설정 → 카카오 로그인 → 보안**에서 **Client Secret**을 생성하고 활성화합니다.
6. **앱 설정 → 앱 키**에서 **REST API 키**를 확인합니다.

### 3. Supabase Auth 설정

1. **Authentication → Providers → Kakao**
   - Enable: ON
   - **REST API Key**: 2-6의 REST API 키
   - **Client Secret Code**: 2-5의 Client Secret
   - 이메일 동의항목을 못 쓰는 경우: **Allow users without an email** ON
2. **Authentication → URL Configuration**
   - **Site URL**: `https://j-hype-labs.github.io/party-connect-mvp/`
   - **Redirect URLs**: `https://j-hype-labs.github.io/party-connect-mvp/**`, `http://localhost:3000/**`

### 4. Edge Function 배포 (Supabase CLI)

```bash
supabase login
```

```bash
supabase link --project-ref <프로젝트ref>
```

```bash
supabase functions deploy partylink-api --no-verify-jwt
```

```bash
supabase secrets set ALLOWED_ORIGINS=https://j-hype-labs.github.io,http://localhost:3000
```

- `--no-verify-jwt`: 로그인하지 않은 사용자도 파티 목록을 볼 수 있도록 게이트웨이의 JWT 검사를 끕니다. 로그인이 필요한 경로는 함수 안에서 토큰을 직접 검증합니다.
- `SUPABASE_URL`과 `SUPABASE_SERVICE_ROLE_KEY`는 Supabase가 자동으로 넣어 주므로 따로 설정하지 않습니다.

### 5. 웹사이트 설정

`party-connect-mvp/index.html`의 `window.PARTYLINK_CONFIG`에 두 값을 넣습니다.

```js
window.PARTYLINK_CONFIG = {
  supabaseUrl: "https://<프로젝트ref>.supabase.co",
  supabaseAnonKey: "<anon 또는 publishable 키>",   // ⚠️ service_role 키 금지
};
```

**실서비스 모드**는 아래 조건에서 켜집니다.

| 상황 | 모드 |
|---|---|
| 두 값이 비어 있음 | 데모 (기존 localStorage 동작) |
| 배포 사이트 (github.io) | 실서비스 |
| localhost | 데모 (CI E2E 테스트 보호) |
| localhost + `?live=1` | 실서비스 (로컬 연동 테스트) |
| 어디서든 `?demo=1` | 데모 강제 |

### 6. 파티 등록 (임시: SQL)

관리자 화면은 아직 localStorage 기반이므로, 실서비스 파티는 SQL로 등록합니다.

```sql
-- 점포 (점주 카카오 로그인 후 auth.users.id 를 owner_user_id 로)
INSERT INTO stores (owner_user_id, name, business_reg_no, owner_name, phone, address, region)
VALUES ('<점주 user id>', '43번지 혼술바', '123-45-67890', '홍길동', '01012345678',
        '서울 중구 을지로11길 19', '명동/을지로')
RETURNING id;

-- 파티 (region 은 웹 지역 필터 값과 같게: '명동/을지로', '홍대/마포' …)
INSERT INTO party_slots (store_id, title, description, benefit, starts_at, ends_at, recruit_deadline,
                         capacity, status, category, images, badges, is_featured)
VALUES ('<store id>', '[을지로] 금요 혼술 파티', '퇴근 후 가볍게 한잔!', '하이볼 2잔 + 안주',
        '2026-11-13 19:00+09', '2026-11-13 22:00+09', '2026-11-12 23:59+09',
        6, 'OPEN', '혼술바', ARRAY['https://…/photo.jpg'], ARRAY['NEW'], false);
```

선정, 방문 인증, 승인(수수료 차감)은 기존 함수(`approve_application`, `verify_visit`, `complete_application` 등)를 사용합니다.

---

## 테스트

```bash
deno test --allow-env supabase/functions/partylink-api/handler_test.ts
```

## 현재 범위와 남은 일

- ✅ 카카오 로그인 (Supabase Auth), 파티 목록, 신청, 취소, 내 신청 내역(상태·방문 코드)
- ⏳ 네이버 로그인: Supabase에 기본 Naver 제공자가 없어 별도 구현이 필요합니다. 실서비스 모드에서는 "준비 중"으로 안내합니다.
- ⏳ 관리자 화면(파티·신청·후기 관리)은 아직 localStorage 기반입니다. 실서비스 데이터는 Supabase 대시보드나 SQL로 관리합니다.
- ⏳ 점주용 화면(선정, QR 방문 인증, 미션 승인)
- ⏳ 찜하기, 후기, 알림은 브라우저 localStorage에만 저장됩니다.
