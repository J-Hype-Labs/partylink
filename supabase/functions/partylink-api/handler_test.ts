// partylink-api 단위 테스트 — Supabase Auth / PostgREST HTTP 를 가짜 fetch 로 대체
// 실행: deno test --allow-env supabase/functions/partylink-api/handler_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.8";

const URL_BASE = "http://supabase.test";
Deno.env.set("SUPABASE_URL", URL_BASE);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");

type Call = { fn: string; args: Record<string, unknown> };
let rpcCalls: Call[] = [];
let rpcImpl: (fn: string, args: Record<string, unknown>) => Response = () => new Response("[]");
type TableCall = { table: string; method: string; params: Record<string, string>; body?: unknown };
let tableCalls: TableCall[] = [];
let tableImpl: ((c: TableCall) => Response | undefined) | null = null;
const ADMIN_USER = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "admin@example.com", aud: "authenticated", role: "authenticated" };
const USER = { id: "11111111-1111-4111-8111-111111111111", email: "kakao@example.com", aud: "authenticated", role: "authenticated" };
const GUEST_ID = "22222222-2222-4222-8222-222222222222";
const SLOT_ID = "33333333-3333-4333-8333-333333333333";

const jsonRes = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// supabase-js 는 생성 시점의 fetch 를 잡으므로 import 전에 교체
globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = new Request(input, init);
  const u = new URL(req.url);
  if (u.pathname === "/auth/v1/user") {
    const auth = req.headers.get("Authorization");
    return auth === "Bearer good-token" ? jsonRes(200, USER)
      : auth === "Bearer admin-token" ? jsonRes(200, ADMIN_USER)
      : jsonRes(401, { code: 401, msg: "invalid JWT" });
  }
  if (u.pathname.startsWith("/rest/v1/rpc/")) {
    const fn = u.pathname.slice("/rest/v1/rpc/".length);
    const args = JSON.parse((await req.text()) || "{}");
    rpcCalls.push({ fn, args });
    return rpcImpl(fn, args);
  }
  if (u.pathname.startsWith("/rest/v1/") && tableImpl) {
    const text = await req.text();
    const c: TableCall = {
      table: u.pathname.slice("/rest/v1/".length), method: req.method,
      params: Object.fromEntries(u.searchParams), body: text ? JSON.parse(text) : undefined,
    };
    tableCalls.push(c);
    const r = tableImpl(c);
    if (r) return r;
  }
  if (u.pathname === "/rest/v1/guests") {
    return u.searchParams.get("user_id") === `eq.${USER.id}` ? jsonRes(200, [{ id: GUEST_ID }]) : jsonRes(200, []);
  }
  return jsonRes(404, { message: `unexpected ${req.method} ${u.pathname}` });
}) as typeof fetch;

const { handler } = await import("./handler.ts");

const call = (method: string, path: string, opts: { token?: string; body?: unknown; origin?: string } = {}) =>
  handler(new Request(`${URL_BASE}/functions/v1/partylink-api${path}`, {
    method,
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.origin ? { Origin: opts.origin } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  }));

const reset = () => { rpcCalls = []; rpcImpl = () => jsonRes(200, []); tableCalls = []; tableImpl = null; };

Deno.test("GET /parties maps DB rows to the web card shape (KST weekday, default image)", async () => {
  reset();
  rpcImpl = () => jsonRes(200, [{
    id: SLOT_ID, title: "금요 혼술", description: null, benefit: "하이볼 2잔", category: "혼술바",
    images: [], badges: ["NEW"], is_featured: true,
    starts_at: "2026-11-06T15:30:00+00:00", // KST 2026-11-07 00:30 → 토
    ends_at: "2026-11-06T18:00:00+00:00", recruit_deadline: "2026-11-06T10:00:00+00:00",
    capacity: 6, selected_count: 2, applicant_count: 5, mission_requirements: {},
    store_name: "43번지 혼술바", store_address: "서울 중구 을지로11길 19", store_region: "명동/을지로",
  }]);
  const res = await call("GET", "/parties");
  assertEquals(res.status, 200);
  const [p] = await res.json();
  assertEquals(p.days, ["토"]);
  assertEquals([p.recruit, p.currentRecruit, p.applicantCount], [6, 2, 5]);
  assertEquals([p.venue, p.region, p.category, p.desc], ["43번지 혼술바", "명동/을지로", "혼술바", "하이볼 2잔"]);
  assertEquals(p.images.length, 1);
  assert(p.live);
  assertEquals(rpcCalls.map((c) => c.fn), ["list_open_parties"]);
});

