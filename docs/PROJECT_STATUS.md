# PartyLink 프로젝트 현황과 업무 분배 (2026-11-09)

두 저장소에 흩어진 명세와 진행 상황을 한 곳에 모은 문서입니다. 상세는 각 문서가 원본이고, 여기에는 **지금 무엇이 되어 있고, 누가 무엇을 맡고, 무엇이 남았는지**만 적습니다.

| 저장소 | 역할 |
|---|---|
| `J-Hype-Labs/partylink` | DB 스키마·마이그레이션, Edge Function `partylink-api` (서버) |
| `J-Hype-Labs/party-connect-mvp` | 웹사이트 (GitHub Pages: `https://j-hype-labs.github.io/party-connect-mvp/`) |

## 1. 구조

```
[웹 (GitHub Pages)] ──supabase-js(카카오 PKCE)──▶ [Supabase Auth]
        │ publishable key + 로그인 토큰
        ▼
[Edge Function partylink-api] ──service_role──▶ [Postgres: SQL 함수 / RLS]
   /parties /applications /applications/:id/cancel
   /admin/*  (admins 테이블에 등록된 계정만)
```

- 브라우저에는 publishable key만 둡니다. `service_role`·Client Secret·관리자 비밀번호는 브라우저와 저장소에 없습니다.
- 게스트·관리자는 요청 본문이 아니라 **로그인 토큰**으로 식별합니다.
- Supabase 프로젝트: `Partylink01` (`cpctedhhojmbycnqhzli`). 같은 계정에 소문자 `partylink01`(`kqubnvzgyqurvnhszamg`)도 있으나 **이 프로젝트에서는 쓰지 않습니다** (용도 미확인).

## 2. 현재 상태 (2026-11-09 기준)

### 완료
| 영역 | 상태 |
|---|---|
| DB | 스키마 v2, 통합 마이그레이션(`20261106…`), 관리자 테이블(`20261107…`), 미션 보완 요청 함수(`20261110…`)가 Supabase에 적용됨 |
| 서버 | `partylink-api` 버전 7 배포됨 (CLI 배포, JWT 검증 꺼짐). 사용자 API(게스트 미션 제출 `POST /applications/:id/mission` 포함) + 관리자 API(점포 등록·수정, 대시보드 집계, 방문 인증 대행, 미션 보완 요청). 직전 버전 6으로 되돌리려면 PR #5 병합 직전 커밋(`f2c4c38`)을 checkout해 같은 명령으로 재배포 |
| 로그인 | 카카오(Supabase Auth, PKCE). Kakao 앱은 비즈 앱, 동의항목 닉네임 필수·사진/이메일 선택 |
| 웹 | 실서비스 모드가 배포 사이트에서 켜져 있음 (`GET /parties` 200, 콘솔 오류 없음). 메인 페이지의 파티·신청 내역 로딩, 모바일 로그인 버그 수정 |
| 관리자 화면 | `/admin/`: 로그인 가드, 대시보드(집계 타일), 신청 관리(선정·반려·방문 인증·노쇼·최종 승인·보완 요청), 파티(등록·수정·상태 전환), 점포·적립금(등록·수정·충전·환불·내역·운영 중지), 게스트(검색·차단/해제). 실서버 로그인 상태 검증은 아직 못 함 |
| CI | `main`의 E2E(chromium, mobile-chrome, WebKit) 통과, 관리자 화면 테스트도 CI에서 실행. 신청 흐름은 로그인 세션을 mock한 live fixture로 검증 |
| 관리자 계정 | `admins`에 1명(대표) 등록 |

### 진행 중 / 대기
| 항목 | 상태 |
|---|---|
| party-connect-mvp PR #15 (`hustlinjh`) | 관리자 대시보드·게스트 화면. 이미 병합된 PR #18과 **범위·파일이 겹치고 충돌 상태**. 작성자와 조율 후 닫거나 필요한 부분만 새 PR로 가져오기 (사용자 결정 필요) |
| 협업자 PR 3, 6, 7 (party-connect-mvp, 아직 열려 있음) | 현재 `main`과 맞지 않는 옛 상태 기준(카카오 구현 명세·감사 문서·옛 입력 id 테스트). 닫기 후보. 사용자 결정 필요 |
| 오래된 브랜치 | `fix/p0-assert-real-flows`, `fix/p0-integration-qa`, `docs/auth-backend-readiness` 등 정리 대상. 삭제는 사용자 확인 후 |

