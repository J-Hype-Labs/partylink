// partylink-api Edge Function 진입점 — 로직은 handler.ts
import { handler } from "./handler.ts";

Deno.serve(handler);