Deno.test("login-required routes reject missing / invalid tokens with 401", async () => {
  reset();
  assertEquals((await call("GET", "/applications")).status, 401);
  assertEquals((await call("GET", "/applications", { token: "forged" })).status, 401);
  assertEquals((await call("POST", "/applications", { token: "forged", body: { slotId: SLOT_ID } })).status, 401);
  assertEquals(rpcCalls.length, 0);
});

Deno.test("POST /applications uses the token's user id, ignoring ids in the body", async () => {
  reset();
  rpcImpl = (fn) =>
    fn === "upsert_guest_profile" ? jsonRes(200, GUEST_ID)
    : fn === "apply_to_slot" ? jsonRes(200, { application_id: "app-1", status: "APPLIED", visit_code: "ABC" })
    : jsonRes(500, {});
  const res = await call("POST", "/applications", {
    token: "good-token",
    body: { slotId: SLOT_ID, name: "홍길동", phone: "010-1234-5678", agree: true,
            userId: "99999999-9999-4999-8999-999999999999", guestId: "99999999-9999-4999-8999-999999999999" },
  });
  assertEquals(res.status, 201);
  assertEquals(await res.json(), { id: "app-1", status: "APPLIED" });
  assertEquals(rpcCalls, [
    { fn: "upsert_guest_profile", args: { p_user_id: USER.id, p_name: "홍길동", p_phone: "010-1234-5678", p_email: USER.email } },
    { fn: "apply_to_slot", args: { p_slot_id: SLOT_ID, p_guest_id: GUEST_ID } },
  ]);
});

Deno.test("POST /applications validates consent and slot id before touching the DB", async () => {
  reset();
  const noAgree = await call("POST", "/applications", { token: "good-token", body: { slotId: SLOT_ID, name: "홍길동", phone: "01012345678" } });
  assertEquals(noAgree.status, 400);
  const badSlot = await call("POST", "/applications", { token: "good-token", body: { slotId: "1", name: "홍길동", phone: "01012345678", agree: true } });
  assertEquals(badSlot.status, 400);
  const badJson = await handler(new Request(`${URL_BASE}/functions/v1/partylink-api/applications`, {
    method: "POST", headers: { Authorization: "Bearer good-token", "Content-Type": "application/json" }, body: "{not json",
  }));
  assertEquals(badJson.status, 400);
  assertEquals(rpcCalls.length, 0);
});

Deno.test("DB error codes become Korean messages with matching HTTP status", async () => {
  const cases: [string, string, number, string][] = [
    ["PL409", "Guest already applied to slot x (or retry)", 409, "이미 신청한 파티입니다."],
    ["PL409", "Phone number is already registered to another account", 409, "이미 다른 계정에 등록된 연락처입니다."],
    ["PL410", "Slot x is full (1/1)", 410, "모집이 마감되었거나 정원이 찼습니다."],
    ["PL400", "Invalid phone number", 400, "연락처를 정확히 입력해 주세요. (예: 01012345678)"],
    ["PL423", "Guest x is blocked", 423, "노쇼 누적 등으로 신청이 제한된 계정입니다."],
    ["XX000", "relation secret_table does not exist", 500, "일시적인 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."],
  ];
  for (const [code, message, status, expected] of cases) {
    reset();
    rpcImpl = () => jsonRes(400, { code, message, details: code === "PL423" ? "2026-12-01" : null, hint: null });
    const res = await call("POST", "/applications", { token: "good-token", body: { slotId: SLOT_ID, name: "홍길동", phone: "01012345678", agree: true } });
    assertEquals(res.status, status, `${code} ${message}`);
    const body = await res.json();
    assertEquals(body.message, expected);
    assert(!JSON.stringify(body).includes("secret_table"), "internal DB messages must not leak");
  }
});

