// QwenWork Gateway — 千问办公 → OpenAI 兼容网关
// 基于 tianyn1990/qwenwork-magpie (MIT) 的 lib/ 实现，去掉 Magpie 宿主依赖，改为独立服务 + 管理后台。
import http from 'node:http'
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync } from 'node:fs'
import { randomUUID, randomBytes, createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { GATEWAY, MODELS, FALLBACK_VERSION, FALLBACK_RELEASE } from './lib/constants.mjs'
import { startLogin, pollLogin, finishLogin, getAccount, renewAuth, quotaForMagpie } from './lib/account.mjs'
import { chatResponse } from './lib/chat.mjs'
import { prepareQwenworkInfer } from './lib/wasm.mjs'
import { ProviderError, errorResponse, redact } from './lib/errors.mjs'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DATA = path.join(ROOT, 'data')
const STATE_FILE = path.join(DATA, 'state.json')
const LOG_FILE = path.join(DATA, 'logs.jsonl')
const WASM_FILE = process.env.QWENWORK_WASM_PATH || path.join(ROOT, 'qoder_auth_wasm_bg.wasm')
const PORT = Number(process.env.PORT || 4021)

// 对外只暴露一个模型名；内部映射到千问办公的「高级」档
const PUBLIC_MODELS = { 'qwen3.8max': 'qwork-advanced' }

mkdirSync(DATA, { recursive: true })

// ---------- 存储 ----------
function loadState() {
  if (!existsSync(STATE_FILE)) return { accounts: [], keys: [], settings: {} }
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    return { accounts: s.accounts ?? [], keys: s.keys ?? [], settings: s.settings ?? {} }
  } catch { return { accounts: [], keys: [], settings: {} } }
}
let state = loadState()
function saveState() {
  const tmp = STATE_FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(state, null, 2))
  writeFileSync(STATE_FILE, readFileSync(tmp))
}
function log(entry) {
  try { appendFileSync(LOG_FILE, JSON.stringify({ ts: Date.now(), ...entry }) + '\n') } catch {}
}

// ---------- 管理令牌 ----------
const ADMIN_FILE = path.join(DATA, 'admin_token.txt')
let ADMIN_TOKEN = process.env.ADMIN_TOKEN || (existsSync(ADMIN_FILE) ? readFileSync(ADMIN_FILE, 'utf8').trim() : '')
if (!ADMIN_TOKEN) {
  ADMIN_TOKEN = randomBytes(18).toString('base64url')
  writeFileSync(ADMIN_FILE, ADMIN_TOKEN, { mode: 0o600 })
}

// ---------- 签名组件 ----------
function runtimeInfo() {
  if (!existsSync(WASM_FILE)) return { ok: false, error: `未找到签名组件：${WASM_FILE}` }
  const st = statSync(WASM_FILE)
  const bytes = readFileSync(WASM_FILE)
  return {
    ok: true,
    wasmPath: WASM_FILE,
    version: process.env.QWENWORK_CLIENT_VERSION || FALLBACK_VERSION,
    releaseVersion: process.env.QWENWORK_RELEASE_VERSION || FALLBACK_RELEASE,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: st.size,
  }
}

// ---------- 工具 ----------
const json = (res, code, body) => {
  const buf = Buffer.from(JSON.stringify(body))
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' })
  res.end(buf)
}
const text = (res, code, body, type = 'text/plain; charset=utf-8') => {
  const buf = Buffer.from(body)
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': buf.length, 'Cache-Control': 'no-store' })
  res.end(buf)
}
async function readBody(req, limit = 32 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > limit) throw new ProviderError('请求体过大', 413)
    chunks.push(c)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { throw new ProviderError('请求体不是有效 JSON', 400) }
}
const publicAccount = a => ({
  id: a.id, email: a.email, name: a.name, uid: a.uid, plan: a.plan,
  organizationId: a.organizationId, status: a.status, quota: a.quota ?? null,
  createdAt: a.createdAt, lastRefresh: a.lastRefresh, accessExpires: a.accessExpires,
  refreshExpires: a.refreshExpires, hasRefresh: !!a.refresh,
})

