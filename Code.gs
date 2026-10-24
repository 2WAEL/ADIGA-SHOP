/**
 * ============================================================
 *  داشبورد الايتمات الموقوفة  —  Code.gs  (كود السيرفر)
 *  يتركب جوه نفس الـ Google Sheet:  Extensions ▸ Apps Script
 *
 *  هيكل الشيت المتوقع:
 *   - شيتات الفروع: DOKKI / ZAMALEK / MERRYLAND / ELSAHEL (بيتكشفوا لوحدهم)
 *     صف 3 = هيدرز، والداتا من صف 4:
 *     A=Date  B=Day  C=Item Name  D=Stop Time  E=Start Time
 *     F=Duration (=MOD(E-D,1))  G=Reason  H=Reason BRANCH
 *   - شيت DATA: عمود A = الأسباب (من A2)، عمود B = الايتمات (من B2)
 *
 *  تحديثات النسخة الحالية:
 *   1) كل الأوقات (السيرفر + الشيتات + السجلات + الحسابات) بصيغة h:mm:ss
 *      والشيتات بتتعرض h:mm:ss AM/PM والمدة [h]:mm:ss.
 *   2) Supabase هو قاعدة البيانات الأساسية للقراءة والكتابة الحية:
 *      - القراءة: كل صفوف item_stops مباشرة عبر REST (من غير قراءة الشيت).
 *      - الكتابة: Supabase أولاً والتأكد من نجاحها، وبعدها الشيت في الخلفية
 *        عبر طابور + trigger كل دقيقة (المستخدم مبيستناش).
 *      - لو Supabase وقع: fallback كامل على الشيت (fail-safe) مع قاطع مؤقت.
 *   3) مزامنة اختيارية مع PostgreSQL عبر Jdbc (احتياطي إضافي).
 *   4) الحفاظ على الجلسات / الأدوار الثلاثة / الكاش / LockService.
 * ============================================================
 */

var CONFIG = {
  TZ: 'Africa/Cairo',          // توقيت "الآن" (الوقف/التشغيل الجديد)
  DATA_SHEET: 'DATA',
  HEADER_ROW: 3,
  FIRST_ROW: 4,
  COLS: 8,                     // A:H
  REASON_COL: 1,               // DATA!A
  ITEM_COL: 2,                 // DATA!B
  DV_ITEM_ROWS: 600,           // عدد خلايا قايمة الايتمات في الـ dropdown
  DV_REASON_ROWS: 100,         // عدد خلايا قايمة الأسباب في الـ dropdown
  CACHE_TTL: 300,              // ثواني
  CACHE_CHUNK: 30000,          // حجم القطعة في الكاش (حروف)
  DEFAULT_CLOSE: '03:00:00',   // وقت القفل لو مقدرناش نقراه من عنوان الشيت
  // لو وقت القفل اتقرأ غلط من عنوان الشيت، اكتبه هنا يدوي: { DOKKI: '04:30:00' }
  CLOSE_OVERRIDE: {},
  CLOSE_FALLBACK: { DOKKI: '04:30:00', ZAMALEK: '03:30:00', MERRYLAND: '03:30:00', ELSAHEL: '02:00:00' },
  USERS_SHEET: 'USERS',        // شيت اليوزرات (بيتعمل لوحده ومخفي)
  SESSION_TTL: 21600,          // مدة الجلسة بالثواني (6 ساعات — أقصى حد في الكاش)
  MAX_FAILS: 5,                // محاولات دخول غلط قبل القفل المؤقت
  FAIL_LOCK: 600,              // مدة القفل المؤقت بالثواني
  RECENT_DAYS: 1,              // الدسباتشر والايجينت بيشوفوا النهارده + كام يوم قبله
  PG_TABLE: 'item_stops',      // اسم جدول PostgreSQL (اختياري)
  PG_STATUS_TTL: 30,           // كاش حالة قاعدة البيانات بالثواني
  SB_PRIMARY: true,            // Supabase قاعدة أساسية للقراءة/الكتابة (الشيت احتياطي)
  SB_DASH_TTL: 12,             // كاش داشبورد Supabase بالثواني (صغير عشان التحديث يبان فوراً)
  SB_MAX_ROWS: 5000,           // أقصى عدد صفوف تتقرأ من Supabase في المرة
  SB_PAGE: 1000,               // حجم الصفحة في قراءة Supabase
  SB_BREAKER_SEC: 120,         // مدة تعطيل Supabase بعد فشل قبل المحاولة تاني
  SB_QUEUE_MAX: 15,            // أقصى وظائف شيت تتنفذ في دورة المزامنة (حد أمان لوقت التنفيذ)
  SB_LISTS_TTL: 300            // كاش قوايم الايتمات/الأسباب بالثواني
};
var UNSPEC = 'غير محدد';
var ROLE_MGMT = 'management', ROLE_BRANCH = 'branch', ROLE_AGENT = 'agent';

/**
 * ⚠ مرة واحدة بس: اكتب باسورد (6 حروف/أرقام على الأقل) هنا، وشغّل الدالة setupUsers من المحرر،
 * وبعدها امسح الباسورد من هنا. بعد كده كل اليوزرات بتتدار من الداشبورد (⚙ ▸ إدارة المستخدمين).
 */
var SEED_USERS = [
  { username: 'admin',     role: 'management', branch: '',          password: 'erVeFHmyd' },
  { username: 'dokki',     role: 'branch',     branch: 'DOKKI',     password: 'WcgvWe3Wn' },
  { username: 'zamalek',   role: 'branch',     branch: 'ZAMALEK',   password: 'fqAJJhtPY' },
  { username: 'merryland', role: 'branch',     branch: 'MERRYLAND', password: 'hCTcuKMPb' },
  { username: 'elsahel',   role: 'branch',     branch: 'ELSAHEL',   password: 'bMQwcpHY4' },
  { username: 'agent',     role: 'agent',      branch: '',          password: 'v9V63GYfq' }
];

/** فتح الصفحة */
function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('داشبورد الايتمات الموقوفة')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/* ============================================================
 *  أدوات مساعدة
 * ============================================================ */

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

/** تنظيف الاسم: مسافات زيادة / رموز مخفية */
function normName_(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[\u200B-\u200F\u202A-\u202E\u00A0]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** مفتاح مقارنة (بدون فروق مسافات/حروف كبيرة) */
function keyOf_(s) { return normName_(s).toLowerCase(); }

/** تحويل الأرقام العربية-الهندية لأرقام عادية */
function arDigits_(s) {
  return String(s).replace(/[\u0660-\u0669]/g, function (d) { return String(d.charCodeAt(0) - 0x0660); });
}

/** ثواني منذ بداية اليوم → h:mm:ss  (مثال: 4:07:09) */
function fmtHMS_(totalSeconds) {
  var t = Math.round(Number(totalSeconds) || 0);
  if (!isFinite(t) || t < 0) t = 0;
  var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h + ':' + pad2_(m) + ':' + pad2_(s);
}

/** 12 ساعة مع AM/PM لو احتجناها (h:mm:ss A/P) */
function fmtHMS12_(totalSeconds) {
  var t = Math.round(Number(totalSeconds) || 0);
  if (!isFinite(t) || t < 0) t = 0;
  var h24 = Math.floor(t / 3600) % 24, m = Math.floor((t % 3600) / 60), s = t % 60;
  var ap = h24 >= 12 ? 'PM' : 'AM';
  var h = h24 % 12; if (h === 0) h = 12;
  return h + ':' + pad2_(m) + ':' + pad2_(s) + ' ' + ap;
}

/** استخراج الوقت من نص الخلية → ثواني من بداية اليوم (أو null) */
function parseSeconds_(s) {
  if (s === null || s === undefined) return null;
  s = arDigits_(normName_(s));
  if (!s) return null;
  var m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm]|[صم])?/);
  if (!m) return null;
  var h = parseInt(m[1], 10), mi = parseInt(m[2], 10), se = parseInt(m[3] || '0', 10), ap = m[4];
  if (mi > 59 || se > 59 || h > 47) return null;
  if (ap) {
    var a = ap.toLowerCase();
    if ((a === 'pm' || a === 'م') && h < 12) h += 12;
    if ((a === 'am' || a === 'ص') && h === 12) h = 0;
  }
  return (h % 24) * 3600 + mi * 60 + se;
}

/** توافق خلفي: دقايق من بداية اليوم */
function parseMinutes_(s) {
  var v = parseSeconds_(s);
  return v === null ? null : Math.floor(v / 60);
}

/** مفتاح التاريخ yyyy-MM-dd من قيمة الخلية */
function dateKey_(v, disp, tz) {
  if (Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  }
  var s = normName_(arDigits_((disp === undefined || disp === '') ? v : disp));
  var m = s.match(/(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})/);
  if (m) return m[1] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[3]);
  m = s.match(/(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})/);        // يوم/شهر/سنة
  if (m) return m[3] + '-' + pad2_(+m[2]) + '-' + pad2_(+m[1]);
  return '';
}

/** رقم اليوم (عدد الأيام من 1970) لحساب الفرق بين تاريخين */
function dayNum_(key) {
  var p = key.split('-');
  return Math.round(Date.UTC(+p[0], +p[1] - 1, +p[2]) / 86400000);
}

/** "الآن" بتوقيت القاهرة — بالثواني */
function nowParts_() {
  var now = new Date();
  var key = Utilities.formatDate(now, CONFIG.TZ, 'yyyy-MM-dd');
  var hms = Utilities.formatDate(now, CONFIG.TZ, 'H:mm:ss');
  var sec = parseSeconds_(hms);
  if (sec === null) sec = 0;
  var p = key.split('-');
  var serial = Math.round((Date.UTC(+p[0], +p[1] - 1, +p[2]) - Date.UTC(1899, 11, 30)) / 86400000);
  return {
    key: key,
    hms: fmtHMS_(sec),
    hm: fmtHMS_(sec),
    min: Math.floor(sec / 60),
    sec: sec,
    serial: serial,
    fraction: sec / 86400
  };
}

/** تنفيذ كود جوه Lock عشان مفيش تعارض بين أكتر من مستخدم */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw bizErr_('السيستم مشغول دلوقتي، جرّب تاني بعد لحظات.');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------------- الكاش (مقسّم لقطع لأن الحد 100KB للقيمة) ---------------- */

function cachePut_(key, obj, ttl) {
  try {
    var s = JSON.stringify(obj), size = CONFIG.CACHE_CHUNK;
    var parts = Math.ceil(s.length / size), map = {};
    for (var i = 0; i < parts; i++) map[key + '_' + i] = s.substr(i * size, size);
    map[key + '_n'] = String(parts);
    CacheService.getScriptCache().putAll(map, ttl || CONFIG.CACHE_TTL);
  } catch (e) { /* الكاش اختياري */ }
}

function cacheGet_(key) {
  try {
    var cache = CacheService.getScriptCache();
    var n = parseInt(cache.get(key + '_n') || '0', 10);
    if (!n) return null;
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(key + '_' + i);
    var got = cache.getAll(keys), s = '';
    for (var j = 0; j < n; j++) {
      if (got[keys[j]] === undefined) return null;
      s += got[keys[j]];
    }
    return JSON.parse(s);
  } catch (e) { return null; }
}

function cacheClear_() {
  cacheDrop_('dash');
  cacheDrop_('lists');
}

/** حذف مفتاح مقسّم من الكاش */
function cacheDrop_(key) {
  try {
    var cache = CacheService.getScriptCache();
    var n = parseInt(cache.get(key + '_n') || '0', 10), keys = [key + '_n'];
    for (var i = 0; i < n; i++) keys.push(key + '_' + i);
    cache.removeAll(keys);
  } catch (e) {}
}

/* ============================================================
 *  الشيتات
 * ============================================================ */

function getDataSheet_() {
  var sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONFIG.DATA_SHEET);
  if (!sh) throw new Error('شيت "' + CONFIG.DATA_SHEET + '" مش موجود.');
  return sh;
}