Deno.test("GET /applications returns only the caller's applications", async () => {
  reset();
  rpcImpl = () => jsonRes(200, [{
    id: "app-1", slot_id: SLOT_ID, status: "APPROVED", visit_code: "K7M2QX9HPA",
    applied_at: "2026-11-01T00:00:00Z", approved_at: "2026-11-02T00:00:00Z", visited_at: "2026-11-07T11:30:00Z", mission_url: "https://instagram.com/p/abc", reject_reason: null,
    title: "금요 혼술", starts_at: "2026-11-07T11:00:00Z", ends_at: "2026-11-07T14:00:00Z", store_name: "43번지 혼술바",
    guest_name: "홍길동", guest_phone: "01012345678",
  }]);
  const res = await call("GET", "/applications", { token: "good-token" });
  assertEquals(res.status, 200);
  const [a] = await res.json();
  assertEquals([a.partyId, a.status, a.visitCode, a.userId, a.day], [SLOT_ID, "APPROVED", "K7M2QX9HPA", USER.id, "토"]);
  // 마이페이지가 미션 제출/보완 요청 상태를 그릴 수 있어야 한다
  assertEquals([a.missionUrl, a.approvedAt, a.visitedAt], ["https://instagram.com/p/abc", "2026-11-02T00:00:00Z", "2026-11-07T11:30:00Z"]);
  assertEquals(rpcCalls, [{ fn: "guest_applications", args: { p_user_id: USER.id } }]);
});

Deno.test("POST /applications/:id/cancel resolves the guest from the token", async () => {
  reset();
  rpcImpl = () => jsonRes(200, { application_id: "a", status: "CANCELLED" });
  const appId = "44444444-4444-4444-8444-444444444444";
  const res = await call("POST", `/applications/${appId}/cancel`, { token: "good-token" });
  assertEquals(res.status, 200);
  assertEquals(rpcCalls, [{ fn: "cancel_application", args: { p_application_id: appId, p_guest_id: GUEST_ID } }]);
});

Deno.test("CORS preflight and unknown routes", async () => {
  reset();
  const pre = await call("OPTIONS", "/applications", { origin: "https://j-hype-labs.github.io" });
  assertEquals(pre.status, 204);
  assertEquals(pre.headers.get("Access-Control-Allow-Origin"), "*");
  assert((pre.headers.get("Access-Control-Allow-Headers") ?? "").includes("authorization"));
  assertEquals((await call("GET", "/nope")).status, 404);
  assertEquals((await call("DELETE", "/parties")).status, 404);
});

// ---------------------------------------------------------------------
// 관리자 API
// ---------------------------------------------------------------------
const STORE_ID = "55555555-5555-4555-8555-555555555555";
const APP_ID = "44444444-4444-4444-8444-444444444444";
const adminTables = (extra?: (c: TableCall) => Response | undefined) => (c: TableCall) =>
  c.table === "admins"
    ? jsonRes(200, c.params.user_id === `eq.${ADMIN_USER.id}` ? [{ user_id: ADMIN_USER.id }] : [])
    : extra?.(c);

Deno.test("admin routes: 401 without token, 403 for non-admin users, DB untouched", async () => {
  reset();
  tableImpl = adminTables();
  assertEquals((await call("GET", "/admin/stores")).status, 401);
  assertEquals((await call("GET", "/admin/stores", { token: "forged" })).status, 401);
  const res = await call("POST", `/admin/stores/${STORE_ID}/charge`, { token: "good-token", body: { amount: 1000, depositorName: "x" } });
  assertEquals(res.status, 403);
  assertEquals(rpcCalls.length, 0);
  assert(tableCalls.every((c) => c.table === "admins"), "non-admin must not reach other tables");
  assertEquals((await call("GET", "/admin/nope", { token: "admin-token" })).status, 404);
});

