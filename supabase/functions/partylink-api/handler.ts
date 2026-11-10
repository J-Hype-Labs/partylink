// =====================================================================
// partylink-api — party-connect-mvp(웹) ↔ PartyLink DB 연결 Edge Function
//
//   GET  /partylink-api/parties                   공개 파티 목록 (로그인 불필요)
//   GET  /partylink-api/applications              내 신청 내역        (카카오 로그인 필요)
//   POST /partylink-api/applications              파티 신청           (카카오 로그인 필요)
//        body: { slotId, name, phone, agree }
//   POST /partylink-api/applications/:id/cancel   신청 취소           (카카오 로그인 필요)
//   POST /partylink-api/applications/:id/mission  미션 URL 제출      (카카오 로그인 필요) body: { url }
//   GET  /partylink-api/me                        내 프로필·가입 동의 여부  (카카오 로그인 필요)
//   POST /partylink-api/me/onboarding             가입 동의 저장            (카카오 로그인 필요)
//        body: { agreeTerms: true, agreePrivacy: true, agreeMarketing?: boolean, termsVersion?: string }
//   *    /partylink-api/admin/...                 관리자 API          (admins 테이블 등록 계정만, admin.ts)
//
// 보안 원칙
//   * 사용자는 Authorization: Bearer <access_token> 으로만 식별 (auth.getUser 로 서버에서 검증)
//   * guest_id / user_id 는 요청 body 에서 절대 받지 않음
//   * service_role 키는 이 함수 안에서만 사용 (Supabase 가 환경변수로 자동 주입)
//
// 진입점은 index.ts (Deno.serve), 이 파일은 테스트를 위해 handler 만 export 합니다.
// 배포: supabase functions deploy partylink-api --no-verify-jwt
//   (공개 목록 조회를 위해 게이트웨이 JWT 검사는 끄고, 로그인이 필요한 경로는 아래에서 직접 검증)
// =====================================================================
import type { User } from "npm:@supabase/supabase-js@2.45.4";
import { db, fromDbError, HttpError, readJson, requireUser, rpc, UUID_RE } from "./common.ts";
import { adminRoute } from "./admin.ts";

// 쉼표로 구분한 허용 Origin. 비우면 모든 Origin 허용 (개발용)
//   예: https://j-hype-labs.github.io,http://localhost:3000
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 현재 약관 버전. 약관을 고치면 이 값(또는 TERMS_VERSION 환경변수)을 올립니다.
// 회원이 이 버전에 동의한 기록이 있어야 onboardingComplete 가 true 입니다.
const TERMS_VERSION = Deno.env.get("TERMS_VERSION") ?? "2026-11-10";

const DEFAULT_PARTY_IMAGE =
  "https://images.unsplash.com/photo-1514933651103-005eec06c04b?auto=format&fit=crop&w=600&q=80";
const weekdayFmt = new Intl.DateTimeFormat("ko-KR", { weekday: "short", timeZone: "Asia/Seoul" });
const weekday = (iso: string) => weekdayFmt.format(new Date(iso)); // "월" ~ "일"

// ---------------------------------------------------------------------
// CORS / 응답
// ---------------------------------------------------------------------
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allow = ALLOWED_ORIGINS.length === 0 ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
    "Vary": "Origin",
  };
  if (allow) headers["Access-Control-Allow-Origin"] = allow;
  return headers;
}

function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json; charset=utf-8" },
  });
}


// ---------------------------------------------------------------------
// 핸들러
// ---------------------------------------------------------------------
type PartyRow = {
  id: string; title: string; description: string | null; benefit: string; category: string | null;
  images: string[]; badges: string[]; is_featured: boolean;
  starts_at: string; ends_at: string; recruit_deadline: string;
  capacity: number; selected_count: number; applicant_count: number;
  mission_requirements: Record<string, unknown>;
  store_name: string; store_address: string; store_region: string | null;
};

// 웹(party-connect-mvp)의 파티 카드 형태로 변환
async function listParties() {
  const rows = await rpc<PartyRow[]>("list_open_parties");
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    region: r.store_region ?? "",
    category: r.category ?? "",
    days: [weekday(r.starts_at)],
    recruit: r.capacity,
    currentRecruit: r.selected_count,
    applicantCount: r.applicant_count,
    venue: r.store_name,
    address: r.store_address,
    desc: r.description ?? r.benefit,
    benefit: r.benefit,
    images: r.images.length > 0 ? r.images : [DEFAULT_PARTY_IMAGE],
    badges: r.badges,
    isFeatured: r.is_featured,
    startsAt: r.starts_at,
    endsAt: r.ends_at,
    recruitDeadline: r.recruit_deadline,
    missionRequirements: r.mission_requirements,
    live: true,
  }));
}

type MyAppRow = {
  id: string; slot_id: string; status: string; visit_code: string | null;
  applied_at: string; approved_at: string | null; visited_at: string | null;
  mission_url: string | null; reject_reason: string | null;
  title: string; starts_at: string; ends_at: string; store_name: string;
  guest_name: string; guest_phone: string;
};

