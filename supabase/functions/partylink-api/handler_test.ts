// partylink-api 단위 테스트 — Supabase Auth / PostgREST HTTP 를 가짜 fetch 로 대체
// 실행: deno test --allow-env supabase/functions/partylink-api/handler_test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.8";

const URL_BASE = "http://supabase.test";
Deno.env.set("SUPABASE_URL", URL_BASE);
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");

type Call = { fn: string; args: Record<string, unknown> };
let rpcCalls: Call[] = [];
let rpcImpl: (fn: string, args: Record<string, unknown>) => Response = () => new Response("[]");
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
    return req.headers.get("Authorization") === "Bearer good-token"
      ? jsonRes(200, USER)
      : jsonRes(401, { code: 401, msg: "invalid JWT" });
  }
  if (u.pathname.startsWith("/rest/v1/rpc/")) {
    const fn = u.pathname.slice("/rest/v1/rpc/".length);
    const args = JSON.parse((await req.text()) || "{}");
    rpcCalls.push({ fn, args });
    return rpcImpl(fn, args);
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

const reset = () => { rpcCalls = []; rpcImpl = () => jsonRes(200, []); };

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
    applied_at: "2026-11-01T00:00:00Z", approved_at: null, visited_at: null, mission_url: null, reject_reason: null,
    title: "금요 혼술", starts_at: "2026-11-07T11:00:00Z", ends_at: "2026-11-07T14:00:00Z", store_name: "43번지 혼술바",
    guest_name: "홍길동", guest_phone: "01012345678",
  }]);
  const res = await call("GET", "/applications", { token: "good-token" });
  assertEquals(res.status, 200);
  const [a] = await res.json();
  assertEquals([a.partyId, a.status, a.visitCode, a.userId, a.day], [SLOT_ID, "APPROVED", "K7M2QX9HPA", USER.id, "토"]);
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