Deno.test("GET /admin/me confirms the admin from the token", async () => {
  reset();
  tableImpl = adminTables();
  const res = await call("GET", "/admin/me", { token: "admin-token" });
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { isAdmin: true, userId: ADMIN_USER.id });
});

Deno.test("POST /admin/stores/:id/charge passes the admin id from the token, validates amount", async () => {
  reset();
  tableImpl = adminTables();
  rpcImpl = () => jsonRes(200, { balance_after: 300000 });
  const res = await call("POST", `/admin/stores/${STORE_ID}/charge`, {
    token: "admin-token",
    body: { amount: 300000, depositorName: " 홍길동 ", memo: "11/6 입금", adminId: "evil" },
  });
  assertEquals(res.status, 200);
  assertEquals(rpcCalls, [{ fn: "charge_deposit", args: {
    p_store_id: STORE_ID, p_amount: 300000, p_depositor_name: "홍길동", p_admin_user_id: ADMIN_USER.id, p_memo: "11/6 입금",
  } }]);

  rpcCalls = [];
  for (const body of [{ amount: -1, depositorName: "a" }, { amount: 1.5, depositorName: "a" }, { amount: "abc", depositorName: "a" }, { amount: 1000 }]) {
    assertEquals((await call("POST", `/admin/stores/${STORE_ID}/charge`, { token: "admin-token", body })).status, 400);
  }
  assertEquals(rpcCalls.length, 0);
});

Deno.test("admin-facing DB errors explain what happened (shortage amount, party window, status)", async () => {
  const cases: [string, string, string | null, number, string][] = [
    ["PL402", "Insufficient prepaid balance: balance=3000, required=10000",
      JSON.stringify({ balance: 3000, required: 10000, shortage: 7000 }), 402,
      "적립금이 7,000원 부족합니다. (잔액 3,000원, 필요 10,000원) 점포·적립금에서 충전한 뒤 다시 승인해 주세요."],
    ["PL410", "Visit verification is only allowed during the party window", null, 410, "방문 인증은 파티 진행 시간에만 할 수 있습니다."],
    ["PL409", "Invalid status transition: COMPLETED -> COMPLETED", null, 409, "이미 처리된 신청입니다. 목록을 새로고침해 주세요."],
    ["PL409", "Invalid status transition: APPROVED -> COMPLETED", null, 409, "신청이 이미 '선정' 상태라 이 작업을 할 수 없습니다. 목록을 새로고침해 주세요."],
    ["PL409", "something unexpected", null, 409, "현재 상태에서는 처리할 수 없습니다."],
  ];
  for (const [code, message, details, status, expected] of cases) {
    reset();
    tableImpl = adminTables((c) => c.table === "applications" ? jsonRes(200, { party_slots: { store_id: STORE_ID } }) : undefined);
    rpcImpl = () => jsonRes(400, { code, message, details, hint: null });
    const res = await call("POST", `/admin/applications/${APP_ID}/complete`, { token: "admin-token" });
    assertEquals(res.status, status, `${code} ${message}`);
    assertEquals((await res.json()).message, expected);
  }
});

Deno.test("POST /admin/stores/:id/refund maps insufficient balance (PL402) to 402", async () => {
  reset();
  tableImpl = adminTables();
  rpcImpl = () => jsonRes(400, { code: "PL402", message: "Insufficient", details: JSON.stringify({ balance: 100 }) });
  const res = await call("POST", `/admin/stores/${STORE_ID}/refund`, { token: "admin-token", body: { amount: 5000 } });
  assertEquals(res.status, 402);
  assertEquals((await res.json()).message, "적립금 잔액이 부족합니다.");
});

