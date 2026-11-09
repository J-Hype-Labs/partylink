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

const SLOT_STATUS_KO: Record<string, string> = {
  DRAFT: "작성 중", OPEN: "모집 중", CLOSED: "모집 마감", CANCELLED: "취소", FINISHED: "종료",
};

const STATUS_KO: Record<string, string> = {
  APPLIED: "신청", APPROVED: "선정", VISITED: "방문 인증", MISSION_SUBMITTED: "미션 제출",
  COMPLETED: "완료", NOSHOW: "노쇼", REJECTED: "반려", CANCELLED: "취소",
};

// "Invalid status transition: COMPLETED -> COMPLETED" 같은 DB 메시지를 운영자가 이해할 문장으로
function transitionMessage(msg: string): string {
  const m = msg.match(/transition:\s*([A-Z_]+)\s*->\s*([A-Z_]+)/);
  if (!m) return "현재 상태에서는 처리할 수 없습니다.";
  const [, from, to] = m;
  if (from === to) return "이미 처리된 신청입니다. 목록을 새로고침해 주세요.";
  const fromKo = STATUS_KO[from];
  if (!fromKo) return "현재 상태에서는 처리할 수 없습니다.";
  return `신청이 이미 '${fromKo}' 상태라 이 작업을 할 수 없습니다. 목록을 새로고침해 주세요.`;
}

// 적립금 부족: 얼마나 모자란지 알려 줘야 충전 금액을 정할 수 있다
function shortageMessage(detail: unknown): string {
  const d = (detail && typeof detail === "object" ? detail : {}) as Record<string, unknown>;
  const won = (n: unknown) => typeof n === "number" && Number.isFinite(n) ? `${n.toLocaleString("ko-KR")}원` : null;
  const shortage = won(d.shortage), balance = won(d.balance), required = won(d.required);
  if (!shortage) return "적립금 잔액이 부족합니다.";
  const tail = balance && required ? ` (잔액 ${balance}, 필요 ${required})` : "";
  return `적립금이 ${shortage} 부족합니다.${tail} 점포·적립금에서 충전한 뒤 다시 승인해 주세요.`;
}

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
      return new HttpError(402, shortageMessage(detail), e.code, detail);
    case "PL403":
      return new HttpError(403, "권한이 없습니다.", e.code);
    case "PL404":
      return new HttpError(404, "대상을 찾을 수 없습니다.", e.code);
    case "PL409":
      if (/already applied/i.test(msg)) return new HttpError(409, "이미 신청한 파티입니다.", e.code);
      if (/phone number is already/i.test(msg)) return new HttpError(409, "이미 다른 계정에 등록된 연락처입니다.", e.code);
      return new HttpError(409, transitionMessage(msg), e.code);
    case "PL410":
      // 정확한 문구로만 매칭한다: "Slot x is CANCELLED"(취소된 파티 선정 시도)에도 cancel 이 들어 있다
      if (/Cannot cancel after the party starts/i.test(msg)) return new HttpError(410, "파티가 시작된 후에는 취소할 수 없습니다.", e.code);
      if (/party window/i.test(msg)) return new HttpError(410, "방문 인증은 파티 진행 시간에만 할 수 있습니다.", e.code);
      if (/No-show can only be marked/i.test(msg)) return new HttpError(410, "파티가 시작된 후에만 노쇼 처리할 수 있습니다.", e.code);
      if (/is full/i.test(msg)) return new HttpError(410, "정원이 가득 차 더 선정할 수 없습니다. 정원을 늘리거나 다른 신청을 반려해 주세요.", e.code);
      {
        const m = msg.match(/^Slot \S+ is ([A-Z]+)$/);
        if (m && SLOT_STATUS_KO[m[1]]) {
          return new HttpError(410, `이 파티는 '${SLOT_STATUS_KO[m[1]]}' 상태라 신청을 선정할 수 없습니다.`, e.code);
        }
      }
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
