// ════════════════════════════════════════════════════════════════════
//  КОЛЛЕКТОР СУДОВ — ЗАГРУЗЧИК С АВТООБНОВЛЕНИЕМ (index.js функции collector-sud)
//  Рядом лежит collector-sud.mjs — запасная копия. При заданной UPDATE_URL загрузчик
//  раз в 10 минут проверяет version.json и подгружает свежий collector-sud.mjs.
//  Переменные: UPDATE_URL (папка обновлений автора), UPDATE_PIN (например 3.12 — зафиксировать).
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto'), { pathToFileURL } = require('url');
const UPDATE_URL = String(process.env.UPDATE_URL || '').replace(/\/+$/, '');
const PIN = String(process.env.UPDATE_PIN || '').trim();
const CHECK_MS = 10 * 60 * 1000;
// v1.1: LICENSE_KEY — обновления выдаются лицензионным сервером только по действующему ключу.
// Тогда UPDATE_URL — адрес лицензионного сервера, а не папки раздачи.
const LICENSE_KEY = String(process.env.LICENSE_KEY || '').trim();
// v1.2: подпись выпуска. Если задан UPDATE_PUB (открытый ключ автора, JSON JWK), принимаются только version.json
// с полями signed (подписанный манифест) и sig (подпись ECDSA P-256) — контрольные суммы берутся из подписанного манифеста.
const UPDATE_PUB = String(process.env.UPDATE_PUB || '').trim();
function manifestOf(text) {
  const raw = JSON.parse(text);
  if (!UPDATE_PUB) return raw.signed ? Object.assign({}, raw, JSON.parse(Buffer.from(String(raw.signed).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))) : raw;
  if (!raw.signed || !raw.sig) throw new Error('version.json не подписан, а UPDATE_PUB задан — обновление отклонено');
  const payload = Buffer.from(String(raw.signed).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const sig = Buffer.from(String(raw.sig).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const pub = crypto.createPublicKey({ key: JSON.parse(UPDATE_PUB), format: 'jwk' });
  if (!crypto.verify('sha256', payload, { key: pub, dsaEncoding: 'ieee-p1363' }, sig)) throw new Error('подпись version.json неверна — обновление отклонено');
  return JSON.parse(payload.toString('utf8'));
}
const distUrl = file => LICENSE_KEY ? UPDATE_URL + '?action=dist&file=' + encodeURIComponent(file) + '&key=' + encodeURIComponent(LICENSE_KEY) : UPDATE_URL + '/' + file;
const TMP = '/tmp/crm-collector';
let mod = null, loadedVer = '', checkedAt = 0;

async function bundled() { mod = await import('./collector-sud.mjs'); loadedVer = 'встроенная'; }
async function fetchText(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try { const r = await fetch(url, { cache: 'no-store', signal: ctl.signal }); if (!r.ok) { let hint = ''; try { const j = JSON.parse(await r.text()); if (j && j.error) hint = ' (' + (j.error === 'license_revoked' ? 'лицензия отозвана' : j.error === 'license_expired' ? 'срок лицензии истёк' : j.error) + ')'; } catch (e) {} throw new Error('HTTP ' + r.status + hint + ' ' + url.replace(/key=[^&]+/, 'key=…')); } return await r.text(); }
  finally { clearTimeout(t); }
}
async function ensure() {
  if (!UPDATE_URL) { if (!mod) await bundled(); return; }
  if (mod && Date.now() - checkedAt < CHECK_MS) return;
  checkedAt = Date.now();
  try {
    const man = manifestOf(await fetchText(distUrl('version.json')));
    const ver = PIN || String(man.collector || '');
    if (!ver) throw new Error('в version.json нет номера коллектора');
    if (mod && ver === loadedVer) return;
    const file = PIN ? `collector-sud-v${PIN}.mjs` : (man.collectorFile || 'collector-sud.mjs');
    const code = await fetchText(distUrl(file));
    const want = PIN ? (man.hashes || {})[file] : man.collectorSha256;
    if (want) { const h = crypto.createHash('sha256').update(code, 'utf8').digest('hex'); if (h !== want) throw new Error('контрольная сумма не совпала'); }
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'collector-' + ver.replace(/[^\w.-]/g, '') + '.mjs');
    fs.writeFileSync(p, code, 'utf8');
    const m = await import(pathToFileURL(p).href);
    if (typeof m.handler !== 'function') throw new Error('в загруженном файле нет handler');
    mod = m; loadedVer = ver;
  } catch (e) {
    console.log('автообновление коллектора: ' + (e && e.message || e) + (mod ? ' — остаётся ' + loadedVer : ' — встроенная копия'));
    if (!mod) await bundled();
  }
}
module.exports.handler = async (event, context) => { await ensure(); return mod.handler(event, context); };
module.exports._loader = { ensure, state: () => ({ loadedVer, checkedAt }) };
