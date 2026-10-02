/**
 * 北栀 / Liminality（beizhi.dedyn.io）每日签到 —— Surge 原生模块
 * ---------------------------------------------------------------------------
 * 一个脚本同时承担三种角色，靠 $script.type 分流：
 *   http-response 自动捕获 Web 端登录凭据（= 面板访问令牌 + 设置面版令牌）
 *   cron          每日签到 + 余额核对，并把「签到获得」算成精确的余额差值
 *   generic       [Panel] 信息面板：余额、今日签到获得、累计获得、连续天数
 *
 * 站点内核：New API v0.9.x（Liminality 定制版），接口契约来自源码核对：
 *   POST /api/user/login            登录，body {username, password}
 *                                   → data.access_token（= 面板访问令牌，用于 Authorization）
 *                                   → data.user.access_token（= 设置面版令牌，传给 New-Api-User）
 *   POST /api/user/checkin?turnstile=<token>   签到（route 挂了 TurnstileCheck 中间件）
 *                                   → data.quota_awarded（本次获得额度）
 *   GET  /api/user/checkin?month=YYYY-MM       本月签到统计（days / total_quota / records）
 *   GET  /api/user/self                        账户余额（quota / used_quota / ...）
 *
 * 鉴权：Authorization: Bearer <面板访问令牌> + New-Api-User: <设置面版令牌>
 * 注意：这个定制版把 dashboard 鉴权换成了自研 access_token / login session，
 *       cookie 会话不再是稳定契约 —— 所以本脚本走 access_token，不做 cookie 解析。
 *
 * Turnstile：站点 turnstile_check=true，登录与签到都强制校验，token 在 **query 参数 turnstile**。
 *       纯 HTTP 无法生成有效 token，本脚本因此：
 *         · 先用「面板访问令牌」直接调接口（多数站点 checkin 不需要 Turnstile，只有 login 需要）；
 *         · 若被 Turnstile 拦下，再提示去 Web 端完成一次验证以刷新凭据。
 *       如果站点连签到也要 Turnstile，Surge 侧无法无人值守完成 —— 见 README 的说明。
 * ---------------------------------------------------------------------------
 * 配置优先级：模块参数（$argument） > 持久化存储 > 文件内 DEFAULT_CONFIG
 * 持久化键：beizhi.token / beizhi.userid / beizhi.ledger / beizhi.cookie
 */

"use strict";

/* ============================ 默认配置 ============================ */

var DEFAULT_CONFIG = {
  baseUrl: "https://beizhi.dedyn.io",
  policy: "",
  timeoutSeconds: 20,
  notify: true,
  lowBalance: 0,
  currencySymbol: "",
  quotaPerUnit: 0,
  fillMissingDays: false,
  ledgerKeep: 400
};

var STORE_KEY = {
  token: "beizhi.token",
  userId: "beizhi.userid",
  ledger: "beizhi.ledger",
  cookie: "beizhi.cookie"
};

var QUOTA_PER_UNIT_FALLBACK = 500000;

/* ============================ 运行时状态 ============================ */

var FP = "[北栀签到]";
var finished = false;
var notifyEnabled = true;

/* ============================ 基础工具 ============================ */

function finish() {
  if (finished) return;
  finished = true;
  if (typeof $done === "function") $done();
}

function pad2(n) { return n < 10 ? "0" + n : "" + n; }

function formatTime(date) {
  var d = date || new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + " " +
    pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function log(message) {
  try {
    console.log(FP + " [" + formatTime() + "] " + message);
  } catch (e) { /* ignore */ }
}

function errText(err) {
  if (err && typeof err === "object") {
    return String(err.message || err.error || err.errMsg || JSON.stringify(err));
  }
  return String(err === null || err === undefined ? "未知错误" : err);
}

function trim(value) {
  if (typeof value === "string") return value.trim();
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  var n = Number(value);
  return isFinite(n) ? n : null;
}

function clampInt(value, fallback, min, max) {
  var n = parseInt(value, 10);
  if (!isFinite(n)) return fallback;
  if (min !== undefined && n < min) return min;
  if (max !== undefined && n > max) return max;
  return n;
}

function parseBool(value, fallback) {
  if (typeof value === "boolean") return value;
  var s = trim(value).toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return fallback;
}

/** Surge 模块参数不允许留空，所以用「未配置」之类占位值表示未设置。 */
var PLACEHOLDER_VALUES = [
  "未配置", "未设置", "未填写", "请填写", "无", "空",
  "none", "null", "nil", "n/a", "-", "—", "?", "0"
];

function isPlaceholder(value) {
  var s = trim(value);
  if (!s) return true;
  if (s.indexOf("{{{") >= 0 || s.indexOf("}}}") >= 0) return true;
  return PLACEHOLDER_VALUES.indexOf(s.toLowerCase()) >= 0;
}

/**
 * 行键开关：把参数放在行键位置（如 `{{{CAPTURE}}}`）时，值填 `#` 会让整行变成注释。
 * 注释掉的行根本不会运行，脚本只能看到「参数不在 $argument 里」这个事实。
 * 因此调用方必须区分「参数缺失 = 行被注释」与「参数存在但值异常」。
 */
function isDisabledValue(value) {
  var s = trim(value).toLowerCase();
  return s === "#" || s === "false" || s === "0" || s === "off" || s === "no";
}

/**
 * 解析一个「可整行关闭」的参数：
 *   参数不存在（行被 # 注释）→ false
 *   值显式写成 false/0/off    → false
 *   其余（true / 1 / 未配置等）→ true，默认保持开启
 * 只有 CAPTURE 这类行键参数走这个逻辑，普通开关请用 parseBool。
 */
function lineKeyEnabled(args, key) {
  if (args[key] === undefined) return false;
  return !isDisabledValue(args[key]);
}

function postNotify(title, body, subtitle) {
  if (!notifyEnabled) {
    log("[通知已关闭] " + title + " | " + (body || ""));
    return;
  }
  try {
    if (typeof $notification !== "undefined" && $notification &&
        typeof $notification.post === "function") {
      $notification.post(FP + title, subtitle || "", body || "");
    } else {
      log("[通知] " + title + " | " + (body || ""));
    }
  } catch (e) {
    log("通知发送失败（不影响签到）: " + errText(e));
  }
}

/* ============================ 持久化 ============================ */

function storeRead(key) {
  try {
    if (typeof $persistentStore !== "undefined" && $persistentStore &&
        typeof $persistentStore.read === "function") {
      var v = $persistentStore.read(key);
      return v === null || v === undefined ? "" : String(v);
    }
    if (typeof $prefs !== "undefined" && $prefs && typeof $prefs.valueForKey === "function") {
      var v2 = $prefs.valueForKey(key);
      return v2 === null || v2 === undefined ? "" : String(v2);
    }
  } catch (e) {
    log("读取持久化失败 [" + key + "]: " + errText(e));
  }
  return "";
}

function storeWrite(key, value) {
  try {
    if (typeof $persistentStore !== "undefined" && $persistentStore &&
        typeof $persistentStore.write === "function") {
      if (value === null) { $persistentStore.write(null, key); return true; }
      $persistentStore.write(String(value), key);
      return true;
    }
    if (typeof $prefs !== "undefined" && $prefs && typeof $prefs.setValueForKey === "function") {
      $prefs.setValueForKey(String(value), key);
      return true;
    }
  } catch (e) {
    log("写入持久化失败 [" + key + "]: " + errText(e));
  }
  return false;
}

function readJsonStore(key, fallback) {
  var raw = storeRead(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw);
  } catch (e) {
    log("持久化 JSON 解析失败 [" + key + "]: " + errText(e));
    return fallback;
  }
}

