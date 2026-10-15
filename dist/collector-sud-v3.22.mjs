#!/usr/bin/env node
// ════════════════════════════════════════════════════════════════════
//  КОЛЛЕКТОР СУДОВ для «CRM Адвоката» (v183)
//
//  Что делает: обходит ссылки дел с сайтов судов, извлекает назначенные
//  заседания, результаты и публикации актов и отправляет их как события
//  мониторинга на ВАШ личный сервер (POST /bridge, action=eventsput).
//  CRM забирает их через «Мониторинг → Получить сейчас» и предлагает
//  создать заседание/задачу одним нажатием.
//
//  Поддержано: суды общей юрисдикции ГАС «Правосудие» (*.sudrf.ru),
//  портал судов Москвы (mos-gorsud.ru, mos-sud.ru) и похожие таблицы.
//  КАД Арбитр скриптам недоступен (антибот) — такие ссылки пропускаются
//  с пометкой в журнале; используйте «Электронный страж» (guard.arbitr.ru).
//
//  Запуск:  node collector-sud.mjs            — собрать и отправить
//           node collector-sud.mjs --dry      — собрать, показать, НЕ отправлять
//           node collector-sud.mjs --test     — самопроверка парсера (без сети)
//           node collector-sud.mjs --config путь/к/файлу.json
//
//  Рядом со скриптом должны лежать:
//    collector-config.json      — настройки (образец: collector-config-example.json)
//    дела-для-коллектора.json   — список дел (CRM: Ещё → Мониторинг → Коллектор судов)
//
//  Требуется Node.js 18+ (https://nodejs.org, версия LTS). Зависимостей нет.
//
//  v3.22: вид жалобы входит в ключ события complaint — апелляционная и частная жалобы одного лица в один день не сливаются (аудит сборки 157, A3).
//  v3.21: жалобы в дайджесте Telegram без имён — новые и изменившиеся (слепок хранит состояние жалобы), раздел «Жалобы за 3 дня» (15.10.2026).
//  v3.20: дело на странице узнаётся по УИД и по любому номеру дела из программы (не только своей инстанции); стороны — только из
//         строки таблицы; жалобы (вкладка «ЖАЛОБЫ» кассации, «Обжалование решений» первой инстанции) — событие complaint (15.10.2026).
//  v3.19: код функции — только в теле запроса и сравнивается без утечки по времени; страница суда — не больше 5 МБ; переадресация —
//         только в пределах сайта ссылки и не во внутренние сети; предел ожидания у доставки, бакета и Telegram (аудит 14.10.2026).
//  v3.18: пустой перечень дел принимается (последнее дело снято с наблюдения), сбор по нему — штатно, «дел для обхода нет»;
//         collectone для КАД говорит о СУДиДЕЛО, только если задан SUDODELO_API_KEY (аудит 11.10.2026).
//  v3.17: номер дела ищется без различий в тире, пробелах и «№»; при расхождении названо, какой номер на странице; страница
//         вовсе без номера дела — «не распознана», а не «другое дело».
//  v3.16: честное состояние сбора — state: ok / partial / error и stateText; слепок прошлого прогона — только после доставки
//  v3.15: BRIDGE_URL и BRIDGE_SECRET обрезаются от пробелов и переносов строк; действие bridgecheck — проверка доставки
//  на личный сервер (ping кодом коллектора; коды не передаются и не возвращаются, сравнение по SHA-256)
//  v3.14: исправлено «kind is not defined» — в 3.13 сбор по ссылкам на сайты судов падал (переменная вне области видимости)
//  v3.13: API Assist (service.api-assist.com, ГАС «Правосудие» по ссылке дела) — резервный источник
//  карточки, когда сайт суда не отдал страницу или таблицы не распознаны (API_ASSIST_KEY; режим
//  API_ASSIST_MODE = fallback | primary | off; бесплатный тариф — 200 запросов в месяц).
//  v3: дополнительно парсит «ДВИЖЕНИЕ ДЕЛА» (событие · результат · основание)
//  и УИД дела; тот же файл работает ОБЛАЧНОЙ ФУНКЦИЕЙ Яндекс Облака (handler) —
//  список дел лежит в вашем бакете, сбор идёт по таймеру без компьютера.
//  v3.1: в события добавлены судья (со страницы суда) и инстанция —
//  по итогам сверки полей с открытым API СУДиДЕЛО.
//  v3.2: CORS-заголовки для кнопок серверного сбора в CRM (браузер шлёт preflight).
//  v3.3: Telegram-дайджест после сбора — заседания на ближайшие дни, движение дела,
//  итоги и ошибки — в тот же бот и чат, что у уведомлений CRM (переменные TG_TOKEN, TG_CHAT).
//  Действия функции: linksput (загрузить список дел), collect (собрать сейчас),
//  status (когда собирал и что вышло). Настройка: КОЛЛЕКТОР_СУДОВ_настройка.md.
//  v3.4: (1) строки «Движения дела» с датами судебных актов помечаются raw.act
//  (decision / fullDecision / appeal / cass / inForce) — CRM предлагает записать дату
//  в дело и рассчитать сроки; (2) слепок прошлого прогона (state.json в бакете или
//  collector-state.json рядом) → точные изменения: перенесённые заседания, новые
//  результаты, новые акты — отдельным разделом дайджеста; (3) сеть: один повтор
//  после паузы при сбое, обход разных судов параллельно (до 3), внутри одного
//  суда — по-прежнему последовательно с паузой delayMs.
//  v3.5: КАД Арбитр через открытое API СУДиДЕЛО (api-sudodelo.torkndgov.ru): арбитражные
//  ссылки больше не пропускаются — дело заводится в СУДиДЕЛО (номер, ссылка на КАД, суд;
//  клиент — заглушка, ФИО не передаются), а заседания (event-schedule) и «Движение дела»
//  (progress, HTML) читаются оттуда и превращаются в те же события. Переменные функции /
//  поля конфига: SUDODELO_API_KEY (sudodeloApiKey), SUDODELO_API_URL (необязательно),
//  SUDODELO_AUTOCREATE=0 — не заводить дела автоматически.
//  v3.6: в каждом событии поле crmNumber — номер дела CRM, от ссылки которого оно получено:
//  CRM привязывает событие точно к этому делу (одинаковые номера в разных судах больше не
//  смешиваются). Сверка страницы: если у ссылки в CRM указан номер дела в суде, а на
//  странице его нет — события не отправляются, в журнале и статусе пометка
//  «ссылка ведёт на другое дело» (защита от ссылки, скопированной из чужого дела).
//  v3.7: карточка дела — parseCaseCard снимает со страницы номер, УИД, судью, суд, дату
//  поступления, категорию, результат и стороны; уходит событием casecard (CRM заполняет
//  пустые поля дела). Действие collectone {url, courtNo, number} — разобрать одну ссылку
//  сразу (CRM вызывает после сохранения ссылки в деле): ответ {ok, card, events}.
// ════════════════════════════════════════════════════════════════════
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns';
import tls from 'node:tls';
import crypto from 'node:crypto';

const COLLECTOR_VER = '3.22';
// Сетевые послабления ТОЛЬКО ради сайтов судов: у многих *.sudrf.ru
// самоподписанные/просроченные сертификаты и устаревший TLS, которые Node
// по умолчанию отвергает («fetch failed»). Коллектор лишь читает публичные
// страницы, поэтому проверку сертификатов отключаем осознанно.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
try { tls.DEFAULT_MIN_VERSION = 'TLSv1'; } catch (e) {}
try { tls.DEFAULT_CIPHERS = tls.DEFAULT_CIPHERS + ':@SECLEVEL=0'; } catch (e) {}
try { dns.setDefaultResultOrder('ipv4first'); } catch (e) {} // Windows/IPv6 нередко ломает доступ к судам

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const DRY = ARGS.includes('--dry');
const TEST = ARGS.includes('--test');
const cfgArg = ARGS.indexOf('--config');
const CONFIG_PATH = cfgArg >= 0 && ARGS[cfgArg + 1] ? ARGS[cfgArg + 1] : path.join(DIR, 'collector-config.json');
const LOG_PATH = path.join(DIR, 'collector-log.txt');

// ── мелкие помощники ────────────────────────────────────────────────
const pad2 = n => String(n).padStart(2, '0');
const isoOf = (dmy) => { // «25.09.2026» → «2026-09-25»
  const m = String(dmy || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  return m ? `${m[3]}-${pad2(m[2])}-${pad2(m[1])}` : '';
};
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const shiftISO = (base, days) => { const d = new Date(base + 'T12:00:00'); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
function log(line) {
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const msg = `[${stamp}] ${line}`;
  console.log(msg);
  try { fs.appendFileSync(LOG_PATH, msg + '\n'); } catch (e) { /* журнал необязателен */ }
}

// ── декодирование страниц (sudrf отдаёт windows-1251) ───────────────
const CP1251_HI =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏђ‘’“”•–—\u0098™љ›њќћџ\u00A0ЎўЈ¤Ґ¦§Ё©Є«¬\u00AD®Ї' +
  '°±Ііґµ¶·ё№є»јЅѕїАБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ' +
  'абвгдежзийклмнопрстуфхцчшщъыьэюя';
function decode1251(buf) {
  let out = '';
  for (const b of buf) out += b < 0x80 ? String.fromCharCode(b) : CP1251_HI[b - 0x80];
  return out;
}
function decodeBody(buf) {
  const ascii = Buffer.from(buf).toString('latin1');
  const is1251 = /charset\s*=\s*["']?windows-1251/i.test(ascii.slice(0, 4000));
  if (is1251) {
    try { return new TextDecoder('windows-1251').decode(buf); }
    catch (e) { return decode1251(Buffer.from(buf)); }
  }
  return Buffer.from(buf).toString('utf8');
}

// ── разбор HTML без внешних библиотек ────────────────────────────────
function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ').trim();
}
function rowsOf(html) { // все <tr> страницы → массив массивов текстов ячеек
  const rows = [];
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html))) {
    const cells = [];
    const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let c;
    while ((c = tdRe.exec(m[1]))) cells.push(stripTags(c[1]));
    if (cells.some(x => x)) rows.push(cells);
  }
  return rows;
}

const RE_DATE = /(\d{1,2}\.\d{1,2}\.\d{4})/;
const RE_TIME = /\b([01]?\d|2[0-3]):([0-5]\d)\b/;
const RE_HEARING = /заседани|слушани|беседа|подготовк|рассмотрени/i;
// v3.8: строки движения, которые НЕ заседания, даже если в них есть дата и время: принятие иска к производству, регистрация, передача судье, оформление, сдача в отдел, направление копий, возврат из инстанции
const RE_NOT_HEARING = /принят\S* к производству|принятии (иска|заявления|жалобы)|о принятии|регистрац|передач\S* (материалов|дела)|дело оформлен|сдан\S* в отдел|направлен\S* (копи|дела|в )|возвращен\S* (из|в )|поступлени|вручен|изготовлен|вынесен\S* (определени|постановлени)|определени\S* о (подготовке|назначении|принятии|возбуждении|оставлении|возврат)|назначени\S* дела к/i; // v3.10: «Вынесено определение о подготовке/назначении дела…» — акт судьи, не заседание; собеседование (подготовка дела) остаётся заседанием
const RE_ACT_KIND = /решени|постановлени|определени|приговор|судебн\w*\s+акт/i;
const RE_ACT_PUB = /опубликован|размещен|изготовлен/i;
const RE_UID = /\b\d{2}[A-Z]{2}\d{4}-\d{2}-\d{4}-\d{6}-\d{2}\b/; // 77RS0031-01-2026-004567-89

// УИД дела из шапки карточки («Уникальный идентификатор дела»)
function parseUid(html) {
  const m = String(html || '').match(RE_UID);
  return m ? m[0] : '';
}
const norm = s => String(s || '').replace(/\s+/g, ' ').trim();
const h8 = s => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex').slice(0, 8);