Deno.test("POST /admin/applications/:id/approve resolves the store server-side", async () => {
  reset();
  tableImpl = adminTables((c) => c.table === "applications" ? jsonRes(200, { party_slots: { store_id: STORE_ID } }) : undefined);
  rpcImpl = () => jsonRes(200, { status: "APPROVED" });
  const res = await call("POST", `/admin/applications/${APP_ID}/approve`, { token: "admin-token", body: { storeId: "evil" } });
  assertEquals(res.status, 200);
  assertEquals(rpcCalls, [{ fn: "approve_application", args: { p_application_id: APP_ID, p_store_id: STORE_ID } }]);

  rpcCalls = [];
  await call("POST", `/admin/applications/${APP_ID}/complete`, { token: "admin-token" });
  assertEquals(rpcCalls, [{ fn: "complete_application", args: { p_application_id: APP_ID, p_store_id: STORE_ID, p_actor_user_id: ADMIN_USER.id } }]);

  rpcCalls = [];
  await call("POST", `/admin/applications/${APP_ID}/reject`, { token: "admin-token", body: { reason: "조건 불충족" } });
  assertEquals(rpcCalls, [{ fn: "reject_application", args: { p_application_id: APP_ID, p_store_id: STORE_ID, p_reason: "조건 불충족" } }]);
});

Deno.test("admin application actions return 404 when the application does not exist", async () => {
  reset();
  tableImpl = adminTables((c) => c.table === "applications" ? jsonRes(200, []) : undefined);
  const res = await call("POST", `/admin/applications/${APP_ID}/approve`, { token: "admin-token" });
  assertEquals(res.status, 404);
  assertEquals(rpcCalls.length, 0);
});

Deno.test("POST /admin/parties validates input and inserts only whitelisted columns", async () => {
  reset();
  const good = {
    storeId: STORE_ID, title: "금요 혼술", benefit: "하이볼 2잔", capacity: 6, category: "혼술바", status: "OPEN",
    startsAt: "2026-11-13T10:00:00Z", endsAt: "2026-11-13T13:00:00Z", recruitDeadline: "2026-11-12T14:59:00Z",
    images: ["https://x/y.jpg"], badges: ["NEW"], isFeatured: false, id: "evil", prepaid_balance: 1,
  };
  tableImpl = adminTables((c) => c.table === "party_slots" && c.method === "POST"
    ? jsonRes(201, { id: SLOT_ID, store_id: STORE_ID, title: "금요 혼술", benefit: "하이볼 2잔", status: "OPEN", capacity: 6,
        images: [], badges: [], is_featured: false, fee_per_guest: 10000, stores: { name: "43번지", region: "명동/을지로" },
        applications: [{ status: "APPROVED" }, { status: "APPLIED" }, { status: "REJECTED" }] })
    : undefined);
  const res = await call("POST", "/admin/parties", { token: "admin-token", body: good });
  assertEquals(res.status, 201);
  const party = await res.json();
  assertEquals([party.selectedCount, party.applicantCount, party.storeName, party.feePerGuest], [1, 2, "43번지", 10000]);
  const insert = tableCalls.find((c) => c.table === "party_slots" && c.method === "POST")!;
  const row = (Array.isArray(insert.body) ? insert.body[0] : insert.body) as Record<string, unknown>;
  assertEquals(row.store_id, STORE_ID);
  assertEquals(row.capacity, 6);
  assert(!("id" in row) && !("prepaid_balance" in row), "unknown fields must be dropped");

  tableCalls = [];
  for (const patch of [{ title: "" }, { capacity: 0 }, { startsAt: "not-a-date" }, { category: "해킹" }, { status: "COMPLETED" }, { storeId: "x" }]) {
    const r = await call("POST", "/admin/parties", { token: "admin-token", body: { ...good, ...patch } });
    assert(r.status === 400 || r.status === 404, `${JSON.stringify(patch)} -> ${r.status}`);
  }
  const closed = await call("POST", "/admin/parties", { token: "admin-token", body: { ...good, status: "FINISHED" } });
  assertEquals(closed.status, 400);
  assert(!tableCalls.some((c) => c.table === "party_slots"), "invalid input must not reach party_slots");
});