/* ============================ 参数解析 ============================ */

/** Surge 模块 argument："a=b&c=d"，值做百分号解码。 */
function parseArguments(raw) {
  var out = {};
  if (!raw || typeof raw !== "string") return out;
  raw.split("&").forEach(function (pair) {
    if (!pair) return;
    var idx = pair.indexOf("=");
    var key = trim(idx < 0 ? pair : pair.slice(0, idx));
    if (!key) return;
    var value = idx < 0 ? "" : pair.slice(idx + 1);
    try {
      value = decodeURIComponent(value.replace(/\+/g, "%20"));
    } catch (e) { /* 保留原值 */ }
    out[key] = value;
  });
  return out;
}

function resolveConfig() {
  var args = parseArguments(typeof $argument === "string" ? $argument : "");

  function argValue(key) {
    if (args[key] === undefined) return "";
    if (isPlaceholder(args[key])) return "";
    return trim(args[key]);
  }

  var baseUrl = (argValue("baseUrl") ||
    storeRead("beizhi.baseUrl") ||
    DEFAULT_CONFIG.baseUrl).replace(/\/+$/, "");
  if (baseUrl && !/^https?:\/\//i.test(baseUrl)) baseUrl = "https://" + baseUrl;

  var timeout = clampInt(argValue("timeout"), DEFAULT_CONFIG.timeoutSeconds, 5, 300);

  return {
    baseUrl: baseUrl,
    token: argValue("token") || storeRead(STORE_KEY.token),
    userId: argValue("userId") || storeRead(STORE_KEY.userId),
    cookie: argValue("cookie") || storeRead(STORE_KEY.cookie),
    policy: argValue("policy") || DEFAULT_CONFIG.policy,
    timeoutSeconds: timeout,
    notify: parseBool(argValue("notify"), DEFAULT_CONFIG.notify),
    // 行键参数：只有真正没传（行被 # 注释）或显式关掉时才为 false
    captureEnabled: lineKeyEnabled(args, "captureEnabled"),
    lowBalance: finiteNumber(argValue("lowBalance")) || DEFAULT_CONFIG.lowBalance,
    fillMissingDays: parseBool(argValue("fillMissingDays"), DEFAULT_CONFIG.fillMissingDays),
    ledgerKeep: clampInt(argValue("ledgerKeep"), DEFAULT_CONFIG.ledgerKeep, 30, 2000),
    // 运行期从 /api/status 刷新，模块参数只作兜底
    currencySymbol: DEFAULT_CONFIG.currencySymbol,
    quotaPerUnit: DEFAULT_CONFIG.quotaPerUnit
  };
}

/* ============================ HTTP（Surge $httpClient） ============================ */

function headerValues(headers, name) {
  var target = String(name).toLowerCase();
  var out = [];
  if (!headers) return out;

  if (Array.isArray(headers)) {
    headers.forEach(function (item) {
      if (!item || String(item.field || "").toLowerCase() !== target) return;
      if (Array.isArray(item.value)) {
        for (var i = 0; i < item.value.length; i++) out.push(item.value[i]);
      } else if (item.value !== undefined && item.value !== null) {
        out.push(item.value);
      }
    });
    return out;
  }

  Object.keys(headers).forEach(function (key) {
    if (key.toLowerCase() !== target) return;
    var value = headers[key];
    if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) out.push(value[i]);
    } else if (value !== undefined && value !== null) {
      out.push(value);
    }
  });
  return out;
}

function getHeader(headers, name) {
  var values = headerValues(headers, name);
  return values.length ? String(values[0]) : "";
}

