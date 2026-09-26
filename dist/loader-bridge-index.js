// ════════════════════════════════════════════════════════════════════
//  CRM Адвоката — ЗАГРУЗЧИК ЛИЧНОГО СЕРВЕРА С АВТООБНОВЛЕНИЕМ
//  Кладётся в функцию моста как index.js; рядом — server.js (запасная копия).
//  Если задана переменная UPDATE_URL (адрес папки обновлений в бакете автора),
//  загрузчик раз в 10 минут проверяет version.json и подгружает свежий server.js.
//  Если обновление недоступно или не прошло проверку — работает запасная копия.
//
//  Переменные функции:
//    UPDATE_URL  — https://storage.yandexcloud.net/<бакет-автора>/dist   (пусто — без автообновления)
//    UPDATE_PIN  — номер версии сервера, например 176, чтобы зафиксировать (не обновляться дальше)
// ════════════════════════════════════════════════════════════════════
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
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
const TMP = '/tmp/crm-server';
let mod = null, loadedVer = '', checkedAt = 0, lastError = '';

function bundled() { mod = require('./server.js'); loadedVer = 'встроенная'; return mod; }
async function fetchText(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 8000);
  try { const r = await fetch(url, { cache: 'no-store', signal: ctl.signal }); if (!r.ok) { let hint = ''; try { const j = JSON.parse(await r.text()); if (j && j.error) hint = ' (' + (j.error === 'license_revoked' ? 'лицензия отозвана' : j.error === 'license_expired' ? 'срок лицензии истёк' : j.error) + ')'; } catch (e) {} throw new Error('HTTP ' + r.status + hint + ' ' + url.replace(/key=[^&]+/, 'key=…')); } return await r.text(); }
  finally { clearTimeout(t); }
}
async function ensure() {
  if (!UPDATE_URL) { if (!mod) bundled(); return; }
  if (mod && Date.now() - checkedAt < CHECK_MS) return;
  checkedAt = Date.now();
  try {
    const man = manifestOf(await fetchText(distUrl('version.json')));
    const ver = PIN || String(man.server || '');
    if (!ver) throw new Error('в version.json нет номера сервера');
    if (mod && ver === loadedVer) return;
    const file = PIN ? `server-v${PIN}.js` : (man.serverFile || 'server.js');
    const code = await fetchText(distUrl(file));
    const want = PIN ? (man.hashes || {})[file] : man.serverSha256;
    if (want) { const h = crypto.createHash('sha256').update(code, 'utf8').digest('hex'); if (h !== want) throw new Error('контрольная сумма не совпала — файл повреждён при загрузке'); }
    fs.mkdirSync(TMP, { recursive: true });
    const p = path.join(TMP, 'server-' + ver.replace(/[^\w.-]/g, '') + '.js');
    fs.writeFileSync(p, code, 'utf8');
    delete require.cache[p];
    const m = require(p);
    if (typeof m.handler !== 'function') throw new Error('в загруженном файле нет handler');
    mod = m; loadedVer = ver; lastError = '';
  } catch (e) {
    lastError = String(e && e.message || e);
    console.log('автообновление сервера: ' + lastError + (mod ? ' — остаётся версия ' + loadedVer : ' — работает встроенная копия'));
    if (!mod) bundled();
  }
}
module.exports.handler = async (event, context) => {
  await ensure();
  const r = await mod.handler(event, context);
  try {
    r.headers = Object.assign({}, r.headers, { 'X-CRM-Server': loadedVer, 'Access-Control-Expose-Headers': 'X-CRM-Server' });
    // ping/GET-страница: сообщаем, какая версия реально работает и откуда
    if (r.body && /"service"|"ready"/.test(r.body)) { const j = JSON.parse(r.body); if (j && typeof j === 'object' && !Array.isArray(j)) { j.loader = { running: loadedVer, updateUrl: UPDATE_URL ? 'задан' : 'нет', pin: PIN || '', error: lastError || undefined }; r.body = JSON.stringify(j); } }
  } catch (e) {}
  return r;
};
module.exports._loader = { ensure, state: () => ({ loadedVer, lastError, checkedAt }) };
