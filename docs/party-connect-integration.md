# HypeConnect 웹 ↔ PartyLink DB 연동 가이드

- 기준일: 2026-11-08
- 프런트엔드 저장소: https://github.com/J-Hype-Labs/party-connect-mvp
- 백엔드 저장소: https://github.com/J-Hype-Labs/partylink
- 관련 백엔드 PR: https://github.com/J-Hype-Labs/partylink/pull/1
- 프런트엔드 인증 상세: https://github.com/J-Hype-Labs/party-connect-mvp/blob/main/docs/AUTH_IMPLEMENTATION_SPEC.md

이 문서는 HypeConnect의 Kakao OAuth/Supabase Auth와 PartyLink DB API의 연동 계약 및 배포 순서를 설명한다. 현재 문서에 적힌 코드/설정이 운영 Supabase에 배포되었다는 뜻은 아니다.

## 1. 현재 상태

- Edge Function 및 웹 연동 migration은 feature/party-connect-integration 브랜치의 PR #1에 있다.
- PR #1은 2026-11-08 기준 OPEN이다.
- 프런트엔드 main에는 Supabase Auth PKCE 호출과 Edge Function 호출 코드가 있으나 PARTYLINK_CONFIG의 URL/공개 키가 비어 있다.
- 실제 Kakao OAuth, 실제 DB 저장·조회·취소는 검증되지 않았다.
- 관리자 화면은 별도 작업이며 현재 프런트엔드 하드코딩 비밀번호를 운영 권한으로 사용해서는 안 된다.

## 2. 아키텍처

브라우저:
- Kakao OAuth 시작은 Supabase Auth client를 사용한다.
- 브라우저에는 Supabase 공개용 publishable/anon key만 둔다.
- service_role key와 Kakao Client Secret은 절대 포함하지 않는다.

인증:
1. 사용자가 Kakao 로그인 버튼을 누른다.
2. Supabase Auth가 Kakao provider로 인증을 시작한다.
3. Kakao는 Supabase Auth callback으로 인가 결과를 반환한다.
4. Supabase Auth가 세션을 생성하고 브라우저 앱으로 복귀시킨다.
5. Edge Function은 Authorization Bearer token을 auth.getUser로 검증한다.
6. 검증된 auth.users.id로 게스트 프로필과 신청 데이터를 연결한다.

사용자 ID를 요청 body에서 받거나 브라우저가 지정한 guest_id를 신뢰하지 않는다.

## 3. API 계약

| 메서드 | 경로 | 로그인 | 설명 |
|---|---|---|---|
| GET | /functions/v1/partylink-api/parties | 불필요 | 모집 중인 파티 목록 |
| GET | /functions/v1/partylink-api/me | 필요 | 내 프로필·가입 동의 여부. 응답은 아래 "가입 동의 API" 참고 |
| POST | /functions/v1/partylink-api/me/onboarding | 필요 | 가입 동의 저장 `{ agreeTerms: true, agreePrivacy: true, agreeMarketing?: boolean, termsVersion?: string }`. 응답은 `GET /me`와 같음 |
| GET | /functions/v1/partylink-api/applications | 필요 | 현재 회원의 신청 내역. 마이페이지용 필드: `id, partyId, partyTitle, venue, day, startsAt, status, visitCode, rejectReason, missionUrl(마지막 제출 URL|null), approvedAt, visitedAt, name, phone, appliedAt, userId`. 보완 요청되면 `status`는 `VISITED`로 돌아가고 `missionUrl`에 이전 제출값이 남으므로 `status==='VISITED' && missionUrl` 이면 "보완 요청됨" |
| POST | /functions/v1/partylink-api/applications | 필요 | 신청: slotId, name, phone, agree |
| POST | /functions/v1/partylink-api/applications/:id/cancel | 필요 | 본인 신청 취소 |
| POST | /functions/v1/partylink-api/applications/:id/mission | 필요 | 미션 URL 제출 `{ url }` (방문 인증 후, 보완 요청 시 재제출) |

응답 오류는 code와 한국어 message를 포함한다. 화면은 빈 목록과 API 오류를 구분한다.

현재 handler는 첫 신청 시 이름·연락처 등으로 guests 프로필을 upsert하고 auth user ID에 연결한다. Kakao 이메일은 제공되지 않을 수 있으므로 필수 식별자로 사용하지 않는다.

### 가입 동의 API (`GET /me`, `POST /me/onboarding`)

동의 기록은 `user_consents` 테이블(마이그레이션 `20261111000000_user_consents.sql`)에 `(user_id, terms_version)` 단위로 저장한다. 서비스 이용약관·개인정보 수집·이용은 필수, 마케팅 수신은 선택이다. 브라우저 localStorage만으로 가입 완료를 판정하지 않는다.

