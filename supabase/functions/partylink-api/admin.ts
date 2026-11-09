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

const BRN_RE = /^\d{3}-\d{2}-\d{5}$/;

// 점포 body(camelCase) → 컬럼. 사업자번호·점주 계정·잔액은 수정할 수 없음
function storeColumns(body: Record<string, unknown>, partial: boolean): Record<string, unknown> {
  const has = (k: string) => body[k] !== undefined;
  const need = (k: string) => partial ? has(k) : true;
  const c: Record<string, unknown> = {};
  if (need("name")) c.name = str(body.name, "점포명", 100, true);
  if (need("ownerName")) c.owner_name = str(body.ownerName, "대표자명", 50, true);
  if (need("phone")) {
    const p = str(body.phone, "연락처", 20, true) as string;
    if (!/^[0-9-]{9,20}$/.test(p)) throw new HttpError(400, "연락처를 정확히 입력해 주세요. (예: 01012345678)");
    c.phone = p;
  }
  if (need("address")) c.address = str(body.address, "주소", 200, true);
  if (has("addressDetail")) c.address_detail = str(body.addressDetail, "상세 주소", 200);
  if (has("region")) c.region = str(body.region, "지역", 50);
  if (has("instagram")) c.instagram_handle = str(body.instagram, "인스타그램", 50);
  if (has("defaultFeePerGuest")) c.default_fee_per_guest = int(body.defaultFeePerGuest, "기본 수수료", 0, 10_000_000);
  if (has("isActive")) {
    if (typeof body.isActive !== "boolean") throw new HttpError(400, "운영 여부 형식이 올바르지 않습니다.");
    c.is_active = body.isActive;
  }
  return c;
}

const STORE_SELECT =
  "id, name, owner_name, phone, address, address_detail, region, prepaid_balance, default_fee_per_guest, is_active, created_at";

// deno-lint-ignore no-explicit-any
function toStore(s: any) {
  return {
    id: s.id, name: s.name, ownerName: s.owner_name, phone: s.phone,
    address: [s.address, s.address_detail].filter(Boolean).join(" "), region: s.region,
    prepaidBalance: s.prepaid_balance, defaultFeePerGuest: s.default_fee_per_guest,
    isActive: s.is_active, createdAt: s.created_at,
  };
}

// 점주 계정이 아직 없는 점포도 등록할 수 있게, ownerUserId 를 생략하면 임시 UUID 를 부여
async function createStore(body: Record<string, unknown>) {
  const brn = str(body.businessRegNo, "사업자등록번호", 12, true) as string;
  if (!BRN_RE.test(brn)) throw new HttpError(400, "사업자등록번호 형식이 올바르지 않습니다. (예: 123-45-67890)");
  if (body.ownerUserId !== undefined && !(typeof body.ownerUserId === "string" && UUID_RE.test(body.ownerUserId))) {
    throw new HttpError(400, "점주 계정 값이 올바르지 않습니다.");
  }
  // 점주 로그인은 MVP 범위 밖이라 생략을 허용한다 (임의 UUID = 아직 연결된 점주 계정이 없다는 표시).
  // 값을 주면 실제 로그인 계정인지 확인한다. 존재하지 않는 계정이 점주로 묶이는 것을 막는다.
  let owner: string = crypto.randomUUID();
  if (body.ownerUserId !== undefined) {
    owner = body.ownerUserId as string;
    const { data: u, error: uErr } = await db.auth.admin.getUserById(owner);
    if (uErr && uErr.status !== 404) throw uErr;
    if (uErr || !u?.user) throw new HttpError(400, "점주 계정을 찾을 수 없습니다. 로그인한 적이 있는 계정의 ID인지 확인해 주세요.");
  }
  const cols = storeColumns(body, false);
  const { data, error } = await db.from("stores")
    .insert({ ...cols, business_reg_no: brn, owner_user_id: owner }).select(STORE_SELECT).single();
  if (error) throw fromDbError(error);
  return toStore(data);
}

