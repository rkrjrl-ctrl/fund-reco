'use strict';
// 펀드추천 대시보드 자동 갱신: 한국투자증권 펀드 조회(TDF 전 빈티지 + 라인업 펀드) + FunETF(2개 펀드) → HTML 생성 → 구글드라이브 동기화 폴더에 저장
// 실행: node update.js   (Windows 작업 스케줄러가 매일 실행, 꺼져 있었으면 켜질 때 실행)
const fs = require('fs'), path = require('path');
const ROOT = __dirname;
const OUT_NAME = process.env.OUT_NAME || '펀드추천_대시보드.html';
const OUT_DIRS = process.env.OUT_DIR ? [process.env.OUT_DIR] : ['C:/Users/rkrjr/Google 드라이브/휴휴 펀드/펀드추천', path.join(ROOT, 'out')];
const LOG = path.join(ROOT, 'logs', 'update.log');
const KIS = 'https://securities.koreainvestment.com';
const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' };
const FORM = { ...UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Referer: KIS + '/main/opensearch/opensearch_tobe.jsp' };

// 라인업은 lineup.json 에서 읽는다(펀드 추가/삭제는 그 파일만 수정)
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'lineup.json'), 'utf8'));
const ITEMS = CFG.라인업.flatMap(f => f.종목);
const EXTRA = ITEMS.filter(i => i.한투검색어).map(i => [i.코드, i.한투검색어]);   // 한투 검색으로 찾는 비TDF 펀드
const FUNETF = ITEMS.filter(i => i.FunETF코드).map(i => ({ key: i.코드, fundCd: i.FunETF코드, term: String(i.기간), base: i.기준, co: i.운용사, fee: i.총보수, risk: i.위험등급, setup: i.설정일, aum: i.설정액억, name: i.정식명 }));
const HCACHE = path.join(ROOT, 'holdings.json');   // 보유종목 마지막 성공값(조회 실패 시 대체)
const HISTF = path.join(ROOT, 'history.json');   // 클래스 출시 이전 구간(FunETF 종류A 기준가) 캐시: 과거는 바뀌지 않으므로 한 번만 받음
const loadMlCache = () => { const c = readJson(path.join(ROOT, 'metlife-cache.json'), null); if (!c) return null; return { eras: c._eras || [], comp: c._comp || {}, funds: Object.entries(c).filter(([k]) => k[0] !== '_').map(([code, e]) => ({ code, name: e.n, group: require('./metlife.js').group(e.n), flags: e.fl || [], d: e.d, v: e.v })) }; };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return d; } };