// ---------- 账号刷新 ----------
async function refreshAccount(acc, { force = false } = {}) {
  const rt = runtimeInfo()
  if (!rt.ok) throw new ProviderError(rt.error, 503)
  const now = Date.now()
  if (acc.accessExpires && acc.accessExpires - now < 5 * 60 * 1000 && acc.refresh) {
    const next = await renewAuth(acc, rt)
    Object.assign(acc, next)
  }
  const ctx = await getAccount(acc, rt)
  const q = ctx.quota ?? {}
  acc.quota = {
    remaining: typeof q.remaining === 'number' ? q.remaining : null,
    total: typeof q.total === 'number' ? q.total : null,
    used: typeof q.used === 'number' ? q.used : null,
    exceeded: q.exceeded === true || (typeof q.remaining === 'number' && q.remaining <= 0),
  }
  acc.plan = ctx.plan?.name ?? acc.plan ?? ''
  acc.status = acc.quota.exceeded ? 'quota_exhausted' : 'ok'
  acc.lastRefresh = now
  saveState()
  return acc
}

// ---------- 授权流程（内存态） ----------
const flows = new Map()

// ---------- 令牌 ----------
function checkKey(authHeader) {
  const raw = (authHeader || '').replace(/^Bearer\s+/i, '').trim()
  if (!raw) return null
  const k = state.keys.find(x => x.key === raw)
  if (!k) return null
  if (k.disabled) return null
  k.lastUsed = Date.now()
  k.requests = (k.requests ?? 0) + 1
  return k
}

// ---------- 业务：OpenAI 端点 ----------
// ---------- 重试策略（类比 WB：换号重试 + 首字节超时 + 流式空闲超时） ----------
const MAX_RETRIES = Number(process.env.QW_MAX_RETRIES || 2)               // 首次之外的额外尝试次数
const HEADER_TIMEOUT = Number(process.env.QW_HEADER_TIMEOUT_MS || 45000)  // 首字节超时
const STREAM_IDLE = Number(process.env.QW_STREAM_IDLE_MS || 60000)        // 流式空闲超时
const sleep = ms => new Promise(r => setTimeout(r, ms))

function pickAccount(exclude = new Set()) {
  const all = state.accounts.filter(a => a.status !== 'quota_exhausted' && a.access)
  if (!all.length) return null
  // 优先选没试过的号；都试过（或只有一个号）时允许同号重试，不能直接放弃
  const fresh = all.filter(a => !exclude.has(a.id))
  const pool = fresh.length ? fresh : all
  return pool.sort((a, b) => (b.quota?.remaining ?? 0) - (a.quota?.remaining ?? 0))[0]
}

// 首字节超时：真正中断底层 fetch，而不是只在表面 reject
async function upstreamWithTimeout(body, acc, rt) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(new Error('header timeout')), HEADER_TIMEOUT)
  try {
    return await chatResponse(body, acc, rt, { signer: prepareQwenworkInfer, signal: ctrl.signal })
  } catch (e) {
    if (ctrl.signal.aborted) throw new ProviderError(`千问办公 ${Math.round(HEADER_TIMEOUT / 1000)}s 未返回首字节`, 504, 'upstream_timeout')
    throw e
  } finally { clearTimeout(timer) }
}

// 流式读一帧，带空闲超时（对应 WB 的 stream idle timeout）
async function readWithTimeout(reader) {
  let timer
  try {
    return await Promise.race([
      reader.read(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new ProviderError(`千问办公流式 ${Math.round(STREAM_IDLE / 1000)}s 无数据`, 504, 'stream_idle_timeout')), STREAM_IDLE) })
    ])
  } finally { clearTimeout(timer) }
}

