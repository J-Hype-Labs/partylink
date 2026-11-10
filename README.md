# PartyLink 데이터베이스 및 API

PartyLink는 HypeConnect 웹 프런트엔드와 점주/운영 업무를 위한 Supabase PostgreSQL 스키마 및 서버 측 업무 함수다.

- 저장소: https://github.com/J-Hype-Labs/partylink
- 프런트엔드: https://github.com/J-Hype-Labs/party-connect-mvp
- 웹 연동 PR: https://github.com/J-Hype-Labs/partylink/pull/1

## 현재 상태

2026-11-08 확인 기준, 웹 연동 migration과 partylink-api Edge Function은 feature/party-connect-integration 브랜치의 PR #1에 포함되어 있으나 아직 main에 병합되지 않았다. Supabase 운영 프로젝트에 migration 또는 Edge Function이 배포되었다고 간주하지 않는다.

프런트엔드 main에는 Kakao OAuth/Supabase Auth 호출 코드가 있지만 Supabase URL 및 공개 키가 비어 있어 실제 인증·DB 연동은 검증되지 않았다.

## 데이터 구조

기본 스키마:

- stores: 점주/업체와 선불 잔액
- party_slots: 파티 일정, 정원, 혜택, 미션 조건, 수수료
- guests: 게스트 프로필과 운영 상태
- applications: 신청, 방문 코드, 미션, 상태, 정산
- deposit_histories: 충전·차감·환불 원장

웹 연동 migration은 party_slots의 카드 표시용 컬럼과 서버 전용 조회/프로필/신청 함수를 추가한다.

## 신청 상태 흐름

APPLIED → APPROVED → VISITED → MISSION_SUBMITTED → COMPLETED

보조 상태:
- REJECTED
- CANCELLED
- NOSHOW

허용되지 않은 상태 전이는 DB 트리거와 업무 함수에서 차단한다.

## 권한 및 보안

- 브라우저에서 service_role 키를 사용하지 않는다.
- Edge Function은 Authorization Bearer token을 Supabase Auth로 검증한다.
- user_id와 guest_id는 클라이언트 요청 body에서 받지 않는다.
- 검증된 auth user ID를 사용해 guests 프로필과 신청 내역을 연결한다.
- 공개 파티 목록 외의 회원별 데이터는 인증과 본인 소유권 확인이 필요하다.
- service_role 전용 SQL 함수는 브라우저 역할에 직접 실행 권한을 주지 않는다.
- RLS, 함수 권한, Edge Function의 본인 확인을 함께 검증한다.

## 현장 운영 책임 경계

PartyLink 웹 회원 인증은 Kakao OAuth와 Supabase Auth를 통한 계정 식별이다. PartyLink는 회원 인증을 위해 생년월일·나이·연령 확인 정보를 수집하거나 관련 인증 API/DB 상태를 제공하지 않는다. 현장 확인이 필요한 사항은 파티 현장 운영자가 담당한다.

## 개발 DB 주의

scripts/reset_dev_only.sql은 개발 전용 초기화 스크립트다. 실행 시 PartyLink 테이블과 데이터가 삭제될 수 있으므로 운영 DB에서 절대 실행하지 않는다.

## 적용 순서

1. 대상 Supabase 프로젝트와 현재 schema/version 확인
2. 백업 및 migration 검토
3. migration을 스테이징에 적용
4. RLS 및 service_role 함수 권한 확인
5. partylink-api Edge Function 배포
6. CORS 및 인증 API 테스트
7. 실제 Kakao 테스트 계정으로 회원별 신청/조회/취소 검증
8. 승인 후 운영 적용

## 문서

- 웹 연동 설정과 API 계약: docs/party-connect-integration.md
- migration: supabase/migrations/20261106000000_party_connect_integration.sql
- Edge Function: supabase/functions/partylink-api/

운영 배포, 실제 OAuth 또는 DB 적용은 PR 병합만으로 완료되지 않는다. 배포 로그와 실제 테스트 증거를 별도로 기록한다.