const log = m => { const s = `[${new Date().toISOString()}] ${m}`; console.log(s); try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function retry(fn, n = 4) { let e; for (let i = 0; i < n; i++) { try { return await fn(); } catch (x) { e = x; await sleep(1500 * (i + 1)); } } throw e; }
const post = async (url, params) => retry(async () => { const r = await fetch(url, { method: 'POST', headers: FORM, body: new URLSearchParams(params) }); if (!r.ok) throw new Error(url + ' ' + r.status); return r.text(); });

async function search(k) {
  const t = await post(KIS + '/main/opensearch/result/json_items_web_renewal.jsp', { mode: 'detail', collection: 'witems', idxCount: '0', listCount: '300', commonSaleYn: 'Y', scSaleChannel: '01', menuValue: 'smart', menuType: 'profitRate', query: k });
  return JSON.parse(t).dataList || [];
}
// 한국투자증권 차트는 term(개월) 전부터 최대 1275행만 준다 → 60개월 간격으로 구간을 이어 붙여 설정일까지 수집
async function chartWin(p, term) {
  const t = await post(KIS + '/main/mall/openfund/FundInfo_Pop.jsp?cmd=A_FP_20270_CHART', { cmd: 'A_FP_20270_CHART', pdno: p, term: String(term), EXCEL_YN: '', gijun_radio: 'CRCT_BSPR24' });
  const j = JSON.parse(t); if (!j.BASS_DT || j.BASS_DT.length < 5) throw new Error('no chart ' + p + ' term ' + term);
  return j;
}
const ymd = dt => dt.toISOString().slice(0, 10).replace(/-/g, '');
async function chart(p) {
  const m = new Map(), now = new Date();
  let prevFirst = null;
  for (let term = 60; term <= 600; term += 60) {
    const j = await chartWin(p, term), d = j.BASS_DT;
    if (prevFirst && d[d.length - 1] < prevFirst) throw new Error('차트 구간이 이어지지 않음 ' + p + ' term ' + term);
    if (prevFirst && d[0] >= prevFirst) break;                       // 더 이전 데이터 없음
    d.forEach((x, i) => { const v = parseFloat(j.CRCT_BSPR24[i] || j.BSPR24[i]); if (!isNaN(v) && !m.has(x)) m.set(x, v); });
    prevFirst = d[0];
    const start = ymd(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - term, now.getUTCDate())));
    if (d[0] > String(+start + 100)) break;                          // 윈도 시작보다 한참 뒤에 시작 = 설정일에 도달
  }
  const d = [...m.keys()].sort();
  return { d, c: d.map(x => m.get(x)), b: [] };
}
// 경제 지표(같은 계정의 claude_drive 저장소가 매일 수집): 리포트의 시장 배경 설명에 사용. 실패해도 갱신은 계속
async function indicators(keys) {
  const base = 'https://raw.githubusercontent.com/rkrjrl-ctrl/claude_drive/main/data/';
  const txt = async f => retry(async () => { const r = await fetch(base + f, { headers: UA }); if (!r.ok) throw new Error(f + ' ' + r.status); return r.text(); }, 3);
  const ok = v => v != null && v !== '' && !isNaN(+v);
  const out = {};
  for (const k of keys) { out[k] = new Map(); for (const l of (await txt('long_term/' + k + '.csv')).split('\n').slice(1)) { const [d, v] = l.trim().split(','); if (d && ok(v)) out[k].set(d.replace(/-/g, ''), +v); } }
  // 저장소의 일별 수집분(history.csv)은 '수집한 날짜'로 찍혀 있어 수집 시각에 따라 전날 값이 들어간다.
  // 그래서 최근 구간은 실제 거래일 기준인 야후 일별 종가로 덮어쓰고, 야후에 없는 지표(한국 금리 등)나 야후 조회 실패 때만 history.csv를 쓴다.
  const YT = { kospi: '^KS11', sp500: '^GSPC', nasdaq: '^IXIC', usdkrw: 'KRW=X', us_10y: '^TNX', gold: 'GC=F', stoxx50: '^STOXX50E', nikkei: '^N225', shanghai: '000001.SS', hsi: '^HSI', nifty: '^NSEI', vix: '^VIX' };
  const yahoo = async t => { const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(t) + '?range=2y&interval=1d', { headers: UA }); if (!r.ok) throw new Error('yahoo ' + t + ' ' + r.status); const res = (await r.json()).chart.result[0], ts = res.timestamp, cl = res.indicators.quote[0].close, off = res.meta.gmtoffset || 0, m = new Map(); ts.forEach((x, i) => { if (cl[i] != null) m.set(new Date((x + off) * 1000).toISOString().slice(0, 10).replace(/-/g, ''), cl[i]); }); if (m.size < 200) throw new Error('yahoo ' + t + ' 자료 부족'); return m; };
  const done = new Set();
  for (const k of keys) if (YT[k]) { try { const m = await retry(() => yahoo(YT[k]), 2), d0 = [...m.keys()].sort()[0]; for (const d of [...out[k].keys()]) if (d >= d0) out[k].delete(d); for (const [d, v] of m) out[k].set(d, v); done.add(k); await sleep(200); } catch (e) { log('WARN 지표 ' + k + ' 실제 거래일 자료 조회 실패(' + e.message + '), 저장소 수집분 사용'); } }
  const h = (await txt('history.csv')).split('\n').map(l => l.trim().split(',')), head = h[0];
  for (const row of h.slice(1)) for (const k of keys) { if (done.has(k)) continue; const i = head.indexOf(k); if (i > 0 && row[0] && ok(row[i])) out[k].set(row[0].replace(/-/g, ''), +row[i]); }
  log('지표: 실제 거래일 기준 ' + done.size + '개, 저장소 수집분 ' + (keys.length - done.size) + '개');
  return out;
}
// TDF 구성·위험 지표(주식·채권 비중, 주요 보유, 환헤지 포지션, 1년 변동성·샤프)
async function tdfInfo(p) {
  const html = await post(KIS + '/main/mall/openfund/FundInfo_Pop.jsp?cmd=A_FP_20280_1', { cmd: 'A_FP_20280_1', pdno: p, pfundCd: p, fundCd: p });
  const t = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/테이블 입니다\./g, ' ').replace(/\s+/g, ' ');
  const sec = (a, b) => { const i = t.indexOf(a); if (i < 0) return ''; const s = t.slice(i + a.length), j = s.indexOf(b); return j < 0 ? '' : s.slice(0, j); };
  const sum = s => { let x = 0; for (const m of s.matchAll(/(\d+(?:\.\d+)?)%/g)) x += +m[1]; return Math.round(x * 10) / 10; };
  const pairs = (s, n) => [...s.matchAll(/\s*(.+?)\s+(\d+(?:\.\d+)?)%/g)].slice(0, n).map(m => m[1].trim() + ' ' + (+m[2]).toFixed(1));
  const eqS = sec('주식 포트폴리오 주식 포트폴리오 구분 비율', '주식 종목별 비율 Top 10'), bdS = sec('채권 포트폴리오 채권 포트폴리오 구분 비율', '채권 종목별 비율 Top 10');
  if (!eqS && !bdS) throw new Error('구성 정보 없음');
  const num = re => { const m = t.match(re); return m ? m[1].trim().split(' ').map(Number) : []; };
  const sd = num(/표준편차 ([\d\.\- ]+?) % 순위/), sh = num(/샤프지수 ([\d\.\- ]+?) % 순위/);
  // 보유 상위 종목 이름으로 자산군을 나눠 추정 노출(%)을 만든다: kr 국내주식, us 미국주식, ox 기타 해외주식, krb 국내채권, glb 해외채권, gold 금, cash 현금성
  const list = s => [...s.matchAll(/\s*(.+?)\s+(\d+(?:\.\d+)?)%/g)].map(m => [m[1].trim(), +m[2]]);
  const han = n => /[가-힣]/.test(n);
  // 종목 이름 → 자산·지역 비중: tdf-lookthrough.json의 규칙을 위에서부터 적용(재간접 펀드·지수 ETF는 지역별로 나눠 담음). 못 찾으면 한글 이름은 한국 주식, 그 외는 gl(미분류)
  const LT = readJson(path.join(ROOT, 'tdf-lookthrough.json'), { rules: [], presets: {} });
  const x = { kr: 0, us: 0, eu: 0, jp: 0, cn: 0, in: 0, oth: 0, gl: 0, krb: 0, glb: 0, gold: 0, cash: 0 }, add = (k, w) => { x[k] += w; };
  const place = (n, w, asset) => { for (const [re, mix, only] of LT.rules) { if (only === 'A' && !asset) continue; if (!new RegExp(re, 'i').test(n)) continue; if (mix === 'BOND') return add(han(n) && !/미국|달러|글로벌|해외/.test(n) ? 'krb' : 'glb', w); const m = typeof mix === 'string' ? LT.presets[mix] : mix; const t = Object.values(m).reduce((p, q) => p + q, 0); for (const k in m) add(k, w * m[k] / t); return; } add(han(n) || /200/.test(n) ? 'kr' : 'gl', w); };
  const eqL = list(sec('주식 종목별 비율 Top 10 주식 종목별 비율 Top 10 구분 비율', '채권 포트폴리오')), bdL = list(sec('채권 종목별 비율 Top 10 채권 종목별 비율 Top 10 구분 비율', '스타일 맵')), asL = list(sec('자산 포트폴리오 자산 포트폴리오 구분 비율', '파생상품 포트폴리오'));
  const eqT = sum(eqS), bdT = sum(bdS);
  // 주식·채권: 상위 10개의 분류 비율을 전체 비중에 그대로 적용. 그 외(해외 펀드·금·현금)는 공시된 비율 그대로
  { const t = eqL.reduce((p, q) => p + q[1], 0); if (t > 0) for (const [n, w] of eqL) place(n, eqT * w / t, false); }
  { const c = { krb: 0, glb: 0, cash: 0 }; let t = 0; for (const [n, w] of bdL) { const k = /머니마켓|MMF|단기채권|전단채/.test(n) ? 'cash' : /미국|달러|USD|글로벌|해외/.test(n) || !han(n) ? 'glb' : 'krb'; c[k] += w; t += w; } if (t > 0) for (const k in c) add(k, bdT * c[k] / t); else add('krb', bdT); }
  for (const [n, w] of asL) place(n, w, true);
  { const t = Object.values(x).reduce((a, b) => a + b, 0); if (t > 102) x.cash = Math.max(0, x.cash - (t - 100)); }   // 환헤지용 미수금 등으로 합이 100을 넘는 경우 현금성에서 뺀다
  for (const k in x) x[k] = Math.round(x[k] * 10) / 10;
  return { x, eq: sum(eqS), bd: sum(bdS), top: pairs(sec('주식 종목별 비율 Top 10 주식 종목별 비율 Top 10 구분 비율', '채권 포트폴리오'), 6), fx: /KRW\/USD/.test(sec('파생상품 포트폴리오 파생상품 포트폴리오 구분 비율', '펀드 위험 분석')) ? 1 : 0, sd: sd[2] || null, sh: sd[2] ? sh[2] : null, asof: (t.match(/자산운용내역 \(기준일 : ([\d\.]+)\)/) || [])[1] || '' };
}
async function holdings(p) {
  const html = await post(KIS + '/main/mall/openfund/FundInfo_Pop.jsp?cmd=A_FP_20280_1', { cmd: 'A_FP_20280_1', pdno: p, pfundCd: p, fundCd: p });
  const t = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/테이블 입니다\./g, ' ').replace(/\s+/g, ' ');
  const pairs = s => { const out = []; const re = /\s*(.+?)\s+(\d+(?:\.\d+)?)%/g; let m; while ((m = re.exec(s)) && out.length < 10) out.push(m[1].trim() + ' ' + (+m[2]).toFixed(2)); return out; };
  const cut = (a, b) => { const i = t.lastIndexOf(a); if (i < 0) return ''; let s = t.slice(i + a.length); const j = s.indexOf(b); if (j >= 0) s = s.slice(0, j); return s.replace('구분 비율', ' ').trim(); };
  let s = cut('주식 종목별 비율 Top 10', '채권 포트폴리오');
  if (!s || /데이터가 없습니다/.test(s)) s = cut('자산 포트폴리오 자산 포트폴리오', '파생상품 포트폴리오');
  if (!s || /데이터가 없습니다/.test(s)) return [];
  return pairs(s);
}
const r2 = x => (x === '' || x == null || isNaN(x)) ? null : Math.round(x * 100) / 100;
const famOf = d => { const nm = d.PRDT_NAME; const b = nm.replace(/적격/g, '').replace(/20[2-7][05]/, '').split(/증권|혼합자산|투자신탁/)[0]; const h = /UH[_ ]|\(UH\)/.test(nm) ? 'UH' : (/[^U]H_|\(H\)|\)H$/.test(nm) ? 'H' : ''); return (b + (h ? ' ' + h : '')).replace(/^미래(?!에셋)/, '미래에셋'); };
const co = d => d.MGCO_EXONO_NAME.replace('자산운용', '').replace('한국투신운용', '한국투자').replace('한국투신', '한국투자').replace('케이씨지아이', 'KCGI');
const rowBase = d => [d.PDNO, d.PRDT_NAME, co(d), r2(d.TOT_PAY_RT), r2(d.RLZT_ERNG_RT_1M), r2(d.RLZT_ERNG_RT_3M), r2(d.RLZT_ERNG_RT_6M), r2(d.RLZT_ERNG_RT_1Y), r2(d.RLZT_ERNG_RT_3Y), d.PRDT_RISK_GRAD_CD_NAME, d.FRST_STUP_DT, Math.round(d.GRP_STUP_AMT)];
// n개월 전 같은 날짜(휴일이면 다음 영업일)
const cutoff = (end, p) => { const dt = new Date(Date.UTC(+end.slice(0, 4), +end.slice(4, 6) - 1 - p, +end.slice(6, 8))); return dt.toISOString().slice(0, 10).replace(/-/g, ''); };
function periodRet(axis, vals, end, p) { const c = cutoff(end, p); let s = axis.findIndex(d => d >= c); if (s < 0) return null; if (vals[s] == null) return null; const e = axis.indexOf(end); if (e < 0 || vals[e] == null) return null; return (vals[e] / vals[s] - 1) * 100; }

