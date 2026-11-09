// =====================================================================
// 관리자 API  (/partylink-api/admin/...)
//
//   GET   /admin/me                            관리자 여부 확인
//   GET   /admin/stores                        점포 목록 (+ 적립금 잔액)
//   GET   /admin/stores/:id/deposits           적립금 원장
//   POST  /admin/stores/:id/charge             충전  { amount, depositorName, memo? }
//   POST  /admin/stores/:id/refund             환불  { amount, memo? }
//   GET   /admin/parties[?status=]             파티 목록 (모든 상태)
//   POST  /admin/parties                       파티 등록
//   PATCH /admin/parties/:id                   파티 수정 (상태 변경 포함)
//   GET   /admin/applications[?slotId=&status=]  신청 목록 (게스트 연락처 포함)
//   POST  /admin/applications/:id/approve      선정
//   POST  /admin/applications/:id/reject       반려  { reason? }
//   POST  /admin/applications/:id/complete     최종 승인 (수수료 차감)
//   POST  /admin/applications/:id/noshow       노쇼 처리
//   GET   /admin/guests[?blocked=1]            게스트 목록
//   POST  /admin/guests/:id/block              수동 차단/해제  { blocked: boolean }
//
// 관리자 판별: Authorization 토큰의 user id 가 admins 테이블에 있어야 함 (요청 body 는 신뢰하지 않음)
// 점주 대행 처리(선정/반려/승인/노쇼)는 신청 → 파티 → 점포를 서버에서 조회해 넘깁니다.
// =====================================================================
import { db, fromDbError, HttpError, readJson, requireUser, rpc, UUID_RE } from "./common.ts";

type Result = { status: number; body: unknown };
const ok = (body: unknown, status = 200): Result => ({ status, body });

const SLOT_STATUSES = ["DRAFT", "OPEN", "CLOSED", "CANCELLED", "FINISHED"];
const APP_STATUSES = ["APPLIED", "APPROVED", "REJECTED", "CANCELLED", "VISITED", "MISSION_SUBMITTED", "COMPLETED", "NOSHOW"];
const CATEGORIES = ["혼술바", "소개팅", "소셜파티"];
const MAX_LIMIT = 500;

// ---------------------------------------------------------------------
// 인증
// ---------------------------------------------------------------------
async function requireAdmin(req: Request): Promise<string> {
  const user = await requireUser(req);
  const { data, error } = await db.from("admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (error) throw fromDbError(error);
  if (!data) throw new HttpError(403, "관리자 권한이 필요합니다.", "FORBIDDEN");
  return user.id;
}

// ---------------------------------------------------------------------
// 입력 검증 유틸
// ---------------------------------------------------------------------
function requireUuid(v: unknown, msg: string): string {
  const s = String(v ?? "");
  if (!UUID_RE.test(s)) throw new HttpError(404, msg);
  return s;
}

function str(v: unknown, field: string, max: number, required = false): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${field}을(를) 입력해 주세요.`);
    return null;
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} 형식이 올바르지 않습니다.`);
  const t = v.trim();
  if (required && !t) throw new HttpError(400, `${field}을(를) 입력해 주세요.`);
  return t.slice(0, max);
}