### 사용자 승인 대기 (프로덕션 변경: 제가 직접 하지 않음)
| 항목 | 내용 |
|---|---|
| `partylink-api` 재배포 | partylink PR #8(`GET /applications`에 `missionUrl·approvedAt·visitedAt`), #9(관리자 오류 메시지), 서버 검증 강화 PR(파티 상태 전이·정원, 점주 계정 확인, 잔액 부족 집계 정정)이 병합돼 있어 **한 번에 재배포**하면 됨(마이그레이션 없음). 배포 전에는 프런트가 새 필드를 못 받지만, 없으면 숨기는 구조라 동작에는 문제 없음 |
| `ALLOWED_ORIGINS` 정리 | 현재 설정은 정상(허용 출처만 CORS 허용, 그 외 거부 확인). 다만 `http://localhost:3000`이 허용 목록에 있음 → 출시 전에 제거 권장(`supabase secrets set ALLOWED_ORIGINS=https://j-hype-labs.github.io`). 프로덕션 환경변수 변경이라 승인 후 |

### 보류 (후속 과제)
- **보완 사유(`revisionNote`)**: 이번 MVP에서는 제외. 마이그레이션(컬럼 + `request_mission_revision` 사유 인자 + `guest_applications` 반환)과 재배포가 필요하고, 사유는 관리자가 수동 안내로 대체 가능. 프런트는 `status==='VISITED' && missionUrl`이면 "보완 요청됨" 문구만 표시.
- **관리 행위 감사 로그**: 차단·선정·반려·노쇼를 누가 했는지 남기지 않음(최종 승인만 `deposit_histories.created_by`에 남음). 관리자가 1명인 MVP에서는 제외, 관리자가 늘어나기 전에 별도 로그 테이블 설계.
- **점주 계정 연결**: 점포 등록 시 `ownerUserId`를 생략하면 임의 UUID가 들어가며 "연결된 점주 계정 없음"을 뜻함(점주 로그인이 MVP 범위 밖). 값을 주면 실제 로그인 계정인지 확인함. 나중에 점주를 연결하려면 SQL로 `stores.owner_user_id`를 바꿔야 함(PATCH는 변경 불가).
- **수수료 집계 서버화**: 지금은 화면이 최근 500건에서 집계. 신청이 500건을 넘으면 서버 집계 엔드포인트가 필요(`docs/settlement-check.md`의 SQL로 원장과 교차 검증 가능).

### 알려진 한계 (지금 DB에 파티가 0개)
- 테스트 데이터를 모두 지워서 배포 사이트는 "검색 결과가 없습니다"로 보입니다. 실제 파티는 관리자 화면에서 **점포 등록 → 파티 등록(공개)** 순서로 만들면 됩니다. 관리자 로그인이 필요해 아직 실서버에서 시험하지 못했습니다.
- 사용자 화면의 "요일 필터"는 반복 요일(`days`)에 의존하지만 DB 파티는 특정 일시의 1회성입니다 (명세 Q6, 별도 논의).
- 레거시 `SUPABASE_SERVICE_ROLE_KEY`는 2027년 초 종료 예정입니다. 새 시크릿 키로 이전해야 합니다.
- 후기 관리는 이번 범위에서 제외했습니다 (DB에 후기 테이블 없음, 명세 Q2).

## 3. 업무 분배 (겹침 방지)

한 영역에는 **한 담당만** 둡니다. 다른 담당의 파일을 고쳐야 하면 먼저 요청하고, 같은 파일을 두 세션이 동시에 고치지 않습니다.