async function histNav(code, fundCd) {
  const h = readJson(HISTF, {});
  if (h[fundCd] && h[fundCd].length > 100) return h[fundCd];
  const nav = await funetfNav({ fundCd, term: 'A' }); await sleep(3000);
  h[fundCd] = nav; fs.writeFileSync(HISTF, JSON.stringify(h)); log('과거이력 저장 ' + code + ' ' + fundCd + ' ' + nav[0][0] + '~');
  return nav;
}
async function funetfNav(f) {
  const page = `https://www.funetf.co.kr/product/fund/view/${f.fundCd}`;
  const r = await retry(async () => { const x = await fetch(page, { headers: UA }); if (!x.ok) throw new Error('funetf page ' + x.status); return x; });
  const html = await r.text();
  const csrf = (html.match(/name="_csrf"[^>]*content="([^"]+)"/) || html.match(/content="([^"]+)"[^>]*name="_csrf"/) || [])[1];
  if (!csrf) throw new Error('funetf csrf missing');
  const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
  const p = new URLSearchParams({ gijunYmd: new Date().toISOString().slice(0, 10).replace(/-/g, ''), fundCd: f.fundCd, repFundCd: f.fundCd, mketDvsn: '02', usdYn: 'N', _csrf: csrf, schNavMode: 'T', schNavTerm: 'A' });
  const t = await retry(async () => { const x = await fetch('https://www.funetf.co.kr/api/public/product/view/fundnav?' + p, { headers: { ...UA, Cookie: cookie, Referer: page } }); if (!x.ok) throw new Error('funetf nav ' + x.status); return x.text(); });
  const j = JSON.parse(t); if (!Array.isArray(j) || !j.length) throw new Error('funetf empty ' + f.fundCd);
  return j.map(x => [x.gijunYmd, x.ugijunGa]).sort((a, b) => a[0].localeCompare(b[0]));
}