/** كشف شيتات الفروع تلقائي: صف الهيدرز فيه Date / Item / Stop  (فرع جديد يدخل لوحده) */
function getBranchSheets_() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheets().filter(function (sh) {
    if (sh.getName() === CONFIG.DATA_SHEET || sh.getName() === CONFIG.USERS_SHEET) return false;
    if (sh.isSheetHidden()) return false;
    if (sh.getLastRow() < CONFIG.HEADER_ROW) return false;
    var h = sh.getRange(CONFIG.HEADER_ROW, 1, 1, 7).getDisplayValues()[0]
      .map(function (x) { return String(x).toLowerCase(); });
    return /date/.test(h[0]) && /item/.test(h[2]) && /stop/.test(h[3]);
  });
}

function getBranchSheetByName_(name) {
  var list = getBranchSheets_();
  for (var i = 0; i < list.length; i++) if (list[i].getName() === name) return list[i];
  throw new Error('الفرع "' + name + '" غير موجود.');
}

/** قراءة قايمة (ايتمات/أسباب) من DATA مع تنظيف ومنع التكرار */
function readList_(sh, col) {
  var n = sh.getLastRow() - 1;
  if (n < 1) return [];
  var vals = sh.getRange(2, col, n, 1).getValues(), seen = {}, out = [];
  vals.forEach(function (r) {
    var v = normName_(r[0]);
    if (!v) return;
    var k = keyOf_(v);
    if (seen[k]) return;
    seen[k] = 1;
    out.push(v);
  });
  return out;
}

/** وقت قفل الفرع: بيتقرأ من آخر وقت مكتوب في عنوان الشيت (A1) — بالثواني */
function closeInfo_(sh) {
  var name = sh.getName(), sec = null;
  if (CONFIG.CLOSE_OVERRIDE[name]) {
    sec = parseSeconds_(CONFIG.CLOSE_OVERRIDE[name]);
  } else {
    var txt = '';
    try { txt = arDigits_(sh.getRange('A1').getDisplayValue()); } catch (e) {}
    var m, last = null, re = /(\d{1,2})\s*:\s*(\d{2})(?::(\d{2}))?/g;
    while ((m = re.exec(txt)) !== null) last = m;
    sec = last ? parseSeconds_(last[1] + ':' + last[2] + ':' + (last[3] || '0')) : null;
  }
  if (sec === null) sec = parseSeconds_(CONFIG.CLOSE_FALLBACK[name] || CONFIG.DEFAULT_CLOSE);
  if (sec === null) sec = 0;
  return { text: fmtHMS_(sec), sec: sec, min: Math.floor(sec / 60) };
}

/* ============================================================
 *  قراءة الداتا للداشبورد
 * ============================================================ */

/** قراءة شيت فرع واحد (Batch: getValues مرة واحدة) */
function readBranch_(sh, tz, now, itemMap, reasonMap) {
  try { ensureTimeFormats_(sh); } catch (e) {}   // توحيد h:mm:ss لكل الصفوف القديمة (مرة كل 6 ساعات)
  var close = closeInfo_(sh);
  var n = sh.getLastRow() - CONFIG.FIRST_ROW + 1;
  var rows = [], skipped = 0;
  if (n >= 1) {
    var rng = sh.getRange(CONFIG.FIRST_ROW, 1, n, CONFIG.COLS);
    var vals = rng.getValues(), disp = rng.getDisplayValues();
    for (var i = 0; i < n; i++) {
      var v = vals[i], d = disp[i];
      var item = normName_(v[2]);
      if (!item) continue;                                  // صف فاضي
      var dk = dateKey_(v[0], d[0], tz);
      var stop = parseSeconds_(d[3]);
      if (!dk || stop === null) { skipped++; continue; }    // صف ناقص (بدون تاريخ أو وقت إيقاف)
      var start = parseSeconds_(d[4]);
      var isOpen = (start === null), durSec = 0, rev = 0, atClose = 0;
      if (isOpen) {
        // لسه موقوف: المدة لحد "دلوقتي" — بالثواني
        durSec = Math.max(0, (dayNum_(now.key) * 86400 + now.sec) - (dayNum_(dk) * 86400 + stop));
      } else {
        // المدة بتعدّي نص الليل: (Start - Stop) mod 24h
        durSec = (start - stop + 86400) % 86400;
        if (durSec === 0) rev = 1;                          // نفس الوقتين → للمراجعة
        if (start === close.sec) atClose = 1;               // رجوع = وقت القفل (بيتحسب عادي)
      }
      var hours = durSec / 3600;
      var reason = normName_(v[6]);
      reason = reason ? (reasonMap[keyOf_(reason)] || reason) : UNSPEC;
      var note = normName_(v[7]);
      // "أسباب أخرى" + وصف الدسباتشر → بيتجمعوا في بند واحد في كل جداول الداشبورد
      var dispReason = (reason && isOtherReason_(reason) && note) ? (reason + ' - ' + note) : reason;
      item = itemMap[keyOf_(item)] || item;
      rows.push({
        d: dk, it: item,
        st: fmtHMS_(stop),                                  // h:mm:ss
        en: isOpen ? '' : fmtHMS_(start),                   // h:mm:ss
        stv: stop,                                          // ثواني (للترتيب)
        env: isOpen ? null : start,
        h: Math.round(hours * 100) / 100,
        du: fmtHMS_(durSec),                                // المدة h:mm:ss
        dsec: durSec,
        r: dispReason, n: note,
        o: isOpen ? 1 : 0, c: atClose, v: rev, x: CONFIG.FIRST_ROW + i
      });
    }
  }
  return { name: sh.getName(), close: close.text, rows: rows, skipped: skipped };
}

function buildData_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone();
  var now = nowParts_();
  var dataSh = ss.getSheetByName(CONFIG.DATA_SHEET);
  var items = dataSh ? readList_(dataSh, CONFIG.ITEM_COL) : [];
  // "غير محدد" عمره ما يظهر كاختيار: السبب لازم يتختار من الأسباب الحقيقية بس
  var reasons = (dataSh ? readList_(dataSh, CONFIG.REASON_COL) : []).filter(function (x) { return keyOf_(x) !== keyOf_(UNSPEC); });
  var itemMap = {}, reasonMap = {};
  items.forEach(function (x) { itemMap[keyOf_(x)] = x; });
  reasons.forEach(function (x) { reasonMap[keyOf_(x)] = x; });

  var branches = [], skipped = 0;
  getBranchSheets_().forEach(function (sh) {
    var b = readBranch_(sh, tz, now, itemMap, reasonMap);
    skipped += b.skipped;
    branches.push(b);
  });
  return {
    generatedAt: now.key + ' ' + now.hms,                  // h:mm:ss
    now: now.key,
    branches: branches,
    items: items,
    reasons: reasons,
    skipped: skipped,
    src: 'sheet'
  };
}

/** بيبني الداتا من الشيتات ويخزنها في الكاش */
function freshPayload_() {
  var data = buildData_();
  cachePut_('dash', data);
  return data;
}

/** الداتا الكاملة: Supabase أولاً، ولو وقع → الشيتات (fail-safe) */
function fullData_(force) {
  if (!force) {
    var cached = cacheGet_('dash');
    // كاش الشيتات ميتستخدمش طالما Supabase رجع شغال — عشان الاستشفاء يبان فوراً
    if (cached && !(cached.src === 'sheet' && sbReady_())) return cached;
  }
  if (sbReady_()) {
    try {
      var p = sbDashboardPayload_();
      cachePut_('dash', p, CONFIG.SB_DASH_TTL);
      sbMarkOnline_();
      return p;
    } catch (e) {
      sbMarkOffline_();
      Logger.log('SB dashboard fallback: ' + sbErr_(e));
    }
  }
  return freshPayload_();   // الشيتات كخطة بديلة
}

/** الدالة اللي بيناديها الداشبورد. force=true → تجاهل الكاش (للمانجمنت بس) */
function getDashboardData(token, force) {
  var user = auth_(token);
  return scopePayload_(fullData_(!!force && user.role === ROLE_MGMT), user);
}

/* ============================================================
 *  Data Validation + تنسيق الوقت في الشيتات
 * ============================================================ */

/** تنسيق الوقت الموحد في شيت فرع — بيتطبق مرة كل 6 ساعات */
function ensureTimeFormats_(sh) {
  var cache = CacheService.getScriptCache();
  var key = 'tf_' + sh.getName();
  if (cache.get(key) === '1') return;
  var rows = Math.max(sh.getMaxRows() - CONFIG.FIRST_ROW + 1, 1);
  sh.getRange(CONFIG.FIRST_ROW, 4, rows, 1).setNumberFormat('h:mm:ss AM/PM');
  sh.getRange(CONFIG.FIRST_ROW, 5, rows, 1).setNumberFormat('h:mm:ss AM/PM');
  sh.getRange(CONFIG.FIRST_ROW, 6, rows, 1).setNumberFormat('[h]:mm:ss');
  try { cache.put(key, '1', 21600); } catch (e) {}
}

/** بيربط عمود الايتم (C) وعمود السبب (G) في كل الفروع بقوايم DATA + يوحّد تنسيق الوقت h:mm:ss */
function applyValidations_() {  var data = getDataSheet_();
  var need = Math.max(CONFIG.DV_ITEM_ROWS, CONFIG.DV_REASON_ROWS) + 1;
  if (data.getMaxRows() < need) data.insertRowsAfter(data.getMaxRows(), need - data.getMaxRows());

  var itemRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(data.getRange(2, CONFIG.ITEM_COL, CONFIG.DV_ITEM_ROWS, 1), true)
    .setAllowInvalid(true).build();
  var reasonRule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(data.getRange(2, CONFIG.REASON_COL, CONFIG.DV_REASON_ROWS, 1), true)
    .setAllowInvalid(true).build();

  getBranchSheets_().forEach(function (sh) {
    var rows = Math.max(sh.getMaxRows() - CONFIG.FIRST_ROW + 1, 1);
    sh.getRange(CONFIG.FIRST_ROW, 3, rows, 1).setDataValidation(itemRule);
    sh.getRange(CONFIG.FIRST_ROW, 7, rows, 1).setDataValidation(reasonRule);
    // تنسيق الوقت الموحد في كل صفوف الشيت
    sh.getRange(CONFIG.FIRST_ROW, 4, rows, 1).setNumberFormat('h:mm:ss AM/PM');
    sh.getRange(CONFIG.FIRST_ROW, 5, rows, 1).setNumberFormat('h:mm:ss AM/PM');
    sh.getRange(CONFIG.FIRST_ROW, 6, rows, 1).setNumberFormat('[h]:mm:ss');
  });
}

/** زرار "تحديث قوائم الاختيار في الشيتات" (مانجمنت بس) */
function refreshLists(token) {
  auth_(token, [ROLE_MGMT]);
  return withLock_(function () {
    applyValidations_();
    cacheClear_();
    return { ok: true };
  });
}

/* ============================================================
 *  إضافة ايتم / ريزون
 * ============================================================ */

function addToDataList_(col, rawName, label, user) {
  var name = normName_(rawName).replace(/^[=+\-@]+/, '').trim();   // منع الفورميولا
  if (!name) throw new Error('اكتب اسم ال' + label + ' الأول.');
  if (name.length > 80) throw new Error('الاسم طويل جدا (الحد 80 حرف).');
  if (col === CONFIG.REASON_COL && keyOf_(name) === keyOf_(UNSPEC)) throw new Error('"' + UNSPEC + '" مينفعش يتضاف كسبب.');
  return withLock_(function () {
    var sh = getDataSheet_();
    var key = keyOf_(name);
    var exists = readList_(sh, col).some(function (x) { return keyOf_(x) === key; });
    if (exists) throw new Error('"' + name + '" موجود بالفعل في قايمة ال' + label + '.');

    // أول خلية فاضية بعد آخر قيمة في العمود
    var colVals = sh.getRange(1, col, sh.getMaxRows(), 1).getValues();
    var row = colVals.length;
    while (row > 1 && String(colVals[row - 1][0]).trim() === '') row--;
    row++;
    if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 20);
    sh.getRange(row, col).setValue(name);          // متعملش copyTo هنا — بيتصادم مع "Typed columns"

    applyValidations_();     // القوايم في كل الفروع بتشوف الجديد
    return { ok: true, name: name, data: scopePayload_(freshPayload_(), user) };
  });
}