// ── v3.7: карточка дела — поля по подписям (ГАС «Правосудие» и портал Москвы) ──
// Страница режется на текстовые ячейки; для каждой подписи берётся следующая непустая ячейка.
function cellsOf(html) {
  return String(html || '').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(td|th|tr|div|p|li|h\d)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .split('\n').map(x => norm(decodeEntities(x))).filter(Boolean);
}
// v3.8: сущности HTML в тексте карточки (&rarr; → «→», &laquo; и числовые)
const ENT = { nbsp: ' ', quot: '"', amp: '&', lt: '<', gt: '>', laquo: '«', raquo: '»', rarr: '→', larr: '←', ndash: '–', mdash: '—', hellip: '…', apos: "'" };
function decodeEntities(t) { return String(t || '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => { if (e[0] === '#') { const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return isFinite(code) ? String.fromCodePoint(code) : m; } return ENT[e.toLowerCase()] !== undefined ? ENT[e.toLowerCase()] : m; }); }
const CARD_LABELS = {
  number: /^(номер дела( ?[~(\/].{0,20})?|№ дела|дело №|номер дела в суде|номер материала)\s*:?$/i, uid: /^(уникальный идентификатор дела|уид)\s*:?$/i, // v3.12: «Номер дела ~ материала» (ГАС «Правосудие»)
  judge: /^(судья|председательствующий судья|судья, рассматривающий дело|судья-докладчик|судья докладчик)\s*:?$/i, registered: /^(дата поступления|дата регистрации|дата поступления в суд)\s*:?$/i,
  category: /^(категория дела|категория)\s*:?$/i, result: /^(результат рассмотрения|результат)\s*:?$/i, decided: /^(дата рассмотрения|дата решения)\s*:?$/i
};
const ROLE_RE = /^(истец|ответчик|третье лицо|заявитель|заинтересованное лицо|должник|взыскатель|административный истец|административный ответчик|представитель|прокурор|потерпевший|подсудимый|обвиняемый)/i;
// v3.20: ячейка рядом с ролью, которая именем быть не может — подписи соседних таблиц и заголовки
const PARTY_NOT_NAME = /^(вышестоящий|нижестоящий)\s+суд|^судебн\S*\s+акт|^(суд|дата|номер|результат|инстанция|категория|статья|перечень)(?![а-яёa-z])|^№|#\d|^вид лица|^лицо$|^фамилия|^наименование/i;
function parseCaseCard(html) {
  const cells = cellsOf(html), card = { parties: [] };
  // v3.20: у дат — только ячейка с датой (заголовок таблицы жалоб «Дата поступления» стоит перед «Процессуальный статус заявителя»)
  const pick = (re, needDate) => { for (let i = 0; i < cells.length - 1; i++) if (re.test(cells[i])) { const v = cells[i + 1]; if (needDate && !RE_DATE.test(v)) continue; if (v && v.length < 300 && !Object.values(CARD_LABELS).some(r => r.test(v))) return v; } return ''; };
  for (const [k, re] of Object.entries(CARD_LABELS)) { const v = pick(re, k === 'registered' || k === 'decided'); if (v) card[k] = v; }
  if (!card.uid) card.uid = parseUid(html);
  // v3.12: номер в любом виде — 2-1500/2026, 33а-123/2026, 8Г-12345/2026, 88-1/2026, А11-1234/2026, 02-2485/2026
  const RE_CASE_NO = /(?:[АA]\d{2}|\d{1,2}[а-яёa-z]{0,2})[-–]\d{1,7}\/\d{4}/i;
  if (card.number) { const m = card.number.match(RE_CASE_NO); card.number = m ? m[0].replace(/–/g, '-') : ''; }
  if (!card.number) { // заголовок карточки «ДЕЛО № 33-3331/2026» или «Дело №…» в любой ячейке
    for (const t of cells) { const h = t.match(/(?:^|\s)дело\s*№\s*([^\s,;]+)/i); if (h) { const m = h[1].match(RE_CASE_NO); if (m) { card.number = m[0].replace(/–/g, '-'); break; } } }
  }
  if (!card.number) delete card.number;
  for (const k of ['registered', 'decided']) if (card[k]) { const m = card[k].match(RE_DATE); card[k] = m ? isoOf(m[0]) : ''; }
  const t = String(html || '').match(/<title>([^<]{3,160})<\/title>/i); if (t) card.court = norm(t[1]).replace(/\s*[-–—|].*$/, '');
  // стороны: «Истец: ФИО» одной ячейкой (Москва) или «Вид лица | Лицо» (ГАС) — роль и имя в ОДНОЙ строке таблицы.
  // v3.20 (жалоба 15.10.2026, урок 155): до 3.19 роль и имя брались соседними ячейками всего текста страницы, и роль без имени
  // «прихватывала» первую ячейку следующей вкладки («Вышестоящий суд», «Судебный акт #1 (Решения)» со страницы кассации)
  const seen = new Set(), add = (role, name) => { name = norm(name); if (!name || seen.has(name)) return; seen.add(name); card.parties.push({ role, name }); };
  for (const c of cells) { const m = c.match(/^(истец|ответчик|третье лицо|заявитель|заинтересованное лицо|должник|взыскатель|административн\S+ истец|административн\S+ ответчик|потерпевший|подсудимый|обвиняемый)\s*:\s*(.{3,120})$/i); if (m) add(cap(m[1]), m[2]); }
  const rows = rowsOf(html), cmpRows = complaintRows(rows).idx;
  rows.forEach((rc, ri) => {
    if (cmpRows.has(ri)) return;
    for (let i = 0; i < rc.length - 1; i++) {
      const c = rc[i]; if (!ROLE_RE.test(c) || c.length >= 40) continue;
      const nm = decodeEntities(rc.slice(i + 1).find(x => x) || '');
      if (nm && !ROLE_RE.test(nm) && nm.length < 120 && /[А-Яа-яA-Za-z]{2,}/.test(nm) && !PARTY_NOT_NAME.test(nm)) add(cap(c.replace(/\s*:$/, '')), nm);
      break;
    }
  });
  card.parties = card.parties.slice(0, 20);
  return card;
}
const cap = s => { s = norm(s).toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
function buildCardEvent(card, ctx) {
  if (!card || !(card.number || card.uid || card.judge || card.parties.length)) return null;
  const key = ctx.uid || card.uid || ctx.courtNo || ctx.url || '';
  return { externalId: 'card:' + h8(key + '|' + ctx.stage), title: `Карточка дела ${card.number || ctx.courtNo || ''}`.trim(), date: card.registered || todayISO(), eventType: 'casecard',
    courtNo: ctx.courtNo || card.number || '', caseUid: ctx.uid || card.uid || '', judge: card.judge || '', source: 'Коллектор судов', crmNumber: ctx.number || '',
    raw: JSON.stringify({ card, st: ctx.stage || '', url: ctx.url || '' }) };
}

// «ДВИЖЕНИЕ ДЕЛА»: секция карточки → строки {title, date, time, result, basis}
function parseFlow(html) {
  const src = String(html || '');
  const mHead = src.match(/ДВИЖЕНИЕ\s+ДЕЛА/i);
  if (!mHead) return [];
  const mTab = src.slice(mHead.index).match(/<table[\s\S]*?<\/table>/i);
  if (!mTab) return [];
  const rows = rowsOf(mTab[0]);
  if (!rows.length) return [];
  // Карта колонок по строке заголовков; без неё — эвристика по содержимому
  let iT = 0, iD = -1, iTime = -1, iR = -1, iB = -1, start = 0;
  const head = rows[0].map(x => x.toLowerCase());
  if (head.some(x => /наименование|результат|основани/.test(x))) {
    start = 1;
    const f = re => head.findIndex(x => re.test(x));
    iT = Math.max(0, f(/наименование|событие/));
    iD = head.findIndex(x => x.includes('дата') && !x.includes('размещ'));
    iTime = f(/время/);
    iR = f(/результат/);
    iB = f(/основани/);
  }
  const out = [];
  for (const cells of rows.slice(start)) {
    const title = norm(cells[iT] || cells[0] || '');
    let date = '';
    if (iD >= 0) { const mm = (cells[iD] || '').match(RE_DATE); date = mm ? mm[1] : ''; }
    else { const anyD = cells.find(x => RE_DATE.test(x)); date = anyD ? anyD.match(RE_DATE)[1] : ''; }
    if (!title || !date || /^судья/i.test(title)) continue;
    const time = (iTime >= 0 && RE_TIME.test(cells[iTime] || '')) ? cells[iTime].match(RE_TIME)[0]
               : ((cells.join(' ').match(RE_TIME) || [])[0] || '');
    out.push({ title, date, time,
      result: iR >= 0 ? norm(cells[iR] || '') : '',
      basis:  iB >= 0 ? norm(cells[iB] || '') : '' });
  }
  return out;
}

// События «движения дела»: merge на сервере идёт по source+externalId,
// хэш считается ТОЛЬКО от даты и названия — появившийся результат/основание
// обновит существующую запись, а не создаст дубль (механика CRM v190)
// v3.4: какой судебный акт описывает строка движения — по названию и результату, с учётом инстанции карточки
function flowActKind(title, result, stage) {
  const t = `${title || ''} ${result || ''}`.toLowerCase();
  if (/мотивированн\S* (решени|приговор)|решени\S* в окончательной форме|окончательн\S* форм/.test(t)) return 'fullDecision';
  if (/вступил\S* в законную силу/.test(t)) return 'inForce';
  const isApp = /апелляц/i.test(stage || ''), isCass = /кассац/i.test(stage || '');
  if (isCass && /(вынесен\S* (кассационн\S* )?(определени|постановлени)|оставлен\S* без изменени|отменен|изменен|жалоба оставлена)/.test(t)) return 'cass';
  if (isApp && /(вынесен\S* (апелляционн\S* )?(определени|постановлени)|оставлен\S* без изменени|отменен|изменен|жалоба оставлена)/.test(t)) return 'appeal';
  if (!isApp && !isCass && /(вынесен\S* решени|решение вынесен|решение по делу|вынесен\S* приговор|постановлен\S* приговор|вынесен\S* постановлени\S* по делу|производство прекращен|без рассмотрения|заочн\S* решени)/.test(t)) return 'decision';
  return '';
}
function buildFlowEvents(flow, ctx) {
  const key = ctx.uid || ctx.courtNo || ctx.number || ctx.url || '';
  const ev = [];
  for (const f of flow) {
    const dISO = isoOf(f.date);
    if (!dISO) continue;
    const raw = {};
    if (f.result) raw.result = f.result;
    if (f.basis) raw.basis = f.basis;
    if (f.time) raw.time = f.time;
    if (ctx.stage) raw.st = ctx.stage; // инстанция: лента дела объединяет все инстанции
    const act = flowActKind(f.title, f.result, ctx.stage); if (act) raw.act = act; // v3.4
    ev.push({
      externalId: `flow:${key}:${h8(dISO + '|' + norm(f.title).toLowerCase())}`,
      title: f.title, date: dISO, eventType: 'caseflow',
      courtNo: ctx.courtNo || '', caseUid: ctx.uid || '', judge: ctx.judge || '', source: 'Коллектор судов', crmNumber: ctx.number || '', court: ctx.court || '',
      raw: JSON.stringify(raw)
    });
  }
  return ev;
}

// ── v3.20: жалобы — вкладка «ЖАЛОБЫ» кассационных судов, «ОБЖАЛОВАНИЕ РЕШЕНИЙ, ОПРЕДЕЛЕНИЙ (ПОСТ.)» первой инстанции ──
// Таблица узнаётся по строке заголовков: столбец со словом «жалоб…» и столбец «Дата поступления…»; столбцы — по словам
// заголовков, порядок и число столбцов не важны. Разметка настоящей страницы 2kas.sudrf.ru не проверена (сайт закрыт для
// роботов): названия столбцов — со снимка пользователя 15.10.2026; первая инстанция — по памяти о ГАС «Правосудие».
const CMP_COLS = [['date', /^дата поступления(?! исправл)/], ['kind', /вид жалоб|вид обращ/], ['by', /кем подан|лиц[оа],? подавш|подавш\S* жалоб/],
  ['status', /процессуальн\S* (статус|положени)/], ['result', /^результат/], ['noMotion', /без движени/], ['fixDue', /срок (для )?устранени/],
  ['fixed', /исправленн/], ['sentUp', /направлени\S* (дела )?в вышестоящ/], ['decided', /вынесени\S* определени|по итогам/], ['returned', /возврат/],
  ['toStudy', /передачи жалобы/], ['withCase', /истребовани/]];
function complaintHeadCols(cells) {
  const head = cells.map(x => String(x || '').toLowerCase());
  if (cells.length < 2 || !head.some(h => /жалоб/.test(h)) || !head.some(h => /^дата поступления/.test(h))) return null;
  const col = {}; for (const [k, re] of CMP_COLS) { const i = head.findIndex(h => re.test(h)); if (i >= 0) col[k] = i; }
  return col.date === undefined || (col.by === undefined && col.kind === undefined) ? null : col;
}
// строки таблиц жалоб среди всех <tr> страницы: { list, idx } — idx нужен parseCaseCard, чтобы не брать стороны из таблицы жалоб
function complaintRows(rows) {
  const list = [], idx = new Set(); let col = null;
  (rows || []).forEach((cells, ri) => {
    const h = complaintHeadCols(cells); if (h) { col = h; idx.add(ri); return; }
    if (!col) return;
    const dm = String(cells[col.date] || '').match(RE_DATE);
    // строка без даты поступления в своём столбце — таблица жалоб кончилась (пустые строки-прокладки пропускаются)
    if (!dm) { if (cells.some(x => /[А-Яа-яA-Za-z]{3,}/.test(x))) col = null; return; }
    idx.add(ri);
    const g = k => col[k] === undefined ? '' : norm(decodeEntities(cells[col[k]] || ''));
    const dOf = k => { const x = g(k).match(RE_DATE); return x ? isoOf(x[1]) : ''; };
    list.push({ date: isoOf(dm[1]), kind: g('kind'), by: g('by'), status: g('status'), result: g('result'), noMotion: dOf('noMotion'), fixDue: dOf('fixDue'),
      fixed: dOf('fixed'), sentUp: dOf('sentUp'), decided: dOf('decided'), returned: dOf('returned'), toStudy: dOf('toStudy'), withCase: g('withCase') });
  });
  const seen = new Set();
  return { list: list.filter(x => { const k = x.date + '|' + x.kind + '|' + x.by; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 20), idx };
}
function parseComplaints(html) { return complaintRows(rowsOf(html)).list; }
// инстанция жалобы: по виду жалобы («Кассационная жалоба», «Частная жалоба» — апелляция), иначе по инстанции страницы
function cmpInstOf(x, stage) {
  const t = [x.kind, x.status, x.result].join(' ').toLowerCase();
  if (/надзорн/.test(t)) return 'Надзор'; if (/кассацион/.test(t)) return 'Кассация'; if (/апелляцион|частн\S* жалоб/.test(t)) return 'Апелляция';
  return /кассац/i.test(stage || '') ? 'Кассация' : /апелляц/i.test(stage || '') ? 'Апелляция' : /надзор/i.test(stage || '') ? 'Надзор' : '';
}
// событие complaint: ключ — дата, инстанция, кто подал и вид жалобы (v3.22; один и тот же факт с двух страниц сводится на сервере по
// externalId; состояния — без движения, срок, результат — в ключ не входят: их изменение обновляет ту же запись);
// заголовок несёт состояние (без движения, срок устранения, результат) — изменение состояния обновляет запись в программе
function buildComplaintEvents(list, ctx) {
  const key = ctx.uid || ctx.courtNo || ctx.number || ctx.url || '';
  const ru = iso => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '';
  const ev = [];
  for (const x of list || []) {
    if (!x || !x.date) continue;
    const inst = cmpInstOf(x, ctx.stage);
    const kind = cmpKindOf(x, inst);
    const tail = cmpTail(x);
    const title = `Подана ${kind} ${ru(x.date)}${x.by ? ' — ' + x.by : ''}${tail.length ? ' · ' + tail.join(' · ') : ''}`;
    const raw = { st: ctx.stage || '', inst, kind: x.kind || '', by: x.by || '', status: x.status || '', result: x.result || '', noMotion: x.noMotion || '', fixDue: x.fixDue || '',
      fixed: x.fixed || '', sentUp: x.sentUp || '', decided: x.decided || '', returned: x.returned || '', url: ctx.url || '' };
    ev.push({ externalId: `cmp:${key}:${h8(x.date + '|' + inst + '|' + norm(x.by).toLowerCase() + cmpKindKey(x))}`, title, date: x.date, eventType: 'complaint',
      courtNo: ctx.courtNo || '', caseUid: ctx.uid || '', judge: '', source: 'Коллектор судов', crmNumber: ctx.number || '', court: ctx.court || '', raw: JSON.stringify(raw) });
  }
  return ev;
}

// v3.22: часть ключа события — нормализованный вид жалобы со страницы («|частная жалоба»); без вида — пусто (ключ 3.21 сохраняется)
function cmpKindKey(x) {
  const k = norm(String(x && x.kind || '')).toLowerCase();
  return k ? '|' + k : '';
}
// v3.21: вид жалобы словами и хвост состояния — общие для заголовка события (с именем) и дайджеста (без имени)
function cmpKindOf(x, inst) {
  return x.kind ? x.kind.toLowerCase() : inst === 'Кассация' ? 'кассационная жалоба' : inst === 'Апелляция' ? 'апелляционная жалоба' : inst === 'Надзор' ? 'надзорная жалоба' : 'жалоба';
}
function cmpTail(x) {
  const ru = iso => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '';
  return [x.noMotion ? 'оставлена без движения ' + ru(x.noMotion) + (x.fixDue ? ', срок устранения до ' + ru(x.fixDue) : '') : (x.fixDue ? 'срок устранения недостатков до ' + ru(x.fixDue) : ''),
    x.fixed ? 'исправленная жалоба ' + ru(x.fixed) : '', x.result || '', x.decided ? 'определение ' + ru(x.decided) : '', x.sentUp ? 'дело направлено в вышестоящий суд ' + ru(x.sentUp) : '',
    x.returned ? 'возвращена ' + ru(x.returned) : ''].filter(Boolean);
}
// v3.21: состояние жалобы одной строкой — для слепка (изменилось ли с прошлого сбора)
function cmpStateOf(raw) {
  return [raw.noMotion, raw.fixDue, raw.fixed, raw.result, raw.decided, raw.sentUp, raw.returned].map(v => String(v || '')).join('|');
}
// v3.21: строка жалобы для дайджеста Telegram — без имени подавшего (только статус заявителя: «истец», «ответчик»)
function cmpDigestText(e) {
  const raw = safeJson(e.raw);
  const ru = iso => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '';
  const tail = cmpTail(raw);
  return `подана ${cmpKindOf(raw, raw.inst || '')} ${ru(e.date)}${raw.status ? ' (' + String(raw.status).toLowerCase() + ')' : ''}${tail.length ? ' · ' + tail.join(' · ') : ''}`;
}

// Универсальный разбор карточки дела: заседания, публикации актов, судья
function parseCasePage(html) {
  const out = { hearings: [], acts: [], judge: '' };
  for (const cells of rowsOf(html)) {
    const joined = cells.join(' | ');
    if (!out.judge && /^судья/i.test(cells[0] || '') && cells[1]) out.judge = cells[1];
    const dm = joined.match(RE_DATE);
    if (!dm) continue;
    const date = dm[1];
    const label = (cells[0] || '').slice(0, 120);
    const tm = joined.match(RE_TIME);
    if (RE_HEARING.test(label) && !RE_NOT_HEARING.test(label)) { // v3.8: «Решение вопроса о принятии иска…» и подобное — не заседание
      const iDate = cells.findIndex(x => RE_DATE.test(x));
      let room = '', result = '';
      for (const cell of cells.slice(iDate + 1)) {
        const t = cell.trim();
        if (!t) continue;
        if (!room && /^\d{1,4}$/.test(t)) { room = t; continue; }
        if (!room && /^(судебн\S*\s+)?зал\S*|^каб(инет|\.)?\s|^кабинет|^зал\s|^помещени/i.test(t) && t.length <= 40) { room = /\d/.test(t) ? t.replace(/^судебн\S*\s+/i, '').replace(/^зал\S*\s*№?\s*/i, 'зал ').replace(/^каб\S*\s*№?\s*/i, 'каб. ').trim() : t; continue; } // v3.11: «Судебный зал №7», «кабинет судьи» — это место, не итог
        if (RE_DATE.test(t) && t.length <= 12) continue;      // «дата размещения»
        if (RE_TIME.test(t) && t.length <= 6) continue;       // отдельная ячейка времени
        if (!result && /[А-Яа-яA-Za-z]{3}/.test(t)) { result = t.slice(0, 160); }
      }
      out.hearings.push({ date, time: tm ? tm[0] : '', room, label, result });
    } else if (RE_ACT_KIND.test(joined) && RE_ACT_PUB.test(joined)) {
      out.acts.push({ date, label: label || 'Судебный акт' });
    }
  }
  return out;
}

// Cобытия для сервера из разобранной страницы
function buildEvents(page, ctx) {
  // ctx: { number, uid, courtNo, stage, url, today, sinceDays }
  const today = ctx.today || todayISO();
  const since = shiftISO(today, -(ctx.sinceDays || 45));
  const no = ctx.courtNo || '';
  const ev = [];
  const push = (kind, dateISO, time, title, rawLine) => ev.push({
    externalId: `sud|${no || ctx.number || ctx.url}|${dateISO}|${time || '-'}|${kind}`,
    title, date: dateISO, eventType: kind === 'h' ? 'hearing' : 'notice',
    courtNo: no, caseUid: ctx.uid || '', judge: ctx.judge || '', source: 'Коллектор судов', crmNumber: ctx.number || '', court: ctx.court || '',
    raw: `${ctx.number ? ctx.number + ' · ' : ''}${ctx.stage || ''}\n${ctx.url}\n${rawLine}`.trim()
  });
  for (const h of page.hearings) {
    const dISO = isoOf(h.date);
    if (!dISO) continue;
    const rawLine = [h.label, h.date, h.time, h.room && ('зал ' + h.room), h.result].filter(Boolean).join(' | ');
    if (dISO >= today) {
      push('h', dISO, h.time,
        `Судебное заседание ${h.date}${h.time ? ' в ' + h.time : ''}${h.room ? ', зал ' + h.room : ''}${h.result ? ' — ' + h.result : ''}`,
        rawLine);
    } else if (dISO >= since && (h.result || ctx.allPast)) { // v3.9: allPast — вся история заседаний (карточка по кнопке), без ограничения давности и с пустым результатом
      push('h', dISO, h.time, `${h.label || 'Заседание'} ${h.date}${h.result ? ': ' + h.result : ''}`, rawLine);
    }
  }
  for (const a of page.acts) {
    const dISO = isoOf(a.date);
    if (dISO && dISO >= since) push('act', dISO, '', `Опубликован судебный акт: ${a.label} (${a.date})`, `${a.label} | ${a.date}`);
  }
  return ev;
}

// ── v3.4: слепок прошлого прогона и точные изменения ─────────────────
// Слепок: { at, items: { externalId: { d: дата, t: заголовок, r: результат, k: тип, c: courtNo, s: состояние жалобы (v3.21, только у complaint) } } }
function snapshotOf(events, at) {
  const items = {};
  for (const e of events) {
    const raw = safeJson(e.raw);
    const it = { d: e.date, t: String(e.title || '').slice(0, 160), r: String(raw.result || '').slice(0, 160), k: e.eventType, c: e.courtNo || '' };
    if (e.eventType === 'complaint') { it.s = cmpStateOf(raw); it.x = String(e.raw || '').slice(0, 4000); }
    items[e.externalId] = it;
  }
  return { at: at || new Date().toISOString(), items };
}
// Изменения: перенесённые заседания (у того же дела прежнее будущее заседание исчезло, появилось новое),
// новые результаты (результат появился или изменился), новые акты, новые заседания и строки движения
function diffEvents(prev, events, todayISO) {
  const out = { moved: [], results: [], acts: [], newHearings: [], newFlow: [], complaints: [] };
  const old = (prev && prev.items) || {}; if (!Object.keys(old).length) return out;
  const today = todayISO || new Date().toISOString().slice(0, 10);
  const cur = snapshotOf(events, '').items;
  const byCaseNewFuture = {}, byCaseGoneFuture = {};
  for (const [id, e] of Object.entries(cur)) {
    const o = old[id];
    if (!o) {
      if (e.k === 'hearing' && e.d >= today) (byCaseNewFuture[e.c] = byCaseNewFuture[e.c] || []).push(e);
      else if (e.k === 'notice') out.acts.push(e);
      else if (e.k === 'caseflow') { out.newFlow.push(e); if (e.r) out.results.push(e); }
      else if (e.k === 'complaint') out.complaints.push({ ...e, chg: false });
      continue;
    }
    // v3.21: жалоба с изменившимся состоянием; слепок прежней версии без поля s — изменение не выдумывается
    if (e.k === 'complaint') { if (o.s !== undefined && e.s !== o.s) out.complaints.push({ ...e, chg: true }); continue; }
    if (e.r && e.r !== o.r) out.results.push(e);
  }
  for (const [id, o] of Object.entries(old)) if (!cur[id] && o.k === 'hearing' && o.d >= today) (byCaseGoneFuture[o.c] = byCaseGoneFuture[o.c] || []).push(o);
  for (const c of Object.keys(byCaseNewFuture)) {
    const gone = (byCaseGoneFuture[c] || []).sort((a, b) => a.d.localeCompare(b.d)), fresh = byCaseNewFuture[c].sort((a, b) => a.d.localeCompare(b.d));
    fresh.forEach((n, i) => { if (gone[i]) out.moved.push({ c, from: gone[i].d, to: n.d, t: n.t }); else out.newHearings.push(n); });
  }
  return out;
}
function changesText(diff) {
  const ru = iso => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '';
  const lines = [];
  diff.moved.slice(0, 10).forEach(m => lines.push(`• перенесено: № ${m.c} ${ru(m.from)} → ${ru(m.to)}`));
  diff.newHearings.slice(0, 10).forEach(e => lines.push(`• назначено: № ${e.c} ${ru(e.d)} — ${e.t}`));
  diff.results.slice(0, 10).forEach(e => lines.push(`• результат: № ${e.c} ${ru(e.d)} ${e.t} → ${e.r}`));
  diff.acts.slice(0, 10).forEach(e => lines.push(`• акт: № ${e.c} ${ru(e.d)} — ${e.t}`));
  // v3.21: жалобы — без имён (текст из raw, не из заголовка)
  (diff.complaints || []).slice(0, 10).forEach(e => lines.push(`• жалоба${e.chg ? ' (изменение)' : ''}: № ${e.c} — ${cmpDigestText({ date: e.d, raw: e.x })}`));
  return lines;
}
const diffCount = d => d ? d.moved.length + d.newHearings.length + d.results.length + d.acts.length + (d.complaints || []).length : 0;

// ── v3.5: КАД Арбитр через открытое API СУДиДЕЛО ─────────────────────
// Записи их справочников — SectionRecordDto: { id, name, attributes:[{code, name, stringValue, dateValue, …}] }.
// Коды атрибутов не документированы, поэтому дело ищется по совпадению номера/ссылки в любом строковом атрибуте.
const sdNorm = v => String(v || '').replace(/\s/g, '').toLowerCase();
function sdCfg(cfg) {
  const key = (cfg && cfg.sudodeloApiKey) || process.env.SUDODELO_API_KEY || '';
  if (!key) return null;
  return { key, url: ((cfg && cfg.sudodeloApiUrl) || process.env.SUDODELO_API_URL || 'https://api-sudodelo.torkndgov.ru').replace(/\/+$/, ''),
    autocreate: String((cfg && cfg.sudodeloAutocreate) ?? process.env.SUDODELO_AUTOCREATE ?? '1') !== '0' };
}
async function sdGet(sd, path, params, timeoutMs) {
  const u = new URL(sd.url + path); u.searchParams.set('apiKey', sd.key);
  for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, String(v));
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
  try { const r = await fetch(u, { signal: ctrl.signal, headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`СУДиДЕЛО: HTTP ${r.status} ${path}`); return await r.json(); }
  finally { clearTimeout(timer); }
}
async function sdPost(sd, path, body, timeoutMs) {
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
  try { const r = await fetch(sd.url + path, { method: 'POST', signal: ctrl.signal, headers: { 'Content-Type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) });
    const t = await r.text(); if (!r.ok) throw new Error(`СУДиДЕЛО: HTTP ${r.status} ${path} ${t.slice(0, 120)}`); return t; }
  finally { clearTimeout(timer); }
}
// строковые значения записи справочника — для поиска дела по номеру или ссылке
function sdStrings(rec) { const out = [rec.name || '']; for (const a of (rec.attributes || [])) if (a && a.stringValue) out.push(a.stringValue); return out; }
function sdFindCase(records, courtNo, url) {
  const n = sdNorm(courtNo), u = sdNorm(url);
  for (const r of records || []) { const vals = sdStrings(r).map(sdNorm); if ((n && vals.includes(n)) || (u && vals.includes(u))) return r; }
  return null;
}
async function sdListCases(sd, timeoutMs) { // все дела аккаунта (постранично)
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const j = await sdGet(sd, '/api/CourtCases', { numberPage: page, pageSize: 1000 }, timeoutMs);
    const items = Array.isArray(j && j.items) ? j.items : []; out.push(...items);
    if (items.length < 1000) break;
  }
  return out;
}
// «График событий» СУДиДЕЛО → заседания в формате parseCasePage (дата ДД.ММ.ГГГГ, время, зал, результат)
function sdScheduleToHearings(sch) {
  const out = [];
  for (const it of (sch && Array.isArray(sch.items) ? sch.items : [])) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(String(it.start || ''));
    if (!m) continue;
    const time = m[4] !== undefined && !(m[4] === '00' && m[5] === '00') ? `${m[4]}:${m[5]}` : '';
    const title = String(it.title || ''); const room = (title.match(/(?:зал|каб\.?)\s*№?\s*([0-9]{1,4}[а-я]?)/i) || [])[1] || '';
    out.push({ date: `${m[3]}.${m[2]}.${m[1]}`, time, room, label: (it.stageName ? it.stageName + ': ' : '') + (title || 'Судебное заседание'), result: String(it.comment || '').slice(0, 160) });
  }
  return out;
}
// «Движение дела» СУДиДЕЛО — HTML-таблица без заголовка секции: добавляем его, чтобы parseFlow нашёл таблицу
function sdProgressToFlow(prog) {
  const html = prog && prog.htmlTable ? String(prog.htmlTable) : '';
  if (!html) return [];
  return parseFlow('<div>ДВИЖЕНИЕ ДЕЛА</div>' + html);
}
// одна арбитражная ссылка: найти/завести дело, забрать график и движение, вернуть события
async function sdCollectLink(sd, c, l, cfg, logf, cache) {
  if (!cache.cases) { cache.cases = await sdListCases(sd, cfg.timeoutMs); logf(`СУДиДЕЛО: дел в аккаунте ${cache.cases.length}`); }
  const courtNo = l.courtNo || c.courtNo || '';
  let rec = sdFindCase(cache.cases, courtNo, l.url);
  if (!rec) {
    if (!sd.autocreate) { logf(`— ${c.number}: в СУДиДЕЛО дела нет, автосоздание выключено (SUDODELO_AUTOCREATE=0)`); return { events: [], created: false, missing: true }; }
    const court = /kad\.arbitr\.ru/i.test(l.url) ? 'Арбитражный суд' : 'Суд';
    await sdPost(sd, '/api/CourtCases', { apiKey: sd.key, courtCase: { numberCase: c.number || courtNo, numberCaseInCourt: courtNo, numberCaseUID: c.uid || '', urlLinkCase: l.url, nameCourt: court }, client: { nameCompany: '—', fio: '—', email: '' } }, cfg.timeoutMs);
    logf(`＋ ${c.number} (${l.stage}): дело заведено в СУДиДЕЛО по ссылке КАД — данные появятся после их обновления (следующий сбор)`);
    cache.cases = null; // перечитать список при следующем деле
    return { events: [], created: true };
  }
  const [sch, prog] = await Promise.all([
    sdGet(sd, `/api/CourtCases/${rec.id}/event-schedule`, {}, cfg.timeoutMs).catch(e => { logf(`   график событий: ${errText(e)}`); return null; }),
    sdGet(sd, `/api/CourtCases/${rec.id}/progress`, {}, cfg.timeoutMs).catch(e => { logf(`   движение дела: ${errText(e)}`); return null; })
  ]);
  const page = { hearings: sdScheduleToHearings(sch), acts: [], judge: '' };
  const flow = sdProgressToFlow(prog);
  const ctx = { number: c.number, uid: c.uid || '', courtNo, stage: l.stage, url: l.url, sinceDays: Number(cfg.sinceDays) || 45, judge: '' };
  const events = [...buildEvents(page, ctx), ...buildFlowEvents(flow, ctx)];
  return { events, hearings: page.hearings.length, flow: flow.length, created: false };
}

// ── сеть ─────────────────────────────────────────────────────────────
const BLOCK_RE = /captcha|доступ ограничен|запрос(ы)? с вашего ip|ваш ip:|attention required|ddos/i;
function errText(e) {
  if (!e) return 'ошибка';
  if (e.name === 'AbortError') return 'нет ответа (таймаут)';
  const c = e.cause || {};
  const code = c.code || c.errno || '';
  const msg = c.message || e.message || 'ошибка';
  return code ? `${msg} [${code}]` : msg;
}
// Повторная попытка по http://, если https не открылся (частая беда судов)
async function fetchPageSmart(url, timeoutMs, logf) {
  try { return await fetchPage(url, timeoutMs); }
  catch (e) {
    // v3.19: отказ по правилу (чужой сайт, внутренний адрес, размер) — без повтора по http
    if (e && e.final) throw e;
    if (/^https:\/\//i.test(url)) {
      const alt = 'http://' + url.slice(8);
      if (logf) logf(`   повтор по http: ${alt}`);
      return await fetchPage(alt, timeoutMs);
    }
    throw e;
  }
}
// v3.4: один повтор после паузы при сетевом сбое (таймаут, обрыв) — сайты судов часто отвечают со второго раза
async function fetchPageRetry(url, timeoutMs, logf, pauseMs) {
  try { return await fetchPageSmart(url, timeoutMs, logf); }
  catch (e) { if (e && e.final) throw e; if (logf) logf(`   повтор через ${Math.round((pauseMs || 4000) / 1000)} с: ${errText(e)}`); await sleep(pauseMs || 4000); return await fetchPageSmart(url, timeoutMs, logf); }
}
const hostOf = url => { try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; } };
// v3.6: есть ли на странице номер дела (сравнение без пробелов и регистра; «2-1500/2026» найдётся и в «№ 2-1500/2026 ~ М-700/2026»)
// v3.17: номер сравнивается без различий в написании тире и пробелов; числовые сущности HTML раскрываются; «№» не мешает
const normCaseNo = x => String(x || '').replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
  .replace(/&nbsp;/g, ' ').replace(/[\u2010-\u2015\u2212\u00ad]/g, '-').replace(/№/g, '').replace(/\s/g, '').toLowerCase();
function pageHasNumber(html, courtNo) {
  const n = normCaseNo(courtNo); if (!n) return true;
  return normCaseNo(String(html || '').replace(/<[^>]+>/g, ' ')).includes(n);
}
// v3.17: что за страница пришла (заголовок, размер, адрес после переадресаций) — чтобы по сообщению было видно, что отдал сайт суда
function pageBrief(r) {
  const t = String((r && r.text) || ''), m = t.match(/<title>([^<]{1,120})<\/title>/i), title = m ? m[1].replace(/\s+/g, ' ').trim() : 'без заголовка';
  let host = ''; try { host = new URL(r.url).hostname; } catch (e) { /* штатно: адрес неизвестен */ }
  return '«' + title + '», ' + t.length + ' знаков' + (host ? ', ' + host : '');
}
// v3.17: номера дел на странице (2-2586/2026, 2а-15/2026, 12-1311/2026, М-2190/2026) — чтобы сказать, на какое дело ведёт ссылка
function pageCaseNumbers(html) {
  const t = String(html || '').replace(/<[^>]+>/g, ' ').replace(/&#(\d+);/g, (m, d) => String.fromCharCode(+d)).replace(/[\u2010-\u2015\u2212]/g, '-');
  // v3.20: и номера с буквами — 8Г-31317/2026 (кассация), 33а-512/2026, А11-1234/2026 (арбитраж)
  const out = []; const re = /(?:^|[^0-9А-Яа-яA-Za-z])((?:[АA]\d{2}|\d{1,3}[а-яёa-zА-ЯЁA-Z]{0,2}|[МмM])-\d{1,7}\/\d{4})(?!\d)/g; let m;
  while ((m = re.exec(t)) && out.length < 4) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}
// v3.20 (жалоба 15.10.2026: верная ссылка первой инстанции отвергалась как «другое дело» — в деле стоял номер апелляции): дело на
// странице узнаётся по номеру своей инстанции, иначе по УИД (один на все инстанции), иначе по любому другому номеру дела из программы.
// l — { courtNo } ссылки, c — { uid, numbers, courtNo, courtNoApp, courtNoCass } дела. Ответ: { ok, byUid, byOther, found, known }
function pageHasUid(html, uid) {
  const u = String(uid || '').trim().toUpperCase(); if (!u) return false;
  return String(html || '').replace(/<[^>]+>/g, ' ').toUpperCase().includes(u);
}
function pageMatchesCase(html, l, c) {
  const own = String((l && l.courtNo) || '').trim();
  if (!own || pageHasNumber(html, own)) return { ok: true, byUid: false, byOther: '', found: [] };
  const uid = String((c && c.uid) || '').trim();
  if (uid && pageHasUid(html, uid)) return { ok: true, byUid: true, byOther: '', found: pageCaseNumbers(html) };
  const others = [].concat((c && c.numbers) || [], c ? [c.courtNo, c.courtNoApp, c.courtNoCass] : []).map(x => String(x || '').trim())
    .filter((x, i, a) => x && normCaseNo(x) !== normCaseNo(own) && a.findIndex(y => normCaseNo(y) === normCaseNo(x)) === i);
  const hit = others.find(x => pageHasNumber(html, x));
  if (hit) return { ok: true, byUid: false, byOther: hit, found: pageCaseNumbers(html) };
  return { ok: false, byUid: false, byOther: '', found: pageCaseNumbers(html), known: [own].concat(others) };
}
function hostKind(url) {
  let h = '';
  try { h = new URL(url).hostname.toLowerCase(); } catch (e) { return 'bad'; }
  if (h.endsWith('.sudrf.ru') || h === 'sudrf.ru') return 'sudrf';
  if (h.endsWith('mos-gorsud.ru') || h.endsWith('mos-sud.ru')) return 'mos';
  if (h.endsWith('kad.arbitr.ru') || h.endsWith('arbitr.ru')) return 'kad';
  return 'other';
}
// v3.19 (аудит 14.10.2026): куда коллектор не ходит — внутренние сети и служебные адреса облака (169.254.169.254 — метаданные функции
// с её токеном), localhost, *.local, *.internal; переадресация — только в пределах сайта ссылки; страница — не больше PAGE_MAX
const PAGE_MAX = 5 * 1024 * 1024;
const REDIRECTS_MAX = 5;
function netHostBad(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) { const a = +m[1], b = +m[2]; return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224; }
  if (h.includes(':')) return h === '::1' || h === '::' || /^f[cd]/.test(h) || /^fe[89ab]/.test(h) || h.startsWith('::ffff:');
  return false;
}
const siteOf = h => String(h || '').toLowerCase().replace(/\.$/, '').split('.').filter(Boolean).slice(-2).join('.');
function sameCourtSite(a, b) {
  const ha = hostOf(a), hb = hostOf(b); if (!ha || !hb) return false;
  if (ha === hb) return true;
  if (hostKind(a) === 'mos' && hostKind(b) === 'mos') return true;
  return siteOf(ha) === siteOf(hb);
}
// отказ по правилу (чужой сайт, внутренний адрес, размер) — окончательный: повтор по http и повтор через паузу его не меняют
const finalErr = m => Object.assign(new Error(m), { final: true });
const pageTooBig = max => finalErr('страница больше ' + Math.round(max / 1048576) + ' МБ — коллектор её не читает');
async function readCapped(r, max) {
  const len = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('content-length') : 0) || 0;
  if (len > max) throw pageTooBig(max);
  if (r.body && typeof r.body.getReader === 'function') {
    const rd = r.body.getReader(); const parts = []; let got = 0;
    for (;;) {
      const { done, value } = await rd.read(); if (done) break;
      got += value.length;
      if (got > max) { try { await rd.cancel(); } catch (e) { /* штатно: поток уже закрыт */ } throw pageTooBig(max); }
      parts.push(value);
    }
    const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
    return buf;
  }
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > max) throw pageTooBig(max);
  return buf;
}
async function fetchPage(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
  try {
    let cur = url;
    for (let hop = 0; ; hop++) {
      let pu = null; try { pu = new URL(cur); } catch (e) { throw finalErr('некорректный адрес страницы'); }
      if (!/^https?:$/.test(pu.protocol) || netHostBad(pu.hostname)) throw finalErr('адрес не похож на сайт суда (' + pu.protocol + '//' + pu.hostname + ') — коллектор туда не обращается');
      const r = await fetch(cur, {
        signal: ctrl.signal, redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'ru-RU,ru;q=0.9'
        }
      });
      const loc = r.status >= 300 && r.status < 400 && r.headers && typeof r.headers.get === 'function' ? r.headers.get('location') : null;
      if (loc) {
        try { if (r.body && typeof r.body.cancel === 'function') await r.body.cancel(); } catch (e) { /* штатно: тело переадресации не нужно */ }
        if (hop >= REDIRECTS_MAX) throw finalErr('сайт суда переадресует больше ' + REDIRECTS_MAX + ' раз');
        let next = ''; try { next = new URL(loc, cur).href; } catch (e) { throw finalErr('сайт суда переадресовал на некорректный адрес'); }
        if (!sameCourtSite(url, next)) throw finalErr('сайт суда переадресовал на другой сайт (' + (hostOf(next) || 'адрес не распознан') + ') — проверьте ссылку в деле');
        cur = next; continue;
      }
      const buf = await readCapped(r, PAGE_MAX);
      return { status: r.status, text: decodeBody(buf), url: cur };
    }
  } finally { clearTimeout(timer); }
}
// v3.19: запрос функции с пределом ожидания; тело ответа читается в пределах того же ожидания. Ответ — { status, ok, text }.
async function fetchT(url, opt, ms) {
  const lim = Number(ms) || 30000;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), lim);
  try {
    const r = await fetch(url, Object.assign({}, opt || {}, { signal: ctrl.signal }));
    const text = await r.text();
    return { status: r.status, ok: r.status >= 200 && r.status < 300, text };
  } catch (e) {
    if ((e && e.name === 'AbortError') || ctrl.signal.aborted) throw new Error('нет ответа за ' + Math.round(lim / 1000) + ' с (' + (hostOf(url) || 'адрес') + ')');
    throw e;
  } finally { clearTimeout(timer); }
}
const jsonOf = t => { try { return JSON.parse(t); } catch (e) { return null; } };
async function sendEvents(cfg, events) {
  let sent = 0, added = 0, updated = 0;
  for (let i = 0; i < events.length; i += 300) {
    const chunk = events.slice(i, i + 300);
    // v3.19: доставка пачки — с пределом ожидания (SEND_TIMEOUT_MS, по умолчанию 45 с)
    const r = await fetchT(cfg.bridge, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: cfg.secret, action: 'eventsput', mode: 'merge', events: chunk })
    }, Number(process.env.SEND_TIMEOUT_MS) || 45000);
    const j = jsonOf(r.text);
    if (!j || !j.ok) throw new Error('сервер ответил: ' + (j && j.error ? j.error : 'HTTP ' + r.status));
    sent += chunk.length; added += Number(j.added || 0); updated += Number(j.updated || 0);
  }
  return { sent, added, updated };
}

