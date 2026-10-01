'use strict';
// 메트라이프생명 변액 펀드 기준가 수집 (공시실 > 변액보험공시 > 기준가 현황). 로그인 불필요.
// 대상: 변액연금 동행/동행 Plus(현재+과거 버전)와 실버플랜 변액유니버셜에서 선택 가능했던 모든 펀드.
// 한 번의 조회가 최대 400행이라 구간을 이어서 받고, 받은 값은 캐시(metlife-cache.json)에 쌓아 두어 이후엔 최근분만 받는다.
const fs = require('fs');
const B = 'https://brand.metlife.co.kr/pn/paReal/';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
// 과거 상품 버전의 공시 번호(펀드 구성이 시기마다 달라서 모두 합침). 현재 판매 버전은 목록에서 이름으로 찾는다.
const OLD_DONGHAENG = ['8185', '5638'];
const SILVER = ['5632', '5631', '5630', '5629', '5628', '5627', '5626'];

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

  // 1) 현재 판매 중인 동행 / 동행 Plus 의 공시 번호
  const list = await (await get(B + 'retrieveVrinsPaBprcPcndList.do?scd=Y&submitType=tab&pageIndex=1')).text();
  const cur = {};
  for (const m of list.matchAll(/<td[^>]*>\s*([^<]{3,70}?)\s*<\/td>\s*<td[^>]*>\s*[\d-]+ ~ [\d-]*\s*<\/td>[\s\S]*?standardPriceDetailView\('(\d+)'\)/g)) {
    if (/변액연금보험 동행 Plus/.test(m[1])) cur.plus = m[2]; else if (/변액연금보험 동행$/.test(m[1].trim())) cur.dong = m[2];
  }
  if (!cur.dong || !cur.plus) throw new Error('메트라이프 현재 동행/동행 Plus 공시 번호를 찾지 못함');

  // 2) 상품별 선택 가능 펀드
  const lists = {};
  let sess = null, allNames = [];
  for (const [key, id] of [['현재동행', cur.dong], ['현재동행Plus', cur.plus], ...OLD_DONGHAENG.map(i => ['과거동행', i]), ...SILVER.map(i => ['실버플랜', i])]) {
    const r = await get(B + `retrieveVrinsPaBprcPcndSearch.do?insProdSeq=${id}&submitType=page`);
    if (!sess) sess = { cookie: r.headers.getSetCookie().map(c => c.split(';')[0]).join('; '), id };
    const h = await r.text(); if (!allNames.length) allNames = names(h);
    const f = fundsOf(h); if (!f.length) throw new Error('메트라이프 펀드 목록 비어 있음 ' + id);
    (lists[key] = lists[key] || []).push(...f); await sleep(150);
  }
  const FN = {};   // code -> {name, flags:Set}
  for (const [key, arr] of Object.entries(lists)) for (const [c, n] of arr) { (FN[c] = FN[c] || { name: n, flags: new Set() }).flags.add(key); FN[c].name = n; }
  const codes = Object.keys(FN).sort();
  log(`메트라이프 펀드 ${codes.length}개`);

  // 3) 기준가 수집(캐시 이어받기)
  let hdr = { Cookie: sess.cookie, Referer: B + 'retrieveVrinsPaBprcPcndSearch.do' }, renewing = null, gen = 0;
  const renew = async g => { if (g !== gen) return; if (!renewing) renewing = (async () => { const r = await fetch(B + `retrieveVrinsPaBprcPcndSearch.do?insProdSeq=${sess.id}&submitType=page`, { headers: UA }); hdr = { ...hdr, Cookie: r.headers.getSetCookie().map(c => c.split(';')[0]).join('; ') }; await r.text(); gen++; renewing = null; })(); await renewing; };
  const fetchRange = async (code, st, ed) => {
    const q = new URLSearchParams(); q.append('insuType', code); allNames.forEach(n => q.append('hdFndNm', n));
    q.set('stDate', st); q.set('edDate', ed); q.set('hdAFndList', code); q.set('hdAFndNmList', FN[code].name); q.set('insProdSeq', sess.id); q.set('submitType', 'page');
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
      const c = codes[next++]; const e = cache[c] || (cache[c] = { n: FN[c].name, d: [], v: [] }); e.fl = [...FN[c].flags];
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
        if (e.d[e.d.length - 1] < addDays(today, -10) && !/미국주식형 2호/.test(FN[c].name)) throw new Error('최근 데이터가 없음 ' + e.d[e.d.length - 1]);
        fails = fails.filter(x => x !== c); break;
      } catch (err) { if (!fails.includes(c)) fails.push(c); log('WARN 메트라이프 ' + c + ' ' + err.message + ' (시도 ' + (attempt + 1) + ')'); await renew(gen); await sleep(1000); }
      await sleep(100);
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  const bad = fails.filter(c => !(cache[c] && cache[c].d.length > 5));
  if (bad.length) throw new Error('메트라이프 기준가 수집 실패: ' + bad.join(','));
  const tmp = cacheFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(cache)); fs.renameSync(tmp, cacheFile);

  const out = codes.map(c => ({ code: c, name: FN[c].name, group: group(FN[c].name), flags: [...FN[c].flags], d: cache[c].d, v: cache[c].v }));
  return { funds: out, cur };
};
module.exports.group = group;
