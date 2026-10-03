'use strict';
// 메트라이프생명 변액 펀드 기준가 수집 (공시실 > 변액보험공시 > 기준가 현황). 로그인 불필요.
// 대상: 변액연금 동행/동행 Plus(현재+과거 버전)와 실버플랜 변액유니버셜에서 선택 가능했던 모든 펀드.
// 한 번의 조회가 최대 400행이라 구간을 이어서 받고, 받은 값은 캐시(metlife-cache.json)에 쌓아 두어 이후엔 최근분만 받는다.
const fs = require('fs');
const B = 'https://brand.metlife.co.kr/pn/paReal/';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
// 상품 버전(공시 번호)마다 선택 가능한 펀드가 다르다: 목록 화면에서 버전·판매기간을 읽고, 버전별 펀드 목록으로 '가입 시점별 선택 가능 펀드(ERAS)'를 만든다.

// 이름으로 유형 분류
const group = n => /TDF/.test(n) ? 'TDF' : /MMF|채권|하이일드/.test(n) ? '채권형' : /포트폴리오|멀티인컴|자산배분/.test(n) ? '혼합형' : /골드/.test(n) ? '기타' : '주식형';

const stripTags = h => h.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const fundsOf = h => { const o = []; for (const m of h.matchAll(/<input[^>]*name="insuType"[^>]*>/g)) { const id = (m[0].match(/id="([^"]+)"/) || [])[1], v = (m[0].match(/value="([^"]+)"/) || [])[1]; const l = (h.match(new RegExp('for="' + id + '"[^>]*>([^<]*)<')) || [])[1]; if (v && l) o.push([v, l.trim()]); } return o; };
const names = h => [...h.matchAll(/name="hdFndNm" value="([^"]*)"/g)].map(m => m[1]);
const ymd = d => d.replace(/-/g, '');
const isWeekday = s => { const w = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8))).getUTCDay(); return w > 0 && w < 6; };
const addDays = (s, n) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8) + n)).toISOString().slice(0, 10).replace(/-/g, '');