function httpRequest(options, cfg) {
  return new Promise(function (resolve, reject) {
    if (typeof $httpClient === "undefined" || !$httpClient) {
      reject(new Error("当前环境不支持 $httpClient，请在 Surge 中运行本脚本"));
      return;
    }
    var method = String(options.method || "GET").toLowerCase();
    var fn = $httpClient[method];
    if (typeof fn !== "function") {
      reject(new Error("当前环境不支持 HTTP 方法: " + method.toUpperCase()));
      return;
    }

    var opts = {
      url: options.url,
      headers: options.headers || {},
      timeout: cfg.timeoutSeconds,
      "auto-redirect": true,
      "auto-cookie": false
    };
    if (options.body !== undefined && options.body !== null) opts.body = options.body;
    if (cfg.policy) opts.policy = cfg.policy;

    var settled = false;
    var guard = setTimeout(function () {
      if (settled) return;
      settled = true;
      reject(new Error("请求超时（" + cfg.timeoutSeconds + " 秒）"));
    }, (cfg.timeoutSeconds + 5) * 1000);

    try {
      fn.call($httpClient, opts, function (error, response, data) {
        if (settled) return;
        settled = true;
        clearTimeout(guard);
        if (error) {
          reject(new Error(errText(error)));
          return;
        }
        resolve({
          status: Number((response && (response.status || response.statusCode)) || 0),
          headers: (response && response.headers) || {},
          body: typeof data === "string" ? data :
            (data === undefined || data === null ? "" : String(data))
        });
      });
    } catch (e) {
      if (!settled) {
        settled = true;
        clearTimeout(guard);
        reject(new Error(errText(e)));
      }
    }
  });
}

function apiHeaders(cfg) {
  var headers = {
    "Accept": "application/json, text/plain, */*",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36",
    "Authorization": "Bearer " + cfg.token
  };
  if (cfg.userId) headers["New-Api-User"] = String(cfg.userId);
  if (cfg.cookie) headers["Cookie"] = cfg.cookie;
  return headers;
}


/** 解析 JSON；HTML / WAF / 401 给出可读原因。 */
function parseApi(res, label) {
  var ct = getHeader(res.headers, "content-type").toLowerCase();
  if (ct.indexOf("text/html") >= 0) {
    throw new Error(label + "返回 HTML（HTTP " + res.status + "），可能被 WAF 拦截或地址已变");
  }
  var payload;
  try {
    payload = JSON.parse(res.body);
  } catch (e) {
    throw new Error(label + "返回非 JSON（HTTP " + res.status + "）");
  }
  if (payload && payload.code === "AUTH_UNAUTHORIZED") {
    var err = new Error("凭据失效（AUTH_UNAUTHORIZED）：面板访问令牌 / 用户 ID 不正确或已过期");
    err.authFailed = true;
    err.label = label;
    err.raw = res;
    throw err;
  }
  if (payload && payload.code === "AUTH_SESSION_REQUIRED") {
    var err2 = new Error("该接口要求登录会话（AUTH_SESSION_REQUIRED），面板访问令牌权限不足");
    err2.authFailed = true;
    throw err2;
  }
  if (res.status === 401 || res.status === 403) {
    var err3 = new Error(label + "返回 HTTP " + res.status + "，凭据无效或权限不足");
    err3.authFailed = true;
    throw err3;
  }
  return payload;
}

function apiUrl(cfg, path, query) {
  var url = cfg.baseUrl + path;
  var parts = [];
  Object.keys(query || {}).forEach(function (k) {
    if (query[k] === undefined || query[k] === null || query[k] === "") return;
    parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(query[k])));
  });
  return parts.length ? url + "?" + parts.join("&") : url;
}

/* ============================ 额度换算 ============================ */

function makeUnits(ctx) {
  var perUnit = ctx.quotaPerUnit > 0 ? ctx.quotaPerUnit : QUOTA_PER_UNIT_FALLBACK;
  var symbol = ctx.currencySymbol || "$";
  return {
    // 额度原始值 → 展示金额
    amount: function (quota) {
      var n = finiteNumber(quota);
      if (n === null) return null;
      return Math.round((n / perUnit) * 10000) / 10000;
    },
    // 展示金额 → 原始额度
    quota: function (amount) {
      var n = finiteNumber(amount);
      if (n === null) return null;
      return n * perUnit;
    },
    text: function (quota) {
      var n = finiteNumber(quota);
      if (n === null) return "未知";
      var a = n / perUnit;
      var digits = Math.abs(a) >= 1 ? 2 : 4;
      return symbol + a.toFixed(digits);
    },
    symbol: symbol
  };
}

/* ============================ 签到账本 ============================ */

function todayKey(d) {
  d = d || new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function loadLedger() {
  var ledger = readJsonStore(STORE_KEY.ledger, null);
  if (!ledger || typeof ledger !== "object") ledger = {};
  if (!Array.isArray(ledger.days)) ledger.days = [];
  if (typeof ledger.checkins !== "number") ledger.checkins = 0;
  if (typeof ledger.totalGain !== "number") ledger.totalGain = 0;
  if (typeof ledger.lastCheckin !== "string") ledger.lastCheckin = "";
  return ledger;
}

function saveLedger(ledger) {
  if (ledger.days.length > DEFAULT_CONFIG.ledgerKeep) {
    ledger.days = ledger.days.slice(-DEFAULT_CONFIG.ledgerKeep);
  }
  storeWrite(STORE_KEY.ledger, JSON.stringify(ledger));
}

function findDay(ledger, key) {
  for (var i = ledger.days.length - 1; i >= 0; i--) {
    if (ledger.days[i] && ledger.days[i].date === key) return ledger.days[i];
  }
  return null;
}

function upsertDay(ledger, entry) {
  var existing = findDay(ledger, entry.date);
  if (existing) {
    Object.keys(entry).forEach(function (k) {
      if (entry[k] !== null && entry[k] !== undefined) existing[k] = entry[k];
    });
    return existing;
  }
  ledger.days.push(entry);
  ledger.days.sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });
  return entry;
}