Deno.test("PATCH /admin/parties/:id updates only given fields; empty / storeId patch rejected", async () => {
  reset();
  tableImpl = adminTables((c) => c.table === "party_slots" && c.method === "PATCH"
    ? jsonRes(200, { id: SLOT_ID, store_id: STORE_ID, status: "CLOSED", images: [], badges: [], applications: [] })
    : undefined);
  const res = await call("PATCH", `/admin/parties/${SLOT_ID}`, { token: "admin-token", body: { status: "CLOSED", id: "evil" } });
  assertEquals(res.status, 200);
  const patch = tableCalls.find((c) => c.method === "PATCH")!;
  assertEquals(patch.body, { status: "CLOSED" });
  assertEquals(patch.params.id, `eq.${SLOT_ID}`);
  assertEquals((await call("PATCH", `/admin/parties/${SLOT_ID}`, { token: "admin-token", body: {} })).status, 400);
  assertEquals((await call("PATCH", `/admin/parties/${SLOT_ID}`, { token: "admin-token", body: { storeId: STORE_ID } })).status, 400);
});

Deno.test("POST /admin/guests/:id/block toggles manual block and clears auto-block on release", async () => {
  reset();
  tableImpl = adminTables((c) => c.table === "guests" && c.method === "PATCH"
    ? jsonRes(200, { id: GUEST_ID, is_blocked: false, blocked_until: null }) : undefined);
  const res = await call("POST", `/admin/guests/${GUEST_ID}/block`, { token: "admin-token", body: { blocked: false } });
  assertEquals(res.status, 200);
  assertEquals(tableCalls.find((c) => c.method === "PATCH")!.body, { is_blocked: false, blocked_until: null });
  assertEquals((await call("POST", `/admin/guests/${GUEST_ID}/block`, { token: "admin-token", body: { blocked: "yes" } })).status, 400);
});

Deno.test("GET /admin/applications includes guest contact and rejects bad filters", async () => {
  reset();
  tableImpl = adminTables((c) => c.table === "applications" ? jsonRes(200, [{
    id: APP_ID, slot_id: SLOT_ID, status: "MISSION_SUBMITTED", visit_code: "K7M2", mission_url: "https://instagram.com/p/x",
    fee_amount: 10000, guests: { id: GUEST_ID, name: "홍길동", phone: "01012345678", noshow_count: 0, penalty_count: 0, is_blocked: false },
    party_slots: { title: "금요 혼술", starts_at: "2026-11-13T10:00:00Z", store_id: STORE_ID, stores: { name: "43번지" } },
  }]) : undefined);
  const res = await call("GET", `/admin/applications?slotId=${SLOT_ID}&status=MISSION_SUBMITTED`, { token: "admin-token" });
  assertEquals(res.status, 200);
  const [a] = await res.json();
  assertEquals([a.guest.phone, a.storeName, a.status, a.missionUrl], ["01012345678", "43번지", "MISSION_SUBMITTED", "https://instagram.com/p/x"]);
  assertEquals((await call("GET", "/admin/applications?status=HACK", { token: "admin-token" })).status, 400);
  assertEquals((await call("GET", "/admin/applications?slotId=1", { token: "admin-token" })).status, 400);
});

// ---------------------------------------------------------------------
// 관리자 API 보완: 점포 등록·수정, 대시보드 집계, 방문 인증 대행
// ---------------------------------------------------------------------
const goodStore = {
  name: "43번지 혼술바", businessRegNo: "123-45-67890", ownerName: "홍길동", phone: "01012345678",
  address: "서울 중구 을지로11길 19", region: "명동/을지로", defaultFeePerGuest: 12000,
};
const storeRow = {
  id: STORE_ID, name: "43번지 혼술바", owner_name: "홍길동", phone: "01012345678", address: "서울 중구 을지로11길 19",
  address_detail: null, region: "명동/을지로", prepaid_balance: 0, default_fee_per_guest: 12000, is_active: true, created_at: "2026-11-09T00:00:00Z",
};

