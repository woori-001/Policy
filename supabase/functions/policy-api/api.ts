// deno-lint-ignore-file no-explicit-any
/****************************************************************************
 * 상부정책 관리 — 서버 로직 (Supabase Edge Function)
 *
 * 예전 Apps Script(Code.gs)의 함수들을 그대로 옮겼습니다. 화면이 받는 응답 모양도 같습니다.
 *  · 시트 대신 Postgres(pol_ 테이블)에 읽고 씁니다.
 *  · LockService 대신 트랜잭션 + advisory lock 으로 쓰기를 한 줄로 세웁니다.
 *  · 구글 계정 확인은 Supabase 로그인(구글)으로 — 이메일이 pol_members 에 있어야 들어옵니다.
 *  · 시트 공유 · 시각 칸 정리처럼 시트에만 필요하던 기능은 빠졌습니다.
 ****************************************************************************/

export type Sql = any;

export const OWNER_EMAIL = "w33439067@gmail.com";
export const OWNER_NAME = "담민";
export const SRV_VER = "2026-10-13 (Supabase)";
export const ROLES = ["관리자", "편집담당자", "열람전용"];
export const TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const LOCK_KEY = 72400001;            // 이 앱 전용 advisory lock 번호

/* ========================= 시각 (한국 시간 · 'YYYY-MM-DD HH:mm') ========================= */
const FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
function parts(d: Date) {
  const o: Record<string, string> = {};
  for (const p of FMT.formatToParts(d)) o[p.type] = p.value;
  return o;
}
let CLOCK: () => Date = () => new Date();
/** 시험용 — 지금 시각을 바꿉니다 */
export function setClock(fn: () => Date) { CLOCK = fn; }
export function nowStr(): string {
  const p = parts(CLOCK());
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}
function nowSec(): string {
  const p = parts(CLOCK());
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
function cleanTs(s: any) { s = String(s || "").trim(); return TS_RE.test(s) ? s : nowStr(); }

/* ========================= 오류 · 잠금 ========================= */
export class ApiError extends Error {}
export class Busy extends Error {}

/** 예전 LockService.tryLock(20000) — 쓰기는 이 앱 전체에서 한 번에 하나씩 */
async function withLock<T>(sql: Sql, fn: (tx: Sql) => Promise<T>): Promise<T | { ok: false; reason: string }> {
  try {
    return await sql.begin(async (tx: Sql) => {
      await tx`set local lock_timeout = '20s'`;
      await tx`select pg_advisory_xact_lock(${LOCK_KEY})`;
      return await fn(tx);
    });
  } catch (e: any) {
    if (e && (e.code === "55P03" || /lock timeout/i.test(String(e.message)))) return { ok: false, reason: "BUSY" };
    throw e;
  }
}

/* ========================= 권한 ========================= */
export type Me = { email: string; name: string; role: string };

async function readAllow(db: Sql) {
  const rows = await db`select email, name, role from pol_members order by ord, email`;
  return rows.map((r: any) => ({ em: r.email, name: r.name || "", role: r.role || "열람전용" }));
}
async function meOf(db: Sql, email: string): Promise<Me> {
  const e = String(email || "").trim().toLowerCase();
  if (!e) return { email: "", name: "", role: "" };
  const r = await db`select name, role from pol_members where email = ${e}`;
  return { email: e, name: r[0] ? r[0].name : "", role: r[0] ? r[0].role : "" };
}

/* ========================= 구조(TREE) · 설정 ========================= */
async function kvGet(db: Sql, key: string) {
  const r = await db`select value from pol_kv where key = ${key}`;
  return r.length ? r[0].value : undefined;
}
async function kvSet(db: Sql, key: string, value: any) {
  if (value === undefined) { await db`delete from pol_kv where key = ${key}`; return; }
  await db`insert into pol_kv (key, value, updated_at) values (${key}, ${db.json(value)}, now())
           on conflict (key) do update set value = excluded.value, updated_at = now()`;
}
async function readTree(db: Sql): Promise<any[]> {
  const t = await kvGet(db, "tree");
  return Array.isArray(t) ? t : [];
}

/* ========================= 공통 유틸 (예전과 같음) ========================= */
function noteW(o: any) { const n = Number(o && o.nw); return (isFinite(n) && n >= 180 && n <= 560) ? Math.round(n) : 0; }
function baseIdx(o: any) {
  const i = Number(o && o.base), n = ((o && o.vendors) || []).length;
  return (isFinite(i) && i >= 0 && i < n) ? Math.floor(i) : -1;
}
function normNotes(o: any) {
  if (!o) return [];
  if (Array.isArray(o.notes)) {
    return o.notes.map((n: any) => {
      const out: any = { t: String((n && n.t) || ""), b: String((n && n.b) || "") };
      if (n && n.k === "tb") out.k = "tb";
      return out;
    }).filter((n: any) => n.t.trim() || n.b.trim());
  }
  if (o.note && String(o.note).trim()) return [{ t: "메모", b: String(o.note) }];
  return [];
}
function priceSig(o: any) {
  const p = [String(((o && o.vendors) || []).length)];
  ((o && o.data) || []).forEach((g: any) => {
    const rows = (g && g.rows) || [];
    p.push("g" + rows.length);
    rows.forEach((r: any) => ((r && r.c) || []).forEach((c: any) => {
      const q = (x: any) => (x == null || x === "") ? "n" : String(x);
      p.push(c ? (q(c[0]) + ":" + q(c[1]) + ":" + (c[3] || "")) : "x");
    }));
  });
  return p.join(",");
}
function subCfgFrom(tree: any[], subId: string) {
  for (const c of tree) for (const s of (c.subs || []))
    if (String(s.id) === String(subId)) return { gift: s.gift !== false, cmp: s.cmp !== false, vat: !!s.vat };
  return null;
}
async function subCfg(db: Sql, subId: string) { return subCfgFrom(await readTree(db), subId); }
function cfgOf(b: any) {
  const c = b && b.cfg;
  if (!c || typeof c !== "object") return null;
  return { gift: c.gift !== false, cmp: c.cmp !== false, vat: !!c.vat };
}
async function bodyOf(db: Sql, payload: any, subId?: string) {
  const o: any = { labels: payload.labels, vendors: payload.vendors, base: baseIdx(payload), nw: noteW(payload),
    data: payload.data, notes: normNotes(payload) };
  if (subId) { const c = await subCfg(db, subId); if (c) o.cfg = c; }
  return o;
}

/* ========================= 정책 현재본 ========================= */
async function readPolicy(db: Sql, subId: string) {
  const r = await db`select rev, last_by, saved_at, eff_at, body from pol_policy where sub_id = ${String(subId)}`;
  if (!r.length) return null;
  const x = r[0], b = x.body || {};
  return {
    subId: String(subId), rev: Number(x.rev) || 0, lastBy: x.last_by || "", savedAt: x.saved_at || "",
    effAt: x.eff_at || x.saved_at || "",
    base: baseIdx(b), nw: noteW(b), cfg: cfgOf(b),
    labels: b.labels || ["상품"],
    vendors: b.vendors || [{ name: "상부 1", memo: "" }],
    data: b.data || [{ g: "기본", rows: [] }],
    notes: normNotes(b),
  };
}
async function writePolicy(db: Sql, subId: string, rev: number, by: string, savedAt: string, effAt: string, body: any) {
  await db`insert into pol_policy (sub_id, rev, last_by, saved_at, eff_at, body)
           values (${subId}, ${rev}, ${by}, ${savedAt}, ${effAt}, ${db.json(body)})
           on conflict (sub_id) do update set rev = excluded.rev, last_by = excluded.last_by,
             saved_at = excluded.saved_at, eff_at = excluded.eff_at, body = excluded.body`;
}
async function deletePolicy(db: Sql, subId: string) { await db`delete from pol_policy where sub_id = ${subId}`; }

/* ========================= 초안 ========================= */
async function readDraft(db: Sql, subId: string) {
  const r = await db`select base_rev, author, at, body from pol_draft where sub_id = ${String(subId)}`;
  if (!r.length) return null;
  const b = r[0].body || {};
  if (!b.data) return null;
  return { baseRev: Number(r[0].base_rev) || 0, by: r[0].author || "", at: r[0].at || "",
    labels: b.labels || ["상품"], vendors: b.vendors || [], base: baseIdx(b), nw: noteW(b),
    cfg: cfgOf(b), data: b.data || [], notes: normNotes(b) };
}
async function draftMap(db: Sql) {
  const out: any = {};
  for (const r of await db`select sub_id, author, at from pol_draft`) out[r.sub_id] = { by: r.author || "", at: r.at || "" };
  return out;
}

/* ========================= 이력 ========================= */
function histMeta(r: any) {
  const pp = String(r.kind || "단가").split("@");
  return { row: Number(r.id), eff: r.eff_at, saved: r.saved_at, by: r.author || "", kind: pp[0] || "단가",
    fixBy: pp[1] || "", fixAt: pp[2] || "" };
}
async function histList(db: Sql, subId: string) {
  const r = await db`select id, eff_at, saved_at, author, kind from pol_hist where sub_id = ${String(subId)}
                     order by eff_at collate "C", saved_at collate "C", id`;
  return r.map(histMeta);
}
async function histAll(db: Sql) {
  const per: any = {};
  const r = await db`select id, sub_id, eff_at, saved_at, author, kind from pol_hist order by sub_id, eff_at collate "C", saved_at collate "C", id`;
  for (const x of r) (per[x.sub_id] || (per[x.sub_id] = [])).push(histMeta(x));
  return per;
}
async function histBody(db: Sql, row: number) {
  const r = await db`select body from pol_hist where id = ${Number(row)}`;
  return r.length ? (r[0].body || {}) : null;
}
async function appendHist(db: Sql, subId: string, eff: string, saved: string, by: string, kind: string, body: any) {
  await db`insert into pol_hist (sub_id, eff_at, saved_at, author, kind, body)
           values (${subId}, ${eff}, ${saved}, ${by}, ${kind}, ${db.json(body)})`;
}
function histOut(list: any[]) {
  return list.map((m) => ({ ts: m.eff, savedAt: m.saved, by: m.by, kind: m.kind, fixBy: m.fixBy || "", fixAt: m.fixAt || "", row: m.row }));
}
function curRow(list: any[], now: string) {
  let pick = 0;
  for (const m of list) if (m.kind !== "기타" && m.eff <= now) pick = m.row;
  return pick;
}
function prevOf(list: any[], row: number) {
  const at = list.findIndex((m) => m.row === row);
  if (at < 0) return null;
  for (let i = at - 1; i >= 0; i--) if (list[i].kind !== "기타") return list[i];
  return null;
}
/** 어느 이력이 현재 정책인지 — '단가' 시점만 보고, 본문은 그 시점의 가장 나중 저장 */
function pickCurrent(list: any[]) {
  if (!list || !list.length) return null;
  let real = list.filter((m) => m.kind !== "기타");
  if (!real.length) real = list;
  const eff = real[real.length - 1].eff;
  let pick = real[real.length - 1];
  for (const m of list) if (m.eff === eff && m.saved >= pick.saved) pick = m;
  return { eff, row: pick.row, by: pick.by };
}
async function healWith(sql: Sql, subId: string, list: any[] | null) {
  try {
    const p = await readPolicy(sql, subId);
    if (!p) return null;
    const l0: any[] = list || await histList(sql, subId);
    if (!l0.length) return null;
    const pick = pickCurrent(l0);
    if (!pick || pick.eff === p.effAt) return null;
    const r: any = await withLock(sql, async (tx) => {
      const now = await readPolicy(tx, subId), l2 = await histList(tx, subId), pk = pickCurrent(l2);
      if (!now || !pk || pk.eff === now.effAt) return null;
      const body = await histBody(tx, pk.row);
      if (!body) return null;
      await writePolicy(tx, subId, (now.rev || 0) + 1, pk.by, nowStr(), pk.eff, body);
      return { from: now.effAt, to: pk.eff };
    });
    return r && r.from !== undefined ? r : null;
  } catch (_) { return null; }
}
function starter(subId: string) {
  return { subId, rev: 0, lastBy: "", savedAt: "", effAt: "", labels: ["상품"], vendors: [{ name: "상부 1", memo: "" }],
    base: -1, nw: 0, data: [{ g: "기본", rows: [{ n: "상품 1", ext: [], c: [[null, null, null, ""]] }] }], notes: [] };
}
function vKey(x: any) { return [String((x && x.name) || ""), String((x && x.ch) || ""), String((x && x.rg) || "")].join("\u0001"); }
function vMatch(pv: any[], cv: any, vi: number) {
  pv = pv || [];
  const k = vKey(cv);
  for (let i = 0; i < pv.length; i++) if (vKey(pv[i]) === k) return i;
  const nm = String((cv && cv.name) || ""), same: number[] = [];
  for (let i = 0; i < pv.length; i++) if (String(pv[i].name || "") === nm) same.push(i);
  if (same.length === 1) return same[0];
  if (same.length > 1 && same.indexOf(vi) >= 0) return vi;
  return -1;
}
function diffCounts(cur: any, prev: any) {
  if (!cur || !prev) return null;
  const key = (g: any, r: any) => [g.g, r.n].concat(r.ext || []).join("\u0001");
  const idx: any = {};
  (prev.data || []).forEach((g: any) => (g.rows || []).forEach((r: any) => { idx[key(g, r)] = r; }));
  const vmap = prev.vendors || [];
  const txt = (c: any) => !!(c && c[3] != null && String(c[3]).trim() !== "");
  const inc = (c: any) => (c == null || txt(c)) ? null : ((c[0] || 0) + (c[1] || 0));
  let up = 0, dn = 0;
  (cur.data || []).forEach((g: any) => (g.rows || []).forEach((r: any) => {
    const pr = idx[key(g, r)]; if (!pr) return;
    (r.c || []).forEach((c: any, vi: number) => {
      const pvi = vMatch(vmap, (cur.vendors || [])[vi], vi); if (pvi < 0) return;
      const a = inc(c), b = inc((pr.c || [])[pvi]);
      if (a == null || b == null || a === b) return;
      if (a > b) up++; else dn++;
    });
  }));
  return { up, dn };
}
function whoChanged(cur: any, prev: any) {
  const key = (g: any, r: any) => [g.g, r.n].concat(r.ext || []).join("\u0001");
  const idx: any = {};
  (prev.data || []).forEach((g: any) => (g.rows || []).forEach((r: any) => { idx[key(g, r)] = r; }));
  const cv = cur.vendors || [], pv = prev.vendors || [];
  if (cv.length < 2) return null;
  const q = (x: any) => (x == null || x === "") ? "n" : String(x);
  const cellSig = (c: any) => c ? (q(c[0]) + ":" + q(c[1]) + ":" + (c[3] || "")) : "x";
  const hit: any = {};
  cv.forEach((x: any, vi: number) => {
    const pvi = vMatch(pv, x, vi);
    if (pvi < 0) { hit[vi] = 1; return; }
    let changed = false;
    (cur.data || []).forEach((g: any) => (g.rows || []).forEach((r: any) => {
      if (changed) return;
      const pr = idx[key(g, r)];
      if (cellSig((r.c || [])[vi]) !== (pr ? cellSig((pr.c || [])[pvi]) : "x")) changed = true;
    }));
    if (changed) hit[vi] = 1;
  });
  const ks = Object.keys(hit);
  if (!ks.length) return null;
  if (ks.length === cv.length) return "ALL";
  const names: string[] = [];
  ks.forEach((k) => {
    const nm = String((cv[Number(k)] && cv[Number(k)].name) || "").trim() || ("상부 " + (Number(k) + 1));
    if (names.indexOf(nm) < 0) names.push(nm);
  });
  return names;
}
async function resyncPolicy(db: Sql, subId: string) {
  const list = await histList(db, subId);
  if (!list.length) { await deletePolicy(db, subId); return ""; }
  const pick = pickCurrent(list);
  if (!pick) return "";
  const body = await histBody(db, pick.row);
  if (!body) return "\u0000FAIL";
  const p = await readPolicy(db, subId);
  await writePolicy(db, subId, (p ? p.rev : 0) + 1, pick.by, nowStr(), pick.eff, body);
  return pick.eff;
}
async function trashHistRow(db: Sql, row: number, kind: string, by: string) {
  const r = await db`select * from pol_hist where id = ${row}`;
  if (!r.length) return;
  const x = r[0];
  await db`insert into pol_trash (kind, ref, deleted_at, deleted_by, data)
           values (${kind}, ${x.sub_id}, ${nowStr()}, ${by},
                   ${db.json({ row: Number(x.id), subId: x.sub_id, eff: x.eff_at, saved: x.saved_at, by: x.author, kind: x.kind, body: x.body })})`;
}

/* ========================= 협력점 정책 — 설정 · 비밀번호 ========================= */
async function ptConfRead(db: Sql) {
  const out: any = {};
  const open = await kvGet(db, "pt_open"); if (open !== undefined) out.open = open;
  const mix = await kvGet(db, "pt_mix"); if (mix !== undefined) out.mix = mix;
  for (const r of await db`select key, value from pol_secret where key like 'pw:%'`) out[r.key] = r.value;
  return out;
}
function ptConfPublic(conf: any) {
  /* 아직 설정 안 했으면 아무 통신사도 안 열림 (관리자만 봄). null = 전부 */
  const open = conf.open === undefined ? [] : conf.open;
  const pw: any = {};
  Object.keys(conf).forEach((k) => { if (k.indexOf("pw:") === 0) pw[k.slice(3)] = true; });
  const mix = conf.mix && typeof conf.mix === "object" ? conf.mix : {};
  return { open, pw, mix };
}
async function sha256Hex(s: string) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function ptHash(salt: string, pw: string) { return await sha256Hex(salt + "|" + pw); }
async function ptHash2(salt: string, pw: string) {
  let h = await ptHash(salt, pw);
  for (let i = 1; i < 300; i++) h = await ptHash(salt, h);
  return h;
}
async function ptPwOk(conf: any, key: string, pw: any) {
  const v = conf["pw:" + key]; if (!v) return true;
  if (!pw) return false;
  const p = String(v).split(":");
  if (p[0] === "v2") return (await ptHash2(p[1], String(pw))) === p[2];
  return (await ptHash(p[0], String(pw))) === p[1];
}
async function ptPwLocked(db: Sql, email: string) {
  const r = await db`select n from pol_pwfail where email = ${email} and until > now()`;
  return !!(r.length && r[0].n >= 8);
}
async function ptPwFail(db: Sql, email: string) {
  await db`insert into pol_pwfail (email, n, until) values (${email}, 1, now() + interval '10 minutes')
           on conflict (email) do update set
             n = case when pol_pwfail.until > now() then pol_pwfail.n + 1 else 1 end,
             until = case when pol_pwfail.until > now() then pol_pwfail.until else now() + interval '10 minutes' end`;
}
async function ptMixOwner(db: Sql, gid: string) {
  gid = String(gid || ""); if (gid.indexOf("mix:") !== 0) return "";
  const mix = ptConfPublic(await ptConfRead(db)).mix, id = gid.slice(4);
  let owner = "";
  Object.keys(mix).forEach((cid) => (mix[cid] || []).forEach((x: any) => { if (String(x.id) === id) owner = cid; }));
  return owner;
}

/* ========================= 등급 차감표 ========================= */
const GRADE_KEYS = ["ct", "A", "A2", "B", "C", "D", "own"];
const OWN_TYPES = ["inet1", "inet2", "usim", "dev", "pre", "usimF", "devF", "preF", "usimSky"];
async function readGrades(db: Sql) {
  const r = await db`select rev, author, at, cfg from pol_grades where id = 1`;
  if (!r.length) return { rev: 0, by: "", at: "", cfg: null };
  return { rev: Number(r[0].rev) || 0, by: r[0].author || "", at: r[0].at || "", cfg: r[0].cfg || null };
}
function gradeAmt(x: any) {
  if (x === null || x === undefined || x === "") return null;
  const n = Number(x);
  if (!isFinite(n) || Math.abs(n) > 10000000) return undefined;
  return Math.round(n);
}
function gradeStr(s: any, max: number) { return String(s == null ? "" : s).replace(/[\u0000-\u001f]/g, " ").trim().substr(0, max); }

export function cleanGrades(cfg: any): any {
  if (!cfg || typeof cfg !== "object" || !cfg.carriers || typeof cfg.carriers !== "object") return null;
  const out: any = { v: 1, grades: [], carriers: {} }, cids = Object.keys(cfg.carriers);
  if (cids.length > 40) return null;
  const keys = GRADE_KEYS.slice(), gk: any = {}, perC: any = {}, gcid: any = {};
  if (cfg.grades != null) {
    if (!Array.isArray(cfg.grades) || cfg.grades.length > 200) return null;
    for (const gg0 of cfg.grades) {
      const gg = gg0 || {}, k0 = String(gg.k || ""), n0 = gradeStr(gg.n, 20), c0 = gg.cid == null ? "" : gradeStr(gg.cid, 60);
      if (!/^x[0-9a-z]{1,16}$/.test(k0) || !n0 || gk[k0]) return null;
      perC[c0] = (perC[c0] || 0) + 1; if (perC[c0] > 12) return null;
      gk[k0] = 1; const g0: any = { k: k0, n: n0 }; if (c0) { g0.cid = c0; gcid[k0] = c0; }
      out.grades.push(g0); keys.push(k0);
    }
  }
  out.order = [];
  const seenO: any = {};
  if (cfg.order != null) {
    if (!Array.isArray(cfg.order) || cfg.order.length > 220) return null;
    for (const o of cfg.order) { const ko = String(o); if (keys.indexOf(ko) >= 0 && !seenO[ko]) { seenO[ko] = 1; out.order.push(ko); } }
  }
  for (const k of keys) if (!seenO[k]) out.order.push(k);
  for (const cid of cids) {
    const c = cfg.carriers[cid];
    if (!c || typeof c !== "object" || !Array.isArray(c.rows) || c.rows.length > 80) return null;
    const rows: any[] = [], ids: any = {};
    for (let j = 0; j < c.rows.length; j++) {
      const r = c.rows[j] || {}, d: any = {}, name = gradeStr(r.name, 40);
      if (!name) return null;
      const id = gradeStr(r.id, 40) || ("g" + j);
      if (ids[id]) return null; ids[id] = 1;
      for (const k of keys) {
        if (gcid[k] && gcid[k] !== cid) continue;
        const a = gradeAmt(r.d && r.d[k]);
        if (a === undefined) return null;
        d[k] = a;
      }
      const ex: any[] = [];
      if (Array.isArray(r.ex)) {
        if (r.ex.length > 12) return null;
        for (const e of r.ex) {
          const en = gradeStr(e && e.n, 30), ea = gradeAmt(e && e.a);
          if (!en || ea === undefined || ea === null) return null;
          ex.push({ n: en, a: ea });
        }
      }
      const ch = String(r.ch || "");
      if (ch && ch !== "도매" && ch !== "소매") return null;
      rows.push({ id, name, sid: gradeStr(r.sid, 60), ch, vat: !!r.vat, d, ex, memo: gradeStr(r.memo, 200) });
    }
    const ck = gradeStr(cid, 60);
    if (!ck || out.carriers[ck]) return null;
    out.carriers[ck] = { splitA: !!c.splitA, rows };
    if (c.sched != null) {
      if (!Array.isArray(c.sched) || c.sched.length > 30) return null;
      const sch: any[] = [], seenS: any = {};
      for (const sv0 of c.sched) {
        const sv = sv0 || {}, sid0 = gradeStr(sv.id, 30), sf = String(sv.from || "");
        if (!/^s[0-9a-z]{1,24}$/.test(sid0) || seenS[sid0] || !/^\d{4}-\d{2}-\d{2}$/.test(sf) || !sv.d || typeof sv.d !== "object") return null;
        seenS[sid0] = 1;
        const sd: any = {}; let nCell = 0; const rk = Object.keys(sv.d);
        if (rk.length > 80) return null;
        for (const rid of rk) {
          if (!ids[rid]) continue;
          const cell = sv.d[rid] || {}, o2: any = {};
          for (const k of Object.keys(cell)) {
            if (keys.indexOf(k) < 0 || (gcid[k] && gcid[k] !== cid)) continue;
            const sa = gradeAmt(cell[k]); if (sa === undefined) return null;
            o2[k] = sa; nCell++;
          }
          if (Object.keys(o2).length) sd[rid] = o2;
        }
        if (nCell) sch.push({ id: sid0, from: sf, d: sd, by: gradeStr(sv.by, 40), at: gradeStr(sv.at, 20) });
      }
      if (sch.length) out.carriers[ck].sched = sch;
    }
  }
  if (cfg.deal != null) {
    if (!Array.isArray(cfg.deal) || cfg.deal.length > 40) return null;
    out.deal = [];
    const seenD: any = {};
    for (const dv0 of cfg.deal) {
      const dv = dv0 || {}, did = gradeStr(dv.id, 30), dn = gradeStr(dv.n, 20), db = String(dv.base || "");
      if (!/^d[0-9a-z]{1,20}$/.test(did) || !dn || seenD[did] || keys.indexOf(db) < 0) return null;
      seenD[did] = 1;
      const drows: any[] = [];
      if (dv.rows != null) {
        if (!Array.isArray(dv.rows) || dv.rows.length > 300) return null;
        for (const dr0 of dv.rows) {
          const dr = dr0 || {}, dg = gradeStr(dr.gid, 60), dnm = gradeStr(dr.n, 60), da = gradeAmt(dr.a);
          if (!dg || !dnm || da === undefined || da === null) return null;
          drows.push({ gid: dg, n: dnm, a: da });
        }
      }
      const dc = gradeStr(dv.cid, 60);
      if (gcid[db] && gcid[db] !== dc) return null;
      const dout: any = { id: did, n: dn, base: db, rows: drows }; if (dc) dout.cid = dc;
      out.deal.push(dout);
    }
  }
  if (cfg.own != null) {
    if (!Array.isArray(cfg.own) || cfg.own.length > 60) return null;
    out.own = [];
    const seenOw: any = {};
    cfg.own.forEach((ow0: any, w: number) => {
      if (out.own === null) return;
      const ow = ow0 || {}, ot = String(ow.t || ""), of = String(ow.from || ""), oa = gradeAmt(ow.a);
      if (OWN_TYPES.indexOf(ot) < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(of) || oa === undefined || oa === null || oa < 0 || seenOw[ot + "|" + of]) { out.own = null; return; }
      seenOw[ot + "|" + of] = 1;
      out.own.push({ id: gradeStr(ow.id, 30) || ("o" + w), t: ot, from: of, memo: gradeStr(ow.memo, 100), a: oa });
    });
    if (out.own === null) return null;
  }
  return out;
}
function ptCarKey(c: any) {
  if (!c) return "null";
  const x = JSON.parse(JSON.stringify(c));
  (x.rows || []).forEach((r: any) => {
    const d: any = {};
    Object.keys(r.d || {}).sort().forEach((k) => { if (r.d[k] != null) d[k] = r.d[k]; });
    r.d = d;
  });
  return JSON.stringify(x);
}
function gradeDiff(a: any, b: any, tree: any[]) {
  if (!a || !a.carriers) return "처음 저장";
  const names: any = {}; tree.forEach((t) => { names[t.id] = t.name; });
  const keys: any = {}, out: string[] = [];
  Object.keys(a.carriers).forEach((k) => { keys[k] = 1; });
  Object.keys(b.carriers).forEach((k) => { keys[k] = 1; });
  const gOf = (c: any, cid: string) => JSON.stringify((c.grades || []).filter((g: any) => (g.cid || "") === cid).map((g: any) => g.k + "=" + g.n).sort());
  const dOf = (c: any, cid: string) => JSON.stringify((c.deal || []).filter((d: any) => (d.cid || "") === cid));
  (a.grades || []).concat(b.grades || []).forEach((g: any) => { if (g.cid) keys[g.cid] = 1; });
  (a.deal || []).concat(b.deal || []).forEach((d: any) => { if (d.cid) keys[d.cid] = 1; });
  const dealBy: string[] = [];
  Object.keys(keys).forEach((k) => {
    if (ptCarKey(a.carriers[k]) !== ptCarKey(b.carriers[k]) || gOf(a, k) !== gOf(b, k)) out.push(names[k] || k);
    if (dOf(a, k) !== dOf(b, k)) dealBy.push(names[k] || k);
  });
  if (gOf(a, "") !== gOf(b, "")) out.unshift("등급 목록");
  else if (a.order && b.order) {
    const both = (x: any[], y: any[]) => x.filter((k) => y.indexOf(k) >= 0);
    if (JSON.stringify(both(a.order, b.order)) !== JSON.stringify(both(b.order, a.order))) out.unshift("등급 순서");
  }
  if (JSON.stringify(a.own || null) !== JSON.stringify(b.own || null)) out.unshift("자점 차감");
  if (dOf(a, "") !== dOf(b, "")) dealBy.unshift("공통");
  if (dealBy.length) out.unshift("협의 업체(" + dealBy.join(", ") + ")");
  return out.length ? out.join(" · ") : "변경 없음";
}
async function gradeHistList(db: Sql, limit: number) {
  const r = await db`select id, at, author, what from pol_grades_hist order by id desc limit ${limit || 30}`;
  return r.map((x: any) => ({ row: Number(x.id), at: x.at || "", by: x.author || "", what: x.what || "" }));
}
async function subChans(db: Sql) {
  const out: any = {};
  const r = await db`select sub_id, body->'vendors' as v from pol_policy`;
  const ids: any = {}; (await readTree(db)).forEach((c) => (c.subs || []).forEach((s: any) => { ids[s.id] = 1; }));
  for (const x of r) {
    if (!ids[x.sub_id]) continue;
    const seen: any = {}, l: string[] = [];
    (Array.isArray(x.v) ? x.v : []).forEach((v: any) => { if (v && (v.ch === "도매" || v.ch === "소매")) seen[v.ch] = 1; });
    if (seen["도매"]) l.push("도매");
    if (seen["소매"]) l.push("소매");
    if (l.length) out[x.sub_id] = l;
  }
  return out;
}

/* ========================= 정책지 ========================= */
const PS_MAX = 400000;
async function psHistList(db: Sql, gid: string, limit: number) {
  const r = await db`select id, at, author, eff from pol_psheet_hist where gid = ${String(gid)} order by id desc limit ${limit || 80}`;
  return r.map((x: any) => ({ row: Number(x.id), at: x.at || "", by: x.author || "", eff: x.eff || "" }));
}

/* ========================= 메모 ========================= */
const MEMO_CATS = ["멘트", "할일", "업체"];
async function memoRead(db: Sql, m: Me, cids: any) {
  const mine: any = {}; (Array.isArray(cids) ? cids : []).forEach((c: any) => { mine[String(c)] = 1; });
  const me = String(m.email || "").toLowerCase(), out: any[] = [];
  for (const v of await db`select * from pol_memo order by at, id`) {
    const own = String(v.email || "").toLowerCase() === me, sh = !!v.shared, mc: string[] = v.cids || [];
    if (!own && !sh) continue;
    if (!own && mc.length && !mc.some((c) => mine[c])) continue;
    out.push({ id: v.id, own, by: v.author || "", shared: sh, cids: mc, cat: v.cat, t: v.title || "", b: v.body || "", at: v.at || "", done: !!v.done });
  }
  return out;
}

/** 행 번호를 그대로 옮긴 뒤, 새 번호가 그 다음부터 이어지게 */
async function fixSeq(tx: Sql) {
  await tx`select setval(pg_get_serial_sequence('pol_hist','id'), greatest((select coalesce(max(id),0) from pol_hist), 1))`;
  await tx`select setval(pg_get_serial_sequence('pol_grades_hist','id'), greatest((select coalesce(max(id),0) from pol_grades_hist), 1))`;
  await tx`select setval(pg_get_serial_sequence('pol_psheet_hist','id'), greatest((select coalesce(max(id),0) from pol_psheet_hist), 1))`;
}

/* ============================================================================
 * 화면이 부르는 함수들 — 이름 · 인자 · 응답 모양은 예전 Code.gs 와 같습니다
 * ========================================================================== */
export function makeApi(sql: Sql, email: string) {
  let _me: Me | null = null;
  const me = async () => (_me || (_me = await meOf(sql, email)));
  const requireRole = async (roles: string[]) => {
    const m = await me();
    if (!m.role) throw new ApiError("NO_ACCESS");
    if (roles.indexOf(m.role) < 0) throw new ApiError("FORBIDDEN");
    return m;
  };
  const anyRole = async () => { const m = await me(); if (!m.role) throw new ApiError("NO_ACCESS"); return m; };

  async function ensureInit() {
    const n = await sql`select count(*)::int as n from pol_members`;
    if (!n[0].n) await sql`insert into pol_members (email, name, role, ord) values (${OWNER_EMAIL}, ${OWNER_NAME}, '관리자', 0) on conflict do nothing`;
    if (!(await readTree(sql)).length) {
      await kvSet(sql, "tree", [
        { id: "c_sky", name: "SKY", logoKey: "skylife", subs: [{ id: "s_sky_1", name: "스카이라이프 유선", logoKey: "skylife" }] },
        { id: "c_kt", name: "KT", logoKey: "kt", subs: [{ id: "s_kt_1", name: "KT 유선", logoKey: "kt" }, { id: "s_kt_2", name: "KT 무선", logoKey: "kt" }] },
        { id: "c_sk", name: "SK", logoKey: "skt", subs: [{ id: "s_sk_1", name: "SK브로드밴드", logoKey: "skb" }, { id: "s_sk_2", name: "SK텔레콤", logoKey: "skt" }] },
        { id: "c_lg", name: "LG", logoKey: "lgu", subs: [{ id: "s_lg_1", name: "LG U+", logoKey: "lgu" }, { id: "s_lg_2", name: "LG 헬로비전", logoKey: "hello" }] },
      ]);
    }
  }

  const A: Record<string, (...a: any[]) => Promise<any>> = {};

  A.getBootstrap = async () => {
    await ensureInit();
    const m = await me();
    if (!m.role) return { ok: false, reason: "NO_ACCESS", email: m.email || email };
    const drafts = m.role !== "열람전용" ? await draftMap(sql) : {};
    return { ok: true, email: m.email, name: m.name, role: m.role, tree: await readTree(sql), now: nowStr(), drafts, test: false };
  };

  A.openSub = async (subId: string, prevRow: any) => {
    const m = await anyRole();
    subId = String(subId);
    let list = await histList(sql, subId);
    const healed = await healWith(sql, subId, list);
    if (healed) list = await histList(sql, subId);
    const p: any = (await readPolicy(sql, subId)) || starter(subId);
    const now = nowStr();
    p.now = now;
    p.pending = !!(p.effAt && p.effAt > now);
    p.draft = m.role === "열람전용" ? null : await readDraft(sql, subId);
    if (healed) p.healed = healed;
    const out: any = { sub: p, hist: histOut(list), now, ver: SRV_VER };
    if (p.pending) {
      let pick = null;
      for (const x of list) { if (x.eff <= now) pick = x; else break; }
      if (pick) {
        const eb = await histBody(sql, pick.row);
        if (eb) out.eff = { effAt: pick.eff, savedAt: pick.saved, by: pick.by, cfg: cfgOf(eb), labels: eb.labels, vendors: eb.vendors,
          base: baseIdx(eb), nw: noteW(eb), data: eb.data, notes: normNotes(eb) };
      }
    }
    const pr = prevOf(list, prevRow ? Number(prevRow) : curRow(list, now));
    if (pr) {
      const pb = await histBody(sql, pr.row);
      if (pb) out.prev = { row: pr.row, ts: pr.eff, savedAt: pr.saved, by: pr.by, kind: pr.kind, cfg: cfgOf(pb), labels: pb.labels,
        vendors: pb.vendors, base: baseIdx(pb), nw: noteW(pb), data: pb.data, notes: normNotes(pb) };
    }
    return out;
  };

  A.homeCards = async (ids: any) => {
    await anyRole();
    ids = Array.isArray(ids) ? ids : [];
    const now = nowStr(), out: any = {}, all = await histAll(sql);
    for (let k = 0; k < ids.length && k < 60; k++) {
      const id = String(ids[k]);
      try {
        const list = (all[id] || []).filter((x: any) => x.kind !== "기타");
        let last: any = null, pending: any = null, li = -1;
        for (let i = 0; i < list.length; i++) {
          if (list[i].eff <= now) { last = list[i]; li = i; } else if (!pending) pending = list[i];
        }
        const prev = li > 0 ? list[li - 1] : null;
        let cnt = null;
        if (last && prev) cnt = diffCounts(await histBody(sql, last.row), await histBody(sql, prev.row));
        out[id] = { any: list.length > 0, cnt,
          last: last ? { ts: last.eff, savedAt: last.saved, by: last.by, row: last.row } : null,
          pending: pending ? { ts: pending.eff, savedAt: pending.saved, by: pending.by, row: pending.row } : null };
      } catch (_) { out[id] = { err: true }; }
    }
    return out;
  };

  A.boot = async (subId: string, mineIds: any) => {
    const out: any = { bootstrap: await A.getBootstrap() };
    if (!out.bootstrap || !out.bootstrap.ok) return out;
    try {
      if (Array.isArray(mineIds) && mineIds.length) out.cards = await A.homeCards(mineIds);
      else if (subId) out.open = await A.openSub(subId);
    } catch (e: any) { out.warn = String((e && e.message) || e); }
    return out;
  };

  A.histWho = async (subId: string, limit: any) => {
    await anyRole();
    const cfg = await subCfg(sql, subId);
    if (cfg && cfg.cmp === false) return { off: true };
    const list = (await histList(sql, subId)).filter((x: any) => x.kind !== "기타");
    if (list.length < 2) return { rows: {} };
    const n = Math.max(2, Math.min(Number(limit) || 36, 60));
    const from = Math.max(1, list.length - n);
    const out: any = {};
    let prev = await histBody(sql, list[from - 1].row);
    for (let i = from; i < list.length; i++) {
      const b = await histBody(sql, list[i].row);
      const w = b && prev ? whoChanged(b, prev) : null;
      if (w) out[list[i].row] = w;
      prev = b || prev;
    }
    return { rows: out };
  };

  A.getSub = async (subId: string) => {
    const m = await anyRole();
    const healed = await healWith(sql, subId, null);
    const p: any = (await readPolicy(sql, subId)) || starter(subId);
    if (healed) p.healed = healed;
    const now = nowStr();
    p.now = now; p.pending = !!(p.effAt && p.effAt > now);
    p.draft = m.role === "열람전용" ? null : await readDraft(sql, subId);
    return p;
  };

  async function getEffective(subId: string) {
    const now = nowStr(), list = await histList(sql, subId);
    let pick: any = null;
    for (const x of list) { if (x.eff <= now) pick = x; else break; }
    if (!pick) return null;
    const b = await histBody(sql, pick.row);
    if (!b) return null;
    return { effAt: pick.eff, savedAt: pick.saved, by: pick.by, cfg: cfgOf(b), labels: b.labels, vendors: b.vendors,
      base: baseIdx(b), nw: noteW(b), data: b.data, notes: normNotes(b) };
  }
  A.getEffective = async (subId: string) => { await anyRole(); return getEffective(String(subId)); };

  A.getHistoryList = async (subId: string) => { await anyRole(); return histOut(await histList(sql, subId)); };

  A.getHistoryAt = async (subId: string, row: any) => {
    await anyRole();
    const r = await sql`select * from pol_hist where id = ${Number(row) || 0}`;
    if (!r.length || String(r[0].sub_id) !== String(subId)) return null;
    const m = histMeta(r[0]), b = r[0].body;
    if (!b) return null;
    return { ts: m.eff, savedAt: m.saved, by: m.by, kind: m.kind, cfg: cfgOf(b), labels: b.labels, vendors: b.vendors,
      base: baseIdx(b), nw: noteW(b), data: b.data, notes: normNotes(b) };
  };

  A.saveDraft = async (subId: string, payload: any, baseRev: any) => {
    const m = await requireRole(["관리자", "편집담당자"]);
    if (!payload || typeof payload !== "object") return { ok: false, reason: "BAD_INPUT" };
    return await withLock(sql, async (tx) => {
      const at = nowStr(), body = await bodyOf(tx, payload, subId);
      await tx`insert into pol_draft (sub_id, base_rev, author, at, body) values (${String(subId)}, ${Number(baseRev) || 0}, ${m.name}, ${at}, ${tx.json(body)})
               on conflict (sub_id) do update set base_rev = excluded.base_rev, author = excluded.author, at = excluded.at, body = excluded.body`;
      return { ok: true, by: m.name, at };
    });
  };
  A.dropDraft = async (subId: string) => {
    await requireRole(["관리자", "편집담당자"]);
    return await withLock(sql, async (tx) => { await tx`delete from pol_draft where sub_id = ${String(subId)}`; return { ok: true }; });
  };

  A.saveSub = async (subId: string, payload: any, baseRev: any, force: any, effAt: any) => {
    const m = await requireRole(["관리자", "편집담당자"]);
    subId = String(subId);
    return await withLock(sql, async (tx) => {
      if (!payload || typeof payload !== "object" || !payload.data) return { ok: false, reason: "BAD_INPUT" };
      const cur = await readPolicy(tx, subId), rev = cur ? cur.rev : 0;
      if (!force && Number(baseRev) !== rev) return { ok: false, reason: "CONFLICT", by: cur ? cur.lastBy : "", at: cur ? cur.savedAt : "", rev };
      const b = await bodyOf(tx, payload, subId);
      const kind = (!cur || priceSig(cur) !== priceSig(b)) ? "단가" : "기타";
      const savedAt = nowStr();
      const eff = kind === "단가" ? cleanTs(effAt) : ((cur && cur.effAt) ? cur.effAt : savedAt);
      const next = rev + 1;
      const back = !!(cur && cur.effAt && eff < cur.effAt);
      if (back) {
        const keep: any = await bodyOf(tx, cur, subId);
        if (cur!.cfg) keep.cfg = cur!.cfg;
        await writePolicy(tx, subId, next, m.name, savedAt, cur!.effAt, keep);
      } else await writePolicy(tx, subId, next, m.name, savedAt, eff, b);
      await appendHist(tx, subId, eff, savedAt, m.name, kind, b);
      await tx`delete from pol_draft where sub_id = ${subId}`;
      return { ok: true, rev: next, savedAt, effAt: eff, by: m.name, kind, back, curEffAt: back ? cur!.effAt : eff,
        pending: !back && eff > savedAt, now: savedAt };
    });
  };

  A.saveTree = async (tree: any) => {
    await requireRole(["관리자"]);
    return await withLock(sql, async (tx) => {
      const before = await readTree(tx), keep: any = {};
      if (!Array.isArray(tree) || !tree.length) return { ok: false, reason: "EMPTY" };
      tree.forEach((c: any) => (c.subs || []).forEach((s: any) => { keep[s.id] = 1; }));
      let wasSubs = 0, nowSubs = 0;
      before.forEach((c) => { wasSubs += (c.subs || []).length; });
      tree.forEach((c: any) => { nowSubs += (c.subs || []).length; });
      if (wasSubs >= 4 && nowSubs * 2 < wasSubs) return { ok: false, reason: "TOO_MANY_REMOVED", was: wasSubs, now: nowSubs };
      if (before.length) await kvSet(tx, "tree_prev", before);
      for (const c of before) for (const s of (c.subs || [])) {
        if (!keep[s.id]) { await deletePolicy(tx, s.id); await tx`delete from pol_draft where sub_id = ${s.id}`; }
      }
      await kvSet(tx, "tree", tree.map((c: any) => ({
        id: c.id, name: c.name, color: c.color || "", logoKey: c.logoKey || "",
        subs: (c.subs || []).map((s: any) => ({ id: s.id, name: s.name, logoKey: s.logoKey || "", gift: s.gift !== false, cmp: s.cmp !== false, vat: !!s.vat })),
      })));
      return { ok: true };
    });
  };

  A.getAllow = async () => { await requireRole(["관리자"]); return await readAllow(sql); };

  A.saveAllow = async (list: any) => {
    const m = await requireRole(["관리자"]);
    if (!Array.isArray(list) || !list.length) return { ok: false, reason: "EMPTY" };
    let admins = 0, selfAdmin = false; const seen: any = {};
    for (const a of list) {
      if (!a || !String(a.em || "").trim() || ROLES.indexOf(a.role) < 0) return { ok: false, reason: "BAD_INPUT" };
      const k = String(a.em).trim().toLowerCase();
      if (seen[k]) return { ok: false, reason: "DUPLICATE" };
      seen[k] = 1;
      if (a.role === "관리자") admins++;
      if (k === m.email.toLowerCase() && a.role === "관리자") selfAdmin = true;
    }
    if (!admins) return { ok: false, reason: "NO_ADMIN" };
    if (!selfAdmin) return { ok: false, reason: "SELF_LOCKOUT" };
    return await withLock(sql, async (tx) => {
      await tx`delete from pol_members`;
      let i = 0;
      for (const a of list) {
        await tx`insert into pol_members (email, name, role, ord) values (${String(a.em).trim().toLowerCase()}, ${String(a.name || "").trim()}, ${a.role}, ${i++})`;
      }
      /* 예전엔 시트 공유도 맞췄지만, 이제는 구글 로그인 + 이 명단만으로 들어옵니다 */
      return { ok: true, shareFail: [], shareLog: "" };
    });
  };
  A.resyncSharing = async () => { await requireRole(["관리자"]); return A.shareCheck(); };
  A.shareCheck = async () => {
    await requireRole(["관리자"]);
    const l = await readAllow(sql);
    return ["Supabase 로 옮긴 뒤로는 시트 공유가 필요 없습니다.", "명단에 있는 구글 계정이면 바로 들어옵니다.", "",
      "■ 명단"].concat(l.map((a: any) => "  " + a.role + "  " + a.em + "  " + (a.name || ""))).join("\n");
  };

  /* ── 정책지 ── */
  A.getPSheet = async (gid: any) => {
    await anyRole();
    gid = String(gid || "");
    const r = await sql`select rev, at, tpl from pol_psheet where gid = ${gid}`;
    return { ok: true, gid, rev: r.length ? Number(r[0].rev) || 0 : 0, at: r.length ? r[0].at || "" : "",
      tpl: r.length ? (r[0].tpl || null) : null, hist: await psHistList(sql, gid, 80) };
  };
  A.getPSheetAt = async (row: any) => {
    await anyRole();
    const r = await sql`select * from pol_psheet_hist where id = ${Number(row) || 0}`;
    if (!r.length) return { ok: false, reason: "NOT_FOUND" };
    const x = r[0];
    return { ok: true, row: Number(x.id), gid: String(x.gid), at: x.at || "", by: x.author || "", eff: x.eff || "", snap: x.snap };
  };
  A.savePSheet = async (gid: any, tpl: any, snap: any, baseRev: any, effAt: any, keepRow: any) => {
    const m = await requireRole(["관리자", "편집담당자"]);
    gid = String(gid || "").substr(0, 60);
    if (!gid || !tpl || typeof tpl !== "object" || !Array.isArray(tpl.rows)) return { ok: false, reason: "BAD_INPUT" };
    const tj = JSON.stringify(tpl), sj = snap ? JSON.stringify(snap) : "";
    if (tj.length > PS_MAX || sj.length > PS_MAX) return { ok: false, reason: "TOO_BIG" };
    if (m.role !== "관리자") {
      const gc = (await readGrades(sql)).cfg || {};
      let owner = "";
      Object.keys(gc.carriers || {}).forEach((cid) => {
        if (((gc.carriers[cid] || {}).rows || []).some((r: any) => String(r.id) === gid)) owner = cid;
      });
      if (!owner) owner = await ptMixOwner(sql, gid);
      if (!owner) return { ok: false, reason: "NO_GRADE" };
      const op = ptConfPublic(await ptConfRead(sql)).open;
      if (op && op.indexOf(owner) < 0) return { ok: false, reason: "CLOSED" };
    }
    return await withLock(sql, async (tx) => {
      const cur = await tx`select rev, author, at from pol_psheet where gid = ${gid}`;
      const rev = cur.length ? Number(cur[0].rev) || 0 : 0;
      if ((Number(baseRev) || 0) !== rev) return { ok: false, reason: "CONFLICT", by: cur.length ? cur[0].author : "", at: cur.length ? cur[0].at : "" };
      const at = nowStr(), by = m.name || m.email;
      const eff = TS_RE.test(String(effAt || "")) ? String(effAt) : at;
      const kr = Number(keepRow) || 0;
      if (sj && kr) {
        const k = await tx`select * from pol_psheet_hist where id = ${kr}`;
        if (!k.length || String(k[0].gid) !== gid) return { ok: false, reason: "NOT_FOUND" };
        const lastH = (await psHistList(tx, gid, 1))[0];
        if (m.role !== "관리자" && (!lastH || lastH.row !== kr)) return { ok: false, reason: "NOT_LATEST" };
        await tx`insert into pol_trash (kind, ref, deleted_at, deleted_by, data)
                 values ('덮어쓴 발행', ${gid}, ${nowStr()}, ${by}, ${tx.json({ row: kr, at: k[0].at, by: k[0].author, eff: k[0].eff, snap: k[0].snap })})`;
      }
      await tx`insert into pol_psheet (gid, rev, author, at, tpl) values (${gid}, ${rev + 1}, ${by}, ${at}, ${tx.json(tpl)})
               on conflict (gid) do update set rev = excluded.rev, author = excluded.author, at = excluded.at, tpl = excluded.tpl`;
      if (sj && kr) await tx`update pol_psheet_hist set at = ${at}, author = ${by}, snap = ${tx.json(snap)} where id = ${kr}`;
      else if (sj) await tx`insert into pol_psheet_hist (gid, at, author, eff, snap) values (${gid}, ${at}, ${by}, ${eff}, ${tx.json(snap)})`;
      return { ok: true, rev: rev + 1, at, by, hist: await psHistList(tx, gid, 80) };
    });
  };
  A.deletePSheet = async (gid: any) => {
    const m = await requireRole(["관리자"]);
    gid = String(gid || "");
    if (!gid) return { ok: false, reason: "BAD_INPUT" };
    return await withLock(sql, async (tx) => {
      const now = nowStr(), by = m.name || m.email;
      let moved = 0;
      const t = await tx`select * from pol_psheet where gid = ${gid}`;
      if (t.length) {
        await tx`insert into pol_trash (kind, ref, deleted_at, deleted_by, data) values ('틀', ${gid}, ${now}, ${by},
                 ${tx.json({ rev: t[0].rev, at: t[0].at, by: t[0].author, tpl: t[0].tpl })})`;
        await tx`delete from pol_psheet where gid = ${gid}`; moved++;
      }
      const h = await tx`select * from pol_psheet_hist where gid = ${gid} order by id desc`;
      for (const x of h) {
        await tx`insert into pol_trash (kind, ref, deleted_at, deleted_by, data) values ('발행', ${gid}, ${now}, ${by},
                 ${tx.json({ row: Number(x.id), at: x.at, by: x.author, eff: x.eff, snap: x.snap })})`;
        moved++;
      }
      await tx`delete from pol_psheet_hist where gid = ${gid}`;
      if (!moved) return { ok: false, reason: "NOT_FOUND" };
      return { ok: true, moved };
    });
  };
  A.deletePSheetAt = async (gid: any, row: any) => {
    const m = await requireRole(["관리자"]);
    gid = String(gid || ""); row = Number(row) || 0;
    return await withLock(sql, async (tx) => {
      const h = await tx`select * from pol_psheet_hist where id = ${row}`;
      if (!gid || !h.length || String(h[0].gid) !== gid) return { ok: false, reason: "NOT_FOUND" };
      await tx`insert into pol_trash (kind, ref, deleted_at, deleted_by, data) values ('발행', ${gid}, ${nowStr()}, ${m.name || m.email},
               ${tx.json({ row, at: h[0].at, by: h[0].author, eff: h[0].eff, snap: h[0].snap })})`;
      await tx`delete from pol_psheet_hist where id = ${row}`;
      return { ok: true, hist: await psHistList(tx, gid, 80) };
    });
  };

  A.ptSource = async (subIds: any) => {
    await requireRole(ROLES);
    const out: any = {}, now = nowStr();
    const tree = await readTree(sql);
    for (const sid0 of (Array.isArray(subIds) ? subIds : []).slice(0, 40)) {
      const sid = String(sid0);
      try {
        let p: any = await readPolicy(sql, sid), pend: any = null;
        if (p && p.effAt && p.effAt > now) {
          pend = { effAt: p.effAt, vendors: p.vendors, data: p.data, labels: p.labels, base: p.base, cfg: p.cfg || subCfgFrom(tree, sid) };
          const e = await getEffective(sid);
          p = e ? { effAt: e.effAt, vendors: e.vendors, data: e.data, labels: e.labels, base: e.base, cfg: e.cfg } : null;
        }
        if (p) out[sid] = { effAt: p.effAt, vendors: p.vendors, data: p.data, labels: p.labels, base: p.base, cfg: p.cfg || subCfgFrom(tree, sid) };
        else if (pend) { out[sid] = pend; pend = null; }
        if (pend) out[sid].pend = pend;
      } catch (e: any) { out[sid] = { err: String((e && e.message) || e) }; }
    }
    return { ok: true, now, src: out };
  };

  /* ── 협력점 정책 설정 ── */
  A.setPtMix = async (cid: any, list: any) => {
    const m = await requireRole(["관리자", "편집담당자"]);
    cid = gradeStr(cid, 60);
    if (!cid || !Array.isArray(list) || list.length > 10) return { ok: false, reason: "BAD_INPUT" };
    const gc = (await readGrades(sql)).cfg || {}, car = (gc.carriers || {})[cid];
    if (!car) return { ok: false, reason: "NO_GRADE" };
    const have: any = {}; (car.rows || []).forEach((r: any) => { have[String(r.id)] = true; });
    if (m.role !== "관리자") {
      const op = ptConfPublic(await ptConfRead(sql)).open;
      if (op && op.indexOf(cid) < 0) return { ok: false, reason: "CLOSED" };
    }
    const out: any[] = [], seen: any = {};
    for (const x0 of list) {
      const x = x0 || {}, id = gradeStr(x.id, 20), n = gradeStr(x.n, 30), g = Array.isArray(x.gids) ? x.gids : [];
      if (!id || !/^[A-Za-z0-9_-]+$/.test(id) || seen[id] || !n || g.length < 1 || g.length > 4) return { ok: false, reason: "BAD_INPUT" };
      const gs: string[] = [], gseen: any = {};
      for (const g0 of g) { const gg = String(g0 || ""); if (!have[gg] || gseen[gg]) return { ok: false, reason: "BAD_INPUT" }; gseen[gg] = 1; gs.push(gg); }
      seen[id] = 1; out.push({ id, n, gids: gs });
    }
    const r: any = await withLock(sql, async (tx) => {
      const all = ptConfPublic(await ptConfRead(tx)).mix;
      for (const o of out) {
        if (Object.keys(all).some((c2) => c2 !== cid && (all[c2] || []).some((y: any) => String(y.id) === o.id))) return { ok: false, reason: "BAD_INPUT" };
      }
      if (out.length) all[cid] = out; else delete all[cid];
      await kvSet(tx, "pt_mix", all);
      return { ok: true };
    });
    if (!r.ok) return r;
    return { ok: true, conf: ptConfPublic(await ptConfRead(sql)) };
  };
  A.setPtOpen = async (ids: any) => {
    await requireRole(["관리자"]);
    if (ids !== null && (!Array.isArray(ids) || ids.length > 40)) return { ok: false, reason: "BAD_INPUT" };
    await kvSet(sql, "pt_open", ids === null ? null : ids.map((x: any) => gradeStr(x, 60)));
    return { ok: true, conf: ptConfPublic(await ptConfRead(sql)) };
  };
  A.setPtPw = async (key: any, pw: any) => {
    await requireRole(["관리자"]);
    key = gradeStr(key, 60); pw = String(pw == null ? "" : pw);
    if (!key || pw.length > 50) return { ok: false, reason: "BAD_INPUT" };
    if (pw && pw.length < 4) return { ok: false, reason: "TOO_SHORT" };
    if (!pw) await sql`delete from pol_secret where key = ${"pw:" + key}`;
    else {
      const salt = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const v = "v2:" + salt + ":" + (await ptHash2(salt, pw));
      await sql`insert into pol_secret (key, value) values (${"pw:" + key}, ${v}) on conflict (key) do update set value = excluded.value`;
    }
    return { ok: true, conf: ptConfPublic(await ptConfRead(sql)) };
  };
  A.checkPtPw = async (key: any, pw: any) => {
    const m = await requireRole(["관리자", "편집담당자"]);
    if (m.role === "관리자") return { ok: true };
    if (await ptPwLocked(sql, m.email)) return { ok: false, reason: "PW_LOCKED" };
    await new Promise((r) => setTimeout(r, 300));
    const ok = await ptPwOk(await ptConfRead(sql), gradeStr(key, 60), pw);
    if (!ok) await ptPwFail(sql, m.email);
    return { ok };
  };

  /* ── 등급 차감표 ── */
  A.getGrades = async () => {
    await requireRole(ROLES);
    const g = await readGrades(sql);
    let ch = {}; try { ch = await subChans(sql); } catch (_) { /* 없어도 됨 */ }
    return { ok: true, rev: g.rev, by: g.by, at: g.at, cfg: g.cfg, hist: await gradeHistList(sql, 30), chans: ch, conf: ptConfPublic(await ptConfRead(sql)) };
  };
  A.getGradeAt = async (row: any) => {
    await requireRole(ROLES);
    const r = await sql`select * from pol_grades_hist where id = ${Number(row) || 0}`;
    if (!r.length) return { ok: false, reason: "NOT_FOUND" };
    return { ok: true, row: Number(r[0].id), at: r[0].at || "", by: r[0].author || "", cfg: r[0].cfg };
  };
  A.saveGrades = async (cfg: any, baseRev: any, pws: any) => {
    const m = await requireRole(["관리자", "편집담당자"]);
    const clean = cleanGrades(cfg);
    if (!clean) return { ok: false, reason: "BAD_INPUT" };
    return await withLock(sql, async (tx) => {
      const cur = await readGrades(tx);
      if ((Number(baseRev) || 0) !== cur.rev) return { ok: false, reason: "CONFLICT", by: cur.by, at: cur.at };
      const tree = await readTree(tx);
      if (m.role !== "관리자") {
        const tIds: any = {}; tree.forEach((t) => { tIds[t.id] = 1; });
        const bad = Object.keys(clean.carriers).some((k) => !tIds[k] && !((cur.cfg || {}).carriers || {})[k])
          || (clean.deal || []).some((d: any) => d.cid && !tIds[d.cid])
          || (clean.grades || []).some((g: any) => g.cid && !tIds[g.cid]);
        if (bad) return { ok: false, reason: "BAD_INPUT" };
        const conf = await ptConfRead(tx), pub = ptConfPublic(conf), a = cleanGrades(cur.cfg) || cur.cfg || {}, need: any[] = [];
        const ids: any = {};
        Object.keys(a.carriers || {}).forEach((k) => { ids[k] = 1; });
        Object.keys(clean.carriers).forEach((k) => { ids[k] = 1; });
        const dealOf = (list: any[], k: string) => JSON.stringify((list || []).filter((d: any) => (d.cid || "") === k));
        (a.deal || []).concat(clean.deal || []).forEach((d: any) => { if (d.cid) ids[d.cid] = 1; });
        const cidKeys: any = {};
        (a.grades || []).concat(clean.grades || []).forEach((g: any) => { if (g.cid) { cidKeys[g.k] = 1; ids[g.cid] = 1; } });
        const scope = (c: any, k: string) => {
          const gl = (c.grades || []).filter((g: any) => (g.cid || "") === k);
          const vis: any = {}; (c.grades || []).forEach((g: any) => { if (g.cid === k) vis[g.k] = 1; });
          const od = c.order == null || !gl.length ? null : c.order.filter((x: string) => GRADE_KEYS.indexOf(x) >= 0 || vis[x]);
          return JSON.stringify([gl, k ? od : null]);
        };
        Object.keys(ids).forEach((k) => {
          if (ptCarKey((a.carriers || {})[k]) === ptCarKey(clean.carriers[k]) && dealOf(a.deal, k) === dealOf(clean.deal, k)
            && scope(a, k) === scope(clean, k)) return;
          if (pub.open && pub.open.indexOf(k) < 0) need.push({ key: k, closed: true });
          else need.push({ key: k });
        });
        const comOnly = (c: any, f: string) => {
          if (f === "grades") return (c.grades || []).filter((g: any) => !g.cid);
          if (f === "order") return c.order == null ? null : c.order.filter((x: string) => !cidKeys[x]);
          return c[f] == null ? null : c[f];
        };
        const cm = dealOf(a.deal, "") !== dealOf(clean.deal, "") || ["grades", "order", "own"].some((f) => {
          const x = comOnly(a, f), y = comOnly(clean, f);
          if (f === "order" && x == null) return false;
          return JSON.stringify(x) !== JSON.stringify(y);
        });
        if (cm) need.push({ key: "common" });
        for (const nd of need) {
          if (nd.closed) return { ok: false, reason: "CLOSED", key: nd.key };
          if (conf["pw:" + nd.key] && await ptPwLocked(tx, m.email)) return { ok: false, reason: "PW_LOCKED", key: nd.key };
          if (!(await ptPwOk(conf, nd.key, pws && pws[nd.key]))) {
            if (pws && pws[nd.key]) await ptPwFail(tx, m.email);
            return { ok: false, reason: pws && pws[nd.key] ? "PW_WRONG" : "PW_REQUIRED", key: nd.key };
          }
        }
      }
      const at = nowStr(), rev = cur.rev + 1, by = m.name || m.email;
      await tx`insert into pol_grades (id, rev, author, at, cfg) values (1, ${rev}, ${by}, ${at}, ${tx.json(clean)})
               on conflict (id) do update set rev = excluded.rev, author = excluded.author, at = excluded.at, cfg = excluded.cfg`;
      await tx`insert into pol_grades_hist (at, author, what, cfg) values (${at}, ${by}, ${gradeDiff(cleanGrades(cur.cfg) || cur.cfg, clean, tree)}, ${tx.json(clean)})`;
      return { ok: true, rev, by, at, cfg: clean, hist: await gradeHistList(tx, 30) };
    });
  };

  /* ── 진단 · 관리 ── */
  A.diagnoseWeb = async () => {
    const m = await me();
    return ["접속 계정 : " + (m.email || email || "(없음)"), "저장소 : Supabase (pol_ 테이블)",
      "내 권한 : " + (m.role || "(명단에 없음)"), "서버 판 : " + SRV_VER].join("\n");
  };
  A.diagnose = A.diagnoseWeb;

  A.deleteHist = async (subId: any, row: any, expectTs: any, expectSaved: any) => {
    const m = await requireRole(["관리자"]);
    subId = String(subId); row = Number(row) || 0;
    return await withLock(sql, async (tx) => {
      const r = await tx`select id, sub_id, eff_at, saved_at, author, kind from pol_hist where id = ${row}`;
      if (!r.length || String(r[0].sub_id) !== subId) return { ok: false, reason: "NOT_FOUND" };
      const cm = histMeta(r[0]);
      if (expectTs && TS_RE.test(String(expectTs)) && String(expectTs) !== cm.eff) return { ok: false, reason: "STALE", at: cm.eff };
      if (expectSaved && TS_RE.test(String(expectSaved)) && String(expectSaved) !== cm.saved) return { ok: false, reason: "STALE", at: cm.eff, saved: cm.saved };
      await trashHistRow(tx, row, "이력", m.name || m.email);
      await tx`delete from pol_hist where id = ${row}`;
      const eff = await resyncPolicy(tx, subId);
      if (eff === "\u0000FAIL") return { ok: true, effAt: "", warn: "RESYNC_FAILED" };
      return { ok: true, effAt: eff, empty: !eff };
    });
  };

  A.editHist = async (subId: any, row: any, payload: any, effAt: any, expectTs: any, expectSaved: any) => {
    const m = await requireRole(["관리자", "편집담당자"]);
    subId = String(subId); row = Number(row) || 0;
    return await withLock(sql, async (tx) => {
      const r = await tx`select * from pol_hist where id = ${row}`;
      if (!r.length || String(r[0].sub_id) !== subId) return { ok: false, reason: "NOT_FOUND" };
      const meta = histMeta(r[0]);
      if (expectTs && TS_RE.test(String(expectTs)) && String(expectTs) !== meta.eff) return { ok: false, reason: "STALE", at: meta.eff };
      if (expectSaved && TS_RE.test(String(expectSaved)) && String(expectSaved) !== meta.saved) return { ok: false, reason: "STALE", at: meta.eff, saved: meta.saved };
      await trashHistRow(tx, row, "이력 정정 전", m.name || m.email);
      const b: any = await bodyOf(tx, payload || {});
      const oldCfg = cfgOf(r[0].body);
      if (oldCfg) b.cfg = oldCfg; else { const nc = await subCfg(tx, subId); if (nc) b.cfg = nc; }
      const eff = TS_RE.test(String(effAt || "").trim()) ? String(effAt).trim() : meta.eff;
      const tag = (meta.kind || "단가") + "@" + m.name + "@" + nowSec();
      await tx`update pol_hist set eff_at = ${eff}, kind = ${tag}, body = ${tx.json(b)} where id = ${row}`;
      let cur = await resyncPolicy(tx, subId);
      if (cur === "\u0000FAIL") cur = "";
      return { ok: true, effAt: eff, curEffAt: cur, movedTo: eff !== meta.eff ? eff : "" };
    });
  };

  A.wipeSub = async (subId: any) => {
    const m = await requireRole(["관리자"]);
    subId = String(subId);
    return await withLock(sql, async (tx) => {
      const rows = await tx`select id from pol_hist where sub_id = ${subId} order by id`;
      for (const x of rows) await trashHistRow(tx, Number(x.id), "이력", m.name || m.email);
      await tx`delete from pol_hist where sub_id = ${subId}`;
      await deletePolicy(tx, subId);
      await tx`delete from pol_draft where sub_id = ${subId}`;
      return { ok: true, removed: rows.length };
    });
  };
  A.listSubs = async () => {
    await requireRole(["관리자"]);
    const out: string[] = [];
    (await readTree(sql)).forEach((c) => (c.subs || []).forEach((s: any) => out.push(c.name + " > " + s.name + "   →   " + s.id)));
    return out.join("\n");
  };

  A.diagSub = async (subId: any) => {
    await requireRole(["관리자"]);
    subId = String(subId);
    const p = await readPolicy(sql, subId), list = await histList(sql, subId), pick = pickCurrent(list);
    const hasReal: any = {}; list.forEach((m: any) => { if (m.kind !== "기타") hasReal[m.eff] = 1; });
    return { ok: true, subId, ver: SRV_VER,
      policy: p ? { effAt: p.effAt, savedAt: p.savedAt, rev: p.rev, by: p.lastBy, vendors: (p.vendors || []).length,
        rows: (p.data || []).reduce((n: number, g: any) => n + ((g.rows || []).length), 0) } : null,
      hist: list.map((m: any) => ({ row: m.row, eff: m.eff, saved: m.saved, kind: m.kind, by: m.by, fixBy: m.fixBy || "", start: 0,
        orphan: m.kind === "기타" && !hasReal[m.eff] })),
      should: pick ? pick.eff : "", mismatch: !!(p && pick && p.effAt !== pick.eff) };
  };

  async function repairCurrentAll() {
    const per = await histAll(sql);
    const out: string[] = []; let fixed = 0, failed = 0;
    const ids = Object.keys(per);
    for (const id of ids) {
      const list = per[id], pick = pickCurrent(list);
      if (!pick) continue;
      const res: any = await withLock(sql, async (tx) => {
        const body = await histBody(tx, pick.row);
        if (!body) return { fail: true };
        const p = await readPolicy(tx, id), before = p ? p.effAt : "(없음)";
        if (before === pick.eff) return { same: true };
        await writePolicy(tx, id, (p ? p.rev : 0) + 1, pick.by, nowStr(), pick.eff, body);
        return { before };
      });
      if (res.fail) { out.push(id + " : ★ 이력 본문을 읽지 못해 건너뜀"); failed++; continue; }
      if (res.same || res.ok === false) continue;
      out.push(id + " : " + res.before + " → " + pick.eff);
      const orph = list.filter((x: any) => x.kind === "기타" && x.eff === res.before).length;
      if (orph) out.push("   └ 없어진 " + res.before + " 시점의 기타 저장 " + orph + "건(메모·이름 수정)은 이력에만 남습니다");
      fixed++;
    }
    const msg = fixed ? ("현재 정책을 " + fixed + "건 바로잡았습니다.\n" + out.join("\n"))
      : failed ? ("고치지 못한 중분류가 " + failed + "건 있습니다.\n" + out.join("\n"))
      : ("모두 정상입니다. (중분류 " + ids.length + "개 확인)");
    return { ok: true, fixed, failed, msg };
  }
  A.repairCurrent = async () => { await requireRole(["관리자"]); return await repairCurrentAll(); };
  A.fixCurrent = async () => { await requireRole(["관리자"]); return (await repairCurrentAll()).msg; };

  /* ── 메모 ── */
  A.getMemos = async (cids: any) => { const m = await requireRole(ROLES); return { ok: true, list: await memoRead(sql, m, cids) }; };
  A.saveMemo = async (x: any, baseAt: any, cids: any) => {
    const m = await requireRole(ROLES);
    x = x || {};
    const cat = String(x.cat || ""), t = gradeStr(x.t, 100), b = String(x.b == null ? "" : x.b).replace(/\r|\u0000/g, "").substr(0, 5000);
    if (MEMO_CATS.indexOf(cat) < 0 || (!t && !b)) return { ok: false, reason: "BAD_INPUT" };
    return await withLock(sql, async (tx) => {
      const at = nowStr();
      let id = String(x.id || "");
      if (x.id) {
        const cur = await tx`select email, at from pol_memo where id = ${id}`;
        if (!cur.length) return { ok: false, reason: "NOT_FOUND" };
        if (String(cur[0].email || "").toLowerCase() !== m.email.toLowerCase()) return { ok: false, reason: "NOT_OWNER" };
        if (baseAt && String(cur[0].at || "") !== String(baseAt)) return { ok: false, reason: "CONFLICT" };
      } else id = "m" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
      let mc: string[] = [];
      if (x.shared) {
        const ok: any = {}; (await readTree(tx)).forEach((c) => { ok[String(c.id)] = 1; });
        (Array.isArray(x.cids) ? x.cids : []).slice(0, 40).forEach((c: any) => { c = String(c || ""); if (ok[c] && mc.indexOf(c) < 0) mc.push(c); });
        if (!mc.length) return { ok: false, reason: "NO_CARRIER" };
      }
      await tx`insert into pol_memo (id, email, author, shared, cat, title, body, at, done, cids)
               values (${id}, ${m.email}, ${m.name || m.email}, ${!!x.shared}, ${cat}, ${t}, ${b}, ${at}, ${!!x.done}, ${mc})
               on conflict (id) do update set author = excluded.author, shared = excluded.shared, cat = excluded.cat,
                 title = excluded.title, body = excluded.body, at = excluded.at, done = excluded.done, cids = excluded.cids`;
      return { ok: true, id, at, list: await memoRead(tx, m, cids) };
    });
  };
  A.deleteMemo = async (id: any, cids: any) => {
    const m = await requireRole(ROLES);
    return await withLock(sql, async (tx) => {
      const cur = await tx`select email, shared from pol_memo where id = ${String(id)}`;
      if (!cur.length) return { ok: false, reason: "NOT_FOUND" };
      const own = String(cur[0].email || "").toLowerCase() === m.email.toLowerCase();
      if (!own && !(m.role === "관리자" && cur[0].shared)) return { ok: false, reason: "NOT_OWNER" };
      await tx`delete from pol_memo where id = ${String(id)}`;
      return { ok: true, list: await memoRead(tx, m, cids) };
    });
  };

  /* ── 예전 구글 시트에서 옮기기 (관리자 · 한 번만) ──
     내보내기 파일을 조각으로 나눠 보냅니다. part: 'begin' | 'members' | 'kv' | 'policy' | 'draft' | 'hist' | 'grades'
     | 'gradesHist' | 'psheet' | 'psheetHist' | 'memo' | 'secret' | 'end'. 행 번호(id)는 그대로 옮깁니다. */
  A.importPart = async (part: string, rows: any) => {
    await requireRole(["관리자"]);
    rows = Array.isArray(rows) ? rows : (rows == null ? [] : [rows]);
    return await withLock(sql, async (tx) => {
      let n = 0;
      if (part === "begin") {
        /* 다시 가져올 수 있게 — 이 앱 테이블만 비웁니다 (명단은 가져올 파일에 있을 때만 바꿈) */
        await tx`delete from pol_policy`; await tx`delete from pol_draft`; await tx`delete from pol_hist`;
        await tx`delete from pol_grades`; await tx`delete from pol_grades_hist`; await tx`delete from pol_psheet`;
        await tx`delete from pol_psheet_hist`; await tx`delete from pol_memo`; await tx`delete from pol_trash`;
        await tx`delete from pol_kv where key in ('tree_prev', 'pt_open', 'pt_mix')`; await tx`delete from pol_secret`; await tx`delete from pol_pwfail`;
        await fixSeq(tx);
        return { ok: true };
      }
      if (part === "members") {
        if (!rows.length) return { ok: false, reason: "EMPTY" };
        await tx`delete from pol_members`;
        rows.forEach((a: any, i: number) => { a._i = i; });
        for (const a of rows) {
          const em = String(a.em || a.email || "").trim().toLowerCase(); if (!em) continue;
          const role = ROLES.indexOf(a.role) >= 0 ? a.role : "열람전용";
          await tx`insert into pol_members (email, name, role, ord) values (${em}, ${String(a.name || "")}, ${role}, ${a._i})
                   on conflict (email) do update set name = excluded.name, role = excluded.role, ord = excluded.ord`;
          n++;
        }
        const self = await meOf(tx, email);
        if (self.role !== "관리자") throw new ApiError("SELF_LOCKOUT");      // 가져온 명단에 내가 관리자로 없으면 되돌림
      } else if (part === "kv") {
        for (const x of rows) { if (["tree", "tree_prev", "pt_open", "pt_mix"].indexOf(x.key) < 0) continue; await kvSet(tx, x.key, x.value); n++; }
      } else if (part === "policy") {
        for (const x of rows) { await writePolicy(tx, String(x.subId), Number(x.rev) || 0, String(x.lastBy || ""), String(x.savedAt || ""), String(x.effAt || x.savedAt || ""), x.body || {}); n++; }
      } else if (part === "draft") {
        for (const x of rows) {
          await tx`insert into pol_draft (sub_id, base_rev, author, at, body) values (${String(x.subId)}, ${Number(x.baseRev) || 0}, ${String(x.by || "")}, ${String(x.at || "")}, ${tx.json(x.body || {})})
                   on conflict (sub_id) do update set base_rev = excluded.base_rev, author = excluded.author, at = excluded.at, body = excluded.body`;
          n++;
        }
      } else if (part === "hist") {
        for (const x of rows) {
          await tx`insert into pol_hist (id, sub_id, eff_at, saved_at, author, kind, body)
                   values (${Number(x.row)}, ${String(x.subId)}, ${String(x.eff)}, ${String(x.saved)}, ${String(x.by || "")}, ${String(x.kind || "단가")}, ${tx.json(x.body || {})})
                   on conflict (id) do update set sub_id = excluded.sub_id, eff_at = excluded.eff_at, saved_at = excluded.saved_at,
                     author = excluded.author, kind = excluded.kind, body = excluded.body`;
          n++;
        }
      } else if (part === "grades") {
        for (const x of rows) {
          await tx`insert into pol_grades (id, rev, author, at, cfg) values (1, ${Number(x.rev) || 0}, ${String(x.by || "")}, ${String(x.at || "")}, ${tx.json(x.cfg || null)})
                   on conflict (id) do update set rev = excluded.rev, author = excluded.author, at = excluded.at, cfg = excluded.cfg`;
          n++;
        }
      } else if (part === "gradesHist") {
        for (const x of rows) {
          await tx`insert into pol_grades_hist (id, at, author, what, cfg) values (${Number(x.row)}, ${String(x.at || "")}, ${String(x.by || "")}, ${String(x.what || "")}, ${tx.json(x.cfg || null)})
                   on conflict (id) do update set at = excluded.at, author = excluded.author, what = excluded.what, cfg = excluded.cfg`;
          n++;
        }
      } else if (part === "psheet") {
        for (const x of rows) {
          await tx`insert into pol_psheet (gid, rev, author, at, tpl) values (${String(x.gid)}, ${Number(x.rev) || 0}, ${String(x.by || "")}, ${String(x.at || "")}, ${tx.json(x.tpl || null)})
                   on conflict (gid) do update set rev = excluded.rev, author = excluded.author, at = excluded.at, tpl = excluded.tpl`;
          n++;
        }
      } else if (part === "psheetHist") {
        for (const x of rows) {
          await tx`insert into pol_psheet_hist (id, gid, at, author, eff, snap) values (${Number(x.row)}, ${String(x.gid)}, ${String(x.at || "")}, ${String(x.by || "")}, ${String(x.eff || "")}, ${tx.json(x.snap || null)})
                   on conflict (id) do update set gid = excluded.gid, at = excluded.at, author = excluded.author, eff = excluded.eff, snap = excluded.snap`;
          n++;
        }
      } else if (part === "memo") {
        for (const x of rows) {
          if (MEMO_CATS.indexOf(x.cat) < 0) continue;
          await tx`insert into pol_memo (id, email, author, shared, cat, title, body, at, done, cids)
                   values (${String(x.id)}, ${String(x.email || "").toLowerCase()}, ${String(x.by || "")}, ${!!x.shared}, ${x.cat}, ${String(x.t || "")}, ${String(x.b || "")}, ${String(x.at || "")}, ${!!x.done}, ${(x.cids || []).map(String)})
                   on conflict (id) do update set email = excluded.email, author = excluded.author, shared = excluded.shared, cat = excluded.cat,
                     title = excluded.title, body = excluded.body, at = excluded.at, done = excluded.done, cids = excluded.cids`;
          n++;
        }
      } else if (part === "secret") {
        for (const x of rows) {
          const k = String(x.key || ""); if (k.indexOf("pw:") !== 0 || !x.value) continue;
          await tx`insert into pol_secret (key, value) values (${k}, ${String(x.value)}) on conflict (key) do update set value = excluded.value`;
          n++;
        }
      } else if (part === "end") {
        /* 옮긴 행 번호 다음부터 새 번호가 이어지게 */
        await fixSeq(tx);
        /* 예전 시트에서 현재본을 못 읽어 빠진 중분류는 이력으로 다시 세웁니다 */
        for (const x of await tx`select distinct sub_id from pol_hist h where not exists (select 1 from pol_policy p where p.sub_id = h.sub_id)`)
          await resyncPolicy(tx, x.sub_id);
        const c = await tx`select (select count(*) from pol_hist)::int as hist, (select count(*) from pol_policy)::int as policy,
                                  (select count(*) from pol_psheet)::int as psheet, (select count(*) from pol_psheet_hist)::int as psheet_hist,
                                  (select count(*) from pol_grades_hist)::int as grades_hist, (select count(*) from pol_memo)::int as memo,
                                  (select count(*) from pol_members)::int as members`;
        return { ok: true, counts: c[0] };
      } else return { ok: false, reason: "BAD_PART" };
      if (part === "hist" || part === "gradesHist" || part === "psheetHist") await fixSeq(tx);   // 중간에 멈춰도 새 저장 번호가 겹치지 않게
      return { ok: true, n };
    });
  };

  return A;
}