/** إضافة ايتم جديد → DATA!B → يظهر في كل الفروع والداشبورد (مانجمنت بس) */
function addItem(token, name) {
  var user = auth_(token, [ROLE_MGMT]);
  return addToDataList_(CONFIG.ITEM_COL, name, 'ايتم', user);
}

/** إضافة ريزون جديد → DATA!A → يظهر في كل الفروع وجدول السبب × الفرع (مانجمنت بس) */
function addReason(token, name) {
  var user = auth_(token, [ROLE_MGMT]);
  return addToDataList_(CONFIG.REASON_COL, name, 'سبب', user);
}

/** بيقول هل السبب ده "أسباب أخرى" (محتاج وصف من الدسباتشر) */
function isOtherReason_(name) { return keyOf_(name).indexOf('اخرى') !== -1 || keyOf_(name).indexOf('أخرى') !== -1; }

/** حذف اسم من قايمة (ايتم/سبب) في DATA */
function deleteFromDataList_(col, rawName, label, user) {
  var name = normName_(rawName);
  if (!name) throw new Error('اختار ال' + label + ' اللي عايز تحذفه.');
  return withLock_(function () {
    var sh = getDataSheet_();
    var key = keyOf_(name);
    var n = sh.getLastRow();
    var vals = sh.getRange(1, col, n, 1).getValues();
    var row = -1;
    for (var i = 1; i < n; i++) { if (keyOf_(vals[i][0]) === key) { row = i + 1; break; } }
    if (row === -1) throw new Error('"' + name + '" مش موجود في قايمة ال' + label + '.');
    sh.getRange(row, col).clearContent();

    applyValidations_();
    return { ok: true, name: name, data: scopePayload_(freshPayload_(), user) };
  });
}

/** حذف ايتم من DATA!B (مانجمنت بس) */
function deleteItem(token, name) {
  var user = auth_(token, [ROLE_MGMT]);
  return deleteFromDataList_(CONFIG.ITEM_COL, name, 'ايتم', user);
}

/** حذف سبب من DATA!A (مانجمنت بس) */
function deleteReason(token, name) {
  var user = auth_(token, [ROLE_MGMT]);
  return deleteFromDataList_(CONFIG.REASON_COL, name, 'سبب', user);
}

/* ============================================================
 *  تسجيل إيقاف / تشغيل
 * ============================================================ */

/** تسجيل إيقاف (مانجمنت: أي فرع — دسباتشر: فرعه بس) */
function logStop(token, branch, item, reason, note) {
  var user = auth_(token, [ROLE_MGMT, ROLE_BRANCH]);
  if (user.role === ROLE_BRANCH) branch = user.branch;     // الدسباتشر مقدرش يختار فرع تاني
  return logStop_(user, branch, item, reason, note);
}

/** تحقق مشترك من بيانات الإيقاف (قبل أي كتابة) */
function validateStop_(branch, item, reason, note) {
  if (!branch) throw new Error('اختار الفرع.');
  if (!item) throw new Error('اختار الايتم.');
  if (!reason) throw new Error('لازم تختار سبب الإيقاف من القايمة.');
  if (keyOf_(reason) === keyOf_(UNSPEC)) throw new Error('مينفعش "' + UNSPEC + '" — اختار سبب حقيقي من القايمة.');
  if (isOtherReason_(reason) && !note) throw new Error('اكتب وصف السبب (أسباب أخرى) الأول.');
  if (note.length > 300) throw new Error('الوصف طويل جدا (الحد 300 حرف).');
  // القوايم من الشيت بس بتتكاش — لو الشيت مش متاح منمنعش العملية
  var lists = dashLists_();
  if (lists.items.length && !lists.items.some(function (x) { return keyOf_(x) === keyOf_(item); })) {
    throw new Error('الايتم "' + item + '" مش في القايمة. ضيفه الأول من ⚙ إضافة ايتم.');
  }
  if (lists.reasons.length && !lists.reasons.some(function (x) { return keyOf_(x) === keyOf_(reason); })) {
    throw new Error('السبب "' + reason + '" مش في القايمة. ضيفه الأول من ⚙ إضافة ريزون.');
  }
}

/** خطأ منطقي (مش مشكلة اتصال) — مينفعش نعمل fallback بسببه */
function bizErr_(msg) { var e = new Error(msg); e.biz = true; return e; }

/**
 * تسجيل إيقاف: Supabase أولاً (القاعدة الأساسية) وبعدين طابور مزامنة الشيت في الخلفية.
 * لو Supabase وقع → fallback كامل على الشيت (fail-safe).
 */
function logStop_(user, branch, item, reason, note) {
  item = normName_(item); reason = normName_(reason); note = normName_(note);
  validateStop_(branch, item, reason, note);

  if (sbReady_()) {
    var saved = null;
    try {
      saved = withLock_(function () {
        if (sbOpenExists_(branch, item)) {
          throw bizErr_('"' + item + '" موجود كموقوف حاليا في ' + branch + '. سجّل له تشغيل الأول.');
        }
        return sbInsertStop_(branch, item, reason, note);
      });
    } catch (e) {
      if (e && e.biz) throw e;
      sbMarkOffline_();
      Logger.log('SB stop fallback: ' + sbErr_(e));
      saved = null;
    }
    if (saved && saved.id) {
      // الشيت في الخلفية — المستخدم مبيستناش
      enqueueSheetJob_({
        t: 'stop', id: saved.id, b: branch, it: item,
        d: String(saved.stop_date).slice(0, 10), st: pgTimeText_(saved.stop_time),
        r: reason, n: note, x: saved.sheet_row || 0
      });
      var data = null;
      try { data = scopePayload_(fullData_(true), user); } catch (e2) { Logger.log('SB payload after stop: ' + sbErr_(e2)); }
      return { ok: true, id: saved.id, row: saved.sheet_row || 0, time: pgTimeText_(saved.stop_time), data: data };
    }
  }

  return logStopSheet_(user, branch, item, reason, note);
}

/** تسجيل إيقاف مباشر في الشيت (خطة بديلة لو Supabase وقع) */
function logStopSheet_(user, branch, item, reason, note) {
  item = normName_(item);
  reason = normName_(reason);
  note = normName_(note);
  if (!branch) throw new Error('اختار الفرع.');
  if (!item) throw new Error('اختار الايتم.');
  if (!reason) throw new Error('لازم تختار سبب الإيقاف من القايمة.');
  if (keyOf_(reason) === keyOf_(UNSPEC)) throw new Error('مينفعش "' + UNSPEC + '" — اختار سبب حقيقي من القايمة.');
  if (isOtherReason_(reason) && !note) throw new Error('اكتب وصف السبب (أسباب أخرى) الأول.');
  if (note.length > 300) throw new Error('الوصف طويل جدا (الحد 300 حرف).');

  return withLock_(function () {
    var sh = getBranchSheetByName_(branch);
    var data = getDataSheet_();
    var itemsOk = readList_(data, CONFIG.ITEM_COL).some(function (x) { return keyOf_(x) === keyOf_(item); });
    var reasonsOk = readList_(data, CONFIG.REASON_COL).some(function (x) { return keyOf_(x) === keyOf_(reason); });
    if (!itemsOk) throw new Error('الايتم "' + item + '" مش في القايمة. ضيفه الأول من ⚙ إضافة ايتم.');
    if (!reasonsOk) throw new Error('السبب "' + reason + '" مش في القايمة. ضيفه الأول من ⚙ إضافة ريزون.');

    // آخر صف فيه ايتم + هل الايتم ده موقوف بالفعل؟
    var n = sh.getLastRow() - CONFIG.FIRST_ROW + 1;
    var lastData = CONFIG.FIRST_ROW - 1;
    if (n >= 1) {
      var cde = sh.getRange(CONFIG.FIRST_ROW, 3, n, 3).getDisplayValues();
      for (var i = 0; i < n; i++) {
        var nm = normName_(cde[i][0]);
        if (!nm) continue;
        lastData = CONFIG.FIRST_ROW + i;
        if (keyOf_(nm) === keyOf_(item) && parseSeconds_(cde[i][2]) === null && parseSeconds_(cde[i][1]) !== null) {
          throw new Error('"' + item + '" موجود كموقوف حاليا في ' + branch + ' (صف ' + (CONFIG.FIRST_ROW + i) + '). سجّل له تشغيل الأول.');
        }
      }
    }

    var row = lastData + 1;
    if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
    var now = nowParts_();

    // تثبيت الفورمات مباشرة — كل الأوقات h:mm:ss AM/PM والمدة [h]:mm:ss
    sh.getRange(row, 1).setNumberFormat('dd/mm/yyyy');
    sh.getRange(row, 2).setNumberFormat('dddd');
    sh.getRange(row, 4).setNumberFormat('h:mm:ss AM/PM');
    sh.getRange(row, 5).setNumberFormat('h:mm:ss AM/PM');
    sh.getRange(row, 6).setNumberFormat('[h]:mm:ss');
    sh.getRange(row, 1).setValue(now.serial);                       // A: تاريخ اليوم
    sh.getRange(row, 2).setFormula('=A' + row);                     // B: اليوم
    sh.getRange(row, 3).setValue(item);                             // C: الايتم
    sh.getRange(row, 4).setValue(now.fraction);                     // D: وقت الإيقاف = الآن (بالثواني)
    sh.getRange(row, 5).clearContent();                             // E: فاضي = لسه موقوف
    sh.getRange(row, 6).setFormula('=IF(E' + row + '="","",MOD(E' + row + '-D' + row + ',1))');
    sh.getRange(row, 7).setValue(reason);                           // G: السبب
    if (note) sh.getRange(row, 8).setValue(note);                   // H: وصف الدسباتشر
    SpreadsheetApp.flush();

    // fallback: مزامنة PostgreSQL فقط (Supabase واقع أصلاً)
    pgUpsertSafe_({
      sheet_row: row, branch: branch, item: item,
      stop_date: now.key, stop_time: now.hms, end_time: '',
      duration_seconds: 0, reason: reason, note: note,
      is_open: true, at_close: false, needs_review: false
    });

    return { ok: true, row: row, time: now.hms, data: scopePayload_(freshPayload_(), user) };
  });
}

/** تسجيل تشغيل (مانجمنت: أي فرع — دسباتشر: فرعه بس) */
function resumeStop(token, branch, row, item, id) {
  var user = auth_(token, [ROLE_MGMT, ROLE_BRANCH]);
  if (user.role === ROLE_BRANCH) branch = user.branch;
  return resumeStop_(user, branch, row, item, id);
}

/**
 * تسجيل تشغيل: Supabase أولاً، والشيت في الخلفية.
 * id = معرّف صف Supabase (الأساسي) — row = رقم صف الشيت (للتوافق/الخطة البديلة).
 */
function resumeStop_(user, branch, row, item, id) {
  item = normName_(item);
  if (sbReady_()) {
    var saved = null;
    try {
      saved = withLock_(function () { return sbResumeStop_(branch, id, row, item); });
    } catch (e) {
      if (e && e.biz) throw e;
      sbMarkOffline_();
      Logger.log('SB resume fallback: ' + sbErr_(e));
      saved = null;
    }
    if (saved && saved.id) {
      enqueueSheetJob_({
        t: 'resume', id: saved.id, b: branch, it: normName_(saved.item),
        d: String(saved.stop_date).slice(0, 10), st: pgTimeText_(saved.stop_time),
        en: pgTimeText_(saved.end_time), x: saved.sheet_row || 0
      });
      var data = null;
      try { data = scopePayload_(fullData_(true), user); } catch (e2) { Logger.log('SB payload after resume: ' + sbErr_(e2)); }
      return { ok: true, id: saved.id, time: pgTimeText_(saved.end_time), data: data };
    }
  }
  return resumeStopSheet_(user, branch, row, item);
}