async function updateStore(id: string, body: Record<string, unknown>) {
  for (const k of ["businessRegNo", "ownerUserId", "prepaidBalance"]) {
    if (k in body) throw new HttpError(400, "이 항목은 수정할 수 없습니다.");
  }
  const cols = storeColumns(body, true);
  if (Object.keys(cols).length === 0) throw new HttpError(400, "변경할 내용이 없습니다.");
  const { data, error } = await db.from("stores").update(cols).eq("id", id).select(STORE_SELECT).maybeSingle();
  if (error) throw fromDbError(error);
  if (!data) throw new HttpError(404, "대상을 찾을 수 없습니다.");
  return toStore(data);
}

// ---------------------------------------------------------------------
// 대시보드 집계
// ---------------------------------------------------------------------
// deno-lint-ignore no-explicit-any
async function countOf(table: string, filter: (q: any) => any): Promise<number> {
  const { count, error } = await filter(db.from(table).select("id", { count: "exact", head: true }));
  if (error) throw fromDbError(error);
  return count ?? 0;
}

async function summary() {
  const now = new Date();
  const weekEnd = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const [pendingApplications, openParties, partiesThisWeek, blockedGuests, stores, upcoming] = await Promise.all([
    countOf("applications", (q) => q.eq("status", "APPLIED")),
    countOf("party_slots", (q) => q.eq("status", "OPEN")),
    countOf("party_slots", (q) => q.in("status", ["OPEN", "CLOSED"]).gte("starts_at", now.toISOString()).lte("starts_at", weekEnd.toISOString())),
    countOf("guests", (q) => q.eq("is_blocked", true)),
    db.from("stores").select("id, prepaid_balance").eq("is_active", true).limit(1000),
    db.from("party_slots").select("store_id, fee_per_guest").in("status", ["OPEN", "CLOSED"]).gte("starts_at", now.toISOString()).limit(5000),
  ]);
  if (stores.error) throw fromDbError(stores.error);
  if (upcoming.error) throw fromDbError(upcoming.error);
  // 다가오는 파티(모집 중·마감)의 인당 수수료 중 가장 큰 값보다 잔액이 적으면, 다음 최종 승인에서 부족해질 수 있다.
  // 점포 기본 수수료가 아니라 실제 파티 수수료 기준이며, 다가오는 파티가 없는 점포는 세지 않는다.
  const maxFee = new Map<string, number>();
  for (const s of upcoming.data ?? []) maxFee.set(s.store_id, Math.max(maxFee.get(s.store_id) ?? 0, s.fee_per_guest ?? 0));
  const lowBalanceStores = (stores.data ?? []).filter((s) => s.prepaid_balance < (maxFee.get(s.id) ?? 0)).length;
  return { pendingApplications, openParties, partiesThisWeek, lowBalanceStores, blockedGuests, asOf: now.toISOString() };
}

// ---------------------------------------------------------------------
// 방문 인증 대행 — 신청에 발급된 방문 코드를 입력받아 해당 신청에 대해서만 인증
// ---------------------------------------------------------------------
async function verifyVisitFor(applicationId: string, body: Record<string, unknown>) {
  const code = str(body.code, "방문 코드", 32, true) as string;
  const { data, error } = await db.from("applications")
    .select("visit_code, party_slots(store_id)").eq("id", applicationId).maybeSingle();
  if (error) throw fromDbError(error);
  // deno-lint-ignore no-explicit-any
  const row = data as any;
  const storeId = row?.party_slots?.store_id;
  if (!row || !storeId) throw new HttpError(404, "대상을 찾을 수 없습니다.");
  // DB 의 normalize_visit_code 와 같은 규칙으로 비교 (공백·하이픈 제거, 대문자, O→0, I/L→1)
  const norm = (s: string) => s.replace(/[\s-]/g, "").toUpperCase().replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!row.visit_code || norm(code) !== norm(row.visit_code)) {
    throw new HttpError(404, "방문 코드가 일치하지 않습니다.");
  }
  return await rpc("verify_visit", { p_store_id: storeId, p_visit_code: code });
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