/** 连续签到天数：从今天（或昨天）往回数。 */
function streakFromLedger(ledger) {
  var has = {};
  ledger.days.forEach(function (d) {
    if (d && d.date && d.checkedIn) has[d.date] = true;
  });
  var cursor = new Date();
  if (!has[todayKey(cursor)]) cursor.setDate(cursor.getDate() - 1);
  var count = 0;
  while (has[todayKey(cursor)]) {
    count++;
    cursor.setDate(cursor.getDate() - 1);
    if (count > 3650) break;
  }
  return count;
}

/* ============================ 提示词 ============================ */

function tokenHint() {
  return "【如何获取凭据】\n" +
    "① 手机浏览器打开 " + "https://beizhi.dedyn.io" + " 并登录（保持 Surge 开启、模块已启用）；\n" +
    "② 登录成功后脚本会自动抓取，回到 Surge 面板点刷新即可；\n" +
    "③ 或手动填：网页「个人设置」→ 生成「面板访问令牌」，连同用户 ID 一起填进模块参数。";
}

function turnstileHint(where) {
  return where + "被 Cloudflare Turnstile 拦截（站点开启了人机验证，纯 HTTP 无法生成 token）。\n" +
    "请用手机浏览器登录一次 " + "https://beizhi.dedyn.io" + " 完成人机验证，" +
    "让本模块抓到新的凭据后再试。";
}

/* ============================ 业务：站点信息 ============================ */

async function fetchStatus(cfg) {
  var res = await httpRequest({ url: cfg.baseUrl + "/api/status", method: "GET" }, cfg);
  var payload = parseApi(res, "站点信息");
  var data = (payload && payload.data) || {};
  return {
    // 站点可以随时关掉签到；这是正常配置，不是错误
    checkinEnabled: data.checkin_enabled !== false,
    turnstile: !!data.turnstile_check,
    systemName: trim(data.system_name) || "站点",
    quotaPerUnit: finiteNumber(data.quota_per_unit) || 0,
    currencySymbol: trim(data.custom_currency_symbol) ||
      (trim(data.quota_display_type).toLowerCase() === "usd" ? "$" : "$"),
    displayInCurrency: !!data.display_in_currency
  };
}

/**
 * 解析失败时优先保留「最有信息量」的原因：
 * HTML/WAF 与 401/403 比后续的泛化文案更值得报给用户，先到先得。
 */
function recordFailure(info, label, res) {
  var ct = getHeader(res.headers, "content-type").toLowerCase();
  var detail = "";
  if (ct.indexOf("text/html") >= 0) {
    info.htmlBlocked = true;
    detail = label + " 返回 HTML（HTTP " + res.status + "），" +
      "疑似被 Cloudflare / WAF 拦截，或域名已变更";
  } else if (res.status === 401 || res.status === 403) {
    info.authFailed = true;
    detail = label + " 返回 HTTP " + res.status + "，凭据无效或权限不足";
  }
  if (detail && !info.failureDetail) info.failureDetail = detail;
  return detail;
}

/* ============================ 业务：账户与签到 ============================ */

async function fetchSelf(cfg) {
  var res = await httpRequest({
    url: apiUrl(cfg, "/api/user/self"),
    method: "GET",
    headers: apiHeaders(cfg)
  }, cfg);
  var payload = parseApi(res, "账户信息");
  if (!payload || !payload.success || !payload.data) {
    var err = new Error("账户接口未返回有效数据: " +
      trim(payload && (payload.message || payload.code) || "空响应"));
    err.label = "账户信息";
    err.raw = res;
    throw err;
  }
  return payload.data;
}

async function fetchCheckinStatus(cfg, month) {
  var res = await httpRequest({
    url: apiUrl(cfg, "/api/user/checkin", { month: month || monthKey() }),
    method: "GET",
    headers: apiHeaders(cfg)
  }, cfg);
  var payload = parseApi(res, "签到状态");
  if (!payload || !payload.success) return { available: false, stats: null };
  var data = payload.data || {};
  return {
    available: true,
    minQuota: finiteNumber(data.min_quota),
    maxQuota: finiteNumber(data.max_quota),
    stats: data.stats || null
  };
}

function monthKey(d) {
  d = d || new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1);
}

async function doCheckin(cfg) {
  var res = await httpRequest({
    url: apiUrl(cfg, "/api/user/checkin"),
    method: "POST",
    headers: (function () {
      var h = apiHeaders(cfg);
      h["Content-Type"] = "application/json";
      return h;
    })(),
    body: "{}"
  }, cfg);

  var payload = parseApi(res, "签到接口");
  var message = trim(payload && payload.message);

  if (payload && payload.success) {
    var data = payload.data || {};
    return {
      status: "success",
      awarded: finiteNumber(data.quota_awarded),
      date: trim(data.checkin_date),
      message: message || "签到成功"
    };
  }

  if (message.indexOf("Turnstile") >= 0) {
    return { status: "turnstile", message: message };
  }
  if (message.indexOf("未启用") >= 0) {
    return { status: "disabled", message: message };
  }
  if (message.indexOf("已签到") >= 0 || message.indexOf("重复") >= 0) {
    return { status: "already", message: message };
  }
  if (message.indexOf("未启用") >= 0) {
    return { status: "disabled", message: message };
  }
  return { status: "fail", message: message || "签到失败（未知原因）" };
}

