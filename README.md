# TEM CNT Workbench

TEM 碳纳米管分析的静态浏览器前端，连接独立部署的 TEM 分析 API。

**[打开当前在线工作台](https://tem-cnt.47.236.76.214.nip.io/)** · [全部 CNT 工具](https://zuestian.github.io/Cnanotools/)

## 仓库职责

本仓库保存 `index.html` 和 `static/` 前端资源。分析 API、模型权重和训练数据由后端部署维护。

GitHub Pages 地址：[zuestian.github.io/tem-cnt-workbench](https://zuestian.github.io/tem-cnt-workbench/)。静态页面调用的接口版本应与后端匹配，日常使用以上方当前在线工作台为入口。

## 本地预览

```bash
python -m http.server 8080
```

打开 `http://127.0.0.1:8080/`。自动分析功能需要可访问的 TEM API。

## 目录

| 路径 | 内容 |
| --- | --- |
| `index.html` | 工作台页面 |
| `static/` | JavaScript、样式和图标 |
| `.nojekyll` | GitHub Pages 静态资源配置 |
