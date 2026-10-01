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

// 라인업의 비TDF 펀드(코드 → 검색어)
const EXTRA = [['073101', 'AB미국그로스'], ['073124', 'AB미국그로스'], ['042430', 'KCGI차이나'], ['040429', '글로벌AI'], ['040438', '글로벌AI'], ['010953', '유진챔피언단기채']];
// FunETF에서 가져오는 2개 펀드(한국투자증권 펀드몰에 없음). 보수·위험등급·설정일·설정액은 고정값.
const FUNETF = [
  { key: '484210', fundCd: 'KR5301AW7849', term: '36', base: 'first', co: '미래에셋', fee: 0.62, risk: '3등급(다소높은위험)', setup: '20141111', aum: 6835,
    name: '미래에셋퇴직연금배당커버드콜액티브증권자투자신탁1호(주식혼합) 종류C-P2e(온라인-퇴직연금)' },
  { key: 'K55101EI6779', fundCd: 'K55101EI6779', term: '12', base: 'unit', co: '한국투자', fee: 0.74, risk: '4등급(보통위험)', setup: '20260713', aum: null,
    name: '한국투자인컴주는ETF모으기월배당증권자투자신탁H(채권혼합-재간접형)(A)' },
];

const log = m => { const s = `[${new Date().toISOString()}] ${m}`; console.log(s); try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, s + '\n'); } catch (e) {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function retry(fn, n = 4) { let e; for (let i = 0; i < n; i++) { try { return await fn(); } catch (x) { e = x; await sleep(1500 * (i + 1)); } } throw e; }
const post = async (url, params) => retry(async () => { const r = await fetch(url, { method: 'POST', headers: FORM, body: new URLSearchParams(params) }); if (!r.ok) throw new Error(url + ' ' + r.status); return r.text(); });

async function search(k) {
  const t = await post(KIS + '/main/opensearch/result/json_items_web_renewal.jsp', { mode: 'detail', collection: 'witems', idxCount: '0', listCount: '300', commonSaleYn: 'Y', scSaleChannel: '01', menuValue: 'smart', menuType: 'profitRate', query: k });
  return JSON.parse(t).dataList || [];
}
async function chart(p) {
  const t = await post(KIS + '/main/mall/openfund/FundInfo_Pop.jsp?cmd=A_FP_20270_CHART', { cmd: 'A_FP_20270_CHART', pdno: p, term: '36', EXCEL_YN: '', gijun_radio: 'CRCT_BSPR24' });
  const j = JSON.parse(t); if (!j.BASS_DT || !j.BASS_DT.length) throw new Error('no chart ' + p);
  return { d: j.BASS_DT, c: j.CRCT_BSPR24, b: j.BSPR24 };
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

async function funetfNav(f) {
  const page = `https://www.funetf.co.kr/product/fund/view/${f.fundCd}`;
  const r = await retry(async () => { const x = await fetch(page, { headers: UA }); if (!x.ok) throw new Error('funetf page ' + x.status); return x; });
  const html = await r.text();
  const csrf = (html.match(/name="_csrf"[^>]*content="([^"]+)"/) || html.match(/content="([^"]+)"[^>]*name="_csrf"/) || [])[1];
  if (!csrf) throw new Error('funetf csrf missing');
  const cookie = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
  const p = new URLSearchParams({ gijunYmd: new Date().toISOString().slice(0, 10).replace(/-/g, ''), fundCd: f.fundCd, repFundCd: f.fundCd, mketDvsn: '02', usdYn: 'N', _csrf: csrf, schNavMode: 'T', schNavTerm: f.term });
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
  const worker = async () => { while (next < ids.length) { const p = ids[next++]; try { S[p] = await chart(p); } catch (e) { log('WARN chart ' + p + ' ' + e.message); } } };
  await Promise.all([worker(), worker(), worker()]);
  const okIds = ids.filter(p => S[p]); if (okIds.length < ids.length - 3) throw new Error('시계열 실패가 많음: ' + (ids.length - okIds.length));
  const refId = okIds.slice().sort((a, b) => S[b].d.length - S[a].d.length)[0];
  const axis = S[refId].d.filter(d => d <= END);
  if (axis[axis.length - 1] !== END) throw new Error('기준일 데이터가 시계열에 없음 ' + END);
  const V = {}, F = {};
  for (const p of okIds) {
    const s = S[p], m = new Map(); s.d.forEach((d, i) => { const v = parseFloat(s.c[i] || s.b[i]); if (!isNaN(v)) m.set(d, v); });
    const first = s.d[0]; let last = null;
    const arr = axis.map(d => { if (d < first) return null; if (m.has(d)) last = m.get(d); return last; });
    F[p] = arr; V[p] = arr.map(x => x == null ? '' : String(Math.round(x * 10) / 10)).join(',');
  }
  // 3) 행
  const R_TDF = tdfRows.filter(d => S[d.PDNO]).map(d => [...rowBase(d), +d.PRDT_NAME.match(/20[2-7][05]/)[0], famOf(d)]);
  R_TDF.sort((a, b) => a[12] - b[12] || a[2].localeCompare(b[2]) || a[13].localeCompare(b[13]));
  const R_EXTRA = extraD.map(d => rowBase(d));
  // 4) FunETF 2개
  for (const f of FUNETF) {
    try {
      const nav = await funetfNav(f); const m = new Map(nav);
      let base; if (f.base === 'first') { base = nav.find(x => x[0] >= axis[0]); base = base && base[1]; } else base = 10;
      let last = null; const first = nav[0][0];
      const arr = axis.map(d => { if (d < first) return null; if (m.has(d)) last = m.get(d); return last == null ? null : Math.round((f.base === 'first' ? 100 * last / base : last / 10) * 100) / 100; });
      F[f.key] = arr; V[f.key] = arr.map(x => x == null ? '' : String(x)).join(',');
      const rr = p => { const x = periodRet(axis, arr, END, p); return x == null ? null : r2(x); };
      R_EXTRA.push([f.key, f.name, f.co, f.fee, rr(1), rr(3), rr(6), rr(12), rr(36), f.risk, f.setup, f.aum]);
    } catch (e) { log('WARN funetf ' + f.key + ' ' + e.message); }
  }
  // 5) 보유종목(자동 파싱 가능한 한국투자증권 펀드)
  const HOLD_AUTO = {};
  for (const [c] of EXTRA) { try { const h = await holdings(c); if (h.length) HOLD_AUTO[c] = h; } catch (e) { log('WARN holdings ' + c + ' ' + e.message); } }
  // 6) 검증: 그래프 수익률과 공식 수치가 맞는지(1개월·3개월·1년)
  let bad = 0, cnt = 0;
  for (const r of [...R_TDF, ...R_EXTRA.filter(x => S[x[0]])]) for (const [col, p] of [[4, 1], [5, 3], [7, 12]]) {
    if (r[col] == null || !F[r[0]]) continue; const g = periodRet(axis, F[r[0]], END, p); if (g == null) continue; cnt++; if (Math.abs(g - r[col]) > 0.1) bad++;
  }
  log(`검증 ${cnt}건 중 불일치 ${bad}건`);
  if (cnt > 0 && bad / cnt > 0.03) throw new Error('그래프와 공식 수익률 불일치가 많아 갱신을 중단합니다');
  // 7) 페이지 생성
  const asof = `${END.slice(0, 4)}-${END.slice(4, 6)}-${END.slice(6, 8)}`;
  const kst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
  const data = `const AXIS="${axis.join(' ')}";\nconst R_TDF=[\n${R_TDF.map(r => JSON.stringify(r)).join(',\n')}\n];\nconst R_EXTRA=[\n${R_EXTRA.map(r => JSON.stringify(r)).join(',\n')}\n];\nconst HOLD_AUTO=${JSON.stringify(HOLD_AUTO)};\nconst NAVS={\n${Object.keys(V).map(k => JSON.stringify(k) + ':' + JSON.stringify(V[k])).join(',\n')}\n};`;
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
