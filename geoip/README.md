# GeoIP 查询服务

给 Workers 版 SSPanel-UIM 提供 IP 归属地查询。Worker 不能直接读取 60MB 的 mmdb，所以由这个小服务读取 MaxMind GeoLite2 数据库并暴露 HTTP 接口。

## 启动

```bash
cd geoip
GEOIP_TOKEN=随便一串随机字符 docker compose up -d --build
curl -H "Authorization: Bearer 随便一串随机字符" "http://127.0.0.1:8090/v1/lookup?ip=8.8.8.8"
```

默认挂载的是子模块 `SSPanel-Uim/storage/GeoLite2-*.mmdb`（旧版 PHP 面板的 `uim` 分支自带；Workers 版分支不再包含这两个文件，子模块指针请保持在旧提交，或改挂自己下载的 mmdb 目录）。要自动更新，去掉只读挂载改为挂目录，并设置 `GEOIP_ACCOUNT_ID` 与 `GEOIP_LICENSE_KEY`，服务会在启动时和每天下载最新库。

## 暴露给 Worker

Worker 必须通过 HTTPS 访问这个服务。两种做法：

1. 已有 nginx 的话加一个反代到 `127.0.0.1:8090` 的 server 块并配置证书。
2. 用 Cloudflare Tunnel 把 `http://127.0.0.1:8090` 映射到一个子域名。

然后在 Worker 里配置 `GEOIP_API_URL`（如 `https://geoip.example.com`），并用 `wrangler secret put GEOIP_API_TOKEN` 写入相同的 token。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查，无需鉴权 |
| GET | `/v1/lookup?ip=1.2.3.4` | 查询单个 IP |
| POST | `/v1/lookup`，body `{"ips":["1.2.3.4"]}` | 批量查询，最多 500 个 |

返回示例：

```json
{"results":{"8.8.8.8":{"country":"美国","country_code":"US","city":"","location":"美国"}}}
```

`location` 是面板直接展示的文本，格式为“城市, 国家”。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GEOIP_PORT` | 8090 | 监听端口 |
| `GEOIP_DB_DIR` | /data | mmdb 目录 |
| `GEOIP_TOKEN` | 空 | 鉴权 token，为空则不鉴权 |
| `GEOIP_LOCALE` | zh-CN | 地名语言 |
| `GEOIP_ACCOUNT_ID` / `GEOIP_LICENSE_KEY` | 空 | MaxMind 账号，用于自动更新 |