/** 从签到统计里取今天是否已签到、本月获得额度、已签天数。 */
function readMonthStats(status, dayKey) {
  var stats = status && status.stats;
  if (!stats || typeof stats !== "object") {
    return { hasToday: false, monthGain: null, monthDays: null };
  }

  var records = stats.records || stats.checkins || stats.list || stats.days;
  var hasToday = false;
  var monthGain = 0;
  var monthDays = 0;
  var gainKnown = false;

  if (Array.isArray(records)) {
    records.forEach(function (item) {
      if (!item) return;
      if (typeof item === "string") {
        var key = item.slice(0, 10);
        if (/^\d{4}-\d{2}-\d{2}$/.test(key)) {
          monthDays++;
          if (key === dayKey) hasToday = true;
        }
        return;
      }
      var date = trim(item.date || item.checkin_date || item.day ||
        item.created_at || item.createdAt).slice(0, 10);
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
        monthDays++;
        if (date === dayKey) hasToday = true;
      }
      var q = finiteNumber(item.quota_awarded || item.quota || item.amount);
      if (q !== null) {
        monthGain += q;
        gainKnown = true;
      }
    });
  }

  if (typeof stats.total_quota === "number") {
    monthGain = stats.total_quota;
    gainKnown = true;
  }
  if (typeof stats.total_quota_awarded === "number") {
    monthGain = stats.total_quota_awarded;
    gainKnown = true;
  }
  if (typeof stats.days === "number") monthDays = stats.days;
  if (typeof stats.checkin_days === "number") monthDays = stats.checkin_days;
  // month 接口里常带「昨天是否签过」；若没给记录，用它兜底判断今天
  if (!records && typeof stats.checked_in_today === "boolean") hasToday = stats.checked_in_today;

  return {
    hasToday: hasToday,
    monthGain: gainKnown ? monthGain : null,
    monthDays: monthDays || null
  };
}

/* ============================ 账本更新 ============================ */

function updateLedger(ledger, info) {
  var dayKey = todayKey();
  var U = info.units;
  var before = info.beforeQuota;
  var after = info.afterQuota;
  var entry = findDay(ledger, dayKey) || { date: dayKey };
  var attribution = "无数据";

  if (typeof entry.balanceBefore !== "number" && before !== null) entry.balanceBefore = before;
  if (after !== null) entry.balanceAfter = after;

  var checkedIn = info.checkedIn;
  if (!checkedIn && entry.checkedIn) checkedIn = true;

  if (checkedIn) {
    entry.checkedIn = true;
    var gain = null;

    if (typeof info.awarded === "number" && info.awarded > 0) {
      gain = info.awarded;                       // 服务端直接给了本次获得
      attribution = "服务端上报";
    } else if (entry.balanceBefore !== null && entry.balanceBefore !== undefined &&
               typeof entry.balanceAfter === "number") {
      var diff = entry.balanceAfter - entry.balanceBefore;
      if (diff !== 0) { gain = diff; attribution = "余额差值"; }
      else { gain = 0; attribution = "余额差值(与上次相同)"; }
    } else if (typeof info.monthGain === "number" && entry.ledgerGain === undefined) {
      gain = null;
      attribution = "本月累计可查、单日缺失";
    }

    if (gain !== null) {
      entry.gain = gain;
      entry.gainSource = attribution;
      if (info.backfilledFromRecords) entry.backfilled = true;
    }
    if (entry.checkinTime === undefined) entry.checkinTime = formatTime();
  }

  // 本月累计：优先服务端，其次账本累加
  var ledgerMonthGain = 0;
  var prefix = monthKey();
  ledger.days.forEach(function (d) {
    if (d && typeof d.gain === "number" && String(d.date).indexOf(prefix) === 0) {
      ledgerMonthGain += d.gain;
    }
  });
  entry.ledgerMonthGain = ledgerMonthGain;

  upsertDay(ledger, entry);

  if (after !== null) ledger.lastBalance = after;
  if (checkedIn) {
    if (typeof entry.gain === "number") {
      var dayAlreadyCounted = findDay(ledger, dayKey) && findDay(ledger, dayKey).counted;
      if (!dayAlreadyCounted) {
        ledger.totalGain = (ledger.totalGain || 0) + entry.gain;
        ledger.checkins = (ledger.checkins || 0) + 1;
        entry.counted = true;
      }
    }
  }
  ledger.lastCheckin = entry.checkedIn ? dayKey : (ledger.lastCheckin || "");
  ledger.streak = streakFromLedger(ledger);
  ledger.updatedAt = formatTime();

  return {
    entry: entry,
    todayGain: typeof entry.gain === "number" ? entry.gain : null,
    gainSource: entry.gainSource || "无数据",
    monthGain: typeof info.monthGain === "number" ? info.monthGain : ledgerMonthGain,
    monthGainSource: typeof info.monthGain === "number" ? "服务端统计" : "账本累加",
    streak: ledger.streak,
    totalGain: ledger.totalGain || 0,
    checkins: ledger.checkins || 0
  };
}

/** 用本月签到明细补齐此前缺失的单日获得（记录里带 quota_awarded 时）。 */
function backfillMonth(ledger, status) {
  var stats = status && status.stats;
  var records = stats && (stats.records || stats.checkins || stats.list || stats.days);
  if (!Array.isArray(records)) return false;
  var changed = false;

  records.forEach(function (item) {
    if (!item || typeof item !== "object") return;
    var date = trim(item.date || item.checkin_date || item.day ||
      item.created_at || item.createdAt).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    var q = finiteNumber(item.quota_awarded || item.quota || item.amount);
    if (q === null) return;
    var day = findDay(ledger, date);
    if (day && day.checkedIn && typeof day.gain === "number" &&
        day.gainSource === "余额差值") {
      return;
    }
    if (!day) {
      day = upsertDay(ledger, { date: date, checkedIn: true, checkinTime: date + " 00:00:00" });
    }
    if (day.gain === q) return;
    if (typeof day.gain === "number" && day.counted) {
      ledger.totalGain = (ledger.totalGain || 0) - day.gain + q;
      day.gain = q;
    } else {
      day.gain = q;
    }
    day.checkedIn = true;
    day.gainSource = "签到明细回填";
    day.backfilled = true;
    changed = true;
  });

  return changed;
}

/* ============================ 结算视图 ============================ */

