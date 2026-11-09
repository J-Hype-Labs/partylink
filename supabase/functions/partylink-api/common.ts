// partylink-api 공통: service_role 클라이언트, 에러 변환, 로그인 토큰 검증
import { createClient, type User } from "npm:@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string, public detail?: unknown) {
    super(message);
  }
}

type DbError = { code?: string; message?: string; details?: string };

export function fromDbError(e: DbError): HttpError {
  const msg = e.message ?? "";
  let detail: unknown = e.details;
  try { detail = JSON.parse(e.details ?? ""); } catch { /* plain text */ }

  switch (e.code) {
    case "PL400":
      if (/phone/i.test(msg)) return new HttpError(400, "연락처를 정확히 입력해 주세요. (예: 01012345678)", e.code);
      if (/name/i.test(msg)) return new HttpError(400, "이름을 2자 이상 입력해 주세요.", e.code);
      return new HttpError(400, "입력값을 확인해 주세요.", e.code);
    case "23514": // CHECK 위반 (시간 순서, 정원, 수수료 등)
    case "22P02": // 형식 오류 (잘못된 enum / 날짜)
    case "22007":
    case "22008":
      return new HttpError(400, "입력값을 확인해 주세요.", e.code);
    case "23503": // 존재하지 않는 점포 등 FK 위반
      return new HttpError(404, "대상을 찾을 수 없습니다.", e.code);
    case "23505": // UNIQUE 위반 (사업자등록번호, 점주 계정 중복)
      return new HttpError(409, "이미 등록된 사업자등록번호 또는 점주 계정입니다.", e.code);
    case "PL402":
      return new HttpError(402, "적립금 잔액이 부족합니다.", e.code, detail);
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

export async function rpc<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await db.rpc(fn, args);
  if (error) throw fromDbError(error);
  return data as T;
}

export async function requireUser(req: Request): Promise<User> {
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "카카오 로그인이 필요합니다.");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "로그인이 만료되었습니다. 다시 로그인해 주세요.");
  return data.user;
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? body as Record<string, unknown> : {};
  } catch {
    throw new HttpError(400, "요청 형식이 올바르지 않습니다.");
  }
}
