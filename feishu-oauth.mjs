// feishu-oauth.mjs — 一次性授权脚本
// 用法: node feishu-oauth.mjs
// 流程: 读 openclaw 配置里的 appId/appSecret → 起本地 3089 端口 HTTP 服务 →
//       打印授权链接 → 用户点开后回调 /feishu-oauth/callback?code=xxx →
//       换取 user_access_token + refresh_token → 写入 ~/.dsh/feishu-user-tokens.json
import http from 'node:http'
import https from 'node:https'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const PORT = 3089
const REDIRECT = `http://127.0.0.1:${PORT}/feishu-oauth/callback`
const BASE = 'https://open.feishu.cn/open-apis'
// 优先写 ~/.dsh（全局），被沙箱拒绝时回退到工作区目录
const TOKEN_PATH = path.join(os.homedir(), '.dsh', 'feishu-user-tokens.json')
const FALLBACK_TOKEN_PATH = '/Users/taoweihao/Downloads/FYP/.feishu/feishu-user-tokens.json'

// 1. read openclaw config
let appId = process.argv[2]
let appSecret = process.argv[3]
if (!appId || !appSecret) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.openclaw', 'openclaw.json'), 'utf8'))
    const feishu = cfg?.channels?.feishu
    appId = feishu?.appId
    appSecret = feishu?.appSecret
  } catch (e) { /* ignore */ }
}
if (!appId || !appSecret) {
  console.error('用法: node feishu-oauth.mjs <app_id> <app_secret>')
  process.exit(1)
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const data = JSON.stringify(body)
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let buf = ''
      res.on('data', (c) => (buf += c))
      res.on('end', () => { try { resolve(JSON.parse(buf)) } catch (e) { reject(new Error('bad json: ' + buf.slice(0, 200))) } })
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

// PKCE: code_verifier + S256 code_challenge
const codeVerifier = crypto.randomBytes(32).toString('base64url')
const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
const state = crypto.randomBytes(8).toString('hex')
const SCOPES = 'docx:document docx:document.block:convert drive:drive docs:document.media:upload'

const authorizeUrl =
  `${BASE}/authen/v1/authorize?app_id=${appId}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT)}` +
  `&state=${state}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&code_challenge=${codeChallenge}&code_challenge_method=S256`

console.log('')
console.log('==========================================================')
console.log('  请用浏览器打开下面的链接，登录飞书并完成授权：')
console.log('')
console.log('  ' + authorizeUrl)
console.log('')
console.log('==========================================================')
console.log('')

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://127.0.0.1:${PORT}`)
  if (u.pathname !== '/feishu-oauth/callback') {
    res.writeHead(404).end('not found')
    return
  }
  const code = u.searchParams.get('code')
  const errParam = u.searchParams.get('error')
  const errDesc = u.searchParams.get('error_description')
  if (errParam) {
    console.error('授权被拒绝或出错:', errParam, errDesc || '')
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>❌ 授权失败</h2><p>${errParam} ${errDesc || ''}</p><p>可以关闭本页面。</p></body></html>`)
    setTimeout(() => process.exit(1), 500)
    return
  }
  if (!code) {
    res.writeHead(400).end('missing code')
    return
  }
  try {
    console.log('收到授权码(code 前8位: ' + code.slice(0, 8) + ', 长度: ' + code.length + ')，正在换取令牌…')
    // 先试 app_id/app_secret 字段名（新版端点要求），失败再试 client_id/client_secret
    let r = await postJson(`${BASE}/authen/v1/oidc/access_token`, {
      grant_type: 'authorization_code',
      app_id: appId,
      app_secret: appSecret,
      code,
      redirect_uri: REDIRECT,
      code_verifier: codeVerifier,
    })
    if (r.code !== 0 && (r.code === 20028 || r.code === 23001)) {
      console.log('app_id 字段名被拒(' + r.code + ')，改用 client_id/client_secret 重试…')
      r = await postJson(`${BASE}/authen/v1/oidc/access_token`, {
        grant_type: 'authorization_code',
        client_id: appId,
        client_secret: appSecret,
        code,
        redirect_uri: REDIRECT,
        code_verifier: codeVerifier,
      })
    }
    if (r.code !== 0) {
      console.error('换取令牌失败:', JSON.stringify(r))
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>❌ 换取令牌失败（错误码 ${r.code}）</h2><p>${r.message || r.msg || ''}</p><p>最常见原因：授权码已过期或已使用。<b>请重新点击下面的链接完成授权</b>（本服务保持运行，无需重启）：</p><p><a href="${authorizeUrl}">${authorizeUrl}</a></p></body></html>`)
      return
    }
    const data = r.data
    const now = Date.now()
    const record = {
      app_id: appId,
      app_secret: appSecret,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      token_type: data.token_type || 'Bearer',
      expires_in: data.expires_in || 7200,
      refresh_expires_in: data.refresh_expires_in || 0,
      scope: data.scope || '',
      created_at: now,
      expires_at: now + (data.expires_in || 7200) * 1000,
    }
    let savedPath = ''
    for (const p of [TOKEN_PATH, FALLBACK_TOKEN_PATH]) {
      try {
        fs.mkdirSync(path.dirname(p), { recursive: true })
        fs.writeFileSync(p, JSON.stringify(record, null, 2), { mode: 0o600 })
        savedPath = p
        break
      } catch (e) {
        console.error('写入 ' + p + ' 失败: ' + e.message + '，尝试下一个路径…')
      }
    }
    if (!savedPath) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>❌ 无法保存令牌</h2><p>请把以下内容复制给 DSH（令牌有效，只是存不下来）：</p><pre>${JSON.stringify(record, null, 2)}</pre></body></html>`)
      return
    }
    console.log('✅ 令牌已保存到', savedPath)
    console.log('   scope:', record.scope)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>✅ 授权成功</h2><p>飞书令牌已保存到 ${savedPath}，可以关闭本页面并回到 DSH。</p></body></html>`)
    setTimeout(() => process.exit(0), 800)
  } catch (e) {
    console.error('异常:', e.message)
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end(`<html><body style="font-family:sans-serif;padding:40px"><h2>❌ 出错</h2><p>${e.message}</p><p>请重新点击授权链接：</p><p><a href="${authorizeUrl}">${authorizeUrl}</a></p></body></html>`)
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`本地回调服务已启动: http://127.0.0.1:${PORT}`)
})