function buildPanel(info) {
  var U = info.units;
  var lineBalance = "余额 " + U.text(info.afterQuota);
  var lineGain = "今日签到获得 " + (info.todayGain === null ? "—" : U.text(info.todayGain));
  var lineMonth = "本月累计 " + (info.monthGain === null ? "—" : U.text(info.monthGain));
  var lineStreak = "连续 " + (info.streak || 0) + " 天";

  var status;
  if (info.status === "fail") status = "❌ 签到失败";
  else if (info.status === "already") status = "🟡 今日已签到";
  else if (info.status === "turnstile") status = "🛡 需人机验证";
  else if (info.status === "no-credential") status = "🔑 待登录抓取";
  else status = "✅ 签到成功";

  return {
    title: info.systemName + " 签到",
    content: status + "\n" + lineBalance + "\n" + lineGain + "\n" +
      lineMonth + "｜" + lineStreak,
    lines: [status, lineBalance, lineGain, lineMonth + "｜" + lineStreak]
  };
}

function buildSummary(info) {
  var U = info.units;
  var out = [];
  out.push("状态: " + info.statusText);
  out.push("余额: " + U.text(info.afterQuota) +
    (info.beforeQuota !== null && info.afterQuota !== null &&
      info.afterQuota !== info.beforeQuota
      ? "（" + U.text(info.beforeQuota) + " → " + U.text(info.afterQuota) + "）" : ""));
  out.push("今日签到获得: " + (info.todayGain === null ? "—" : U.text(info.todayGain)) +
    (info.gainSource ? "（" + info.gainSource + "）" : ""));
  out.push("本月累计: " + (info.monthGain === null ? "—" : U.text(info.monthGain)) +
    (info.monthGainSource ? "（" + info.monthGainSource + "）" : ""));
  out.push("连续签到: " + (info.streak || 0) + " 天｜累计 " + U.text(info.totalGain));
  if (info.monthDays !== null) out.push("本月已签: " + info.monthDays + " 天");
  if (info.turnstile) out.push("⚠️ 站点开启 Turnstile 人机验证");
  if (info.warning) out.push("⚠️ " + info.warning);
  if (info.lowBalanceAlert) {
    out.push("🔔 余额低于阈值 " + U.text(U.quota(info.lowBalanceThreshold)));
  }
  return out.join("\n");
}

/* ============================ 主流程 ============================ */