// ── ядро сбора (общее для компьютера и облачной функции) ─────────────
// deadlineMs — мягкий бюджет времени: 0 = без лимита; при исчерпании сбор
// останавливается, отправляется собранное, статус помечается partial.
async function collectRun(pack, cfg, logf, deadlineMs) {
  const delay = Number(cfg.delayMs) || 2500;
  const sinceDays = Number(cfg.sinceDays) || 45;
  const parallel = Math.max(1, Math.min(6, Number(cfg.parallel) || 3)); // v3.4: разных судов одновременно
  const byId = new Map();
  const stats = { cases: pack.cases.length, pages: 0, blocked: 0, kadSkipped: 0, unparsed: 0, failed: 0, flowRows: 0, errors: [], partial: false };
  // задачи сгруппированы по хосту: внутри суда — по очереди с паузой, разные суды — параллельно
  const groups = new Map();
  const sd = sdCfg(cfg); const sdCache = {}; stats.kadViaSudodelo = 0; stats.kadCreated = 0; // v3.5
  for (const c of pack.cases) for (const l of (c.links || [])) {
    const kind = hostKind(l.url);
    if (kind === 'bad') { stats.failed++; stats.errors.push({ number: c.number, stage: l.stage, err: 'некорректная ссылка' }); logf(`✗ ${c.number}: некорректная ссылка (${l.stage})`); continue; }
    if (kind === 'kad') {
      if (!sd) { stats.kadSkipped++; logf(`— ${c.number}: КАД Арбитр пропущен (антибот) — подключите API СУДиДЕЛО (SUDODELO_API_KEY) или «Электронный страж»: ${l.url}`); continue; }
      (groups.get('sudodelo') || groups.set('sudodelo', []).get('sudodelo')).push({ c, l, sd: true }); continue;
    }
    const h = hostOf(l.url); (groups.get(h) || groups.set(h, []).get(h)).push({ c, l });
  }
  const queue = [...groups.values()];
  async function one({ c, l, sd: viaSd }) {
    if (viaSd) { // v3.5: КАД через СУДиДЕЛО
      try {
        const r = await sdCollectLink(sd, c, l, cfg, logf, sdCache);
        for (const e of r.events) byId.set(e.externalId, e);
        if (r.created) stats.kadCreated++; else if (!r.missing) { stats.kadViaSudodelo++; stats.pages++; stats.flowRows += r.flow || 0; logf(`✓ ${c.number} (${l.stage}, КАД через СУДиДЕЛО): заседаний ${r.hearings || 0}, движение ${r.flow || 0}`); }
      } catch (e) { stats.failed++; stats.errors.push({ number: c.number, stage: l.stage, err: errText(e) }); logf(`✗ ${c.number} (${l.stage}, СУДиДЕЛО): ${errText(e)}`); }
      return;
    }
    // v3.14: вид сайта нужен здесь (tryAA ниже); в 3.13 kind был объявлен только в цикле группировки — «kind is not defined»
    const kind = hostKind(l.url);
    const apply = (page, flow, cardP, uidOnPage, via, cmpP) => { // v3.13: общий хвост — события из разобранной карточки; v3.20: cmpP — жалобы
      stats.flowRows += flow.length;
      const ctx = { number: c.number, uid: uidOnPage, courtNo: l.courtNo || c.courtNo, stage: l.stage, url: l.url, sinceDays, judge: page.judge || cardP.judge || '', court: cardP.court || '' };
      for (const e of buildEvents(page, ctx)) byId.set(e.externalId, e);
      for (const e of buildFlowEvents(flow, ctx)) byId.set(e.externalId, e);
      const cardEv = buildCardEvent(cardP, ctx); if (cardEv) byId.set(cardEv.externalId, cardEv); // v3.7
      // v3.20: жалобы — событиями complaint
      const cmpEv = buildComplaintEvents(cmpP || [], ctx); for (const e of cmpEv) byId.set(e.externalId, e); stats.complaints = (stats.complaints || 0) + cmpEv.length;
      const empty = !page.hearings.length && !page.acts.length && !flow.length && !cmpEv.length;
      if (empty) { stats.unparsed++; logf(`· ${c.number} (${l.stage}${via ? ', ' + via : ''}): таблицы не распознаны — откройте страницу глазами`); }
      else logf(`✓ ${c.number} (${l.stage}${via ? ', ' + via : ''}): заседаний ${page.hearings.length}, актов ${page.acts.length}, движение ${flow.length}${cmpEv.length ? ', жалоб ' + cmpEv.length : ''}${uidOnPage ? ', УИД ✓' : ''}`);
      return !empty;
    };
    const tryAA = async (why) => { // v3.13: карточка через API Assist
      if (!(kind === 'sudrf' && aaEnabled())) return false;
      try { const m = aaToPage(await aaFetchCase(l.url, cfg.timeoutMs)); stats.apiAssist = (stats.apiAssist || 0) + 1; if (why) logf(`   ${why} — карточка через API Assist`); apply(m.page, m.flow, m.card, m.card.uid || c.uid || '', 'API Assist'); return true; }
      catch (e) { stats.apiAssistErrors = (stats.apiAssistErrors || 0) + 1; logf(`   API Assist: ${errText(e)}`); return false; }
    };
    try {
      if (AA.mode === 'primary' && await tryAA('')) return;
      const r = await fetchPageRetry(l.url, cfg.timeoutMs, logf, Math.max(2000, delay));
      stats.pages++; let pm = null;
      if (r.status >= 400 || BLOCK_RE.test(r.text.slice(0, 6000))) {
        if (AA.mode !== 'primary' && await tryAA(`сайт суда не отдал страницу (HTTP ${r.status})`)) return;
        stats.blocked++; logf(`⚠ ${c.number} (${l.stage}): сайт суда не отдал страницу (HTTP ${r.status}${BLOCK_RE.test(r.text.slice(0, 6000)) ? ', похоже на капчу/блокировку' : ''}) — проверьте вручную`);
      } else if (!(pm = pageMatchesCase(r.text, l, c)).ok) { // v3.6: страница не про это дело; v3.20: дело узнаётся и по УИД, и по любому его номеру
        // v3.17: названо, какой номер на странице; номеров дел на странице нет вовсе — это нераспознанная страница, а не «другое дело»
        const found = pm.found;
        if (found.length) { stats.linkMismatch = (stats.linkMismatch || 0) + 1; stats.errors.push({ number: c.number, stage: l.stage, err: 'ссылка ведёт на другое дело: на странице номер ' + found.join(', ') + ', а в деле ' + pm.known.join(', ') + (c.uid ? ' (и УИД дела на странице нет)' : '') }); }
        else { stats.unparsed++; stats.errors.push({ number: c.number, stage: l.stage, err: 'страница не распознана: на ней нет номера дела — получено ' + pageBrief(r) + ' (возможно, сайт суда показал облаку страницу проверки, а не дело)' }); }
        logf(`⚠ ${c.number} (${l.stage}): на странице суда нет номера ${l.courtNo}${found.length ? ' (на странице ' + found.join(', ') + ')' : ' и вообще нет номера дела'}; события не отправлены: ${l.url}`);
      } else {
        // v3.20: номера своей инстанции на странице нет, дело узнано по УИД или другому номеру — страница читается; в журнале назван номер со
        // страницы (карточка дела в программе предложит исправить номер)
        if (pm.byUid || pm.byOther) logf(`· ${c.number} (${l.stage}): номера ${l.courtNo} на странице нет, дело узнано по ${pm.byUid ? 'УИД' : 'номеру ' + pm.byOther}${pm.found.length ? '; на странице номер ' + pm.found.join(', ') : ''} — проверьте номер в деле`);
        const page = parseCasePage(r.text), flow = parseFlow(r.text), cardP = parseCaseCard(r.text), cmpP = parseComplaints(r.text); // v3.11: суд страницы (из title) — в события
        if (!page.hearings.length && !page.acts.length && !flow.length && AA.mode !== 'primary' && await tryAA('таблицы не распознаны')) return;
        apply(page, flow, cardP, parseUid(r.text) || c.uid || '', '', cmpP);
      }
    } catch (e) {
      if (await tryAA(`сайт суда: ${errText(e)}`)) return;
      stats.failed++; stats.errors.push({ number: c.number, stage: l.stage, err: errText(e) });
      logf(`✗ ${c.number} (${l.stage}): ${errText(e)}`);
    }
  }
  async function worker() {
    while (queue.length) {
      const group = queue.shift();
      for (const task of group) {
        if (deadlineMs && Date.now() > deadlineMs) { if (!stats.partial) { stats.partial = true; logf('⏱ Бюджет времени исчерпан — сбор остановлен, остальное доберёт следующий запуск'); } queue.length = 0; return; }
        await one(task);
        await sleep(delay);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length || 1) }, () => worker()));
  stats.errors = stats.errors.slice(0, 20);
  if (aaEnabled()) logf(`API Assist (${AA.mode}): запросов ${AA.used}, ошибок ${AA.errors}${AA.lastError ? ' (последняя: ' + AA.lastError + ')' : ''}`); // v3.13
  return { events: [...byId.values()], stats };
}

