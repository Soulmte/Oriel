# 发布流程

## 1. 版本号

三处保持一致：`package.json`、`src-tauri/Cargo.toml`、`packages/shared` 的 `APP_VERSION`。
更新检查用 `APP_VERSION` 与 Release tag 比较（忽略前缀 `v`）。

## 2. 构建

```bash
npm ci
npm run typecheck && npm run smoke
npm run build          # 前端 dist + 服务端 server/dist
npm run build:desktop  # 生成 msi / nsis 安装包
```

## 3. 发布产物

| 文件 | 说明 |
| --- | --- |
| `oriel-server.zip` | 服务端产物 + 生产依赖（当前 Tauri 包还不含 sidecar） |
| `*_x64-setup.exe` / `*.msi` | 桌面安装包 |
| `SHA256SUMS.txt` | 校验和，Release 说明里引用 |

打 tag 推送后 `.github/workflows/release.yml` 会自动构建并创建 Release：

```bash
git tag v0.2.0
git push origin v0.2.0
```

## 4. 应用内更新

服务端读取：

- `ORIEL_UPDATE_REPO=owner/repo` —— 更新源；
- `ORIEL_UPDATE_CDN=https://dl.example.com/oriel` —— 可选；设置后下载地址变成
  `<CDN>/<tag>/<文件名>`，用于 GitHub 资源被墙的网络。

CDN 目录结构（把同名文件按 tag 归档即可）：

```
<CDN>/v0.2.0/oriel-server.zip
<CDN>/v0.2.0/Oriel_0.2.0_x64-setup.exe
<CDN>/v0.2.0/SHA256SUMS.txt
```

客户端行为：检查 → 展示 Markdown 更新日志 → 下载（真实字节进度，可取消）→ 打开安装包。

## 5. Gitee 镜像

```bash
git remote add gitee https://gitee.com/<owner>/Oriel.git
git push gitee main --tags
```

CI 镜像：在 GitHub 仓库 Secrets 里配置 `GITEE_TOKEN`（Gitee 私人令牌，勾选 projects 权限），
`release.yml` 的 `mirror` job 会把所有分支与 tag 推送到 Gitee。
