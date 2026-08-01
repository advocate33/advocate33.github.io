// ════════════════════════════════════════════════════════════════════
//  CRM Адвоката — ЛИЧНЫЙ СЕРВЕР (Яндекс Облако, Cloud Function)
//  Модули: «Почта России» (прокси трекинга, совместим с мостом CRM)
//          «Календарная лента» (публикация .ics в Object Storage)
//  Внешних зависимостей нет. Среда выполнения: nodejs18.
//
//  Переменные окружения функции (Консоль → функция → Редактор → Параметры):
//    SECRET        — секретный код (тот же вводится в CRM)
//    POCHTA_LOGIN  — логин API трекинга (tracking.pochta.ru)
//    POCHTA_PASS   — пароль API трекинга
//    BUCKET        — имя бакета Object Storage (для календарной ленты)
//    S3_KEY_ID     — идентификатор статического ключа сервисного аккаунта
//    S3_SECRET     — секрет статического ключа
// ════════════════════════════════════════════════════════════════════
'use strict';
const crypto = require('crypto');

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};
const reply = (obj, code) => ({ statusCode: code || 200, headers: JSON_HEADERS, body: JSON.stringify(obj) });

module.exports.handler = async function (event) {
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };

  if (method === 'GET') {
    return reply({
      ok: true, service: 'CRM Адвоката — личный сервер', module: 'lichny-server',
      ready: readiness()
    });
  }

  let body;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body || '', 'base64').toString('utf8')
      : (event.body || '');
    body = JSON.parse(raw);
  } catch (e) { return reply({ ok: false, error: 'bad_json' }); }

  if (!body || body.secret !== process.env.SECRET) return reply({ ok: false, error: 'auth' });

  try {
    if (body.action === 'ping')  return reply({ ok: true, ready: readiness() });
    if (body.action === 'track') return reply(await trackBarcodes(body.barcodes || []));
    if (body.action === 'ics')   return reply(await publishIcs(body.ics));
    if (body.action === 'calcheck') return reply(await calCheck());
    if (body.action === 'dbput')  return reply(await dbPut(body.data));
    if (body.action === 'dbget')  return reply(await dbGet());
    if (body.action === 'dbver')  return reply(await dbVer());
    return reply({ ok: false, error: 'unknown_action' });
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  }
};

function readiness() {
  return {
    pochta: !!(process.env.POCHTA_LOGIN && process.env.POCHTA_PASS),
    storage: !!(process.env.BUCKET && process.env.S3_KEY_ID && process.env.S3_SECRET)
  };
}

// ════════════════════════════════════════════════════════════
//  ПОЧТА РОССИИ — официальный API трекинга (rtm34, SOAP).
//  Порт скрипта «Почта-России-скрипт.gs» один в один: тот же
//  конверт, тот же разбор, та же форма ответа для CRM.
// ════════════════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function trackBarcodes(barcodes) {
  if (!process.env.POCHTA_LOGIN || !process.env.POCHTA_PASS) {
    return { ok: false, error: 'Не заполнены POCHTA_LOGIN / POCHTA_PASS в параметрах функции' };
  }
  const results = {}, errors = {};
  const list = (barcodes || []).slice(0, 30); // лимит бесплатного доступа ~100 запросов/день
  let first = true;
  for (const b of list) {
    if (!first) await sleep(300); // Почта отбрасывает залп быстрых запросов — щадящая пауза
    first = false;
    try {
      const r = await trackOne(b);
      results[b] = r.list;
      if (!r.list.length && r.err) errors[b] = r.err;
    } catch (e) { results[b] = []; errors[b] = String(e && e.message || e); }
  }
  return { ok: true, results, errors };
}

