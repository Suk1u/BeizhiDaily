// beizhi (New API) 每日签到脚本 for Surge
// 站点：https://beizhi.sylu.cc
// 功能：
//   1) Cookie 捕获：登录后访问站点任意账户页/接口，自动保存 Cookie + 用户 ID 到本地（支持多账号，默认 2 个）
//   2) 每日定时签到：检查今日是否已签到，未签到则签到，并读取当前额度（quota/used_quota）
//   3) 通知：捕获到 Cookie、签到成功/已签到/失败 均推送通知，通知带站点图标（图片内容）
//
// 可选 argument（模块“编辑参数”可注入）：
//   notify=true&cookieNotify=true&policy=DIRECT
//   notify      : true/false 控制每日任务与异常通知
//   cookieNotify: true/false 控制 Cookie 获取通知（失败通知始终保留）
//   policy      : Surge 请求策略，默认 DIRECT；如需代理改策略组名
//
// 存储键（local $persistentStore）：
//   beizhi.accounts  -> JSON 数组：[{origin, uid, username, cookie, userAgent, capturedAt, updatedAt}]
//   beizhi.ua        -> 默认 User-Agent

const SITE = 'https://beizhi.sylu.cc';
const STORE_ACCOUNTS = 'beizhi.accounts';
const STORE_UA = 'beizhi.ua';
// 通知配图：站点图标。可在“编辑参数”或下方直接替换为用户头像 URL。
const IMG_URL = 'https://beizhi.sylu.cc/logo.png';

const DEFAULT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function log(msg) {
  console.log('[beizhi-checkin] ' + msg);
}

// ---------- argument ----------
function readArgs() {
  const raw = typeof $argument === 'string' ? $argument.trim() : '';
  const def = { notify: true, cookieNotify: true, policy: 'DIRECT' };
  if (!raw) return def;
  try {
    if (raw[0] === '{') return Object.assign(def, JSON.parse(raw));
    raw.split('&').forEach((part) => {
      if (!part) return;
      const i = part.indexOf('=');
      const k = decodeURIComponent(i >= 0 ? part.slice(0, i) : part);
      const v = decodeURIComponent(i >= 0 ? part.slice(i + 1) : 'true');
      if (k === 'notify') def.notify = !/^(0|false|no|off)$/i.test(v);
      else if (k === 'cookieNotify') def.cookieNotify = !/^(0|false|no|off)$/i.test(v);
      else if (k === 'policy') def.policy = v;
    });
  } catch (e) {
    log('argument 解析失败，用默认值：' + e.message);
  }
  return def;
}

function postNotify(title, subtitle, body, withImage) {
  const args = readArgs();
  if (!args.notify) return;
  const opts = { 'auto-dismiss': true };
  if (withImage) opts['media-url'] = IMG_URL;
  $notification.post(title, subtitle || '', body || '', opts);
}

function postCookieNotify(title, subtitle, body, withImage) {
  const args = readArgs();
  if (!args.notify || !args.cookieNotify) return;
  const opts = { 'auto-dismiss': true };
  if (withImage) opts['media-url'] = IMG_URL;
  $notification.post(title, subtitle || '', body || '', opts);
}

// ---------- store helpers ----------
function loadAccounts() {
  const raw = $persistentStore.read(STORE_ACCOUNTS);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((a) => a && a.origin && a.uid && a.cookie) : [];
  } catch (_) {
    return [];
  }
}

function saveAccounts(arr) {
  arr.sort((a, b) => (a.origin + '/' + a.uid).localeCompare(b.origin + '/' + b.uid));
  $persistentStore.write(JSON.stringify(arr), STORE_ACCOUNTS);
}

function accountKey(a) {
  return a.origin + '#' + a.uid;
}

function upsertAccount(arr, acc) {
  const key = accountKey(acc);
  const existing = arr.find((x) => accountKey(x) === key);
  const merged = Object.assign({}, existing || {}, acc);
  if (existing) {
    merged.capturedAt = existing.capturedAt || acc.capturedAt;
  }
  merged.updatedAt = new Date().toISOString();
  const next = arr.filter((x) => accountKey(x) !== key);
  next.push(merged);
  const oldCookie = existing ? existing.cookie : '';
  const oldUa = existing ? existing.userAgent : '';
  const changed = oldCookie !== merged.cookie || oldUa !== merged.userAgent;
  return { accounts: next, account: merged, changed, isNew: !existing };
}