module.exports = async function metlife({ cacheFile, log, retry, sleep, today }) {
  let cache = {}; try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) {}
  const get = async (url, hdr) => retry(async () => { const r = await fetch(url, { headers: { ...UA, ...hdr } }); if (!r.ok) throw new Error(url.slice(0, 80) + ' ' + r.status); return r; });

  // 1) 상품 버전 목록(판매 중 + 판매 중지, 동행·동행 Plus·실버플랜만)
  const prodOf = n => /변액연금보험 동행 Plus/.test(n) ? '동행Plus' : /변액연금보험 동행$/.test(n.trim()) ? '동행' : /실버플랜/.test(n) ? '실버플랜' : null;
  const versions = [];
  for (const scd of ['Y', 'N']) {
    for (let pg = 1; pg <= 30; pg++) {
      const h = await (await get(B + `retrieveVrinsPaBprcPcndList.do?scd=${scd}&submitType=paging&pageIndex=${pg}`)).text();
      const rows = [...h.matchAll(/<td[^>]*>\s*([^<]{3,70}?)\s*<\/td>\s*<td[^>]*>\s*(\d{4}-\d\d-\d\d) ~ (\d{4}-\d\d-\d\d)?\s*<\/td>[\s\S]*?standardPriceDetailView\('(\d+)'\)/g)];
      if (!rows.length) break;
      for (const r of rows) { const p = prodOf(r[1]); if (p) versions.push({ id: r[4], prod: p, from: ymd(r[2]), to: r[3] ? ymd(r[3]) : '' }); }
      await sleep(100);
    }
  }
  if (!versions.some(v => v.prod === '동행' && !v.to) || !versions.some(v => v.prod === '동행Plus' && !v.to)) throw new Error('메트라이프 현재 동행/동행 Plus 판매 버전을 찾지 못함');
  const cur = { dong: versions.find(v => v.prod === '동행' && !v.to).id, plus: versions.find(v => v.prod === '동행Plus' && !v.to).id };

  // 2) 버전별 선택 가능 펀드(과거 버전은 바뀌지 않으므로 캐시, 판매 중인 버전만 매번 다시 받음)
  cache._lists = cache._lists || {};
  let sess = null, allNames = [];
  const FN = {};   // code -> name
  for (const v of versions) {
    const r = await get(B + `retrieveVrinsPaBprcPcndSearch.do?insProdSeq=${v.id}&submitType=page`);
    if (!sess) sess = { cookie: r.headers.getSetCookie().map(c => c.split(';')[0]).join('; '), id: v.id };
    const h = await r.text(); if (!allNames.length) allNames = names(h);
    if (v.to && cache._lists[v.id]) { v.f = cache._lists[v.id]; }
    else { const f = fundsOf(h); if (!f.length) throw new Error('메트라이프 펀드 목록 비어 있음 ' + v.id); v.f = f; if (v.to) cache._lists[v.id] = f; }
    v.f.forEach(([c, n]) => { FN[c] = n; }); await sleep(120);
  }
  // 같은 상품에서 펀드 구성이 같은 연속 버전은 하나로 합침
  const ERAS = [];
  for (const p of ['동행', '동행Plus', '실버플랜']) {
    const vs = versions.filter(v => v.prod === p).sort((a, b) => a.from.localeCompare(b.from));
    for (const v of vs) { const cs = v.f.map(x => x[0]).sort(), k = cs.join(','), last = ERAS.filter(e => e[0] === p).pop(); if (last && last[3].join(',') === k) last[2] = v.to; else ERAS.push([p, v.from, v.to, cs]); }
  }
  const flagOf = c => { const f = new Set(); for (const [p, , to, cs] of ERAS) if (cs.includes(c)) { if (p === '실버플랜') f.add('실버플랜'); else f.add(to ? '과거동행' : p === '동행' ? '현재동행' : '현재동행Plus'); } return [...f]; };
  const codes = Object.keys(FN).sort();
  log(`메트라이프 펀드 ${codes.length}개, 가입 시점 구간 ${ERAS.length}개`);

  // 3) 기준가 수집(캐시 이어받기)
  let hdr = { Cookie: sess.cookie, Referer: B + 'retrieveVrinsPaBprcPcndSearch.do' }, renewing = null, gen = 0;
  const renew = async g => { if (g !== gen) return; if (!renewing) renewing = (async () => { const r = await fetch(B + `retrieveVrinsPaBprcPcndSearch.do?insProdSeq=${sess.id}&submitType=page`, { headers: UA }); hdr = { ...hdr, Cookie: r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') }; await r.text(); gen++; renewing = null; })(); await renewing; };
  const fetchRange = async (code, st, ed) => {
    const q = new URLSearchParams(); q.append('insuType', code); allNames.forEach(n => q.append('hdFndNm', n));
    q.set('stDate', st); q.set('edDate', ed); q.set('hdAFndList', code); q.set('hdAFndNmList', FN[code]); q.set('insProdSeq', sess.id); q.set('submitType', 'page');
    let h = '';
    for (let k = 0; k < 4; k++) {   // 세션이 만료되면(오류 화면) 새 세션으로 재시도
      const g = gen; h = await (await get(B + 'retrieveVrinsPaBprcPcndDtl.do?' + q, hdr)).text();
      if (/<th scope="row"/.test(h) || /<tbody>\s*<\/tbody>/.test(h)) break;
      await renew(g); await sleep(500);
    }
    if (/에러가 발생/.test(h)) throw new Error('메트라이프 조회 오류 ' + code);
    return [...h.matchAll(/<th scope="row"[^>]*>(\d{4}-\d\d-\d\d)<\/th>\s*<td>([\d,\.]+)<\/td>/g)].map(m => [ymd(m[1]), +m[2].replace(/,/g, '')]);
  };
  let next = 0, fails = [];
  const worker = async () => {
    while (next < codes.length) {
      const c = codes[next++]; const e = cache[c] || (cache[c] = { n: FN[c], d: [], v: [] }); e.fl = flagOf(c);
      for (let attempt = 0; attempt < 3; attempt++) try {
        let st = e.d.length ? addDays(e.d[e.d.length - 1], -7) : '20000101';   // 최근 7일은 다시 받아 덮어씀
        let full = false;
        for (let guard = 0; guard < 80; guard++) {
          const rows = await fetchRange(c, st, today);
          if (!rows.length) { if (full) throw new Error('중간 응답이 비어 있음 ' + st); break; }
          full = rows.length >= 400;
          const m = new Map(e.d.map((d, i) => [d, e.v[i]])); rows.forEach(([d, v]) => { if (isWeekday(d)) m.set(d, v); });
          e.d = [...m.keys()].sort(); e.v = e.d.map(d => m.get(d));
          if (rows.length < 400) break;
          st = addDays(rows[rows.length - 1][0], 1);
        }
        if (e.d.length < 5) throw new Error('데이터 없음');
        if (e.d[e.d.length - 1] < addDays(today, -10) && !/미국주식형 2호/.test(FN[c])) throw new Error('최근 데이터가 없음 ' + e.d[e.d.length - 1]);
        fails = fails.filter(x => x !== c); break;
      } catch (err) { if (!fails.includes(c)) fails.push(c); log('WARN 메트라이프 ' + c + ' ' + err.message + ' (시도 ' + (attempt + 1) + ')'); await renew(gen); await sleep(1000); }
      await sleep(100);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  const bad = fails.filter(c => !(cache[c] && cache[c].d.length > 5));
  if (bad.length) throw new Error('메트라이프 기준가 수집 실패: ' + bad.join(','));
  // 4) 운용현황: 펀드별 자산구성(국내 주식·채권, 수익증권, 해외유가증권, 유동성)과 순자산. 월말 기준으로 공시됨.
  //    현재 판매 버전은 매번, 과거 버전은 아직 값이 없는 펀드가 있을 때만 받는다. 실패해도 기준가 갱신은 계속.
  cache._comp = cache._comp || {};
  try {
    const norm = s => s.replace(/\s+/g, ''), byName = {}; for (const c of codes) byName[norm(FN[c])] = c;
    const cell = s => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), num = s => +s.replace(/,/g, '');
    const order = [...versions.filter(v => !v.to), ...versions.filter(v => v.to).sort((a, b) => b.from.localeCompare(a.from))];
    for (const v of order) {
      if (v.to && v.f.every(([c]) => cache._comp[c])) continue;
      const h = await (await get(B + 'retrieveVrinsPaOprlPcndDtl.do?insProdSeq=' + v.id + '&submitType=page')).text();
      const rows = (h.match(/<tr[\s\S]*?<\/tr>/g) || []).map(r => [...r.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(x => cell(x[1])));
      const head = rows.find(r => /자산구성내역/.test(r[0] || '')); if (!head) continue;
      const names = head.slice(1), asof = (head[0].match(/\d{4}-\d+월말/) || [''])[0];
      const row = l => rows.find(r => r[0] === l), pick = l => { const r = row(l); return names.map((_, i) => r ? num(r[2 + i * 2] || '0') : 0); };
      const st = pick('주식'), bd = pick('채권'), fs2 = pick('수익증권'), ov = pick('해외유가증권'), cash = pick('유동성'), tot = row('계');
      names.forEach((n, i) => { const c = byName[norm(n)]; if (c && tot) cache._comp[c] = { st: st[i], bd: bd[i], fd: fs2[i], ov: ov[i], cash: cash[i], aum: Math.round(num(tot[1 + i * 2] || '0') / 100), asof }; });
      await sleep(200);
    }
  } catch (e) { log('WARN 메트라이프 운용현황 ' + e.message); }
  cache._eras = ERAS;
  const tmp = cacheFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cache)); fs.renameSync(tmp, cacheFile);

  const out = codes.map(c => ({ code: c, name: FN[c], group: group(FN[c]), flags: flagOf(c), d: cache[c].d, v: cache[c].v }));
  return { funds: out, cur, eras: ERAS, comp: cache._comp };
};
module.exports.group = group;