Deno.test("POST /admin/stores validates input, drops unknown fields, assigns a placeholder owner", async () => {
  reset();
  tableImpl = adminTables((c) => c.table === "stores" && c.method === "POST" ? jsonRes(201, storeRow) : undefined);
  const res = await call("POST", "/admin/stores", { token: "admin-token", body: { ...goodStore, prepaid_balance: 999, id: "evil" } });
  assertEquals(res.status, 201);
  const store = await res.json();
  assertEquals([store.name, store.prepaidBalance, store.defaultFeePerGuest], ["43번지 혼술바", 0, 12000]);
  const insert = tableCalls.find((c) => c.table === "stores" && c.method === "POST")!;
  const row = (Array.isArray(insert.body) ? insert.body[0] : insert.body) as Record<string, unknown>;
  assertEquals(row.business_reg_no, "123-45-67890");
  assert(typeof row.owner_user_id === "string" && (row.owner_user_id as string).length === 36, "owner placeholder uuid");
  assert(!("prepaid_balance" in row) && !("id" in row), "balance/id must never be client-controlled");

  tableCalls = [];
  for (const bad of [{ businessRegNo: "1234567890" }, { name: "" }, { phone: "abc" }, { defaultFeePerGuest: -1 }, { ownerUserId: "x" }]) {
    const r = await call("POST", "/admin/stores", { token: "admin-token", body: { ...goodStore, ...bad } });
    assertEquals(r.status, 400, JSON.stringify(bad));
  }
  assert(!tableCalls.some((c) => c.table === "stores"), "invalid input must not reach stores");
});

Deno.test("POST /admin/stores maps a duplicate business number (23505) to 409", async () => {
  reset();
  tableImpl = adminTables((c) => c.table === "stores" && c.method === "POST"
    ? jsonRes(409, { code: "23505", message: "duplicate key value violates unique constraint" }) : undefined);
  const res = await call("POST", "/admin/stores", { token: "admin-token", body: goodStore });
  assertEquals(res.status, 409);
});

Deno.test("PATCH /admin/stores/:id updates only given fields; immutable fields and empty patch rejected", async () => {
  reset();
  tableImpl = adminTables((c) => c.table === "stores" && c.method === "PATCH" ? jsonRes(200, { ...storeRow, region: "홍대/마포" }) : undefined);
  const ok = await call("PATCH", `/admin/stores/${STORE_ID}`, { token: "admin-token", body: { region: "홍대/마포" } });
  assertEquals(ok.status, 200);
  assertEquals((await ok.json()).region, "홍대/마포");
  const patch = tableCalls.find((c) => c.method === "PATCH")!;
  assertEquals(patch.body, { region: "홍대/마포" });
  for (const bad of [{}, { businessRegNo: "123-45-67890" }, { ownerUserId: STORE_ID }, { prepaidBalance: 1 }]) {
    const r = await call("PATCH", `/admin/stores/${STORE_ID}`, { token: "admin-token", body: bad });
    assertEquals(r.status, 400, JSON.stringify(bad));
  }
  tableImpl = adminTables((c) => c.table === "stores" && c.method === "PATCH" ? jsonRes(200, null) : undefined);
  assertEquals((await call("PATCH", `/admin/stores/${STORE_ID}`, { token: "admin-token", body: { region: "x" } })).status, 404);
});

Deno.test("GET /admin/summary returns dashboard counts and flags low-balance stores", async () => {
  reset();
  const count = (n: number) => new Response("[]", { status: 200, headers: { "Content-Type": "application/json", "Content-Range": `*/${n}` } });
  tableImpl = adminTables((c) => {
    if (c.table === "applications") return count(4);
    if (c.table === "party_slots") return c.params.status === "eq.OPEN" ? count(3) : count(2);
    if (c.table === "guests") return count(1);
    if (c.table === "stores") return jsonRes(200, [
      { prepaid_balance: 5000, default_fee_per_guest: 10000 }, { prepaid_balance: 50000, default_fee_per_guest: 10000 },
    ]);
  });
  const res = await call("GET", "/admin/summary", { token: "admin-token" });
  assertEquals(res.status, 200);
  const s = await res.json();
  assertEquals([s.pendingApplications, s.openParties, s.partiesThisWeek, s.blockedGuests, s.lowBalanceStores], [4, 3, 2, 1, 1]);
  assertEquals((await call("GET", "/admin/summary")).status, 401);
});