// 单次尝试：拿到响应就转发；开始写字节后置标，供上层判断能否重试
async function serveOnce(res, key, body, rt, acc, publicModel, upstreamModel, started) {
  if (!acc.quota || Date.now() - (acc.lastRefresh ?? 0) > 10 * 60 * 1000) {
    await refreshAccount(acc).catch(() => {})
  }
  const upstream = await upstreamWithTimeout(body, acc, rt)
  const headers = Object.fromEntries(upstream.headers.entries())
  headers['X-Gateway-Account'] = acc.email || acc.uid
  headers['X-Gateway-Attempts'] = String(res._qwAttempts || 1)
  delete headers['content-length']
  const rename = (buf) => Buffer.from(
    buf.toString('utf8')
      .replaceAll(`"model":"${upstreamModel}"`, `"model":"${publicModel}"`)
      .replaceAll(`"model": "${upstreamModel}"`, `"model": "${publicModel}"`)
  )
  res.writeHead(upstream.status, headers)
  res._qwStarted = true
  if (upstream.body) {
    const reader = upstream.body.getReader()
    try {
      while (true) {
        const { value, done } = await readWithTimeout(reader)
        if (done) break
        res.write(rename(Buffer.from(value)))
      }
    } finally { res.end() }
  } else res.end()
  log({ type: 'chat', key: key.name, account: acc.email || acc.uid, model: publicModel, stream: !!body.stream, ms: Date.now() - started, status: upstream.status, attempts: res._qwAttempts || 1 })
}

async function handleChat(req, res, key) {
  let body = await readBody(req)
  const upstreamModel = PUBLIC_MODELS[body?.model]
  if (!upstreamModel) {
    return json(res, 400, { error: { message: `模型 ${body?.model} 不存在，可用模型：${Object.keys(PUBLIC_MODELS).join(', ')}`, type: 'invalid_request_error' } })
  }
  const publicModel = body.model
  body = { ...body, model: upstreamModel }
  const rt = runtimeInfo()
  if (!rt.ok) return json(res, 503, { error: { message: rt.error, type: 'provider_unavailable' } })

  const started = Date.now()
  const tried = new Set()
  let lastErr = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const acc = body?.accountId
      ? state.accounts.find(a => a.id === body.accountId)
      : pickAccount(tried)
    if (!acc) break
    tried.add(acc.id)
    res._qwAttempts = attempt + 1
    res._qwStarted = false
    try {
      await serveOnce(res, key, body, rt, acc, publicModel, upstreamModel, started)
      return
    } catch (error) {
      const e = error instanceof ProviderError ? error : new ProviderError(redact(error.message || '千问办公连接失败'), 503)
      lastErr = e
      // 已经向客户端吐过内容，再重试会重复输出，直接收尾
      if (res._qwStarted || res.headersSent) { res.end(); return }
      const retryable = e.status >= 500 || e.status === 429 || e.status === 401
      if (!retryable || attempt >= MAX_RETRIES) break
      log({ type: 'retry', key: key.name, account: acc.email || acc.uid, model: publicModel, attempt: attempt + 1, error: e.message })
      // 401：先续期再试；429/限流：标记该账号，下一轮换号
      if (e.status === 401) { await refreshAccount(acc, { force: true }).catch(() => {}) }
      if (e.status === 429) { acc.status = 'quota_exhausted' }
      await sleep(Math.min(2000, 500 * (attempt + 1)))
    }
  }

  const e = lastErr ?? new ProviderError('没有可用的千问办公账号，请先在后台授权', 503)
  log({ type: 'chat_error', key: key.name, model: publicModel, ms: Date.now() - started, error: e.message })
  if (!res.headersSent) {
    const r = errorResponse(e)
    json(res, e.status, await r.json())
  } else res.end()
}