| 담당 | 맡는 영역 | 대표 파일 |
|---|---|---|
| **DB/서버 + 관리자 화면** | DB 마이그레이션, Edge Function, 관리자 API, `/admin/` 화면과 그 테스트 | `partylink/supabase/**`, `party-connect-mvp/admin/**`, `js/admin-*.js`, `tests/admin-*.spec.js` |
| **사용자 화면 (협업자)** | 메인 페이지·HypeConnect 페이지 UI, 인증 모듈, 사용자 문서, E2E 안정화 | `index.html`, `party-connect/index.html`, `js/auth-*.js`, `js/party-*.js`, `tests/comprehensive.spec.js`, `tests/party-connect-page.spec.js`, `tests/user-journey-regression.spec.js`, `docs/AUTH_*` |
| **PM (조율)** | 우선순위, 병합·배포 승인, 사용자 확인 필요한 변경 전달 | — |

### 공통 규칙
1. 모든 변경은 브랜치 + PR. `main`에 직접 푸시하지 않습니다.
2. **CI가 초록일 때만 병합**합니다. 빨간 채로 병합하려면 사용자 승인을 받습니다.
3. **Supabase 적용(마이그레이션)과 Edge Function 배포는 PR 병합과 별개 단계**이며 PM/사용자 확인 후 진행합니다. 병합만으로는 서비스에 반영되지 않습니다.
4. 서버 API를 바꾸면 `docs/party-connect-integration.md`의 API 표와 Deno 테스트를 같은 PR에서 갱신합니다.
5. 사용자 입력은 화면에서 `textContent`로만 그립니다 (`innerHTML` 금지). 키·토큰은 코드와 로그에 남기지 않습니다.
6. E2E는 실제 Supabase를 호출하지 않고 SDK와 API를 mock 합니다 (`tests/helpers/live-fixture.js`). 로컬은 포트 3000이 다른 서버에 점유돼 있지 않은지 먼저 확인합니다.

## 4. 다음 작업 (제안 순서)

| 순서 | 작업 | 담당 | 비고 |
|---|---|---|---|
| 1 | ~~partylink PR #5 병합 → 마이그레이션 적용 → 재배포~~ | — | 완료 (함수 버전 7) |
| 2 | ~~관리자 화면: 대시보드, 파티, 점포·적립금~~ | — | 완료 (party-connect-mvp#16, #18) |
| 3 | ~~관리자 화면: 게스트 차단, "보완 요청" 버튼~~ | — | 완료 (party-connect-mvp#17, #18) |
| 4 | ~~`ci.yml`에 관리자 테스트 단계 추가~~ | — | 완료 (party-connect-mvp#14, 3개 브라우저 통과) |
| 5 | 게스트 마이페이지에서 미션 제출 연결 (`POST /applications/:id/mission`) | 사용자 화면 | 서버는 준비됨 (버전 7). 지금 바로 가능 |
| 6 | **관리자 로그인으로 실서버 시험**: 점포 1개·파티 1개 등록 → 사이트 노출 → 신청 → 선정 → 방문 인증 → 미션 → 최종 승인 | 사용자(카카오 로그인 필요) + DB/서버 | 관리자 화면 전체가 mock 테스트만 거침 |
| 6-1 | 요일 필터/반복 파티 정책 결정 | PM + 사용자 화면 | 명세 Q6 |
| 7 | 메인 페이지의 옛 관리자 모달(하드코딩 비밀번호) 제거 → `/admin/` 링크 | 사용자 화면 | 관리자 화면이 안정된 뒤 |
| 8 | 레거시 service_role 키 이전, 후기 테이블 설계 | DB/서버 | 2027년 초 전 |

## 5. 문서 위치

| 내용 | 위치 |
|---|---|
| API 계약, 설정 순서 | `partylink/docs/party-connect-integration.md` |
| 관리자 페이지 명세 (확정 v1.0) | `partylink/docs/admin-page-spec.md` |
| 인증 구현·UI·배포 점검 | `party-connect-mvp/docs/AUTH_*.md` |
| 사이트 명세 | `party-connect-mvp/SPECIFICATION.md`, `PARTY_CONNECT_PAGE_IMPLEMENTATION_SPEC.md` |
| 이 문서 | `partylink/docs/PROJECT_STATUS.md` (변경될 때마다 갱신) |