// ── основной сценарий ────────────────────────────────────────────────
async function main() {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); }
  catch (e) { console.error('Не найден или повреждён collector-config.json (' + CONFIG_PATH + ').\nСкопируйте collector-config-example.json в collector-config.json и заполните.'); process.exit(1); }
  for (const k of ['bridge', 'secret']) if (!cfg[k]) { console.error('В конфиге не заполнено поле "' + k + '".'); process.exit(1); }
  const linksPath = path.isAbsolute(cfg.linksFile || '') ? cfg.linksFile : path.join(DIR, cfg.linksFile || 'дела-для-коллектора.json');
  let pack;
  try { pack = JSON.parse(fs.readFileSync(linksPath, 'utf8')); }
  catch (e) { console.error('Не найден список дел: ' + linksPath + '\nСкачайте его в CRM: Ещё → Мониторинг → Коллектор судов.'); process.exit(1); }
  if (!pack || pack.format !== 'crm-advokat-links' || !Array.isArray(pack.cases)) { console.error('Файл списка дел не похож на выгрузку CRM (format=crm-advokat-links).'); process.exit(1); }

  log(`Старт (коллектор v${COLLECTOR_VER}, Node ${process.version}): дел ${pack.cases.length}, выгрузка от ${pack.exportedAt || '—'}${DRY ? ' (пробный прогон, без отправки)' : ''}`);
  const { events, stats } = await collectRun(pack, cfg, log, 0);
  log(`Собрано событий: ${events.length} (страниц: ${stats.pages}, движение: ${stats.flowRows}, блокировок: ${stats.blocked}, КАД пропущено: ${stats.kadSkipped}, не распознано: ${stats.unparsed}, ошибок: ${stats.failed})`);
  { // v3.4: изменения с прошлого прогона — по слепку рядом со скриптом
    const STATE_PATH = path.join(DIR, 'collector-state.json'); let prevState = null;
    try { prevState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (e) {}
    const diff = diffEvents(prevState, events, todayISO());
    if (diffCount(diff)) { log(`Изменения с прошлого сбора (${diffCount(diff)}):`); changesText(diff).forEach(l => log('  ' + l)); }
    else if (prevState) log('Изменений с прошлого сбора нет.');
    if (!DRY && !stats.partial) { try { fs.writeFileSync(STATE_PATH, JSON.stringify(snapshotOf(events), null, 1)); } catch (e) {} }
  }
  if (DRY) {
    for (const e of events.slice(0, 20)) console.log('  •', e.date, e.eventType, '—', e.title, e.courtNo ? `[${e.courtNo}]` : '');
    if (events.length > 20) console.log(`  … и ещё ${events.length - 20}`);
    log('Пробный прогон завершён, на сервер ничего не отправлено.');
    return;
  }
  if (!events.length) { log('Отправлять нечего.'); return; }
  try {
    const res = await sendEvents(cfg, events);
    log(`Отправлено на сервер: ${res.sent}${(res.added || res.updated) ? ` (новых ${res.added}, обновлено ${res.updated})` : ''}. Теперь в CRM: Ещё → Мониторинг → «Получить сейчас».`);
  } catch (e) {
    log('✗ Отправка не удалась: ' + e.message);
    if (/unknown_action/.test(String(e.message))) {
      log('   Причина: на сервере старая версия функции — в ней нет действия eventsput.');
      log('   Решение: в консоли Яндекс Облака откройте функцию → «Редактор» → замените содержимое index.js файлом «Сервер_v170_index.js» → «Создать версию». Данные и настройки не пострадают.');
    }
    process.exit(1);
  }
}