// ---------- 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname
  try {
    // 管理页
    if (p === '/admin' || p === '/admin/') {
      const html = readFileSync(path.join(ROOT, 'admin.html'))
      return text(res, 200, html, 'text/html; charset=utf-8')
    }

    // 管理 API
    if (p.startsWith('/admin/api/')) {
      const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('token')
      if (token !== ADMIN_TOKEN) return json(res, 401, { error: 'unauthorized' })
      const action = p.slice('/admin/api/'.length)

      if (action === 'state' && req.method === 'GET') {
        const rt = runtimeInfo()
        return json(res, 200, {
          runtime: { ok: rt.ok, error: rt.error, version: rt.version, releaseVersion: rt.releaseVersion, sha256: rt.sha256, bytes: rt.bytes, wasmPath: rt.wasmPath },
          accounts: state.accounts.map(publicAccount),
          keys: state.keys.map(k => ({ ...k, key: k.key.slice(0, 8) + '…' + k.key.slice(-4) })),
          models: Object.entries(PUBLIC_MODELS).map(([id, upstream]) => ({ id, name: MODELS[upstream]?.name ?? id, limit: MODELS[upstream]?.limit })),
          stats: {
            accounts: state.accounts.length,
            usable: state.accounts.filter(a => a.status === 'ok').length,
            remaining: state.accounts.reduce((s, a) => s + (a.quota?.remaining ?? 0), 0),
            requests: state.keys.reduce((s, k) => s + (k.requests ?? 0), 0),
          },
        })
      }

      if (action === 'login/start' && req.method === 'POST') {
        const rt = runtimeInfo()
        if (!rt.ok) return json(res, 400, { error: rt.error })
        const flow = startLogin(rt)
        const id = randomUUID()
        flows.set(id, { flow, createdAt: Date.now() })
        return json(res, 200, { flowId: id, url: flow.url, expiresIn: 300 })
      }

      if (action === 'login/poll' && req.method === 'GET') {
        const id = url.searchParams.get('flowId')
        const item = flows.get(id)
        if (!item) return json(res, 404, { error: '授权流程不存在或已过期' })
        if (Date.now() - item.createdAt > 10 * 60 * 1000) { flows.delete(id); return json(res, 408, { error: '授权超时，请重新生成链接' }) }
        const tokens = await pollLogin(item.flow)
        if (!tokens) return json(res, 200, { status: 'pending' })
        const auth = await finishLogin(item.flow, tokens)
        flows.delete(id)
        let acc = state.accounts.find(a => a.uid === auth.uid)
        if (!acc) {
          acc = { id: randomUUID(), createdAt: Date.now() }
          state.accounts.push(acc)
        }
        Object.assign(acc, auth, { status: 'ok' })
        saveState()
        await refreshAccount(acc, { force: true }).catch(() => {})
        log({ type: 'login', account: acc.email || acc.uid })
        return json(res, 200, { status: 'ok', account: publicAccount(acc) })
      }

      if (action === 'account/refresh' && req.method === 'POST') {
        const { id } = await readBody(req)
        const acc = state.accounts.find(a => a.id === id)
        if (!acc) return json(res, 404, { error: '账号不存在' })
        await refreshAccount(acc, { force: true })
        return json(res, 200, { account: publicAccount(acc) })
      }

      if (action === 'account/delete' && req.method === 'POST') {
        const { id } = await readBody(req)
        state.accounts = state.accounts.filter(a => a.id !== id)
        saveState()
        return json(res, 200, { ok: true })
      }

      if (action === 'keys' && req.method === 'POST') {
        const { name, disabled, id } = await readBody(req)
        if (id) {
          const k = state.keys.find(x => x.id === id)
          if (!k) return json(res, 404, { error: '令牌不存在' })
          if (typeof disabled === 'boolean') k.disabled = disabled
          if (typeof name === 'string' && name) k.name = name
          saveState()
          return json(res, 200, { ok: true })
        }
        const key = 'sk-qw-' + randomBytes(24).toString('hex')
        const item = { id: randomUUID(), name: name || '默认令牌', key, createdAt: Date.now(), requests: 0, disabled: false }
        state.keys.push(item)
        saveState()
        return json(res, 200, { key, item: { ...item, key: item.key } })
      }

      if (action === 'keys/delete' && req.method === 'POST') {
        const { id } = await readBody(req)
        state.keys = state.keys.filter(k => k.id !== id)
        saveState()
        return json(res, 200, { ok: true })
      }

      if (action === 'logs' && req.method === 'GET') {
        const n = Math.min(Number(url.searchParams.get('n') || 100), 1000)
        if (!existsSync(LOG_FILE)) return json(res, 200, { logs: [] })
        const lines = readFileSync(LOG_FILE, 'utf8').trim().split('\n').slice(-n).reverse()
        return json(res, 200, { logs: lines.map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) })
      }

      if (action === 'stats' && req.method === 'GET') {
        // 用量统计：近 24h 按小时、按模型、按账号、今日汇总
        const now = Date.now()
        const hourStart = now - (now % 3600000)
        const buckets = new Map()
        for (let i = 23; i >= 0; i--) {
          const t = hourStart - i * 3600000
          buckets.set(t, { t, n: 0, err: 0, ms: 0 })
        }
        const byModel = new Map(), byAccount = new Map()
        let total = 0, errors = 0, today = 0, todayErr = 0, msSum = 0, msN = 0
        const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0)
        if (existsSync(LOG_FILE)) {
          for (const line of readFileSync(LOG_FILE, 'utf8').split('\n')) {
            if (!line.trim()) continue
            let l; try { l = JSON.parse(line) } catch { continue }
            if (l.type !== 'chat' && l.type !== 'chat_error') continue
            total++
            const isErr = l.type === 'chat_error'
            if (isErr) errors++
            if (l.ms) { msSum += l.ms; msN++ }
            if (l.ts >= dayStart.getTime()) { today++; if (isErr) todayErr++ }
            const b = buckets.get(l.ts - (l.ts % 3600000))
            if (b) { b.n++; if (isErr) b.err++; if (l.ms) b.ms += l.ms }
            const mk = l.model || 'unknown'
            const cur = byModel.get(mk) || { model: mk, n: 0, err: 0 }
            cur.n++; if (isErr) cur.err++; byModel.set(mk, cur)
            const ak = l.account || 'unknown'
            const ac = byAccount.get(ak) || { account: ak, n: 0, err: 0 }
            ac.n++; if (isErr) ac.err++; byAccount.set(ak, ac)
          }
        }
        return json(res, 200, {
          hourly: [...buckets.values()].sort((a, b) => a.t - b.t),
          byModel: [...byModel.values()].sort((a, b) => b.n - a.n),
          byAccount: [...byAccount.values()].sort((a, b) => b.n - a.n),
          total, errors, today, todayErr,
          avgMs: msN ? Math.round(msSum / msN) : 0,
          successRate: total ? Number(((total - errors) / total).toFixed(3)) : 1,
        })
      }

      return json(res, 404, { error: 'not found' })
    }

    // OpenAI 兼容
    if (p === '/v1/models') {
      const k = checkKey(req.headers.authorization)
      if (!k) return json(res, 401, { error: { message: 'invalid api key', type: 'authentication_error' } })
      return json(res, 200, {
        object: 'list',
        data: Object.entries(PUBLIC_MODELS).map(([id, upstream]) => ({
          id, object: 'model', created: 0, owned_by: 'qwenwork',
          name: MODELS[upstream]?.name ?? id,
        })),
      })
    }

    if (p === '/v1/chat/completions' && req.method === 'POST') {
      const k = checkKey(req.headers.authorization)
      if (!k) return json(res, 401, { error: { message: 'invalid api key', type: 'authentication_error' } })
      return await handleChat(req, res, k)
    }

    if (p === '/health') {
      const rt = runtimeInfo()
      return json(res, 200, { ok: true, wasm: rt.ok, accounts: state.accounts.length, models: Object.keys(MODELS) })
    }

    return json(res, 404, { error: 'not found' })
  } catch (error) {
    const e = error instanceof ProviderError ? error : new ProviderError(redact(error.message || 'internal error'), 500)
    if (!res.headersSent) json(res, e.status ?? 500, { error: { message: e.message, type: e.code } })
    else res.end()
  }
})

server.listen(PORT, '0.0.0.0', () => {
  const rt = runtimeInfo()
  console.log(`[qwenwork-gateway] listening :${PORT}`)
  console.log(`[qwenwork-gateway] admin  http://127.0.0.1:${PORT}/admin?token=${ADMIN_TOKEN}`)
  console.log(`[qwenwork-gateway] wasm   ${rt.ok ? 'OK ' + rt.sha256.slice(0, 16) + ' ' + rt.bytes + 'B' : 'MISSING ' + rt.error}`)
})

// 定时刷新余额（默认 10 分钟）
const REFRESH_MS = Number(process.env.REFRESH_MS || 10 * 60 * 1000)
setInterval(async () => {
  for (const acc of state.accounts) {
    try { await refreshAccount(acc) } catch (e) { log({ type: 'refresh_error', account: acc.email || acc.uid, error: redact(e.message) }) }
  }
}, REFRESH_MS).unref()