async function trackOne(barcode) {
  barcode = String(barcode || '').replace(/[^0-9A-Za-z]/g, ''); // защита SOAP-XML
  const envelope =
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" ' +
      'xmlns:oper="http://russianpost.org/operationhistory" ' +
      'xmlns:data="http://russianpost.org/operationhistory/data" ' +
      'xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">' +
      '<soap:Header/>' +
      '<soap:Body>' +
        '<oper:getOperationHistory>' +
          '<data:OperationHistoryRequest>' +
            '<data:Barcode>' + barcode + '</data:Barcode>' +
            '<data:MessageType>0</data:MessageType>' +
            '<data:Language>RUS</data:Language>' +
          '</data:OperationHistoryRequest>' +
          '<data:AuthorizationHeader soapenv:mustUnderstand="1">' +
            '<data:login>' + process.env.POCHTA_LOGIN + '</data:login>' +
            '<data:password>' + process.env.POCHTA_PASS + '</data:password>' +
          '</data:AuthorizationHeader>' +
        '</oper:getOperationHistory>' +
      '</soap:Body>' +
    '</soap:Envelope>';

  const resp = await fetch('https://tracking.russianpost.ru/rtm34', {
    method: 'POST',
    headers: { 'Content-Type': 'application/soap+xml; charset=UTF-8' },
    body: envelope
  });
  const xml = await resp.text();

  // Разбор без привязки к префиксам пространств имён (как в GAS-скрипте)
  const records = xml.split(/<\w*:?historyRecord>/).slice(1);
  const out = [];
  for (const r of records) {
    const date  = pick(r, 'OperDate');
    const oper  = pickAfter(r, 'OperType', 'Name') || pick(r, 'Name');
    const attr  = pickAfter(r, 'OperAttr', 'Name');
    const place = pickAfter(r, 'OperationAddress', 'Description');
    out.push({
      date: date ? date.replace('T', ' ').slice(0, 16) : '',
      oper: (oper || '') + (attr && attr !== oper ? ' — ' + attr : ''),
      place: place || ''
    });
  }
  // Пусто? Достаём причину из ответа Почты (fault / сообщение об ошибке)
  let err = '';
  if (!out.length) {
    err = pick(xml, 'faultstring') || pickAfter(xml, 'Fault', 'Text') || pick(xml, 'message') || '';
    if (!err && !/historyRecord/.test(xml)) err = 'нет данных по треку (проверьте номер)';
  }
  return { list: out, err };
}

function pick(s, tag) {
  const m = s.match(new RegExp('<\\w*:?' + tag + '>([^<]*)</'));
  return m ? m[1] : '';
}
function pickAfter(s, outer, inner) {
  const m = s.match(new RegExp('<\\w*:?' + outer + '>[\\s\\S]*?<\\w*:?' + inner + '>([^<]*)</'));
  return m ? m[1] : '';
}

// ════════════════════════════════════════════════════════════
//  КАЛЕНДАРНАЯ ЛЕНТА — публикация .ics в Object Storage.
//  Объект: cal-<SECRET>.ics; наружу отдаётся API-шлюзом по адресу
//  https://<шлюз>/cal/<SECRET>  (секретная ссылка для подписки).
// ════════════════════════════════════════════════════════════
async function publishIcs(ics) {
  if (typeof ics !== 'string' || !ics.startsWith('BEGIN:VCALENDAR')) {
    return { ok: false, error: 'bad_ics' };
  }
  if (ics.length > 400000) return { ok: false, error: 'ics_too_big' };
  if (!process.env.BUCKET || !process.env.S3_KEY_ID || !process.env.S3_SECRET) {
    return { ok: false, error: 'Хранилище не настроено: BUCKET / S3_KEY_ID / S3_SECRET' };
  }
  const key = 'cal-' + process.env.SECRET + '.ics';
  const r = await s3Put(key, ics, 'text/calendar; charset=utf-8');
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return { ok: false, error: 's3 ' + r.status + ' ' + t.slice(0, 120) };
  }
  return { ok: true, object: key };
}

// ── Подпись запроса к Object Storage (AWS Signature V4, без зависимостей) ──
const sha256hex = d => crypto.createHash('sha256').update(d, 'utf8').digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();

function sigV4(method, host, canonicalUri, payloadHash, contentType, amzDate, region, service, keyId, keySecret) {
  const dateStamp = amzDate.slice(0, 8);
  const headers = {
    'host': host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate
  };
  if (contentType) headers['content-type'] = contentType; // GET — без content-type
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(h => h + ':' + headers[h] + '\n').join('');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = dateStamp + '/' + region + '/' + service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let k = hmac('AWS4' + keySecret, dateStamp);
  k = hmac(k, region);
  k = hmac(k, service);
  k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign, 'utf8').digest('hex');
  return {
    authorization: 'AWS4-HMAC-SHA256 Credential=' + keyId + '/' + scope +
      ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    signedHeaders
  };
}

