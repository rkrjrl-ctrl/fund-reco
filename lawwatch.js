// 연금 화면(계산기·제도 정리)의 근거 법령이 바뀌었는지 법제처에서 확인한다.
// 지금 시행 중인 본과 시행 예정인 본을 받아, lawwatch.json 의 seen(내용을 확인해 반영을 끝낸 본)에 없는 것을 "확인 필요"로 돌려준다.
// 읽지 못하면 지난번 결과를 그대로 쓴다(빌드를 멈추지 않는다). 내용 반영은 사람이 한다. 이 파일은 바뀐 것을 알려 주기만 한다.
// 확인을 끝냈으면: node lawwatch.js --seen            (지금 뜬 것 모두 확인 처리)
//                 node lawwatch.js --seen 소득세법    (그 법령만)
// ponytail: 연금과 상관없는 개정(타법개정 등)도 뜬다. 조문 단위로 가려내려면 개정문을 읽어 근거 조문 번호와 견주면 된다
const fs = require('fs');
const LAWS = ['국민연금법', '국민연금법 시행령', '공무원연금법', '공무원연금법 시행령', '사립학교교직원 연금법', '군인연금법', '근로자퇴직급여 보장법', '소득세법', '소득세법 시행령', '국민건강보험법 시행령', '국민건강보험법 시행규칙', '노인장기요양보험법 시행령'];
const today = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
const key = x => x.법령일련번호 + '@' + x.시행일자;
async function rows(name, td) { // 시행 중인 본 + 아직 시행 전인 본
  const r = await fetch('https://www.law.go.kr/DRF/lawSearch.do?OC=test&target=eflaw&type=JSON&display=100&nw=2,3&query=' + encodeURIComponent(name), { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const a = [].concat((await r.json()).LawSearch.law || []).filter(x => x.법령명한글 == name && (x.현행연혁코드 == '현행' || x.시행일자 > td));
  if (!a.some(x => x.현행연혁코드 == '현행')) throw new Error(name + ': 시행 중인 본을 찾지 못함');
  return a;
}
async function scan(seen) {
  const td = today(), all = [], pend = [];
  for (const n of LAWS) {
    const a = await rows(n, td); all.push(...a.map(key));
    const p = a.filter(x => !seen.includes(key(x))).sort((x, y) => x.시행일자.localeCompare(y.시행일자));
    if (p.length) pend.push({ n, items: p.map(x => ({ k: key(x), p: x.공포일자, e: x.시행일자, t: x.제개정구분명 })) });
  }
  return { td, all, pend };
}
module.exports = async ({ file, log }) => {
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    const s = await scan(cur.seen);
    cur.seen = cur.seen.filter(k => s.all.includes(k)); // 지나간 본은 지운다
    cur.pend = s.pend; cur.checked = s.td;
    fs.writeFileSync(file, JSON.stringify(cur, null, 1) + '\n');
    if (s.pend.length) log('확인이 필요한 법 개정: ' + s.pend.map(x => `${x.n} ${x.items.length}건`).join(', '));
  } catch (e) { log('WARN 법 개정 확인을 하지 못해 지난번 결과 사용: ' + e.message); }
  return { checked: cur.checked, pend: cur.pend };
};
if (require.main === module) (async () => {
  const file = __dirname + '/lawwatch.json', [, , cmd, name] = process.argv;
  const cur = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { seen: [], pend: [], checked: '' };
  const s = await scan(cur.seen);
  console.assert(s.all.length >= LAWS.length, '법령마다 한 본 이상');
  if (cmd == '--seen') { for (const x of s.pend) if (!name || x.n == name) cur.seen.push(...x.items.map(i => i.k)); const t = await scan(cur.seen); cur.pend = t.pend; cur.checked = t.td; fs.writeFileSync(file, JSON.stringify(cur, null, 1) + '\n'); }
  for (const x of (cmd == '--seen' ? cur.pend : s.pend)) for (const i of x.items) console.log(x.n, i.k, '공포', i.p, '시행', i.e, i.t);
})();
