# 部署与维护

首次部署使用新的数据卷；本版本不自动迁移其他账本数据库。恢复只使用本版本生成的备份。

目标为 Docker Compose 单实例服务。镜像构建与生产更新分开：GitHub Actions 构建镜像，按需手动更新。

## 首次配置

1. 将 `compose.yaml`、`update.sh`、`backup.sh`、`restore.sh` 上传到服务器的 `/opt/ledger/`，该目录由部署账号管理。使用同一目录名保持 Compose 项目及数据卷名称稳定。
2. 复制 `.env.example` 为 `/opt/ledger/.env`，填写镜像摘要、域名和初始账号。默认仅监听 `127.0.0.1:18082`。
3. 创建 `secrets/admin_password`，填入 12–72 字节的唯一密码。文件须供容器 UID `10001` 读取；可使用 `sudo chown 10001:10001 secrets/admin_password` 和 `sudo chmod 400 secrets/admin_password`，并将宿主机 `secrets/` 目录设为部署用户所有、权限 `700`。不要提交该文件。
4. 若 GHCR 镜像私有，在服务器运行 `docker login ghcr.io`，使用仅有 `read:packages` 权限的凭据。
5. 执行 `./update.sh ghcr.io/trynewthin/ledger@sha256:<镜像摘要>`，等待健康检查通过。
6. 在已有反向代理中配置域名，代理到 `127.0.0.1:18082`，启用 HTTPS；Caddy 示例见 `Caddyfile.example`。`LEDGER_ORIGIN` 必须与浏览器访问的协议和域名完全一致，不含路径或尾斜杠。
7. 打开网站登录并在“连接与安全”中签发 MCP Token。首次配置完成后，后续改动初始密码文件不会改变数据库中的账号密码；使用网页修改密码。

## 手动更新

1. 在 GitHub `CI and image` 工作流确认测试与镜像发布成功，从工作流摘要取得不可变镜像地址。
2. 执行 `./update.sh <镜像地址>`。脚本拉取镜像、为正在运行的数据库生成备份，再更新容器。
3. 更新成功后 `.env` 记录实际镜像；健康检查失败会启动上一个镜像。当前版本使用同一数据格式，回退不会自动恢复备份，以免丢失更新期间写入的数据。

也可以运行 GitHub 的 `Deploy manually` 工作流，填写镜像摘要。首次使用需要在仓库 `production` 环境配置：

| 配置类型 | 名称 | 用途 |
| --- | --- | --- |
| Variable | `DEPLOY_HOST` | 服务器主机名或 IP |
| Variable | `DEPLOY_USER` | 部署用户 |
| Secret | `DEPLOY_SSH_KEY` | 专用于部署的 SSH 私钥 |
| Secret | `DEPLOY_KNOWN_HOSTS` | 经核验的服务器 SSH 主机公钥记录 |

工作流固定执行 `/opt/ledger/update.sh`，只接受本仓库的不可变 GHCR 摘要。生产工作流不会由代码提交自动触发。也可由本地已授权的 SSH 连接直接执行更新脚本，无需向 GitHub 配置 SSH 密钥。

## 备份与恢复

1. 执行 `./backup.sh`，通过 SQLite 在线备份 API 生成一致性快照，保存到 `backups/`。服务不停止，WAL 中的数据一并纳入。
2. 将备份复制到独立存储并按需要加密。备份包含财务数据、密码哈希、会话和令牌摘要，应限制读取权限。脚本不会自动清理历史备份，也未默认设置定时任务。
3. 恢复时执行 `./restore.sh /绝对路径/备份.db`。脚本先验证完整性和单用户账号，再备份当前数据，停止服务、替换数据库，最后启动并检查健康状态。
4. 恢复到旧备份会同时恢复当时的会话与 Token 状态。恢复完成后检查“连接与安全”，撤销不再使用的凭据。

更新、回退与恢复使用同一个部署锁。禁止同时手动启动多个实例写入同一账本卷。

## 常用命令

```sh
docker compose ps
docker compose logs --tail=100 ledger
curl --fail http://127.0.0.1:18082/healthz
./backup.sh
```

`docker compose down` 保留数据卷；不要使用 `down -v`。应用不记录密码、Token 或账目请求正文。持久化卷不做应用层加密，应通过宿主机磁盘和备份存储保护数据。
