/**
 * 极简 GeoIP 查询服务：读取 MaxMind GeoLite2 mmdb，给 Workers 版面板提供 IP 归属地。
 *
 * 环境变量：
 *   GEOIP_PORT        监听端口，默认 8090
 *   GEOIP_DB_DIR      mmdb 所在目录，默认 /data；需要 GeoLite2-City.mmdb（可选 GeoLite2-Country.mmdb 作为回退）
 *   GEOIP_TOKEN       鉴权 token，设置后请求必须带 Authorization: Bearer <token>
 *   GEOIP_LOCALE      名称语言，默认 zh-CN，找不到时回退 en
 *   GEOIP_SOURCE_URL  mmdb 下载地址模板，{edition} 会被替换为 GeoLite2-City / GeoLite2-Country，
 *                     默认 https://github.com/du5/geoip/blob/main/{edition}.mmdb?raw=1（无需 MaxMind 账号）
 *   GEOIP_UPDATE_HOURS 自动刷新间隔（小时），默认 24，0 表示只在缺文件时下载
 *
 * 接口：
 *   GET  /healthz
 *   GET  /v1/lookup?ip=1.2.3.4
 *   POST /v1/lookup  {"ips":["1.2.3.4","2001:db8::1"]}
 * 返回 {"results": {"1.2.3.4": {"country": "...", "country_code": "CN", "city": "...", "location": "城市, 国家"}}}
 */
import { createServer } from 'node:http';
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import maxmind from 'maxmind';

const PORT = Number(process.env.GEOIP_PORT ?? 8090);
const DB_DIR = process.env.GEOIP_DB_DIR ?? '/data';
const TOKEN = process.env.GEOIP_TOKEN ?? '';
const LOCALE = process.env.GEOIP_LOCALE ?? 'zh-CN';
const SOURCE_URL = process.env.GEOIP_SOURCE_URL ?? 'https://github.com/du5/geoip/blob/main/{edition}.mmdb?raw=1';
const UPDATE_HOURS = Number(process.env.GEOIP_UPDATE_HOURS ?? 24);
const EDITIONS = ['GeoLite2-Country', 'GeoLite2-City'];

const readers = { city: null, country: null };

async function openReaders() {
  const next = { city: null, country: null };
  const cityPath = path.join(DB_DIR, 'GeoLite2-City.mmdb');
  const countryPath = path.join(DB_DIR, 'GeoLite2-Country.mmdb');
  if (existsSync(cityPath)) {
    next.city = await maxmind.open(cityPath);
  }
  if (existsSync(countryPath)) {
    next.country = await maxmind.open(countryPath);
  }
  if (!next.city && !next.country) {
    throw new Error(`在 ${DB_DIR} 下找不到 GeoLite2-City.mmdb 或 GeoLite2-Country.mmdb`);
  }
  readers.city = next.city;
  readers.country = next.country;
  console.log(`已加载数据库: city=${next.city ? 'yes' : 'no'} country=${next.country ? 'yes' : 'no'}`);
}

function pickName(names) {
  if (!names) return '';
  return names[LOCALE] ?? names.en ?? Object.values(names)[0] ?? '';
}

function lookup(ip) {
  if (!isIP(ip)) {
    return { error: 'invalid ip' };
  }
  const record = readers.city?.get(ip) ?? readers.country?.get(ip) ?? null;
  const country = pickName(record?.country?.names);
  const countryCode = record?.country?.iso_code ?? '';
  const city = pickName(record?.city?.names);
  const location = city !== '' ? `${city}, ${country || '未知国家'}` : country !== '' ? country : '未知';
  return { country, country_code: countryCode, city, location };
}

async function downloadEdition(edition) {
  const url = SOURCE_URL.replace('{edition}', edition);
  const resp = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!resp.ok || !resp.body) {
    throw new Error(`下载 ${edition} 失败: HTTP ${resp.status}`);
  }
  mkdirSync(DB_DIR, { recursive: true });
  const target = path.join(DB_DIR, `${edition}.mmdb`);
  const temp = `${target}.download`;
  await pipeline(resp.body, createWriteStream(temp));
  const size = statSync(temp).size;
  if (size < 1024 * 1024) {
    throw new Error(`下载的 ${edition} 太小（${size} 字节），疑似不是 mmdb 文件`);
  }
  // 先校验能打开再替换正式文件
  await maxmind.open(temp);
  renameSync(temp, target);
  console.log(`已更新 ${edition}: ${size} 字节，来源 ${url}`);
}

/** 缺文件或到刷新周期时从 GitHub 下载 GeoLite2 库（du5/geoip 镜像，无需 MaxMind 账号） */
async function updateDatabases(force) {
  for (const edition of EDITIONS) {
    const target = path.join(DB_DIR, `${edition}.mmdb`);
    if (!force && existsSync(target)) {
      continue;
    }
    try {
      await downloadEdition(edition);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
    }
  }
  try {
    await openReaders();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
  }
}

function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

function authorized(req) {
  if (TOKEN === '') return true;
  return req.headers.authorization === `Bearer ${TOKEN}`;
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      throw new Error('body too large');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/healthz') {
    return send(res, 200, { ok: true, city: Boolean(readers.city), country: Boolean(readers.country) });
  }
  if (!authorized(req)) {
    return send(res, 401, { error: 'unauthorized' });
  }
  if (url.pathname === '/v1/lookup' && req.method === 'GET') {
    const ip = url.searchParams.get('ip') ?? '';
    const result = lookup(ip);
    return send(res, result.error ? 400 : 200, result.error ? result : { ip, ...result });
  }
  if (url.pathname === '/v1/lookup' && req.method === 'POST') {
    let body;
    try {
      body = await readJson(req);
    } catch {
      return send(res, 400, { error: 'invalid json' });
    }
    const ips = Array.isArray(body.ips) ? body.ips.slice(0, 500).map(String) : [];
    const results = {};
    for (const ip of ips) {
      const result = lookup(ip);
      results[ip] = result.error ? { country: '', country_code: '', city: '', location: '未知' } : result;
    }
    return send(res, 200, { results });
  }
  return send(res, 404, { error: 'not found' });
});

await updateDatabases(false);
if (!readers.city && !readers.country) {
  console.error('没有可用的 GeoLite2 数据库，退出');
  process.exit(1);
}
server.listen(PORT, () => console.log(`GeoIP 服务监听 :${PORT}，鉴权 ${TOKEN === '' ? '关闭' : '开启'}，语言 ${LOCALE}`));
if (UPDATE_HOURS > 0) {
  setInterval(() => updateDatabases(true), UPDATE_HOURS * 60 * 60 * 1000).unref();
}