// ── самопроверка парсера (без сети) ─────────────────────────────────
function runTests() {
  let pass = 0, fail = 0;
  const t = (name, cond) => { if (cond) pass++; else { fail++; console.log('FAIL:', name); } };

  const FIX = `
  <html><head><meta charset="windows-1251"></head><body>
  <table id="tablcont">
    <tr><th>Наименование события</th><th>Дата события</th><th>Время</th><th>Зал</th><th>Результат события</th><th>Дата размещения</th></tr>
    <tr><td>Судебное заседание</td><td>25.09.2026</td><td>10:30</td><td>5</td><td></td><td>01.08.2026</td></tr>
    <tr><td>Судебное заседание</td><td>10.08.2026</td><td>09:00</td><td>5</td><td>Заседание отложено</td><td>10.08.2026</td></tr>
    <tr><td>Предварительное судебное заседание (беседа)</td><td>01.06.2026</td><td>14:00</td><td>3</td><td>Назначено судебное заседание</td><td></td></tr>
    <tr><td>Решение</td><td>12.08.2026</td><td></td><td></td><td>Опубликовано</td><td>15.08.2026</td></tr>
    <tr><td>Судья</td><td>Иванова И.И.</td></tr>
  </table></body></html>`;

  const page = parseCasePage(FIX);
  t('судья распознан', page.judge === 'Иванова И.И.');
  t('заседаний найдено 3', page.hearings.length === 3);
  t('будущее заседание: время', page.hearings[0].time === '10:30');
  t('будущее заседание: зал', page.hearings[0].room === '5');
  t('прошедшее: результат', page.hearings[1].result === 'Заседание отложено');
  t('публикация акта найдена', page.acts.length === 1 && page.acts[0].date === '12.08.2026');

  const evs = buildEvents(page, { number: 'Д-5/2026', uid: '33RS0011-01-2026-000123-45', courtNo: '2-345/2026', stage: 'Первая инстанция', url: 'https://kovrovsky--wld.sudrf.ru/x', today: '2026-08-18', sinceDays: 45 });
  t('событий 3 (будущее + результат + акт; старая беседа отсечена)', evs.length === 3);
  const hFut = evs.find(e => e.date === '2026-09-25');
  t('hearing: тип и дата', !!hFut && hFut.eventType === 'hearing');
  t('hearing: заголовок с временем и залом', !!hFut && /25\.09\.2026 в 10:30, зал 5/.test(hFut.title));
  t('externalId стабилен', !!hFut && hFut.externalId === 'sud|2-345/2026|2026-09-25|10:30|h');
  const hRes = evs.find(e => e.date === '2026-08-10');
  t('результат прошедшего — notice? нет, hearing-обновление', !!hRes && /Заседание отложено/.test(hRes.title));
  const act = evs.find(e => /акт/i.test(e.title));
  t('акт: notice с датой', !!act && act.eventType === 'notice' && act.date === '2026-08-12');
  t('caseUid прокинут', evs.every(e => e.caseUid === '33RS0011-01-2026-000123-45'));

  // v3.13: API Assist → структуры разбора
  const AAJ = { success: 1, case_title: 'ДЕЛО № 2-632/2026 ~ М-608/2026', court_title: 'Ковровский городской суд Владимирской области',
    attributes: [{ name: 'Уникальный идентификатор дела', value: '33RS0011-01-2026-000123-45' }, { name: 'Дата поступления', value: '05.06.2026' }, { name: 'Судья', value: 'Иванова И.И.' }],
    events: [ [{ name: 'Наименование события', value: 'Регистрация иска (заявления, жалобы) в суде и принятие его к производству' }, { name: 'Дата', value: '05.06.2026' }, { name: 'Время', value: '16:07' }, { name: 'Зал судебного заседания', value: '' }, { name: 'Результат события', value: '' }, { name: 'Основание для выбранного результата события', value: '' }],
      [{ name: 'Наименование события', value: 'Судебное заседание' }, { name: 'Дата', value: '25.09.2026' }, { name: 'Время', value: '10:30' }, { name: 'Зал судебного заседания', value: 'Зал №5' }, { name: 'Результат события', value: '' }, { name: 'Основание для выбранного результата события', value: '' }],
      [{ name: 'Наименование события', value: 'Предварительное судебное заседание' }, { name: 'Дата', value: '10.08.2026' }, { name: 'Время', value: '09:00' }, { name: 'Зал судебного заседания', value: '5' }, { name: 'Результат события', value: 'Назначено судебное заседание' }, { name: 'Основание для выбранного результата события', value: '' }] ],
    sides: [ [{ name: 'Вид лица, участвующего в деле', value: 'ИСТЕЦ' }, { name: 'Фамилия / наименование', value: 'Шашина Марина Михайловна' }, { name: 'ИНН', value: '' }], [{ name: 'Вид лица, участвующего в деле', value: 'ОТВЕТЧИК' }, { name: 'Фамилия / наименование', value: 'ООО "Экоквартал"' }, { name: 'ИНН', value: '7700000000' }] ] };
  const aa = aaToPage(AAJ);
  t('API Assist: заседаний 2, регистрация — не заседание', aa.page.hearings.length === 2 && aa.flow.length === 3);
  t('API Assist: будущее заседание — время и зал без «Зал №»', aa.page.hearings[0].time === '10:30' && aa.page.hearings[0].room === '5');
  t('API Assist: результат прошедшего', aa.page.hearings[1].result === 'Назначено судебное заседание');
  t('API Assist: карточка — УИД, номер, судья, суд, дата поступления, стороны', aa.card.uid === '33RS0011-01-2026-000123-45' && aa.card.number === '2-632/2026' && aa.card.judge === 'Иванова И.И.' && /Ковровский/.test(aa.card.court) && aa.card.registered === '2026-06-05' && aa.card.parties.length === 2 && aa.card.parties[1].inn === '7700000000');
  const aaEv = buildEvents(aa.page, { number: 'Д-5/2026', uid: aa.card.uid, courtNo: aa.card.number, stage: 'Первая инстанция', url: 'https://kovrovsky--wld.sudrf.ru/x', today: '2026-08-18', sinceDays: 45 });
  t('API Assist: события строятся теми же функциями', aaEv.some(e => e.eventType === 'hearing' && e.date === '2026-09-25' && /зал 5/.test(e.title)));
  t('API Assist выключен без ключа', !aaEnabled());

  // распознавание хостов
  t('sudrf', hostKind('https://kovrovsky--wld.sudrf.ru/modules.php?name=sud_delo') === 'sudrf');
  t('mos', hostKind('https://mos-gorsud.ru/rs/babushkinskij/services/cases/civil/details/abc') === 'mos');
  t('kad', hostKind('https://kad.arbitr.ru/card/xxxx') === 'kad');

  // декодер cp1251: «Дело» = 0xC4 0xE5 0xEB 0xEE
  t('cp1251 вручную', decode1251(Buffer.from([0xC4, 0xE5, 0xEB, 0xEE])) === 'Дело');

  // даты
  t('isoOf', isoOf('5.9.2026') === '2026-09-05');
  t('isoOf мусор', isoOf('скоро') === '');

  // ── v3: УИД, «Движение дела», события caseflow ──
  const FIX_FLOW = `
  <html><body>
  Уникальный идентификатор дела 77RS0031-01-2026-004567-89
  <div>ДВИЖЕНИЕ ДЕЛА</div>
  <table>
    <tr><th>Наименование события</th><th>Дата события</th><th>Время</th><th>Зал</th><th>Результат события</th><th>Основание для выбранного результата события</th><th>Дата размещения</th></tr>
    <tr><td>Регистрация иска (заявления, жалобы) в суде</td><td>05.05.2026</td><td>09:10</td><td></td><td></td><td></td><td>05.05.2026</td></tr>
    <tr><td>Судебное заседание</td><td>19.08.2026</td><td>16:00</td><td>406</td><td>Вынесено решение</td><td>Иск удовлетворён частично</td><td>19.08.2026</td></tr>
    <tr><td></td><td>01.01.2026</td><td></td><td></td><td></td><td></td><td></td></tr>
  </table></body></html>`;
  t('parseUid: УИД найден', parseUid(FIX_FLOW) === '77RS0031-01-2026-004567-89');
  t('parseUid: нет УИД — пусто', parseUid('<html>нет</html>') === '');
  const flow = parseFlow(FIX_FLOW);
  t('движение: 2 строки, пустое название отсечено', flow.length === 2);
  t('движение: дата события, а не размещения', flow[0].date === '05.05.2026' && flow[0].time === '09:10');
  t('движение: результат и основание', flow[1].result === 'Вынесено решение' && flow[1].basis === 'Иск удовлетворён частично');
  t('движение: нет секции — пусто', parseFlow('<html>ничего</html>').length === 0);
  const fctx = { number: '2-345/2026', uid: parseUid(FIX_FLOW), courtNo: '2-345/2026', url: 'https://x' };
  const fev = buildFlowEvents(flow, fctx);
  t('caseflow: тип, УИД, source', fev.length === 2 && fev.every(e => e.eventType === 'caseflow' && e.caseUid === '77RS0031-01-2026-004567-89' && e.source === 'Коллектор судов'));
  t('caseflow: raw с результатом и основанием', /Вынесено решение/.test(fev[1].raw) && /Иск удовлетворён частично/.test(fev[1].raw));
  t('caseflow: у строки без результата raw без него', !/result/.test(fev[0].raw) && /09:10/.test(fev[0].raw));
  const idA = fev[1].externalId;
  t('caseflow: hash не зависит от результата (merge обновит запись)',
    buildFlowEvents([{ ...flow[1], result: '', basis: '' }], fctx)[0].externalId === idA);
  t('caseflow: другая дата — другой id',
    buildFlowEvents([{ ...flow[1], date: '20.08.2026' }], fctx)[0].externalId !== idA);
  t('caseflow: без УИД ключ по номеру',
    buildFlowEvents([flow[0]], { courtNo: '2-9/2026' })[0].externalId.startsWith('flow:2-9/2026:'));
  const fevJ = buildFlowEvents([flow[1]], { ...fctx, stage: 'Апелляция', judge: 'Иванова И.И.' })[0];
  t('caseflow: судья отдельным полем', fevJ.judge === 'Иванова И.И.');
  t('caseflow: инстанция в raw', /Апелляция/.test(fevJ.raw));
  const hevJ = buildEvents(page, { number: 'Д-5/2026', uid: '', courtNo: '2-345/2026', stage: '1', url: 'https://x', today: '2026-08-18', sinceDays: 45, judge: 'Иванова И.И.' });
  t('hearing: судья отдельным полем', hevJ.length > 0 && hevJ.every(e => e.judge === 'Иванова И.И.'));

  // ── v3: маршрутизация облачной функции и санитизация ──
  const dT = decodeFnEvent({ messages: [{ event_metadata: {} }] });
  t('таймер распознан', dT.kind === 'timer' && dT.action === 'collect');
  const dH = decodeFnEvent({ httpMethod: 'POST', isBase64Encoded: true,
    body: Buffer.from(JSON.stringify({ action: 'status', secret: 's1' }), 'utf8').toString('base64') });
  t('http+base64 распознан', dH.kind === 'http' && dH.action === 'status' && dH.secret === 's1');
  const dQ = decodeFnEvent({ httpMethod: 'GET', queryStringParameters: { action: 'status', secret: 'q' } });
  // v3.19: действие из адреса принимается, код из адреса — нет
  t('query: действие распознано, код из адреса не принят', dQ.action === 'status' && dQ.secret === '' && dQ.secretInUrl === true);
  const clean = sanitizeLinksPack({ format: 'crm-advokat-links', version: 1, cases: [
    { number: '2-1/2026', uid: 'U1', client: 'Смирнова Анна Петровна', clientPhone: '+7 900 000-00-00',
      links: [{ url: 'https://a.sudrf.ru/x', stage: 'Первая инстанция', courtNo: '2-1/2026', note: 'лишнее' }] },
    { number: 'без ссылок', links: [] } ] });
  t('санитизация: ФИО и лишние поля вычищены', !JSON.stringify(clean).includes('Смирнова') && !JSON.stringify(clean).includes('лишнее'));
  t('санитизация: дела без ссылок отброшены', clean.cases.length === 1 && clean.cases[0].links[0].url === 'https://a.sudrf.ru/x');
  t('санитизация: чужой формат отвергнут', sanitizeLinksPack({ format: 'x' }) === null);

  // ── v3.3: дайджест ──
  const EV = [
    { eventType:'hearing', date:'2026-09-09', title:'Заседание 09.09.2026 10:00', courtNo:'2-1/2026', judge:'Иванова И.И.', raw: JSON.stringify({ time:'10:00', room:'5' }) },
    { eventType:'hearing', date:'2026-09-20', title:'Заседание 20.09.2026', courtNo:'2-2/2026', raw:'{}' },
    { eventType:'caseflow', date:'2026-09-07', title:'Судебное заседание', courtNo:'2-1/2026', raw: JSON.stringify({ result:'Вынесено решение' }) },
    { eventType:'caseflow', date:'2026-08-01', title:'Регистрация иска', courtNo:'2-1/2026', raw:'{}' } ];
  const ST = { added:2, updated:1, failedCount:1, failed:[{ number:'2-3/2026', stage:'Апелляция', err:'HTTP 503' }] };
  const dg = buildDigest(EV, ST, '2026-09-08T04:31:00.000Z', 'changes');
  t('дайджест: шапка с датой и счётчиками', dg.startsWith('⚖ Сбор судов · 08.09.2026') && dg.includes('новых 2') && dg.includes('обновлено 1'));
  t('дайджест: заседание на завтра с временем, залом и судьёй', dg.includes('• 09.09 № 2-1/2026 10:00 зал 5 · Иванова И.И.'));
  t('дайджест: далёкое заседание не попало', !dg.includes('2-2/2026'));
  t('дайджест: движение за 3 дня с результатом', dg.includes('• 07.09 № 2-1/2026 — Судебное заседание → Вынесено решение') && !dg.includes('Регистрация иска'));
  t('дайджест: ошибки перечислены', dg.includes('Ошибок: 1') && dg.includes('2-3/2026 (Апелляция): HTTP 503'));
  t('дайджест: без изменений и заседаний — пусто в режиме changes', buildDigest([], { added:0, updated:0 }, '2026-09-08T04:31:00.000Z', 'changes') === '');
  t('дайджест: режим always шлёт и пустую сводку', buildDigest([], { added:0, updated:0 }, '2026-09-08T04:31:00.000Z', 'always').includes('Событий 0'));
  const big = Array.from({ length: 300 }, (_, i) => ({ eventType:'caseflow', date:'2026-09-08', title:'Событие номер ' + i + ' с длинным названием для проверки ограничения длины сообщения', courtNo:'2-' + i + '/2026', raw:'{}' }));
  t('дайджест: длина в пределах Telegram', buildDigest(big, { added:1 }, '2026-09-08T04:31:00.000Z', 'changes').length <= 3900);
  // ── v3.4: акты, слепок и изменения, группировка по хостам ──
  t('акт: решение первой инстанции', flowActKind('Судебное заседание', 'Вынесено решение по делу', 'Первая инстанция') === 'decision');
  t('акт: мотивированное решение', flowActKind('Изготовлено мотивированное решение в окончательной форме', '', 'Первая инстанция') === 'fullDecision');
  t('акт: апелляция', flowActKind('Судебное заседание', 'Вынесено апелляционное определение', 'Апелляция') === 'appeal' && flowActKind('Судебное заседание', 'Вынесено решение', 'Апелляция') === '');
  t('акт: кассация и вступление в силу', flowActKind('Судебное заседание', 'Оставлено без изменения', 'Кассация') === 'cass' && flowActKind('Решение вступило в законную силу', '', '') === 'inForce');
  t('акт: обычная строка — пусто', flowActKind('Регистрация иска', '', 'Первая инстанция') === '');
  const fevA = buildFlowEvents([{ title: 'Судебное заседание', date: '19.08.2026', result: 'Вынесено решение' }], { courtNo: '2-1/2026', stage: 'Первая инстанция' })[0];
  t('caseflow: raw.act проставлен', safeJson(fevA.raw).act === 'decision');
  const E1 = [
    { externalId: 'sud|2-1|2026-09-20|10:00|h', eventType: 'hearing', date: '2026-09-20', title: 'Заседание 20.09', courtNo: '2-1', raw: '{}' },
    { externalId: 'flow:2-1:aaaa', eventType: 'caseflow', date: '2026-09-01', title: 'Судебное заседание', courtNo: '2-1', raw: JSON.stringify({}) },
    { externalId: 'sud|2-2|2026-09-25|-|act', eventType: 'notice', date: '2026-09-25', title: 'Опубликован акт', courtNo: '2-2', raw: '' } ];
  const snap = snapshotOf(E1, '2026-09-10T00:00:00Z');
  t('слепок: все события, поля', Object.keys(snap.items).length === 3 && snap.items['sud|2-1|2026-09-20|10:00|h'].d === '2026-09-20');
  const E2 = [
    { externalId: 'sud|2-1|2026-10-02|10:00|h', eventType: 'hearing', date: '2026-10-02', title: 'Заседание 02.10', courtNo: '2-1', raw: '{}' },
    { externalId: 'flow:2-1:aaaa', eventType: 'caseflow', date: '2026-09-01', title: 'Судебное заседание', courtNo: '2-1', raw: JSON.stringify({ result: 'Заседание отложено' }) },
    { externalId: 'sud|2-2|2026-09-25|-|act', eventType: 'notice', date: '2026-09-25', title: 'Опубликован акт', courtNo: '2-2', raw: '' },
    { externalId: 'sud|2-3|2026-09-30|-|act', eventType: 'notice', date: '2026-09-30', title: 'Опубликован акт', courtNo: '2-3', raw: '' },
    { externalId: 'sud|2-4|2026-09-28|11:00|h', eventType: 'hearing', date: '2026-09-28', title: 'Заседание 28.09', courtNo: '2-4', raw: '{}' } ];
  const dd = diffEvents(snap, E2, '2026-09-12');
  t('изменения: перенос заседания', dd.moved.length === 1 && dd.moved[0].from === '2026-09-20' && dd.moved[0].to === '2026-10-02');
  t('изменения: новый результат', dd.results.length === 1 && dd.results[0].r === 'Заседание отложено');
  t('изменения: новый акт и новое заседание', dd.acts.length === 1 && dd.acts[0].c === '2-3' && dd.newHearings.length === 1 && dd.newHearings[0].c === '2-4');
  t('изменения: без слепка — пусто', diffCount(diffEvents(null, E2, '2026-09-12')) === 0 && diffCount(diffEvents({ items: {} }, E2, '2026-09-12')) === 0);
  t('изменения: текст', changesText(dd).join('\n').includes('• перенесено: № 2-1 20.09 → 02.10') && changesText(dd).join('\n').includes('• результат: № 2-1 01.09 Судебное заседание → Заседание отложено'));
  const dg34 = buildDigest([], { added: 0, updated: 0 }, '2026-09-12T04:31:00.000Z', 'changes', dd);
  t('дайджест: раздел изменений появляется даже без новых событий', dg34.includes('Изменения с прошлого сбора (4)') && dg34.includes('перенесено'));
  t('хост из ссылки', hostOf('https://kovrovsky--wld.sudrf.ru/modules.php?name=sud_delo') === 'kovrovsky--wld.sudrf.ru' && hostOf('мусор') === '');
  // ── v3.5: СУДиДЕЛО ──
  const recs = [{ id: 45, name: 'Д-7/2026', attributes: [{ code: 'x1', stringValue: 'А11-1234/2026' }, { code: 'x2', stringValue: 'https://kad.arbitr.ru/card/abc' }] }, { id: 46, name: 'Другое', attributes: [] }];
  t('СУДиДЕЛО: дело по номеру суда', sdFindCase(recs, 'А11-1234/2026', '') && sdFindCase(recs, 'А11-1234/2026', '').id === 45);
  t('СУДиДЕЛО: дело по ссылке, пробелы и регистр', sdFindCase(recs, '', 'https://KAD.arbitr.ru/card/abc').id === 45 && sdFindCase(recs, 'А11-9/2026', '') === null);
  const sch = sdScheduleToHearings({ items: [{ start: '2026-10-05T11:30:00', title: 'Судебное заседание, зал 3', stageName: 'Первая инстанция', comment: '' }, { start: '2026-10-20', title: 'Предварительное' }, { start: 'мусор' }] });
  t('СУДиДЕЛО: график → заседания', sch.length === 2 && sch[0].date === '05.10.2026' && sch[0].time === '11:30' && sch[0].room === '3' && sch[0].label.startsWith('Первая инстанция: ') && sch[1].time === '');
  const fl = sdProgressToFlow({ htmlTable: '<table><tr><th>Наименование события</th><th>Дата события</th><th>Результат события</th></tr><tr><td>Судебное заседание</td><td>19.08.2026</td><td>Вынесено решение</td></tr></table>' });
  t('СУДиДЕЛО: движение из HTML без заголовка', fl.length === 1 && fl[0].result === 'Вынесено решение');
  t('СУДиДЕЛО: конфиг без ключа — null, с ключом — url по умолчанию', sdCfg({}) === null && sdCfg({ sudodeloApiKey: 'k' }).url === 'https://api-sudodelo.torkndgov.ru' && sdCfg({ sudodeloApiKey: 'k', sudodeloAutocreate: '0' }).autocreate === false);
  // ── v3.6 ──
  t('crmNumber в событиях', buildEvents({ hearings: [{ date: '25.09.2026', time: '10:00', room: '', label: 'x', result: '' }], acts: [] }, { number: 'Д-19/2026', courtNo: '2-1', stage: 'Первая инстанция', sinceDays: 45, today: '2026-08-18' })[0].crmNumber === 'Д-19/2026'
    && buildFlowEvents([{ title: 'Регистрация', date: '01.09.2026' }], { number: 'Д-19/2026', courtNo: '2-1', stage: 'Первая инстанция' })[0].crmNumber === 'Д-19/2026');
  t('сверка страницы: номер есть', pageHasNumber('<td>Номер дела</td><td>2-1500/2026 ~ М-700/2026</td>', '2-1500/2026') && pageHasNumber('<b>№&nbsp;2 - 1500 / 2026</b>', '2-1500/2026'));
  t('сверка страницы: номера нет / без номера — не проверяем', !pageHasNumber('<td>Номер дела</td><td>2-1600/2026</td>', '2-1500/2026') && pageHasNumber('что угодно', ''));
  // ── v3.7: карточка дела ──
  const CARD = `<html><head><title>Ковровский городской суд Владимирской области - Судебное делопроизводство</title></head><body>
<table><tr><td>Уникальный идентификатор дела</td><td>33RS0011-01-2026-001500-11</td></tr><tr><td>Дата поступления</td><td>03.06.2026</td></tr>
<tr><td>Судья</td><td>Чепик Ирина Рашидовна</td></tr><tr><td>Категория дела</td><td>Споры, связанные с жилищными отношениями → О взыскании платы за жилую площадь</td></tr>
<tr><td>Номер дела</td><td>2-1500/2026 ~ М-700/2026</td></tr><tr><td>Результат рассмотрения</td><td>Иск удовлетворен</td></tr></table>
<table><tr><th>Вид лица</th><th>Лицо</th><th>Перечень статей</th></tr><tr><td>ИСТЕЦ</td><td>Горелова Мария Константиновна</td><td></td></tr><tr><td>ОТВЕТЧИК</td><td>ООО "Управляющая компания"</td><td></td></tr></table></body></html>`;
  const cd = parseCaseCard(CARD);
  t('карточка: номер (первый из пары), УИД, судья, дата, категория, результат, суд из title', cd.number === '2-1500/2026' && cd.uid === '33RS0011-01-2026-001500-11' && cd.judge === 'Чепик Ирина Рашидовна' && cd.registered === '2026-06-03' && /жилищными/.test(cd.category) && cd.result === 'Иск удовлетворен' && cd.court === 'Ковровский городской суд Владимирской области');
  t('карточка: стороны', cd.parties.length === 2 && cd.parties[0].role === 'Истец' && cd.parties[0].name === 'Горелова Мария Константиновна' && cd.parties[1].role === 'Ответчик' && cd.parties[1].name === 'ООО "Управляющая компания"');
  const cdM = parseCaseCard('<div>Номер дела</div><div>02-2485/2026</div><div>Судья</div><div>Обломова А.Н.</div><div>Истец: Кашицын Василий Евгеньевич</div><div>Ответчик: АО "Страховая"</div>');
  t('карточка Москвы: подписи в div, стороны через двоеточие', cdM.number === '02-2485/2026' && cdM.judge === 'Обломова А.Н.' && cdM.parties.length === 2 && cdM.parties[1].name === 'АО "Страховая"');
  const ce = buildCardEvent(cd, { number: 'Д-19/2026', courtNo: '2-1500/2026', stage: 'Первая инстанция', url: 'https://x' });
  t('событие casecard', ce.eventType === 'casecard' && ce.crmNumber === 'Д-19/2026' && JSON.parse(ce.raw).card.judge === 'Чепик Ирина Рашидовна' && ce.date === '2026-06-03');
  t('пустая страница — без события', buildCardEvent(parseCaseCard('<html></html>'), { number: 'x' }) === null);
  // ── v3.8 ──
  const P38 = '<table><tr><td>Решение вопроса о принятии иска (заявления, жалобы) к рассмотрению</td><td>03.09.2026</td><td>11:17</td><td></td><td>Иск (заявление, жалоба) принят к производству</td></tr><tr><td>Судебное заседание</td><td>30.09.2026</td><td>11:00</td><td>5</td><td></td></tr><tr><td>Подготовка дела (собеседование)</td><td>15.09.2026</td><td>10:00</td><td></td><td>Назначено судебное заседание</td></tr></table>';
  const pg38 = parseCasePage(P38);
  t('принятие иска к производству — не заседание; собеседование — заседание (явка в суд)', pg38.hearings.length === 2 && pg38.hearings[0].date === '30.09.2026' && pg38.hearings[0].room === '5' && pg38.hearings[1].date === '15.09.2026');
  t('все три строки остаются в движении дела', parseFlow('<div>ДВИЖЕНИЕ ДЕЛА</div>' + P38).length === 3);
  const P310 = '<table><tr><td>Вынесено определение о подготовке дела к судебному разбирательству</td><td>19.03.2026</td><td>10:00</td><td></td><td></td></tr><tr><td>Вынесено определение о назначении дела к судебному разбирательству</td><td>20.03.2026</td><td>10:00</td><td></td><td></td></tr><tr><td>Подготовка дела (собеседование)</td><td>25.03.2026</td><td>09:30</td><td>7</td><td></td></tr><tr><td>Судебное заседание</td><td>03.04.2026</td><td>14:00</td><td>7</td><td>Заседание отложено</td></tr></table>';
  t('v3.10: определения о подготовке/назначении — не заседания; собеседование и заседание — заседания', parseCasePage(P310).hearings.map(h => h.date).join() === '25.03.2026,03.04.2026');
  const P311 = '<table><tr><td>Судебное заседание</td><td>29.01.2026</td><td>15:00</td><td>Судебный зал №7</td><td></td></tr><tr><td>Судебное заседание</td><td>19.02.2026</td><td>15:30</td><td>кабинет судьи</td><td></td></tr><tr><td>Судебное заседание</td><td>24.06.2026</td><td>10:00</td><td>кабинет судьи</td><td>Вынесено решение</td></tr></table>';
  const h311 = parseCasePage(P311).hearings;
  t('v3.11: «Судебный зал №7» и «кабинет судьи» — место, а не итог', h311[0].room === 'зал 7' && h311[0].result === '' && h311[1].room === 'кабинет судьи' && h311[1].result === '' && h311[2].result === 'Вынесено решение');
  t('v3.11: суд страницы в событиях', buildEvents({ hearings: [{ date: '25.09.2026', time: '10:00', room: '', label: 'x', result: '' }], acts: [] }, { number: 'Д-1', courtNo: '2-1', stage: 'Апелляция', sinceDays: 45, today: '2026-08-18', court: 'Владимирский областной суд' })[0].court === 'Владимирский областной суд');
  t('сущности HTML в карточке', decodeEntities('Споры &rarr; жильё &laquo;а&raquo; &#8594; &#x2192; &amp;') === 'Споры → жильё «а» → → &');
  t('v3.9: вся история заседаний при allPast', buildEvents({ hearings: [{ date: '10.01.2024', time: '10:00', room: '', label: 'Судебное заседание', result: '' }, { date: '05.03.2026', time: '09:00', room: '', label: 'Судебное заседание', result: 'Отложено' }], acts: [] }, { number: 'Д-1', courtNo: '2-1', stage: 'Первая инстанция', sinceDays: 36500, allPast: true, today: '2026-09-15' }).length === 2
    && buildEvents({ hearings: [{ date: '10.01.2024', time: '10:00', room: '', label: 'Судебное заседание', result: '' }], acts: [] }, { number: 'Д-1', courtNo: '2-1', stage: 'Первая инстанция', sinceDays: 45, today: '2026-09-15' }).length === 0);
  // ── v3.12: номер дела на реальной вёрстке ──
  t('v3.12: «Номер дела ~ материала» (ГАС)', parseCaseCard('<table><tr><td>Номер дела ~ материала</td><td>33-3331/2026 ~ М-100/2026</td></tr></table>').number === '33-3331/2026');
  t('v3.12: заголовок «ДЕЛО № …» без таблицы', parseCaseCard('<h2>ДЕЛО № 33-3331/2026</h2><table><tr><td>Судья</td><td>Сергеева</td></tr></table>').number === '33-3331/2026');
  t('v3.12: номера с буквами и арбитраж', parseCaseCard('<div>Номер дела</div><div>33а-512/2026</div>').number === '33а-512/2026' && parseCaseCard('<div>ДЕЛО № 8Г-12345/2026</div>').number === '8Г-12345/2026' && parseCaseCard('<div>Номер дела</div><div>А11-1234/2026</div>').number === 'А11-1234/2026');
  t('v3.12: нет номера — поле отсутствует', parseCaseCard('<div>Судья</div><div>Иванов</div>').number === undefined);
  t('категория с &rarr; читается со стрелкой', parseCaseCard('<div>Категория дела</div><div>Споры, связанные с имущественными правами &rarr; О взыскании</div>').category === 'Споры, связанные с имущественными правами → О взыскании');
  // ── v3.20: дело по УИД и любому номеру, стороны по строкам таблицы, жалобы (данные вымышленные; разметка кассации — по снимку) ──
  const C320 = `<html><head><title>Второй кассационный суд общей юрисдикции - Судебное делопроизводство</title></head><body>
<ul><li>ПРОИЗВОДСТВО</li><li>РАССМОТРЕНИЕ В НИЖЕСТОЯЩЕМ СУДЕ</li><li>ЖАЛОБЫ</li><li>УЧАСТНИКИ</li></ul>
<table><tr><td>Уникальный идентификатор дела</td><td>33RS0011-01-2025-004499-82</td></tr><tr><td>Номер дела</td><td>8Г-31317/2026</td></tr><tr><td>Дата поступления</td><td>07.10.2026</td></tr><tr><td>Судья-докладчик</td><td>Вымышленный Сергей Сергеевич</td></tr></table>
<table><tr><th>Вид лица, участвующего в деле</th><th>Фамилия / наименование</th><th>Перечень статей</th></tr><tr><td>Истец</td><td>ИП Вымышлова Е.А.</td><td></td></tr><tr><td>Ответчик</td><td>Громов Пётр Ильич</td><td></td></tr><tr><td>Представитель</td><td></td><td></td></tr></table>
<table><tr><td>Вышестоящий суд</td><td>Владимирский областной суд</td></tr><tr><td>Номер дела</td><td>33-2422/2026</td></tr><tr><td>Процессуальный статус</td><td>Взыскатель</td></tr></table>
<table><tr><td>Судебный акт #1 (Решения)</td><td>Апелляционное определение от 20.08.2026</td></tr></table>
<table><tr><th>Дата поступления</th><th>Процессуальный статус заявителя</th><th>Лицо подавшее жалобу (заявитель)</th><th>Дата передачи жалобы на изучение</th><th>С истребованием дела</th><th>Дата опр. об оставл. жалобы без движения / напр. уведомления</th><th>Срок для устранения недостатков</th><th>Дата поступления исправленной жалобы</th><th>Дата вынесения определения по итогам изучения</th></tr>
<tr><td>05.10.2026</td><td>Истец</td><td>ИП Вымышлова Е.А.</td><td>08.10.2026</td><td>Да</td><td>09.10.2026</td><td>30.10.2026</td><td></td><td></td></tr></table></body></html>`;
  const cd320 = parseCaseCard(C320);
  t('v3.20: стороны только из строки таблицы — роль без имени не берёт ячейку соседней таблицы', cd320.parties.map(p => p.role + ':' + p.name).join('; ') === 'Истец:ИП Вымышлова Е.А.; Ответчик:Громов Пётр Ильич');
  t('v3.20: карточка кассации — номер, УИД, судья-докладчик, дата поступления', cd320.number === '8Г-31317/2026' && cd320.uid === '33RS0011-01-2025-004499-82' && cd320.judge === 'Вымышленный Сергей Сергеевич' && cd320.registered === '2026-10-07');
  const cmp320 = parseComplaints(C320);
  t('v3.20: вкладка «Жалобы» кассации прочитана по заголовкам столбцов', cmp320.length === 1 && cmp320[0].date === '2026-10-05' && cmp320[0].by === 'ИП Вымышлова Е.А.' && cmp320[0].status === 'Истец' && cmp320[0].noMotion === '2026-10-09' && cmp320[0].fixDue === '2026-10-30' && cmp320[0].toStudy === '2026-10-08' && cmp320[0].withCase === 'Да');
  const cev = buildComplaintEvents(cmp320, { number: 'Д-61/2026', uid: '33RS0011-01-2025-004499-82', courtNo: '8Г-31317/2026', stage: 'Кассация', url: 'https://x' });
  t('v3.20: событие complaint — заголовок с состоянием, инстанция, ключ по УИД', cev.length === 1 && cev[0].eventType === 'complaint' && cev[0].date === '2026-10-05' && cev[0].crmNumber === 'Д-61/2026'
    && cev[0].title === 'Подана кассационная жалоба 05.10.2026 — ИП Вымышлова Е.А. · оставлена без движения 09.10.2026, срок устранения до 30.10.2026' && JSON.parse(cev[0].raw).inst === 'Кассация' && JSON.parse(cev[0].raw).fixDue === '2026-10-30' && cev[0].externalId.startsWith('cmp:33RS0011-01-2025-004499-82:'));
  const F320 = '<html><head><title>Ковровский городской суд</title></head><body><div>Дело № 2-67/2026</div><div>ОБЖАЛОВАНИЕ РЕШЕНИЙ, ОПРЕДЕЛЕНИЙ (ПОСТ.)</div><table><tr><th>Вид жалобы (представления)</th><th>Дата поступления жалобы (представления)</th><th>Кем подана жалоба (представление)</th><th>Результат рассмотрения жалобы</th><th>Дата направления дела в вышестоящий суд</th></tr><tr><td>Апелляционная жалоба</td><td>12.07.2026</td><td>Громов П.И.</td><td>Передано в апелляцию</td><td>25.07.2026</td></tr></table><table><tr><th>Вид лица</th><th>Лицо</th></tr><tr><td>ОТВЕТЧИК</td><td>Громов Пётр Ильич</td></tr></table></body></html>';
  const fc320 = parseComplaints(F320), fev320 = buildComplaintEvents(fc320, { number: 'Д-61/2026', uid: '', courtNo: '2-67/2026', stage: 'Первая инстанция', url: 'https://x' });
  t('v3.20: «Обжалование решений» первой инстанции — апелляционная жалоба, кто подал, результат, направление дела', fc320.length === 1 && fc320[0].kind === 'Апелляционная жалоба' && fc320[0].by === 'Громов П.И.' && fc320[0].sentUp === '2026-07-25' && fev320[0].title === 'Подана апелляционная жалоба 12.07.2026 — Громов П.И. · Передано в апелляцию · дело направлено в вышестоящий суд 25.07.2026' && JSON.parse(fev320[0].raw).inst === 'Апелляция');
  t('v3.20: строка таблицы жалоб не становится стороной; стороны первой инстанции читаются', parseCaseCard(F320).parties.map(p => p.role + ':' + p.name).join() === 'Ответчик:Громов Пётр Ильич');
  t('v3.20: дело узнано по УИД / по номеру другой инстанции / не узнано', pageMatchesCase(C320, { courtNo: '2-67/2026' }, { uid: '33RS0011-01-2025-004499-82' }).byUid === true && pageMatchesCase(C320, { courtNo: '2-67/2026' }, { uid: '', numbers: ['33-2422/2026'] }).byOther === '33-2422/2026'
    && pageMatchesCase(C320, { courtNo: '2-67/2026' }, { uid: '77RS0001-01-2026-000001-01', courtNoApp: '33-1/2026' }).ok === false && pageMatchesCase(C320, { courtNo: '8Г-31317/2026' }, {}).ok === true && pageMatchesCase(C320, { courtNo: '' }, {}).ok === true);
  t('v3.20: номера с буквами на странице', pageCaseNumbers(C320).includes('8Г-31317/2026') && pageCaseNumbers(C320).includes('33-2422/2026') && pageCaseNumbers('<div>Дело № 33а-512/2026 и А11-1234/2026</div>').join() === '33а-512/2026,А11-1234/2026');
  // ── v3.21: жалобы в дайджесте без имён ──
  const dt321 = cmpDigestText(cev[0]);
  t('v3.21: строка жалобы для дайджеста — без имени, со статусом заявителя и состоянием', dt321 === 'подана кассационная жалоба 05.10 (истец) · оставлена без движения 09.10.2026, срок устранения до 30.10.2026' && !dt321.includes('Вымышлова'));
  const snap321 = snapshotOf(cev, '2026-10-10T00:00:00Z');
  t('v3.21: слепок хранит состояние жалобы', snap321.items[cev[0].externalId].s === '2026-10-09|2026-10-30|||||' && snap321.items[cev[0].externalId].k === 'complaint');
  const cevUpd = buildComplaintEvents([{ ...cmp320[0], fixed: '2026-10-20' }], { number: 'Д-61/2026', uid: '33RS0011-01-2025-004499-82', courtNo: '8Г-31317/2026', stage: 'Кассация', url: 'https://x' });
  const dd321 = diffEvents(snap321, cevUpd.concat(fev320), '2026-10-21');
  t('v3.21: изменения — новая жалоба и жалоба с изменившимся состоянием', dd321.complaints.length === 2 && dd321.complaints.some(x => x.chg === true && x.c === '8Г-31317/2026') && dd321.complaints.some(x => x.chg === false && x.c === '2-67/2026') && diffCount(dd321) === 2);
  t('v3.21: то же состояние — изменения нет', diffEvents(snap321, cev, '2026-10-21').complaints.length === 0);
  const snapOld = { at: '2026-10-10T00:00:00Z', items: { [cev[0].externalId]: { d: '2026-10-05', t: cev[0].title, r: '', k: 'complaint', c: '8Г-31317/2026' } } };
  t('v3.21: слепок прежней версии без состояния — изменение не выдумывается', diffEvents(snapOld, cevUpd, '2026-10-21').complaints.length === 0);
  const ct321 = changesText(dd321).join('\n');
  t('v3.21: текст изменений — без имён, с номером дела', ct321.includes('• жалоба (изменение): № 8Г-31317/2026 — подана кассационная жалоба 05.10 (истец) · оставлена без движения 09.10.2026, срок устранения до 30.10.2026 · исправленная жалоба 20.10.2026') && ct321.includes('• жалоба: № 2-67/2026 — подана апелляционная жалоба 12.07 · Передано в апелляцию · дело направлено в вышестоящий суд 25.07.2026') && !ct321.includes('Вымышлова') && !ct321.includes('Громов'));
  const dg321 = buildDigest(cev, { added: 1, updated: 0 }, '2026-10-07T04:31:00.000Z', 'changes');
  t('v3.21: раздел «Жалобы за 3 дня» в дайджесте без имени', dg321.includes('Жалобы за 3 дня:') && dg321.includes('• № 8Г-31317/2026 — подана кассационная жалоба 05.10 (истец) · оставлена без движения 09.10.2026') && !dg321.includes('Вымышлова'));
  t('v3.21: жалоба старше 3 дней в раздел не попадает', !buildDigest(cev, { added: 1 }, '2026-10-20T04:31:00.000Z', 'changes').includes('Жалобы за 3 дня'));
  const dg321c = buildDigest([], { added: 0, updated: 0 }, '2026-10-21T04:31:00.000Z', 'changes', dd321);
  t('v3.21: новая жалоба сама запускает дайджест (режим changes)', dg321c.includes('Изменения с прошлого сбора (2)') && dg321c.includes('• жалоба: № 2-67/2026'));
  t('v3.21 (урок 156): ярлыки «Номер дела», «Дата поступления», «Суд» именем не считаются, фамилии с теми же буквами — считаются', PARTY_NOT_NAME.test('Номер дела') && PARTY_NOT_NAME.test('Дата поступления') && PARTY_NOT_NAME.test('Суд') && PARTY_NOT_NAME.test('Результат рассмотрения') && !PARTY_NOT_NAME.test('Судакова Анна Петровна') && !PARTY_NOT_NAME.test('Номеров Пётр Ильич') && !PARTY_NOT_NAME.test('Датаев Р. Р.'));
  t('v3.21 (урок 156): роль без имени перед ярлыком «Номер дела» не даёт участника', parseCaseCard('<html><body><table><tr><td>Представитель</td><td>Номер дела</td><td>33-1/2026</td></tr><tr><td>Истец</td><td>Громов Пётр Ильич</td></tr></table></body></html>').parties.map(p => p.role + ':' + p.name).join() === 'Истец:Громов Пётр Ильич');
  t('v3.21: возвращённая жалоба — в хвосте состояния и в заголовке события', cmpTail({ returned: '2026-10-12' }).join() === 'возвращена 12.10.2026' && buildComplaintEvents([{ ...cmp320[0], returned: '2026-10-12' }], { number: 'Д-61/2026', uid: '', courtNo: '8Г-31317/2026', stage: 'Кассация', url: '' })[0].title.endsWith(' · возвращена 12.10.2026') && cmpStateOf({ returned: '2026-10-12' }) === '||||||2026-10-12');
  // ── v3.22: вид жалобы в ключе события ──
  const two322 = buildComplaintEvents([{ ...fc320[0], kind: 'Апелляционная жалоба' }, { ...fc320[0], kind: 'Частная жалоба' }], { number: 'Д-61/2026', uid: '', courtNo: '2-67/2026', stage: 'Первая инстанция', url: 'https://x' });
  t('v3.22 (аудит 157, A3): апелляционная и частная жалобы одного лица в один день — разные ключи, обе в слепке', two322.length === 2 && two322[0].externalId !== two322[1].externalId && Object.keys(snapshotOf(two322, '2026-10-10T00:00:00Z').items).length === 2);
  t('v3.22: изменение состояния жалобы ключ не меняет', buildComplaintEvents([{ ...fc320[0], noMotion: '2026-07-20', fixDue: '2026-08-01', result: 'Возвращена' }], { number: 'Д-61/2026', uid: '', courtNo: '2-67/2026', stage: 'Первая инстанция', url: 'https://x' })[0].externalId === fev320[0].externalId);
  t('v3.22: вид в ключе — без регистра и лишних пробелов; без вида — ключ 3.21', cmpKindKey({ kind: ' Частная  ЖАЛОБА ' }) === '|частная жалоба' && cmpKindKey({ kind: '' }) === '' && buildComplaintEvents([{ ...cmp320[0], kind: '' }], { number: 'Д-61/2026', uid: '33RS0011-01-2025-004499-82', courtNo: '8Г-31317/2026', stage: 'Кассация', url: 'https://x' })[0].externalId === cev[0].externalId);
  console.log(`коллектор: ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
}

// ═══════════════ ОБЛАЧНЫЙ РЕЖИМ: функция Яндекс Облака ═══════════════
// Точка входа задаётся файлом-мостиком index.js (CommonJS → ESM):
//   module.exports.handler = async (e, c) => (await import('./collector-sud.mjs')).handler(e, c);
const ENV = process.env;
const LINKS_KEY = ENV.LINKS_KEY || 'collector/links.json';
const STATUS_KEY = ENV.STATUS_KEY || 'collector/status.json';
const STATE_KEY = ENV.STATE_KEY || 'collector/state.json'; // v3.4: слепок прошлого прогона
function fnCfg() {
  return { bridge: String(ENV.BRIDGE_URL || '').trim(), secret: String(ENV.BRIDGE_SECRET || '').trim(), // v3.15: без пробелов и переносов строк

    delayMs: Number(ENV.DELAY_MS) || 1500, sinceDays: Number(ENV.SINCE_DAYS) || 45,
    timeoutMs: Number(ENV.TIMEOUT_MS) || 25000, parallel: Number(ENV.PARALLEL) || 3,
    sudodeloApiKey: ENV.SUDODELO_API_KEY || '', sudodeloApiUrl: ENV.SUDODELO_API_URL || '', sudodeloAutocreate: ENV.SUDODELO_AUTOCREATE }; // v3.5
}
async function iamToken(context) {
  const t = context && context.token && (context.token.access_token || context.token.accessToken);
  if (t) return t;
  // v3.19: с пределом ожидания
  const r = await fetchT('http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token',
    { headers: { 'Metadata-Flavor': 'Google' } }, 5000);
  if (!r.ok) throw new Error('IAM-токен недоступен: назначьте функции сервисный аккаунт');
  return (jsonOf(r.text) || {}).access_token;
}
const s3url = key => `https://storage.yandexcloud.net/${ENV.BUCKET}/${key}`;
// v3.19: бакет — с пределом ожидания 30 с
async function s3get(key, iam) {
  const r = await fetchT(s3url(key), { headers: { Authorization: 'Bearer ' + iam } }, 30000);
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('бакет: HTTP ' + r.status + ' при чтении ' + key);
  return r.text;
}
async function s3put(key, body, iam) {
  const r = await fetchT(s3url(key), { method: 'PUT',
    headers: { Authorization: 'Bearer ' + iam, 'Content-Type': 'application/json; charset=utf-8' }, body }, 30000);
  if (!r.ok) throw new Error('бакет: HTTP ' + r.status + ' при записи ' + key);
}

// В облако уходят только реквизиты дел и ссылки — ФИО и любые лишние поля отсекаются
function sanitizeLinksPack(pack) {
  if (!pack || pack.format !== 'crm-advokat-links' || !Array.isArray(pack.cases)) return null;
  return {
    format: 'crm-advokat-links', v: pack.v || pack.version || 1,
    exportedAt: pack.exportedAt || new Date().toISOString(),
    cases: pack.cases.map(c => ({
      number: String(c.number || ''), uid: String(c.uid || ''), stage: String(c.stage || ''),
      courtNo: String(c.courtNo || ''), courtNoApp: String(c.courtNoApp || ''), courtNoCass: String(c.courtNoCass || ''),
      links: (Array.isArray(c.links) ? c.links : []).map(l => ({
        url: String(l.url || ''), stage: String(l.stage || ''), courtNo: String(l.courtNo || '') }))
    })).filter(c => c.links.length)
  };
}

// Разбор события функции: таймер-триггер или HTTP (тело бывает в base64)
function decodeFnEvent(event) {
  const ev = event || {};
  if (Array.isArray(ev.messages) && ev.messages.length && !ev.httpMethod)
    return { kind: 'timer', action: 'collect', secret: '', body: {} };
  let raw = ev.body || '';
  if (ev.isBase64Encoded && raw) { try { raw = Buffer.from(raw, 'base64').toString('utf8'); } catch (e) { raw = ''; } }
  let body = {};
  if (raw) { try { body = JSON.parse(raw); } catch (e) { body = {}; } }
  const q = ev.queryStringParameters || {};
  // v3.19: код — только из тела запроса; код в адресе отмечается (secretInUrl) и не принимается
  return { kind: 'http', method: ev.httpMethod || 'POST',
    action: body.action || q.action || '', secret: typeof body.secret === 'string' ? body.secret : '', secretInUrl: !!q.secret, body };
}
// v3.19: сравнение кода без утечки по времени — отпечатки SHA-256 одинаковой длины
function secretOk(given) {
  const want = String(ENV.SECRET || '');
  if (!want || typeof given !== 'string' || !given) return false;
  const a = crypto.createHash('sha256').update(given, 'utf8').digest(), b = crypto.createHash('sha256').update(want, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}
const fnResp = (code, obj) => ({ statusCode: code,
  headers: { 'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }, // v3.2: preflight из браузера CRM
  body: JSON.stringify(obj) });

// ── v3.3: Telegram-дайджест ──
// Текст дайджеста из собранных событий и статуса. Без ФИО: номера дел, суды, даты — то же, что шлёт сама CRM.
function buildDigest(events, status, nowISO, mode, diff) {
  const today = (nowISO || new Date().toISOString()).slice(0, 10);
  const plus = n => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const ru = iso => iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}` : '';
  const soon = plus(3), recent = plus(-3);
  const hearings = events.filter(e => e.eventType === 'hearing' && e.date >= today && e.date <= soon)
    .sort((a, b) => a.date.localeCompare(b.date) || String(a.title).localeCompare(String(b.title)));
  const flow = events.filter(e => e.eventType === 'caseflow' && e.date >= recent && e.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date));
  const changed = (status.added || 0) + (status.updated || 0);
  const errors = status.failedCount || 0;
  const dc = diffCount(diff);
  if (mode !== 'always' && !hearings.length && !changed && !errors && !dc) return '';
  const lines = [`⚖ Сбор судов · ${ru(today)}.${today.slice(0, 4)}`];
  lines.push(`Событий ${events.length} · новых ${status.added || 0} · обновлено ${status.updated || 0}${status.partial ? ' · собран не весь список' : ''}`);
  if (dc) { lines.push('', `Изменения с прошлого сбора (${dc}):`); lines.push(...changesText(diff)); } // v3.4
  if (hearings.length) {
    lines.push('', 'Заседания в ближайшие 3 дня:');
    hearings.slice(0, 12).forEach(e => { const raw = safeJson(e.raw); lines.push(`• ${ru(e.date)} ${e.courtNo ? '№ ' + e.courtNo : ''}${raw.time ? ' ' + raw.time : ''}${raw.room ? ' зал ' + raw.room : ''}${e.judge ? ' · ' + e.judge : ''}`.replace(/\s+/g, ' ')); });
    if (hearings.length > 12) lines.push(`… и ещё ${hearings.length - 12}`);
  }
  if (flow.length) {
    lines.push('', 'Движение дела за 3 дня:');
    flow.slice(0, 10).forEach(e => { const raw = safeJson(e.raw); lines.push(`• ${ru(e.date)} ${e.courtNo ? '№ ' + e.courtNo + ' — ' : ''}${e.title}${raw.result ? ' → ' + raw.result : ''}`); });
    if (flow.length > 10) lines.push(`… и ещё ${flow.length - 10}`);
  }
  // v3.21: жалобы, поступившие за 3 дня (по дате поступления) — без имён; новые и изменившиеся жалобы — в разделе изменений
  const cmps = events.filter(e => e.eventType === 'complaint' && e.date >= recent && e.date <= today).sort((a, b) => b.date.localeCompare(a.date));
  if (cmps.length) {
    lines.push('', 'Жалобы за 3 дня:');
    cmps.slice(0, 10).forEach(e => lines.push(`• ${e.courtNo ? '№ ' + e.courtNo + ' — ' : ''}${cmpDigestText(e)}`));
    if (cmps.length > 10) lines.push(`… и ещё ${cmps.length - 10}`);
  }
  if (errors) {
    lines.push('', `Ошибок: ${errors}`);
    (status.failed || []).slice(0, 3).forEach(f => lines.push(`• ${f.number || ''} (${f.stage || ''}): ${f.err || ''}`));
  }
  let text = lines.join('\n');
  if (text.length > 3900) text = text.slice(0, 3880) + '\n…';
  return text;
}
function safeJson(t) { try { return JSON.parse(t || '{}') || {}; } catch (e) { return {}; } }
async function tgSend(text) {
  // v3.19: с пределом ожидания 15 с; адрес с токеном в текст ошибки не попадает (только имя сайта)
  const r = await fetchT(`https://api.telegram.org/bot${ENV.TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ENV.TG_CHAT, text, disable_web_page_preview: true })
  }, 15000);
  const j = jsonOf(r.text);
  if (!j || !j.ok) throw new Error('Telegram: ' + (j && j.description ? j.description : 'HTTP ' + r.status));
}

async function cloudCollect(context, reason) {
  const started = Date.now();
  const iam = await iamToken(context);
  const rawLinks = await s3get(LINKS_KEY, iam);
  if (!rawLinks) return { ok: false, error: 'нет списка дел: пришлите его действием linksput или положите файл ' + LINKS_KEY + ' в бакет' };
  let pack = null;
  try { pack = sanitizeLinksPack(JSON.parse(rawLinks)); } catch (e) {}
  if (!pack) return { ok: false, error: 'список дел неверного формата (ожидается выгрузка CRM format=crm-advokat-links)' };
  // v3.18: перечень пуст — дел для обхода нет: состояние ok, на сервер ничего не уходит, слепок прежний
  if (!pack.cases.length) {
    const status = { ok: true, state: 'ok', stateText: 'дел для обхода нет: перечень пуст (все дела сняты с наблюдения)', at: new Date().toISOString(), reason, tookMs: Date.now() - started,
      collectorVer: COLLECTOR_VER, cases: 0, pages: 0, flowRows: 0, events: 0, sent: 0, added: 0, updated: 0, blocked: 0, kadSkipped: 0, unparsed: 0, failedCount: 0, failed: [], partial: false, changes: 0, changesList: [] };
    try { await s3put(STATUS_KEY, JSON.stringify(status, null, 1), iam); } catch (e) { console.log('статус не записан в бакет: ' + (e.message || e)); }
    console.log('Сбор: перечень дел пуст — обходить нечего');
    return status;
  }
  const cfg = fnCfg();
  if (!cfg.bridge || !cfg.secret) return { ok: false, error: 'не заданы BRIDGE_URL / BRIDGE_SECRET в переменных функции' };
  const deadline = started + (Number(ENV.BUDGET_MS) || 480000);
  const logf = m => console.log(m);
  logf(`Старт облачного сбора (${reason}, коллектор v${COLLECTOR_VER}): дел ${pack.cases.length}`);
  const { events, stats } = await collectRun(pack, cfg, logf, deadline);
  let prevState = null; try { const rs = await s3get(STATE_KEY, iam); prevState = rs ? JSON.parse(rs) : null; } catch (e) {} // v3.4
  const diff = diffEvents(prevState, events, new Date().toISOString().slice(0, 10));
  let res = { sent: 0, added: 0, updated: 0 }, sendErr = '';
  if (events.length) { try { res = await sendEvents(cfg, events); } catch (e) { sendErr = String(e.message || e); } }
  const status = { ok: !sendErr, ...collectState(stats, sendErr), at: new Date().toISOString(), reason, tookMs: Date.now() - started,
    collectorVer: COLLECTOR_VER, cases: stats.cases, pages: stats.pages, flowRows: stats.flowRows,
    events: events.length, sent: res.sent, added: res.added, updated: res.updated,
    blocked: stats.blocked, kadSkipped: stats.kadSkipped, kadViaSudodelo: stats.kadViaSudodelo || 0, kadCreated: stats.kadCreated || 0, linkMismatch: stats.linkMismatch || 0, unparsed: stats.unparsed,
    failedCount: stats.failed, failed: stats.errors, partial: stats.partial,
    changes: diffCount(diff), changesList: changesText(diff).slice(0, 20), // v3.4
    error: sendErr || undefined };
  // v3.16: слепок — только когда события доставлены; иначе недоставленные изменения считались бы уже известными
  if (!stats.partial && !sendErr) { try { await s3put(STATE_KEY, JSON.stringify(snapshotOf(events, status.at), null, 1), iam); } catch (e) { console.log('слепок не записан в бакет: ' + (e.message || e)); } }
  try { await s3put(STATUS_KEY, JSON.stringify(status, null, 1), iam); }
  catch (e) { console.log('статус не записан в бакет: ' + (e.message || e)); }
  if (sendErr) console.log('✗ Отправка на /bridge не удалась: ' + sendErr);
  // v3.3: дайджест в Telegram — если заданы TG_TOKEN и TG_CHAT; TG_DIGEST=always шлёт и пустые сводки
  if (ENV.TG_TOKEN && ENV.TG_CHAT) {
    try { const text = buildDigest(events, status, status.at, ENV.TG_DIGEST || 'changes', diff); if (text) { await tgSend(text); status.telegram = 'sent'; } else status.telegram = 'skipped'; }
    catch (e) { status.telegram = 'error: ' + (e.message || e); console.log('✗ ' + status.telegram); }
  }
  return status;
}

// v3.7: одна ссылка сразу — карточка и события (без бакета и /bridge; CRM применяет ответ сама)
// ═══ v3.13: API Assist — карточка дела ГАС «Правосудие» по ссылке, структурированным JSON ═══
// Документация: https://api-assist.com/documentation/sudrf-custom-api.txt. Ключ — только в переменных функции.
const AA = { key: String(ENV.API_ASSIST_KEY || '').trim(), mode: String(ENV.API_ASSIST_MODE || 'fallback').toLowerCase(), used: 0, errors: 0, lastError: '' };
const aaEnabled = () => !!AA.key && AA.mode !== 'off';
async function aaFetchCase(url, timeoutMs) {
  const api = 'https://service.api-assist.com/parser/sudrf_custom_api/?key=' + encodeURIComponent(AA.key) + '&url=' + encodeURIComponent(url);
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), timeoutMs || 25000);
    try {
      const r = await fetch(api, { signal: ctrl.signal }); const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch (e) { j = null; }
      if (r.status === 403 || (j && j.error)) { AA.errors++; AA.lastError = (j && j.error) || ('HTTP ' + r.status); throw new Error('API Assist: ' + AA.lastError + (j && j.error_code ? ' (' + j.error_code + ')' : '')); }
      if (j && j.success === 1) { AA.used++; return j; }
      last = j; // success = 0 или нераспознанный ответ — повтор через паузу
    } finally { clearTimeout(timer); }
    await sleep(3000);
  }
  AA.errors++; AA.lastError = 'источник не ответил'; throw new Error('API Assist: источник не ответил (success=0)' + (last && last.error ? ': ' + last.error : ''));
}
// JSON API Assist → те же структуры, что даёт разбор страницы (page, flow, card)
function aaToPage(j) {
  const kv = arr => { const o = {}; for (const x of (arr || [])) if (x && x.name) o[String(x.name).toLowerCase()] = String(x.value || '').trim(); return o; };
  const a = kv(j.attributes);
  const page = { hearings: [], acts: [], judge: a['судья'] || '' }, flow = [];
  for (const ev of (j.events || [])) {
    const e = kv(ev); const title = norm(e['наименование события'] || ''), date = (e['дата'] || '').match(RE_DATE); if (!title || !date) continue;
    const time = ((e['время'] || '').match(RE_TIME) || [])[0] || '', room = (e['зал судебного заседания'] || '').replace(/^зал\s*№?\s*/i, '').trim(), result = norm(e['результат события'] || ''), basis = norm(e['основание для выбранного результата события'] || '');
    flow.push({ title, date: date[1], time, result, basis });
    if (RE_HEARING.test(title) && !RE_NOT_HEARING.test(title)) page.hearings.push({ date: date[1], time, room, label: title, result });
  }
  const RE_NO = /(?:[АA]\d{2}|\d{1,2}[а-яёa-z]{0,2})[-–]\d{1,7}\/\d{4}/i;
  const card = { parties: [], uid: a['уникальный идентификатор дела'] || '', judge: a['судья'] || '', court: norm(j.court_title || ''), registered: '', category: a['категория дела'] || '' };
  const no = String(j.case_title || '').match(RE_NO); if (no) card.number = no[0].replace(/–/g, '-');
  const reg = (a['дата поступления'] || '').match(RE_DATE); if (reg) card.registered = isoOf(reg[1]) || '';
  for (const sd of (j.sides || [])) { const p = kv(sd); const name = p['фамилия / наименование'] || ''; if (name) card.parties.push({ role: p['вид лица, участвующего в деле'] || '', name, inn: p['инн'] || '' }); }
  return { page, flow, card };
}
async function collectOne(body) {
  const url = String(body.url || '').trim(), courtNo = String(body.courtNo || '').trim(), number = String(body.number || '').trim(), stage = String(body.stage || 'Первая инстанция');
  // v3.20: УИД дела и все его номера — дело на странице узнаётся по ним, когда номера своей инстанции на странице нет
  const uidIn = String(body.uid || '').trim(), numbers = Array.isArray(body.numbers) ? body.numbers.map(x => String(x || '').trim()).filter(Boolean) : [];
  const kind = hostKind(url);
  if (kind === 'bad') return { ok: false, error: 'некорректная ссылка' };
  // v3.18 (урок 99): о СУДиДЕЛО — только когда ключ задан; без него называется путь, который действительно работает
  if (kind === 'kad') return { ok: false, error: (ENV.SUDODELO_API_KEY ? 'КАД Арбитр: карточка читается через СУДиДЕЛО при плановом сборе' : 'КАД Арбитр не отдаёт карточку дела скриптам — коллектор её не читает; карточку читает приложение для Android (кнопка «Карточка КАД» в деле)') };
  const timeoutMs = Number(ENV.TIMEOUT_MS) || 25000;
  let card, page, flow, via = 'сайт суда', cmp = [], match = null;
  const viaAA = async () => { const j = await aaFetchCase(url, timeoutMs); const m = aaToPage(j); card = m.card; page = m.page; flow = m.flow; via = 'API Assist'; }; // v3.13
  if (kind === 'sudrf' && aaEnabled() && AA.mode === 'primary') { try { await viaAA(); } catch (e) { /* ниже — сайт суда */ } }
  if (!page) {
    let r = null; try { r = await fetchPageRetry(url, timeoutMs, () => {}, 3000); } catch (e) { if (!(kind === 'sudrf' && aaEnabled())) throw e; }
    const bad = !r || r.status >= 400 || BLOCK_RE.test(r.text.slice(0, 6000));
    // v3.17: при расхождении назван номер со страницы; страница без номера дела — «не распознана»
    // v3.20: дело узнаётся по номеру своей инстанции, по УИД и по любому номеру дела из программы
    const pm = bad ? null : pageMatchesCase(r.text, { courtNo }, { uid: uidIn, numbers });
    if (pm && !pm.ok) { const found = pm.found; return found.length ? { ok: false, error: `ссылка ведёт на другое дело: на странице номер ${found.join(', ')}, а в деле ${pm.known.join(', ')}${uidIn ? ' (и УИД дела на странице нет)' : ''}`, mismatch: true, found } : { ok: false, error: `страница не распознана: на ней нет номера дела ${courtNo} — получено ${pageBrief(r)}`, unparsed: true }; }
    if (pm && (pm.byUid || pm.byOther)) match = { byUid: pm.byUid, byOther: pm.byOther, found: pm.found, link: courtNo };
    if (!bad) { card = parseCaseCard(r.text); page = parseCasePage(r.text); flow = parseFlow(r.text); cmp = parseComplaints(r.text); }
    if ((bad || (!page.hearings.length && !page.acts.length && !flow.length)) && kind === 'sudrf' && aaEnabled() && AA.mode !== 'primary') { try { await viaAA(); } catch (e) { if (bad) return { ok: false, error: `сайт суда не отдал страницу (HTTP ${r ? r.status : '—'}); ${errText(e)}` }; } }
    else if (bad) return { ok: false, error: `сайт суда не отдал страницу (HTTP ${r ? r.status : '—'})` };
  }
  const full = body.full !== false; // v3.9: по умолчанию — вся история заседаний
  const ctx = { number, uid: card.uid || '', courtNo: courtNo || card.number || '', stage, url, sinceDays: full ? 36500 : 45, allPast: full, judge: page.judge || card.judge || '', court: card.court || '' };
  // v3.20: события жалоб; match — номер своей инстанции на странице не найден, дело узнано по УИД или другому номеру
  const events = [...buildEvents(page, ctx), ...buildFlowEvents(flow, ctx), ...buildComplaintEvents(cmp, ctx)];
  return Object.assign({ ok: true, card, events, hearings: page.hearings.length, flow: flow.length, complaints: cmp.length, via }, match ? { match } : {});
}
// v3.15: проверка доставки на личный сервер. Возвращает только несекретное: адрес сервера, длину кода, были ли пробелы по краям,
// совпадает ли код с кодом программы (программа присылает SHA-256 своего кода в body.hash), и ответ сервера на ping.
async function bridgeCheck(body) {
  const rawUrl = String(ENV.BRIDGE_URL || ''), rawSecret = String(ENV.BRIDGE_SECRET || ''), cfg = fnCfg();
  const out = { ok: true, collectorVer: COLLECTOR_VER, bridgeUrl: cfg.bridge, urlHadSpaces: rawUrl !== cfg.bridge, secretSet: !!cfg.secret, secretLen: cfg.secret.length, secretHadSpaces: rawSecret !== cfg.secret,
    sameAsProgram: body && body.hash ? crypto.createHash('sha256').update(cfg.secret, 'utf8').digest('hex') === String(body.hash).toLowerCase() : null, ping: null };
  if (!cfg.bridge || !cfg.secret) { out.ping = { ok: false, error: 'не заданы BRIDGE_URL / BRIDGE_SECRET в переменных функции' }; return out; }
  try {
    // v3.19: проверка доставки — с пределом ожидания 20 с
    const r = await fetchT(cfg.bridge, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ secret: cfg.secret, action: 'ping' }) }, 20000);
    const j = jsonOf(r.text);
    out.ping = { http: r.status, ok: !!(j && j.ok), error: j && j.error ? String(j.error) : (j ? '' : 'ответ не JSON'), serverVer: j && j.ver ? j.ver : undefined };
  } catch (e) { out.ping = { ok: false, error: 'нет связи: ' + String((e && e.message) || e) }; }
  return out;
}
// v3.16: состояние сбора словами. ok — все ссылки обработаны и события доставлены; partial — доставлено, но часть ссылок
// не обработана (ошибка, блокировка, страница не распознана, ссылка на другое дело) или сбор остановлен по времени;
// error — события не доставлены на личный сервер.
function collectState(stats, sendErr) {
  const miss = [];
  if (stats.failed) miss.push('ошибок: ' + stats.failed);
  if (stats.blocked) miss.push('сайт суда не пустил: ' + stats.blocked);
  if (stats.unparsed) miss.push('страница не распознана: ' + stats.unparsed);
  if (stats.linkMismatch) miss.push('ссылка на другое дело: ' + stats.linkMismatch);
  if (stats.partial) miss.push('сбор остановлен по времени, остальные ссылки — при следующем запуске');
  if (sendErr) return { state: 'error', stateText: 'события собраны, но не доставлены на личный сервер: ' + sendErr + (miss.length ? '; кроме того, ' + miss.join('; ') : '') };
  if (miss.length) return { state: 'partial', stateText: 'сбор частичный — ' + miss.join('; ') };
  return { state: 'ok', stateText: 'сбор полный: все ссылки обработаны, события доставлены' };
}
export async function handler(event, context) {
  try {
    const d = decodeFnEvent(event);
    if (d.kind === 'http' && d.method === 'OPTIONS') return fnResp(204, {});
    if (d.kind === 'http') {
      if (!secretOk(d.secret)) return fnResp(403, d.secretInUrl ? { ok: false, error: 'forbidden', note: 'код в адресе не принимается (коллектор 3.19): программа передаёт его в теле запроса' } : { ok: false, error: 'forbidden' });
      if (d.action === 'status') {
        const iam = await iamToken(context);
        const raw = await s3get(STATUS_KEY, iam);
        return fnResp(200, raw ? JSON.parse(raw) : { ok: true, empty: true, note: 'сбор ещё не запускался' });
      }
      if (d.action === 'linksput') {
        const clean = sanitizeLinksPack(d.body.links || d.body.pack || d.body);
        // v3.18: пустой список дел — тоже перечень (программа сняла с наблюдения последнее дело); неверный формат — отказ, как прежде
        if (!clean) return fnResp(400, { ok: false, error: 'ожидается выгрузка CRM (format=crm-advokat-links) с делами и ссылками' });
        const iam = await iamToken(context);
        await s3put(LINKS_KEY, JSON.stringify(clean, null, 1), iam);
        return fnResp(200, { ok: true, cases: clean.cases.length, savedAt: new Date().toISOString() });
      }
      if (d.action === 'collect') return fnResp(200, await cloudCollect(context, 'manual'));
      if (d.action === 'collectone') return fnResp(200, await collectOne(d.body)); // v3.7
      if (d.action === 'bridgecheck') return fnResp(200, await bridgeCheck(d.body)); // v3.15
      return fnResp(400, { ok: false, error: 'unknown_action' });
    }
    return fnResp(200, await cloudCollect(context, 'timer'));
  } catch (e) {
    console.log('handler error: ' + ((e && e.stack) || e));
    return fnResp(500, { ok: false, error: String((e && e.message) || e) });
  }
}

// Локальный запуск — только когда файл вызван напрямую (в облаке модуль импортируется мостиком)
const IS_MAIN = (() => { try { return !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]); } catch (e) { return false; } })();
if (TEST) runTests(); else if (IS_MAIN) main();