// ---------- http ----------
function request(method, url, headers, body) {
  return new Promise((resolve, reject) => {
    const opts = { url: url, headers: headers, timeout: 20, 'auto-cookie': false, 'auto-redirect': true };
    if (body !== undefined) opts.body = body;
    const fn = method.toLowerCase() === 'post' ? $httpClient.post : $httpClient.get;
    fn(opts, (err, resp, data) => {
      if (err) return reject(err);
      let json = null;
      try { json = JSON.parse(data || '{}'); } catch (_) { json = null; }
      resolve({ status: resp ? resp.status : 0, headers: resp ? resp.headers : {}, json: json, raw: data });
    });
  });
}

function reqHeaders(account, extra) {
  const h = {
    Accept: 'application/json',
    'User-Agent': account.userAgent || $persistentStore.read(STORE_UA) || DEFAULT_UA,
    Cookie: account.cookie,
    'New-Api-User': String(account.uid),
  };
  if (extra) Object.assign(h, extra);
  return h;
}

function getHeader(headers, name) {
  if (!headers) return '';
  const t = String(name).toLowerCase();
  for (const k in headers) if (String(k).toLowerCase() === t) return String(headers[k]);
  return '';
}

function getCookieValue(cookie, name) {
  const prefix = name + '=';
  const parts = String(cookie || '').split(';');
  for (const p of parts) {
    const t = p.trim();
    if (t.indexOf(prefix) === 0) return t.slice(prefix.length);
  }
  return '';
}

// ---------- Cookie 捕获（http-request） ----------
function captureCookie() {
  const reqHeadersMap = $request.headers || {};
  const cookie = getHeader(reqHeadersMap, 'Cookie');
  const origin = (function () {
    const m = String($request.url || '').match(/^(https?:\/\/[^/]+)/i);
    return m ? m[1].replace(/\/$/, '') : SITE;
  })();
  if (!cookie) {
    // 无 Cookie 的请求（如未登录态）直接放行，不做处理
    $done({});
    return;
  }
  const ua = getHeader(reqHeadersMap, 'User-Agent') || '';
  const headerUid = getHeader(reqHeadersMap, 'New-Api-User');

  const tmp = { origin: origin, uid: headerUid || '', cookie: cookie, userAgent: ua, capturedAt: new Date().toISOString() };

  const finish = (account, changed, isNew) => {
    const arr = loadAccounts();
    const res = upsertAccount(arr, account);
    saveAccounts(res.accounts);
    const msg =
      'Cookie 已保存' + (isNew ? '（新账号）' : changed ? '（已更新）' : '（未变化）') +
      '，长度 ' + account.cookie.length + '，uid=' + account.uid;
    log(msg);
    postCookieNotify('Beizhi Cookie 获取成功', account.username ? account.username : (isNew ? '新账号' : '账号更新'), msg, true);
    $done({});
  };

  // 用 Cookie 拉取 /api/user/self 验证登录态并获取 uid 与 username。
  // 该站点以 access-token cookie 鉴权（401 invalid access token），故不强制 session=。
  request('GET', origin + '/api/user/self', { Accept: 'application/json', Cookie: cookie, 'User-Api-User': '', 'User-Agent': ua || DEFAULT_UA }, undefined)
    .then((r) => {
      const d = (r.json && r.json.data) || {};
      const uid = String(headerUid || d.id || getCookieValue(cookie, 'user_id') || '');
      if (!uid) {
        const msg = '已捕获 Cookie，但 /self 返回未登录，请确认登录态有效（Cookie 可能过期）。';
        log(msg);
        postCookieNotify('Beizhi Cookie 获取失败', '解析用户 ID 失败', msg, true);
        $done({});
        return;
      }
      const account = Object.assign({}, tmp, {
        uid: uid,
        username: d.username || d.display_name || String(d.id || uid),
      });
      const arr = loadAccounts();
      const res = upsertAccount(arr, account);
      finish(res.account, res.changed, res.isNew);
    })
    .catch((err) => {
      const msg = '已捕获 Cookie，但请求 /self 失败：' + String(err);
      log(msg);
      postCookieNotify('Beizhi Cookie 获取失败', '验证登录态失败', msg, true);
      $done({});
    });
}