async function runTask() {
  var cfg = resolveConfig();
  notifyEnabled = cfg.notify;

  var ledger = loadLedger();
  var info = {
    systemName: "北栀",
    status: "fail",
    statusText: "签到失败",
    beforeQuota: null,
    afterQuota: null,
    todayGain: null,
    gainSource: "",
    monthGain: null,
    monthGainSource: "",
    streak: 0,
    totalGain: ledger.totalGain || 0,
    monthDays: null,
    turnstile: false,
    warning: "",
    htmlBlocked: false,
    authFailed: false,
    failureDetail: "",
    lowBalanceAlert: false,
    lowBalanceThreshold: cfg.lowBalance
  };

  if (!cfg.token) {
    info.status = "no-credential";
    info.statusText = "未配置凭据";
    info.units = makeUnits(cfg);
    log("未找到面板访问令牌，跳过签到");
    postNotify("签到失败：缺少凭据",
      "未检测到面板访问令牌。\n\n" + tokenHint());
    return info;
  }

  // 1) 站点信息
  var site = null;
  try {
    site = await fetchStatus(cfg);
    cfg.quotaPerUnit = site.quotaPerUnit;
    cfg.currencySymbol = site.currencySymbol;
    info.systemName = site.systemName;
    info.turnstile = site.turnstile;
    log("站点 " + site.systemName + "｜签到 " + (site.checkinEnabled ? "开启" : "关闭") +
      "｜Turnstile " + (site.turnstile ? "开启" : "关闭") +
      "｜单位 " + site.quotaPerUnit);
  } catch (e) {
    log("读取站点信息失败（继续）: " + errText(e));
    recordFailure(info, "站点信息", { headers: {}, status: 0 });
    cfg.quotaPerUnit = DEFAULT_CONFIG.quotaPerUnit;
  }
  var U = makeUnits(cfg);
  info.units = U;

  // 站点自己关掉了签到：读一下余额让面板有数据，然后干净收尾
  if (site && site.checkinEnabled === false) {
    info.status = "disabled";
    info.statusText = "站点已关闭签到";
    try {
      var selfDisabled = await fetchSelf(cfg);
      info.beforeQuota = finiteNumber(selfDisabled.quota);
      info.afterQuota = info.beforeQuota;
      ledger.lastBalance = info.beforeQuota;
      ledger.updatedAt = formatTime();
      saveLedger(ledger);
      info.streak = streakFromLedger(ledger);
    } catch (e) {
      log("读取余额失败: " + errText(e));
    }
    log("站点未开启签到，跳过签到请求");
    postNotify(info.statusText, buildSummary(info));
    return info;
  }

  // 2) 签到前余额
  var before = null;
  var authRejected = false;
  try {
    var selfBefore = await fetchSelf(cfg);
    before = finiteNumber(selfBefore.quota);
    info.username = trim(selfBefore.username || selfBefore.display_name);
    if (!cfg.userId && selfBefore.id) {
      cfg.userId = String(selfBefore.id);
      storeWrite(STORE_KEY.userId, cfg.userId);
    }
    log("签到前余额 " + U.text(before));
  } catch (e) {
    var beforeErr = errText(e);
    authRejected = !!e.authFailed;
    if (authRejected) info.authFailed = true;
    if (e.raw) recordFailure(info, e.label || "账户信息", e.raw);
    if (!info.failureDetail) info.failureDetail = beforeErr;
    log("读取签到前余额失败: " + beforeErr);
  }
  info.beforeQuota = before;

  // 凭据被拒 + 没有任何余额数据 = 真的失效，直接收尾，不再空跑签到
  if (authRejected && before === null) {
    info.status = "no-credential";
    info.statusText = "凭据失效";
    info.warning = info.failureDetail;
    log("凭据失效，跳过签到");
    postNotify("签到失败：凭据失效",
      buildSummary(info) + "\n\n" + tokenHint());
    return info;
  }

  // 3) 签到
  var checkin = { status: "fail", message: "" };
  try {
    checkin = await doCheckin(cfg);
    log("签到接口: " + checkin.status + "｜" + checkin.message);
  } catch (e) {
    var text = errText(e);
    checkin = { status: e.authFailed ? "auth" : "fail", message: text };
    log("签到请求失败: " + text);
  }

  // 4) 签到后余额 + 本月统计
  var after = null;
  var selfAfter = null;
  try {
    selfAfter = await fetchSelf(cfg);
    after = finiteNumber(selfAfter.quota);
    log("签到后余额 " + U.text(after));
  } catch (e) {
    log("读取签到后余额失败: " + errText(e));
    if (e.raw) recordFailure(info, e.label || "账户信息", e.raw);
    if (!info.failureDetail) info.failureDetail = errText(e);
  }
  info.afterQuota = after;

  // WAF / HTML：数据全拿不到，直接给出可读结论，不再空跑
  if (before === null && after === null && info.htmlBlocked) {
    info.status = "fail";
    info.statusText = "接口被拦截";
    info.warning = info.failureDetail;
    log("接口被 WAF 拦截，提前收尾");
    postNotify("签到失败：接口被拦截",
      buildSummary(info) + "\n\n若为 Cloudflare 拦截，请检查 [MITM] 是否已加入本站域名，" +
      "或把出站策略 POLCY 改为直连/代理后重试。");
    return info;
  }

  var monthStats = { hasToday: false, monthGain: null, monthDays: null };
  var statusResp = null;
  try {
    statusResp = await fetchCheckinStatus(cfg);
    monthStats = readMonthStats(statusResp, todayKey());
    log("本月统计: 已签 " + monthStats.monthDays + " 天｜累计 " + U.text(monthStats.monthGain) +
      "｜今日已签 " + monthStats.hasToday);
  } catch (e) {
    log("读取签到统计失败: " + errText(e));
  }
  info.monthDays = monthStats.monthDays;

  // 5) 归并状态
  var checkedIn = false;
  if (checkin.status === "success" || checkin.status === "already") {
    checkedIn = true;
    info.status = checkin.status === "success" ? "success" : "already";
    info.statusText = checkin.status === "success" ? "签到成功" : "今日已签到";
    if (checkin.status === "success") {
      info.todayGain = finiteNumber(checkin.awarded);
      info.gainSource = info.todayGain !== null ? "服务端上报" : "";
      // 服务端上报与余额差值相互印证
      if (info.todayGain !== null && before !== null && after !== null) {
        var diff = after - before;
        if (diff !== info.todayGain && Math.abs(diff) > 0) {
          info.gainSource = "服务端上报（余额差 " + U.text(diff) + "）";
        }
      }
    }
  } else if (checkin.status === "disabled") {
    info.status = "disabled";
    info.statusText = "站点已关闭签到";
  } else if (checkin.status === "turnstile") {
    info.status = "turnstile";
    info.statusText = "需人机验证";
  } else if (checkin.status === "auth" || (info.authFailed && !checkedIn)) {
    info.status = "no-credential";
    info.statusText = "凭据失效";
    info.warning = checkin.message || info.failureDetail;
  } else {
    info.status = "fail";
    info.statusText = info.failureDetail ?
      ("接口异常：" + info.failureDetail) : (checkin.message || "签到失败");
  }

  // 6) 账本
  var lm = updateLedger(ledger, {
    units: U,
    beforeQuota: before,
    afterQuota: after,
    checkedIn: checkedIn,
    awarded: checkin.status === "success" ? finiteNumber(checkin.awarded) : null,
    monthGain: monthStats.monthGain
  });

  if (checkedIn && cfg.fillMissingDays && statusResp) {
    try {
      if (backfillMonth(ledger, statusResp)) {
        saveLedger(ledger);
        lm.entry = findDay(ledger, todayKey()) || lm.entry;
      }
    } catch (e) {
      log("回填失败（忽略）: " + errText(e));
    }
  }
  saveLedger(ledger);

  // 今日获得：优先服务端上报，其次账本差值
  if (info.todayGain === null && typeof lm.todayGain === "number") {
    info.todayGain = lm.todayGain;
    info.gainSource = lm.gainSource;
  }
  if (info.monthGain === null) {
    info.monthGain = lm.monthGain;
    info.monthGainSource = lm.monthGainSource;
  } else {
    info.monthGainSource = "服务端统计";
  }
  info.streak = lm.streak;
  info.totalGain = lm.totalGain;

  // 7) 低余额提醒
  if (cfg.lowBalance > 0 && after !== null) {
    var threshold = U.quota(cfg.lowBalance);
    if (after < threshold) {
      info.lowBalanceAlert = true;
      info.warning = (info.warning ? info.warning + "；" : "") +
        "余额 " + U.text(after) + " 已低于阈值 " + U.text(threshold);
    }
  }

  // 8) 通知
  var title = FP + " " + info.statusText;
  if (info.status === "success") title = FP + " 签到成功";
  else if (info.status === "already") title = FP + " 今日已签到";
  else if (info.status === "turnstile") title = FP + " 需要人机验证";
  else if (info.status === "no-credential") title = FP + " 凭据失效";
  else if (info.status === "disabled") title = FP + " 站点已关闭签到";

  var body = buildSummary(info);
  if (info.status === "turnstile") body += "\n\n" + turnstileHint("签到接口");
  else if (info.status === "no-credential") body += "\n\n" + tokenHint();
  else if (info.htmlBlocked) {
    body += "\n\n接口返回 HTML，疑似 Cloudflare / WAF 拦截。" +
      "请确认 [MITM] 已加入本站域名，或调整出站策略后重试。";
  }
  postNotify(title, body);

  return info;
}

