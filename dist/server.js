// ════════════════════════════════════════════════════════════════════
//  CRM Адвоката — ЛИЧНЫЙ СЕРВЕР (Яндекс Облако, Cloud Function)
//  Модули: «Почта России» (прокси трекинга, совместим с мостом CRM)
//          «Календарная лента» (публикация .ics в Object Storage)
//          «События мониторинга» (v171: приём от коллектора судов — eventsput,
//           выдача в CRM — eventsget; хранятся в Object Storage)
//          «Диктовка» (v172: приложение голосовых записей — загрузка звука в бакет по
//           подписанной ссылке, распознавание SpeechKit (асинхронно, длинные записи),
//           чистка и юридическая стилизация текста моделью Yandex AI Studio)
//  v173: события хранят crmNumber — точная привязка к делу CRM (коллектор v3.6)
//  v176: ОНЛАЙН-КОПИИ ДОКУМЕНТОВ. Файл шифруется НА УСТРОЙСТВЕ паролем синхронизации и кладётся в бакет
//  напрямую по подписанной ссылке (сервер видит только шифротекст и не знает пароля):
//    blobput  {id, name?, size?} → {url, key} — ссылка PUT на 1 час
//    blobget  {id}               → {url} — ссылка GET на 1 час
//    bloblist {}                 → {items:[{id, size, at}]}
//    blobdel  {id}               → удаление
//  Объекты: blob-<SECRET>/<id>.bin. Метаданные (какому делу и документу принадлежит файл) остаются
//  в зашифрованной базе CRM — на сервере их нет.
//  v174: ОНЛАЙН-ЗАПИСЬ НА ПРИЁМ. Публичная страница без секрета: GET /bridge?book=<publicId> — календарь
//  свободных окон (их публикует CRM), форма; POST /bridge {book, action:'bookreq', date, time, name, phone, topic, comment}
//  — заявка (сервер проверяет, что окно свободно, шлёт уведомление в Telegram, если заданы TG_TOKEN/TG_CHAT).
//  Для CRM (с секретом): bookpub {publicId, settings, days} — опубликовать окна; bookget {since?} — заявки;
//  bookset {id, status, note?} — подтвердить/отклонить (клиент видит статус: GET /bridge?book=<pid>&code=<код>).
//  Объекты: book-<publicId>.json (публичное: окна и настройки), bookings-<SECRET>.json (заявки: имя, телефон — вне шифрования CRM).
//  Внешних зависимостей нет. Среда выполнения: nodejs18.
//
//  Переменные окружения функции (Консоль → функция → Редактор → Параметры):
//    SECRET        — секретный код (тот же вводится в CRM)
//    POCHTA_LOGIN  — логин API трекинга (tracking.pochta.ru)
//    POCHTA_PASS   — пароль API трекинга
//    BUCKET        — имя бакета Object Storage (для календарной ленты и событий)
//    S3_KEY_ID     — идентификатор статического ключа сервисного аккаунта
//    S3_SECRET     — секрет статического ключа
//    FOLDER_ID     — идентификатор каталога Яндекс Облака (для SpeechKit и моделей; v172)
//    LLM_MODEL_URI — необязательно; модель для чистки, по умолчанию gpt://<FOLDER_ID>/yandexgpt-lite/latest
//    LLM_MODEL_URI_LEGAL — необязательно; модель для юридической стилизации, по умолчанию gpt://<FOLDER_ID>/yandexgpt/latest
//    Функции нужен сервисный аккаунт с ролями storage.editor, ai.speechkit-stt.user, ai.languageModels.user
//
//  v171 — события мониторинга:
//    POST /bridge {secret, action:'eventsput', mode:'merge'|'replace', events:[…]}
//        — так шлёт коллектор судов; слияние по source+externalId, изменившееся событие обновляется
//    GET  /bridge  с заголовком  Authorization: Bearer <SECRET>
//        — так забирает CRM («Мониторинг → HTTPS-адаптер»: URL = адрес /bridge, токен = SECRET);
//          ответ — JSON-массив событий
//    POST /bridge {secret, action:'eventsget'} — то же, ответ {ok, events}
//    POST /bridge {secret, action:'eventsclear'} — очистить хранилище событий
//  Объект в бакете: events-<SECRET>.json (до 5000 событий, старше 400 дней отбрасываются).
//
//  v172 — диктовка (все действия — POST /bridge с secret):
//    dict_upload  {name, contentType}          → {id, key, url} — подписанная ссылка PUT на 1 час: приложение
//                                                 загружает звук напрямую в бакет (размер функции не ограничивает)
//    dict_start   {id, format: OGG_OPUS|MP3|WAV} → {id, opId} — запуск асинхронного распознавания SpeechKit
//    dict_status  {id}                          → {done, text?, error?} — опрос; готовый текст сохраняется в задании
//    dict_process {id | text, modes:['clean','legal'], hint?} → {clean?, legal?} — модель AI Studio по частям
//    dict_list    {}                            → {jobs:[…]}; dict_delete {id} → удаление звука, задания и текстов
//  Задания: dict/<id>.json, звук: dict/<id>.<ext>. Звук и текст не покидают ваш каталог Яндекс Облака.
// ════════════════════════════════════════════════════════════════════
'use strict';
const crypto = require('crypto');

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};
const reply = (obj, code) => ({ statusCode: code || 200, headers: JSON_HEADERS, body: JSON.stringify(obj) });

