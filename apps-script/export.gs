/****************************************************************************
 * 상부정책 관리 — 구글 시트 → Supabase 옮기기용 내보내기 (한 번만 실행)
 *
 * 쓰는 법
 *   1) 지금 쓰는 Apps Script 프로젝트(Code.gs 가 있는 곳)에 이 파일을 새 스크립트 파일로 붙여 넣습니다.
 *   2) 위쪽 함수 고르는 칸에서 exportForSupabase 를 고르고 ▶ 실행.
 *      (처음 한 번 Drive 권한을 물어보면 허용)
 *   3) 실행 로그에 나온 Drive 파일(policy_export_날짜.json)을 내려받습니다.
 *   4) 새 웹앱(GitHub Pages)에 관리자로 로그인 → ⚙ 관리 → "예전 시트 데이터 가져오기" 에서 그 파일을 고릅니다.
 *
 * 시트의 정책 · 이력 내용은 바꾸지 않습니다. (예전 PT_설정 시트에 비밀번호 줄이 남아 있으면
 * 평소 앱이 하던 대로 스크립트 속성으로 옮겨지는 정도입니다)
 * 휴지통 시트는 옮기지 않습니다 — 예전 시트에 그대로 남아 있으니 필요하면 거기서 보면 됩니다.
 ****************************************************************************/