`GET /me` 응답 (로그인 필요, 401이면 로그인 만료):

```json
{
  "id": "<auth user id>", "email": "…|null", "nickname": "…|null", "avatarUrl": "…|null",
  "termsVersion": "2026-11-10",
  "onboardingComplete": false,
  "consent": null,
  "guest": null
}
```

- `termsVersion`: 지금 동의받아야 하는 약관 버전. 이 버전에 동의한 기록이 있어야 `onboardingComplete`가 true다(약관 버전이 오르면 기존 회원도 다시 false가 되어 재동의를 받는다).
- `consent`: 동의했으면 `{ termsVersion, agreeTerms, agreePrivacy, agreeMarketing, consentedAt, marketingChangedAt }`, 아니면 `null`.
- `guest`: 첫 신청 전에는 `null`, 신청한 뒤에는 `{ name, phone }`.

`POST /me/onboarding` 요청 본문은 `{ agreeTerms: true, agreePrivacy: true, agreeMarketing: true|false(생략 시 false), termsVersion?: "2026-11-10" }`. 성공하면 200과 `GET /me`와 같은 응답(`onboardingComplete: true`)을 돌려준다.

| 상태 | 의미 |
|---|---|
| 400 | `agreeTerms`·`agreePrivacy`가 `true`가 아니거나 `agreeMarketing`이 boolean이 아님 |
| 401 | 로그인 필요/만료 |
| 409 `TERMS_VERSION_MISMATCH` | 본문의 `termsVersion`이 현재 버전과 다름. `detail.termsVersion`이 현재 버전이니 화면을 새로고침해 다시 동의받는다 |

- 같은 요청을 다시 보내도 안전하다(멱등). 최초 동의 시각(`consentedAt`)은 유지되고, 마케팅 값이 바뀐 경우에만 `agreeMarketing`과 `marketingChangedAt`이 갱신된다.
- 사용자 ID는 본문에서 받지 않고 토큰으로만 식별한다.
- 저장에 성공하면 Supabase Auth `user_metadata.onboarding_complete = true`도 함께 기록한다. 웹 `toAppUser`는 세션의 이 값으로 `onboardingComplete`를 읽으므로, 동의 직후 **세션을 갱신(`refreshSession`)하거나 `GET /me`의 `onboardingComplete`를 기준으로 삼아야** 한다. 이 기록이 실패해도 요청은 성공하며 DB 기록이 기준이다.
- 약관 버전은 Edge Function 상수 `TERMS_VERSION`(환경변수 `TERMS_VERSION`으로 덮어쓰기 가능)이다. 약관을 고치면 이 값을 올리고 재배포한다.

## 4. Kakao Developers 설정

https://developers.kakao.com/

1. 서비스 Kakao 애플리케이션 확인
2. Web 플랫폼에 https://j-hype-labs.github.io 등록
3. 로컬 테스트가 필요하면 http://localhost:3000 등록
4. Kakao Login 활성화
5. Supabase Dashboard의 Kakao Provider 화면에서 정확한 provider callback URI 확인
6. Kakao Redirect URI에 다음 형식의 Supabase 주소 등록:
   https://<SUPABASE_PROJECT_REF>.supabase.co/auth/v1/callback
7. 필요한 동의항목만 요청
8. 이메일은 선택 정보로 취급하고, 미제공 사용자의 인증 허용 설정 확인
9. REST API Key와 Client Secret 준비

Kakao Client Secret은 Supabase Provider 설정에만 입력한다. 프런트엔드나 GitHub 문서에 기록하지 않는다.

## 5. Supabase Auth 설정

Authentication → Sign In / Providers → Kakao

- Kakao Provider 활성화
- Kakao REST API Key 입력
- Kakao Client Secret 입력
- 이메일 미제공 사용자 허용 여부 확인

Authentication → URL Configuration

- Site URL: https://j-hype-labs.github.io/party-connect-mvp/
- Redirect URL은 실제 프런트엔드가 redirectTo로 보내는 URL만 허용한다.
- 프런트엔드 main SHA 9949f53에 auth/callback/index.html은 추가되어 있다.
- 다만 현재 js/auth-service.js의 loginWithKakao()는 redirectTo로 로그인 시작 페이지의 현재 URL을 지정한다. 따라서 callback 페이지가 실제 redirect target으로 사용된다고 단정하지 않는다.
- 구현에서 중앙 callback URL을 redirectTo로 통일한 뒤 https://j-hype-labs.github.io/party-connect-mvp/auth/callback/ 을 allowlist에 추가한다.
- callback 연결 전에는 현재 코드가 실제로 사용하는 URL만 허용하고, 존재하지 않는 경로를 임의 등록하지 않는다.
- 불필요한 와일드카드 redirect는 사용하지 않는다.