/** تسجيل تشغيل مباشر في الشيت (خطة بديلة) */
function resumeStopSheet_(user, branch, row, item) {
  return withLock_(function () {
    var sh = getBranchSheetByName_(branch);
    row = parseInt(row, 10);
    if (!(row >= CONFIG.FIRST_ROW && row <= sh.getLastRow())) throw new Error('رقم الصف غير صحيح، حدّث الداتا وجرّب تاني.');
    var disp = sh.getRange(row, 1, 1, CONFIG.COLS).getDisplayValues()[0];
    if (keyOf_(disp[2]) !== keyOf_(item)) throw new Error('الصف اتغيّر من ساعة ما فتحت الصفحة، حدّث الداتا وجرّب تاني.');
    if (parseSeconds_(disp[4]) !== null) throw new Error('الايتم ده اتسجل له تشغيل بالفعل.');

    var now = nowParts_();
    sh.getRange(row, 5).setNumberFormat('h:mm:ss AM/PM');
    sh.getRange(row, 5).setValue(now.fraction);
    sh.getRange(row, 6).setNumberFormat('[h]:mm:ss');
    sh.getRange(row, 6).setFormula('=IF(E' + row + '="","",MOD(E' + row + '-D' + row + ',1))');
    SpreadsheetApp.flush();

    // fallback: مزامنة PostgreSQL فقط
    var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
    var stopSec = parseSeconds_(disp[3]);
    var durSec = stopSec === null ? 0 : (now.sec - stopSec + 86400) % 86400;
    var close = closeInfo_(sh);
    pgUpsertSafe_({
      sheet_row: row, branch: branch, item: normName_(disp[2]),
      stop_date: dateKey_(null, disp[0], tz), stop_time: stopSec === null ? '0:00:00' : fmtHMS_(stopSec),
      end_time: now.hms, duration_seconds: durSec,
      reason: normName_(disp[6]), note: normName_(disp[7]),
      is_open: false, at_close: stopSec !== null && now.sec === close.sec, needs_review: durSec === 0
    });

    return { ok: true, time: now.hms, data: scopePayload_(freshPayload_(), user) };
  });
}

/* ============================================================
 *  PostgreSQL — طبقة مزامنة اختيارية (حفظ + استرجاع)
 *
 *  الإعداد من: Project Settings ▸ Script Properties
 *    PG_URL      = jdbc:postgresql://HOST:5432/DBNAME?sslmode=require
 *    PG_USER     = username
 *    PG_PASSWORD = password
 *    PG_TABLE    = item_stops        (اختياري)
 *    PG_ENABLED  = false             (اختياري لإيقاف المزامنة مؤقتاً)
 *
 *  أو سطر واحد: PG_URL = postgres://user:pass@host:5432/db
 *  ملاحظة: Jdbc في Apps Script بيحتاج مشروع GCP قياسي (Standard) مربوط بالسكريبت.
 * ============================================================ */

function pgCfg_() {
  var props = PropertiesService.getScriptProperties();
  var raw = String(props.getProperty('PG_URL') || '').trim();
  var user = String(props.getProperty('PG_USER') || '').trim();
  var pass = props.getProperty('PG_PASSWORD') || '';
  var table = String(props.getProperty('PG_TABLE') || CONFIG.PG_TABLE).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) table = CONFIG.PG_TABLE;
  var disabled = String(props.getProperty('PG_ENABLED') || '').toLowerCase() === 'false';

  // دعم connection string بصيغة postgres://user:pass@host:port/db
  var m = raw.match(/^postgres(?:ql)?:\/\/([^:\/@]+):([^@]*)@([^\/]+)\/([^?]+)(?:\?.*)?$/i);
  if (m) {
    if (!user) user = decodeURIComponent(m[1]);
    if (!pass) pass = decodeURIComponent(m[2]);
    raw = 'jdbc:postgresql://' + m[3] + '/' + m[4];
  }
  return { enabled: !!raw && !disabled, url: raw, user: user, pass: pass, table: table };
}

function pgErr_(e) {
  var s = String((e && e.message) || e || '');
  return s.replace(/password\s*=\s*[^&\s]+/gi, 'password=***')
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, 'postgresql://***')
    .replace(/jdbc:postgresql:\/\/[^\s]+/gi, 'jdbc:postgresql://***')
    .substring(0, 500);
}

function pgHost_(url) {
  var m = String(url || '').match(/^jdbc:postgresql:\/\/([^\/?]+)/i);
  return m ? m[1] : '—';
}

function pgConnect_() {
  var cfg = pgCfg_();
  if (!cfg.enabled) throw new Error('PG_NOT_CONFIGURED');
  var conn = (cfg.user || cfg.pass)
    ? Jdbc.getConnection(cfg.url, cfg.user, cfg.pass)
    : Jdbc.getConnection(cfg.url);
  try { conn.setAutoCommit(false); } catch (e) {}
  return conn;
}

function pgEnsureSchema_(conn, cfg) {
  var cache = CacheService.getScriptCache();
  var key = 'pg_schema_' + cfg.table + '_' + pgHost_(cfg.url);
  if (cache.get(key) === '1') return;
  var t = cfg.table, st = conn.createStatement();
  try {
    st.execute('CREATE TABLE IF NOT EXISTS ' + t + ' ('
      + 'id BIGSERIAL PRIMARY KEY,'
      + 'sheet_row INTEGER,'
      + 'branch VARCHAR(80) NOT NULL,'
      + 'item VARCHAR(160) NOT NULL,'
      + 'stop_date DATE NOT NULL,'
      + 'stop_time TIME NOT NULL,'
      + 'end_time TIME NULL,'
      + 'duration_seconds INTEGER NOT NULL DEFAULT 0,'
      + 'reason VARCHAR(200),'
      + 'note VARCHAR(500),'
      + 'is_open BOOLEAN NOT NULL DEFAULT TRUE,'
      + 'at_close BOOLEAN NOT NULL DEFAULT FALSE,'
      + 'needs_review BOOLEAN NOT NULL DEFAULT FALSE,'
      + 'source VARCHAR(40) NOT NULL DEFAULT \'sheet\','
      + 'created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),'
      + 'updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),'
      + 'CONSTRAINT ' + t + '_uq UNIQUE (branch, item, stop_date, stop_time)'
      + ')');
    st.execute('CREATE INDEX IF NOT EXISTS ' + t + '_open_idx ON ' + t + ' (is_open, stop_date DESC, stop_time DESC)');
    st.execute('CREATE INDEX IF NOT EXISTS ' + t + '_branch_idx ON ' + t + ' (branch, stop_date DESC, stop_time DESC)');
  } finally {
    try { st.close(); } catch (e) {}
  }
  try { cache.put(key, '1', 3600); } catch (e) {}
}

function pgBind_(st, rec) {
  st.setInt(1, rec.sheet_row || 0);
  st.setString(2, String(rec.branch || ''));
  st.setString(3, String(rec.item || ''));
  st.setString(4, String(rec.stop_date || ''));
  st.setString(5, String(rec.stop_time || '0:00:00'));
  st.setString(6, rec.end_time ? String(rec.end_time) : '');
  st.setInt(7, Math.max(0, Math.round(rec.duration_seconds || 0)));
  st.setString(8, String(rec.reason || ''));
  st.setString(9, String(rec.note || ''));
  st.setBoolean(10, !!rec.is_open);
  st.setBoolean(11, !!rec.at_close);
  st.setBoolean(12, !!rec.needs_review);
}

var PG_SQL_ = 'INSERT INTO {T} '
  + '(sheet_row, branch, item, stop_date, stop_time, end_time, duration_seconds, reason, note, is_open, at_close, needs_review, source, created_at, updated_at) '
  + 'VALUES (?, ?, ?, CAST(? AS date), CAST(? AS time), NULLIF(?, \'\')::time, ?, ?, ?, ?, ?, ?, \'sheet\', NOW(), NOW()) '
  + 'ON CONFLICT (branch, item, stop_date, stop_time) DO UPDATE SET '
  + 'sheet_row = EXCLUDED.sheet_row, end_time = EXCLUDED.end_time, duration_seconds = EXCLUDED.duration_seconds, '
  + 'reason = EXCLUDED.reason, note = EXCLUDED.note, is_open = EXCLUDED.is_open, '
  + 'at_close = EXCLUDED.at_close, needs_review = EXCLUDED.needs_review, updated_at = NOW()';

function pgSql_(table) { return PG_SQL_.replace('{T}', table); }

/** حفظ/تحديث حركة واحدة — بتبلع أي خطأ عشان الشيت ميقفش */
function pgUpsertSafe_(rec) {
  var cfg = pgCfg_();
  if (!cfg.enabled) return false;
  var conn = null;
  try {
    conn = pgConnect_();
    pgEnsureSchema_(conn, cfg);
    var st = conn.prepareStatement(pgSql_(cfg.table));
    try { pgBind_(st, rec); st.executeUpdate(); } finally { try { st.close(); } catch (e) {} }
    conn.commit();
    return true;
  } catch (e) {
    try { if (conn) conn.rollback(); } catch (e2) {}
    Logger.log('PG upsert: ' + pgErr_(e));
    return false;
  } finally {
    try { if (conn) conn.close(); } catch (e) {}
  }
}

function pgRecFromRow_(branch, r) {
  return {
    sheet_row: r.x, branch: branch, item: r.it,
    stop_date: r.d, stop_time: r.st, end_time: r.en || '',
    duration_seconds: r.dsec || 0, reason: r.r || '', note: r.n || '',
    is_open: !!r.o, at_close: !!r.c, needs_review: !!r.v
  };
}

/** مزامنة حركة واحدة مع كل القواعد المفعلة (best-effort) */
function dbUpsertSafe_(rec) {
  var a = false, b = false;
  try { a = pgUpsertSafe_(rec); } catch (e) { Logger.log('PG upsert wrapper: ' + pgErr_(e)); }
  try { b = sbUpsertSafe_(rec); } catch (e) { Logger.log('Supabase upsert wrapper: ' + sbErr_(e)); }
  return a || b;
}

/** مزامنة كل الداتا — batch داخل معاملة واحدة */
function pgSyncRows_(branches) {
  var cfg = pgCfg_();
  if (!cfg.enabled) return { ok: false, synced: 0, error: 'PG_NOT_CONFIGURED' };
  var conn = null, total = 0;
  try {
    conn = pgConnect_();
    pgEnsureSchema_(conn, cfg);
    var st = conn.prepareStatement(pgSql_(cfg.table));
    try {
      branches.forEach(function (b) {
        b.rows.forEach(function (r) {
          pgBind_(st, pgRecFromRow_(b.name, r));
          st.addBatch();
          total++;
          if (total % 200 === 0) st.executeBatch();
        });
      });
      st.executeBatch();
    } finally { try { st.close(); } catch (e) {} }
    conn.commit();
    return { ok: true, synced: total };
  } catch (e) {
    try { if (conn) conn.rollback(); } catch (e2) {}
    return { ok: false, synced: 0, error: pgErr_(e) };
  } finally {
    try { if (conn) conn.close(); } catch (e) {}
  }
}

function pgStatusRaw_() {
  var cfg = pgCfg_();
  if (!cfg.enabled) {
    return { enabled: false, connected: false, message: 'مفيش إعدادات PostgreSQL. ضيف PG_URL و PG_USER و PG_PASSWORD في Script Properties.' };
  }
  var conn = null;
  try {
    conn = pgConnect_();
    pgEnsureSchema_(conn, cfg);
    var st = conn.createStatement(), total = 0, open = 0;
    try {
      var rs = st.executeQuery('SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN is_open THEN 1 ELSE 0 END), 0) AS o FROM ' + cfg.table);
      if (rs.next()) { total = rs.getInt('n'); open = rs.getInt('o'); }
      try { rs.close(); } catch (e) {}
    } finally { try { st.close(); } catch (e) {} }
    conn.commit();
    return { enabled: true, connected: true, total: total, open: open, table: cfg.table, host: pgHost_(cfg.url) };
  } catch (e) {
    return { enabled: true, connected: false, table: cfg.table, host: pgHost_(cfg.url), message: pgErr_(e) };
  } finally {
    try { if (conn) conn.close(); } catch (e) {}
  }
}

