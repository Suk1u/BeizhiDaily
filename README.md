# 北栀 Liminality 签到 · Surge 模块

`beizhi.dedyn.io` 的 Surge 每日签到模块。定时签到、记录**余额**与**签到获得**，
并把结果送进信息面板和账本。参考 [Suk1u/AgentRoute](https://github.com/Suk1u/AgentRoute) 的模块结构。

## 一键安装

**模块地址**（Surge → 首页 → 模块 → 安装新模块）：

```
https://raw.githubusercontent.com/Suk1u/BeizhiDaily/main/BeizhiCheckin.sgmodule
```

国内访问 GitHub 慢的话，把域名换成 jsDelivr：

```
https://cdn.jsdelivr.net/gh/Suk1u/BeizhiDaily@main/BeizhiCheckin.sgmodule
```

**脚本地址**（模块内部已写死，无需手动填）：

```
https://raw.githubusercontent.com/Suk1u/BeizhiDaily/main/beizhi_checkin.js
```

## 本仓库文件

| 文件 | 说明 |
|---|---|
| `beizhi_checkin.js` | **Surge 实际下载的脚本**，唯一必需文件。改完必须推到仓库根目录 |
| `BeizhiCheckin.sgmodule` | 模块本体，`script-path` 已指向本仓库的 raw 地址 |
| `src/beizhi_checkin.js` | 开发用的源文件（与根目录那份内容一致） |
| `scripts/build.js` | 构建：注入 raw URL、产出 `dist/` |
| `scripts/test-mock.js` | 20 个 mock 场景，跑脚本逻辑 |
| `scripts/test-remote.js` | **上线回归**：抓取远程 JS，校验 sha256 一致性 + 端到端行为 |
| `scripts/validate_sgmodule.py` | 模块静态校验器 |

> 改了 `src/beizhi_checkin.js` 之后：把同一份内容覆盖到仓库根目录的
> `beizhi_checkin.js`，然后 `npm run test:remote` 确认远程已同步。

## 本地开发

```bash
npm run check          # 校验模块 + 语法 + 20 个 mock 场景 + 远程上线回归

npm run test:remote    # 只跑上线回归：下载远程 JS，比对 sha256，端到端验证

npm run build          # 用 dist/ 产出（默认已指向 Suk1u/BeizhiDaily）
npm run build -- --repo <user>/<repo>   # 换仓库时重新注入 URL
```

## 安装与首次使用

1. 安装模块后，**用手机浏览器打开 `https://beizhi.dedyn.io` 并登录一次**
   （Surge 需保持开启、模块已启用、MITM 证书已信任）。
2. 登录成功后脚本会自动保存凭据并弹通知「凭据已捕获」。
3. 打开 Surge 的**面板**（策略页 → 面板 → 北栀签到面板），等待定时任务或手动运行一次。
4. 定时任务默认每天 `09:00` 执行。

抓取到的凭据存在 `$persistentStore`：`beizhi.token` / `beizhi.userid`。
不想自动抓取，就把 `CAPTURE` 的值改成 `#`，并在 `TOKEN` / `USER_ID` 里手工填
（网页「个人设置」→ 生成**面板访问令牌**，不是 `sk-` 开头的 API 令牌）。

## 参数表

| 参数 | 默认 | 说明 |
|---|---|---|
| `TIME` | `0 9 * * *` | cron 表达式，5 段 |
| `TASK_NAME` | `北栀签到` | 定时任务名；填 `#` 关闭定时签到 |
| `CAPTURE` | `北栀凭据捕获` | 抓取脚本名；填 `#` 关闭自动抓取 |
| `TOKEN` | `未配置` | 面板访问令牌；留占位则用抓取值 |
| `USER_ID` | `未配置` | 用户 ID；留占位则用抓取值 |
| `PANEL_NAME` | `北栀签到面板` | 面板名；填 `#` 关闭面板 |
| `POLICY` | `未配置` | 出站策略/策略组；留占位表示按分流规则 |
| `TIMEOUT` | `20` | 单请求超时秒数（5–300） |
| `NOTIFY` | `true` | 是否发通知 |
| `LOW_BALANCE` | `0` | 余额低于该金额额外提醒；`0` 关闭 |
| `FILL_MISSING_DAYS` | `false` | 用本月明细回填历史单日获得 |
| `MITM_HOST` | `beizhi.dedyn.io` | 需要解密的域名 |
| `BASE_URL` | `beizhi.dedyn.io` | 站点域名，只填域名 |

> 所有参数都必须有非空值，留空会让模块加载失败 —— 这是 Surge 的硬约束。
> 关闭功能请用 `#`（行键会整行注释掉），不要留空。

## 「签到获得」是怎么算出来的

按可信度从高到低：

1. **服务端上报** — `POST /api/user/checkin` 返回 `data.quota_awarded`，最准。
2. **余额差值** — 签到前后各查一次 `GET /api/user/self`，取 `quota` 之差。
   服务端没给 `quota_awarded` 时用这个，通知里会标「余额差值」。
   如果差值为 0（今天没发额度或早已签过），会标成「余额差值(与上次相同)」，不谎报。
3. **签到明细回填** — 开了 `FILL_MISSING_DAYS` 时，从 `GET /api/user/checkin?month=` 的
   `records[].quota_awarded` 补齐历史缺失的单日获得，标「签到明细回填」。
4. 都拿不到 → 显示 `—`，不猜。

账本存在 `beizhi.ledger`（JSON），字段：`days[{date, checkedIn, gain, gainSource, balanceBefore, balanceAfter}]`、
`totalGain`、`checkins`、`streak`、`lastBalance`。面板据此显示余额、今日获得、本月累计、连续天数。

## ⚠️ 关于 Cloudflare Turnstile

这个站点（内核 `New API v0.9.0-liminality`）的 `/api/status` 返回：

```json
{ "checkin_enabled": true, "turnstile_check": true,
  "turnstile_site_key": "0x4AAAAAAFLXuS7bOlCEVI9e", "quota_per_unit": 500000 }
```

`turnstile_check=true` 表示服务端在 **`/api/user/login`** 上挂了 `middleware.TurnstileCheck()`
（源码核对：从 **query 参数 `turnstile`** 取值，再调 Cloudflare `siteverify`）。
纯 HTTP 请求无法生成有效 token，所以：

- **不要尝试账号密码登录** —— 一定会被 `Turnstile token 为空` 挡掉。
- 本模块改为复用浏览器登录后拿到的 `access_token`，走 `Authorization: Bearer`，
  **不碰登录接口**，因此不受 Turnstile 影响。
- **Surge 的脚本无法自己过 Turnstile。** WebView 引擎跑在 `surge://` 来源下，
  而 Turnstile 的 sitekey 只对站点自身的域名白名单生效（未注册域名必定失败）。
  真正做过这件事的项目（Chrome 扩展）也都是**在目标站点页面内**渲染控件、让用户点一下。
- 如果将来站点把 Turnstile 也加到**签到**接口上，模块会识别出
  `Turnstile token 为空` 并给出「需要人机验证」的专门通知，同时提示去浏览器刷新凭据 ——
  这种情况**无法无人值守完成**，届时请改用浏览器扩展方案。

## 鉴权说明（源码核对结论）

该 fork 把 dashboard 鉴权换成了自研 `access_token` / login session：

```
中间件: authorizationToken(c.GetHeader("Authorization"))  →  解析 Bearer <token>
        legacy token 走 model.ValidateAccessToken(raw)
登录响应: data.access_token  →  用于 Authorization
          data.user.id       →  OK
```

因此模块使用 `Authorization: Bearer <panel access token>`，并附带 `New-Api-User`。
**没有**解析 `Set-Cookie`：这个版本的会话是服务端 session 记录而非 cookie，
cookie 不是稳定契约（仅在参数里保留 `cookie` 作为可选兜底）。

## 测试

### 上线回归 `scripts/test-remote.js`

它会**下载模块 `script-path` 实际指向的那个 JS**，然后：

1. 比对远程 sha256 与本地 `src/beizhi_checkin.js` —— 不一致就报 `OUT OF SYNC`，
   防止「本地改了没推」；
2. 在进程内做语法编译校验；
3. 用「站点开启 Turnstile + 签到返回 quota_awarded=2500」的数据跑一遍端到端，
   断言：`$done` 被调用、无运行时错误、通知里有余额与今日获得、token 没泄露、
   账本落盘且 `gain === 2500`。

当前结果：`LIVE REGRESSION PASSED`（远程与本地 sha256 一致）。

### 单元/场景测试 `scripts/test-mock.js`

用 skill 自带的 `surge_mock.js` 跑真实脚本，覆盖 20 个场景：

- 成功（服务端上报获得额 = 余额差值一致）
- 服务端不给获得额 → 走余额差值
- 今日已签到（服务端 message）
- 未配置凭据 → 零请求、给操作指引
- `AUTH_UNAUTHORIZED` → 凭据失效分支
- Turnstile 拦截 → 专门分支
- HTML/WAF → 可读错误，不空跑
- 网络错误 → 失败通知，不崩
- 站点关闭签到 → 不 POST 签到
- 请求永不回调 → 超时兜底
- 面板 3 态（已签/未签/无凭据）
- 登录响应抓取、关闭抓取、Turnstile 拦截登录、失败登录不泄露、无关 URL 无副作用
- 低余额提醒、明细回填

结果：`20/20 scenario(s) passed`。

## 注意事项

- 脚本 `script-path` 是远程 raw URL，**改本地 JS 不会影响 Surge**，必须把同一份文件
  推到该 URL（`script-update-interval=86400`，最长 24 小时生效）。
- `requires-body=true` 只加在抓凭据的 `http-response` 行上，并显式设了 `max-size=1048576`，
  避免 iOS 上缓冲大 body 把 NE 进程搞崩。
- `[MITM]` 用 `%APPEND%`，不会覆盖你的 profile 和其它模块的 hostname。
- 面板需要 iOS 订阅在 2021-09-22 之后仍有效；`update-interval=3600`。
- 模块只做服务端接口调用，不拦截其它流量。

## License

MIT