Kakao provider callback(Supabase 주소)과 Supabase의 앱 복귀 redirectTo(웹사이트 주소)는 서로 다른 주소다.

## 6. DB migration

PR #1의 웹 연동 migration:

supabase/migrations/20261106000000_party_connect_integration.sql

가입 동의 테이블(`user_consents`, 기존 데이터 변경 없음): `supabase/migrations/20261111000000_user_consents.sql`

파티 상태 자동 전환(`sync_party_slot_status()` + pg_cron 5분 주기, 기존 데이터 변경 없음): `supabase/migrations/20261112000000_slot_auto_status.sql`
- 모집 마감이 지난 `OPEN` → `CLOSED`, 종료 시각이 지난 `OPEN`/`CLOSED` → `FINISHED`. `DRAFT`·`CANCELLED`와 신청(applications)은 건드리지 않는다.
- pg_cron이 켜지지 않아도 마이그레이션은 성공하고, 관리자 `GET /admin/parties`·`/admin/summary`가 같은 함수를 먼저 호출한다. 공개 목록·신청은 원래부터 `recruit_deadline`을 직접 비교한다.
- 확인: `select jobname, schedule, active from cron.job;`

실행 전:
- 현재 대상 DB의 schema/version 확인
- 기본 v2 스키마 선행 조건 확인
- 백업/복구 계획 확인
- 스테이징 우선 적용

migration은 party_slots 표시 컬럼과 service_role 전용 함수를 추가한다. 운영 DB에서 reset_dev_only.sql을 실행하지 않는다.

## 7. Edge Function 배포

PR #1 병합과 코드 리뷰 후 대상 프로젝트를 확인하고 실행한다.

- supabase login
- supabase link --project-ref <project-ref>
- supabase functions deploy partylink-api --no-verify-jwt
- supabase secrets set ALLOWED_ORIGINS=https://j-hype-labs.github.io,http://localhost:3000

SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY는 Supabase Edge Function의 서버 환경에서만 사용한다.

--no-verify-jwt는 공개 파티 목록을 위해 gateway 검사를 끄는 설정이다. 로그인 필수 API는 handler 내부에서 auth.getUser로 토큰을 검증해야 한다.

## 8. 프런트엔드 설정 및 모드

현재 프런트엔드 main의 두 HTML에는 PARTYLINK_CONFIG가 각각 존재하며 supabaseUrl과 supabaseAnonKey가 빈 문자열이다.

현재 코드 모드:
- URL/공개 키가 비어 있으면 데모 모드
- 설정값이 있고 localhost가 아니면 기본 실서비스 모드
- localhost는 ?live=1일 때 실서비스 모드
- ?demo=1은 설정이 있어도 데모 모드를 강제할 수 있음

이는 현재 구현을 설명하는 표이며 운영 권장 정책이 아니다.

실제 사용자 운영 전 필수 변경:
- production에서 URL 파라미터로 demo mode를 강제할 수 없게 한다.
- production 설정 누락 시 fail-closed 처리한다.
- 운영 API 실패 시 localStorage fixture로 성공처럼 대체하지 않는다.
- 개발/CI 데모 모드는 별도 환경에서만 허용한다.
- 두 페이지의 설정과 Auth client를 공통 모듈로 통합한다.

브라우저 설정에는 Supabase Project URL과 공개용 publishable/anon key만 둔다. service_role, Kakao Client Secret, 관리자 비밀번호는 절대 넣지 않는다.

### 관리자 API