function pgTimeText_(t) {
  if (!t) return '';
  var m = String(t).match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  return m ? fmtHMS_(parseSeconds_(m[0])) : String(t);
}

function pgRecentRaw_(limit) {
  var cfg = pgCfg_();
  if (!cfg.enabled) return [];
  limit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
  var conn = null;
  try {
    conn = pgConnect_();
    pgEnsureSchema_(conn, cfg);
    var st = conn.prepareStatement('SELECT branch, item, stop_date, stop_time, end_time, duration_seconds, reason, note, is_open '
      + 'FROM ' + cfg.table + ' ORDER BY stop_date DESC, stop_time DESC, id DESC LIMIT ?');
    st.setInt(1, limit);
    var rs = st.executeQuery(), out = [];
    while (rs.next()) {
      out.push({
        b: rs.getString('branch'), it: rs.getString('item'),
        d: String(rs.getString('stop_date') || ''),
        st: pgTimeText_(rs.getString('stop_time')),
        en: pgTimeText_(rs.getString('end_time')),
        du: fmtHMS_(rs.getInt('duration_seconds')),
        r: rs.getString('reason') || '', n: rs.getString('note') || '',
        o: rs.getBoolean('is_open') ? 1 : 0
      });
    }
    try { rs.close(); } catch (e) {}
    try { st.close(); } catch (e) {}
    conn.commit();
    return out;
  } catch (e) {
    Logger.log('PG recent: ' + pgErr_(e));
    return [];
  } finally {
    try { if (conn) conn.close(); } catch (e) {}
  }
}

/** حالة القاعدة (مانجمنت بس) */
function getPostgresStatus(token) {
  auth_(token, [ROLE_MGMT]);
  return pgStatusRaw_();
}

/** مزامنة كاملة من الشيتات إلى PostgreSQL (مانجمنت بس) */
function syncToPostgres(token) {
  auth_(token, [ROLE_MGMT]);
  var res = withLock_(function () {
    var data = buildData_();
    return pgSyncRows_(data.branches);
  });
  cacheClear_();
  return { ok: !!res.ok, synced: res.synced || 0, error: res.error || '', status: pgStatusRaw_() };
}

/** استرجاع أحدث الحركات من القاعدة (مانجمنت بس) */
function getPostgresRecent(token, limit) {
  auth_(token, [ROLE_MGMT]);
  return pgRecentRaw_(limit);
}

/* ============================================================
 *  Supabase — مزامنة اختيارية عبر REST API (PostgREST)
 *
 *  الإعداد من: Project Settings ▸ Script Properties
 *    SUPABASE_URL    = https://PROJECT.supabase.co   (اختياري — بيتحسب من المفتاح)
 *    SUPABASE_KEY    = anon key                       (اختياري — فيه افتراضي تحت)
 *    SUPABASE_TABLE  = item_stops                     (اختياري)
 *    SUPABASE_ENABLED= false                          (اختياري لإيقاف المزامنة)
 *
 *  الجدول لازم يكون موجود بنفس أعمدة PostgreSQL:
 *
 *    CREATE TABLE IF NOT EXISTS item_stops (
 *      id BIGSERIAL PRIMARY KEY,
 *      sheet_row INTEGER,
 *      branch VARCHAR(80) NOT NULL,
 *      item VARCHAR(160) NOT NULL,
 *      stop_date DATE NOT NULL,
 *      stop_time TIME NOT NULL,
 *      end_time TIME NULL,
 *      duration_seconds INTEGER NOT NULL DEFAULT 0,
 *      reason VARCHAR(200),
 *      note VARCHAR(500),
 *      is_open BOOLEAN NOT NULL DEFAULT TRUE,
 *      at_close BOOLEAN NOT NULL DEFAULT FALSE,
 *      needs_review BOOLEAN NOT NULL DEFAULT FALSE,
 *      source VARCHAR(40) NOT NULL DEFAULT 'sheet',
 *      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *      CONSTRAINT item_stops_uq UNIQUE (branch, item, stop_date, stop_time)
 *    );
 *    ALTER TABLE item_stops ENABLE ROW LEVEL SECURITY;
 *    CREATE POLICY "anon read/write" ON item_stops FOR ALL USING (true) WITH CHECK (true);
 *
 *  ملاحظة أمنية: المفتاح الافتراضي anon بيخضع لـ Row Level Security.
 *  لو الـINSERT مرفوض (401/403 أو RLS)، نفّذ السياسة فوق أو استخدم
 *  service_role في SUPABASE_KEY — وده يتحط في Script Properties بس.
 * ============================================================ */

/** المفتاح الافتراضي (anon) — يتغيّر من SUPABASE_KEY في Script Properties */
var SUPABASE_KEY_DEFAULT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpsa2NxbGhhemZhbHNmY3pzdXZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3OTIwNDgsImV4cCI6MjEwODM2ODA0OH0.L2s0QgMxr9lfckMJtAJhhs4Cz1cw-rQLWv4hd7o7WyY';

function sbCfg_() {
  var props = PropertiesService.getScriptProperties();
  var key = String(props.getProperty('SUPABASE_KEY')
    || props.getProperty('SUPABASE_ANON_KEY')
    || SUPABASE_KEY_DEFAULT).trim();
  var url = String(props.getProperty('SUPABASE_URL') || '').trim().replace(/\/+$/, '');
  if (!url) url = sbUrlFromKey_(key);
  var table = String(props.getProperty('SUPABASE_TABLE') || CONFIG.PG_TABLE).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) table = CONFIG.PG_TABLE;
  var disabled = String(props.getProperty('SUPABASE_ENABLED') || '').toLowerCase() === 'false';
  return { enabled: !!(url && key) && !disabled, url: url, key: key, table: table };
}

/** استخراج رابط المشروع من مفتاح JWT (payload.ref) */
function sbUrlFromKey_(key) {
  var p = sbJwtPayload_(key);
  return (p && p.ref) ? ('https://' + p.ref + '.supabase.co') : '';
}

function sbJwtPayload_(jwt) {
  try {
    var part = String(jwt).split('.')[1] || '';
    if (!part) return null;
    part = part.replace(/-/g, '+').replace(/_/g, '/');
    while (part.length % 4) part += '=';
    var txt = Utilities.newBlob(Utilities.base64Decode(part)).getDataAsString('UTF-8');
    return JSON.parse(txt);
  } catch (e) { return null; }
}

function sbHeaders_(cfg, extra) {
  var h = {
    'apikey': cfg.key,
    'Authorization': 'Bearer ' + cfg.key,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) h[k] = extra[k]; } }
  return h;
}