async function main() {
  const t0 = Date.now();
  if (process.argv.includes('--if-stale')) { try { const l = JSON.parse(fs.readFileSync(path.join(ROOT, 'last-run.json'), 'utf8')); if (Date.now() - l.ts < 90 * 60e3) { log('90분 안에 갱신되어 건너뜀'); return; } } catch (e) {} }
  // 1) 목록
  const all = {};
  const queries = [];
  for (let y = 2020; y <= 2070; y += 5) for (const k of ['TDF' + y, 'TDF알아서' + y, 'TDF ' + y, '적격TDF' + y]) queries.push(k);
  queries.push('TDF', '적격TDF', 'TDF알아서', 'ETF포커스', '라이프사이클', '전략배분TDF', '한국형TDF');
  [...new Set(EXTRA.map(e => e[1]))].forEach(k => queries.push(k));
  for (const k of queries) { try { for (const d of await search(k)) all[d.PDNO] = d; } catch (e) { log('WARN search ' + k + ' ' + e.message); } }
  const tdfRows = Object.values(all).filter(d => /TDF/i.test(d.PRDT_NAME) && /20[2-7][05]/.test(d.PRDT_NAME) && d.TAX_RDEM_KIND_CD == '36');
  if (tdfRows.length < 80) throw new Error('TDF 목록이 너무 적음: ' + tdfRows.length);
  const extraD = EXTRA.map(([c]) => all[c]); if (extraD.some(x => !x)) throw new Error('라인업 펀드 누락: ' + EXTRA.filter(([c]) => !all[c]).map(e => e[0]));
  const END = tdfRows.map(d => d.ZEROIN_BASS_DT).filter(Boolean).sort().pop();
  log(`TDF ${tdfRows.length}개, 기준일 ${END}`);
  // 2) 가격 시계열
  const ids = [...tdfRows.map(d => d.PDNO), ...EXTRA.map(e => e[0])];
  const S = {}; let next = 0;
  const worker = async () => { while (next < ids.length) { const p = ids[next++]; try { S[p] = await retry(() => chart(p), 6); } catch (e) { log('WARN chart ' + p + ' ' + e.message); } } };
  await Promise.all(Array.from({ length: 6 }, worker));
  const lost = EXTRA.map(e => e[0]).filter(c => !S[c]); if (lost.length) throw new Error('라인업 펀드 시계열 실패: ' + lost.join(','));
  const okIds = ids.filter(p => S[p]); if (okIds.length < ids.length - 3) throw new Error('시계열 실패가 많음: ' + (ids.length - okIds.length));
  const NAVH = {};
  for (const i of ITEMS) if (i.과거FunETF코드 && okIds.includes(i.코드)) NAVH[i.코드] = await histNav(i.코드, i.과거FunETF코드);
  const NAVF = {};
  for (const f of FUNETF) { try { NAVF[f.key] = await funetfNav(f); } catch (e) { log('WARN funetf ' + f.key + ' ' + e.message); } }
  let ML = null;
  try { ML = await require('./metlife.js')({ cacheFile: path.join(ROOT, 'metlife-cache.json'), log, retry, sleep, today: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '') }); }
  catch (e) { log('WARN 메트라이프 ' + e.message); ML = loadMlCache(); if (!ML) throw e; log('WARN 메트라이프 캐시로 진행'); }
  // 메트라이프는 평일마다 값을 싣기 때문에 공휴일(예: 임시공휴일)이 섞인다. 공모펀드 거래일 범위 안에서는 공모펀드가 있는 날만 축에 둔다.
  const realD = new Set([...okIds.flatMap(p => S[p].d), ...Object.values(NAVF).flatMap(n => n.map(x => x[0])), ...Object.values(NAVH).flatMap(n => n.map(x => x[0]))]);
  const realMin = [...realD].sort()[0];
  const axis = [...new Set([...ML.funds.flatMap(f => f.d).filter(d => d < realMin || realD.has(d)), ...okIds.flatMap(p => S[p].d), ...Object.values(NAVF).flatMap(n => n.map(x => x[0])), ...Object.values(NAVH).flatMap(n => n.map(x => x[0]))])].filter(d => d <= END).sort();
  if (axis[axis.length - 1] !== END) throw new Error('기준일 데이터가 시계열에 없음 ' + END);
  const V = {}, F = {}, NOFF = {};
  const packV = (k, arr, fmt) => { const i0 = arr.findIndex(x => x != null); NOFF[k] = i0 < 0 ? 0 : i0; V[k] = arr.slice(NOFF[k]).map(x => x == null ? '' : fmt(x)).join(','); };
  for (const p of okIds) {
    const s = S[p], m = new Map(); s.d.forEach((d, i) => { const v = parseFloat(s.c[i] || s.b[i]); if (!isNaN(v)) m.set(d, v); });
    const first = s.d[0]; let last = null;
    const arr = axis.map(d => { if (d < first) return null; if (m.has(d)) last = m.get(d); return last; });
    if (NAVH[p]) {   // 클래스 출시 이전: 종류A 기준가를 첫 거래일 값에 맞춰 이어 붙임
      const hm = new Map(NAVH[p]); let i0 = arr.findIndex(x => x != null);
      while (i0 + 1 < arr.length && arr[i0 + 1] === arr[i0] && hm.has(axis[i0 + 1])) i0++;   // 출시 직후 기준가 1000이 한동안 그대로인 구간은 건너뛰고 변동 직전 날에 접합
      const hv = hm.get(axis[i0]);
      if (!hv) throw new Error('접합일 과거이력 없음 ' + p + ' ' + axis[i0]);
      const k = arr[i0] / hv; let hl = null; const hf = NAVH[p][0][0];
      for (let i = 0; i < i0; i++) { const d = axis[i]; if (d < hf) continue; if (hm.has(d)) hl = hm.get(d); if (hl != null) arr[i] = hl * k; }
    }
    F[p] = arr; packV(p, arr, x => String(Math.round(x * 10) / 10));
  }
  // 경제 지표를 같은 날짜 축에 맞춰 싣는다(I:usdkrw 등, 값이 없는 날은 직전 값)
  try {
    const IND = await indicators(['usdkrw', 'sp500', 'nasdaq', 'kospi', 'us_10y', 'kr_10y', 'gold', 'stoxx50', 'nikkei', 'shanghai', 'hsi', 'nifty', 'vix']);
    for (const k in IND) { const e = [...IND[k]].sort((a, b) => a[0].localeCompare(b[0])); let j = 0, last = null; if (e.length < 100) continue;
      packV('I:' + k, axis.map(d => { while (j < e.length && e[j][0] <= d) last = e[j++][1]; return last; }), x => String(Math.round(x * 1000) / 1000)); }
  } catch (e) { log('WARN 경제 지표 ' + e.message); }
  // 3) 행
  const R_TDF = tdfRows.filter(d => S[d.PDNO]).map(d => [...rowBase(d), +d.PRDT_NAME.match(/20[2-7][05]/)[0], famOf(d)]);
  R_TDF.sort((a, b) => a[12] - b[12] || a[2].localeCompare(b[2]) || a[13].localeCompare(b[13]));
  const R_EXTRA = extraD.map(d => rowBase(d));
  // 4) FunETF 2개
  for (const f of FUNETF) {
    try {
      const nav = NAVF[f.key]; if (!nav) continue; const m = new Map(nav);
      let base; if (f.base === 'first') { base = nav.find(x => x[0] >= axis[0]); base = base && base[1]; } else base = 10;
      let last = null; const first = nav[0][0];
      const arr = axis.map(d => { if (d < first) return null; if (m.has(d)) last = m.get(d); return last == null ? null : Math.round((f.base === 'first' ? 100 * last / base : last / 10) * 100) / 100; });
      F[f.key] = arr; packV(f.key, arr, x => String(x));
      const rr = p => { const x = periodRet(axis, arr, END, p); return x == null ? null : r2(x); };
      R_EXTRA.push([f.key, f.name, f.co, f.fee, rr(1), rr(3), rr(6), rr(12), rr(36), f.risk, f.setup, f.aum]);
    } catch (e) { log('WARN funetf ' + f.key + ' ' + e.message); }
  }
  const R_VAR = [];
  for (const f of ML.funds) {
    const m = new Map(f.d.map((d, i) => [d, f.v[i]])); let last = null; const first = f.d[0];
    const arr = axis.map(d => { if (d < first) return null; if (m.has(d)) last = m.get(d); return last; });
    packV('M:' + f.code, arr, x => String(Math.round(x * 10) / 10)); R_VAR.push(['M:' + f.code, f.name, f.group, first, f.flags.join(',')]);
  }
  // 5) 보유종목(자동 파싱 가능한 한국투자증권 펀드)
  const HOLD_AUTO = {}, hc = readJson(HCACHE, {});
  for (const [c] of EXTRA) {
    try { const h = await retry(async () => { const x = await holdings(c); if (!x.length) throw new Error('보유종목 비어 있음'); return x; }, 8); HOLD_AUTO[c] = h; hc[c] = { date: new Date().toISOString().slice(0, 10), hold: h }; }
    catch (e) { if (hc[c] && hc[c].hold.length) { HOLD_AUTO[c] = hc[c].hold; log('WARN 보유종목 ' + c + ' 조회 실패(' + e.message + '), ' + hc[c].date + ' 값 사용'); } else throw new Error('보유종목 없음 ' + c + ': ' + e.message); }
  }
  fs.writeFileSync(HCACHE, JSON.stringify(hc, null, 1));
  // 5-2) TDF 구성·위험 지표: 실패하면 직전 값(tdfinfo.json)을 쓰고 갱신은 계속
  const TFILE = path.join(ROOT, 'tdfinfo.json'), tc = readJson(TFILE, {}), TINFO = {};
  { let k = 0; const ids = R_TDF.map(r => r[0]); let fail = 0;
    const w = async () => { while (k < ids.length) { const c = ids[k++]; try { tc[c] = await retry(() => tdfInfo(c), 3); } catch (e) { fail++; } if (tc[c]) TINFO[c] = tc[c]; await sleep(150); } };
    await Promise.all(Array.from({ length: 4 }, w)); if (fail) log('WARN TDF 구성 조회 실패 ' + fail + '건(직전 값 사용)'); }
  fs.writeFileSync(TFILE, JSON.stringify(tc));
  const have = new Set([...R_TDF, ...R_EXTRA].map(r => r[0]));
  const miss = ITEMS.map(i => i.코드).filter(c => !have.has(c)); if (miss.length) throw new Error('라인업 코드를 찾지 못함(코드/검색어 확인): ' + miss.join(','));
  // 6) 검증: 그래프 수익률과 공식 수치가 맞는지(1·3·6개월, 1·3년)
  let bad = 0, cnt = 0, bad2 = 0, cnt2 = 0, fixed = 0;
  for (const r of [...R_TDF, ...R_EXTRA.filter(x => S[x[0]])]) for (const [col, p] of [[4, 1], [5, 3], [6, 6], [7, 12], [8, 36]]) {
    if (r[col] == null || !F[r[0]]) continue; const g = periodRet(axis, F[r[0]], END, p); if (g == null) continue;
    // 한국투자증권 표의 값이 하루 전 기준일로 남아 있는 경우(주로 3년): 같은 산식의 오늘 기준 값으로 바꿔 그래프와 맞춘다
    if (Math.abs(g - r[col]) > 0.1) { const g1 = periodRet(axis, F[r[0]], axis[axis.length - 2], p); if (g1 != null && Math.abs(g1 - r[col]) <= 0.1) { r[col] = r2(g); fixed++; } }
    if (col === 6 || col === 8) { cnt2++; if (Math.abs(g - r[col]) > 0.1) bad2++; continue; } cnt++; if (Math.abs(g - r[col]) > 0.1) bad++;
  }
  log(`검증 ${cnt}건 중 불일치 ${bad}건 / 6개월·3년 ${cnt2}건 중 ${bad2}건 / 전일 기준값 보정 ${fixed}건`);
  if (cnt > 0 && bad / cnt > 0.03) throw new Error('그래프와 공식 수익률 불일치가 많아 갱신을 중단합니다');
  // 7) 페이지 생성
  const asof = `${END.slice(0, 4)}-${END.slice(4, 6)}-${END.slice(6, 8)}`;
  const kst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  const LINEUP = CFG.라인업.map(f => ({ g: f.묶음, type: f.유형, name: f.펀드명, feat: f.특징, etc: f.비고, codes: f.종목.map(i => i.코드) }));
  const LB = Object.fromEntries(ITEMS.filter(i => i.짧은이름).map(i => [i.코드, i.짧은이름]));
  const NOTE = Object.fromEntries(ITEMS.filter(i => i.메모 || i.과거FunETF코드).map(i => [i.코드, [i.메모, i.과거FunETF코드 && '판매 클래스 출시 이전 구간(설정일~)은 FunETF 일반 클래스(종류A) 기준가를 접합일 값에 맞춰 이어 붙인 것으로, 클래스 간 보수 차이만큼 오차가 있을 수 있음.'].filter(Boolean).join(' ')]));
  const HOLD_STATIC = Object.fromEntries(ITEMS.filter(i => i.보유종목).map(i => [i.코드, i.보유종목]));
  const data = `const LINEUP=${JSON.stringify(LINEUP)};
const LB=${JSON.stringify(LB)};
const NOTE=${JSON.stringify(NOTE)};
const HOLD_STATIC=${JSON.stringify(HOLD_STATIC)};
const AXIS="${axis.join(' ')}";\nconst R_TDF=[\n${R_TDF.map(r => JSON.stringify(r)).join(',\n')}\n];\nconst R_EXTRA=[\n${R_EXTRA.map(r => JSON.stringify(r)).join(',\n')}\n];\nconst ERAS=${JSON.stringify(ML.eras)};
const R_VAR=[\n${R_VAR.map(r => JSON.stringify(r)).join(',\n')}\n];\nconst NOFF=${JSON.stringify(NOFF)};\nconst HOLD_AUTO=${JSON.stringify(HOLD_AUTO)};\nconst TINFO=${JSON.stringify(TINFO)};\nconst TNOTE=${JSON.stringify(readJson(path.join(ROOT, 'tdf-notes.json'), {}))};\nconst VINFO=${JSON.stringify(Object.fromEntries(Object.entries(ML.comp || {}).map(([c, v]) => ['M:' + c, v])))};\nconst VNOTE=${JSON.stringify(readJson(path.join(ROOT, 'metlife-notes.json'), {}))};\nconst NAVS={\n${Object.keys(V).map(k => JSON.stringify(k) + ':' + JSON.stringify(V[k])).join(',\n')}\n};`;
  const html = fs.readFileSync(path.join(ROOT, 'tpl.html'), 'utf8').replace('/*@@DATA@@*/', () => data).replace(/@@ASOF@@/g, asof).replace('@@UPDATED@@', kst + ' (KST)');
  if (html.length < 200000) throw new Error('생성된 HTML이 비정상적으로 작음');
  let saved = 0;
  for (const dir of OUT_DIRS) {
    try { fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, OUT_NAME), tmp = f + '.tmp'; fs.writeFileSync(tmp, html); fs.renameSync(tmp, f); saved++; log('저장 ' + f); }
    catch (e) { log('WARN 저장 실패 ' + dir + ' ' + e.message); }
  }
  if (!saved) throw new Error('저장 실패');
  fs.writeFileSync(path.join(ROOT, 'last-run.json'), JSON.stringify({ ts: Date.now(), end: END, updated: kst, tdf: R_TDF.length, days: axis.length, bad, cnt }));
  log(`완료 ${Math.round((Date.now() - t0) / 1000)}초, ${(html.length / 1024).toFixed(0)}KB`);
}
main().catch(e => { log('ERROR ' + e.message); process.exit(1); });