Deno.test("POST /admin/applications/:id/verify-visit verifies only the code issued to that application", async () => {
  reset();
  tableImpl = adminTables((c) => c.table === "applications"
    ? jsonRes(200, { visit_code: "K7M2ABCD12", party_slots: { store_id: STORE_ID } }) : undefined);
  rpcImpl = () => jsonRes(200, { application_id: APP_ID, status: "VISITED" });
  const ok = await call("POST", `/admin/applications/${APP_ID}/verify-visit`, { token: "admin-token", body: { code: "k7m2-abcd-l2" } });
  assertEquals(ok.status, 200);
  assertEquals(rpcCalls[0].fn, "verify_visit");
  assertEquals(rpcCalls[0].args.p_store_id, STORE_ID);

  rpcCalls = [];
  const wrong = await call("POST", `/admin/applications/${APP_ID}/verify-visit`, { token: "admin-token", body: { code: "ZZZZZZZZZZ" } });
  assertEquals(wrong.status, 404);
  const missing = await call("POST", `/admin/applications/${APP_ID}/verify-visit`, { token: "admin-token", body: {} });
  assertEquals(missing.status, 400);
  assertEquals(rpcCalls.length, 0, "a mismatching code must never reach verify_visit");
});

// ---------------------------------------------------------------------
// 미션 보완 요청 / 미션 제출
// ---------------------------------------------------------------------
Deno.test("POST /admin/applications/:id/request-revision calls request_mission_revision; needs an admin", async () => {
  reset();
  tableImpl = adminTables();
  rpcImpl = () => jsonRes(200, { application_id: APP_ID, status: "VISITED" });
  assertEquals((await call("POST", `/admin/applications/${APP_ID}/request-revision`)).status, 401);
  assertEquals((await call("POST", `/admin/applications/${APP_ID}/request-revision`, { token: "good-token" })).status, 403);
  assertEquals(rpcCalls.length, 0, "non-admins must not reach the DB function");

  const ok = await call("POST", `/admin/applications/${APP_ID}/request-revision`, { token: "admin-token" });
  assertEquals(ok.status, 200);
  assertEquals(rpcCalls, [{ fn: "request_mission_revision", args: { p_application_id: APP_ID } }]);
  assertEquals((await call("POST", "/admin/applications/not-a-uuid/request-revision", { token: "admin-token" })).status, 404);
});

Deno.test("POST /admin/applications/:id/request-revision maps a wrong status (PL409) to 409", async () => {
  reset();
  tableImpl = adminTables();
  rpcImpl = () => jsonRes(400, { code: "PL409", message: "Invalid status transition: APPROVED -> VISITED" });
  const res = await call("POST", `/admin/applications/${APP_ID}/request-revision`, { token: "admin-token" });
  assertEquals(res.status, 409);
});

Deno.test("POST /applications/:id/mission uses the token's guest and validates the URL first", async () => {
  reset();
  rpcImpl = () => jsonRes(200, { application_id: APP_ID, status: "MISSION_SUBMITTED" });
  assertEquals((await call("POST", `/applications/${APP_ID}/mission`, { body: { url: "https://instagram.com/p/x" } })).status, 401);
  assertEquals((await call("POST", `/applications/${APP_ID}/mission`, { token: "good-token", body: { url: "javascript:alert(1)" } })).status, 400);
  assertEquals((await call("POST", `/applications/${APP_ID}/mission`, { token: "good-token", body: {} })).status, 400);
  assertEquals(rpcCalls.length, 0);

  const res = await call("POST", `/applications/${APP_ID}/mission`, {
    token: "good-token", body: { url: " https://instagram.com/p/x ", guestId: "evil" },
  });
  assertEquals(res.status, 200);
  assertEquals(rpcCalls, [{ fn: "submit_mission", args: { p_application_id: APP_ID, p_guest_id: GUEST_ID, p_mission_url: "https://instagram.com/p/x" } }]);
});