/** وقت → HH:mm:ss (PostgREST بيحوّله لعمود time) */
function sbTime_(v) {
  if (v === null || v === undefined || v === '') return null;
  var m = String(v).match(/(\d{1,3}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return pad2_(+m[1]) + ':' + pad2_(+m[2]) + ':' + pad2_(m[3] == null ? 0 : +m[3]);
}

/** تحويل صف داخلي لأعمدة جدول Supabase */
function sbRec_(rec) {
  return {
    sheet_row: rec.sheet_row || null,
    branch: String(rec.branch || ''),
    item: String(rec.item || ''),
    stop_date: String(rec.stop_date || ''),
    stop_time: sbTime_(rec.stop_time) || '00:00:00',
    end_time: sbTime_(rec.end_time),
    duration_seconds: Math.max(0, Math.round(rec.duration_seconds || 0)),
    reason: String(rec.reason || ''),
    note: String(rec.note || ''),
    is_open: !!rec.is_open,
    at_close: !!rec.at_close,
    needs_review: !!rec.needs_review,
    source: rec.source || 'sheet',
    updated_at: new Date().toISOString()
  };
}

function sbErr_(e) {
  var s = String((e && e.message) || e || '');
  try { var cfg = sbCfg_(); if (cfg.key) s = s.split(cfg.key).join('***'); } catch (e2) {}
  s = s.replace(/eyJ[A-Za-z0-9_\-\.]{20,}/g, '***');
  return s.substring(0, 500);
}

function sbHeader_(res, name) {
  var h = res.getHeaders() || {};
  var want = String(name).toLowerCase();
  for (var k in h) { if (String(k).toLowerCase() === want) return h[k]; }
  return '';
}

/** نداء REST واحد — بيرمي خطأ واضح لو الرد مش 2xx */
function sbFetch_(method, path, body, extraHeaders) {
  var cfg = sbCfg_();
  if (!cfg.enabled) throw new Error('SUPABASE_NOT_CONFIGURED');
  var opt = { method: method, headers: sbHeaders_(cfg, extraHeaders), muteHttpExceptions: true };
  if (body !== undefined && body !== null) opt.payload = JSON.stringify(body);
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + cfg.table + path, opt);
  var code = res.getResponseCode();
  var txt = res.getContentText() || '';
  if (code < 200 || code >= 300) {
    var msg = txt;
    try { var j = JSON.parse(txt); msg = j.message || j.hint || j.details || txt; } catch (e) {}
    var err = new Error('Supabase ' + code + ': ' + msg);
    err.httpCode = code;
    throw err;
  }
  return txt;
}

/** قاطع مؤقت: لو Supabase وقع/الجدول مش موجود منحاولش مع كل حركة */
function sbOffline_() {
  try { return CacheService.getScriptCache().get('sb_offline') === '1'; } catch (e) { return false; }
}
function sbMarkOffline_() {
  try { CacheService.getScriptCache().put('sb_offline', '1', CONFIG.SB_BREAKER_SEC); } catch (e) {}
}
function sbMarkOnline_() {
  try { CacheService.getScriptCache().remove('sb_offline'); } catch (e) {}
}

/** حفظ/تحديث حركة واحدة — best-effort */
function sbUpsertSafe_(rec) {
  var cfg = sbCfg_();
  if (!cfg.enabled || sbOffline_()) return false;
  try {
    sbFetch_('POST', '?on_conflict=branch,item,stop_date,stop_time', [sbRec_(rec)], {
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    });
    sbMarkOnline_();
    return true;
  } catch (e) {
    sbMarkOffline_();
    Logger.log('Supabase upsert: ' + sbErr_(e));
    return false;
  }
}

/** مزامنة كل الداتا — دفعات 500 صف */
function sbSyncRows_(branches) {
  var cfg = sbCfg_();
  if (!cfg.enabled) return { ok: false, synced: 0, error: 'SUPABASE_NOT_CONFIGURED' };
  var all = [];
  branches.forEach(function (b) {
    b.rows.forEach(function (r) { all.push(sbRec_(pgRecFromRow_(b.name, r))); });
  });
  var CH = 500, total = 0;
  try {
    for (var i = 0; i < all.length; i += CH) {
      var chunk = all.slice(i, i + CH);
      sbFetch_('POST', '?on_conflict=branch,item,stop_date,stop_time', chunk, {
        'Prefer': 'resolution=merge-duplicates,return=minimal'
      });
      total += chunk.length;
    }
    sbMarkOnline_();
    return { ok: true, synced: total };
  } catch (e) {
    sbMarkOffline_();
    return { ok: false, synced: total, error: sbErr_(e) };
  }
}

function sbCount_(filter) {
  var cfg = sbCfg_();
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + cfg.table + '?select=id' + (filter || '') + '&limit=1', {
    headers: sbHeaders_(cfg, { 'Prefer': 'count=exact' }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) return 0;
  var n = parseInt(String(sbHeader_(res, 'content-range')).split('/')[1], 10);
  return isFinite(n) ? n : 0;
}

function sbStatusRaw_() {
  var cfg = sbCfg_();
  if (!cfg.enabled) {
    return { enabled: false, connected: false, message: 'مفيش إعدادات Supabase. ضيف SUPABASE_URL و SUPABASE_KEY في Script Properties.', table: cfg.table, host: '—', total: 0, open: 0 };
  }
  var host = cfg.url.replace(/^https?:\/\//, '');
  try {
    var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + cfg.table + '?select=id&limit=1', {
      headers: sbHeaders_(cfg, { 'Prefer': 'count=exact' }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 404 || code === 400) {
      throw new Error('الجدول "' + cfg.table + '" مش موجود في Supabase — نفّذ SQL الإنشاء اللي في تعليق sbCfg_.');
    }
    if (code === 401 || code === 403) throw new Error('المفتاح مرفوض أو مفيش صلاحية (RLS) — راجع SUPABASE_KEY والسياسات.');
    if (code >= 300) throw new Error('HTTP ' + code + ': ' + String(res.getContentText() || '').substring(0, 200));
    var total = parseInt(String(sbHeader_(res, 'content-range')).split('/')[1], 10);
    sbMarkOnline_();
    return {
      enabled: true, connected: true, table: cfg.table, host: host,
      total: isFinite(total) ? total : 0, open: sbCount_('&is_open=eq.true'), message: ''
    };
  } catch (e) {
    return { enabled: true, connected: false, table: cfg.table, host: host, total: 0, open: 0, message: sbErr_(e) };
  }
}

function sbRecentRaw_(limit) {
  var cfg = sbCfg_();
  if (!cfg.enabled) return [];
  limit = Math.max(1, Math.min(parseInt(limit, 10) || 50, 200));
  try {
    var txt = sbFetch_('GET', '?select=branch,item,stop_date,stop_time,end_time,duration_seconds,reason,note,is_open'
      + '&order=stop_date.desc,stop_time.desc,id.desc&limit=' + limit);
    var list = JSON.parse(txt || '[]');
    return list.map(function (r) {
      return {
        b: r.branch, it: r.item, d: String(r.stop_date || ''),
        st: pgTimeText_(r.stop_time), en: pgTimeText_(r.end_time),
        du: fmtHMS_(r.duration_seconds || 0), r: r.reason || '', n: r.note || '',
        o: r.is_open ? 1 : 0
      };
    });
  } catch (e) {
    Logger.log('Supabase recent: ' + sbErr_(e));
    return [];
  }
}

/* ---------- Supabase: قراءة الداشبورد (القاعدة الأساسية) ---------- */

/** Supabase جاهز؟ (مفعّل + مش في فترة تعطيل) */
function sbReady_() {
  try { var cfg = sbCfg_(); return cfg.enabled && !sbOffline_(); } catch (e) { return false; }
}

/** قوايم الايتمات/الأسباب من شيت DATA — كاش قصير عشان السرعة */
function dashLists_() {
  var c = cacheGet_('lists');
  if (c) return c;
  var out = { items: [], reasons: [] };
  try {
    var sh = getDataSheet_();
    out.items = readList_(sh, CONFIG.ITEM_COL);
    out.reasons = readList_(sh, CONFIG.REASON_COL).filter(function (x) { return keyOf_(x) !== keyOf_(UNSPEC); });
  } catch (e) { /* الشيت مش متاح — منمنعش القراءة من Supabase */ }
  cachePut_('lists', out, CONFIG.SB_LISTS_TTL);
  return out;
}

/** بيانات الفروع (الاسم + وقت القفل) من عناوين الشيتات — كاش 6 ساعات */
function branchMeta_() {
  var c = cacheGet_('bmeta');
  if (c) return c;
  var meta = [];
  try {
    getBranchSheets_().forEach(function (sh) {
      meta.push({ name: sh.getName(), close: closeInfo_(sh).text });
    });
  } catch (e) {}
  cachePut_('bmeta', meta, 21600);
  return meta;
}

function branchCloseMap_() {
  var m = {};
  branchMeta_().forEach(function (x) { m[keyOf_(x.name)] = x.close; });
  return m;
}

/** قراءة صفوف item_stops بالصفحات (Range headers) */
function sbFetchRows_() {
  var cfg = sbCfg_();
  var out = [], from = 0, page = CONFIG.SB_PAGE, cap = CONFIG.SB_MAX_ROWS, guard = 0;
  var q = '?select=id,sheet_row,branch,item,stop_date,stop_time,end_time,duration_seconds,reason,note,is_open,at_close,needs_review'
    + '&order=stop_date.desc,stop_time.desc,id.desc';
  while (out.length < cap && guard++ < 60) {
    var to = Math.min(from + page - 1, cap - 1);
    var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + cfg.table + q, {
      headers: sbHeaders_(cfg, { 'Range': from + '-' + to, 'Range-Unit': 'items' }),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code === 416) break;                       // خلصت الصفحات
    if (code < 200 || code >= 300) {
      var msg = res.getContentText() || '';
      try { var j = JSON.parse(msg); msg = j.message || msg; } catch (e) {}
      throw new Error('Supabase ' + code + ': ' + msg);
    }
    var chunk = JSON.parse(res.getContentText() || '[]');
    if (!chunk.length) break;
    out = out.concat(chunk);
    from += chunk.length;
    var total = parseInt(String(sbHeader_(res, 'content-range')).split('/')[1], 10);
    if (isFinite(total) && out.length >= total) break;
    if (chunk.length < page) break;
  }
  return out;
}

/** صف Supabase → شكل الداشبورد الداخلي */
function sbRowToDash_(r, now) {
  var dk = String(r.stop_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dk)) return null;
  var stop = parseSeconds_(r.stop_time);
  if (stop === null) return null;
  var start = (r.end_time === null || r.end_time === undefined || r.end_time === '') ? null : parseSeconds_(r.end_time);
  var isOpen = (start === null), durSec;
  if (isOpen) {
    durSec = Math.max(0, (dayNum_(now.key) * 86400 + now.sec) - (dayNum_(dk) * 86400 + stop));
  } else {
    durSec = (start - stop + 86400) % 86400;
  }
  var hours = durSec / 3600;
  return {
    id: r.id,
    d: dk,
    it: normName_(r.item),
    st: fmtHMS_(stop),
    en: isOpen ? '' : fmtHMS_(start),
    stv: stop,
    env: isOpen ? null : start,
    h: Math.round(hours * 100) / 100,
    du: fmtHMS_(durSec),
    dsec: durSec,
    r: normName_(r.reason) || UNSPEC,
    n: normName_(r.note),
    o: isOpen ? 1 : 0,
    c: r.at_close ? 1 : 0,
    v: ((!isOpen && durSec === 0) || !!r.needs_review) ? 1 : 0,
    x: r.sheet_row || null
  };
}

/** بناء payload الداشبورد بالكامل من Supabase */
function sbDashboardPayload_() {
  var now = nowParts_();
  var list = sbFetchRows_();
  var lists = dashLists_();
  var meta = branchMeta_();
  var groups = {};

  meta.forEach(function (m) {
    groups[keyOf_(m.name)] = { name: m.name, close: m.close || CONFIG.DEFAULT_CLOSE, rows: [], skipped: 0 };
  });

  list.forEach(function (r) {
    var bn = normName_(r.branch);
    if (!bn) return;
    var k = keyOf_(bn);
    if (!groups[k]) {
      groups[k] = {
        name: bn,
        close: CONFIG.CLOSE_OVERRIDE[bn] || CONFIG.CLOSE_FALLBACK[bn] || CONFIG.DEFAULT_CLOSE,
        rows: [], skipped: 0
      };
    }
    var row = sbRowToDash_(r, now);
    if (row) groups[k].rows.push(row);
  });

  var branches = Object.keys(groups).map(function (k) {
    var b = groups[k];
    b.rows.sort(function (a, c) {
      if (a.d !== c.d) return a.d < c.d ? 1 : -1;
      return (c.stv || 0) - (a.stv || 0);
    });
    return b;
  });
  branches.sort(function (a, c) { return a.name.localeCompare(c.name, 'ar'); });

  return {
    generatedAt: now.key + ' ' + now.hms,
    now: now.key,
    branches: branches,
    items: lists.items,
    reasons: lists.reasons,
    skipped: 0,
    src: 'sb'
  };
}

/* ---------- Supabase: كتابة الحركات ---------- */

function sbOpenExists_(branch, item) {
  var txt = sbFetch_('GET', '?select=id&branch=eq.' + encodeURIComponent(branch)
    + '&item=eq.' + encodeURIComponent(item) + '&is_open=eq.true&limit=1');
  var arr = JSON.parse(txt || '[]');
  return arr.length > 0;
}

function sbInsertStop_(branch, item, reason, note) {
  var now = nowParts_();
  var rec = {
    sheet_row: null, branch: branch, item: item,
    stop_date: now.key, stop_time: now.hms, end_time: '',
    duration_seconds: 0, reason: reason, note: note,
    is_open: true, at_close: false, needs_review: false, source: 'dashboard'
  };
  var txt = sbFetch_('POST', '?on_conflict=branch,item,stop_date,stop_time&select=*', [sbRec_(rec)], {
    'Prefer': 'resolution=merge-duplicates,return=representation'
  });
  var arr = JSON.parse(txt || '[]');
  if (!arr[0] || !arr[0].id) throw new Error('Supabase مارجّعش الصف بعد الحفظ.');
  return arr[0];
}

function sbPatch_(id, patch) {
  var txt = sbFetch_('PATCH', '?id=eq.' + encodeURIComponent(id) + '&select=*', patch, {
    'Prefer': 'return=representation'
  });
  var arr = JSON.parse(txt || '[]');
  return arr[0] || null;
}

/** إيجاد حركة مفتوحة بـid أو بـsheet_row أو بآخر حركة للايتم */
function sbFindOpen_(branch, id, sheetRow, item) {
  var q;
  if (id) {
    q = '?select=*&id=eq.' + encodeURIComponent(id) + '&limit=1';
  } else if (sheetRow) {
    q = '?select=*&branch=eq.' + encodeURIComponent(branch)
      + '&sheet_row=eq.' + encodeURIComponent(sheetRow) + '&is_open=eq.true&limit=1';
  } else if (item) {
    q = '?select=*&branch=eq.' + encodeURIComponent(branch)
      + '&item=eq.' + encodeURIComponent(item)
      + '&is_open=eq.true&order=stop_date.desc,stop_time.desc&limit=1';
  } else {
    throw bizErr_('مفيش مرجع للحركة — حدّث الداتا وجرّب تاني.');
  }
  var txt = sbFetch_('GET', q);
  var arr = JSON.parse(txt || '[]');
  return arr[0] || null;
}

function sbResumeStop_(branch, id, sheetRow, item) {
  var rec = sbFindOpen_(branch, id, sheetRow, item);
  if (!rec) throw bizErr_('مفيش حركة مفتوحة للايتم ده — حدّث الداتا وجرّب تاني.');
  if (keyOf_(rec.branch) !== keyOf_(branch)) throw bizErr_('الحركة دي مش بتاعة الفرع.');
  if (!rec.is_open) throw bizErr_('الايتم ده اتسجل له تشغيل بالفعل.');

  var stopSec = parseSeconds_(rec.stop_time);
  if (stopSec === null) throw new Error('وقت الإيقاف في القاعدة غير صالح.');
  var now = nowParts_();
  var durSec = (now.sec - stopSec + 86400) % 86400;
  var closes = branchCloseMap_();
  var closeSec = parseSeconds_(closes[keyOf_(branch)] || '');
  var atClose = closeSec !== null && now.sec === closeSec;

  var saved = sbPatch_(rec.id, {
    end_time: sbTime_(now.hms),
    duration_seconds: durSec,
    is_open: false,
    at_close: atClose,
    needs_review: durSec === 0,
    updated_at: new Date().toISOString()
  });
  if (!saved) throw new Error('Supabase مارجّعش الصف بعد التحديث.');
  return saved;
}

/** حالة Supabase (مانجمنت بس) */
function getSupabaseStatus(token) {
  auth_(token, [ROLE_MGMT]);
  return sbStatusRaw_();
}

/** مزامنة كاملة من الشيتات إلى Supabase (مانجمنت بس) */
function syncToSupabase(token) {
  auth_(token, [ROLE_MGMT]);
  var res = withLock_(function () {
    return sbSyncRows_(buildData_().branches);
  });
  cacheClear_();
  return { ok: !!res.ok, synced: res.synced || 0, error: res.error || '', status: sbStatusRaw_() };
}

/** استرجاع أحدث الحركات من Supabase (مانجمنت بس) */
function getSupabaseRecent(token, limit) {
  auth_(token, [ROLE_MGMT]);
  return sbRecentRaw_(limit);
}

/* ============================================================
 *  طابور مزامنة الشيت في الخلفية
 *  - Supabase هو الأساس: الكتابة بتخلص فوراً
 *  - الشيت بيتحدّث بعدين عبر trigger كل دقيقة
 * ============================================================ */

var SYNC_PREFIX = 'SYNCJOB_';

function sbQueueKeys_() {
  var all = PropertiesService.getScriptProperties().getProperties();
  return Object.keys(all).filter(function (k) { return k.indexOf(SYNC_PREFIX) === 0; }).sort();
}

function sbQueueCount_() { return sbQueueKeys_().length; }

/** إضافة وظيفة مزامنة للطابور + التأكد من وجود الـtrigger */
function enqueueSheetJob_(job) {
  try {
    var qid = String(Date.now()) + '_' + Math.random().toString(36).slice(2, 8);
    job.qid = qid;
    job.tries = 0;
    PropertiesService.getScriptProperties().setProperty(SYNC_PREFIX + qid, JSON.stringify(job));
    ensureSheetSyncTrigger_();
    return true;
  } catch (e) {
    Logger.log('Queue enqueue: ' + e);
    return false;
  }
}

/** trigger كل دقيقة — بيتعمل مرة واحدة بس */
function ensureSheetSyncTrigger_() {
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get('sync_trigger') === '1') return;
    var has = ScriptApp.getProjectTriggers().some(function (t) {
      return t.getHandlerFunction() === 'processSheetSyncQueue';
    });
    if (!has) {
      ScriptApp.newTrigger('processSheetSyncQueue').timeBased().everyMinutes(1).create();
    }
    cache.put('sync_trigger', '1', 21600);
  } catch (e) {
    Logger.log('ensureSheetSyncTrigger_: ' + e);
  }
}

/** معالجة الطابور — بتتنادى من الـtrigger أو يدوياً */
function processSheetSyncQueue() {
  var keys = sbQueueKeys_();
  if (!keys.length) return 0;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return 0;
  var done = 0;
  try {
    var props = PropertiesService.getScriptProperties();
    var batch = keys.slice(0, CONFIG.SB_QUEUE_MAX);
    for (var i = 0; i < batch.length; i++) {
      var key = batch[i], job = null;
      try { job = JSON.parse(props.getProperty(key) || 'null'); } catch (e) { props.deleteProperty(key); continue; }
      if (!job) { props.deleteProperty(key); continue; }
      try {
        applySheetJob_(job);
        props.deleteProperty(key);
        done++;
      } catch (e) {
        job.tries = (job.tries || 0) + 1;
        job.err = String((e && e.message) || e).substring(0, 200);
        if (job.tries >= 6) {
          props.deleteProperty(key);
          Logger.log('SYNC DROP ' + key + ': ' + job.err);
        } else {
          props.setProperty(key, JSON.stringify(job));
        }
      }
    }
  } finally {
    lock.releaseLock();
  }
  return done;
}

function serialFromKey_(key) {
  var p = String(key || '').split('-');
  if (p.length !== 3) return null;
  return Math.round((Date.UTC(+p[0], +p[1] - 1, +p[2]) - Date.UTC(1899, 11, 30)) / 86400000);
}

function nextDataRow_(sh) {
  var last = sh.getLastRow();
  if (last < CONFIG.FIRST_ROW) return CONFIG.FIRST_ROW;
  var n = last - CONFIG.FIRST_ROW + 1;
  var vals = sh.getRange(CONFIG.FIRST_ROW, 3, n, 1).getDisplayValues();
  var row = CONFIG.FIRST_ROW - 1;
  for (var i = 0; i < n; i++) { if (normName_(vals[i][0])) row = CONFIG.FIRST_ROW + i; }
  return row + 1;
}

function verifySheetRow_(sh, row, job) {
  row = parseInt(row, 10);
  if (!(row >= CONFIG.FIRST_ROW && row <= sh.getLastRow())) return 0;
  var d = sh.getRange(row, 1, 1, 8).getDisplayValues()[0];
  if (keyOf_(d[2]) !== keyOf_(job.it)) return 0;
  if (parseSeconds_(d[3]) !== parseSeconds_(job.st)) return 0;
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  if (dateKey_(null, d[0], tz) !== job.d) return 0;
  return row;
}

function findSheetRow_(sh, job) {
  var n = sh.getLastRow() - CONFIG.FIRST_ROW + 1;
  if (n < 1) return 0;
  var vals = sh.getRange(CONFIG.FIRST_ROW, 1, n, 8).getDisplayValues();
  var stopSec = parseSeconds_(job.st);
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  for (var i = 0; i < n; i++) {
    if (keyOf_(vals[i][2]) !== keyOf_(job.it)) continue;
    if (parseSeconds_(vals[i][3]) !== stopSec) continue;
    if (dateKey_(null, vals[i][0], tz) !== job.d) continue;
    return CONFIG.FIRST_ROW + i;
  }
  return 0;
}

function writeStopCells_(sh, row, job) {
  var stopSec = parseSeconds_(job.st);
  if (stopSec === null) throw new Error('وقت الإيقاف غير صالح.');
  var serial = serialFromKey_(job.d);
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 50);
  sh.getRange(row, 1).setNumberFormat('dd/mm/yyyy');
  sh.getRange(row, 2).setNumberFormat('dddd');
  sh.getRange(row, 4).setNumberFormat('h:mm:ss AM/PM');
  sh.getRange(row, 5).setNumberFormat('h:mm:ss AM/PM');
  sh.getRange(row, 6).setNumberFormat('[h]:mm:ss');
  sh.getRange(row, 1).setValue(serial);
  sh.getRange(row, 2).setFormula('=A' + row);
  sh.getRange(row, 3).setValue(job.it);
  sh.getRange(row, 4).setValue(stopSec / 86400);
  sh.getRange(row, 5).clearContent();
  sh.getRange(row, 6).setFormula('=IF(E' + row + '="","",MOD(E' + row + '-D' + row + ',1))');
  sh.getRange(row, 7).setValue(job.r || '');
  sh.getRange(row, 8).setValue(job.n || '');
  SpreadsheetApp.flush();
}

