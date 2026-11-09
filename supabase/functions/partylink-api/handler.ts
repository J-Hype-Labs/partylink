// =====================================================================
// partylink-api — party-connect-mvp(웹) ↔ PartyLink DB 연결 Edge Function
//
//   GET  /partylink-api/parties                   공개 파티 목록 (로그인 불필요)
//   GET  /partylink-api/applications              내 신청 내역        (카카오 로그인 필요)
//   POST /partylink-api/applications              파티 신청           (카카오 로그인 필요)
//        body: { slotId, name, phone, agree }
//   POST /partylink-api/applications/:id/cancel   신청 취소           (카카오 로그인 필요)
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
import { createClient, type User } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// 쉼표로 구분한 허용 Origin. 비우면 모든 Origin 허용 (개발용)
//   예: https://j-hype-labs.github.io,http://localhost:3000
const ALLOWED_ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEFAULT_PARTY_IMAGE =
  "https://images.unsplash.com/photo-1514933651103-005eec06c04b?auto=format&fit=crop&w=600&q=80";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const weekdayFmt = new Intl.DateTimeFormat("ko-KR", { weekday: "short", timeZone: "Asia/Seoul" });
const weekday = (iso: string) => weekdayFmt.format(new Date(iso)); // "월" ~ "일"

// ---------------------------------------------------------------------
// 에러 처리
// ---------------------------------------------------------------------
class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public detail?: unknown) {
    super(message);
  }
}

type DbError = { code?: string; message?: string; details?: string };

function fromDbError(e: DbError): HttpError {
  const msg = e.message ?? "";
  let detail: unknown = e.details;
  try { detail = JSON.parse(e.details ?? ""); } catch { /* plain text */ }

  switch (e.code) {
    case "PL400":
      if (/phone/i.test(msg)) return new HttpError(400, "연락처를 정확히 입력해 주세요. (예: 01012345678)", e.code);
      if (/name/i.test(msg)) return new HttpError(400, "이름을 2자 이상 입력해 주세요.", e.code);
      return new HttpError(400, "입력값을 확인해 주세요.", e.code);
    case "PL403":
      return new HttpError(403, "권한이 없습니다.", e.code);
    case "PL404":
      return new HttpError(404, "대상을 찾을 수 없습니다.", e.code);
    case "PL409":
      if (/already applied/i.test(msg)) return new HttpError(409, "이미 신청한 파티입니다.", e.code);
      if (/phone number is already/i.test(msg)) return new HttpError(409, "이미 다른 계정에 등록된 연락처입니다.", e.code);
      return new HttpError(409, "현재 상태에서는 처리할 수 없습니다.", e.code);
    case "PL410":
      if (/cancel/i.test(msg)) return new HttpError(410, "파티가 시작된 후에는 취소할 수 없습니다.", e.code);
      return new HttpError(410, "모집이 마감되었거나 정원이 찼습니다.", e.code);
    case "PL423":
      return new HttpError(423, "노쇼 누적 등으로 신청이 제한된 계정입니다.", e.code, detail);
    default:
      console.error("Unexpected DB error", e);
      return new HttpError(500, "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요.");
  }
}

async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw fromDbError(error);
  return data as T;
}

// ---------------------------------------------------------------------
// 인증 / CORS / 응답
// ---------------------------------------------------------------------
async function requireUser(req: Request): Promise<User> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "카카오 로그인이 필요합니다.");
  const { data, error } = await admin.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해 주세요.");
  return data.user;
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allow = ALLOWED_ORIGINS.length === 0 ? "*" : ALLOWED_ORIGINS.includes(origin) ? origin : "";
  const headers: Record<string, string> = {
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    throw new HttpError(400, "요청 형식이 올바르지 않습니다.");
  }
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
    name: r.guest_name,
    phone: r.guest_phone,
    appliedAt: r.applied_at,
    userId: user.id,
  }));
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
  const { data: guest, error } = await admin.from("guests").select("id").eq("user_id", user.id).maybeSingle();
  if (error) throw fromDbError(error);
  if (!guest) throw new HttpError(404, "대상을 찾을 수 없습니다.");
  return await rpc("cancel_application", { p_application_id: applicationId, p_guest_id: guest.id });
}

// ---------------------------------------------------------------------
// 라우터
// ---------------------------------------------------------------------
export async function handler(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });

  const path = new URL(req.url).pathname.replace(/^.*?\/partylink-api/, "").replace(/\/+$/, "") || "/";
  try {
    if (path === "/parties" && req.method === "GET") {
      return json(req, 200, await listParties());
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
    throw new HttpError(404, "Not found");
  } catch (e) {
    const err = e instanceof HttpError ? e : (console.error(e), new HttpError(500, "일시적인 오류가 발생했습니다."));
    return json(req, err.status, { code: err.code, message: err.message, detail: err.detail });
  }
}