`/functions/v1/partylink-api/admin/...` — 모든 경로가 **카카오 로그인 토큰 + `admins` 테이블 등록**을 요구합니다. (미로그인 401, 관리자 아님 403)

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/admin/me` | 관리자 여부 확인 (화면 진입 가드용) |
| GET | `/admin/summary` | 대시보드 집계 (선정 대기 신청, 모집 중 파티, 7일 내 파티, 적립금 부족 점포, 차단 게스트) |
| GET | `/admin/stores` | 점포 목록 + 적립금 잔액 |
| POST | `/admin/stores` | 점포 등록 `{ name, businessRegNo, ownerName, phone, address, region?, defaultFeePerGuest?, ownerUserId? }` (`ownerUserId` 생략 시 임시 값 부여, 사업자번호 중복 409) |
| PATCH | `/admin/stores/:id` | 점포 수정 (사업자번호·점주 계정·잔액은 수정 불가) |
| GET | `/admin/stores/:id/deposits` | 적립금 원장 |
| POST | `/admin/stores/:id/charge` | 충전 `{ amount, depositorName, memo? }` |
| POST | `/admin/stores/:id/refund` | 환불 `{ amount, memo? }` (잔액 부족 시 402) |
| GET | `/admin/parties?status=` | 파티 목록 (모든 상태, 선정/신청 인원 포함) |
| POST | `/admin/parties` | 파티 등록 `{ storeId, title, benefit, startsAt, endsAt, recruitDeadline, capacity, ... }` |
| PATCH | `/admin/parties/:id` | 파티 수정 (상태 변경 포함, 점포 변경 불가) |
| GET | `/admin/applications?slotId=&status=` | 신청 목록 (게스트 연락처·미션 URL 포함) |
| POST | `/admin/applications/:id/approve` | 선정 |
| POST | `/admin/applications/:id/verify-visit` | 방문 인증 대행 `{ code }` (그 신청에 발급된 코드와 일치할 때만, 파티 시간대 안에서만) |
| POST | `/admin/applications/:id/request-revision` | 미션 보완 요청 (미션 제출 → 방문 인증 상태로 되돌려 게스트가 다시 제출). 마이그레이션 `20261110000000_mission_revision.sql` 필요 |
| POST | `/admin/applications/:id/reject` | 반려 `{ reason? }` |
| POST | `/admin/applications/:id/complete` | 최종 승인 (수수료 차감) |
| POST | `/admin/applications/:id/noshow` | 노쇼 처리 (벌점·자동 차단) |
| GET | `/admin/guests?blocked=1` | 게스트 목록 |
| POST | `/admin/guests/:id/block` | 수동 차단/해제 `{ blocked: boolean }` |

목록은 `?limit=`(기본 100, 최대 500)을 받습니다. 선정/반려/승인/노쇼는 점주 대신 처리하는 것이라, 점포 id는 서버가 신청에서 조회합니다.

관리자 등록: 마이그레이션 `20261107000000_admin_api.sql`을 적용한 뒤, 관리자가 웹에서 카카오 로그인을 한 번 한 다음 Supabase 대시보드 → Authentication → Users에서 User UID를 확인해 등록합니다.

```sql
INSERT INTO admins (user_id, note) VALUES ('<auth.users.id>', '대표');
```

## 9. 운영 테스트

- [ ] 실제 Kakao 테스트 계정 로그인
- [ ] Supabase Auth 사용자 생성 확인
- [ ] 새로고침 및 페이지 이동 후 세션 유지
- [ ] 로그아웃 후 재로그인
- [ ] 비로그인 신청 API가 거부됨
- [ ] 로그인 회원의 신청 저장
- [ ] 같은 회원의 신청 조회
- [ ] 본인 신청 취소
- [ ] 중복 신청 차단
- [ ] 다른 회원의 신청 조회/취소 거부
- [ ] 모집 마감 및 정원 초과 서버 검증
- [ ] RLS와 service_role 함수 권한 검증
- [ ] CORS allowlist 검증
- [ ] service_role 키 브라우저 노출 없음

Mock 테스트 통과는 실제 Kakao OAuth/운영 DB 테스트를 대체하지 않는다.

## 10. 운영 범위 경계

PartyLink는 Kakao 계정 인증과 파티 신청 데이터를 처리한다. 회원 인증을 위해 생년월일·나이·연령 확인 정보를 수집하거나 관련 인증 API/DB 상태를 만들지 않는다. 현장에서 필요한 확인은 파티 현장 운영자가 담당한다.

## 11. 남은 작업

- [ ] PR #1 코드 리뷰 및 main 병합
- [ ] 스테이징 DB migration 적용
- [ ] Edge Function 배포
- [ ] Kakao Provider 설정
- [ ] 프런트엔드 설정 및 production demo 차단
- [ ] 회원 동의 이력 저장 기능
- [ ] 실제 OAuth 및 신청 통합 테스트
- [ ] 관리자 인증을 서버 측 권한으로 전환 (서버 API는 `/admin/*`로 구현됨, 관리자 화면 연동은 남음)
- [ ] 운영 적용 승인

관련 공식 문서:
- Supabase Kakao provider: https://supabase.com/docs/guides/auth/social-login/auth-kakao
- Supabase redirect URLs: https://supabase.com/docs/guides/auth/redirect-urls
- Kakao Developers: https://developers.kakao.com/docs/latest/ko/kakaologin/common