/* ============================ http-response：抓凭据 ============================ */

function extractLogin(data) {
  if (!data || typeof data !== "object") return null;
  var out = { token: "", userId: "", username: "" };
  var user = data.user && typeof data.user === "object" ? data.user : data;

  if (trim(data.access_token)) out.token = trim(data.access_token);
  if (!out.token && trim(user.access_token)) out.token = trim(user.access_token);
  if (trim(user.access_token)) out.userId = trim(user.access_token);
  if (user.id !== undefined && user.id !== null) out.userId = String(user.id);
  if (trim(user.username)) out.username = trim(user.username);
  if (!out.token && !out.userId) return null;
  return out;
}

function storeLogin(data) {
  var extracted = extractLogin(data);
  if (!extracted) return null;

  var changed = [];
  var prevToken = storeRead(STORE_KEY.token);
  var prevUser = storeRead(STORE_KEY.userId);

  if (extracted.token && extracted.token !== prevToken) {
    storeWrite(STORE_KEY.token, extracted.token);
    changed.push("token");
  }
  if (extracted.userId && extracted.userId !== prevUser) {
    storeWrite(STORE_KEY.userId, extracted.userId);
    changed.push("userId");
  }
  if (!changed.length) return null;

  log("已捕获凭据: " + changed.join(",") + (extracted.username ? "｜用户 " + extracted.username : ""));
  return { changed: changed, username: extracted.username };
}

function captureLoginResponse(body) {
  var payload;
  try {
    payload = JSON.parse(body);
  } catch (e) {
    log("登录响应非 JSON，跳过捕获");
    return;
  }
  if (!payload || !payload.success) {
    // 登录失败（含 Turnstile 失败），提示用户
    var msg = trim(payload && payload.message) || "未知原因";
    log("登录失败，未捕获凭据: " + msg);
    if (msg.indexOf("Turnstile") >= 0) {
      postNotify("登录被人机验证拦截", msg + "\n\n请在浏览器里正常完成一次人机验证后重新登录。");
    }
    return;
  }
  var captured = storeLogin(payload.data);
  if (captured) {
    postNotify("凭据已捕获",
      "用户: " + (captured.username || "未知") + "\n" +
      "已保存: " + captured.changed.join("、") + "\n" +
      "下次定时任务即可自动签到。",
      "可在 Surge 面板查看余额");
  }
}

function onHttpResponse(cfg) {
  if (!cfg.captureEnabled) {
    log("凭据捕获已关闭（CAPTURE 行键为 # 或值为 false），跳过");
    return;
  }
  var req = typeof $request !== "undefined" ? $request : null;
  var res = typeof $response !== "undefined" ? $response : null;
  if (!req || !res) return;

  var url = String(req.url || "");
  if (url.indexOf("/api/user/login") < 0) return;

  var body = String(res.body || "");
  if (!body) {
    log("登录响应体为空（未解密）——请确认 [MITM] 已包含本站域名");
    return;
  }
  captureLoginResponse(body);
}

/* ============================ generic：信息面板 ============================ */

function onPanel(cfg) {
  var ledger = loadLedger();
  var U = makeUnits(cfg);
  var today = findDay(ledger, todayKey());
  var checkedToday = !!(today && today.checkedIn);

  if (!cfg.token) {
    return {
      title: "北栀签到",
      content: "🔑 未捕获凭据\n请先在浏览器登录一次\nbeizhi.dedyn.io",
      style: "alert",
      icon: "key",
      "icon-color": "#FF9F0A"
    };
  }

  var monthGain = 0;
  var prefix = monthKey();
  ledger.days.forEach(function (d) {
    if (d && typeof d.gain === "number" && String(d.date).indexOf(prefix) === 0) {
      monthGain += d.gain;
    }
  });

  var todayGain = today && typeof today.gain === "number" ? today.gain : null;
  var lines = [];
  lines.push(checkedToday ? "✅ 今日已签到" : "⏳ 今日未签到");
  lines.push("余额: " + U.text(ledger.lastBalance));
  lines.push("今日获得: " + (todayGain === null ? "—" : U.text(todayGain)));
  lines.push("本月获得: " + U.text(monthGain));
  lines.push("连续: " + (ledger.streak || 0) + " 天｜累计: " + U.text(ledger.totalGain || 0));
  if (ledger.updatedAt) lines.push("更新: " + ledger.updatedAt.slice(5, 16));

  return {
    title: "北栀签到",
    content: lines.join("\n"),
    style: checkedToday ? "good" : "info",
    icon: "checkmark.seal",
    "icon-color": checkedToday ? "#30D158" : "#0A84FF"
  };
}

/* ============================ 入口 ============================ */

function main() {
  var type = (typeof $script !== "undefined" && $script && $script.type) ? $script.type : "cron";
  var cfg = resolveConfig();

  if (type === "http-response") {
    try {
      onHttpResponse(cfg);
    } catch (e) {
      log("捕获流程异常: " + errText(e));
    }
    return finish();
  }

  if (type === "generic") {
    var panel;
    try {
      panel = onPanel(cfg);
    } catch (e) {
      panel = {
        title: "北栀签到",
        content: "面板渲染失败: " + errText(e),
        style: "error",
        icon: "exclamationmark.triangle",
        "icon-color": "#FF453A"
      };
    }
    if (typeof $done === "function") $done(panel);
    return;
  }

  // cron
  runTask()
    .catch(function (e) {
      var message = "脚本异常: " + errText(e);
      log(message);
      try {
        postNotify("签到失败", message);
      } catch (ignored) { /* ignore */ }
    })
    .then(finish);
}

main();