// ---------- 每日签到（cron） ----------
async function runDaily() {
  const args = readArgs();
  const accounts = loadAccounts();
  if (!accounts.length) {
    const msg = '尚未保存任何账号 Cookie：请先登录 beizhi.sylu.cc，并在 Surge 开启本模块后访问一次账户页完成 Cookie 捕获。';
    log(msg);
    postNotify('Beizhi 每日签到失败', '缺少 Cookie', msg, true);
    $done();
    return;
  }

  const month = (function () {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  })();

  const results = [];
  // 对所有已保存账号执行（默认 2 个，可扩展更多）

  for (const acc of accounts) {
    try {
      const selfR = await request('GET', acc.origin + '/api/user/self', reqHeaders(acc), undefined);
      const selfData = (selfR.json && selfR.json.data) || {};

      // 检查今日是否已签到
      const statusR = await request('GET', acc.origin + '/api/user/checkin?month=' + month, reqHeaders(acc), undefined);
      const stats = (statusR.json && statusR.json.data && statusR.json.data.stats) || {};
      const checkedInToday = stats.checked_in_today === true;

      const quota = typeof selfData.quota === 'number' ? selfData.quota : (selfData.quota != null ? Number(selfData.quota) : null);
      const used = typeof selfData.used_quota === 'number' ? selfData.used_quota : (selfData.used_quota != null ? Number(selfData.used_quota) : null);
      const remain = quota != null && used != null ? quota - used : null;
      const quotaText =
        '当前额度 ' + (remain != null ? remain : quota != null ? quota : '未知') +
        (quota != null && used != null ? '（总额 ' + quota + '，已用 ' + used + '）' : '');

      let status, title, subtitle, body;
      if (checkedInToday) {
        status = 'already';
        title = 'Beizhi 每日签到';
        subtitle = (acc.username || ('uid ' + acc.uid)) + ' · 今日已签到';
        body = '已经签到，' + quotaText + '。';
      } else {
        const ckR = await request('POST', acc.origin + '/api/user/checkin', reqHeaders(acc), '');
        if (ckR.json && ckR.json.success === true) {
          status = 'success';
          const awarded = ckR.json.data && ckR.json.data.quota_awarded;
          title = 'Beizhi 每日签到';
          subtitle = (acc.username || ('uid ' + acc.uid)) + ' · 签到成功';
          body = '签到成功，' + quotaText + (awarded != null ? '，本次获得额度 ' + awarded : '') + '。';
        } else {
          const msg = (ckR.json && ckR.json.message) || ('HTTP ' + ckR.status);
          // 服务端也可能在已签到时返回成功=false 但提示已签到
          if (/今日已签到|already/i.test(msg)) {
            status = 'already';
            title = 'Beizhi 每日签到';
            subtitle = (acc.username || ('uid ' + acc.uid)) + ' · 今日已签到';
            body = '已经签到，' + quotaText + '。';
          } else {
            status = 'failed';
            title = 'Beizhi 每日签到失败';
            subtitle = (acc.username || ('uid ' + acc.uid)) + ' · 签到失败';
            body = '签到失败：' + msg + '。';
          }
        }
      }

      if (status === 'failed') {
        // 失败通知始终发送（不受 notify 开关影响，确保感知异常）
        $notification.post(title, subtitle, body, { 'auto-dismiss': true, 'media-url': IMG_URL });
      } else {
        postNotify(title, subtitle, body, true);
      }
      results.push({ account: acc, status: status });
      log('账号 ' + (acc.username || acc.uid) + ' -> ' + status);
    } catch (e) {
      const msg = String(e && e.message ? e.message : e);
      const title = 'Beizhi 每日签到失败';
      const subtitle = (acc.username || ('uid ' + acc.uid)) + ' · 请求异常';
      const body = '签到失败：' + msg;
      log(body);
      $notification.post(title, subtitle, body, { 'auto-dismiss': true, 'media-url': IMG_URL });
      results.push({ account: acc, status: 'failed' });
    }
  }

  const ok = results.filter((r) => r.status !== 'failed').length;
  const fail = results.length - ok;
  log('完成：成功 ' + ok + '，失败 ' + fail);
  $done();
}

// ---------- 入口 ----------
if (typeof $request !== 'undefined' && $script && $script.type === 'http-request') {
  captureCookie();
} else {
  runDaily();
}
