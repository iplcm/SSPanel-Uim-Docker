/**
 * 极简 GeoIP 查询服务：读取 MaxMind GeoLite2 mmdb，给 Workers 版面板提供 IP 归属地。
 *
 * 环境变量：
 *   GEOIP_PORT        监听端口，默认 8090
 *   GEOIP_DB_DIR      mmdb 所在目录，默认 /data；需要 GeoLite2-City.mmdb（可选 GeoLite2-Country.mmdb 作为回退）
 *   GEOIP_TOKEN       鉴权 token，设置后请求必须带 Authorization: Bearer <token>
 *   GEOIP_LOCALE      名称语言，默认 zh-CN，找不到时回退 en
 *   GEOIP_ACCOUNT_ID / GEOIP_LICENSE_KEY  设置后启动时及每天自动从 MaxMind 下载更新数据库
 *
 * 接口：
 *   GET  /healthz
 *   GET  /v1/lookup?ip=1.2.3.4
 *   POST /v1/lookup  {"ips":["1.2.3.4","2001:db8::1"]}
 * 返回 {"results": {"1.2.3.4": {"country": "...", "country_code": "CN", "city": "...", "location": "城市, 国家"}}}
 */
import { createServer } from 'node:http';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import maxmind from 'maxmind';
import * as tar from 'tar';

const PORT = Number(process.env.GEOIP_PORT ?? 8090);
const DB_DIR = process.env.GEOIP_DB_DIR ?? '/data';
const TOKEN = process.env.GEOIP_TOKEN ?? '';
const LOCALE = process.env.GEOIP_LOCALE ?? 'zh-CN';
const ACCOUNT_ID = process.env.GEOIP_ACCOUNT_ID ?? '';
const LICENSE_KEY = process.env.GEOIP_LICENSE_KEY ?? '';
const EDITIONS = ['GeoLite2-City', 'GeoLite2-Country'];

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
  const url = `https://download.maxmind.com/geoip/databases/${edition}/download?suffix=tar.gz`;
  const auth = Buffer.from(`${ACCOUNT_ID}:${LICENSE_KEY}`).toString('base64');
  const resp = await fetch(url, { headers: { authorization: `Basic ${auth}` }, redirect: 'follow' });
  if (!resp.ok) {
    throw new Error(`下载 ${edition} 失败: HTTP ${resp.status}`);
  }
  const work = await mkdtemp(path.join(tmpdir(), 'geoip-'));
  const archive = path.join(work, `${edition}.tar.gz`);
  await pipeline(resp.body, createWriteStream(archive));
  await tar.x({ file: archive, cwd: work });
  const dirs = (await readdir(work, { withFileTypes: true })).filter((d) => d.isDirectory());
  let found = null;
  for (const dir of dirs) {
    const candidate = path.join(work, dir.name, `${edition}.mmdb`);
    if (existsSync(candidate)) {
      found = candidate;
    }
  }
  if (!found) {
    await rm(work, { recursive: true, force: true });
    throw new Error(`压缩包里没有 ${edition}.mmdb`);
  }
  mkdirSync(DB_DIR, { recursive: true });
  const target = path.join(DB_DIR, `${edition}.mmdb`);
  const temp = `${target}.tmp`;
  await pipeline(createReadStream(found), createWriteStream(temp));
  renameSync(temp, target);
  await rm(work, { recursive: true, force: true });
  console.log(`已更新 ${edition}: ${statSync(target).size} 字节`);
}

async function updateDatabases() {
  if (ACCOUNT_ID === '' || LICENSE_KEY === '') {
    return;
  }
  for (const edition of EDITIONS) {
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

await updateDatabases();
await openReaders();
server.listen(PORT, () => console.log(`GeoIP 服务监听 :${PORT}，鉴权 ${TOKEN === '' ? '关闭' : '开启'}，语言 ${LOCALE}`));
if (ACCOUNT_ID !== '' && LICENSE_KEY !== '') {
  setInterval(updateDatabases, 24 * 60 * 60 * 1000).unref();
}
