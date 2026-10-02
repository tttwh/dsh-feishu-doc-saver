# DSH 飞书文档保存插件（dsh-plugin）

让 DeepSeek Harness (DSH) 把写好的文档**自动保存到飞书云文档**。基于飞书官方 OpenAPI：

- **任意输入格式**：Markdown / HTML / 纯文本 → 飞书云文档 docx
- **全保真**：真表格、代码块、图片（本地路径或 URL 自动上传嵌入）、LaTeX 公式、嵌套列表、引用、链接
- **文档归你**：以 OAuth 用户身份创建，落在你「我的空间」的 `DSH` 文件夹（自动创建）
- **智能命名**：标题默认取文件名，重名自动加 `(2)`；失败自动重试 2 次，本地文件不受影响
- **自动续期**：refresh_token 长期有效，一次授权永久可用

## 安装（DSH Agent Preset）

1. 把本目录复制到 `${DSH_HOME:-~/.dsh}/.agent-presets/feishu-doc-saver/`
2. 在 DSH 里选择「飞书文档保存」preset 开始会话

## 一次性授权（必须）

插件以**用户 OAuth 身份**写文档，需要先完成一次授权：

### 1. 飞书开放平台配置（应用 cli_xxx）

- **安全设置 → 重定向 URL**：添加 `http://127.0.0.1:3089/feishu-oauth/callback`
- **权限管理 → 用户身份**：开通 `docx:document`、`drive:drive`、`docs:document.media:upload`（上传图片用）
- 应用开了「版本管理」的话记得发布新版本

### 2. 运行授权脚本

```bash
node feishu-oauth.mjs <app_id> <app_secret>
```

打开脚本打印的授权链接，登录飞书并同意。成功后令牌保存为：

1. `~/.dsh/feishu-user-tokens.json`（优先）
2. 写不进去时回退到 `<工作区>/.feishu/feishu-user-tokens.json`（权限 600）

### 3. 使用

直接在会话里说：

> 把「飞书导入探针.md」保存到飞书

或让 DSH 写完文档后主动调用 `save_to_feishu` 工具。工具参数：

| 参数 | 说明 |
| --- | --- |
| `path` | 本地文件路径（Markdown/HTML/纯文本），与 `content` 二选一 |
| `content` | Markdown 内容原文，与 `path` 二选一 |
| `title` | 飞书文档标题（可选），缺省用文件名去扩展名 |

## 配置（环境变量，均可选）

- `DSH_FEISHU_TOKEN_PATH` — 令牌文件路径
- `DSH_FEISHU_FOLDER` — 飞书目标文件夹名（默认 `DSH`）

## 技术要点

飞书 docx API 的坑都填好了：

- 普通「创建块」接口**不能建表格**（错误 1770029）→ 使用「创建嵌套块」接口 `POST /docx/v1/documents/{id}/blocks/{id}/descendant` 一次写入整棵块树
- 官方「markdown 转换」接口输出的块需要清洗：剥 `style`、重映射 `block_id`、表格块去掉 `cells` 字段、叶子块补 `children: []`
- 图片需 `drive/v1/medias/upload_all` 上传（`parent_type=docx_image`）+ `replace_image` 回填，PATCH 要带 `document_revision_id=-1`
- OAuth 换令牌需 **PKCE + 显式 scope**，新版端点要 `app_id`/`app_secret` 字段名

## License

MIT
