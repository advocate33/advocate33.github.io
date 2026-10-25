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
//  v179: запись базы быстрее — независимые операции с хранилищем идут одновременно (при небольшом таймауте функции 178
//  не успевал: «сервер не ответил»); порядок, от которого зависит сохранность, прежний.
//  v197: напоминания — отметка прежнего сервера (дата) не скрывает изменённое напоминание (аудит сборки 201, R9)
//  v196: напоминания — отметка версии и резерв отправки (аудит сборки 198, N6)
//  v195: списки хранилища — целиком по страницам (файлы документов, изменения базы, история снимков; аудит сборки 194, 6.7)
//  v194: напоминания — remindput и таймер пишут файл условно по ETag и повторяют при изменении (аудит сборки 194, R4)
//  v193: событие суда сохраняет proceedingId (id рассмотрения дела от коллектора 3.24+) и сравнивается с ним (аудит сборки 169, А1)
//  v192: аудит 14.10.2026 — пределы форм по адресу платформы, ответы в пределах функции, код не в журнал, напоминания до 4096 знаков
//  v191: icalget — закрытая ссылка календаря Google или Apple: события окна дат для «Быстрых записей» программы (этап 6 плана по ЮрТопосу)
//  v190: «Задать вопрос» — публичная страница ?ask=<страница> и приём вопросов без секрета; askpub/askget/askack для программы
//  (план по ЮрТопосу 13.10.2026, этап 4)
//  v189: согласие на обработку ПД на странице записи — отдельный текст, флажок, время и редакция в заявке; уведомление о заявке без имён;
//  число просроченных задач в утренней сводке (план по ЮрТопосу 13.10.2026, этап 1)
//  v188: события — одна запись под замком для доставки и очистки (eventsclear), файл событий пишется условно по ETag (аудит 13.10.2026)
//  v187: лента календаря по ссылке самой функции — GET ?cal=<метка>; метка — HMAC от SECRET, кода сервера в ссылке нет (А1)
//  v186: изменения базы между версиями — устройство берёт только их (deltaget), а не весь снимок; разрыв цепочки — снимок целиком
//  (план переноса 11.10.2026, Д6, этап 1)
//  v185: условная запись (If-Match / If-None-Match): отметка «принято» базы и файл заявок онлайн-записи не перезаписываются поверх
//  чужой записи, номер версии занимается меткой; прежнее имя файла базы — после отметки (план переноса 11.10.2026, Д5)
//  v184: события — под замком, повреждённый файл событий сохраняется копией; замок записи базы перепроверяется перед записью (аудит 11.10.2026)
//  v183: запись базы (dbput, snapcommit) без baseVer отклоняется — устаревший снимок не ляжет поверх нового (разбор GPT 06.10.2026, п. 8)
//  v178: ЗАПИСЬ БАЗЫ С ПРОВЕРКОЙ ВЕРСИИ (baseVer → «conflict»), запись «всё или ничего» (файл версии — отметка «принято»),
//  история снимков dbhist-<SECRET>/<версия>.crypt (5 последних + по одному за день на 14 дней; dbhistlist, dbhistget),
//  отказ при пустом SECRET, сравнение кода без утечки по времени.
//  v177: НАПОМИНАНИЯ С СЕРВЕРА. CRM кладёт список ближайших сроков и заседаний (remindput → remind-<SECRET>.json,
//  открыто: даты, номера дел, названия сроков — без ФИО), а таймер Облака раз в день вызывает функцию без параметров
//  (или remindtick с секретом): всё, что наступает сегодня или завтра и ещё не отправлялось, уходит в Telegram
//  (TG_TOKEN, TG_CHAT). Напоминание приходит, даже если программа не открывалась.
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
// v178: проверка секретного кода. В v177 сравнение `a !== b` при незаданной переменной SECRET пропускало запрос вовсе без
// кода (undefined === undefined). Теперь: SECRET обязан быть задан, код обязан быть непустой строкой; сравнение — по
// SHA-256 через timingSafeEqual, чтобы время ответа не подсказывало, сколько знаков совпало.
// v178: имена файлов в бакете — от STORE_ID, если он задан, иначе от SECRET (как раньше). Так секретный код можно сменить,
// не переименовывая файлы базы, календаря, событий и вложений: STORE_ID = прежний код (метка), SECRET = новый.
const storeId = () => process.env.STORE_ID || process.env.SECRET;
function secretOk(given) {
  const s = process.env.SECRET;
  if (typeof s !== 'string' || !s.length || typeof given !== 'string' || !given.length) return false;
  const a = crypto.createHash('sha256').update(given, 'utf8').digest(), b = crypto.createHash('sha256').update(s, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}
// v192: секретный код (и имена файлов от него, если STORE_ID не задан) не попадает в журнал функции и в ответы без кода
function scrub(x) { let t = String(x == null ? '' : x); for (const v of [process.env.SECRET, process.env.STORE_ID]) if (typeof v === 'string' && v.length >= 4) t = t.split(v).join('…'); return t; }
// v192: адрес клиента для пределов публичных форм — тот, что видит платформа. В X-Forwarded-For первые адреса может прислать сам клиент,
// настоящий платформа дописывает последним; без заголовка — общий предел для всех «без адреса», а не отсутствие предела
function clientIp(event) {
  const rc = event && event.requestContext && event.requestContext.identity && event.requestContext.identity.sourceIp;
  if (rc) return String(rc).slice(0, 64);
  const h = (event && event.headers) || {}, parts = String(h['X-Forwarded-For'] || h['x-forwarded-for'] || '').split(',').map(x => x.trim()).filter(Boolean);
  return (parts.length ? parts[parts.length - 1] : 'нет-адреса').slice(0, 64);
}
// v192: ответ в пределах функции (3 670 016 байт — раздел 0а правил): считается в байтах тела JSON
const RESP_MAX = 3000000;
const jsonBytes = x => Buffer.byteLength(JSON.stringify(x), 'utf8');
function fitList(list, base) { const out = []; let n = jsonBytes(base || {}) + 32; for (const x of list || []) { const b = jsonBytes(x) + 1; if (n + b > RESP_MAX) break; out.push(x); n += b; } return { items: out, cut: (list || []).length - out.length }; }
function fitReply(r) { return r && jsonBytes(r) > 3600000 ? { ok: false, error: 'too_big', note: 'снимок больше предела ответа функции — новая версия программы берёт его по ссылке (snapget); прежней программе — копия базы через файл' } : r; }
// v192: Telegram — с пределом ожидания: медленный ответ не держит функцию и не превращает принятую заявку в «Нет связи» у клиента
async function tgSend(text, ms) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms || 8000);
  try { return await fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: process.env.TG_CHAT, text }), signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}
// v192: вызов без HTTP — только похожий на сообщение таймера (у каждого сообщения — event_metadata; тип, если указан, — таймер)
function timerEventOk(e) {
  return !!e && Array.isArray(e.messages) && e.messages.length > 0 && e.messages.every(m => m && typeof m === 'object' && m.event_metadata && typeof m.event_metadata === 'object' && (!m.event_metadata.event_type || /TimerMessage$/.test(String(m.event_metadata.event_type))));
}

