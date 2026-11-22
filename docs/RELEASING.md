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

同时会做两件国内可达性的事：

- **Gitee 镜像**（需要 `GITEE_TOKEN`）：推送代码与 tag，并把同一批安装包挂到 Gitee
  Release 上。仓库不存在时会用 token 自动创建一个公开仓库；如果 Gitee 账号与 GitHub
  不同名，再配一个 `GITEE_OWNER`，构建时会把镜像源写成 `<GITEE_OWNER>/Oriel`。
- **CDN**（可选）：配置 `CDN_ENDPOINT`、`CDN_BUCKET`、`CDN_ACCESS_KEY_ID`、
  `CDN_SECRET_ACCESS_KEY`、`CDN_PUBLIC_BASE`，构建时会把 `CDN_PUBLIC_BASE` 写进桌面端，
  发布 job 把安装包传到 `<CDN_PUBLIC_BASE>/<tag>/<文件名>`。
  `CDN_PROVIDER` 默认 `Cloudflare`（R2），阿里云 OSS 填 `Alibaba`；`CDN_REGION` 默认 `auto`。
  这些 secret 不配置时，发布流程照常走 GitHub + Gitee。

## 4. 应用内更新

桌面端读取：

- `ORIEL_UPDATE_REPO=owner/repo` —— GitHub 更新源；
- `ORIEL_UPDATE_GITEE=owner/repo` —— Gitee 镜像源，默认与 GitHub 相同；
- `ORIEL_UPDATE_CDN=https://dl.example.com/oriel` —— 可选；设置后第一下载地址变成
  `<CDN>/<tag>/<文件名>`，失败后依次尝试 Gitee 和 GitHub。

CDN 目录结构（发布 job 已按此布局上传）：

```
<CDN>/v0.2.0/Oriel_0.2.0_x64-setup.exe
<CDN>/v0.2.0/SHA256SUMS.txt
```

客户端行为：检查（可强制刷新）→ 展示 Markdown 更新日志 → 下载（真实字节进度，可取消，
依次尝试 CDN / Gitee / GitHub）→「立即安装并退出」或手动打开安装包。

## 5. Gitee 镜像

```bash
git remote add gitee https://gitee.com/<owner>/Oriel.git
git push gitee main --tags
```

CI 镜像：在 GitHub 仓库 Secrets 里配置 `GITEE_TOKEN`（Gitee 私人令牌，勾选 projects 权限），
`release.yml` 的 `mirror` job 会把所有分支与 tag 推送到 Gitee。
