// 국민연금 계산에 쓰는 기준 숫자(A값, 부양가족연금액)를 국민연금공단 "급여액 산정" 안내에서 읽어 pension.json 을 고친다.
// 읽지 못하거나 값이 이상하면 저장해 둔 pension.json 을 그대로 쓴다(빌드를 멈추지 않는다).
// ponytail: 기준소득월액 상·하한(lo·hi)은 이 페이지에 없어 pension.json 에 손으로 적는다. 매년 7월에 바뀌므로 그때 고칠 것.
const fs = require('fs');
const URL = 'https://www.nps.or.kr/pnsinfo/ntpsklg/getOHAF0048M0.do';
const num = s => +s.replace(/,/g, '');
function parse(html) {
  const t = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const a = t.match(/([\d.]+월\s*~\s*[\d.]+월)\s*지급사유 발생자에게 적용할 A값은\s*([\d,]+)원/);
  const sp = t.match(/배우자\s*:\s*연\s*([\d,]+)원/), dp = t.match(/자녀[^:]{0,40}:\s*연\s*([\d,]+)원/);
  if (!a || !sp || !dp) throw new Error('공단 페이지 형식이 바뀜');
  return { A: num(a[2]), Aperiod: a[1].replace(/\s+/g, ' '), spouse: num(sp[1]), dep: num(dp[1]) };
}
module.exports = async ({ file, log }) => {
  const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
  try {
    const r = await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const p = parse(await r.text());
    // A값은 해마다 몇 %씩만 오른다. 터무니없는 값이면 버린다
    if (!(p.A >= cur.A && p.A < cur.A * 1.15) || !(p.spouse > 2e5 && p.spouse < 6e5) || !(p.dep > 1e5 && p.dep < p.spouse)) throw new Error('값이 범위를 벗어남 ' + JSON.stringify(p));
    const next = { ...cur, ...p, checked: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10) };
    if (p.A !== cur.A || p.spouse !== cur.spouse || p.dep !== cur.dep) log(`국민연금 기준 숫자 바뀜: A값 ${cur.A} → ${p.A}`);
    fs.writeFileSync(file, JSON.stringify(next, null, 1) + '\n');
    return next;
  } catch (e) { log('WARN 국민연금 기준 숫자를 읽지 못해 저장된 값 사용: ' + e.message); return cur; }
};
module.exports.parse = parse;
if (require.main === module) { // 자체 점검: node pension.js <저장한 html>
  const p = parse(fs.readFileSync(process.argv[2], 'utf8')); console.log(p);
  console.assert(p.A > 3e6 && p.spouse > p.dep, 'parse');
}