async function s3Put(key, bodyStr, contentType) {
  const host = 'storage.yandexcloud.net';
  const region = 'ru-central1';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const canonicalUri = '/' + process.env.BUCKET + '/' + encodeURIComponent(key).replace(/%2F/g, '/');
  const payloadHash = sha256hex(bodyStr);
  const sig = sigV4('PUT', host, canonicalUri, payloadHash, contentType, amzDate,
    region, 's3', process.env.S3_KEY_ID, process.env.S3_SECRET);
  return fetch('https://' + host + canonicalUri, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'X-Amz-Content-Sha256': payloadHash,
      'X-Amz-Date': amzDate,
      'Authorization': sig.authorization
    },
    body: bodyStr
  });
}

async function s3Get(key) {
  const host = 'storage.yandexcloud.net';
  const region = 'ru-central1';
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const canonicalUri = '/' + process.env.BUCKET + '/' + encodeURIComponent(key).replace(/%2F/g, '/');
  const payloadHash = sha256hex('');
  const sig = sigV4('GET', host, canonicalUri, payloadHash, null, amzDate,
    region, 's3', process.env.S3_KEY_ID, process.env.S3_SECRET);
  return fetch('https://' + host + canonicalUri, {
    method: 'GET',
    headers: { 'X-Amz-Content-Sha256': payloadHash, 'X-Amz-Date': amzDate, 'Authorization': sig.authorization }
  });
}

// Диагностика ленты: сервер сам читает свой объект и считает события
async function calCheck() {
  if (!process.env.BUCKET || !process.env.S3_KEY_ID || !process.env.S3_SECRET) {
    return { ok: false, error: 'Хранилище не настроено: BUCKET / S3_KEY_ID / S3_SECRET' };
  }
  const key = 'cal-' + process.env.SECRET + '.ics';
  const r = await s3Get(key);
  if (r.status === 404) return { ok: true, exists: false };
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    return { ok: false, error: 's3 ' + r.status + ' ' + t.slice(0, 140) };
  }
  const txt = await r.text();
  return { ok: true, exists: true, events: (txt.match(/BEGIN:VEVENT/g) || []).length, bytes: Buffer.byteLength(txt, 'utf8') };
}

// ════════════════════════════════════════════════════════════
//  СИНХРОНИЗАЦИЯ БАЗЫ: зашифрованный дамп CRM в вашем Object Storage.
//  Сервер видит только шифротекст (E2E: пароль знают лишь ваши устройства).
// ════════════════════════════════════════════════════════════
function dbKey()    { return 'db-'    + process.env.SECRET + '.crypt'; }
function dbVerKey() { return 'dbver-' + process.env.SECRET + '.txt'; }

async function dbPut(data) {
  if (typeof data !== 'string' || !data.length) return { ok: false, error: 'bad_data' };
  if (data.length > 3500000) return { ok: false, error: 'db_too_big' };
  if (!process.env.BUCKET || !process.env.S3_KEY_ID || !process.env.S3_SECRET) {
    return { ok: false, error: 'Хранилище не настроено: BUCKET / S3_KEY_ID / S3_SECRET' };
  }
  const r1 = await s3Put(dbKey(), data, 'text/plain; charset=utf-8');
  if (!r1.ok) { const t = await r1.text().catch(()=> ''); return { ok:false, error:'s3 '+r1.status+' '+t.slice(0,120) }; }
  const ver = Date.now();
  const r2 = await s3Put(dbVerKey(), String(ver), 'text/plain; charset=utf-8');
  if (!r2.ok) return { ok: false, error: 's3 ver ' + r2.status };
  return { ok: true, ver };
}

async function dbVer() {
  const r = await s3Get(dbVerKey());
  if (r.status === 404) return { ok: true, ver: 0 };
  if (!r.ok) return { ok: false, error: 's3 ' + r.status };
  const t = await r.text();
  return { ok: true, ver: Number(String(t).trim()) || 0 };
}

async function dbGet() {
  const r = await s3Get(dbKey());
  if (r.status === 404) return { ok: true, exists: false };
  if (!r.ok) { const t = await r.text().catch(()=> ''); return { ok:false, error:'s3 '+r.status+' '+t.slice(0,120) }; }
  const data = await r.text();
  const v = await dbVer();
  return { ok: true, exists: true, data, ver: (v.ok && v.ver) || 0 };
}

// Экспорт внутренностей для автотестов (на работу функции не влияет)
module.exports._test = { pick, pickAfter, sigV4, sha256hex };