async function listMyApplications(user: User) {
  const rows = await rpc<MyAppRow[]>("guest_applications", { p_user_id: user.id });
  return rows.map((r) => ({
    id: r.id,
    partyId: r.slot_id,
    partyTitle: r.title,
    venue: r.store_name,
    day: weekday(r.starts_at),
    startsAt: r.starts_at,
    status: r.status,
    visitCode: r.visit_code,
    rejectReason: r.reject_reason,
    // 마이페이지용: 마지막으로 제출한 미션 URL. 관리자가 보완을 요청하면 status 는 VISITED 로 돌아가지만
    // missionUrl 은 이전 제출값이 남으므로 (VISITED && missionUrl) 이면 "보완 요청됨" 으로 볼 수 있다.
    missionUrl: r.mission_url,
    approvedAt: r.approved_at,
    visitedAt: r.visited_at,
    name: r.guest_name,
    phone: r.guest_phone,
    appliedAt: r.applied_at,
    userId: user.id,
  }));
}

// ---------------------------------------------------------------------
// 내 정보 / 가입 동의
// ---------------------------------------------------------------------
type ConsentRow = {
  terms_version: string; agreed_terms: boolean; agreed_privacy: boolean; agreed_marketing: boolean;
  consented_at: string; marketing_changed_at: string;
};
const CONSENT_COLUMNS = "terms_version, agreed_terms, agreed_privacy, agreed_marketing, consented_at, marketing_changed_at";

async function findConsent(userId: string): Promise<ConsentRow | null> {
  const { data, error } = await db.from("user_consents").select(CONSENT_COLUMNS)
    .eq("user_id", userId).eq("terms_version", TERMS_VERSION).maybeSingle();
  if (error) throw fromDbError(error);
  return data as ConsentRow | null;
}

