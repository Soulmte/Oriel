# 发布流程

## 1. 版本号

五处保持一致：`package.json`、`packages/shared/package.json`、
`packages/shared/src/index.ts` 的 `APP_VERSION`、`src-tauri/Cargo.toml` 的
`[workspace.package] version`、`src-tauri/tauri.conf.json`。
更新检查用 `APP_VERSION` 与 Release tag 比较（忽略前缀 `v`）。

## 2. 构建

```bash
npm ci
npm run typecheck
npm run smoke          # cargo test -p oriel-core
npm run build:desktop  # vite 构建 + tauri build，产出 msi / nsis
```

服务端是 Rust，编译进 `oriel.exe` 本身，不存在独立的服务端产物。

## 3. 发布产物

| 文件 | 说明 |
| --- | --- |
| `*_x64-setup.exe` / `*.msi` | 桌面安装包（单文件，内含本地服务） |

打 tag 推送后 `.github/workflows/release.yml` 会自动构建并创建 Release：

```bash
git tag v0.2.0
git push origin v0.2.0
```

Release 正文来自 `docs/release-notes/<tag>.md`（例如 `docs/release-notes/v0.1.4.md`）。
文件不存在时才回退到 GitHub 自动生成的提交列表。发版前先写好这份说明，Gitee 镜像会
同步同一份正文。

同时会做两件国内可达性的事：

- **Gitee 镜像**（需要 `GITEE_TOKEN`）：推送代码与 tag，并把同一批安装包挂到 Gitee
  Release 上。目标仓库默认 `rain-drops/oriel`（Gitee 上已有的公开仓库，注意是小写
  `oriel`）；仓库不存在时会用 token 自动创建一个公开仓库。需要换账号或仓库名时，配
  `GITEE_OWNER` / `GITEE_REPO` secret 覆盖即可。
- **CDN**（可选）：配置 `CDN_ENDPOINT`、`CDN_BUCKET`、`CDN_ACCESS_KEY_ID`、
  `CDN_SECRET_ACCESS_KEY`、`CDN_PUBLIC_BASE`，构建时会把 `CDN_PUBLIC_BASE` 写进桌面端，
  发布 job 把安装包传到 `<CDN_PUBLIC_BASE>/<tag>/<文件名>`。
  `CDN_PROVIDER` 默认 `Cloudflare`（R2），阿里云 OSS 填 `Alibaba`；`CDN_REGION` 默认 `auto`。
  这些 secret 不配置时，发布流程照常走 GitHub + Gitee。

## 4. 应用内更新

桌面端更新源在**构建时**写入 exe（运行时同名环境变量可覆盖）：

- `ORIEL_UPDATE_REPO=owner/repo` —— GitHub 更新源；
- `ORIEL_UPDATE_GITEE_REPO=owner/repo` —— Gitee 镜像源（兼容旧名
  `ORIEL_UPDATE_GITEE`），默认 `rain-drops/oriel`；
- `ORIEL_UPDATE_CDN=https://dl.example.com/oriel` —— 可选；设置后第一下载地址变成
  `<CDN>/<tag>/<文件名>`。

`release.yml` 已经把这些值传给 `tauri build`，所以配置好 secrets 后发布产物自带镜像，
用户机器不需要设置任何环境变量。早前的实现只读运行时环境变量，导致 CI 里的配置没有写进
安装包，已改为“编译期写入 + 运行时覆盖”。

下载顺序固定为 **CDN → Gitee → GitHub**；每个镜像下载完都会校验文件大小，不完整会自
动换下一个。启动约 4 秒后自动检查一次，有新版本时右下角弹出卡片，可立即更新、稍后或
跳过该版本（跳过记录在 localStorage，出现更新版本时会重新提示）。设置 → 关于 里保留
完整更新日志和手动检查。

### Gitee manifest

Gitee 的 REST API 前面有 WAF，十几次匿名请求就会返回 `403 Rate Limit Exceeded`，所以
客户端**不把 Gitee API 当作主路径**。发布流程在创建 Release 后会自动生成仓库根目录的
`update.json` 并提交到 `main`：

```json
{
  "tag": "v0.1.5",
  "name": "Oriel v0.1.5",
  "publishedAt": "2026-11-22T13:34:47.339Z",
  "notes": "...更新日志 Markdown...",
  "assets": [
    { "name": "Oriel_0.1.5_x64-setup.exe", "size": 2674110 }
  ]
}
```

客户端读取 `https://gitee.com/rain-drops/oriel/raw/main/update.json`（raw 文件不受限
流），再用 `releases/download/<tag>/<文件名>` 拼出下载地址。这样即使 Gitee API 被拦、
GitHub 也不通，国内用户依然能看到新版本并下载。API 结果只在 manifest 缺失时使用。

手动生成（例如补发旧版本）：

```bash
node scripts/update-manifest.mjs v0.1.5 src-tauri/target/release/bundle docs/release-notes
```

CDN 目录结构（发布 job 已按此布局上传）：

```
<CDN>/v0.2.0/Oriel_0.2.0_x64-setup.exe
<CDN>/v0.2.0/SHA256SUMS.txt
```

客户端行为：检查（可强制刷新）→ 展示 Markdown 更新日志 → 下载（真实字节进度，可取消，
依次尝试 CDN / Gitee / GitHub）→「立即安装并退出」或手动打开安装包。

## 5. Gitee 镜像

```bash
git remote add gitee https://gitee.com/rain-drops/oriel.git
git push gitee main --tags
```

CI 镜像：在 GitHub 仓库 Secrets 里配置 `GITEE_TOKEN`（Gitee 私人令牌，勾选 projects 权限），
`release.yml` 的 `mirror` job 会把所有分支与 tag 推送到 Gitee。
