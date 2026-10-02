// plugin.mjs — DSH 飞书文档保存插件（Agent preset 行，零依赖纯 JS）
//
// 注册一个模型工具 save_to_feishu：
//   path   (可选) 要保存的本地文件路径（Markdown/HTML/纯文本）
//   content(可选) 要保存的 Markdown 内容原文
//   title  (可选) 飞书文档标题，缺省用文件名去扩展名
//
// 行为：
//   - 以用户 OAuth 身份（user_access_token）创建文档，文档归用户所有
//   - 自动在「我的空间」根目录创建专用文件夹（默认 DSH，可用环境变量覆盖）
//   - Markdown/HTML → 飞书官方块转换 API → 「创建嵌套块」API 一次性写入
//     （表格、代码块、图片、LaTeX 公式、嵌套列表、引用、链接全部保真）
//   - 图片（本地路径或 http(s) URL）自动上传并回填图片块
//   - 重名自动加序号；失败自动重试 2 次，本地文件不受影响
//
// 配置（环境变量，均可选）：
//   DSH_FEISHU_TOKEN_PATH  令牌文件路径（默认 ~/.dsh/feishu-user-tokens.json，
//                          其次 <工作区>/.feishu/feishu-user-tokens.json）
//   DSH_FEISHU_FOLDER      飞书目标文件夹名（默认 DSH）