function exportForSupabase() {
  var ss = ss_(), out = { v: 1, from: ss.getId(), at: nowStr_(), parts: {} };
  var P = out.parts;

  /* 명단 */
  P.members = readAllow_().map(function (a) { return { em: a.em.toLowerCase(), name: a.name, role: a.role }; });

  /* 구조 · 협력점 설정 */
  P.kv = [{ key: 'tree', value: readTree_() }];
  try {
    var prev = readChunks_(treeSheet_(), 2, 1);
    if (prev) P.kv.push({ key: 'tree_prev', value: JSON.parse(prev) });
  } catch (e) {}
  var conf = ptConfRead_();
  if (conf.open != null) { try { P.kv.push({ key: 'pt_open', value: JSON.parse(conf.open) }); } catch (e) {} }
  if (conf.mix) { try { P.kv.push({ key: 'pt_mix', value: JSON.parse(conf.mix) }); } catch (e) {} }
  P.secret = Object.keys(conf).filter(function (k) { return k.indexOf('pw:') === 0 && conf[k]; })
    .map(function (k) { return { key: k, value: conf[k] }; });

  /* 현재 정책 */
  P.policy = [];
  var bad = [];
  readTree_().forEach(function (c) {
    (c.subs || []).forEach(function (s) {
      try {
        var p = readPolicy_(s.id); if (!p) return;
        var body = { labels: p.labels, vendors: p.vendors, base: p.base, nw: p.nw, data: p.data, notes: p.notes };
        if (p.cfg) body.cfg = p.cfg;
        P.policy.push({ subId: String(s.id), rev: p.rev, lastBy: p.lastBy, savedAt: p.savedAt, effAt: p.effAt, body: body });
      } catch (e) { bad.push('정책 ' + s.id + ': ' + (e && e.message || e)); }
    });
  });

  /* 초안 */
  P.draft = [];
  var dsh = draftSheet_(), dl = dsh.getLastRow();
  for (var r = 2; r <= dl; r++) {
    var h = dsh.getRange(r, 1, 1, 4).getValues()[0]; if (!String(h[0] || '')) continue;
    try {
      P.draft.push({ subId: String(h[0]), baseRev: Number(h[1]) || 0, by: String(h[2] || ''), at: tsCell_(h[3]),
                     body: JSON.parse(readChunks_(dsh, r, 5)) });
    } catch (e) { bad.push('초안 ' + h[0] + ': 본문을 읽지 못함'); }
  }

  /* 이력 — 행 번호를 그대로 id 로 씁니다 */
  P.hist = [];
  var hsh = histSheet_(), hl = hsh.getLastRow();
  if (hl >= 2) {
    var all = hsh.getRange(2, 1, hl - 1, hsh.getMaxColumns()).getValues();
    for (var i = 0; i < all.length; i++) {
      var sid = String(all[i][0] || ''); if (!sid) continue;
      var m = histMeta_(all, i), raw = all[i].slice(m.start - 1).join(''), body = null;
      try { body = JSON.parse(raw); } catch (e) { bad.push('이력 ' + (i + 2) + '행: 본문을 읽지 못함'); continue; }
      var kind = m.kind + (m.fixBy || m.fixAt ? '@' + m.fixBy + '@' + m.fixAt : '');
      P.hist.push({ row: i + 2, subId: sid, eff: m.eff, saved: m.saved, by: m.by, kind: kind, body: body });
    }
  }

  /* 등급 차감표 */
  var g = { rev: 0, by: '', at: '', cfg: null };
  try { g = readGrades_(); } catch (e) { bad.push('등급 차감표: ' + (e && e.message || e)); }
  P.grades = g.rev || g.cfg ? [{ rev: g.rev, by: g.by, at: g.at, cfg: g.cfg }] : [];
  P.gradesHist = [];
  var gh = gradeHistSheet_(), gl = gh.getLastRow();
  if (gl >= 2) {
    var gv = gh.getRange(2, 1, gl - 1, gh.getMaxColumns()).getValues();
    for (var j = 0; j < gv.length; j++) {
      var gc = null; try { gc = JSON.parse(gv[j].slice(3).join('')); } catch (e) {}
      P.gradesHist.push({ row: j + 2, at: tsCell_(gv[j][0]), by: String(gv[j][1] || ''), what: String(gv[j][2] || ''), cfg: gc });
    }
  }

  /* 협력점 정책지 */
  P.psheet = [];
  var ps = psSheet_(), pl = ps.getLastRow();
  if (pl >= 2) {
    var pv = ps.getRange(2, 1, pl - 1, ps.getMaxColumns()).getValues();
    for (var k = 0; k < pv.length; k++) {
      if (!String(pv[k][0] || '')) continue;
      var tpl = null; try { tpl = JSON.parse(pv[k].slice(4).join('')); } catch (e) { bad.push('정책지 틀 ' + pv[k][0] + ': 읽지 못함'); continue; }
      P.psheet.push({ gid: String(pv[k][0]), rev: Number(pv[k][1]) || 0, by: String(pv[k][2] || ''), at: tsCell_(pv[k][3]), tpl: tpl });
    }
  }
  P.psheetHist = [];
  var phs = psHistSheet_(), phl = phs.getLastRow();
  if (phl >= 2) {
    var phv = phs.getRange(2, 1, phl - 1, phs.getMaxColumns()).getValues();
    for (var q = 0; q < phv.length; q++) {
      if (!String(phv[q][0] || '')) continue;
      var snap = null; try { snap = JSON.parse(phv[q].slice(4).join('')); } catch (e) { bad.push('정책지 발행 ' + (q + 2) + '행: 읽지 못함'); continue; }
      P.psheetHist.push({ row: q + 2, gid: String(phv[q][0]), at: tsCell_(phv[q][1]), by: String(phv[q][2] || ''), eff: tsCell_(phv[q][3]), snap: snap });
    }
  }

  /* 메모 */
  P.memo = [];
  var ms = memoSheet_(), ml = ms.getLastRow();
  if (ml >= 2) {
    ms.getRange(2, 1, ml - 1, 10).getValues().forEach(function (v) {
      if (!String(v[0] || '')) return;
      P.memo.push({ id: String(v[0]), email: String(v[1] || '').toLowerCase(), by: String(v[2] || ''), shared: String(v[3]) === 'Y',
        cat: String(v[4] || ''), t: String(v[5] || ''), b: String(v[6] || ''), at: tsCell_(v[7]), done: String(v[8]) === 'Y',
        cids: String(v[9] || '').split(',').filter(function (x) { return x; }) });
    });
  }

  out.problems = bad;
  var name = 'policy_export_' + Utilities.formatDate(new Date(), tz_(), 'yyyyMMdd_HHmm') + '.json';
  var file = DriveApp.createFile(Utilities.newBlob(JSON.stringify(out), 'application/json', name));
  var msg = '내보내기 완료 → Drive 파일: ' + name + '\n' + file.getUrl() + '\n' +
    '명단 ' + P.members.length + ' · 정책 ' + P.policy.length + ' · 이력 ' + P.hist.length + ' · 초안 ' + P.draft.length +
    ' · 등급이력 ' + P.gradesHist.length + ' · 정책지 ' + P.psheet.length + ' · 발행 ' + P.psheetHist.length + ' · 메모 ' + P.memo.length +
    (bad.length ? '\n\n⚠ 읽지 못한 것 ' + bad.length + '건:\n' + bad.join('\n') : '');
  Logger.log(msg);
  return msg;
}