/** كاش شيتات الفروع داخل نفس التنفيذ (مهم للمزامنة الجماعية) */
var SHEET_CACHE_ = null;
function branchSheetCached_(name) {
  if (!SHEET_CACHE_) {
    SHEET_CACHE_ = {};
    getBranchSheets_().forEach(function (sh) { SHEET_CACHE_[keyOf_(sh.getName())] = sh; });
  }
  var sh = SHEET_CACHE_[keyOf_(name)];
  if (!sh) throw new Error('الفرع "' + name + '" غير موجود.');
  return sh;
}

/** تنفيذ وظيفة واحدة على الشيت (idempotent: ميعملش صف مكرر) */
function applySheetJob_(job) {
  var sh = branchSheetCached_(job.b);
  var row = job.x ? verifySheetRow_(sh, job.x, job) : 0;
  if (!row) row = findSheetRow_(sh, job);
  if (!row) {
    row = nextDataRow_(sh);
    writeStopCells_(sh, row, job);
  }
  if (job.t === 'resume') {
    var endSec = parseSeconds_(job.en);
    if (endSec === null) throw new Error('وقت التشغيل غير صالح.');
    sh.getRange(row, 5).setNumberFormat('h:mm:ss AM/PM');
    sh.getRange(row, 5).setValue(endSec / 86400);
    sh.getRange(row, 6).setNumberFormat('[h]:mm:ss');
    sh.getRange(row, 6).setFormula('=IF(E' + row + '="","",MOD(E' + row + '-D' + row + ',1))');
    SpreadsheetApp.flush();
  }
  if (job.id && !job.noPatch) sbSetSheetRow_(job.id, row);
}

function sbSetSheetRow_(id, row) {
  try { sbPatch_(id, { sheet_row: row }); }
  catch (e) { Logger.log('SB sheet_row: ' + sbErr_(e)); }
}

/** معالجة الطابور فوراً (مانجمنت بس) */
function flushSheetSyncQueue(token) {
  auth_(token, [ROLE_MGMT]);
  var n = processSheetSyncQueue();
  return { ok: true, processed: n, pending: sbQueueCount_() };
}

/** حالة طابور المزامنة (مانجمنت بس) */
function getSyncQueueStatus(token) {
  auth_(token, [ROLE_MGMT]);
  var props = PropertiesService.getScriptProperties().getProperties();
  var keys = sbQueueKeys_(), jobs = [];
  keys.slice(0, 20).forEach(function (k) {
    try {
      var j = JSON.parse(props[k]);
      jobs.push({ t: j.t, b: j.b, it: j.it, d: j.d, tries: j.tries || 0, err: j.err || '' });
    } catch (e) {}
  });
  return { pending: keys.length, jobs: jobs };
}

/**
 * مطابقة الشيت مع Supabase (بدون حذف) — مانجمنت بس.
 * بتشتغل على دفعات (80 صف) عشان متتخطاش حد وقت التنفيذ.
 * نادِها بـ offset = nextOffset اللي رجع من النداء السابق لحد ما nextOffset = null.
 */
function reconcileSheetFromSupabase(token, offset) {
  auth_(token, [ROLE_MGMT]);
  var rows = sbFetchRows_();
  var cap = 80;
  var start = Math.max(0, parseInt(offset, 10) || 0);
  var slice = rows.slice(start, start + cap);
  var jobs = slice.map(function (r) {
    return {
      t: r.is_open ? 'stop' : 'resume',
      id: r.id, noPatch: 1,
      b: r.branch, it: r.item,
      d: String(r.stop_date).slice(0, 10),
      st: pgTimeText_(r.stop_time),
      en: r.end_time ? pgTimeText_(r.end_time) : '',
      r: r.reason || '', n: r.note || '',
      x: r.sheet_row || 0
    };
  });
  var done = 0, failed = 0;
  withLock_(function () {
    jobs.forEach(function (j) {
      try { applySheetJob_(j); done++; }
      catch (e) { failed++; Logger.log('reconcile ' + j.id + ': ' + e); }
    });
  });
  var next = start + slice.length;
  return {
    ok: true, total: rows.length, processed: slice.length, done: done, failed: failed,
    remaining: Math.max(0, rows.length - next),
    nextOffset: next < rows.length ? next : null
  };
}

/** تشغيل/إصلاح trigger المزامنة من محرر Apps Script */
function setupSheetSyncTrigger() {
  ensureSheetSyncTrigger_();
  return { ok: true };
}

/* ============================================================
 *  اليوزرات والصلاحيات
 *  الأدوار:
 *   management = كل حاجة (التقارير + إضافة/حذف ايتم وريزون + إدارة اليوزرات + تسجيل إيقاف/تشغيل لأي فرع)
 *   branch     = دسباتشر فرع: يسجل إيقاف (يختار الايتم والسبب) ويشغّل الايتم — على فرعه بس
 *   agent      = قراءة فقط: الايتمات اللي وقفت واشتغلت (من غير ساعات ولا أسباب ولا تقارير)
 *
 *  كل دالة عامة بتتحقق من التوكن والدور على السيرفر.
 * ============================================================ */

function addDaysKey_(key, n) {
  var p = key.split('-'), t = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + n));
  return t.getUTCFullYear() + '-' + pad2_(t.getUTCMonth() + 1) + '-' + pad2_(t.getUTCDate());
}