export default {
  inject: ['timer', 'tools'],
  apply(ctx) {
    const subprocess = ctx.get('subprocess')
    if (subprocess === undefined) {
      console.error('[feishu-doc-saver] subprocess service unavailable, plugin disabled')
      return
    }
    const fs = ctx.get('fs')
    const env = (typeof process !== 'undefined' && process.env) || {}
    const home = env.HOME || ''
    const FOLDER_NAME = env.DSH_FEISHU_FOLDER || 'DSH'

    const TOKEN_PATHS = []
    if (env.DSH_FEISHU_TOKEN_PATH) TOKEN_PATHS.push(env.DSH_FEISHU_TOKEN_PATH)
    if (home) TOKEN_PATHS.push(home + '/.dsh/feishu-user-tokens.json')
    TOKEN_PATHS.push('.feishu/feishu-user-tokens.json') // 相对路径 → 会话工作目录

    const BASE = 'https://open.feishu.cn/open-apis'
    const CURL = '/usr/bin/curl'
    const MAX_RETRIES = 2

    // ---------- 底层：执行 curl ----------
    function runCmd(argv, opts = {}) {
      const handle = subprocess.spawn({
        argv,
        cwd: '/tmp',
        stdio: {
          stdin: opts.stdinData !== undefined ? { data: opts.stdinData } : 'ignore',
          stdout: { maxBytes: opts.maxOut || 16 * 1024 * 1024, spill: { maxBytes: 16 * 1024 * 1024 } },
          stderr: { maxBytes: 64 * 1024, spill: { maxBytes: 64 * 1024 } },
        },
        graceMs: opts.graceMs || 45000,
        signal: opts.signal,
      })
      return handle.done.then((outcome) => {
        const out = handle.collected.stdout ? handle.collected.stdout.readFrom(0).text : ''
        const err = handle.collected.stderr ? handle.collected.stderr.readFrom(0).text : ''
        return { exitCode: outcome.exitCode, out, err }
      })
    }

    // JSON API，传输层自动重试
    async function apiJson(method, path, token, body) {
      let lastErr = ''
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        const argv = [CURL, '-s', '-S', '-X', method, BASE + path,
          '-H', 'Authorization: Bearer ' + token]
        let stdinData
        if (body !== undefined) {
          argv.push('-H', 'Content-Type: application/json', '--data-binary', '@-')
          stdinData = JSON.stringify(body)
        }
        const r = await runCmd(argv, { stdinData })
        if (r.exitCode === 0) {
          try {
            const j = JSON.parse(r.out)
            if (j && typeof j === 'object' && 'code' in j) return j
            lastErr = 'unexpected body: ' + r.out.slice(0, 120)
          } catch (e) {
            lastErr = 'bad json: ' + r.out.slice(0, 120)
          }
        } else {
          lastErr = 'curl exit ' + r.exitCode + ': ' + r.err.slice(0, 160)
        }
        if (attempt < MAX_RETRIES) await ctx.timeout(500 * (attempt + 1))
      }
      throw new Error('飞书 API 请求失败(' + method + ' ' + path + '): ' + lastErr)
    }

    // ---------- 令牌管理 ----------
    async function readTokenFile() {
      if (fs === undefined) return null
      for (const p of TOKEN_PATHS) {
        try {
          const target = await fs.resolve(p)
          const text = await fs.readText(target)
          return JSON.parse(text)
        } catch (e) { /* 尝试下一个路径 */ }
      }
      return null
    }

    async function refreshTokens(record) {
      const r = await apiJson('POST', '/authen/v1/oidc/refresh_token', '', {
        grant_type: 'refresh_token',
        client_id: record.app_id,
        client_secret: record.app_secret,
        refresh_token: record.refresh_token,
      })
      if (r.code !== 0) throw new Error('刷新飞书令牌失败: ' + r.msg + ' (请重新运行授权流程)')
      const d = r.data
      const now = Date.now()
      return {
        access_token: d.access_token,
        refresh_token: d.refresh_token,
        expires_at: now + (d.expires_in || 7200) * 1000,
      }
    }

    async function ensureToken() {
      const record = await readTokenFile()
      if (record === null) {
        return { error: '尚未授权飞书。请先运行 feishu-oauth.mjs 完成一次性 OAuth 授权，令牌文件应位于 ' + TOKEN_PATHS.join(' 或 ') }
      }
      if (record.access_token && Date.now() < (record.expires_at || 0) - 60000) {
        return { token: record.access_token, record }
      }
      const fresh = await refreshTokens(record)
      return { token: fresh.access_token, record: Object.assign({}, record, fresh) }
    }

    // ---------- 目标文件夹 ----------
    async function ensureFolder(token) {
      const rm = await apiJson('GET', '/drive/explorer/v2/root_folder/meta', token)
      if (rm.code !== 0) throw new Error('获取根目录失败: ' + rm.msg)
      const root = rm.data.token
      const lst = await apiJson('GET', '/drive/v1/files?folder_token=' + encodeURIComponent(root) + '&page_size=200', token)
      if (lst.code !== 0) throw new Error('列出根目录失败: ' + lst.msg)
      const files = lst.data.files || []
      let folder = files.find((f) => f.type === 'folder' && f.name === FOLDER_NAME)
      if (folder === undefined) {
        const created = await apiJson('POST', '/drive/v1/files/create_folder', token, {
          name: FOLDER_NAME, folder_token: root,
        })
        if (created.code !== 0) throw new Error('创建文件夹失败: ' + created.msg)
        folder = { token: created.data.token }
      }
      const inner = await apiJson('GET', '/drive/v1/files?folder_token=' + encodeURIComponent(folder.token) + '&page_size=200', token)
      if (inner.code !== 0) throw new Error('列出目标文件夹失败: ' + inner.msg)
      const existingTitles = new Set()
      for (const f of inner.data.files || []) {
        if (f.type === 'docx' || f.type === 'doc') existingTitles.add(f.name)
      }
      return { folderToken: folder.token, existingTitles }
    }

    function uniqueTitle(base, existing) {
      let t = base.slice(0, 80)
      if (!existing.has(t)) return t
      for (let i = 2; i < 1000; i++) {
        const cand = base.slice(0, 76) + '(' + i + ')'
        if (!existing.has(cand)) return cand
      }
      return base.slice(0, 60) + Date.now()
    }

    // ---------- Markdown/HTML → 块 ----------
    function extractImages(md, isHtml) {
      const out = []
      const re = isHtml
        ? /<img[^>]+src=["']([^"']+)["']/gi
        : /!\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g
      let m
      while ((m = re.exec(md)) !== null) out.push({ src: m[1] })
      return out
    }

    function metaBlock(fileLabel) {
      const now = new Date()
      const pad = (n) => String(n).padStart(2, '0')
      const ts = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
        ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes())
      const lines = ['📌 本文档由 DSH 自动保存', '来源文件: ' + fileLabel, '保存时间: ' + ts]
      return {
        block_id: 'fypmeta',
        block_type: 15,
        quote: {
          elements: lines.map((l) => ({ text_run: { content: l, text_element_style: {} } })),
        },
        children: [],
      }
    }

    const TEXT_LIKE = { 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1, 11: 1, 12: 1, 13: 1, 15: 1, 17: 1, 19: 1 }
    const TEXT_KEYS = ['text', 'bullet', 'ordered', 'quote', 'todo', 'callout',
      'heading1', 'heading2', 'heading3', 'heading4', 'heading5',
      'heading6', 'heading7', 'heading8', 'heading9']

    function cleanBlocks(data) {
      const blocks = data.blocks || []
      const first = data.first_level_block_ids || []
      const remap = {}
      blocks.forEach((b, i) => { remap[b.block_id] = 'fypb' + i })
      const cleaned = blocks.map((b) => {
        const out = {}
        for (const k of Object.keys(b)) {
          if (k === 'parent_id') continue
          out[k] = b[k]
        }
        out.block_id = remap[b.block_id] || out.block_id
        if ('children' in out) {
          out.children = (out.children || []).map((c) => remap[c]).filter(Boolean)
        } else {
          out.children = []
        }
        const t = b.block_type
        if (t === 31) {
          const prop = (b.table && b.table.property) || {}
          const cleanProp = { row_size: prop.row_size, column_size: prop.column_size }
          if (Array.isArray(prop.column_width)) cleanProp.column_width = prop.column_width
          out.table = { property: cleanProp }
        } else if (t === 14) {
          if (out.code && out.code.style) {
            const st = out.code.style
            out.code.style = {}
            if (st.language !== undefined) out.code.style.language = st.language
            if (st.wrap !== undefined) out.code.style.wrap = st.wrap
          }
        } else if (TEXT_LIKE[t]) {
          for (const key of TEXT_KEYS) {
            if (out[key] && out[key].style) delete out[key].style
          }
        }
        return out
      })
      const orderedFirst = first.map((id) => remap[id]).filter(Boolean)
      const meta = metaBlock('由 DSH 生成的内容')
      const all = [meta].concat(cleaned)
      return { descendants: all, firstIds: ['fypmeta'].concat(orderedFirst), imageBlocks: cleaned.filter((b) => b.block_type === 27) }
    }

    // ---------- 图片回填 ----------
    async function downloadTo(url, dest) {
      const r = await runCmd([CURL, '-s', '-L', '--max-time', '45', '-o', dest, url], { graceMs: 50000 })
      if (r.exitCode !== 0) throw new Error('下载图片失败: ' + url)
      return dest
    }

    async function uploadImage(token, realBlockId, filePath, size, name) {
      const r = await runCmd([CURL, '-s', '-S', '-X', 'POST', BASE + '/drive/v1/medias/upload_all',
        '-H', 'Authorization: Bearer ' + token,
        '-F', 'file_name=' + name, '-F', 'parent_type=docx_image',
        '-F', 'parent_node=' + realBlockId, '-F', 'size=' + size,
        '-F', 'file=@' + filePath], { graceMs: 60000 })
      try {
        const j = JSON.parse(r.out)
        if (j.code !== 0) throw new Error('上传图片失败: ' + j.msg)
        return j.data.file_token
      } catch (e) {
        if (e instanceof Error && /上传图片失败/.test(e.message)) throw e
        throw new Error('上传图片失败: ' + r.out.slice(0, 160))
      }
    }

    async function fillImages(token, docId, relations, imageBlocks, images, baseDir) {
      const realMap = {}
      for (const rel of relations || []) realMap[rel.temporary_block_id] = rel.block_id
      let done = 0
      const skipped = []
      for (let i = 0; i < imageBlocks.length && i < images.length; i++) {
        const block = imageBlocks[i]
        const src = images[i].src
        const realId = realMap[block.block_id]
        if (!realId) { skipped.push(src); continue }
        try {
          let filePath = src
          let size = 0
          let name = 'image_' + (i + 1) + '.png'
          if (/^https?:\/\//i.test(src)) {
            filePath = '/tmp/fyp_dsh_img_' + Date.now() + '_' + i
            await downloadTo(src, filePath)
          } else {
            const resolved = src.startsWith('/') ? src : (baseDir ? baseDir.replace(/\/+$/, '') + '/' + src : src)
            filePath = resolved
          }
          if (fs !== undefined) {
            try {
              const target = await fs.resolve(filePath)
              const info = await fs.stat(target)
              if (info && typeof info.size === 'number') size = info.size
            } catch (e) { /* 继续 */ }
          }
          const fileToken = await uploadImage(token, realId, filePath, size, name)
          const patched = await apiJson('PATCH',
            '/docx/v1/documents/' + docId + '/blocks/' + realId + '?document_revision_id=-1',
            token, { replace_image: { token: fileToken } })
          if (patched.code === 0) done++
          else skipped.push(src + ' (patch: ' + patched.msg + ')')
        } catch (e) {
          skipped.push(src + ' (' + (e && e.message) + ')')
        }
      }
      return { uploaded: done, skipped }
    }

    // ---------- 主流程 ----------
    async function saveToFeishu(args) {
      const auth = await ensureToken()
      if (auth.error !== undefined) return { ok: false, error: auth.error }
      const token = auth.token

      let md = ''
      let fileLabel = '由 DSH 生成的内容'
      let baseDir = ''
      let isHtml = false
      if (typeof args.content === 'string' && args.content.length > 0) {
        md = args.content
      } else if (typeof args.path === 'string' && args.path.length > 0) {
        if (fs === undefined) return { ok: false, error: 'fs 服务不可用，无法读取文件' }
        let target
        try {
          target = await fs.resolve(args.path)
          md = await fs.readText(target)
        } catch (e) {
          return { ok: false, error: '读取文件失败: ' + args.path + ' (' + (e && e.message) + ')' }
        }
        const name = args.path.split('/').pop() || '未命名'
        fileLabel = name
        const idx = args.path.lastIndexOf('/')
        baseDir = idx >= 0 ? args.path.slice(0, idx) : ''
        isHtml = /\.html?$/i.test(name)
      } else {
        return { ok: false, error: '请提供 path（要保存的文件路径）或 content（要保存的内容）' }
      }

      const folder = await ensureFolder(token)
      let title = typeof args.title === 'string' && args.title.trim().length > 0
        ? args.title.trim()
        : fileLabel.replace(/\.[^.]+$/, '')
      title = uniqueTitle(title, folder.existingTitles)

      const convertBody = { content_type: isHtml ? 'html' : 'markdown', content: md }
      const conv = await apiJson('POST', '/docx/v1/documents/blocks/convert', token, convertBody)
      if (conv.code !== 0) return { ok: false, error: 'Markdown 转换失败: ' + conv.msg }

      const cleaned = cleanBlocks(conv.data)
      const created = await apiJson('POST', '/docx/v1/documents', token, {
        title, folder_token: folder.folderToken,
      })
      if (created.code !== 0) return { ok: false, error: '创建飞书文档失败: ' + created.msg }
      const docId = created.data.document.document_id

      const inserted = await apiJson('POST',
        '/docx/v1/documents/' + docId + '/blocks/' + docId + '/descendant',
        token, { index: 0, children_id: cleaned.firstIds, descendants: cleaned.descendants })
      if (inserted.code !== 0) return { ok: false, error: '写入文档内容失败: ' + inserted.msg + '（文档已创建但为空: https://feishu.cn/docx/' + docId + '）' }

      const images = extractImages(md, isHtml)
      let imgResult = { uploaded: 0, skipped: [] }
      if (images.length > 0 && cleaned.imageBlocks.length > 0) {
        imgResult = await fillImages(token, docId,
          inserted.data.block_id_relations || [], cleaned.imageBlocks, images, baseDir)
      }

      return {
        ok: true,
        title,
        url: 'https://feishu.cn/docx/' + docId,
        document_id: docId,
        block_count: cleaned.descendants.length,
        images_uploaded: imgResult.uploaded,
        images_skipped: imgResult.skipped,
        folder: FOLDER_NAME,
      }
    }

    // ---------- 注册工具 ----------
    ctx.tools.register({
      name: 'save_to_feishu',
      description: '把 DSH 写好的文档保存到飞书云文档（我的空间 > ' + FOLDER_NAME + ' 文件夹，以用户本人身份创建，文档归用户所有）。支持 Markdown、HTML、纯文本输入，表格、代码块、图片、LaTeX 公式、嵌套列表、引用、链接全部保真。写完任何文档后应主动调用此工具保存；重名自动加序号。',
      parameters: {
        type: 'object',
        additionalProperties: true,
        properties: {
          path: { type: 'string', description: '要保存的本地文件路径（Markdown/HTML/纯文本），相对路径基于会话工作目录。与 content 二选一。' },
          content: { type: 'string', description: '要保存的 Markdown 内容原文。与 path 二选一。' },
          title: { type: 'string', description: '飞书文档标题（可选），缺省用文件名去掉扩展名。' },
        },
        required: [],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean' },
            title: { type: 'string' },
            url: { type: 'string' },
            document_id: { type: 'string' },
            block_count: { type: 'number' },
            images_uploaded: { type: 'number' },
            images_skipped: { type: 'array', items: { type: 'string' } },
            folder: { type: 'string' },
            error: { type: 'string' },
          },
          required: ['ok'],
        },
        render(args, value) {
          if (value && value.ok) {
            let line = '✅ 已保存到飞书：' + value.title + '\n' + value.url
            if (value.images_uploaded > 0) line += '\n图片: ' + value.images_uploaded + ' 张已嵌入'
            return [{ type: 'text', text: line }]
          }
          return [{ type: 'text', text: '❌ 飞书保存失败：' + ((value && value.error) || '未知错误') }]
        },
      },
      execute: async (args) => {
        try {
          return await saveToFeishu(args || {})
        } catch (e) {
          return { ok: false, error: String((e && e.message) || e) }
        }
      },
      timeoutMs: 180000,
    })
    console.log('[feishu-doc-saver] tool registered: save_to_feishu')
  },
}