function int(v: unknown, field: string, min: number, max: number): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${field} 값을 확인해 주세요.`);
  }
  return n;
}

function isoDate(v: unknown, field: string): string {
  const d = new Date(String(v ?? ""));
  if (typeof v !== "string" || Number.isNaN(d.getTime())) throw new HttpError(400, `${field} 형식이 올바르지 않습니다.`);
  return d.toISOString();
}

function strArray(v: unknown, field: string, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v) || v.length > maxItems || v.some((x) => typeof x !== "string" || x.length > maxLen)) {
    throw new HttpError(400, `${field} 형식이 올바르지 않습니다.`);
  }
  return v as string[];
}

function limitOf(url: URL): number {
  const n = Number(url.searchParams.get("limit") ?? 100);
  return Number.isInteger(n) && n > 0 ? Math.min(n, MAX_LIMIT) : 100;
}

function oneOf(v: string | null, allowed: string[], field: string): string | null {
  if (v === null || v === "") return null;
  if (!allowed.includes(v)) throw new HttpError(400, `${field} 값이 올바르지 않습니다.`);
  return v;
}

// ---------------------------------------------------------------------
// 점포 / 적립금
// ---------------------------------------------------------------------
async function listStores(url: URL) {
  const { data, error } = await db.from("stores")
    .select("id, name, owner_name, phone, address, address_detail, region, prepaid_balance, default_fee_per_guest, is_active, created_at")
    .order("created_at", { ascending: false }).limit(limitOf(url));
  if (error) throw fromDbError(error);
  return (data ?? []).map((s) => ({
    id: s.id, name: s.name, ownerName: s.owner_name, phone: s.phone,
    address: [s.address, s.address_detail].filter(Boolean).join(" "), region: s.region,
    prepaidBalance: s.prepaid_balance, defaultFeePerGuest: s.default_fee_per_guest,
    isActive: s.is_active, createdAt: s.created_at,
  }));
}

async function listDeposits(storeId: string, url: URL) {
  const { data, error } = await db.from("deposit_histories")
    .select("id, application_id, type, amount, balance_before, balance_after, depositor_name, memo, created_at")
    .eq("store_id", storeId).order("id", { ascending: false }).limit(limitOf(url));
  if (error) throw fromDbError(error);
  return (data ?? []).map((d) => ({
    id: d.id, applicationId: d.application_id, type: d.type, amount: d.amount,
    balanceBefore: d.balance_before, balanceAfter: d.balance_after,
    depositorName: d.depositor_name, memo: d.memo, createdAt: d.created_at,
  }));
}

// ---------------------------------------------------------------------
// 파티
// ---------------------------------------------------------------------
type SlotRow = {
  id: string; store_id: string; title: string; description: string | null; benefit: string;
  category: string | null; images: string[]; badges: string[]; is_featured: boolean;
  starts_at: string; ends_at: string; recruit_deadline: string; capacity: number;
  fee_per_guest: number; status: string; mission_requirements: unknown; created_at: string;
  stores?: { name: string; region: string | null } | null;
  applications?: { status: string }[];
};

const SLOT_SELECT =
  "id, store_id, title, description, benefit, category, images, badges, is_featured, starts_at, ends_at, " +
  "recruit_deadline, capacity, fee_per_guest, status, mission_requirements, created_at, stores(name, region), applications(status)";

const TAKEN = ["APPROVED", "VISITED", "MISSION_SUBMITTED", "COMPLETED", "NOSHOW"];

function toParty(r: SlotRow) {
  const apps = r.applications ?? [];
  return {
    id: r.id, storeId: r.store_id, storeName: r.stores?.name ?? "", region: r.stores?.region ?? "",
    title: r.title, description: r.description, benefit: r.benefit, category: r.category,
    images: r.images, badges: r.badges, isFeatured: r.is_featured,
    startsAt: r.starts_at, endsAt: r.ends_at, recruitDeadline: r.recruit_deadline,
    capacity: r.capacity, feePerGuest: r.fee_per_guest, status: r.status,
    missionRequirements: r.mission_requirements, createdAt: r.created_at,
    selectedCount: apps.filter((a) => TAKEN.includes(a.status)).length,
    applicantCount: apps.filter((a) => !["REJECTED", "CANCELLED"].includes(a.status)).length,
  };
}

async function listParties(url: URL) {
  const status = oneOf(url.searchParams.get("status"), SLOT_STATUSES, "status");
  let q = db.from("party_slots").select(SLOT_SELECT);
  if (status) q = q.eq("status", status);
  const { data, error } = await q.order("starts_at", { ascending: false }).limit(limitOf(url));
  if (error) throw fromDbError(error);
  return ((data ?? []) as unknown as SlotRow[]).map(toParty);
}

// body(camelCase) → 컬럼. partial=true 이면 들어온 필드만 (PATCH)
function slotColumns(body: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const has = (k: string) => body[k] !== undefined;
  const need = (k: string) => partial ? has(k) : true;
  const c: Record<string, unknown> = {};

  if (need("title")) c.title = str(body.title, "제목", 100, true);
  if (has("description")) c.description = str(body.description, "설명", 2000);
  if (need("benefit")) c.benefit = str(body.benefit, "혜택", 500, true);
  if (need("startsAt")) c.starts_at = isoDate(body.startsAt, "시작 시각");
  if (need("endsAt")) c.ends_at = isoDate(body.endsAt, "종료 시각");
  if (need("recruitDeadline")) c.recruit_deadline = isoDate(body.recruitDeadline, "모집 마감");
  if (need("capacity")) c.capacity = int(body.capacity, "정원", 1, 1000);
  if (has("feePerGuest")) c.fee_per_guest = int(body.feePerGuest, "인당 수수료", 0, 10_000_000);
  if (has("category")) {
    const cat = str(body.category, "카테고리", 20);
    if (cat !== null && !CATEGORIES.includes(cat)) throw new HttpError(400, "카테고리 값이 올바르지 않습니다.");
    c.category = cat;
  }
  if (has("images")) c.images = strArray(body.images, "이미지", 10, 1000);
  if (has("badges")) c.badges = strArray(body.badges, "배지", 10, 20);
  if (has("isFeatured")) {
    if (typeof body.isFeatured !== "boolean") throw new HttpError(400, "추천 여부 형식이 올바르지 않습니다.");
    c.is_featured = body.isFeatured;
  }
  if (has("missionRequirements")) {
    const m = body.missionRequirements;
    if (!m || typeof m !== "object" || Array.isArray(m)) throw new HttpError(400, "미션 조건 형식이 올바르지 않습니다.");
    c.mission_requirements = m;
  }
  if (has("status")) {
    const s = oneOf(String(body.status), SLOT_STATUSES, "status");
    c.status = s;
  }
  return c;
}

async function createParty(body: Record<string, unknown>) {
  const storeId = requireUuid(body.storeId, "점포를 찾을 수 없습니다.");
  const cols = slotColumns(body, false);
  if (cols.status && !["DRAFT", "OPEN"].includes(cols.status as string)) {
    throw new HttpError(400, "새 파티는 DRAFT 또는 OPEN 상태로만 등록할 수 있습니다.");
  }
  // fee_per_guest 를 생략하면 DB 트리거가 점포 기본 수수료를 채움
  const { data, error } = await db.from("party_slots")
    .insert({ ...cols, store_id: storeId }).select(SLOT_SELECT).single();
  if (error) throw fromDbError(error);
  return toParty(data as unknown as SlotRow);
}

async function updateParty(id: string, body: Record<string, unknown>) {
  if ("storeId" in body) throw new HttpError(400, "파티의 점포는 변경할 수 없습니다.");
  const cols = slotColumns(body, true);
  if (Object.keys(cols).length === 0) throw new HttpError(400, "변경할 내용이 없습니다.");
  const { data, error } = await db.from("party_slots").update(cols).eq("id", id).select(SLOT_SELECT).maybeSingle();
  if (error) throw fromDbError(error);
  if (!data) throw new HttpError(404, "대상을 찾을 수 없습니다.");
  return toParty(data as unknown as SlotRow);
}

// ---------------------------------------------------------------------
// 신청
// ---------------------------------------------------------------------
async function listApplications(url: URL) {
  const slotId = url.searchParams.get("slotId");
  if (slotId && !UUID_RE.test(slotId)) throw new HttpError(400, "slotId 값이 올바르지 않습니다.");
  const status = oneOf(url.searchParams.get("status"), APP_STATUSES, "status");

  let q = db.from("applications").select(
    "id, slot_id, status, visit_code, mission_url, applied_at, approved_at, visited_at, mission_submitted_at, " +
      "completed_at, noshow_at, fee_amount, reject_reason, " +
      "guests(id, name, phone, email, instagram_handle, noshow_count, penalty_count, is_blocked, blocked_until), " +
      "party_slots(title, starts_at, store_id, stores(name))",
  );
  if (slotId) q = q.eq("slot_id", slotId);
  if (status) q = q.eq("status", status);
  const { data, error } = await q.order("applied_at", { ascending: false }).limit(limitOf(url));
  if (error) throw fromDbError(error);

  // deno-lint-ignore no-explicit-any
  return ((data ?? []) as any[]).map((a) => ({
    id: a.id, slotId: a.slot_id, status: a.status, visitCode: a.visit_code, missionUrl: a.mission_url,
    appliedAt: a.applied_at, approvedAt: a.approved_at, visitedAt: a.visited_at,
    missionSubmittedAt: a.mission_submitted_at, completedAt: a.completed_at, noshowAt: a.noshow_at,
    feeAmount: a.fee_amount, rejectReason: a.reject_reason,
    partyTitle: a.party_slots?.title ?? "", partyStartsAt: a.party_slots?.starts_at ?? null,
    storeId: a.party_slots?.store_id ?? null, storeName: a.party_slots?.stores?.name ?? "",
    guest: a.guests && {
      id: a.guests.id, name: a.guests.name, phone: a.guests.phone, email: a.guests.email,
      instagram: a.guests.instagram_handle, noshowCount: a.guests.noshow_count,
      penaltyCount: a.guests.penalty_count, isBlocked: a.guests.is_blocked, blockedUntil: a.guests.blocked_until,
    },
  }));
}

// 신청 → 점포 id (점주 대행 처리용)
async function storeOfApplication(applicationId: string): Promise<string> {
  const { data, error } = await db.from("applications")
    .select("party_slots(store_id)").eq("id", applicationId).maybeSingle();
  if (error) throw fromDbError(error);
  // deno-lint-ignore no-explicit-any
  const storeId = (data as any)?.party_slots?.store_id;
  if (!storeId) throw new HttpError(404, "대상을 찾을 수 없습니다.");
  return storeId;
}

// ---------------------------------------------------------------------
// 게스트
// ---------------------------------------------------------------------
async function listGuests(url: URL) {
  let q = db.from("guests").select(
    "id, name, phone, email, instagram_handle, follower_count, noshow_count, penalty_count, is_blocked, blocked_until, created_at",
  );
  if (url.searchParams.get("blocked") === "1") q = q.or(`is_blocked.eq.true,blocked_until.gt.${new Date().toISOString()}`);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(limitOf(url));
  if (error) throw fromDbError(error);
  return (data ?? []).map((g) => ({
    id: g.id, name: g.name, phone: g.phone, email: g.email, instagram: g.instagram_handle,
    followerCount: g.follower_count, noshowCount: g.noshow_count, penaltyCount: g.penalty_count,
    isBlocked: g.is_blocked, blockedUntil: g.blocked_until, createdAt: g.created_at,
  }));
}

async function setGuestBlocked(id: string, body: Record<string, unknown>) {
  if (typeof body.blocked !== "boolean") throw new HttpError(400, "blocked 값은 true 또는 false 여야 합니다.");
  // 해제 시 벌점 자동 차단(blocked_until)도 함께 풀어 줌
  const patch = body.blocked ? { is_blocked: true } : { is_blocked: false, blocked_until: null };
  const { data, error } = await db.from("guests").update(patch).eq("id", id)
    .select("id, is_blocked, blocked_until").maybeSingle();
  if (error) throw fromDbError(error);
  if (!data) throw new HttpError(404, "대상을 찾을 수 없습니다.");
  return { id: data.id, isBlocked: data.is_blocked, blockedUntil: data.blocked_until };
}

// ---------------------------------------------------------------------
// 라우터  (path 는 "/admin" 이후 부분)
// ---------------------------------------------------------------------
export async function adminRoute(req: Request, path: string): Promise<Result | null> {
  const url = new URL(req.url);
  const m = req.method;
  const seg = path.split("/").filter(Boolean); // ["stores", ":id", "charge"]
  const known = ["me", "stores", "parties", "applications", "guests"];
  if (!known.includes(seg[0] ?? "")) return null;

  const adminId = await requireAdmin(req); // 라우트가 존재하더라도 먼저 인증 → 구조 노출 최소화

  if (seg[0] === "me" && seg.length === 1 && m === "GET") return ok({ isAdmin: true, userId: adminId });

  if (seg[0] === "stores") {
    if (seg.length === 1 && m === "GET") return ok(await listStores(url));
    const id = seg[1] ? requireUuid(seg[1], "점포를 찾을 수 없습니다.") : "";
    if (seg.length === 3 && seg[2] === "deposits" && m === "GET") return ok(await listDeposits(id, url));
    if (seg.length === 3 && seg[2] === "charge" && m === "POST") {
      const b = await readJson(req);
      return ok(await rpc("charge_deposit", {
        p_store_id: id, p_amount: int(b.amount, "충전 금액", 1, 1_000_000_000),
        p_depositor_name: str(b.depositorName, "입금자명", 50, true), p_admin_user_id: adminId,
        p_memo: str(b.memo, "메모", 500),
      }));
    }
    if (seg.length === 3 && seg[2] === "refund" && m === "POST") {
      const b = await readJson(req);
      return ok(await rpc("refund_deposit", {
        p_store_id: id, p_amount: int(b.amount, "환불 금액", 1, 1_000_000_000),
        p_admin_user_id: adminId, p_memo: str(b.memo, "메모", 500),
      }));
    }
  }

  if (seg[0] === "parties") {
    if (seg.length === 1 && m === "GET") return ok(await listParties(url));
    if (seg.length === 1 && m === "POST") return ok(await createParty(await readJson(req)), 201);
    if (seg.length === 2 && m === "PATCH") {
      return ok(await updateParty(requireUuid(seg[1], "대상을 찾을 수 없습니다."), await readJson(req)));
    }
  }

  if (seg[0] === "applications") {
    if (seg.length === 1 && m === "GET") return ok(await listApplications(url));
    if (seg.length === 3 && m === "POST") {
      const appId = requireUuid(seg[1], "대상을 찾을 수 없습니다.");
      const action = seg[2];
      if (["approve", "reject", "complete", "noshow"].includes(action)) {
        const storeId = await storeOfApplication(appId);
        if (action === "approve") return ok(await rpc("approve_application", { p_application_id: appId, p_store_id: storeId }));
        if (action === "reject") {
          const b = await readJson(req);
          return ok(await rpc("reject_application", {
            p_application_id: appId, p_store_id: storeId, p_reason: str(b.reason, "반려 사유", 500),
          }));
        }
        if (action === "complete") {
          return ok(await rpc("complete_application", {
            p_application_id: appId, p_store_id: storeId, p_actor_user_id: adminId,
          }));
        }
        return ok(await rpc("mark_noshow", { p_application_id: appId, p_store_id: storeId }));
      }
    }
  }

  if (seg[0] === "guests") {
    if (seg.length === 1 && m === "GET") return ok(await listGuests(url));
    if (seg.length === 3 && seg[2] === "block" && m === "POST") {
      return ok(await setGuestBlocked(requireUuid(seg[1], "대상을 찾을 수 없습니다."), await readJson(req)));
    }
  }

  return null;
}