/** شيت اليوزرات (بيتعمل مخفي لو مش موجود) */
function getUsersSheet_(create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(CONFIG.USERS_SHEET);
  if (!sh && create) {
    sh = ss.insertSheet(CONFIG.USERS_SHEET);
    sh.getRange(1, 1, 1, 7).setValues([['Username', 'Role', 'Branch', 'Salt', 'Hash', 'Active', 'Created']]);
    sh.setFrozenRows(1);
    sh.hideSheet();
  }
  return sh;
}

function readUsers_() {
  var sh = getUsersSheet_(false);
  if (!sh || sh.getLastRow() < 2) return [];
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues(), out = [];
  vals.forEach(function (r, i) {
    var name = normName_(r[0]);
    if (!name) return;
    out.push({
      row: i + 2, username: name, role: String(r[1]).trim(), branch: normName_(r[2]),
      salt: String(r[3]), hash: String(r[4]), active: String(r[5]).toUpperCase() === 'TRUE'
    });
  });
  return out;
}

/** خريطة اليوزرات (بتتخزن في الكاش دقيقتين وبتتمسح عند أي تعديل) */
function usersMap_() {
  var cache = CacheService.getScriptCache(), raw = cache.get('users_map');
  if (raw) { try { return JSON.parse(raw); } catch (e) {} }
  var map = {};
  readUsers_().forEach(function (u) { map[keyOf_(u.username)] = u; });
  try { cache.put('users_map', JSON.stringify(map), 120); } catch (e) {}
  return map;
}
function usersCacheClear_() { try { CacheService.getScriptCache().remove('users_map'); } catch (e) {} }

function hashPass_(salt, pass) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, salt + ':' + pass, Utilities.Charset.UTF_8);
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function safeEqual_(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  var d = 0;
  for (var i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

function randomPass_(n) {
  var alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  var hex = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''), out = '';
  for (var i = 0; i < n; i++) out += alphabet.charAt(parseInt(hex.substr(i * 2, 2), 16) % alphabet.length);
  return out;
}

/** تسجيل الدخول: بيرجّع توكن + الداتا المفلترة حسب الدور في نفس النداء */
function login(username, password) {
  username = normName_(username);
  password = String(password || '');
  if (!username || !password) throw new Error('اكتب اسم المستخدم وكلمة السر.');
  var cache = CacheService.getScriptCache();
  var fk = 'fail_' + keyOf_(username).substr(0, 60);
  if (parseInt(cache.get(fk) || '0', 10) >= CONFIG.MAX_FAILS) {
    throw new Error('محاولات كتير غلط. استنى ' + Math.round(CONFIG.FAIL_LOCK / 60) + ' دقايق وجرّب تاني.');
  }
  var u = usersMap_()[keyOf_(username)];
  var ok = !!(u && u.active && safeEqual_(hashPass_(u.salt, password), u.hash));
  if (!ok) {
    cache.put(fk, String(parseInt(cache.get(fk) || '0', 10) + 1), CONFIG.FAIL_LOCK);
    Utilities.sleep(500);
    throw new Error('اسم المستخدم أو كلمة السر غلط.');
  }
  cache.remove(fk);
  var token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  cache.put('sess_' + token, JSON.stringify({ u: u.username }), CONFIG.SESSION_TTL);
  var user = { username: u.username, role: u.role, branch: u.branch };
  return { token: token, data: scopePayload_(fullData_(false), user) };
}

function logout(token) {
  try { if (token) CacheService.getScriptCache().remove('sess_' + token); } catch (e) {}
  return true;
}

/** تحقق من التوكن + الدور. بيرجّع اليوزر أو بيرمي SESSION_EXPIRED */
function auth_(token, roles) {
  var cache = CacheService.getScriptCache();
  var raw = token ? cache.get('sess_' + String(token)) : null;
  if (!raw) throw new Error('SESSION_EXPIRED');
  var s;
  try { s = JSON.parse(raw); } catch (e) { throw new Error('SESSION_EXPIRED'); }
  var u = usersMap_()[keyOf_(s.u)];
  if (!u || !u.active) throw new Error('SESSION_EXPIRED');          // اليوزر اتحذف أو اتوقف
  cache.put('sess_' + token, raw, CONFIG.SESSION_TTL);                // الجلسة بتتجدد مع كل نشاط
  var user = { username: u.username, role: u.role, branch: u.branch };
  if (roles && roles.indexOf(user.role) === -1) throw new Error('مفيش عندك صلاحية لتنفيذ العملية دي.');
  return user;
}

/** بيفلتر الداتا حسب دور اليوزر — اللي مش مسموح يشوفه مبيوصلش للمتصفح أصلا */
function scopePayload_(full, user) {
  var me = { username: user.username, role: user.role, branch: user.branch };
  var out = { generatedAt: full.generatedAt, now: full.now, me: me };
  if (user.role === ROLE_MGMT) {
    out.branches = full.branches; out.items = full.items; out.reasons = full.reasons; out.skipped = full.skipped;
    return out;
  }
  var minDay = addDaysKey_(full.now, -CONFIG.RECENT_DAYS);
  var branches = full.branches.filter(function (b) {
    if (user.role === ROLE_BRANCH) return !!user.branch && b.name === user.branch;     // دسباتشر: فرعه بس
    return !user.branch || b.name === user.branch;                                      // ايجينت: فرع محدد أو كل الفروع
  }).map(function (b) {
    var rows = b.rows.filter(function (r) { return r.o || r.d >= minDay; }).map(function (r) {
      if (user.role === ROLE_AGENT) return { d: r.d, it: r.it, st: r.st, en: r.en, stv: r.stv, env: r.env, o: r.o };
      return {
        d: r.d, it: r.it, st: r.st, en: r.en, stv: r.stv, env: r.env,
        h: r.h, du: r.du, r: r.r, n: r.n, o: r.o, c: r.c, v: r.v, x: r.x, id: r.id
      };
    });
    return { name: b.name, close: b.close, rows: rows, skipped: 0 };
  });
  out.branches = branches;
  out.items = user.role === ROLE_BRANCH ? full.items : [];
  out.reasons = user.role === ROLE_BRANCH ? full.reasons : [];
  out.skipped = 0;
  return out;
}

/* ---------------- إدارة اليوزرات (مانجمنت بس) ---------------- */

function listUsersPublic_() {
  return readUsers_().map(function (u) { return { username: u.username, role: u.role, branch: u.branch, active: u.active }; });
}

function listUsers(token) {
  auth_(token, [ROLE_MGMT]);
  return listUsersPublic_();
}

/** إضافة/تعديل يوزر. الباسورد اختياري عند التعديل (فاضي = من غير تغيير) */
function saveUser(token, u) {
  auth_(token, [ROLE_MGMT]);
  u = u || {};
  var username = normName_(u.username);
  if (!/^[A-Za-z0-9_.\-]{3,30}$/.test(username)) throw new Error('اسم المستخدم 3-30 حرف إنجليزي أو أرقام (مسموح . _ -).');
  var role = String(u.role || '');
  if ([ROLE_MGMT, ROLE_BRANCH, ROLE_AGENT].indexOf(role) === -1) throw new Error('الدور غير صحيح.');
  var branch = normName_(u.branch);
  if (role === ROLE_MGMT) branch = '';
  if (role === ROLE_BRANCH && !branch) throw new Error('اختار الفرع لدسباتشر الفرع.');
  if (branch) getBranchSheetByName_(branch);                        // بيتأكد إن الفرع موجود
  var pass = String(u.password || '');
  if (pass && pass.length < 6) throw new Error('كلمة السر لازم تكون 6 حروف/أرقام على الأقل.');
  var active = u.active !== false;

  return withLock_(function () {
    var sh = getUsersSheet_(true), users = readUsers_(), existing = null;
    users.forEach(function (x) { if (keyOf_(x.username) === keyOf_(username)) existing = x; });
    if (!existing && !pass) throw new Error('اكتب كلمة سر لليوزر الجديد (6 حروف/أرقام على الأقل).');

    var activeMgmt = users.filter(function (x) {
      return !(existing && x.row === existing.row) && x.role === ROLE_MGMT && x.active;
    }).length + ((role === ROLE_MGMT && active) ? 1 : 0);
    if (activeMgmt < 1) throw new Error('لازم يفضل مدير (management) نشط واحد على الأقل.');

    var salt = pass ? Utilities.getUuid() : existing.salt;
    var hash = pass ? hashPass_(salt, pass) : existing.hash;
    var name = existing ? existing.username : username;
    if (existing) {
      sh.getRange(existing.row, 1, 1, 6).setValues([[name, role, branch, salt, hash, active]]);
    } else {
      sh.appendRow([name, role, branch, salt, hash, active, Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd h:mm:ss a')]);
    }
    usersCacheClear_();
    return listUsersPublic_();
  });
}

function deleteUser(token, username) {
  var me = auth_(token, [ROLE_MGMT]);
  username = normName_(username);
  if (keyOf_(username) === keyOf_(me.username)) throw new Error('مينفعش تحذف نفسك.');
  return withLock_(function () {
    var users = readUsers_(), target = null;
    users.forEach(function (x) { if (keyOf_(x.username) === keyOf_(username)) target = x; });
    if (!target) throw new Error('اليوزر مش موجود.');
    var others = users.filter(function (x) { return x.row !== target.row && x.role === ROLE_MGMT && x.active; }).length;
    if (target.role === ROLE_MGMT && others < 1) throw new Error('لازم يفضل مدير نشط واحد على الأقل.');
    getUsersSheet_(false).deleteRow(target.row);
    usersCacheClear_();
    return listUsersPublic_();
  });
}

/** بيعمل يوزر دسباتشر لكل فرع ملوش يوزر، بباسورد عشوائي بيظهر مرة واحدة بس (متخزن مشفّر) */
function createBranchUsers(token) {
  auth_(token, [ROLE_MGMT]);
  return withLock_(function () {
    var sh = getUsersSheet_(true), users = readUsers_(), created = [], taken = {}, has = {};
    users.forEach(function (u) {
      taken[keyOf_(u.username)] = 1;
      if (u.role === ROLE_BRANCH) has[keyOf_(u.branch)] = 1;
    });
    getBranchSheets_().forEach(function (b) {
      var bn = b.getName();
      if (has[keyOf_(bn)]) return;
      var base = bn.toLowerCase().replace(/[^a-z0-9]/g, '') || 'branch', uname = base, k = 1;
      while (taken[uname]) { k++; uname = base + k; }
      taken[uname] = 1;
      var pass = randomPass_(8), salt = Utilities.getUuid();
      sh.appendRow([uname, ROLE_BRANCH, bn, salt, hashPass_(salt, pass), true, Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd h:mm:ss a')]);
      created.push({ username: uname, password: pass, branch: bn });
    });
    usersCacheClear_();
    return { created: created, users: listUsersPublic_() };
  });
}

/**
 * تجهيز أول مدير — بتشغّلها مرة واحدة من المحرر (Run ▸ setupUsers).
 * بترفض تشتغل لو فيه مدير نشط بالفعل، وبترفض لو الباسورد فاضي.
 */
function setupUsers() {
  var sh = getUsersSheet_(true), have = {}, made = [];
  readUsers_().forEach(function (u) { have[keyOf_(u.username)] = 1; });
  var stamp = Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyy-MM-dd h:mm:ss a');
  SEED_USERS.forEach(function (u) {
    if (have[keyOf_(u.username)]) return;
    var pass = String(u.password || '');
    if (pass.length < 6) throw new Error('باسورد "' + u.username + '" لازم يكون 6 حروف/أرقام على الأقل.');
    var salt = Utilities.getUuid();
    sh.appendRow([u.username, u.role, u.branch, salt, hashPass_(salt, pass), true, stamp]);
    made.push(u.username);
  });
  usersCacheClear_();
  var msg = made.length ? 'تم إنشاء: ' + made.join(', ') + '. امسح الباسوردات من SEED_USERS دلوقتي.' : 'كل اليوزرات موجودة بالفعل — مفيش حاجة اتغيرت.';
  Logger.log(msg + ' | الشيت: ' + SpreadsheetApp.getActiveSpreadsheet().getName());
  return msg;
}
