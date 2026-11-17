# 预制运行环境与后端发布

## 为什么分开

后端业务程序、后端运行依赖和沙箱 worker 是三个不同的更新对象。普通 Go 代码发布不应重新安装 pandas、JDK 或 PDF 工具，也不应在下载依赖期间停止旧服务。

- **后端运行环境**：证书、wget、Python、poppler-utils、pdfplumber 等，由独立环境 Dockerfile 制作。
- **后端应用镜像**：编译 server 和 broker，再复制到预制运行环境。
- **沙箱 worker 镜像**：Python、pandas/openpyxl、Go、JDK、网络初始化脚本等；只在环境升级时明确制作。

## 镜像复用原则

发布前先检查指定版本的环境镜像，本地存在则复用；缺失时只拉取明确指定的镜像仓库引用。只有本地名称、没有真实仓库地址的默认环境镜像，缺失时必须先制作，不能假定 Docker Hub 上存在同名官方镜像。

付费镜像加速服务只能加速它实际代理的镜像请求，不会自动代理 Dockerfile 内部的 pip/APT 下载。要让两台服务器避免重复安装，需先在一处制作完整环境镜像，然后通过用户自己的仓库分发，或用 `docker save` / `docker load` 传输。仓库地址由操作者提供，不预填虚构地址或自动推送。

使用固定版本标签，或明确的 digest。版本标签应按不可变版本管理；本地已有同名标签时脚本不会主动检查远端是否覆盖了它。依赖、基础环境或初始化脚本变更后，应发布新版本并在部署时明确选择。不要把“镜像存在”当成“必然是远端最新版本”。

## 使用命令

首次在有 Docker 的构建机上制作环境（会下载安装依赖，不自动推送或部署）：

```bash
bash deploy/build-runtime-images.sh
# 也可只制作一种环境
bash deploy/build-runtime-images.sh --runtime-only
bash deploy/build-runtime-images.sh --sandbox-only
```

默认环境版本分别为 `localhost/chat-lite/backend-runtime:2026-11-17-v1` 与 `localhost/chat-lite/table-sandbox:2026-11-17-v1`。`localhost/` 是本地镜像标签，不代表已提供镜像仓库服务；默认镜像缺失时会报错，不会向虚构远端拉取。已有旧 `chat-lite-table-sandbox:latest` 不会自动视为该版本环境。

普通后端发布：

```bash
bash deploy/rebuild-backend.sh
```

已有真实仓库镜像时，用以下参数明确指定。`registry.example.com/team` 仅为示例，必须替换；使用前完成对应仓库的登录授权：

```bash
bash deploy/rebuild-backend.sh \
  --runtime-image registry.example.com/team/backend-runtime:2026-11-17-v1 \
  --sandbox-image registry.example.com/team/table-sandbox:2026-11-17-v1
```

这两个参数也接受 `仓库/镜像@sha256:完整摘要`。本地存在即复用，不额外检查远端是否改写标签。显式制作脚本接受同名参数作为构建输出标签（不接受 digest 输出），之后由操作者明确 `docker push`，再在另一台拉取；脚本不会自动发布仓库。

不使用仓库时，在构建机导出默认环境镜像，传输文件后在另一台导入：

```bash
docker save -o chat-lite-environments.tar \
  localhost/chat-lite/backend-runtime:2026-11-17-v1 \
  localhost/chat-lite/table-sandbox:2026-11-17-v1
# 在接收节点运行
docker load -i chat-lite-environments.tar
```

跨机镜像必须匹配目标 CPU 架构；本流程没有增加多架构制作支持。普通发布仍需构建 Go 程序，Go 基础镜像及未缓存的 Go 模块仍可能需要网络；“复用环境”不等于所有构建完全离线。

`NO_CACHE=1` 只影响普通后端构建；`STOP_BEFORE_BUILD=1` 已忽略并提示，不再提前停服。直接 `docker build .` 或 Compose build 同样需要先准备后端 runtime；前端 `--target web` 保持独立。

## 切换与边界

部署需要 Linux 的 `flock`，通过固定的 `/var/lock/chat-lite-backend-deploy.lock` 串行保护整次发布及回退；同一主机上的第二次发布会立即拒绝。使用有 Docker 权限且可创建该锁文件的部署账号（现有服务器使用 root），不要手工删除正在使用的锁文件。

候选后端镜像构建成功后才进入服务切换。切换前保留旧运行镜像和 worker 别名，健康失败时尝试恢复旧版本；回退失败必须明确报告并保留诊断信息。该流程不是双机自动故障转移，也不保证正在执行的沙箱任务不被中断，应在维护窗口发布。

镜像回退只能恢复程序和镜像引用，不回滚数据库 DDL、模型命令的外部副作用或工作区文件。发布不格式化、迁移或删除 ext4 卷，不清理工作区，也不以无配额目录替代既有存储。

本地语法检查不等于 Docker 构建和部署验收。没有 Docker 环境时，需明确记录未验证镜像拉取、缓存复用、健康失败回退和 Linux 容器实际运行。

## 本次检查

本地对 `rebuild-backend.sh`、`build-runtime-images.sh` 执行 Git Bash `bash -n`，均 exit 0；根 Dockerfile 与环境 Dockerfile 的 RUN 指令按续行规则合并后执行 `sh -n`，均 exit 0。一次静态审计发现并修复了主机级发布互斥缺失，以及 slim 基础环境安装 CA 前使用 HTTPS APT 的引导问题。APT 引导保留包签名验证，CA 安装后 pip 继续使用 HTTPS。

本机无可用 Docker，未执行镜像构建、拉取、容器启动或回退场景；未运行业务自动测试，未连接或部署服务器。语法通过与静态审计不能作为上述运行路径已验收的结论。
