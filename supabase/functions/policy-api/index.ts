// deno-lint-ignore-file no-explicit-any
/****************************************************************************
 * Edge Function "policy-api" — 화면이 부르는 단 하나의 입구
 *   POST { fn: "openSub", args: [...] }  (Authorization: Bearer <로그인 토큰>)
 *   → 결과 JSON, 또는 { __error: "NO_ACCESS" | "FORBIDDEN" | ... }
 ****************************************************************************/
import postgres from "npm:postgres@3.4.5";
import { ApiError, makeApi } from "./api.ts";

const DB_URL = Deno.env.get("SUPABASE_DB_URL")!;
const SB_URL = Deno.env.get("SUPABASE_URL") || "";
const SB_ANON = Deno.env.get("SUPABASE_ANON_KEY") || "";
const TEST_EMAIL = Deno.env.get("POLICY_TEST_EMAIL") || "";   // 로컬 시험에서만 씀 (배포 환경엔 없음)

const sql = postgres(DB_URL, { prepare: false, max: 3, idle_timeout: 20, connect_timeout: 15 });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: any, status = 200) =>
  new Response(JSON.stringify(o === undefined ? null : o), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" } });

/** 로그인 토큰 → 구글 이메일 (Supabase Auth 가 확인) */
async function emailOf(req: Request): Promise<string> {
  const auth = req.headers.get("Authorization") || "";
  const tok = auth.replace(/^Bearer\s+/i, "");
  if (TEST_EMAIL && !SB_URL) return tok.startsWith("test:") ? tok.slice(5) : TEST_EMAIL;
  if (!tok) return "";
  const r = await fetch(SB_URL + "/auth/v1/user", { headers: { Authorization: "Bearer " + tok, apikey: SB_ANON } });
  if (!r.ok) return "";
  const u = await r.json();
  /* 같은 프로젝트의 다른 앱이 이메일/비밀번호 가입을 쓰므로, 구글로 확인된 이메일만 받습니다
     (남의 지메일 주소로 비밀번호 가입해 들어오는 것을 막음) */
  const em = String((u && u.email) || "").toLowerCase();
  const g = ((u && u.identities) || []).find((i: any) => i && i.provider === "google" &&
    String((i.identity_data && i.identity_data.email) || "").toLowerCase() === em);
  return g ? em : "";
}

const PUBLIC_FNS = new Set([
  "boot", "getBootstrap", "openSub", "homeCards", "histWho", "getSub", "getEffective", "getHistoryList", "getHistoryAt",
  "saveDraft", "dropDraft", "saveSub", "saveTree", "getAllow", "saveAllow", "resyncSharing", "shareCheck",
  "getPSheet", "getPSheetAt", "savePSheet", "deletePSheet", "deletePSheetAt", "ptSource",
  "setPtMix", "setPtOpen", "setPtPw", "checkPtPw", "getGrades", "getGradeAt", "saveGrades",
  "diagnoseWeb", "diagnose", "deleteHist", "editHist", "wipeSub", "listSubs", "diagSub", "repairCurrent", "fixCurrent",
  "getMemos", "saveMemo", "deleteMemo", "importPart",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ __error: "BAD_METHOD" }, 405);
  let body: any;
  try { body = await req.json(); } catch (_) { return json({ __error: "BAD_INPUT" }, 400); }
  const fn = String((body && body.fn) || "");
  const args = Array.isArray(body && body.args) ? body.args : [];
  if (!PUBLIC_FNS.has(fn)) return json({ __error: "NO_FN:" + fn }, 400);
  try {
    const email = await emailOf(req);
    if (!email) return json({ __error: "NEED_LOGIN" }, 401);
    const api = makeApi(sql, email);
    const out = await api[fn](...args);
    return json(out);
  } catch (e: any) {
    if (e instanceof ApiError) return json({ __error: e.message });
    console.error(fn, e);
    return json({ __error: "서버 오류: " + String((e && e.message) || e) }, 500);
  }
});