module.exports.handler = async function (event, context) {
  if (event && context) event._context = context; // v172: IAM-токен сервисного аккаунта
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };

  const q0 = event.queryStringParameters || {};
  if (q0.book) { // v174: публичная страница записи (без секрета)
    try { return method === 'GET' ? await bookPage(q0) : reply({ ok: false, error: 'method' }, 405); }
    catch (err) { return { statusCode: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Ошибка: ' + (err && err.message || err) }; }
  }
  if (method === 'GET') {
    // v171: CRM забирает события GET-запросом с Bearer-токеном (или ?secret=… для разовой отладки)
    const bearer = bearerOf(event);
    const q = event.queryStringParameters || {};
    if ((bearer && bearer === process.env.SECRET) || (q.secret && q.secret === process.env.SECRET)) {
      try {
        const st = await eventsLoad();
        return reply(st.events); // массив — формат, который понимает crmMonRows
      } catch (err) { return reply({ ok: false, error: String(err && err.message || err) }, 500); }
    }
    if (bearer || q.secret) return reply({ ok: false, error: 'auth' }, 403);
    return reply({
      ok: true, service: 'CRM Адвоката — личный сервер', module: 'lichny-server', ver: 176,
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

  if (body && body.action === 'bookreq') { try { return reply(await bookRequest(body, event)); } catch (err) { return reply({ ok: false, error: String(err && err.message || err) }); } } // v174: заявка клиента, без секрета
  if (!body || body.secret !== process.env.SECRET) return reply({ ok: false, error: 'auth' });

  try {
    if (body.action === 'ping')  return reply({ ok: true, ready: readiness(), ver: 176 });
    if (body.action === 'track') return reply(await trackBarcodes(body.barcodes || []));
    if (body.action === 'ics')   return reply(await publishIcs(body.ics));
    if (body.action === 'calcheck') return reply(await calCheck());
    if (body.action === 'dbput')  return reply(await dbPut(body.data));
    if (body.action === 'dbget')  return reply(await dbGet());
    if (body.action === 'dbver')  return reply(await dbVer());
    if (body.action === 'eventsput')   return reply(await eventsPut(body.events, body.mode));   // v171
    if (body.action === 'eventsget')   return reply({ ok: true, events: (await eventsLoad()).events });
    if (body.action === 'eventsclear') return reply(await eventsSave({ events: [] }));
    if (body.action === 'dict_upload')  return reply(await dictUpload(body));   // v172
    if (body.action === 'dict_start')   return reply(await dictStart(body, event));
    if (body.action === 'dict_status')  return reply(await dictStatus(body, event));
    if (body.action === 'dict_process') return reply(await dictProcess(body, event));
    if (body.action === 'dict_list')    return reply(await dictList());
    if (body.action === 'dict_delete')  return reply(await dictDelete(body));
    if (body.action === 'bookpub')  return reply(await bookPublish(body));   // v174
    if (body.action === 'bookget')  return reply(await bookGet(body));
    if (body.action === 'bookset')  return reply(await bookSet(body));
    if (body.action === 'blobput')  return reply(await blobPut(body));   // v176
    if (body.action === 'blobget')  return reply(await blobGet(body));
    if (body.action === 'bloblist') return reply(await blobList());
    if (body.action === 'blobdel')  return reply(await blobDel(body));
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
function bearerOf(event) {
  const h = event.headers || {};
  const a = h.Authorization || h.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(String(a).trim());
  return m ? m[1].trim() : '';
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
  const payloadHash = sha256hex('');
  if (String(key).startsWith('?')) { // v172: листинг бакета (list-type=2&prefix=…) — подпись с query
    const canonicalUri = '/' + process.env.BUCKET + '/';
    const params = Object.fromEntries(new URLSearchParams(key.slice(1)));
    const enc = v => encodeURIComponent(v).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    const cq = Object.keys(params).sort().map(k => enc(k) + '=' + enc(params[k])).join('&');
    const headers = { 'host': host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const signedHeaders = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers).sort().map(h => h + ':' + headers[h] + '\n').join('');
    const canonicalRequest = ['GET', canonicalUri, cq, canonicalHeaders, signedHeaders, payloadHash].join('\n');
    const dateStamp = amzDate.slice(0, 8), scope = dateStamp + '/' + region + '/s3/aws4_request';
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
    let k = hmac('AWS4' + process.env.S3_SECRET, dateStamp); k = hmac(k, region); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
    const signature = crypto.createHmac('sha256', k).update(stringToSign, 'utf8').digest('hex');
    const auth = 'AWS4-HMAC-SHA256 Credential=' + process.env.S3_KEY_ID + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
    return fetch('https://' + host + canonicalUri + '?' + cq, { method: 'GET', headers: { 'X-Amz-Content-Sha256': payloadHash, 'X-Amz-Date': amzDate, 'Authorization': auth } });
  }
  const canonicalUri = '/' + process.env.BUCKET + '/' + encodeURIComponent(key).replace(/%2F/g, '/');
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

// ════════════════════════════════════════════════════════════
//  v171: СОБЫТИЯ МОНИТОРИНГА — приём от коллектора судов, выдача в CRM.
//  Объект events-<SECRET>.json: { events:[…], updatedAt }.
//  Слияние по source+externalId: изменившееся событие (title/date/raw) обновляется,
//  повторное — не дублируется. Лимиты: 5000 событий, старше 400 дней отбрасываются.
// ════════════════════════════════════════════════════════════
function eventsKey() { return 'events-' + process.env.SECRET + '.json'; }
const EV_MAX = 5000, EV_MAX_AGE_DAYS = 400;
const EV_FIELDS = ['externalId', 'title', 'date', 'eventType', 'courtNo', 'caseUid', 'judge', 'source', 'raw', 'crmNumber', 'court']; // v173: crmNumber; v175: court — суд страницы (коллектор v3.11)

function evNormalize(e) { // только известные поля, строки, разумной длины
  if (!e || typeof e !== 'object') return null;
  const out = {};
  for (const f of EV_FIELDS) { const v = e[f]; if (v !== undefined && v !== null) out[f] = String(v).slice(0, f === 'raw' ? 4000 : 400); }
  if (!out.externalId || !out.date) return null;
  out.eventType = out.eventType || 'notice';
  out.source = out.source || 'Коллектор судов';
  return out;
}
const evId = e => (e.source || '') + '|' + e.externalId;
const evSig = e => [e.title, e.date, e.eventType, e.courtNo, e.caseUid, e.judge, e.raw].map(x => x || '').join('\u0001');

async function eventsLoad() {
  if (!process.env.BUCKET || !process.env.S3_KEY_ID || !process.env.S3_SECRET) {
    throw new Error('Хранилище не настроено: BUCKET / S3_KEY_ID / S3_SECRET');
  }
  const r = await s3Get(eventsKey());
  if (r.status === 404) return { events: [], updatedAt: 0 };
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('s3 ' + r.status + ' ' + t.slice(0, 120)); }
  try { const j = JSON.parse(await r.text()); return { events: Array.isArray(j.events) ? j.events : [], updatedAt: j.updatedAt || 0 }; }
  catch (e) { return { events: [], updatedAt: 0 }; }
}
async function eventsSave(st) {
  st.updatedAt = Date.now();
  const r = await s3Put(eventsKey(), JSON.stringify(st), 'application/json; charset=utf-8');
  if (!r.ok) { const t = await r.text().catch(() => ''); return { ok: false, error: 's3 ' + r.status + ' ' + t.slice(0, 120) }; }
  return { ok: true, total: st.events.length };
}
function eventsMerge(existing, incoming, mode) { // чистая функция — для тестов
  const list = mode === 'replace' ? [] : existing.slice();
  const idx = new Map(list.map((e, i) => [evId(e), i]));
  let added = 0, updated = 0, skipped = 0;
  for (const raw of incoming) {
    const e = evNormalize(raw); if (!e) { skipped++; continue; }
    const k = evId(e), i = idx.get(k);
    if (i === undefined) { idx.set(k, list.length); list.push(e); added++; }
    else if (evSig(list[i]) !== evSig(e)) { list[i] = e; updated++; }
  }
  const cutoff = new Date(Date.now() - EV_MAX_AGE_DAYS * 864e5).toISOString().slice(0, 10);
  let kept = list.filter(e => (e.date || '') >= cutoff);
  if (kept.length > EV_MAX) kept = kept.sort((a, b) => (a.date || '').localeCompare(b.date || '')).slice(-EV_MAX);
  return { events: kept, added, updated, skipped };
}
async function eventsPut(events, mode) {
  if (!Array.isArray(events)) return { ok: false, error: 'bad_events' };
  if (events.length > 3000) return { ok: false, error: 'too_many_events' };
  const st = await eventsLoad();
  const m = eventsMerge(st.events, events, mode === 'replace' ? 'replace' : 'merge');
  const r = await eventsSave({ events: m.events });
  if (!r.ok) return r;
  return { ok: true, added: m.added, updated: m.updated, skipped: m.skipped, total: m.events.length };
}

// ════════════════════════════════════════════════════════════
//  v172: ДИКТОВКА — загрузка звука, SpeechKit, модель AI Studio
// ════════════════════════════════════════════════════════════
const S3_HOST = 'storage.yandexcloud.net', S3_REGION = 'ru-central1';
const dictKey = (id, ext) => 'dict/' + id + (ext ? '.' + ext : '.json');
const dictId = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '-' + crypto.randomBytes(3).toString('hex');
// Подписанная ссылка (AWS Signature V4, query string) — PUT для загрузки с телефона, GET для SpeechKit
function presign(method, key, expires, contentType) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const scope = dateStamp + '/' + S3_REGION + '/s3/aws4_request';
  const canonicalUri = '/' + process.env.BUCKET + '/' + encodeURIComponent(key).replace(/%2F/g, '/');
  const enc = v => encodeURIComponent(v).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const q = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': process.env.S3_KEY_ID + '/' + scope, 'X-Amz-Date': amzDate, 'X-Amz-Expires': String(expires || 3600), 'X-Amz-SignedHeaders': 'host' };
  const canonicalQuery = Object.keys(q).sort().map(k => enc(k) + '=' + enc(q[k])).join('&');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, 'host:' + S3_HOST + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let k = hmac('AWS4' + process.env.S3_SECRET, dateStamp); k = hmac(k, S3_REGION); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign, 'utf8').digest('hex');
  return 'https://' + S3_HOST + canonicalUri + '?' + canonicalQuery + '&X-Amz-Signature=' + signature;
}
// та же подпись, но с произвольными хостом/путём/датой — для проверки по эталону AWS в тестах
function presignRaw(method, host, path, region, keyId, secret, amzDate, expires) {
  const dateStamp = amzDate.slice(0, 8), scope = dateStamp + '/' + region + '/s3/aws4_request';
  const enc = v => encodeURIComponent(v).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const q = { 'X-Amz-Algorithm': 'AWS4-HMAC-SHA256', 'X-Amz-Credential': keyId + '/' + scope, 'X-Amz-Date': amzDate, 'X-Amz-Expires': String(expires), 'X-Amz-SignedHeaders': 'host' };
  const canonicalQuery = Object.keys(q).sort().map(k => enc(k) + '=' + enc(q[k])).join('&');
  const canonicalRequest = [method, path, canonicalQuery, 'host:' + host + '\n', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let k = hmac('AWS4' + secret, dateStamp); k = hmac(k, region); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
  return crypto.createHmac('sha256', k).update(stringToSign, 'utf8').digest('hex');
}
function iamOf(event) { // IAM-токен сервисного аккаунта функции — из контекста вызова
  const c = event && event._context; const t = c && c.token && (c.token.access_token || c.token.accessToken);
  if (!t) throw new Error('IAM-токен недоступен: назначьте функции сервисный аккаунт (роли storage.editor, ai.speechkit-stt.user, ai.languageModels.user)');
  return t;
}
function needStorage() { if (!process.env.BUCKET || !process.env.S3_KEY_ID || !process.env.S3_SECRET) throw new Error('Хранилище не настроено: BUCKET / S3_KEY_ID / S3_SECRET'); }
async function jobLoad(id) { const r = await s3Get(dictKey(id)); if (r.status === 404) return null; if (!r.ok) throw new Error('s3 ' + r.status); try { return JSON.parse(await r.text()); } catch (e) { return null; } }
async function jobSave(job) { job.updatedAt = Date.now(); const r = await s3Put(dictKey(job.id), JSON.stringify(job), 'application/json; charset=utf-8'); if (!r.ok) throw new Error('s3 ' + r.status + ' при записи задания'); return job; }
const AUDIO_EXT = { OGG_OPUS: 'ogg', MP3: 'mp3', WAV: 'wav' };
function audioFormatOf(nameOrType) {
  const t = String(nameOrType || '').toLowerCase();
  if (/ogg|opus|webm/.test(t)) return 'OGG_OPUS'; if (/mp3|mpeg/.test(t)) return 'MP3'; if (/wav/.test(t)) return 'WAV'; return 'OGG_OPUS';
}
async function dictUpload(body) {
  needStorage();
  const format = audioFormatOf(body.format || body.contentType || body.name), ext = AUDIO_EXT[format];
  const id = dictId(), key = dictKey(id, ext);
  const job = { id, key, format, name: String(body.name || '').slice(0, 120), status: 'uploading', createdAt: Date.now() };
  await jobSave(job);
  return { ok: true, id, key, url: presign('PUT', key, 3600), format, expiresIn: 3600 };
}
// SpeechKit v3: асинхронное распознавание файла из бакета по подписанной ссылке
async function dictStart(body, event) {
  needStorage(); const iam = iamOf(event);
  const job = await jobLoad(body.id); if (!job) return { ok: false, error: 'job_not_found' };
  if (!process.env.FOLDER_ID) return { ok: false, error: 'не задан FOLDER_ID в переменных функции' };
  const format = AUDIO_EXT[body.format] ? body.format : job.format;
  const req = { uri: presign('GET', job.key, 7200),
    recognitionModel: { model: 'general', audioFormat: { containerAudio: { containerAudioType: format } },
      textNormalization: { textNormalization: 'TEXT_NORMALIZATION_ENABLED', profanityFilter: false, literatureText: true },
      languageRestriction: { restrictionType: 'WHITELIST', languageCode: ['ru-RU'] }, audioProcessingType: 'FULL_DATA' } };
  const r = await fetch('https://stt.api.cloud.yandex.net/stt/v3/recognizeFileAsync', { method: 'POST',
    headers: { Authorization: 'Bearer ' + iam, 'x-folder-id': process.env.FOLDER_ID, 'Content-Type': 'application/json' }, body: JSON.stringify(req) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || !j.id) { job.status = 'error'; job.error = 'SpeechKit: HTTP ' + r.status + ' ' + JSON.stringify(j || {}).slice(0, 200); await jobSave(job); return { ok: false, error: job.error }; }
  job.opId = j.id; job.status = 'recognizing'; job.format = format; job.startedAt = Date.now(); delete job.error; await jobSave(job);
  return { ok: true, id: job.id, opId: j.id };
}
// текст из потока результатов SpeechKit v3 (NDJSON): предпочитаем finalRefinement (нормализованный), иначе final
function sttTextFrom(ndjson) {
  const lines = String(ndjson || '').split(/\n/).map(l => l.trim()).filter(Boolean);
  const chunks = []; let hasRefined = false;
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch (e) { continue; }
    const r = o.result || o;
    if (r.finalRefinement && r.finalRefinement.normalizedText && r.finalRefinement.normalizedText.alternatives) { hasRefined = true; chunks.push({ kind: 'ref', text: (r.finalRefinement.normalizedText.alternatives[0] || {}).text || '' }); }
    else if (r.final && r.final.alternatives) chunks.push({ kind: 'fin', text: (r.final.alternatives[0] || {}).text || '' });
  }
  const use = hasRefined ? chunks.filter(c => c.kind === 'ref') : chunks;
  return use.map(c => c.text.trim()).filter(Boolean).join('\n');
}
async function dictStatus(body, event) {
  needStorage();
  const job = await jobLoad(body.id); if (!job) return { ok: false, error: 'job_not_found' };
  if (job.status === 'done') return { ok: true, id: job.id, done: true, text: job.text || '', clean: job.clean, legal: job.legal, status: job.status };
  if (job.status !== 'recognizing') return { ok: true, id: job.id, done: false, status: job.status, error: job.error };
  const iam = iamOf(event);
  const op = await (await fetch('https://operation.api.cloud.yandex.net/operations/' + encodeURIComponent(job.opId), { headers: { Authorization: 'Bearer ' + iam } })).json().catch(() => null);
  if (!op) return { ok: true, id: job.id, done: false, status: 'recognizing' };
  if (op.error) { job.status = 'error'; job.error = 'SpeechKit: ' + (op.error.message || JSON.stringify(op.error)); await jobSave(job); return { ok: false, error: job.error }; }
  if (!op.done) return { ok: true, id: job.id, done: false, status: 'recognizing' };
  const rr = await fetch('https://stt.api.cloud.yandex.net/stt/v3/getRecognition?operationId=' + encodeURIComponent(job.opId), { headers: { Authorization: 'Bearer ' + iam, 'x-folder-id': process.env.FOLDER_ID || '' } });
  if (!rr.ok) { const t = await rr.text().catch(() => ''); return { ok: false, error: 'SpeechKit результат: HTTP ' + rr.status + ' ' + t.slice(0, 120) }; }
  job.text = sttTextFrom(await rr.text()); job.status = 'done'; job.doneAt = Date.now(); await jobSave(job);
  return { ok: true, id: job.id, done: true, text: job.text, status: 'done' };
}
// ── модель AI Studio: чистка и юридическая стилизация по частям (контекст модели ограничен) ──
const PROMPT_CLEAN = 'Ты редактор расшифровки устной речи адвоката. Приведи текст в грамотную письменную форму, НИЧЕГО не добавляя от себя и не сокращая содержания: убери слова-паразиты (ну, вот, значит, как бы, типа, короче, это самое, в общем, так сказать), самоповторы, оговорки и ложные начала фраз (оставь окончательный вариант, если говорящий поправил себя), расставь знаки препинания и абзацы, числа и даты запиши цифрами. Сохраняй порядок мыслей и все факты, имена, суммы и даты точно. Отвечай только готовым текстом, без пояснений.';
const PROMPT_LEGAL = 'Ты помощник адвоката. Перепиши текст официально-деловым юридическим языком, как для процессуального документа или правового заключения: третье лицо или безличные конструкции, точные формулировки, логичные абзацы; разговорные обороты замени юридическими эквивалентами; где уместно, обозначь роли участников (доверитель, ответчик, суд). НЕ добавляй фактов, оценок и ссылок на нормы, которых нет в исходнике; сохрани все имена, даты и суммы точно. Отвечай только готовым текстом, без пояснений.';
function splitChunks(text, maxChars) { // по абзацам, затем по предложениям
  const out = []; let cur = '';
  for (const p of String(text || '').split(/\n{2,}|\n/)) {
    const parts = p.length > maxChars ? p.split(/(?<=[.!?])\s+/) : [p];
    for (let part of parts) {
      if (part.length > maxChars) { for (let i = 0; i < part.length; i += maxChars) { if (cur) { out.push(cur.trim()); cur = ''; } out.push(part.slice(i, i + maxChars)); } continue; } // без знаков препинания — по длине
      if ((cur + '\n' + part).length > maxChars && cur) { out.push(cur.trim()); cur = part; } else cur = cur ? cur + '\n' + part : part;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
async function llmComplete(system, user, modelUri, iam) {
  const r = await fetch('https://llm.api.cloud.yandex.net/foundationModels/v1/completion', { method: 'POST',
    headers: { Authorization: 'Bearer ' + iam, 'x-folder-id': process.env.FOLDER_ID, 'Content-Type': 'application/json' },
    body: JSON.stringify({ modelUri, completionOptions: { stream: false, temperature: 0.2, maxTokens: '8000' }, messages: [{ role: 'system', text: system }, { role: 'user', text: user }] }) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !j) throw new Error('Модель: HTTP ' + r.status + ' ' + JSON.stringify(j || {}).slice(0, 200));
  const alt = j.result && j.result.alternatives && j.result.alternatives[0];
  return (alt && alt.message && alt.message.text) || '';
}
async function llmRun(text, mode, iam, hint) {
  const folder = process.env.FOLDER_ID;
  const modelUri = mode === 'legal' ? (process.env.LLM_MODEL_URI_LEGAL || 'gpt://' + folder + '/yandexgpt/latest') : (process.env.LLM_MODEL_URI || 'gpt://' + folder + '/yandexgpt-lite/latest');
  const system = (mode === 'legal' ? PROMPT_LEGAL : PROMPT_CLEAN) + (hint ? ' Контекст: ' + String(hint).slice(0, 300) : '');
  const parts = splitChunks(text, 9000), out = [];
  for (let i = 0; i < parts.length; i++) out.push(await llmComplete(system, (parts.length > 1 ? `Часть ${i + 1} из ${parts.length}.\n\n` : '') + parts[i], modelUri, iam));
  return out.join('\n\n');
}
async function dictProcess(body, event) {
  if (!process.env.FOLDER_ID) return { ok: false, error: 'не задан FOLDER_ID в переменных функции' };
  const iam = iamOf(event);
  let job = null, text = String(body.text || '');
  if (body.id) { needStorage(); job = await jobLoad(body.id); if (!job) return { ok: false, error: 'job_not_found' }; text = text || job.text || ''; }
  if (!text.trim()) return { ok: false, error: 'empty_text' };
  if (text.length > 400000) return { ok: false, error: 'text_too_big' };
  const modes = Array.isArray(body.modes) && body.modes.length ? body.modes : ['clean'];
  const out = { ok: true };
  if (modes.includes('clean')) out.clean = await llmRun(text, 'clean', iam, body.hint);
  if (modes.includes('legal')) out.legal = await llmRun(out.clean || text, 'legal', iam, body.hint);
  if (job) { if (out.clean !== undefined) job.clean = out.clean; if (out.legal !== undefined) job.legal = out.legal; await jobSave(job); out.id = job.id; }
  return out;
}
async function dictList() {
  needStorage();
  const r = await s3Get('?list-type=2&prefix=dict/&max-keys=200');
  if (!r.ok) return { ok: false, error: 's3 list ' + r.status };
  const xml = await r.text(); const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]).filter(k => /^dict\/[^/]+\.json$/.test(k));
  const jobs = [];
  for (const k of keys.slice(-50)) { const j = await jobLoad(k.slice(5, -5)); if (j) jobs.push({ id: j.id, name: j.name, status: j.status, createdAt: j.createdAt, hasText: !!j.text, hasClean: !!j.clean, hasLegal: !!j.legal }); }
  return { ok: true, jobs: jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)) };
}
async function dictDelete(body) {
  needStorage(); const job = await jobLoad(body.id); if (!job) return { ok: false, error: 'job_not_found' };
  for (const key of [job.key, dictKey(job.id)]) { if (!key) continue; const r = await s3Delete(key); if (!r.ok && r.status !== 404) return { ok: false, error: 's3 ' + r.status + ' при удалении ' + key }; }
  return { ok: true, id: job.id };
}
async function s3Delete(key) {
  const host = S3_HOST, region = S3_REGION;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const canonicalUri = '/' + process.env.BUCKET + '/' + encodeURIComponent(key).replace(/%2F/g, '/');
  const payloadHash = sha256hex('');
  const sig = sigV4('DELETE', host, canonicalUri, payloadHash, null, amzDate, region, 's3', process.env.S3_KEY_ID, process.env.S3_SECRET);
  return fetch('https://' + host + canonicalUri, { method: 'DELETE', headers: { 'X-Amz-Content-Sha256': payloadHash, 'X-Amz-Date': amzDate, 'Authorization': sig.authorization } });
}

// ════════════════════════════════════════════════════════════
//  v176: ОНЛАЙН-КОПИИ ДОКУМЕНТОВ (шифротекст в бакете)
// ════════════════════════════════════════════════════════════
const BLOB_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const blobKey = id => 'blob-' + process.env.SECRET + '/' + id + '.bin';
const BLOB_MAX = 60 * 1024 * 1024;
async function blobPut(body) {
  needStorage();
  const id = String(body.id || ''); if (!BLOB_ID_RE.test(id)) return { ok: false, error: 'bad_id' };
  const size = Number(body.size || 0); if (size > BLOB_MAX) return { ok: false, error: 'too_big' };
  return { ok: true, id, key: blobKey(id), url: presign('PUT', blobKey(id), 3600), expiresIn: 3600 };
}
async function blobGet(body) {
  needStorage();
  const id = String(body.id || ''); if (!BLOB_ID_RE.test(id)) return { ok: false, error: 'bad_id' };
  return { ok: true, id, url: presign('GET', blobKey(id), 3600), expiresIn: 3600 };
}
async function blobList() {
  needStorage();
  const prefix = 'blob-' + process.env.SECRET + '/';
  const r = await s3Get('?list-type=2&prefix=' + prefix + '&max-keys=1000');
  if (!r.ok) return { ok: false, error: 's3 list ' + r.status };
  const xml = await r.text(); const items = [];
  const re = /<Contents>([\s\S]*?)<\/Contents>/g; let m;
  while ((m = re.exec(xml))) {
    const part = m[1];
    const key = (part.match(/<Key>([^<]+)<\/Key>/) || [])[1] || '';
    const size = Number((part.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0);
    const at = (part.match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1] || '';
    if (!key.startsWith(prefix) || !key.endsWith('.bin')) continue;
    items.push({ id: key.slice(prefix.length, -4), size, at });
  }
  return { ok: true, items, total: items.length, bytes: items.reduce((a, b) => a + b.size, 0) };
}
async function blobDel(body) {
  needStorage();
  const id = String(body.id || ''); if (!BLOB_ID_RE.test(id)) return { ok: false, error: 'bad_id' };
  const r = await s3Delete(blobKey(id));
  if (!r.ok && r.status !== 404) return { ok: false, error: 's3 ' + r.status };
  return { ok: true, id };
}

// ════════════════════════════════════════════════════════════
//  v174: ОНЛАЙН-ЗАПИСЬ НА ПРИЁМ
// ════════════════════════════════════════════════════════════
const PID_RE = /^[a-z0-9]{6,32}$/i;
const bookKey = pid => 'book-' + pid + '.json';
const bookingsKey = () => 'bookings-' + process.env.SECRET + '.json';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ruDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
async function bookLoadPublic(pid) { if (!PID_RE.test(pid)) return null; const r = await s3Get(bookKey(pid)); if (!r.ok) return null; try { return JSON.parse(await r.text()); } catch (e) { return null; } }
async function bookingsLoad() { const r = await s3Get(bookingsKey()); if (r.status === 404) return { items: [] }; if (!r.ok) throw new Error('s3 ' + r.status); try { const j = JSON.parse(await r.text()); return { items: Array.isArray(j.items) ? j.items : [] }; } catch (e) { return { items: [] }; } }
async function bookingsSave(st) { const r = await s3Put(bookingsKey(), JSON.stringify(st), 'application/json; charset=utf-8'); if (!r.ok) throw new Error('s3 ' + r.status + ' при записи заявок'); }
const bookTaken = (items, date, time) => items.some(b => b.date === date && b.time === time && b.status !== 'declined' && b.status !== 'cancelled');
// CRM публикует окна: { publicId, settings:{title, address, phone, durationMin, note, topics:[]}, days:[{date, slots:[…]}] }
async function bookPublish(body) {
  needStorage();
  const pid = String(body.publicId || ''); if (!PID_RE.test(pid)) return { ok: false, error: 'bad_publicId' };
  const settings = Object.assign({ title: 'Запись на консультацию', durationMin: 60 }, body.settings || {});
  const days = (Array.isArray(body.days) ? body.days : []).filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date)).map(d => ({ date: d.date, slots: (d.slots || []).filter(t => /^\d{2}:\d{2}$/.test(t)).slice(0, 48) })).slice(0, 60);
  const r = await s3Put(bookKey(pid), JSON.stringify({ settings, days, updatedAt: Date.now() }), 'application/json; charset=utf-8');
  if (!r.ok) return { ok: false, error: 's3 ' + r.status };
  return { ok: true, publicId: pid, days: days.length, slots: days.reduce((a, d) => a + d.slots.length, 0), url: '?book=' + pid };
}
async function bookGet(body) {
  needStorage(); const st = await bookingsLoad(); const since = Number(body.since) || 0;
  return { ok: true, items: st.items.filter(b => (b.updatedAt || b.createdAt || 0) > since), total: st.items.length };
}
async function bookSet(body) {
  needStorage(); const st = await bookingsLoad(); const b = st.items.find(x => x.id === body.id); if (!b) return { ok: false, error: 'not_found' };
  if (!['new', 'confirmed', 'declined', 'cancelled', 'done'].includes(body.status)) return { ok: false, error: 'bad_status' };
  b.status = body.status; if (body.note !== undefined) b.lawyerNote = String(body.note).slice(0, 300); b.updatedAt = Date.now();
  await bookingsSave(st);
  return { ok: true, item: b };
}
// заявка клиента: окно должно быть опубликовано и не занято; телефон обязателен; защита от роботов — скрытое поле «site»
async function bookRequest(body, event) {
  needStorage();
  const pid = String(body.book || ''); const pub = await bookLoadPublic(pid); if (!pub) return { ok: false, error: 'Страница записи не найдена' };
  if (body.site) return { ok: true, id: 'x', code: '0000' }; // робот заполнил скрытое поле — делаем вид, что приняли
  const date = String(body.date || ''), time = String(body.time || ''), name = String(body.name || '').trim().slice(0, 120), phone = String(body.phone || '').replace(/[^\d+]/g, '').slice(0, 20);
  const topic = String(body.topic || '').trim().slice(0, 120), comment = String(body.comment || '').trim().slice(0, 1000);
  if (!name || phone.replace(/\D/g, '').length < 10) return { ok: false, error: 'Укажите имя и телефон' };
  const day = pub.days.find(d => d.date === date); if (!day || !day.slots.includes(time)) return { ok: false, error: 'Это время недоступно — выберите другое' };
  const st = await bookingsLoad();
  if (bookTaken(st.items, date, time)) return { ok: false, error: 'Это время уже занято — выберите другое' };
  const ip = ((event && event.headers && (event.headers['X-Forwarded-For'] || event.headers['x-forwarded-for'])) || '').split(',')[0].trim();
  const recent = st.items.filter(b => b.ip && b.ip === ip && Date.now() - (b.createdAt || 0) < 3600e3).length; if (recent >= 5) return { ok: false, error: 'Слишком много заявок — попробуйте позже' };
  const id = 'З' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), code = String(1000 + crypto.randomInt(9000));
  const item = { id, code, publicId: pid, date, time, name, phone, topic, comment, status: 'new', createdAt: Date.now(), updatedAt: Date.now(), ip };
  st.items.push(item); await bookingsSave(st);
  await bookNotify(pub, item).catch(() => {});
  return { ok: true, id, code, date, time, status: 'new' };
}
async function bookNotify(pub, b) { // Telegram — если в переменных функции моста заданы TG_TOKEN и TG_CHAT
  if (!process.env.TG_TOKEN || !process.env.TG_CHAT) return;
  const text = `📅 Новая запись на приём\n${ruDate(b.date)} ${b.time} — ${b.name}\n📞 ${b.phone}${b.topic ? '\n' + b.topic : ''}${b.comment ? '\n' + b.comment.slice(0, 200) : ''}\nКод ${b.code}. Подтвердите в CRM.`;
  await fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: process.env.TG_CHAT, text }) });
}
// публичная страница: календарь окон + форма; с параметром code — статус заявки
async function bookPage(q) {
  const pid = String(q.book || ''); const pub = await bookLoadPublic(pid);
  const html = h => ({ statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: h });
  if (!pub) return html(bookShell('Запись', '<p>Страница записи не найдена или ещё не опубликована.</p>'));
  const S = pub.settings || {};
  if (q.code) { const st = await bookingsLoad(); const b = st.items.find(x => x.publicId === pid && x.code === String(q.code)); const label = { new: 'ожидает подтверждения', confirmed: 'подтверждена ✅', declined: 'отклонена — выберите другое время', cancelled: 'отменена', done: 'приём состоялся' };
    return html(bookShell(S.title, b ? `<p><b>Заявка ${esc(b.code)}</b>: ${ruDate(b.date)} в ${esc(b.time)} — ${label[b.status] || b.status}.${b.lawyerNote ? '<br>' + esc(b.lawyerNote) : ''}</p>${S.phone ? `<p>Телефон: <a href="tel:${esc(S.phone)}">${esc(S.phone)}</a></p>` : ''}` : '<p>Заявка с таким кодом не найдена.</p>')); }
  const st = await bookingsLoad();
  const today = new Date().toISOString().slice(0, 10);
  const days = pub.days.filter(d => d.date >= today).map(d => ({ date: d.date, slots: d.slots.filter(t => !bookTaken(st.items, d.date, t)) })).filter(d => d.slots.length);
  const daysHtml = days.length ? days.map(d => { const dt = new Date(d.date + 'T00:00:00'); return `<div class="day"><div class="dh">${ruDate(d.date)} · ${WD[dt.getDay()]}</div><div class="slots">${d.slots.map(t => `<button type="button" class="slot" data-d="${d.date}" data-t="${t}">${t}</button>`).join('')}</div></div>`; }).join('') : '<p>Свободных окон сейчас нет — позвоните или напишите.</p>';
  const topics = Array.isArray(S.topics) && S.topics.length ? `<label>Вопрос<select name="topic"><option value="">— выберите —</option>${S.topics.map(t => `<option>${esc(t)}</option>`).join('')}</select></label>` : `<label>Вопрос (кратко)<input name="topic" maxlength="120"></label>`;
  const body = `${S.note ? `<p class="note">${esc(S.note)}</p>` : ''}${S.address ? `<p class="note">📍 ${esc(S.address)}</p>` : ''}<p>Приём длится ${esc(S.durationMin || 60)} мин. Выберите день и время:</p>${daysHtml}
<form id="f" style="display:none"><div class="pick">Выбрано: <b id="pick"></b></div><label>Ваше имя<input name="name" required maxlength="120"></label><label>Телефон<input name="phone" required inputmode="tel" placeholder="+7 900 000-00-00"></label>${topics}<label>Комментарий<textarea name="comment" rows="3" maxlength="1000"></textarea></label><input name="site" style="display:none" tabindex="-1" autocomplete="off"><button type="submit" class="go">Записаться</button><p class="fine">Нажимая «Записаться», вы соглашаетесь на обработку имени и телефона для связи по записи.</p></form><div id="out"></div>
<script>(function(){var d='',t='';var f=document.getElementById('f'),out=document.getElementById('out');document.querySelectorAll('.slot').forEach(function(b){b.onclick=function(){document.querySelectorAll('.slot').forEach(function(x){x.classList.remove('on')});b.classList.add('on');d=b.dataset.d;t=b.dataset.t;document.getElementById('pick').textContent=b.closest('.day').querySelector('.dh').textContent+' '+t;f.style.display='block';f.scrollIntoView({behavior:'smooth'});};});
f.onsubmit=function(e){e.preventDefault();var fd=new FormData(f);var body={book:${JSON.stringify(pid)},action:'bookreq',date:d,time:t};fd.forEach(function(v,k){body[k]=v;});var btn=f.querySelector('.go');btn.disabled=true;btn.textContent='Отправляю…';
fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(j){if(j.ok){f.style.display='none';out.innerHTML='<div class="ok">Заявка принята: '+j.date.split('-').reverse().join('.')+' в '+j.time+'.<br>Код заявки <b>'+j.code+'</b> — по нему можно проверить статус: <a href="?book=${pid}&code='+j.code+'">открыть</a>.<br>Приём состоится после подтверждения; при изменениях с вами свяжутся по телефону.</div>';}else{out.innerHTML='<div class="err">'+(j.error||'Ошибка')+'</div>';btn.disabled=false;btn.textContent='Записаться';}}).catch(function(){out.innerHTML='<div class="err">Нет связи — попробуйте ещё раз</div>';btn.disabled=false;btn.textContent='Записаться';});};})();</script>`;
  return html(bookShell(S.title, body));
}
function bookShell(title, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title || 'Запись на приём')}</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f5f6fa;color:#1a1d2b}.wrap{max-width:560px;margin:0 auto;padding:20px 16px 40px}h1{font-size:22px;margin:8px 0 12px}.note{color:#555;margin:4px 0}.day{background:#fff;border:1px solid #e3e5ee;border-radius:12px;padding:10px 12px;margin:10px 0}.dh{font-weight:600;margin-bottom:6px}.slots{display:flex;flex-wrap:wrap;gap:6px}.slot{border:1px solid #c9cde0;background:#fff;border-radius:8px;padding:8px 12px;font-size:15px}.slot.on{background:#4f46e5;color:#fff;border-color:#4f46e5}
form{background:#fff;border:1px solid #e3e5ee;border-radius:12px;padding:12px;margin-top:14px}label{display:block;margin:8px 0 4px;font-size:14px;color:#444}input,select,textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid #c9cde0;border-radius:8px;font-size:16px;font-family:inherit}.go{margin-top:12px;width:100%;padding:12px;border:0;border-radius:10px;background:#4f46e5;color:#fff;font-size:16px}.fine{font-size:12px;color:#777}.pick{margin-bottom:6px}.ok{background:#e8f7ee;border:1px solid #9ad4b0;border-radius:12px;padding:12px;margin-top:12px}.err{background:#fdecec;border:1px solid #f0a0a0;border-radius:12px;padding:12px;margin-top:12px}
</style></head><body><div class="wrap"><h1>${esc(title || 'Запись на приём')}</h1>${body}</div></body></html>`;
}

// Экспорт внутренностей для автотестов (на работу функции не влияет)
module.exports._test = { pick, pickAfter, sigV4, sha256hex, eventsMerge, evNormalize, bearerOf, presign, presignRaw, sttTextFrom, splitChunks, audioFormatOf, bookTaken, bookShell, blobKey };