const metaString = (m: Record<string, unknown> | undefined, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = m?.[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
};

async function getMe(user: User) {
  const consent = await findConsent(user.id);
  const { data: guest, error } = await db.from("guests").select("name, phone").eq("user_id", user.id).maybeSingle();
  if (error) throw fromDbError(error);
  return {
    id: user.id,
    email: user.email ?? null,
    nickname: metaString(user.user_metadata, "nickname", "name", "full_name", "preferred_username"),
    avatarUrl: metaString(user.user_metadata, "avatar_url", "picture"),
    termsVersion: TERMS_VERSION, // 지금 동의받아야 하는 약관 버전
    onboardingComplete: consent !== null,
    consent: consent && {
      termsVersion: consent.terms_version,
      agreeTerms: consent.agreed_terms,
      agreePrivacy: consent.agreed_privacy,
      agreeMarketing: consent.agreed_marketing,
      consentedAt: consent.consented_at,
      marketingChangedAt: consent.marketing_changed_at,
    },
    guest: guest ? { name: guest.name as string, phone: guest.phone as string } : null, // 첫 신청 전에는 null
  };
}

// 필수 동의 + 선택 마케팅 동의 저장. 같은 요청을 다시 보내도 안전합니다(멱등).
async function completeOnboarding(user: User, body: Record<string, unknown>) {
  if (body.agreeTerms !== true || body.agreePrivacy !== true) {
    throw new HttpError(400, "이용약관과 개인정보 수집·이용에 모두 동의해 주세요.");
  }
  if (body.agreeMarketing !== undefined && typeof body.agreeMarketing !== "boolean") {
    throw new HttpError(400, "마케팅 수신 동의 값이 올바르지 않습니다.");
  }
  if (body.termsVersion !== undefined && body.termsVersion !== TERMS_VERSION) {
    throw new HttpError(409, "약관이 갱신되었습니다. 화면을 새로고침한 뒤 다시 동의해 주세요.", "TERMS_VERSION_MISMATCH", { termsVersion: TERMS_VERSION });
  }
  const marketing = body.agreeMarketing === true;

  const existing = await findConsent(user.id);
  if (!existing) {
    const { error } = await db.from("user_consents").insert({
      user_id: user.id, terms_version: TERMS_VERSION,
      agreed_terms: true, agreed_privacy: true, agreed_marketing: marketing,
    });
    // 동시에 두 번 눌러 먼저 들어간 행이 있으면(23505) 그대로 성공으로 본다
    if (error && error.code !== "23505") throw fromDbError(error);
  } else if (existing.agreed_marketing !== marketing) {
    const { error } = await db.from("user_consents").update({
      agreed_marketing: marketing, marketing_changed_at: new Date().toISOString(),
    }).eq("user_id", user.id).eq("terms_version", TERMS_VERSION);
    if (error) throw fromDbError(error);
  }

  // 웹은 세션의 user_metadata.onboarding_complete 로 동의 여부를 판단하므로 같이 맞춰 둔다.
  // (새 값은 웹이 세션을 refreshSession 한 뒤부터 보인다.) 실패해도 DB 기록이 기준이라 요청은 성공 처리.
  try {
    const { error } = await db.auth.admin.updateUserById(user.id, {
      user_metadata: { ...(user.user_metadata ?? {}), onboarding_complete: true, terms_version: TERMS_VERSION },
    });
    if (error) console.error("onboarding metadata sync failed", error.message);
  } catch (e) {
    console.error("onboarding metadata sync failed", e);
  }
  return await getMe(user);
}

async function apply(user: User, body: Record<string, unknown>) {
  const slotId = String(body.slotId ?? "");
  const name = String(body.name ?? "").slice(0, 50);
  const phone = String(body.phone ?? "").slice(0, 20);
  if (!UUID_RE.test(slotId)) throw new HttpError(400, "신청할 파티를 찾을 수 없습니다.");
  if (body.agree !== true) throw new HttpError(400, "개인정보 수집 및 이용에 동의해 주세요.");

  // 1) 카카오 계정 ↔ guests 프로필 연결 (최초 신청 시 생성, 이후 갱신)
  const guestId = await rpc<string>("upsert_guest_profile", {
    p_user_id: user.id, p_name: name, p_phone: phone, p_email: user.email ?? null,
  });
  // 2) 신청 (모집 상태·마감·차단·중복은 DB 함수가 검증)
  const result = await rpc<{ application_id: string; status: string }>("apply_to_slot", {
    p_slot_id: slotId, p_guest_id: guestId,
  });
  return { id: result.application_id, status: result.status };
}

async function cancel(user: User, applicationId: string) {
  if (!UUID_RE.test(applicationId)) throw new HttpError(404, "대상을 찾을 수 없습니다.");
  const { data: guest, error } = await db.from("guests").select("id").eq("user_id", user.id).maybeSingle();
  if (error) throw fromDbError(error);
  if (!guest) throw new HttpError(404, "대상을 찾을 수 없습니다.");
  return await rpc("cancel_application", { p_application_id: applicationId, p_guest_id: guest.id });
}

// 미션 URL 제출 (방문 인증 후, 관리자가 보완을 요청한 뒤 재제출 포함). 게스트는 토큰으로 식별
async function submitMission(user: User, applicationId: string, body: Record<string, unknown>) {
  if (!UUID_RE.test(applicationId)) throw new HttpError(404, "대상을 찾을 수 없습니다.");
  const url = String(body.url ?? "").trim().slice(0, 1000);
  if (!/^https?:\/\//i.test(url)) throw new HttpError(400, "미션 URL은 http:// 또는 https:// 로 시작해야 합니다.");
  const { data: guest, error } = await db.from("guests").select("id").eq("user_id", user.id).maybeSingle();
  if (error) throw fromDbError(error);
  if (!guest) throw new HttpError(404, "대상을 찾을 수 없습니다.");
  return await rpc("submit_mission", { p_application_id: applicationId, p_guest_id: guest.id, p_mission_url: url });
}

// ---------------------------------------------------------------------
// 라우터
// ---------------------------------------------------------------------
export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });

  const path = new URL(req.url).pathname.replace(/^.*?\/partylink-api/, "").replace(/\/+$/, "") || "/";
  try {
    if (path === "/admin" || path.startsWith("/admin/")) {
      const r = await adminRoute(req, path.slice("/admin".length) || "/");
      if (r) return json(req, r.status, r.body);
      throw new HttpError(404, "Not found");
    }
    if (path === "/parties" && req.method === "GET") {
      return json(req, 200, await listParties());
    }
    if (path === "/me" && req.method === "GET") {
      return json(req, 200, await getMe(await requireUser(req)));
    }
    if (path === "/me/onboarding" && req.method === "POST") {
      const user = await requireUser(req);
      return json(req, 200, await completeOnboarding(user, await readJson(req)));
    }
    if (path === "/applications" && req.method === "GET") {
      return json(req, 200, await listMyApplications(await requireUser(req)));
    }
    if (path === "/applications" && req.method === "POST") {
      const user = await requireUser(req);
      return json(req, 201, await apply(user, await readJson(req)));
    }
    const cancelMatch = path.match(/^\/applications\/([^/]+)\/cancel$/);
    if (cancelMatch && req.method === "POST") {
      return json(req, 200, await cancel(await requireUser(req), cancelMatch[1]));
    }
    const missionMatch = path.match(/^\/applications\/([^/]+)\/mission$/);
    if (missionMatch && req.method === "POST") {
      const user = await requireUser(req);
      return json(req, 200, await submitMission(user, missionMatch[1], await readJson(req)));
    }
    throw new HttpError(404, "Not found");
  } catch (e) {
    const err = e instanceof HttpError ? e : (console.error(e), new HttpError(500, "일시적인 오류가 발생했습니다."));
    return json(req, err.status, { code: err.code, message: err.message, detail: err.detail });
  }
}