// 파티 상태 전이 (CANCELLED / FINISHED 는 최종 상태라 되살릴 수 없다)
const SLOT_NEXT: Record<string, string[]> = {
  DRAFT: ["OPEN", "CANCELLED"],
  OPEN: ["CLOSED", "CANCELLED"],
  CLOSED: ["OPEN", "FINISHED", "CANCELLED"],
};
const SLOT_KO: Record<string, string> = {
  DRAFT: "작성 중", OPEN: "모집 중", CLOSED: "모집 마감", CANCELLED: "취소", FINISHED: "종료",
};

async function updateParty(id: string, body: Record<string, unknown>) {
  if ("storeId" in body) throw new HttpError(400, "파티의 점포는 변경할 수 없습니다.");
  const cols = slotColumns(body, true);
  if (Object.keys(cols).length === 0) throw new HttpError(400, "변경할 내용이 없습니다.");

  // 상태·정원을 바꿀 때만 현재 값을 읽어 검증한다 (DB 에는 이 규칙을 강제하는 트리거가 없다)
  let guardStatus: string | null = null;
  if (cols.status !== undefined || cols.capacity !== undefined) {
    const { data: cur, error: curErr } = await db.from("party_slots")
      .select("status, capacity, applications(status)").eq("id", id).maybeSingle();
    if (curErr) throw fromDbError(curErr);
    // deno-lint-ignore no-explicit-any
    const row = cur as any;
    if (!row) throw new HttpError(404, "대상을 찾을 수 없습니다.");

    if (cols.status !== undefined && cols.status !== row.status) {
      if (!(SLOT_NEXT[row.status] ?? []).includes(cols.status as string)) {
        throw new HttpError(
          409,
          `파티가 '${SLOT_KO[row.status] ?? row.status}' 상태라 '${SLOT_KO[cols.status as string] ?? cols.status}'(으)로 바꿀 수 없습니다.`,
          "PL409",
        );
      }
      guardStatus = row.status; // 읽은 뒤 다른 곳에서 바뀌었다면 갱신이 적용되지 않도록 조건을 건다
    }
    if (cols.capacity !== undefined) {
      const taken = ((row.applications ?? []) as { status: string }[]).filter((a) => TAKEN.includes(a.status)).length;
      if ((cols.capacity as number) < taken) {
        throw new HttpError(409, `이미 ${taken}명이 선정되어 있어 정원을 ${taken}명보다 적게 줄일 수 없습니다.`, "PL409");
      }
    }
  }

  let q = db.from("party_slots").update(cols).eq("id", id);
  if (guardStatus) q = q.eq("status", guardStatus);
  const { data, error } = await q.select(SLOT_SELECT).maybeSingle();
  if (error) throw fromDbError(error);
  if (!data) {
    if (guardStatus) throw new HttpError(409, "다른 곳에서 먼저 파티 상태가 바뀌었습니다. 목록을 새로고침해 주세요.", "PL409");
    throw new HttpError(404, "대상을 찾을 수 없습니다.");
  }
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
  const known = ["me", "summary", "stores", "parties", "applications", "guests"];
  if (!known.includes(seg[0] ?? "")) return null;

  const adminId = await requireAdmin(req); // 라우트가 존재하더라도 먼저 인증 → 구조 노출 최소화

  if (seg[0] === "me" && seg.length === 1 && m === "GET") return ok({ isAdmin: true, userId: adminId });

  if (seg[0] === "summary" && seg.length === 1 && m === "GET") return ok(await summary());

  if (seg[0] === "stores") {
    if (seg.length === 1 && m === "GET") return ok(await listStores(url));
    if (seg.length === 1 && m === "POST") return ok(await createStore(await readJson(req)), 201);
    const id = seg[1] ? requireUuid(seg[1], "점포를 찾을 수 없습니다.") : "";
    if (seg.length === 2 && m === "PATCH") return ok(await updateStore(id, await readJson(req)));
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
      if (action === "verify-visit") return ok(await verifyVisitFor(appId, await readJson(req)));
      // 미션 보완 요청: MISSION_SUBMITTED → VISITED (게스트가 같은 신청에 다시 제출)
      if (action === "request-revision") return ok(await rpc("request_mission_revision", { p_application_id: appId }));
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