module.exports.handler = async function (event, context) {
  if (event && context) event._context = context; // v172: IAM-токен сервисного аккаунта
  const method = (event.httpMethod || 'GET').toUpperCase();
  if (method === 'OPTIONS') return { statusCode: 204, headers: JSON_HEADERS, body: '' };
  if (!event.httpMethod && event.messages) { if (!timerEventOk(event)) return reply({ ok: false, error: 'forbidden' }, 403); try { return reply(await remindTick()); } catch (e) { return reply({ ok: false, error: String(e && e.message || e) }, 500); } } // v177: вызов таймером

  const q0 = event.queryStringParameters || {};
  // v187: лента календаря для подписки (Google, Яндекс, телефон) — без секрета, по метке; только чтение готового файла
  if (q0.cal !== undefined) {
    try { return method === 'GET' || method === 'HEAD' ? await calServe(String(q0.cal), method === 'HEAD') : reply({ ok: false, error: 'method' }, 405); }
    catch (err) { return { statusCode: 500, headers: CAL_TEXT, body: 'Ошибка: ' + scrub(err && err.message || err) }; }
  }
  if (q0.ask) { // v190: публичная страница «Задать вопрос» (без секрета)
    try { return method === 'GET' ? await askPage(q0) : reply({ ok: false, error: 'method' }, 405); }
    catch (err) { return { statusCode: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Ошибка: ' + scrub(err && err.message || err) }; }
  }
  if (q0.book) { // v174: публичная страница записи (без секрета)
    try { return method === 'GET' ? await bookPage(q0) : reply({ ok: false, error: 'method' }, 405); }
    catch (err) { return { statusCode: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'Ошибка: ' + scrub(err && err.message || err) }; }
  }
  if (method === 'GET') {
    // v171: CRM забирает события GET-запросом с Bearer-токеном (или ?secret=… для разовой отладки)
    const bearer = bearerOf(event);
    const q = event.queryStringParameters || {};
    if (secretOk(bearer) || secretOk(q.secret)) { // v178
      try {
        const st = await eventsLoad();
        // v192: последние события, что помещаются в ответ функции (массив — формат, который понимает crmMonRows)
        return reply(fitList(st.events.slice().reverse()).items.reverse());
      } catch (err) { return reply({ ok: false, error: String(err && err.message || err) }, 500); }
    }
    if (bearer || q.secret) return reply({ ok: false, error: 'auth' }, 403);
    return reply({
      ok: true, service: 'CRM Адвоката — личный сервер', module: 'lichny-server', ver: 197,
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

  if (body && body.action === 'askreq') { try { return reply(await askRequest(body, event)); } catch (err) { return reply({ ok: false, error: scrub(err && err.message || err) }); } } // v190: вопрос с сайта, без секрета
  if (body && body.action === 'bookreq') { try { return reply(await bookRequest(body, event)); } catch (err) { return reply({ ok: false, error: scrub(err && err.message || err) }); } } // v174: заявка клиента, без секрета
  // v178: без переменной SECRET сервер не работает вовсе — и говорит об этом словами
  if (!process.env.SECRET) return reply({ ok: false, error: 'сервер не настроен: не задана переменная SECRET функции' });
  if (!body || !secretOk(body.secret)) return reply({ ok: false, error: 'auth' });

  try {
    if (body.action === 'ping')  return reply({ ok: true, ready: readiness(), ver: 197, cal: true, ask: true, ical: true });
    if (body.action === 'track') return reply(await trackBarcodes(body.barcodes || []));
    if (body.action === 'ics')   return reply(await publishIcs(body.ics));
    if (body.action === 'calcheck') return reply(await calCheck());
    if (body.action === 'dbput')  return reply(await dbPutLocked(body.data, body.baseVer)); // v178: baseVer; v180: под замком
    if (body.action === 'snapput')    return reply(await snapPut(body));    // v180: снимок напрямую в хранилище
    if (body.action === 'snapcommit') return reply(await snapCommit(body));
    if (body.action === 'snapget')    return reply(await snapGet(body));
    if (body.action === 'deltaget')   return reply(await deltaGet(body));   // v186: цепочка изменений с версии since
    if (body.action === 'corscheck')  return reply(await corsCheck());   // v181
    if (body.action === 'dbhistlist') return reply(await dbHistList()); // v178
    // v192: снимок сверх предела ответа функции — отказ словами (dbget, dbhistget)
    if (body.action === 'dbhistget')  return reply(fitReply(await dbHistGet(body.ver))); // v178
    if (body.action === 'dbget')  return reply(fitReply(await dbGet()));
    if (body.action === 'dbver')  { const v = await dbVer(); return reply(v.ok ? { ok: true, ver: v.ver } : v); } // v185: ETag — внутреннее
    if (body.action === 'eventsput')   return reply(await eventsPut(body.events, body.mode));   // v171
    if (body.action === 'eventsget')   { const st = await eventsLoad(); if (st.corrupt) return reply({ ok: false, error: 'events_corrupt', note: 'файл событий на сервере повреждён — следующая доставка коллектора сохранит его копию и начнёт новый' }); const f = fitList(st.events.slice().reverse(), { ok: true, cut: 0 }); return reply({ ok: true, events: f.items.reverse(), cut: f.cut }); }
    // v188: очистка — тем же путём, что доставка: под замком событий, с условной записью
    if (body.action === 'eventsclear') return reply(await eventsPut([], 'replace'));
    if (body.action === 'dict_upload')  return reply(await dictUpload(body));   // v172
    if (body.action === 'dict_start')   return reply(await dictStart(body, event));
    if (body.action === 'dict_status')  return reply(await dictStatus(body, event));
    if (body.action === 'dict_process') return reply(await dictProcess(body, event));
    if (body.action === 'dict_list')    return reply(await dictList());
    if (body.action === 'dict_delete')  return reply(await dictDelete(body));
    if (body.action === 'bookpub')  return reply(await bookPublish(body));   // v174
    if (body.action === 'bookget')  return reply(await bookGet(body));
    if (body.action === 'bookset')  return reply(await bookSet(body));
    if (body.action === 'askpub')   return reply(await askPublish(body));   // v190
    if (body.action === 'askget')   return reply(await askGet());
    if (body.action === 'askack')   return reply(await askAck(body));
    if (body.action === 'icalget')  return reply(await icalGet(body));       // v191
    if (body.action === 'remindput') return reply(await remindPut(body)); // v177
    if (body.action === 'remindtick') return reply(await remindTick());
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
    storage: !!(process.env.BUCKET && process.env.S3_KEY_ID && process.env.S3_SECRET),
    secret: !!process.env.SECRET,
    storeId: !!process.env.STORE_ID
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
// ── v187: отдача ленты по ссылке функции ──
// Метка = первые 32 знака base64url от HMAC-SHA256(SECRET, «crm-cal-feed-v1»). Программа считает ту же метку (WebCrypto) и
// показывает адрес «<адрес сервера>?cal=<метка>». Сравнение — по SHA-256 через timingSafeEqual, как у секретного кода.
const CAL_LABEL = 'crm-cal-feed-v1';
const CAL_TEXT = { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
function calToken() {
  const s = process.env.SECRET;
  if (typeof s !== 'string' || !s.length) return '';
  return crypto.createHmac('sha256', s).update(CAL_LABEL, 'utf8').digest('base64url').slice(0, 32);
}
function calTokenOk(given) {
  const t = calToken();
  if (!t || typeof given !== 'string' || !given.length) return false;
  const a = crypto.createHash('sha256').update(given, 'utf8').digest(), b = crypto.createHash('sha256').update(t, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}
async function calServe(token, head) {
  if (!calTokenOk(token)) return { statusCode: 403, headers: CAL_TEXT, body: 'Неверная ссылка на ленту календаря. Возьмите адрес заново в программе: «Настройки» -> «Лента календаря». Ссылка меняется при смене секретного кода сервера.' };
  if (!process.env.BUCKET || !process.env.S3_KEY_ID || !process.env.S3_SECRET) return { statusCode: 503, headers: CAL_TEXT, body: 'Хранилище сервера не настроено: нет переменных BUCKET / S3_KEY_ID / S3_SECRET у функции.' };
  const r = await s3Get('cal-' + storeId() + '.ics');
  if (r.status === 404) return { statusCode: 404, headers: CAL_TEXT, body: 'Лента ещё не опубликована: включите её в программе («Настройки» -> «Лента календаря») и нажмите «Опубликовать сейчас».' };
  // v192: при сбое — код ошибки хранилища без его текста (в тексте имя файла, а в нём код сервера)
  if (!r.ok) { const t = await r.text().catch(() => ''), code = (t.match(/<Code>([A-Za-z]{1,60})<\/Code>/) || [])[1] || ''; return { statusCode: 502, headers: CAL_TEXT, body: 'Хранилище ответило ' + r.status + (code ? ' (' + code + ')' : '') + '. Повторите позже.' }; }
  const txt = await r.text();
  return { statusCode: 200, headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store', 'Content-Disposition': 'inline; filename="crm-calendar.ics"' }, body: head ? '' : txt };
}
async function publishIcs(ics) {
  if (typeof ics !== 'string' || !ics.startsWith('BEGIN:VCALENDAR')) {
    return { ok: false, error: 'bad_ics' };
  }
  if (ics.length > 400000) return { ok: false, error: 'ics_too_big' };
  if (!process.env.BUCKET || !process.env.S3_KEY_ID || !process.env.S3_SECRET) {
    return { ok: false, error: 'Хранилище не настроено: BUCKET / S3_KEY_ID / S3_SECRET' };
  }
  const key = 'cal-' + storeId() + '.ics';
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

// v195 (аудит сборки 194, 6.7): список объектов с префиксом — целиком, по страницам ListObjectsV2 (IsTruncated, NextContinuationToken).
// Ответ — как у s3Get одной страницы ({ ok, status, text() }), text() — склеенные <Contents> всех страниц. Страница не прочиталась, ответ
// без признака окончания или объектов больше maxObjects — { ok:false }: вызывающий не должен принимать неполный список за полный.
async function s3ListAll(prefix, maxObjects) {
  const limit = maxObjects || 100000; let token = '', parts = [], n = 0;
  for (let page = 0; page < 1000; page++) {
    const r = await s3Get('?list-type=2&prefix=' + prefix + '&max-keys=1000' + (token ? '&continuation-token=' + encodeURIComponent(token) : ''));
    if (!r.ok) return { ok: false, status: r.status, text: async () => '' };
    const xml = await r.text(), items = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
    parts.push(items.join('')); n += items.length;
    if (n > limit) return { ok: false, status: 507, text: async () => '' };
    const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml), next = (xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/) || [])[1] || '';
    if (!truncated) return { ok: true, status: 200, count: n, text: async () => '<ListBucketResult>' + parts.join('') + '</ListBucketResult>' };
    if (!next || next === token) return { ok: false, status: 502, text: async () => '' };
    token = next.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  }
  return { ok: false, status: 508, text: async () => '' };
}
// Диагностика ленты: сервер сам читает свой объект и считает события
async function calCheck() {
  if (!process.env.BUCKET || !process.env.S3_KEY_ID || !process.env.S3_SECRET) {
    return { ok: false, error: 'Хранилище не настроено: BUCKET / S3_KEY_ID / S3_SECRET' };
  }
  const key = 'cal-' + storeId() + '.ics';
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
function dbKey()    { return 'db-'    + storeId() + '.crypt'; }
function dbVerKey() { return 'dbver-' + storeId() + '.txt'; }

// v178: история снимков. Каждый принятый снимок лежит под именем своей версии; файл версии (dbver-…) пишется последним и
// означает «принято». Хранятся 5 последних и по одному (самому позднему) за каждый из 14 последних дней с записями.
function dbHistPrefix() { return 'dbhist-' + storeId() + '/'; }
function dbHistKey(ver) { return dbHistPrefix() + String(ver) + '.crypt'; }
const DB_HIST_LAST = 5, DB_HIST_DAYS = 14;
async function dbHistList() {
  const prefix = dbHistPrefix();
  // v195: список целиком (s3ListAll)
  const r = await s3ListAll(prefix);
  if (!r.ok) return { ok: false, error: 's3 list ' + r.status };
  const xml = await r.text(); const items = []; const re = /<Contents>([\s\S]*?)<\/Contents>/g; let m;
  while ((m = re.exec(xml))) {
    const part = m[1]; const key = (part.match(/<Key>([^<]+)<\/Key>/) || [])[1] || '';
    if (!key.startsWith(prefix) || !key.endsWith('.crypt')) continue;
    const ver = Number(key.slice(prefix.length, -6)); if (!ver) continue;
    items.push({ ver, bytes: Number((part.match(/<Size>(\d+)<\/Size>/) || [])[1] || 0), at: new Date(ver).toISOString() });
  }
  items.sort((a, b) => b.ver - a.ver);
  return { ok: true, items };
}
async function dbHistGet(ver) {
  ver = Number(ver); if (!ver || ver < 0 || !Number.isFinite(ver)) return { ok: false, error: 'bad_ver' };
  const r = await s3Get(dbHistKey(Math.floor(ver)));
  if (r.status === 404) return { ok: true, exists: false };
  if (!r.ok) return { ok: false, error: 's3 ' + r.status };
  return { ok: true, exists: true, data: await r.text(), ver: Math.floor(ver) };
}
// какие версии оставить: последние DB_HIST_LAST и самую позднюю за каждый из DB_HIST_DAYS последних дней (по Москве)
function dbHistKeep(vers, current) {
  const sorted = vers.slice().sort((a, b) => b - a), keep = new Set(sorted.slice(0, DB_HIST_LAST)); keep.add(current);
  const days = new Set();
  for (const v of sorted) { const day = new Date(v + 3 * 3600000).toISOString().slice(0, 10); if (days.has(day)) continue; if (days.size >= DB_HIST_DAYS) break; days.add(day); keep.add(v); }
  return keep;
}

// v183: запись без номера исходной версии отклоняется — иначе устаревший снимок мог лечь поверх более нового
function needBaseVer(baseVer, curVer) {
  if (baseVer === undefined || baseVer === null || baseVer === '' || !Number.isFinite(Number(baseVer))) {
    return { ok: false, code: 'need_base_ver', ver: curVer, error: 'запись без номера версии базы отклонена: обновите программу до версии 312 или новее (на этом устройстве она только читает базу)' };
  }
  return null;
}
async function dbPut(data, baseVer, guard) {
  if (typeof data !== 'string' || !data.length) return { ok: false, error: 'bad_data' };
  if (data.length > 3500000) return { ok: false, error: 'db_too_big' };
  if (!process.env.BUCKET || !process.env.S3_KEY_ID || !process.env.S3_SECRET) {
    return { ok: false, error: 'Хранилище не настроено: BUCKET / S3_KEY_ID / S3_SECRET' };
  }
  // v178: вслепую не пишем — сначала версия на сервере. v179: версия и список истории читаются одновременно
  const [cur, hist] = await Promise.all([dbVer(), dbHistList().catch(() => null)]);
  if (!cur.ok) return { ok: false, error: 'версия базы на сервере не прочитана (' + cur.error + ') — запись отменена' };
  // устройство сообщает версию, от которой шло; на сервере уже другая — отказ, устройство сначала объединяет и повторяет.
  // v183: без номера версии запись не принимается (прежняя программа присылает его с v312; более старая — только чтение)
  const nb = needBaseVer(baseVer, cur.ver); if (nb) return nb;
  if (Number(baseVer) !== cur.ver) return { ok: false, error: 'conflict', ver: cur.ver };
  const have = hist && hist.ok ? hist.items.map(x => x.ver) : null;
  const CT = 'text/plain; charset=utf-8', bad = async (what, r) => { const t = await r.text().catch(() => ''); return { ok: false, error: 's3 ' + what + r.status + ' ' + t.slice(0, 120) }; };
  // v184: замок перепроверяется перед первой записью и перед отметкой «принято»
  const LOST = { ok: false, error: 'lock_lost', note: 'запись шла дольше срока замка — отменена, повторите отправку' };
  // v185: номер версии занимается условной записью метки — снимок истории под этим номером пишет только этот писатель; метка
  // занимается одновременно с перепроверкой замка (замок не наш — метка снимается)
  const [held, claim] = await Promise.all([guard ? guard() : true, dbClaimVer(Math.max(Date.now(), cur.ver + 1))]);
  if (!claim.ok) return claim;
  const ver = claim.ver, dropMine = () => Promise.all([s3Delete(dbHistKey(ver)).catch(() => {}), s3Delete(dbClaimKey(ver)).catch(() => {})]);
  if (!held) { await dropMine(); return LOST; }
  // снимок, сделанный сервером 177 (в истории его нет), сохраняется ДО перезаписи прежнего файла
  if (have && cur.ver && !have.includes(cur.ver)) {
    const old = await s3Get(dbKey());
    if (old.ok) { const rp = await s3Put(dbHistKey(cur.ver), await old.text(), CT); if (rp.ok) have.push(cur.ver); }
  }
  const r0 = await s3Put(dbHistKey(ver), data, CT);
  if (!r0.ok) { await dropMine(); return bad('hist ', r0); }
  // отметка «принято» — последней и условной (v185)
  if (guard && !(await guard())) { await dropMine(); return LOST; }
  const cm = await dbCommitVer(cur, ver);
  if (!cm.ok) { await dropMine(); return cm; }
  // принято. Прежнее имя файла (для отката на сервер 177) — после отметки: проигравший условие его не трогает. Уборка лишних снимков
  // и метки — одновременно; запись уже принята, поэтому уборка не ждётся дольше 2 секунд
  let pruned = 0, legacy = true;
  try {
    const jobs = [s3Put(dbKey(), data, CT).then(r1 => { if (!r1.ok) { legacy = false; console.log('db legacy copy: s3 ' + r1.status); } }).catch(e => { legacy = false; console.log('db legacy copy: ' + (e && e.message || e)); }),
      s3Delete(dbClaimKey(ver)).catch(() => {})];
    if (have) { const all = have.concat([ver]), keep = dbHistKeep(all, ver); all.filter(v => !keep.has(v)).forEach(v => jobs.push(s3Delete(dbHistKey(v)).then(rd => { if (rd.ok || rd.status === 404) pruned++; }).catch(() => {}))); }
    await Promise.race([Promise.all(jobs), new Promise(res => setTimeout(res, 2000))]);
  } catch (e) { console.log('dbhist prune: ' + (e && e.message || e)); }
  return { ok: true, ver, pruned, cond: cm.cond, ...(legacy ? {} : { legacy: false }) };
}

async function dbVer() {
  const r = await s3Get(dbVerKey());
  if (r.status === 404) return { ok: true, ver: 0, exists: false, etag: '' };
  if (!r.ok) return { ok: false, error: 's3 ' + r.status };
  const t = await r.text();
  // v185: ETag прочитанного файла версии — условие для отметки «принято» (запись пройдёт, только если файл с тех пор не менялся)
  return { ok: true, ver: Number(String(t).trim()) || 0, exists: true, etag: (r.headers && r.headers.get && r.headers.get('etag')) || '' };
}

async function dbGet() {
  const v = await dbVer();
  if (!v.ok) return { ok: false, error: v.error };
  // v178: отдаётся принятый снимок — тот, на который указывает файл версии; для базы, записанной сервером 177, — прежний файл
  if (v.ver) {
    const h = await s3Get(dbHistKey(v.ver));
    if (h.ok) return { ok: true, exists: true, data: await h.text(), ver: v.ver };
    if (h.status !== 404) return { ok: false, error: 's3 ' + h.status };
  }
  const r = await s3Get(dbKey());
  if (r.status === 404) return { ok: true, exists: false };
  if (!r.ok) { const t = await r.text().catch(()=> ''); return { ok:false, error:'s3 '+r.status+' '+t.slice(0,120) }; }
  const data = await r.text();
  return { ok: true, exists: true, data, ver: v.ver };
}

// ════════════════════════════════════════════════════════════
//  v171: СОБЫТИЯ МОНИТОРИНГА — приём от коллектора судов, выдача в CRM.
//  Объект events-<SECRET>.json: { events:[…], updatedAt }.
//  Слияние по source+externalId: изменившееся событие (title/date/raw) обновляется,
//  повторное — не дублируется. Лимиты: 5000 событий, старше 400 дней отбрасываются.
// ════════════════════════════════════════════════════════════
function eventsKey() { return 'events-' + storeId() + '.json'; }
const EV_MAX = 5000, EV_MAX_AGE_DAYS = 400;
// v193: proceedingId — id рассмотрения дела, с чьей ссылки собрано событие (коллектор 3.24+)
const EV_FIELDS = ['externalId', 'title', 'date', 'eventType', 'courtNo', 'caseUid', 'judge', 'source', 'raw', 'crmNumber', 'court', 'proceedingId']; // v173: crmNumber; v175: court — суд страницы (коллектор v3.11)

function evNormalize(e) { // только известные поля, строки, разумной длины
  if (!e || typeof e !== 'object') return null;
  const out = {};
  // v192: карточка суда (JSON в raw) — до 16 000 знаков: обрезанный JSON не применялся
  for (const f of EV_FIELDS) { const v = e[f]; if (v !== undefined && v !== null) { const t = String(v); out[f] = t.slice(0, f === 'raw' ? (/^\s*\{/.test(t) ? 16000 : 4000) : 400); } }
  if (!out.externalId || !out.date) return null;
  // v193: id рассмотрения — только вид id программы; чужое значение отбрасывается, событие принимается без него
  if (out.proceedingId !== undefined && !/^[A-Za-z0-9_-]{1,80}$/.test(out.proceedingId)) delete out.proceedingId;
  out.eventType = out.eventType || 'notice';
  out.source = out.source || 'Коллектор судов';
  return out;
}
const evId = e => (e.source || '') + '|' + e.externalId;
// v193: id рассмотрения входит в сравнение — повтор события с добавленным id обновляет запись
const evSig = e => [e.title, e.date, e.eventType, e.courtNo, e.caseUid, e.judge, e.raw, e.proceedingId].map(x => x || '').join('\u0001');

async function eventsLoad() {
  if (!process.env.BUCKET || !process.env.S3_KEY_ID || !process.env.S3_SECRET) {
    throw new Error('Хранилище не настроено: BUCKET / S3_KEY_ID / S3_SECRET');
  }
  const r = await s3Get(eventsKey());
  if (r.status === 404) return { events: [], updatedAt: 0, exists: false, etag: '' };
  if (!r.ok) { const t = await r.text().catch(() => ''); throw new Error('s3 ' + r.status + ' ' + t.slice(0, 120)); }
  // v184: повреждённый файл — не пустой список (иначе следующая запись затёрла бы его); вызывающий решает, что делать
  // v188: ETag прочитанного файла — условие записи (eventsSave)
  const text = await r.text(), etag = (r.headers && r.headers.get && r.headers.get('etag')) || '';
  try { const j = JSON.parse(text); return { events: Array.isArray(j.events) ? j.events : [], updatedAt: j.updatedAt || 0, exists: true, etag }; }
  catch (e) { return { events: [], updatedAt: 0, corrupt: true, text, exists: true, etag }; }
}
// v188: cur — прочитанный файл (eventsLoad): запись только если файл с тех пор не менялся (If-Match) или его не было (If-None-Match: *);
// файл изменился — { ok:false, error:'changed' }, вызывающий перечитывает. Без cur — запись без условия (как до 188).
async function eventsSave(st, cur) {
  st.updatedAt = Date.now();
  const body = JSON.stringify(st), CT = 'application/json; charset=utf-8';
  const cond = cur ? (cur.exists ? (cur.etag ? { 'If-Match': cur.etag } : null) : { 'If-None-Match': '*' }) : null;
  let r = cond ? await s3PutIf(eventsKey(), body, CT, cond) : await s3Put(eventsKey(), body, CT);
  if (cond && condFailed(r)) return { ok: false, error: 'changed' };
  if (cond && condUnsupported(r)) { console.log('events: условная запись не поддерживается (501) — запись без условия'); r = await s3Put(eventsKey(), body, CT); }
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
// v184: объединение и запись событий — под своим замком; занято — повтор через случайную паузу, не дольше EV_LOCK_WAIT
const EV_LOCK_WAIT = 8000;
async function eventsPut(events, mode) {
  if (!Array.isArray(events)) return { ok: false, error: 'bad_events' };
  if (events.length > 3000) return { ok: false, error: 'too_many_events' };
  const until = Date.now() + EV_LOCK_WAIT; let lock = null;
  for (;;) {
    lock = await lockAcquire(evLockPrefix());
    if (lock.ok) break;
    if (lock.error !== 'busy') return lock;
    if (Date.now() >= until) return { ok: false, error: 'busy', note: 'события сейчас записывает другой запрос — повторите позже' };
    await new Promise(res => setTimeout(res, 200 + Math.floor(Math.random() * 500)));
  }
  try {
    let saved = '';
    // v188: файл изменился между чтением и записью (замок пережил срок, список хранилища отстал) — перечитать, объединить, записать снова
    for (let i = 0; i < 4; i++) {
      const st = await eventsLoad();
      if (st.corrupt) {
        // повреждённый файл сохраняется копией до записи нового списка; не сохранилась копия — запись не идёт
        saved = eventsKey().replace(/\.json$/, '') + '.corrupt-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
        const c = await s3Put(saved, st.text, 'application/json; charset=utf-8');
        if (!c.ok) return { ok: false, error: 'events_corrupt', note: 'файл событий повреждён, а копию сохранить не удалось (s3 ' + c.status + ') — запись не выполнена' };
      }
      const m = eventsMerge(st.events, events, mode === 'replace' ? 'replace' : 'merge');
      if (!(await lockHeld(lock, evLockPrefix()))) return { ok: false, error: 'lock_lost' };
      const r = await eventsSave({ events: m.events }, st);
      if (r.ok) return { ok: true, added: m.added, updated: m.updated, skipped: m.skipped, total: m.events.length, ...(saved ? { corruptSaved: saved } : {}) };
      if (r.error !== 'changed') return r;
      console.log('events: файл изменился после чтения — перечитываю (попытка ' + (i + 2) + ')');
      await new Promise(res => setTimeout(res, 60 + Math.floor(Math.random() * 180)));
    }
    return { ok: false, error: 'busy', note: 'файл событий одновременно меняет другой запрос — повторите позже' };
  } finally { await lockRelease(lock); }
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
//  v180: СНИМОК БАЗЫ НАПРЯМУЮ В ХРАНИЛИЩЕ (подписанные ссылки), ЗАМОК ЗАПИСИ, CORS
// ════════════════════════════════════════════════════════════
const SNAP_MAX = 512 * 1024 * 1024, SHA_MAX = 24 * 1024 * 1024, LOCK_TTL = 120000, PENDING_TTL = 24 * 3600000;
const snapPrefix = () => 'dbsnap-' + storeId() + '/';
const snapPendingKey = token => snapPrefix() + 'pending-' + token + '.crypt';
const lockPrefix = () => 'dblock-' + storeId() + '/';
const evLockPrefix = () => 'evlock-' + storeId() + '/';
const SNAP_TOKEN_RE = /^[a-f0-9]{32}$/;
// подписанный запрос без тела: HEAD объекта, копирование внутри хранилища (x-amz-copy-source), чтение и запись правила CORS
function s3Signed(method, key, extraHeaders, bodyStr, contentType) {
  const host = S3_HOST, region = S3_REGION;
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const canonicalUri = '/' + process.env.BUCKET + '/' + encodeURIComponent(key || '').replace(/%2F/g, '/');
  const sub = key && String(key).startsWith('?') ? String(key) : '';
  const uri = sub ? '/' + process.env.BUCKET + '/' : canonicalUri;
  const payloadHash = sha256hex(bodyStr || '');
  const headers = { 'host': host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  if (contentType) headers['content-type'] = contentType;
  for (const k of Object.keys(extraHeaders || {})) headers[k.toLowerCase()] = extraHeaders[k];
  const signedHeaders = Object.keys(headers).sort().join(';');
  const canonicalHeaders = Object.keys(headers).sort().map(h => h + ':' + headers[h] + '\n').join('');
  const canonicalQuery = sub ? sub.slice(1) + '=' : '';
  const canonicalRequest = [method, uri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const dateStamp = amzDate.slice(0, 8), scope = dateStamp + '/' + region + '/s3/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  let k = hmac('AWS4' + process.env.S3_SECRET, dateStamp); k = hmac(k, region); k = hmac(k, 's3'); k = hmac(k, 'aws4_request');
  const signature = crypto.createHmac('sha256', k).update(stringToSign, 'utf8').digest('hex');
  const auth = 'AWS4-HMAC-SHA256 Credential=' + process.env.S3_KEY_ID + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
  const h = { 'X-Amz-Content-Sha256': payloadHash, 'X-Amz-Date': amzDate, 'Authorization': auth };
  if (contentType) h['Content-Type'] = contentType;
  for (const k2 of Object.keys(extraHeaders || {})) h[k2] = extraHeaders[k2];
  return fetch('https://' + host + uri + (sub ? sub : ''), { method, headers: h, body: bodyStr === undefined ? undefined : bodyStr });
}
const s3Head = key => s3Signed('HEAD', key);
const s3Copy = (src, dst) => s3Signed('PUT', dst, { 'x-amz-copy-source': '/' + process.env.BUCKET + '/' + encodeURIComponent(src).replace(/%2F/g, '/') });
// v185 (Д5): условная запись. If-Match — только если ETag объекта совпадает с прочитанным; If-None-Match: * — только если объекта нет.
// Отказ условия — 412 Precondition Failed (409 — при одновременных условных записях одного ключа).
const s3PutIf = (key, bodyStr, contentType, cond) => s3Signed('PUT', key, cond || {}, bodyStr, contentType);
const condFailed = r => !!r && (r.status === 412 || r.status === 409);
const condUnsupported = r => !!r && r.status === 501;
// метка «номер версии занят»: dbhist-…/<версия>.claim (в список истории не попадает — там только .crypt)
const dbClaimKey = ver => dbHistPrefix() + String(ver) + '.claim';
async function dbClaimVer(from) {
  let ver = from;
  for (let i = 0; i < 8; i++, ver++) {
    const r = await s3PutIf(dbClaimKey(ver), '1', 'text/plain', { 'If-None-Match': '*' });
    if (r.ok) return { ok: true, ver };
    // хранилище без условной записи — номер по времени, как в 184
    if (condUnsupported(r)) { console.log('claim: условная запись не поддерживается (501)'); return { ok: true, ver, cond: false }; }
    if (!condFailed(r)) return { ok: false, error: 's3 claim ' + r.status };
  }
  return { ok: false, error: 'conflict', busy: true, note: 'номер версии не удалось занять — повторите отправку' };
}
// отметка «принято»: только если файл версии не менялся с начала операции (If-Match) или его не было (If-None-Match)
async function dbCommitVer(cur, ver) {
  const CT = 'text/plain; charset=utf-8', cond = cur.exists ? (cur.etag ? { 'If-Match': cur.etag } : null) : { 'If-None-Match': '*' };
  let r = cond ? await s3PutIf(dbVerKey(), String(ver), CT, cond) : await s3Put(dbVerKey(), String(ver), CT);
  if (r.ok) return { ok: true, cond: !!cond };
  if (cond && condFailed(r)) {
    const now = await dbVer().catch(() => ({ ok: false }));
    return { ok: false, error: 'conflict', ver: now.ok ? now.ver : undefined, note: 'базу на сервере только что записало другое устройство — программа объединит и повторит' };
  }
  if (cond && condUnsupported(r)) { console.log('commit: условная запись не поддерживается (501) — запись без условия'); r = await s3Put(dbVerKey(), String(ver), CT); if (r.ok) return { ok: true, cond: false }; }
  return { ok: false, error: 's3 ver ' + r.status };
}
// правило CORS: PUT/GET/HEAD с любого адреса страницы — объекты зашифрованы, ссылки подписаны и живут час
const CORS_XML = '<CORSConfiguration><CORSRule><AllowedOrigin>*</AllowedOrigin><AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod><AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>';
let corsChecked = 0;
// проверка «как браузер»: предварительный запрос без подписи; хранилище без правила отвечает 403 «CORS is not enabled for this bucket»
async function corsProbe() {
  try {
    const r = await fetch('https://' + S3_HOST + '/' + process.env.BUCKET + '/dbsnap-probe/probe.crypt', { method: 'OPTIONS', headers: { 'Origin': 'https://advocate33.github.io', 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
    const allow = r.headers.get('access-control-allow-origin') || '', text = r.ok ? '' : (await r.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    return { ok: r.ok && !!allow, status: r.status, allow, text };
  } catch (e) { return { ok: false, status: 0, allow: '', text: String(e && e.message || e).slice(0, 160) }; }
}
async function corsSet() {
  const w = await s3Signed('PUT', '?cors', { 'content-md5': crypto.createHash('md5').update(CORS_XML).digest('base64') }, CORS_XML, 'application/xml');
  const t = w.ok ? '' : (await w.text().catch(() => '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
  console.log('cors put: ' + w.status + ' ' + t);
  return { ok: w.ok, status: w.status, text: t };
}
async function ensureCors() {
  if (corsChecked && Date.now() - corsChecked < 3600000) return { ok: true, cached: true };
  // v181: сначала проверка как браузер; правило ставится, если проверка не прошла, и проверяется снова — ссылка только после этого
  let p = await corsProbe();
  if (p.ok) { corsChecked = Date.now(); return { ok: true }; }
  const w = await corsSet();
  if (!w.ok) return { ok: false, error: 'правило CORS бакета не поставлено: хранилище ответило ' + w.status + (w.text ? ' «' + w.text + '»' : '') + ' — у сервисного аккаунта функции должна быть роль storage.editor на бакет' };
  p = await corsProbe();
  if (!p.ok) return { ok: false, error: 'правило CORS записано, но хранилище его не применяет: на предварительный запрос ответ ' + p.status + (p.text ? ' «' + p.text + '»' : '') + ' — пришлите этот текст' };
  corsChecked = Date.now(); return { ok: true, set: true };
}
async function corsCheck() {
  needStorage();
  const g = await s3Signed('GET', '?cors'); const gt = (await g.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
  const p = await corsProbe();
  return { ok: true, rule: { status: g.status, text: gt }, probe: p, enabled: p.ok, bucket: String(process.env.BUCKET || '') };
}
// замок записи: свой замок → список → если есть чужой живой, свой убирается и ответ busy; снятие — удаление своего замка
async function lockAcquire(pfx) {
  pfx = pfx || lockPrefix();
  const token = crypto.randomBytes(8).toString('hex'), ts = Date.now(), mine = pfx + String(ts).padStart(14, '0') + '-' + token;
  const w = await s3Put(mine, '1', 'text/plain');
  if (!w.ok) return { ok: false, error: 's3 lock ' + w.status };
  const r = await s3Get('?list-type=2&prefix=' + pfx + '&max-keys=1000');
  if (!r.ok) { await s3Delete(mine).catch(() => {}); return { ok: false, error: 's3 lock list ' + r.status }; }
  const keys = [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]).filter(k => k.startsWith(pfx));
  const alive = keys.filter(k => { const t = Number(k.slice(pfx.length, pfx.length + 14)); return t && ts - t < LOCK_TTL; });
  // чужой живой замок — занято (и при одновременном приходе оба отступают: лучше два отказа, чем два победителя)
  if (alive.some(k => k !== mine)) { await s3Delete(mine).catch(() => {}); return { ok: false, error: 'busy' }; }
  // устаревшие замки (упавшая функция) убираются попутно
  keys.filter(k => !alive.includes(k)).forEach(k => s3Delete(k).catch(() => {}));
  return { ok: true, key: mine, ts, pfx };
}
const lockRelease = lock => (lock && lock.key ? s3Delete(lock.key).catch(() => {}) : Promise.resolve());
// v184 (аудит 11.10.2026, п. 9): перед записью — замок всё ещё наш: ключ на месте, не старше LOCK_TTL, чужого живого нет. Сбой списка — «не наш».
async function lockHeld(lock, pfx) {
  if (!lock || !lock.key) return false;
  pfx = pfx || lock.pfx || lockPrefix();
  if (Date.now() - Number(lock.ts || 0) >= LOCK_TTL) return false;
  const r = await s3Get('?list-type=2&prefix=' + pfx + '&max-keys=1000'); if (!r.ok) return false;
  const now = Date.now(), keys = [...(await r.text()).matchAll(/<Key>([^<]+)<\/Key>/g)].map(m => m[1]).filter(k => k.startsWith(pfx));
  if (!keys.includes(lock.key)) return false;
  return !keys.some(k => k !== lock.key && now - Number(k.slice(pfx.length, pfx.length + 14)) < LOCK_TTL);
}
async function dbPutLocked(data, baseVer) {
  const lock = await lockAcquire();
  if (!lock.ok) return lock.error === 'busy' ? { ok: false, error: 'conflict', busy: true } : lock;
  try { return await dbPut(data, baseVer, () => lockHeld(lock)); } finally { await lockRelease(lock); }
}
async function snapPut(body) {
  needStorage();
  const bytes = Number(body.bytes || 0);
  if (!bytes || !Number.isFinite(bytes) || bytes < 0) return { ok: false, error: 'bad_size' };
  if (bytes > SNAP_MAX) return { ok: false, error: 'db_too_big', max: SNAP_MAX };
  const cors = await ensureCors(); if (!cors.ok) return cors;
  const [cur, token] = [await dbVer(), crypto.randomBytes(16).toString('hex')];
  if (!cur.ok) return { ok: false, error: cur.error };
  // v186: изменения этой отправки — своей ссылкой рядом со снимком (необязательно: без них цепочка просто прервётся)
  const db = Number(body.deltaBytes || 0), dt = db > 0 && db <= DELTA_MAX && Number.isFinite(db) ? crypto.randomBytes(16).toString('hex') : '';
  return { ok: true, token, url: presign('PUT', snapPendingKey(token), 3600), expiresIn: 3600, ver: cur.ver, max: SNAP_MAX, ...(dt ? { deltaToken: dt, deltaUrl: presign('PUT', deltaPendingKey(dt), 3600) } : {}) };
}
async function snapCommit(body) {
  needStorage();
  const token = String(body.token || ''); if (!SNAP_TOKEN_RE.test(token)) return { ok: false, error: 'bad_token' };
  const bytes = Number(body.bytes || 0), sha = String(body.sha256 || '').toLowerCase();
  const pending = snapPendingKey(token);
  const lock = await lockAcquire();
  if (!lock.ok) return lock.error === 'busy' ? { ok: false, error: 'conflict', busy: true } : lock;
  try {
    const [cur, hist, head] = await Promise.all([dbVer(), dbHistList().catch(() => null), s3Head(pending)]);
    if (!cur.ok) return { ok: false, error: 'версия базы на сервере не прочитана (' + cur.error + ') — запись отменена' };
    // v183: без номера версии фиксация не принимается
    const nb = needBaseVer(body.baseVer, cur.ver); if (nb) return nb;
    if (Number(body.baseVer) !== cur.ver) return { ok: false, error: 'conflict', ver: cur.ver };
    if (head.status === 404) return { ok: false, error: 'not_uploaded' };
    if (!head.ok) return { ok: false, error: 's3 head ' + head.status };
    const size = Number(head.headers && head.headers.get ? head.headers.get('content-length') : 0);
    if (bytes && size !== bytes) return { ok: false, error: 'size_mismatch', expected: bytes, got: size };
    if (!size) return { ok: false, error: 'empty' };
    // контрольная сумма: снимок до SHA_MAX читается и сверяется; больше — проверяется только размер (сказано в ответе)
    let shaChecked = false;
    if (sha && size <= SHA_MAX) { const r = await s3Get(pending); if (!r.ok) return { ok: false, error: 's3 read ' + r.status }; if (sha256hex(await r.text()) !== sha) return { ok: false, error: 'sha_mismatch' }; shaChecked = true; }
    const have = hist && hist.ok ? hist.items.map(x => x.ver) : null;
    // v185: номер версии — занятый условной записью метки (копирование условия на объект назначения не принимает)
    const claim = await dbClaimVer(Math.max(Date.now(), cur.ver + 1)); if (!claim.ok) return claim;
    const ver = claim.ver, dropMine = () => Promise.all([s3Delete(dbHistKey(ver)).catch(() => {}), s3Delete(dbClaimKey(ver)).catch(() => {})]);
    // снимок 177 (в истории его нет) сохраняется до перезаписи прежнего файла
    if (have && cur.ver && !have.includes(cur.ver)) { const old = await s3Get(dbKey()); if (old.ok) { const rp = await s3Put(dbHistKey(cur.ver), await old.text(), 'text/plain; charset=utf-8'); if (rp.ok) have.push(cur.ver); } }
    // копирование внутри хранилища — без скачивания: в историю под занятым номером
    const c0 = await s3Copy(pending, dbHistKey(ver)); if (!c0.ok) { await dropMine(); return { ok: false, error: 's3 copy hist ' + c0.status }; }
    // v184: перед отметкой «принято» — замок всё ещё наш; v185: сама отметка — условная
    if (!(await lockHeld(lock))) { await dropMine(); return { ok: false, error: 'lock_lost', note: 'фиксация шла дольше срока замка — отменена, повторите отправку' }; }
    const cm = await dbCommitVer(cur, ver);
    if (!cm.ok) { await dropMine(); return cm; }
    // v186 (Д6): изменения этой фиксации — только после принятой отметки и только под её номером и номером, от которого шли
    let delta = false;
    if (SNAP_TOKEN_RE.test(String(body.deltaToken || ''))) delta = await deltaRegister(String(body.deltaToken), Number(body.deltaBytes || 0), ver, cur.ver).catch(e => { console.log('delta: ' + (e && e.message || e)); return false; });
    // принято; прежнее имя файла (для отката на сервер 177) — после отметки. Уборка — своя заготовка, метка, лишние снимки истории,
    // чужие незавершённые загрузки старше суток; не дольше 2 с
    let pruned = 0, legacy = true;
    try {
      const jobs = [s3Copy(pending, dbKey()).then(c1 => { if (!c1.ok) { legacy = false; console.log('snap legacy copy: s3 ' + c1.status); } return c1.ok ? s3Delete(pending) : null; }).catch(() => { legacy = false; }), s3Delete(dbClaimKey(ver)).catch(() => {})];
      if (have) { const all = have.concat([ver]), keep = dbHistKeep(all, ver); all.filter(v => !keep.has(v)).forEach(v => jobs.push(s3Delete(dbHistKey(v)).then(rd => { if (rd.ok || rd.status === 404) pruned++; }).catch(() => {}))); }
      // v195: незавершённые загрузки — список целиком
      const pl = await s3ListAll(snapPrefix() + 'pending-');
      if (pl.ok) for (const m of (await pl.text()).matchAll(/<Key>([^<]+)<\/Key>[\s\S]*?<LastModified>([^<]+)<\/LastModified>/g)) { if (m[1] !== pending && Date.now() - Date.parse(m[2]) > PENDING_TTL) jobs.push(s3Delete(m[1]).catch(() => {})); }
      jobs.push(deltaPrune().catch(e => console.log('delta prune: ' + (e && e.message || e))));
      await Promise.race([Promise.all(jobs), new Promise(res => setTimeout(res, 2000))]);
    } catch (e) { console.log('snap prune: ' + (e && e.message || e)); }
    return { ok: true, ver, bytes: size, shaChecked, pruned, cond: cm.cond, delta, ...(legacy ? {} : { legacy: false }) };
  } finally { await lockRelease(lock); }
}
// ── v186 (Д6, этап 1): изменения базы между версиями ──
const DELTA_MAX = 64 * 1024 * 1024, DELTA_KEEP = 200, DELTA_DAYS = 30;
const deltaPrefix = () => 'dbdelta-' + storeId() + '/';
const deltaKey = (ver, base) => deltaPrefix() + String(ver) + '-' + String(base) + '.crypt';
const deltaPendingKey = token => deltaPrefix() + 'pending-' + token + '.crypt';
// сохранённые изменения: [{ ver, base, bytes, key, at }]
async function deltaList() {
  // v195: список целиком (s3ListAll)
  const r = await s3ListAll(deltaPrefix()); if (!r.ok) return { ok: false, error: 's3 list ' + r.status };
  const items = [];
  for (const m of (await r.text()).matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = (m[1].match(/<Key>([^<]+)<\/Key>/) || [])[1] || '', mm = /\/(\d+)-(\d+)\.crypt$/.exec(key); if (!mm || !key.startsWith(deltaPrefix())) continue;
    items.push({ ver: Number(mm[1]), base: Number(mm[2]), bytes: Number((m[1].match(/<Size>(\d+)<\/Size>/) || [])[1] || 0), key, at: Date.parse((m[1].match(/<LastModified>([^<]+)<\/LastModified>/) || [])[1] || '') || 0 });
  }
  return { ok: true, items };
}
// цепочка от since до cur: каждое следующее изменение начинается с версии, которой кончилось предыдущее; нет пути — разрыв (чистая
// функция). Две записи от одной версии условная фиксация не допускает, но путь ищется поиском в ширину — лишнее звено не рвёт цепочку
function deltaChain(items, since, cur) {
  if (since === cur) return { chain: [] };
  const byBase = new Map(); for (const d of items) if (d && d.ver > d.base && d.ver <= cur) { if (!byBase.has(d.base)) byBase.set(d.base, []); byBase.get(d.base).push(d); }
  const prev = new Map([[since, null]]), queue = [since];
  while (queue.length && !prev.has(cur)) { const at = queue.shift(); for (const d of (byBase.get(at) || []).sort((a, b) => a.ver - b.ver)) if (!prev.has(d.ver)) { prev.set(d.ver, d); queue.push(d.ver); } }
  if (!prev.has(cur)) return { gap: true };
  const chain = []; for (let v = cur; v !== since; v = prev.get(v).base) chain.unshift(prev.get(v));
  return { chain };
}
async function deltaRegister(token, bytes, ver, base) {
  const pending = deltaPendingKey(token), h = await s3Head(pending);
  if (!h.ok) return false;
  const size = Number(h.headers && h.headers.get ? h.headers.get('content-length') : 0);
  if (!size || (bytes && size !== bytes)) { await s3Delete(pending).catch(() => {}); return false; }
  const c = await s3Copy(pending, deltaKey(ver, base)); await s3Delete(pending).catch(() => {});
  return !!c.ok;
}
// хранятся DELTA_KEEP последних и не старше DELTA_DAYS; незавершённые загрузки старше суток удаляются
async function deltaPrune() {
  // v195: список целиком (s3ListAll)
  const r = await s3ListAll(deltaPrefix()); if (!r.ok) return 0;
  const xml = await r.text(), now = Date.now(), jobs = [], done = [];
  for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>[\s\S]*?<LastModified>([^<]+)<\/LastModified>/g)) if (/\/pending-/.test(m[1]) && now - Date.parse(m[2]) > PENDING_TTL) jobs.push(s3Delete(m[1]));
  const l = await deltaList(); if (l.ok) { const sorted = l.items.sort((a, b) => b.ver - a.ver); sorted.forEach((d, i) => { if (i >= DELTA_KEEP || (d.at && now - d.at > DELTA_DAYS * 864e5)) { jobs.push(s3Delete(d.key)); done.push(d.ver); } }); }
  await Promise.all(jobs.map(p => p.catch(() => {})));
  return done.length;
}
// устройство на версии since: ссылки на цепочку изменений до текущей версии; разрыв или изменений больше половины снимка — gap
async function deltaGet(body) {
  needStorage();
  const since = Math.floor(Number(body.since || 0)); if (!since || since < 0 || !Number.isFinite(since)) return { ok: true, gap: true, reason: 'since' };
  const cors = await ensureCors(); if (!cors.ok) return cors;
  const [v, list] = await Promise.all([dbVer(), deltaList()]);
  if (!v.ok) return { ok: false, error: v.error };
  if (!list.ok) return { ok: true, gap: true, ver: v.ver, reason: list.error };
  const c = deltaChain(list.items, since, v.ver);
  if (c.gap) return { ok: true, gap: true, ver: v.ver };
  const total = c.chain.reduce((a, d) => a + d.bytes, 0);
  if (c.chain.length) { const h = await s3Head(dbHistKey(v.ver)); const snap = h.ok ? Number(h.headers.get('content-length') || 0) : 0; if (snap && total > snap / 2) return { ok: true, gap: true, ver: v.ver, reason: 'large' }; }
  return { ok: true, ver: v.ver, bytes: total, chain: c.chain.map(d => ({ ver: d.ver, base: d.base, bytes: d.bytes, url: presign('GET', d.key, 3600) })), expiresIn: 3600 };
}
async function snapGet(body) {
  needStorage();
  // v182: ссылка на чтение тоже требует правила CORS — иначе браузер не прочитает ответ хранилища
  const cors = await ensureCors(); if (!cors.ok) return cors;
  const v = await dbVer(); if (!v.ok) return { ok: false, error: v.error };
  const want = body && body.ver ? Math.floor(Number(body.ver)) : v.ver;
  if (!want) { const h = await s3Head(dbKey()); if (h.status === 404) return { ok: true, exists: false, ver: 0 }; if (!h.ok) return { ok: false, error: 's3 head ' + h.status }; return { ok: true, exists: true, ver: 0, bytes: Number(h.headers.get('content-length') || 0), url: presign('GET', dbKey(), 3600), expiresIn: 3600 }; }
  let key = dbHistKey(want), h = await s3Head(key);
  if (h.status === 404 && want === v.ver) { key = dbKey(); h = await s3Head(key); } // база, записанная сервером 177
  if (h.status === 404) return { ok: true, exists: false, ver: want };
  if (!h.ok) return { ok: false, error: 's3 head ' + h.status };
  return { ok: true, exists: true, ver: want, bytes: Number(h.headers.get('content-length') || 0), url: presign('GET', key, 3600), expiresIn: 3600 };
}

// ════════════════════════════════════════════════════════════
//  v177: НАПОМИНАНИЯ С СЕРВЕРА (Telegram по таймеру)
// ════════════════════════════════════════════════════════════
const remindKey = () => 'remind-' + storeId() + '.json';
// v194: вместе со списком — ETag прочитанного файла и признак «файла не было»: условие записи (remindSave)
async function remindLoad() { const r = await s3Get(remindKey()); if (r.status === 404) return { items: [], sent: {}, exists: false, etag: '' }; if (!r.ok) throw new Error('s3 ' + r.status); const etag = (r.headers && r.headers.get && r.headers.get('etag')) || ''; try { const j = JSON.parse(await r.text()); return { items: j.items || [], sent: j.sent || {}, updatedAt: j.updatedAt, claim: j.claim || null, exists: true, etag }; } catch (e) { return { items: [], sent: {}, exists: true, etag }; } }
// v194 (аудит сборки 194, R4): запись только если файл с чтения не менялся; изменился — { ok:false, changed:true }, вызывающий перечитывает
async function remindSave(data, cur) {
  const body = JSON.stringify(data), CT = 'application/json', cond = cur.exists ? (cur.etag ? { 'If-Match': cur.etag } : null) : { 'If-None-Match': '*' };
  let r = cond ? await s3PutIf(remindKey(), body, CT, cond) : await s3Put(remindKey(), body, CT);
  if (cond && condFailed(r)) return { ok: false, changed: true };
  if (cond && condUnsupported(r)) { console.log('remind: условная запись не поддерживается (501) — запись без условия'); r = await s3Put(remindKey(), body, CT); return { ok: r.ok, status: r.status, uncond: true }; }
  return { ok: r.ok, status: r.status };
}
async function remindPut(body) { // список от CRM: [{ id, date (ГГГГ-ММ-ДД), time?, title, text? }]
  needStorage();
  const items = (Array.isArray(body.items) ? body.items : []).filter(x => x && x.id && /^\d{4}-\d{2}-\d{2}$/.test(x.date || '') && !isNaN(Date.parse(x.date))).slice(0, 500)
    .map(x => ({ id: String(x.id).slice(0, 80), date: x.date, time: x.time ? String(x.time).slice(0, 5) : '', title: String(x.title || '').slice(0, 160), text: String(x.text || '').slice(0, 200) }));
  // v189: отметка «строка о просрочке сегодня уже отправлена» (ov:<дата>) переживает новый список — иначе вторая сводка за день повторила бы её
  // v194: отметки «отправлено» — из файла, прочитанного непосредственно перед условной записью (таймер мог отметить отправку за это время)
  const ids = new Set(items.map(i => i.id)), ovFrom = 'ov:' + mskDateISO(-2);
  for (let i = 0; ; i++) {
    const prev = await remindLoad(); const keep = {}; for (const k of Object.keys(prev.sent)) if (ids.has(k) || (k.startsWith('ov:') && k >= ovFrom)) keep[k] = prev.sent[k];
    // v197 (аудит сборки 201, R9): отметка прежнего сервера — только дата. Напоминание не менялось (та же версия в прежнем списке) — отметка
    // переводится в отметку версии; менялось или прежнего элемента нет — снимается, изменённое напоминание уйдёт следующим вызовом
    const before = new Map((prev.items || []).map(x => [x.id, x])), now = new Map(items.map(x => [x.id, x]));
    for (const k of Object.keys(keep)) {
      if (k.startsWith('ov:') || !/^\d{4}-\d{2}-\d{2}$/.test(String(keep[k]))) continue;
      const was = before.get(k), cur = now.get(k);
      if (was && cur && keep[k] === cur.date && remindMark(was) === remindMark(cur)) keep[k] = remindMark(cur); else delete keep[k];
    }
    // v196 (N6): резерв отправки, действующий сейчас, сохраняется — иначе новый список во время отправки снимал бы его, и второй вызов отправил бы то же
    const claim = prev.claim && Number(prev.claim.until || 0) > Date.now() ? { claim: prev.claim } : {};
    const r = await remindSave(Object.assign({ items, sent: keep, updatedAt: Date.now() }, claim), prev);
    if (r.ok) break;
    if (!r.changed || i >= 4) throw new Error(r.changed ? 'список напоминаний меняется одновременно — повторите' : 's3 ' + r.status);
  }
  return { ok: true, n: items.length, telegram: !!(process.env.TG_TOKEN && process.env.TG_CHAT) };
}
function mskDateISO(offsetDays) { const d = new Date(Date.now() + 3 * 3600e3 + (offsetDays || 0) * 864e5); return d.toISOString().slice(0, 10); }
// v196 (аудит сборки 198, N6-A): отметка «отправлено» — версия напоминания: дата и отпечаток времени, заголовка и текста. Отметка прежних
// серверов (только дата) считается отправкой той же версии (переход без повторной рассылки всего списка)
function remindMark(x) { return x.date + '#' + crypto.createHash('sha256').update([x.date, x.time || '', x.title || '', x.text || ''].join('\n')).digest('hex').slice(0, 12); }
const remindSentOk = (st, x) => st.sent[x.id] === remindMark(x) || st.sent[x.id] === x.date;
const REMIND_CLAIM_MS = 120000;
// что отправить по состоянию st: напоминания на сегодня и завтра, ещё не отправленные в этой версии; строка о просрочке — раз в день
function remindDue(st, today, tomorrow) {
  const due = st.items.filter(x => (x.date === today || x.date === tomorrow) && !remindSentOk(st, x)).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  // v189: просроченные задачи считаются здесь каждый день (срок раньше сегодняшнего по Москве) — задача, срок которой прошёл, пока программа
  // была закрыта, тоже попадает; строка — раз в день. Программа присылает не больше 200 просроченных задач.
  const over = st.items.filter(x => /^t:/.test(x.id) && x.date < today).length, ovKey = 'ov:' + today, ovNeed = over > 0 && st.sent[ovKey] !== today;
  return { due, over, ovKey, ovNeed };
}
// v196 (N6-B): резерв отправки — условной записью в тот же файл; занято другим исполнителем (резерв не истёк) — { busy }
async function remindClaim(me) {
  for (let i = 0; i < 5; i++) {
    const cur = await remindLoad(), now = Date.now();
    if (cur.claim && cur.claim.by !== me && Number(cur.claim.until || 0) > now) return { busy: true };
    const w = await remindSave({ items: cur.items, sent: cur.sent, updatedAt: cur.updatedAt || now, claim: { by: me, until: now + REMIND_CLAIM_MS } }, cur);
    if (w.ok) { if (w.uncond) console.log('remind: резерв записан без условия — одновременный вызов может отправить то же'); return { cur }; }
    if (!w.changed) throw new Error('s3 ' + w.status);
  }
  return { busy: true };
}
// снять свой резерв (и записать отметки, если переданы); чужой или истёкший — не трогать
async function remindRelease(me, marks) {
  let w = { ok: false, status: 0 };
  for (let i = 0; i < 5; i++) {
    const cur = await remindLoad(), have = new Set(cur.items.map(x => x.id));
    for (const [id, m] of Object.entries(marks || {})) if (have.has(id) || id.startsWith('ov:')) cur.sent[id] = m;
    const data = { items: cur.items, sent: cur.sent, updatedAt: cur.updatedAt || Date.now() };
    if (cur.claim && cur.claim.by !== me) data.claim = cur.claim;
    w = await remindSave(data, cur);
    if (w.ok || !w.changed) break;
  }
  return w;
}
async function remindTick() { // сегодня и завтра — по одному сообщению
  if (!process.env.TG_TOKEN || !process.env.TG_CHAT) return { ok: true, sent: 0, error: 'нет TG_TOKEN/TG_CHAT' };
  if (!process.env.BUCKET) return { ok: true, sent: 0, error: 'нет хранилища' };
  const today = mskDateISO(0), tomorrow = mskDateISO(1);
  const first = remindDue(await remindLoad(), today, tomorrow);
  if (!first.due.length && !first.ovNeed) return { ok: true, sent: 0 };
  // v196 (N6-B): резерв до внешнего вызова; что отправлять — по состоянию, прочитанному при резерве (другой вызов мог успеть отправить)
  const me = crypto.randomBytes(8).toString('hex'), cl = await remindClaim(me);
  if (cl.busy) return { ok: true, sent: 0, busy: true };
  const { due, over, ovKey, ovNeed } = remindDue(cl.cur, today, tomorrow);
  if (!due.length && !ovNeed) { await remindRelease(me, null); return { ok: true, sent: 0 }; }
  const line = x => `${x.date === today ? '🔴 сегодня' : '🟠 завтра'}${x.time ? ' ' + x.time : ''} — ${x.title}${x.text ? ' (' + x.text + ')' : ''}`;
  // v192: сообщение Telegram — не длиннее 4096 знаков (длиннее Telegram отклоняет, и не уходило ни одно напоминание); не поместившиеся — счётом
  const tail = ovNeed ? `\n⚠️ Просрочено задач: ${over >= 200 ? 'не меньше 200' : over}` : '';
  let text = '⚖️ CRM Адвоката · напоминание', shown = 0;
  for (const x of due.slice(0, 25)) { const l = '\n' + line(x); if ((text + l + tail).length > 3900) break; text += l; shown++; }
  if (due.length > shown) text += `\n… и ещё ${due.length - shown}`;
  text += tail;
  // сбой отправки или потерянный ответ — резерв снимается без отметок: следующий вызов отправит снова (повтор лучше пропуска)
  let r; try { r = await tgSend(text, 10000); } catch (e) { await remindRelease(me, null).catch(() => {}); return { ok: false, error: 'telegram: ' + String(e && e.message || e).slice(0, 80) }; }
  if (!r.ok) { await remindRelease(me, null).catch(() => {}); return { ok: false, error: 'telegram ' + r.status }; }
  // v192: отметки «отправлено» — в список, перечитанный после отправки: список, переданный программой за это время, не затирается
  // v194 (аудит сборки 194, R4): запись отметок — условная по ETag перечитанного файла; список программы, записанный между чтением и записью,
  // не затирается: файл изменился — перечитать и отметить заново (отметка — только у пунктов, которые есть в новом списке)
  // v196 (N6-A): отметка — версии, которая ушла в сообщении; изменённая за это время остаётся ожидающей
  const marks = {}; due.forEach(x => { marks[x.id] = remindMark(x); }); if (ovNeed) marks[ovKey] = today;
  const w = await remindRelease(me, marks);
  if (!w.ok) console.log('remind: отметки об отправке не записаны (' + (w.changed ? 'список всё время меняется' : 's3 ' + w.status) + ') — напоминание может прийти повторно');
  return { ok: true, sent: due.length, overdue: ovNeed ? over : 0 };
}

// ════════════════════════════════════════════════════════════
//  v176: ОНЛАЙН-КОПИИ ДОКУМЕНТОВ (шифротекст в бакете)
// ════════════════════════════════════════════════════════════
const BLOB_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;
const blobKey = id => 'blob-' + storeId() + '/' + id + '.bin';
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
  const prefix = 'blob-' + storeId() + '/';
  // v195: список файлов целиком — по нему программа решает, что есть на сервере (s3ListAll)
  const r = await s3ListAll(prefix);
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
// v192: заявок со страницы в сутки
const BOOK_PAGE_DAY = 40;
const PID_RE = /^[a-z0-9]{6,32}$/i;
const bookKey = pid => 'book-' + pid + '.json';
const bookingsKey = () => 'bookings-' + storeId() + '.json';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ruDate = iso => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || ''); return m ? `${m[3]}.${m[2]}.${m[1]}` : ''; };
const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
// v189: согласие на обработку ПД (ч. 1 ст. 9 152-ФЗ в ред. от 24.06.2025 — отдельно от иных документов). Текст — от программы; без него —
// запасной текст из подписей страницы. Редакция — первые 12 знаков SHA-256 текста; каждая редакция хранится своим файлом.
const bookConsentKey = (pid, ver) => 'book-consent-' + pid + '-' + ver + '.txt';
const CONSENT_VER_RE = /^[0-9a-f]{12}$/;
function bookConsentOf(S) {
  S = S || {}; if (S.consentText) return String(S.consentText);
  return 'Согласие на обработку персональных данных\n\nЗаполняя форму записи на консультацию на этой странице и отмечая согласие, я даю согласие адвокату, принимающему запись на этой странице'
    + (S.address ? ' (адрес: ' + S.address + ')' : '') + (S.phone ? ', телефон ' + S.phone : '') + ', на обработку моих имени, номера телефона и сведений, указанных в полях «Вопрос» и «Комментарий», для записи на консультацию и связи со мной по этой записи.'
    + (S.notifyFull ? ' Уведомление о заявке с моими именем, телефоном и вопросом направляется адвокату через мессенджер Telegram, серверы которого могут находиться за пределами Российской Федерации.' : '')
    + '\n\nСогласие действует до достижения цели обработки либо до его отзыва; отозвать согласие можно, сообщив об этом адвокату по указанному телефону или адресу.';
}
const consentVer = text => sha256hex(String(text || '')).slice(0, 12);
async function bookLoadPublic(pid) { if (!PID_RE.test(pid)) return null; const r = await s3Get(bookKey(pid)); if (!r.ok) return null; try { return JSON.parse(await r.text()); } catch (e) { return null; } }
// v185: файл заявок читается с ETag и пишется условно — две одновременные записи (заявка доверителя и ответ адвоката, две заявки
// на одно время) не затирают друг друга: проигравший перечитывает и повторяет. Повреждённый файл — не пустой список (сохраняется копией).
async function bookingsLoad() {
  const r = await s3Get(bookingsKey()); if (r.status === 404) return { items: [], exists: false, etag: '' }; if (!r.ok) throw new Error('s3 ' + r.status);
  const etag = (r.headers && r.headers.get && r.headers.get('etag')) || '', text = await r.text();
  try { const j = JSON.parse(text); return { items: Array.isArray(j.items) ? j.items : [], exists: true, etag }; } catch (e) { return { items: [], exists: true, etag, corrupt: true, text }; }
}
// записать; false — файл успел измениться (повторить с перечитанным)
async function bookingsSave(st) {
  if (st.corrupt) { const saved = bookingsKey().replace(/\.json$/, '.corrupt-' + Date.now() + '.json'); const c = await s3Put(saved, st.text || '', 'application/json; charset=utf-8'); if (!c.ok) throw new Error('файл заявок повреждён, а копию сохранить не удалось (s3 ' + c.status + ')'); console.log('bookings: повреждённый файл заявок сохранён копией'); }
  const body = JSON.stringify({ items: st.items }), CT = 'application/json; charset=utf-8';
  const cond = st.exists ? (st.etag ? { 'If-Match': st.etag } : null) : { 'If-None-Match': '*' };
  let r = cond ? await s3PutIf(bookingsKey(), body, CT, cond) : await s3Put(bookingsKey(), body, CT);
  if (cond && condFailed(r)) return false;
  if (cond && condUnsupported(r)) r = await s3Put(bookingsKey(), body, CT);
  if (!r.ok) throw new Error('s3 ' + r.status + ' при записи заявок');
  return true;
}
// прочитать → изменить → условно записать, до 4 попыток с короткой случайной паузой; fn возвращает ответ или { save: true, reply }
async function bookingsTx(fn) {
  for (let i = 0; i < 4; i++) {
    const st = await bookingsLoad(); const out = await fn(st);
    if (!out || !out.save) return out;
    if (await bookingsSave(st)) return out.reply;
    await new Promise(res => setTimeout(res, 60 + Math.floor(Math.random() * 180)));
  }
  return { ok: false, error: 'busy', note: 'заявки на сервере сейчас меняются — повторите через несколько секунд' };
}
const bookTaken = (items, date, time) => items.some(b => b.date === date && b.time === time && b.status !== 'declined' && b.status !== 'cancelled');
// CRM публикует окна: { publicId, settings:{title, address, phone, durationMin, note, topics:[]}, days:[{date, slots:[…]}] }
async function bookPublish(body) {
  needStorage();
  const pid = String(body.publicId || ''); if (!PID_RE.test(pid)) return { ok: false, error: 'bad_publicId' };
  const settings = Object.assign({ title: 'Запись на консультацию', durationMin: 60 }, body.settings || {});
  // v189: текст согласия и вид уведомления; прежняя программа их не шлёт — остаются от прошлой публикации
  const given = body.settings || {}, prevPub = await bookLoadPublic(pid), ps = (prevPub && prevPub.settings) || {};
  for (const k of ['consentText', 'notifyFull']) if (!(k in given) && k in ps) settings[k] = ps[k];
  settings.consentText = String(settings.consentText || '').slice(0, 8000); if (!settings.consentText) delete settings.consentText;
  settings.notifyFull = !!settings.notifyFull;
  settings.consentVer = consentVer(bookConsentOf(settings));
  // текст редакции — до страницы, которая на него ссылается; та же редакция уже записана — повторно не пишется
  if (settings.consentVer !== ps.consentVer) { const c = await s3Put(bookConsentKey(pid, settings.consentVer), bookConsentOf(settings), 'text/plain; charset=utf-8'); if (!c.ok) return { ok: false, error: 's3 ' + c.status + ' при записи текста согласия' }; }
  const days = (Array.isArray(body.days) ? body.days : []).filter(d => d && /^\d{4}-\d{2}-\d{2}$/.test(d.date)).map(d => ({ date: d.date, slots: (d.slots || []).filter(t => /^\d{2}:\d{2}$/.test(t)).slice(0, 48) })).slice(0, 60);
  const r = await s3Put(bookKey(pid), JSON.stringify({ settings, days, updatedAt: Date.now() }), 'application/json; charset=utf-8');
  if (!r.ok) return { ok: false, error: 's3 ' + r.status };
  return { ok: true, publicId: pid, days: days.length, slots: days.reduce((a, d) => a + d.slots.length, 0), url: '?book=' + pid, consentVer: settings.consentVer };
}
async function bookGet(body) {
  needStorage(); const st = await bookingsLoad(); const since = Number(body.since) || 0;
  if (st.corrupt) return { ok: false, error: 'bookings_corrupt', note: 'файл заявок на сервере повреждён — при следующей заявке он будет сохранён копией и начат заново' };
  // v192: от ранних изменений к поздним и в пределах ответа — программа продолжит с последней полученной (more: есть ещё)
  const list = st.items.filter(b => (b.updatedAt || b.createdAt || 0) > since).sort((a, b) => (a.updatedAt || a.createdAt || 0) - (b.updatedAt || b.createdAt || 0));
  const f = fitList(list, { ok: true, total: st.items.length, more: true });
  return { ok: true, items: f.items, total: st.items.length, more: f.cut > 0 };
}
async function bookSet(body) {
  needStorage();
  if (!['new', 'confirmed', 'declined', 'cancelled', 'done'].includes(body.status)) return { ok: false, error: 'bad_status' };
  return bookingsTx(st => {
    const b = st.items.find(x => x.id === body.id); if (!b) return { ok: false, error: 'not_found' };
    b.status = body.status; if (body.note !== undefined) b.lawyerNote = String(body.note).slice(0, 300); b.updatedAt = Date.now();
    return { save: true, reply: { ok: true, item: b } };
  });
}
// заявка клиента: окно должно быть опубликовано и не занято; телефон обязателен; защита от роботов — скрытое поле «site»
async function bookRequest(body, event) {
  needStorage();
  const pid = String(body.book || ''); const pub = await bookLoadPublic(pid); if (!pub) return { ok: false, error: 'Страница записи не найдена' };
  if (body.site) return { ok: true, id: 'x', code: '0000' }; // робот заполнил скрытое поле — делаем вид, что приняли
  const date = String(body.date || ''), time = String(body.time || ''), name = String(body.name || '').trim().slice(0, 120), phone = String(body.phone || '').replace(/[^\d+]/g, '').slice(0, 20);
  const topic = String(body.topic || '').trim().slice(0, 120), comment = String(body.comment || '').trim().slice(0, 1000);
  if (!name || phone.replace(/\D/g, '').length < 10) return { ok: false, error: 'Укажите имя и телефон' };
  // v189: без согласия на обработку ПД заявка не принимается; согласие — на ту редакцию текста, что сейчас на странице
  const S = pub.settings || {}, cver = CONSENT_VER_RE.test(S.consentVer || '') ? S.consentVer : consentVer(bookConsentOf(S));
  if (!(body.consent === true || body.consent === 'on' || body.consent === '1')) return { ok: false, error: 'Отметьте согласие на обработку персональных данных — без него заявку принять нельзя' };
  if (String(body.consentVer || '') !== cver) return { ok: false, error: 'Текст согласия на странице обновился — откройте страницу заново и отметьте согласие ещё раз' };
  const day = pub.days.find(d => d.date === date); if (!day || !day.slots.includes(time)) return { ok: false, error: 'Это время недоступно — выберите другое' };
  // v192: адрес по платформе, а не первый адрес X-Forwarded-For (его присылает клиент)
  const ip = clientIp(event);
  // v192: прошедшие день и время не принимаются (окна — по Москве; запас 2 часа — для адвокатов западнее Москвы)
  const slotAt = Date.parse(date + 'T' + time + ':00+03:00');
  if (!Number.isFinite(slotAt) || slotAt < Date.now() - 2 * 3600e3) return { ok: false, error: 'Это время уже прошло — выберите другое' };
  const id = 'З' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const item = { id, code: '', publicId: pid, date, time, name, phone, topic, comment, status: 'new', createdAt: Date.now(), updatedAt: Date.now(), ip, consentAt: Date.now(), consentVer: cver };
  // v185: проверка «время свободно» и запись — по одному и тому же прочитанному файлу; файл изменился — перечитать и проверить снова
  const res = await bookingsTx(st => {
    if (bookTaken(st.items, date, time)) return { ok: false, error: 'Это время уже занято — выберите другое' };
    const recent = st.items.filter(b => b.ip && b.ip === ip && Date.now() - (b.createdAt || 0) < 3600e3).length; if (recent >= 5) return { ok: false, error: 'Слишком много заявок — попробуйте позже' };
    // v192: не больше BOOK_PAGE_DAY заявок со страницы в сутки — иначе с разных адресов можно занять все окна и засыпать Telegram
    if (st.items.filter(b => b.publicId === pid && Date.now() - (b.createdAt || 0) < 864e5).length >= BOOK_PAGE_DAY) return { ok: false, error: 'Сейчас страница не принимает заявки' + (S.phone ? ' — позвоните: ' + S.phone : ' — попробуйте завтра') };
    // v192: заявки, день которых прошёл больше 400 дней назад, удаляются — файл заявок не растёт без предела
    const old = new Date(Date.now() + 3 * 3600e3 - 400 * 864e5).toISOString().slice(0, 10); st.items = st.items.filter(b => !(b && b.date && b.date < old));
    // v192: код заявки — 6 цифр и не повторяется на странице (по 4-значному коду можно было перебрать заявки, и коды совпадали)
    const used = new Set(st.items.filter(b => b && b.publicId === pid).map(b => String(b.code))); do { item.code = String(100000 + crypto.randomInt(900000)); } while (used.has(item.code));
    st.items.push(item); return { save: true, reply: { ok: true, id, code: item.code, date, time, status: 'new' } };
  });
  if (res && res.ok) await bookNotify(pub, item).catch(e => console.log('book notify: ' + scrub(e && e.message || e)));
  return res;
}
async function bookNotify(pub, b) { // Telegram — если в переменных функции моста заданы TG_TOKEN и TG_CHAT
  if (!process.env.TG_TOKEN || !process.env.TG_CHAT) return;
  // v189: Telegram — зарубежный сервис: имя, телефон и вопрос — только если программа прислала notifyFull (отметка «Полные названия и имена в Telegram»)
  const full = !!(pub && pub.settings && pub.settings.notifyFull);
  const text = full ? `📅 Новая запись на приём\n${ruDate(b.date)} ${b.time} — ${b.name}\n📞 ${b.phone}${b.topic ? '\n' + b.topic : ''}${b.comment ? '\n' + b.comment.slice(0, 200) : ''}\nКод ${b.code}. Подтвердите в CRM.`
    : `📅 Новая запись на приём\n${ruDate(b.date)} ${b.time}\nКод ${b.code}. Имя, телефон и вопрос — в CRM; там же подтвердите запись.`;
  // v192: с пределом ожидания
  await tgSend(text, 8000);
}
// публичная страница: календарь окон + форма; с параметром code — статус заявки
async function bookPage(q) {
  const pid = String(q.book || ''); const pub = await bookLoadPublic(pid);
  const html = h => ({ statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: h });
  if (!pub) return html(bookShell('Запись', '<p>Страница записи не найдена или ещё не опубликована.</p>'));
  const S = pub.settings || {};
  // v189: отдельная страница текста согласия; с номером редакции — тот самый текст, на который дано согласие
  if (q.consent) {
    const cur = CONSENT_VER_RE.test(S.consentVer || '') ? S.consentVer : consentVer(bookConsentOf(S)), want = String(q.consent);
    let text = '', ver = cur;
    if (want === '1' || want === cur) text = bookConsentOf(S);
    else if (CONSENT_VER_RE.test(want)) { const r = await s3Get(bookConsentKey(pid, want)); if (r.ok) { text = await r.text(); ver = want; } }
    if (!text) return html(bookShell('Согласие на обработку персональных данных', '<p>Такой редакции текста согласия нет.</p><p><a href="?book=' + esc(pid) + '&consent=1">Действующая редакция</a></p>'));
    return html(bookShell('Согласие на обработку персональных данных', `<div class="ctext">${esc(text).replace(/\n/g, '<br>')}</div><p class="fine">Редакция ${esc(ver)}${ver !== cur ? ' (прежняя)' : ''}</p><p><a href="?book=${esc(pid)}">Вернуться к записи</a></p>`));
  }
  if (q.code) { const st = await bookingsLoad(); const b = st.items.find(x => x.publicId === pid && x.code === String(q.code)); const label = { new: 'ожидает подтверждения', confirmed: 'подтверждена ✅', declined: 'отклонена — выберите другое время', cancelled: 'отменена', done: 'приём состоялся' };
    return html(bookShell(S.title, b ? `<p><b>Заявка ${esc(b.code)}</b>: ${ruDate(b.date)} в ${esc(b.time)} — ${label[b.status] || b.status}.${b.lawyerNote ? '<br>' + esc(b.lawyerNote) : ''}</p>${S.phone ? `<p>Телефон: <a href="tel:${esc(S.phone)}">${esc(S.phone)}</a></p>` : ''}` : '<p>Заявка с таким кодом не найдена.</p>')); }
  const st = await bookingsLoad();
  // v192: «сегодня» — по Москве (было по UTC: с 00:00 до 03:00 показывались вчерашние окна); прошедшие сегодняшние окна не показываются
  const today = new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10), passed = (d, t) => Date.parse(d + 'T' + t + ':00+03:00') < Date.now();
  const days = pub.days.filter(d => d.date >= today).map(d => ({ date: d.date, slots: d.slots.filter(t => !bookTaken(st.items, d.date, t) && !passed(d.date, t)) })).filter(d => d.slots.length);
  const daysHtml = days.length ? days.map(d => { const dt = new Date(d.date + 'T00:00:00'); return `<div class="day"><div class="dh">${ruDate(d.date)} · ${WD[dt.getDay()]}</div><div class="slots">${d.slots.map(t => `<button type="button" class="slot" data-d="${d.date}" data-t="${t}">${t}</button>`).join('')}</div></div>`; }).join('') : '<p>Свободных окон сейчас нет — позвоните или напишите.</p>';
  const cver = CONSENT_VER_RE.test(S.consentVer || '') ? S.consentVer : consentVer(bookConsentOf(S));
  const topics = Array.isArray(S.topics) && S.topics.length ? `<label>Вопрос<select name="topic"><option value="">— выберите —</option>${S.topics.map(t => `<option>${esc(t)}</option>`).join('')}</select></label>` : `<label>Вопрос (кратко)<input name="topic" maxlength="120"></label>`;
  const body = `${S.note ? `<p class="note">${esc(S.note)}</p>` : ''}${S.address ? `<p class="note">📍 ${esc(S.address)}</p>` : ''}<p>Приём длится ${esc(S.durationMin || 60)} мин. Выберите день и время:</p>${daysHtml}
<form id="f" style="display:none"><div class="pick">Выбрано: <b id="pick"></b></div><label>Ваше имя<input name="name" required maxlength="120"></label><label>Телефон<input name="phone" required inputmode="tel" placeholder="+7 900 000-00-00"></label>${topics}<label>Комментарий<textarea name="comment" rows="3" maxlength="1000"></textarea></label><input name="site" style="display:none" tabindex="-1" autocomplete="off"><label class="ck"><input type="checkbox" name="consent" id="ck"><span>Даю согласие на обработку моих персональных данных на условиях <a href="?book=${esc(pid)}&consent=${esc(cver)}" target="_blank" rel="noopener">текста согласия</a></span></label><input type="hidden" name="consentVer" value="${esc(cver)}"><button type="submit" class="go" disabled>Записаться</button><p class="fine">Без согласия заявку отправить нельзя. Текст согласия открывается отдельной страницей.</p></form><div id="out"></div>
<script>(function(){var d='',t='';var f=document.getElementById('f'),out=document.getElementById('out'),ck=document.getElementById('ck'),go=f.querySelector('.go');ck.onchange=function(){go.disabled=!ck.checked;};document.querySelectorAll('.slot').forEach(function(b){b.onclick=function(){document.querySelectorAll('.slot').forEach(function(x){x.classList.remove('on')});b.classList.add('on');d=b.dataset.d;t=b.dataset.t;document.getElementById('pick').textContent=b.closest('.day').querySelector('.dh').textContent+' '+t;f.style.display='block';f.scrollIntoView({behavior:'smooth'});};});
f.onsubmit=function(e){e.preventDefault();var fd=new FormData(f);var body={book:${JSON.stringify(pid)},action:'bookreq',date:d,time:t};fd.forEach(function(v,k){body[k]=v;});var btn=f.querySelector('.go');btn.disabled=true;btn.textContent='Отправляю…';
fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(j){if(j.ok){f.style.display='none';out.innerHTML='<div class="ok">Заявка принята: '+j.date.split('-').reverse().join('.')+' в '+j.time+'.<br>Код заявки <b>'+j.code+'</b> — по нему можно проверить статус: <a href="?book=${pid}&code='+j.code+'">открыть</a>.<br>Приём состоится после подтверждения; при изменениях с вами свяжутся по телефону.</div>';}else{out.innerHTML='<div class="err">'+(j.error||'Ошибка')+'</div>';btn.disabled=!ck.checked;btn.textContent='Записаться';}}).catch(function(){out.innerHTML='<div class="err">Нет связи — попробуйте ещё раз</div>';btn.disabled=!ck.checked;btn.textContent='Записаться';});};})();</script>`;
  return html(bookShell(S.title, body));
}
function bookShell(title, body) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title || 'Запись на приём')}</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;background:#f5f6fa;color:#1a1d2b}.wrap{max-width:560px;margin:0 auto;padding:20px 16px 40px}h1{font-size:22px;margin:8px 0 12px}.note{color:#555;margin:4px 0}.day{background:#fff;border:1px solid #e3e5ee;border-radius:12px;padding:10px 12px;margin:10px 0}.dh{font-weight:600;margin-bottom:6px}.slots{display:flex;flex-wrap:wrap;gap:6px}.slot{border:1px solid #c9cde0;background:#fff;border-radius:8px;padding:8px 12px;font-size:15px}.slot.on{background:#4f46e5;color:#fff;border-color:#4f46e5}
form{background:#fff;border:1px solid #e3e5ee;border-radius:12px;padding:12px;margin-top:14px}label{display:block;margin:8px 0 4px;font-size:14px;color:#444}input,select,textarea{width:100%;box-sizing:border-box;padding:10px;border:1px solid #c9cde0;border-radius:8px;font-size:16px;font-family:inherit}.go{margin-top:12px;width:100%;padding:12px;border:0;border-radius:10px;background:#4f46e5;color:#fff;font-size:16px}.fine{font-size:12px;color:#777}.ck{display:flex;gap:8px;align-items:flex-start;margin-top:12px}.ck input{width:auto;margin-top:3px;flex:none}.go:disabled{opacity:.5}.ctext{background:#fff;border:1px solid #e3e5ee;border-radius:12px;padding:12px;line-height:1.5}.pick{margin-bottom:6px}.ok{background:#e8f7ee;border:1px solid #9ad4b0;border-radius:12px;padding:12px;margin-top:12px}.err{background:#fdecec;border:1px solid #f0a0a0;border-radius:12px;padding:12px;margin-top:12px}
</style></head><body><div class="wrap"><h1>${esc(title || 'Запись на приём')}</h1>${body}</div></body></html>`;
}

// ════════════════════════════════════════════════════════════
//  v190: «ЗАДАТЬ ВОПРОС» (план по ЮрТопосу 13.10.2026, этап 4)
// ════════════════════════════════════════════════════════════
// Публичная страница без секрета: GET ?ask=<publicId> — форма; POST {ask, action:'askreq', name, phone, tg, method, question, consent,
// consentVer, nonce} — вопрос. Для программы (с секретом): askpub {publicId, settings} — подписи страницы, способы связи, текст согласия,
// off — «не принимать»; askget {} — все вопросы (без адреса и метки формы) и время сервера; askack {ids} — отметка «программа приняла».
// Объекты: ask-<publicId>.json (публичное), ask-consent-<publicId>-<редакция>.txt (каждая редакция текста согласия), asks-<STORE>.json (вопросы:
// имя, контакты, текст — вне шифрования CRM). Принятый программой вопрос удаляется через 30 дней после отметки, непринятый — через 180 дней.
// Защита: скрытое поле; не больше 5 вопросов с одного адреса в час и 40 со страницы за сутки; та же форма (метка) или тот же текст с того же
// телефона или Telegram за сутки — тот же ответ без новой записи. Вложений нет.
const ASK_KEEP_TAKEN = 30 * 864e5, ASK_KEEP_ALL = 180 * 864e5, ASK_IP_HOUR = 5, ASK_PAGE_DAY = 40;
const ASK_METHODS = { call: 'позвонить', tg: 'написать в Telegram', wa: 'написать в WhatsApp', sms: 'написать SMS' };
const askKey = pid => 'ask-' + pid + '.json';
const asksKey = () => 'asks-' + storeId() + '.json';
const askConsentKey = (pid, ver) => 'ask-consent-' + pid + '-' + ver + '.txt';
const askPhone = s => String(s || '').replace(/[^\d+]/g, '').slice(0, 20);
const askDigits10 = s => String(s || '').replace(/\D/g, '').slice(-10);
// имя пользователя Telegram: латиница, цифры и «_», от 5 до 32 знаков, первая — буква; «@» и адрес t.me/… снимаются
const askTg = s => String(s || '').trim().replace(/^https?:\/\/(www\.)?(t|telegram)\.me\//i, '').replace(/^@/, '').replace(/\/+$/, '');
const ASK_TG_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
function askConsentOf(S) {
  S = S || {}; if (S.consentText) return String(S.consentText);
  return 'Согласие на обработку персональных данных\n\nЗаполняя форму «Задать вопрос» на этой странице и отмечая согласие, я даю согласие адвокату, принимающему вопросы на этой странице'
    + (S.phone ? ' (телефон ' + S.phone + ')' : '') + ', на обработку моих имени, номера телефона, имени пользователя Telegram и сведений, указанных в поле «Вопрос», для ответа на мой вопрос и связи со мной по нему.'
    + (S.notifyFull ? ' Уведомление о вопросе с моими именем, контактами и текстом вопроса направляется адвокату через мессенджер Telegram, серверы которого могут находиться за пределами Российской Федерации.' : '')
    + '\n\nСогласие действует до достижения цели обработки либо до его отзыва; отозвать согласие можно, сообщив об этом адвокату по указанному телефону.';
}
async function askLoadPublic(pid) { if (!PID_RE.test(pid)) return null; const r = await s3Get(askKey(pid)); if (!r.ok) return null; try { return JSON.parse(await r.text()); } catch (e) { return null; } }
// файл вопросов — как файл заявок (v185): чтение с ETag, условная запись, повреждённый файл сохраняется копией
async function asksLoad() {
  const r = await s3Get(asksKey()); if (r.status === 404) return { items: [], exists: false, etag: '' }; if (!r.ok) throw new Error('s3 ' + r.status);
  const etag = (r.headers && r.headers.get && r.headers.get('etag')) || '', text = await r.text();
  try { const j = JSON.parse(text); return { items: Array.isArray(j.items) ? j.items : [], exists: true, etag }; } catch (e) { return { items: [], exists: true, etag, corrupt: true, text }; }
}
// срок хранения: принятый программой — 30 дней после отметки, любой — 180 дней
function asksPrune(items, now) {
  return (items || []).filter(x => { const c = Number(x && x.createdAt) || 0, tk = Number(x && x.takenAt) || 0; return !!x && !(tk && now - tk > ASK_KEEP_TAKEN) && !(now - c > ASK_KEEP_ALL); });
}
async function asksSave(st) {
  if (st.corrupt) { const saved = asksKey().replace(/\.json$/, '.corrupt-' + Date.now() + '.json'); const c = await s3Put(saved, st.text || '', 'application/json; charset=utf-8'); if (!c.ok) throw new Error('файл вопросов повреждён, а копию сохранить не удалось (s3 ' + c.status + ')'); console.log('asks: повреждённый файл вопросов сохранён копией'); }
  const body = JSON.stringify({ items: asksPrune(st.items, Date.now()) }), CT = 'application/json; charset=utf-8';
  const cond = st.exists ? (st.etag ? { 'If-Match': st.etag } : null) : { 'If-None-Match': '*' };
  let r = cond ? await s3PutIf(asksKey(), body, CT, cond) : await s3Put(asksKey(), body, CT);
  if (cond && condFailed(r)) return false;
  if (cond && condUnsupported(r)) r = await s3Put(asksKey(), body, CT);
  if (!r.ok) throw new Error('s3 ' + r.status + ' при записи вопросов');
  return true;
}
async function asksTx(fn) {
  for (let i = 0; i < 4; i++) {
    const st = await asksLoad(); const out = await fn(st);
    if (!out || !out.save) return out;
    if (await asksSave(st)) return out.reply;
    await new Promise(res => setTimeout(res, 60 + Math.floor(Math.random() * 180)));
  }
  return { ok: false, error: 'busy', note: 'вопросы на сервере сейчас меняются — повторите через несколько секунд' };
}
// программа публикует страницу: { publicId, settings:{title, intro, phone, methods:[call|tg|wa|sms], consentText?, notifyFull?, off?} }
async function askPublish(body) {
  needStorage();
  const pid = String(body.publicId || ''); if (!PID_RE.test(pid)) return { ok: false, error: 'bad_publicId' };
  const g = body.settings || {}, prev = await askLoadPublic(pid), ps = (prev && prev.settings) || {};
  const S = { title: String(g.title || 'Задать вопрос адвокату').slice(0, 120), intro: String(g.intro || '').slice(0, 1000), phone: String(g.phone || '').slice(0, 40),
    methods: (Array.isArray(g.methods) ? g.methods : []).filter(m => ASK_METHODS[m]).slice(0, 4), off: !!g.off };
  if (!S.methods.length) S.methods = ['call', 'tg'];
  // текст согласия и вид уведомления не присланы — остаются прежние (как у записи с 189)
  S.consentText = String(('consentText' in g ? g.consentText : ps.consentText) || '').slice(0, 8000); if (!S.consentText) delete S.consentText;
  S.notifyFull = !!('notifyFull' in g ? g.notifyFull : ps.notifyFull);
  S.consentVer = consentVer(askConsentOf(S));
  if (S.consentVer !== ps.consentVer) { const c = await s3Put(askConsentKey(pid, S.consentVer), askConsentOf(S), 'text/plain; charset=utf-8'); if (!c.ok) return { ok: false, error: 's3 ' + c.status + ' при записи текста согласия' }; }
  const r = await s3Put(askKey(pid), JSON.stringify({ settings: S, updatedAt: Date.now() }), 'application/json; charset=utf-8');
  if (!r.ok) return { ok: false, error: 's3 ' + r.status };
  return { ok: true, publicId: pid, url: '?ask=' + pid, consentVer: S.consentVer, off: S.off };
}
// все вопросы — программа сама решает, что у неё уже есть; адрес и метка формы программе не нужны
async function askGet() {
  needStorage(); const st = await asksLoad();
  if (st.corrupt) return { ok: false, error: 'asks_corrupt', note: 'файл вопросов на сервере повреждён — при следующем вопросе он будет сохранён копией и начат заново' };
  const all = asksPrune(st.items, Date.now()).map(x => { const o = Object.assign({}, x); delete o.ip; delete o.nonce; return o; });
  // v192: в пределах ответа функции — сначала непринятые, затем принятые от новых к старым; не поместившиеся — счётом
  const order = all.filter(x => !x.takenAt).concat(all.filter(x => x.takenAt).sort((a, b) => (b.takenAt || 0) - (a.takenAt || 0)));
  const f = fitList(order, { ok: true, now: Date.now(), cut: 0 });
  return { ok: true, now: Date.now(), items: f.items, cut: f.cut };
}
async function askAck(body) {
  needStorage();
  const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).slice(0, 500); if (!ids.length) return { ok: true, n: 0 };
  return asksTx(st => {
    const now = Date.now(); let n = 0;
    for (const x of st.items) if (x && ids.includes(x.id) && !x.takenAt) { x.takenAt = now; n++; }
    return n ? { save: true, reply: { ok: true, n } } : { ok: true, n: 0 };
  });
}
async function askRequest(body, event) {
  needStorage();
  const pid = String(body.ask || ''); const pub = await askLoadPublic(pid); if (!pub) return { ok: false, error: 'Страница не найдена' };
  if (body.site) return { ok: true, code: '0000' }; // робот заполнил скрытое поле — делаем вид, что приняли
  const S = pub.settings || {};
  if (S.off) return { ok: false, error: 'Сейчас вопросы через эту страницу не принимаются' + (S.phone ? ' — позвоните: ' + S.phone : '') };
  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 120), phone = askPhone(body.phone), tg = askTg(body.tg), digits = phone.replace(/\D/g, '');
  const question = String(body.question || '').trim().slice(0, 2000);
  if (!name) return { ok: false, error: 'Укажите имя' };
  if (tg && !ASK_TG_RE.test(tg)) return { ok: false, error: 'Имя пользователя Telegram — латинские буквы, цифры и «_», от 5 знаков, например @ivan_petrov' };
  if (digits.length < 10 && !tg) return { ok: false, error: 'Укажите телефон или имя пользователя Telegram — иначе адвокат не сможет ответить' };
  const allowed = Array.isArray(S.methods) && S.methods.length ? S.methods.filter(m => ASK_METHODS[m]) : ['call', 'tg'];
  const method = allowed.includes(body.method) ? body.method : allowed[0];
  if (method !== 'tg' && digits.length < 10) return { ok: false, error: 'Чтобы адвокат мог ' + ASK_METHODS[method] + ', укажите телефон' };
  if (question.length < 10) return { ok: false, error: 'Опишите вопрос хотя бы одним предложением' };
  // согласие — как у записи с 189: флажок и та редакция текста, что сейчас на странице
  const cver = CONSENT_VER_RE.test(S.consentVer || '') ? S.consentVer : consentVer(askConsentOf(S));
  if (!(body.consent === true || body.consent === 'on' || body.consent === '1')) return { ok: false, error: 'Отметьте согласие на обработку персональных данных — без него вопрос принять нельзя' };
  if (String(body.consentVer || '') !== cver) return { ok: false, error: 'Текст согласия на странице обновился — откройте страницу заново и отметьте согласие ещё раз' };
  // v192: адрес по платформе
  const ip = clientIp(event);
  const nonce = /^[a-z0-9]{8,40}$/i.test(String(body.nonce || '')) ? String(body.nonce) : '';
  const now = Date.now(), id = 'q' + now.toString(36) + crypto.randomBytes(3).toString('hex'), code = String(1000 + crypto.randomInt(9000));
  const item = { id, code, publicId: pid, name, phone, tg, method, question, createdAt: now, updatedAt: now, ip, nonce, consentAt: now, consentVer: cver };
  let fresh = false;
  const res = await asksTx(st => {
    st.items = asksPrune(st.items, now);
    // повтор: та же форма (метка) или тот же текст с того же телефона или Telegram за сутки — тот же ответ, новой записи нет
    const same = st.items.find(x => x && x.publicId === pid && ((nonce && x.nonce === nonce) || (x.question === question && now - (x.createdAt || 0) < 864e5 && ((digits.length >= 10 && askDigits10(x.phone) === digits.slice(-10)) || (tg && String(x.tg || '').toLowerCase() === tg.toLowerCase())))));
    if (same) return { ok: true, code: same.code, method: same.method, repeat: true };
    if (ip && st.items.filter(x => x.ip === ip && now - (x.createdAt || 0) < 3600e3).length >= ASK_IP_HOUR) return { ok: false, error: 'Слишком много вопросов с этого устройства — попробуйте позже' + (S.phone ? ' или позвоните: ' + S.phone : '') };
    if (st.items.filter(x => x.publicId === pid && now - (x.createdAt || 0) < 864e5).length >= ASK_PAGE_DAY) return { ok: false, error: 'Сейчас страница не принимает вопросы' + (S.phone ? ' — позвоните: ' + S.phone : ' — попробуйте завтра') };
    st.items.push(item); fresh = true;
    return { save: true, reply: { ok: true, code, method } };
  });
  if (res && res.ok && fresh && !res.repeat) await askNotify(pub, item).catch(e => console.log('ask notify: ' + (e && e.message || e)));
  return res;
}
async function askNotify(pub, q) { // Telegram — если в переменных функции заданы TG_TOKEN и TG_CHAT
  if (!process.env.TG_TOKEN || !process.env.TG_CHAT) return;
  // Telegram — зарубежный сервис: имя, контакты и вопрос — только если программа прислала notifyFull (как у записи с 189)
  const full = !!(pub && pub.settings && pub.settings.notifyFull);
  const text = full ? `Вопрос с сайта\n${q.name}${q.phone ? '\nТелефон: ' + q.phone : ''}${q.tg ? '\nTelegram: @' + q.tg : ''}\nКак связаться: ${ASK_METHODS[q.method] || q.method}\n${q.question.slice(0, 300)}${q.question.length > 300 ? '…' : ''}\nКод ${q.code}.`
    : `Новый вопрос с сайта\nКод ${q.code}. Имя, контакты и вопрос — в CRM.`;
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 8000);
  try { await fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: process.env.TG_CHAT, text }), signal: ctl.signal }); }
  finally { clearTimeout(timer); }
}
async function askPage(q) {
  const pid = String(q.ask || ''); const pub = await askLoadPublic(pid);
  const html = h => ({ statusCode: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, body: h });
  if (!pub) return html(bookShell('Задать вопрос', '<p>Страница не найдена или ещё не опубликована.</p>'));
  const S = pub.settings || {}, title = S.title || 'Задать вопрос адвокату';
  const cur = CONSENT_VER_RE.test(S.consentVer || '') ? S.consentVer : consentVer(askConsentOf(S));
  if (q.consent) {
    const want = String(q.consent); let text = '', ver = cur;
    if (want === '1' || want === cur) text = askConsentOf(S);
    else if (CONSENT_VER_RE.test(want)) { const r = await s3Get(askConsentKey(pid, want)); if (r.ok) { text = await r.text(); ver = want; } }
    if (!text) return html(bookShell('Согласие на обработку персональных данных', '<p>Такой редакции текста согласия нет.</p><p><a href="?ask=' + esc(pid) + '&consent=1">Действующая редакция</a></p>'));
    return html(bookShell('Согласие на обработку персональных данных', `<div class="ctext">${esc(text).replace(/\n/g, '<br>')}</div><p class="fine">Редакция ${esc(ver)}${ver !== cur ? ' (прежняя)' : ''}</p><p><a href="?ask=${esc(pid)}">Вернуться к вопросу</a></p>`));
  }
  const tel = S.phone ? `<p class="note">Телефон: <a href="tel:${esc(String(S.phone).replace(/[^\d+]/g, ''))}">${esc(S.phone)}</a></p>` : '';
  if (S.off) return html(bookShell(title, '<p>Сейчас вопросы через эту страницу не принимаются.</p>' + tel));
  const methods = (Array.isArray(S.methods) && S.methods.length ? S.methods : ['call', 'tg']).filter(m => ASK_METHODS[m]);
  const body = `${S.intro ? `<p class="note">${esc(S.intro)}</p>` : ''}${tel}
<form id="f"><label>Ваше имя<input name="name" required maxlength="120" autocomplete="name"></label><label>Телефон<input name="phone" inputmode="tel" autocomplete="tel" placeholder="+7 900 000-00-00"></label><label>Telegram — имя пользователя, если удобнее писать туда<input name="tg" autocomplete="off" placeholder="@имя_пользователя"></label><label>Как с вами связаться<select name="method">${methods.map(m => `<option value="${m}">${ASK_METHODS[m].charAt(0).toUpperCase() + ASK_METHODS[m].slice(1)}</option>`).join('')}</select></label><label>Ваш вопрос<textarea name="question" rows="5" maxlength="2000" required></textarea></label><p class="fine">Документы прикладывать не нужно — адвокат уточнит подробности, когда свяжется с вами.</p><input name="site" style="display:none" tabindex="-1" autocomplete="off"><input type="hidden" name="nonce" id="nonce"><label class="ck"><input type="checkbox" name="consent" id="ck"><span>Даю согласие на обработку моих персональных данных на условиях <a href="?ask=${esc(pid)}&consent=${esc(cur)}" target="_blank" rel="noopener">текста согласия</a></span></label><input type="hidden" name="consentVer" value="${esc(cur)}"><button type="submit" class="go" disabled>Отправить вопрос</button><p class="fine">Укажите телефон или Telegram. Без согласия вопрос отправить нельзя. Текст согласия открывается отдельной страницей.</p></form><div id="out"></div>
<script>(function(){var f=document.getElementById('f'),out=document.getElementById('out'),ck=document.getElementById('ck'),go=f.querySelector('.go');document.getElementById('nonce').value=(Math.random().toString(36).slice(2)+Date.now().toString(36)).slice(0,30);ck.onchange=function(){go.disabled=!ck.checked;};
f.onsubmit=function(e){e.preventDefault();var fd=new FormData(f);var body={ask:${JSON.stringify(pid)},action:'askreq'};fd.forEach(function(v,k){body[k]=v;});go.disabled=true;go.textContent='Отправляю…';
fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).then(function(r){return r.json()}).then(function(j){if(j.ok){f.style.display='none';var how={call:'позвонит',tg:'напишет в Telegram',wa:'напишет в WhatsApp',sms:'напишет SMS'}[j.method]||'свяжется с вами';out.innerHTML='<div class="ok">Вопрос отправлен. Номер обращения <b>'+j.code+'</b>.<br>Адвокат '+how+', как только сможет.</div>';}else{out.innerHTML='<div class="err">'+String(j.error||'Ошибка').replace(/[<>&]/g,'')+'</div>';go.disabled=!ck.checked;go.textContent='Отправить вопрос';}}).catch(function(){out.innerHTML='<div class="err">Нет связи — попробуйте ещё раз</div>';go.disabled=!ck.checked;go.textContent='Отправить вопрос';});};})();</script>`;
  return html(bookShell(title, body));
}

// ════════════════════════════════════════════════════════════
//  v191: ЗАКРЫТАЯ ССЫЛКА КАЛЕНДАРЯ (план по ЮрТопосу 13.10.2026, этап 6)
// ════════════════════════════════════════════════════════════
// icalget {url, from, to} (с секретным кодом): сервер скачивает календарь по закрытой ссылке и отдаёт программе события окна дат.
// Разрешены только адреса календарей Google и Apple — иначе сервер можно было бы заставить обращаться к любым адресам. Адрес — секрет
// пользователя (по нему календарь читается без входа): в журнал функции не пишется.
const ICAL_TIMEOUT = 12000, ICAL_MAX_BYTES = 8 * 1024 * 1024, ICAL_MAX_OUT = 3000000, ICAL_REDIRECTS = 3;
const ICAL_HOSTS = [
  { host: /^calendar\.google\.com$/i, path: /^\/calendar\/ical\/[^/]{3,200}\/(private-[0-9a-f]{16,64}|public)\/basic\.ics$/i },
  { host: /^p\d{1,3}-caldav\.icloud\.com$/i, path: /^\/published\/\d\/[A-Za-z0-9_\-]{10,600}$/ }
];
// адрес → проверенный https-адрес или '' (webcal:// — то же, что https://)
function icalUrlOk(raw) {
  let u; try { u = new URL(String(raw || '').trim().replace(/^webcals?:\/\//i, 'https://')); } catch (e) { return ''; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return '';
  return ICAL_HOSTS.some(h => h.host.test(u.hostname) && h.path.test(u.pathname)) ? u.href : '';
}
async function icalReadCapped(res, max) {
  if (res.body && typeof res.body.getReader === 'function') {
    const rd = res.body.getReader(), parts = []; let n = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; if (n > max) { try { await rd.cancel(); } catch (e) { /* штатно: поток уже закрыт */ } return null; } parts.push(value); }
    return Buffer.concat(parts.map(p => Buffer.from(p))).toString('utf8');
  }
  const t = await res.text(); return Buffer.byteLength(t, 'utf8') > max ? null : t;
}
// скачивание с переадресацией вручную: каждый следующий адрес проходит ту же проверку
async function icalFetch(url, timeoutMs) {
  const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeoutMs || ICAL_TIMEOUT);
  try {
    let cur = url;
    for (let i = 0; i <= ICAL_REDIRECTS; i++) {
      const r = await fetch(cur, { method: 'GET', redirect: 'manual', headers: { Accept: 'text/calendar, text/plain;q=0.5' }, signal: ctl.signal });
      if ([301, 302, 303, 307, 308].includes(r.status)) {
        const loc = r.headers && r.headers.get && r.headers.get('location'); let next = '';
        try { next = loc ? icalUrlOk(new URL(loc, cur).href) : ''; } catch (e) { next = ''; }
        if (!next) return { ok: false, error: 'redirect', note: 'календарь переадресовал на адрес, который сервер не открывает' };
        cur = next; continue;
      }
      if (r.status === 404 || r.status === 410) return { ok: false, error: 'not_found', note: 'по ссылке календаря нет — ссылку сбросили или календарь удалён' };
      if (r.status === 401 || r.status === 403) return { ok: false, error: 'denied', note: 'календарь не открылся по ссылке — для Google нужна «Закрытая ссылка в формате iCal», для Apple — общий доступ «Общедоступный календарь»' };
      if (!r.ok) return { ok: false, error: 'http_' + r.status };
      const text = await icalReadCapped(r, ICAL_MAX_BYTES);
      if (text === null) return { ok: false, error: 'too_big', note: 'календарь больше 8 МБ — для «Быстрых записей» заведите отдельный календарь' };
      return { ok: true, text };
    }
    return { ok: false, error: 'redirect', note: 'слишком много переадресаций' };
  } catch (e) {
    return { ok: false, error: e && e.name === 'AbortError' ? 'timeout' : 'network', note: e && e.name === 'AbortError' ? 'календарь не ответил за 12 секунд' : 'сервер не смог открыть ссылку календаря' };
  } finally { clearTimeout(timer); }
}
// строки iCal с развёрнутыми переносами (RFC 5545, п. 3.1); значение — после первого двоеточия вне кавычек
const icalJsonBytes = s => Buffer.byteLength(JSON.stringify(String(s)), 'utf8') - 2;
const icalUnfold = text => String(text || '').replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
function icalValue(line) { let q = false; for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ':' && !q) return line.slice(i + 1); } return ''; }
function icalDate(line) { const m = /^(\d{4})(\d{2})(\d{2})/.exec(icalValue(line)); return m ? m[1] + '-' + m[2] + '-' + m[3] : ''; }
// события окна [from; to] и описания поясов; повторяющееся событие (RRULE) с началом не позже конца окна — с правилом.
// Дата сверяется по записи DTSTART как есть, а Google пишет время в UTC (…Z): заседание 01:00 по Москве записано вчерашней датой. Поэтому
// окно шире на день с каждой стороны — точную дату в поясе пользователя считает программа и лишнее отбрасывает сама
const icalDayAdd = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
function icalWindow(text, from0, to0) {
  const from = icalDayAdd(from0, -1), to = icalDayAdd(to0, 1);
  const lines = icalUnfold(text), head = [], keep = []; let blk = null, depth = 0, total = 0, kept = 0, rec = 0, name = '';
  for (const ln of lines) {
    if (!blk) {
      if (/^BEGIN:(VEVENT|VTIMEZONE)$/i.test(ln)) { blk = [ln]; depth = 1; continue; }
      if (/^X-WR-CALNAME[:;]/i.test(ln)) name = icalValue(ln).slice(0, 200);
      if (/^(BEGIN|END):VCALENDAR$/i.test(ln) || /^(VERSION|PRODID|CALSCALE|METHOD|X-WR-CALNAME|X-WR-TIMEZONE)[:;]/i.test(ln)) head.push(ln);
      continue;
    }
    blk.push(ln);
    if (/^BEGIN:/i.test(ln)) depth++;
    else if (/^END:/i.test(ln) && --depth === 0) {
      const b = blk; blk = null;
      if (/^BEGIN:VTIMEZONE$/i.test(b[0])) { keep.push(b); continue; }
      total++;
      const ds = b.find(l => /^DTSTART[:;]/i.test(l)), d = ds ? icalDate(ds) : '', isRec = b.some(l => /^RRULE[:;]/i.test(l));
      if (!d) continue;
      if ((isRec && d <= to) || (d >= from && d <= to)) { keep.push(b); kept++; if (isRec) rec++; }
    }
  }
  const out = [head.find(l => /^BEGIN:VCALENDAR$/i.test(l)) || 'BEGIN:VCALENDAR'].concat(head.filter(l => !/^(BEGIN|END):VCALENDAR$/i.test(l)));
  // предел — в байтах ответа: строка уходит в JSON, где кириллица занимает 2 байта, а перевод строки — 4 (\r\n экранируются)
  let ics = out.join('\r\n'), cut = 0, size = icalJsonBytes(ics + '\r\nEND:VCALENDAR');
  for (const b of keep) { const piece = '\r\n' + b.join('\r\n'), sz = icalJsonBytes(piece); if (size + sz > ICAL_MAX_OUT) { cut++; continue; } ics += piece; size += sz; }
  return { ics: ics + '\r\nEND:VCALENDAR', total, kept: kept - cut, recurring: rec, cut, name };
}
async function icalGet(body) {
  const url = icalUrlOk(body.url);
  if (!url) return { ok: false, error: 'host', note: 'сервер открывает только закрытые ссылки календарей Google (calendar.google.com/…/basic.ics) и Apple (…icloud.com/published/…)' };
  const iso = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '';
  const now = new Date(), from = iso(body.from) || new Date(now.getTime() - 30 * 864e5).toISOString().slice(0, 10), to = iso(body.to) || new Date(now.getTime() + 366 * 864e5).toISOString().slice(0, 10);
  const g = await icalFetch(url);
  if (!g.ok) return g;
  if (!/BEGIN:VCALENDAR/i.test(g.text)) return { ok: false, error: 'not_ics', note: 'по ссылке не календарь — проверьте, что скопирована ссылка в формате iCal' };
  const w = icalWindow(g.text, from, to);
  return { ok: true, ics: w.ics, total: w.total, kept: w.kept, recurring: w.recurring, cut: w.cut, name: w.name, from, to, host: new URL(url).hostname, now: Date.now() };
}

// Экспорт внутренностей для автотестов (на работу функции не влияет)
module.exports._test = { remindMark, remindClaim, remindRelease, REMIND_CLAIM_MS, icalGet, icalUrlOk, icalFetch, icalWindow, icalUnfold, icalValue, ICAL_HOSTS, askPublish, askGet, askAck, askRequest, askPage, askNotify, askConsentOf, asksLoad, asksPrune, askTg, ASK_TG_RE, bookPublish, bookPage, bookNotify, bookConsentOf, bookConsentKey, consentVer, eventsSave, calToken, calTokenOk, calServe, CAL_LABEL, publishIcs, deltaChain, deltaList, deltaGet, deltaPrune, deltaKey, deltaPrefix, DELTA_KEEP, dbPut, dbVer, dbClaimVer, dbCommitVer, dbClaimKey, bookingsLoad, bookingsSave, bookRequest, bookSet, bookGet, corsProbe, corsSet, corsCheck, lockAcquire, lockRelease, lockHeld, eventsPut, eventsLoad, evLockPrefix, LOCK_TTL, ensureCors, snapPut, snapCommit, snapGet, s3Signed, pick, pickAfter, sigV4, sha256hex, eventsMerge, evNormalize, bearerOf, presign, presignRaw, sttTextFrom, splitChunks, audioFormatOf, bookTaken, bookShell, blobKey, remindPut, remindTick, mskDateISO };
