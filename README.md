# Codex 鹈鹕测试（CLIProxyAPI 插件）

在 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)（CPA）管理面板里，让每个凭证画同一幅 SVG——**一只骑自行车的鹈鹕**——然后把各凭证的作品并排对比。降智或被替换成小模型的凭证，通常画得明显更粗糙。

提示词原样使用 Simon Willison 的 [pelican riding a bicycle](https://simonwillison.net/tags/pelican-riding-a-bicycle/) 基准：

```
Generate an SVG of a pelican riding a bicycle
```

## 功能

- 按凭证固定路由发送请求（`host.model.execute` + `auth_id`），每个结果都对应确定的账号。
- 从回答中提取第一个完整的 `<svg>`（支持代码块、前后说明文字、嵌套 `<svg>`），并用 XML 解析校验；截断或格式错误的 SVG 记为「无有效 SVG」。
- 列表显示每个凭证最近一幅作品和最近 8 幅缩略图；点开可放大、查看 SVG 源码。
- 没有自动评分：用 👍 / 👎 记录你自己的判断，评价随历史一起保存。
- 每个凭证保留最近 20 次记录，重启 CPA 后仍在（`plugins/cpa-codex-pelican-eval-state.json`）。
- 画作以 `data:` 图片显示，页面 CSP 只允许 `img-src data:`，模型生成的 SVG 无法执行脚本。

界面、凭证同步和模型目录逻辑沿用 [cpa-plugin-codex-candy-eval](https://github.com/haowang02/cpa-plugin-codex-candy-eval)，两个插件可以同时安装。

## 安装

要求 CPA v8（在 v8.0.4 上测试）。

1. 构建（见下文）或从 Releases 下载 `cpa-codex-pelican-eval.so`，重命名为 `cpa-codex-pelican-eval-v0.1.0.so`，放入 CPA 工作目录的 `plugins/linux/amd64/`。
2. 在 CPA 的 `config.yaml` 中启用：

   ```yaml
   plugins:
     enabled: true
     dir: "plugins"
     configs:
       cpa-codex-pelican-eval:
         enabled: true
   ```

3. 重启 CPA，在管理面板左侧打开「Codex 鹈鹕测试」。

## 使用

选择模型、推理强度（默认 `medium`）和单凭证次数（1–5），点凭证旁的「测试」，或勾选多个凭证批量测试。未勾选时，批量操作针对当前类型下的全部可用凭证。

每次测试消耗一次该凭证的额度，输出通常在 1–4k tokens。

## 构建

需要 Docker。在仓库根目录运行：

```sh
./build.sh
```

它在 `golang:1.24-bookworm` 容器里执行 `go vet`、`go test -race`，并输出 `dist/cpa-codex-pelican-eval.so`（Linux amd64，glibc 2.36，适配 CPA 官方 Debian 12 镜像）。如需兼容更老的 glibc，参考 candy-eval 的 manylinux2014 构建方式。

## 许可

MIT。包含源自 cpa-plugin-codex-candy-eval（© 2026 Hao Wang，MIT）的代码，见 [LICENSE](LICENSE)。图标来自 [Lucide](https://lucide.dev)（ISC）。
