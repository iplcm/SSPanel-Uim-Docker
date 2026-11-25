# SSPanel-Uim-Docker

用 Docker Compose 部署 [SSPanel-Uim](https://github.com/iplcm/SSPanel-Uim)（子模块 `SSPanel-Uim/`）：nginx + PHP 8.5 + MariaDB（最新 LTS，当前 12.3）+ Redis + phpMyAdmin。

面板本身的说明（功能、配置项、升级注意事项）见子模块里的 README。

### 下载源代码
```bash
# 项目和数据都放在 /opt/ssp-2027 下
git clone --recurse-submodules --depth=1 https://github.com/du5/SSPanel-Uim-Docker /opt/ssp-2027 && cd /opt/ssp-2027
# git submodule update --init # 子模块目录是空的时候执行
```

### 安装 PHP 依赖

```bash
# rm -rf SSPanel-Uim/vendor # 可选, 删除旧依赖重新安装
docker run --rm -v $PWD/SSPanel-Uim:/app composer install --no-dev --ignore-platform-reqs
```

前端页面的打包结果已经在子模块的 `public/` 里，不需要安装 Node。


### 启动

```bash
# 数据库文件位置 /opt/ssp-2027/mysql（从旧目录迁移：先 docker-compose down，再 mv /opt/data/mysql /opt/ssp-2027/mysql）
# Redis 数据位置 /opt/ssp-2027/redis
# 时区 Asia/Shanghai
# 数据库 root 密码写在 docker-compose.yaml 同目录的 .env 里：MARIADB_ROOT_PASSWORD=...
# 可通过 docker-compose.yaml 配置文件修改
docker-compose up -d
```

### 创建数据库

```bash
docker-compose exec -i mariadb sh -c 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -e"\
SET NAMES utf8;
CREATE DATABASE sspanel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"'
```

### 复制配置文件

```bash
cp SSPanel-Uim/config/.config.example.php SSPanel-Uim/config/.config.php
cp SSPanel-Uim/config/appprofile.example.php SSPanel-Uim/config/appprofile.php
# 修改配置文件，数据库地址为 mariadb，Redis 地址为 redis
# pma 访问地址 http://<当前ip>:888
# 主机名 mariadb 用户 root
sed -i "s|^\$_ENV\['db_host'\] = '';|\$_ENV['db_host'] = 'mariadb';|" SSPanel-Uim/config/.config.php # 修改数据库 host
sed -i "s|^\$_ENV\['redis_host'\] = '127.0.0.1';|\$_ENV['redis_host'] = 'redis';|" SSPanel-Uim/config/.config.php # 修改 Redis host
# vim SSPanel-Uim/config/.config.php # 必须修改 key、muKey、baseUrl、数据库密码
```

### 设置 php 权限

```bash
docker-compose exec -i php sh -c 'exec chmod -R 755 `pwd`'
docker-compose exec -i php sh -c 'exec chown -R www-data: `pwd`'
```

### 初始化数据库并创建管理员

```bash
docker-compose exec -i php sh -c 'exec php xcat Migration new' # 建表并导入设置
docker-compose exec -i php sh -c 'exec php xcat Tool createAdmin 0x你的钱包地址' # 创建管理员，之后用这个钱包签名登录
docker-compose exec -i php sh -c 'exec php xcat Tool updateGeoIP' # 可选，下载最新的 GeoLite2 数据库（仓库里自带一份）
```

### 配置定时任务

```bash
*/5 * * * * docker exec -i php-2025 sh -c 'exec php xcat Cron'
```

### 从旧版面板升级

升级不删除任何数据，旧版的表和字段都留在库里；确认新版稳定后再单独清理。

```bash
# 1. 先备份数据库
docker-compose exec mariadb sh -c 'exec mariadb-dump sspanel -uroot -p"$MARIADB_ROOT_PASSWORD"' > db-before-upgrade.sql

# 2. 更新代码与依赖
git pull && git submodule update --init
docker run --rm -v $PWD/SSPanel-Uim:/app composer install --no-dev --ignore-platform-reqs
docker-compose restart nginx php   # nginx 配置有变化；重启 php 清掉旧代码的缓存

# 3. 检查 SSPanel-Uim/config/.config.php：key 不能是 ChangeMe 或空（现在是登录会话的签名密钥），
#    baseUrl / subUrl / webAPIUrl 要和实际访问的域名一致。旧文件里多出来的配置项不用删

# 4. 升级数据库，并立即执行一次定时任务（读取魂点门槛）
docker-compose exec -i php sh -c 'exec php xcat Migration latest'
docker-compose exec -i php sh -c 'exec php xcat Cron'

# 5. 把 crontab 改成每 5 分钟执行一次（见上一节）
```

升级后所有人需要用钱包重新签名登录一次；订阅地址、连接密码和节点后端都不用动。

需要回退时，把子模块切回旧提交、重新安装依赖即可，数据库可以直接继续使用。

确认不再需要回退后，清理旧版遗留的表、字段和设置（不可恢复）：

```bash
docker-compose exec -i php sh -c 'exec php xcat Tool cleanLegacy'
```

### 升级 MariaDB

`mariadb:lts` 始终指向最新的 LTS 版本，重新拉取镜像后可能换到新的大版本。换版本之后执行一次 `mariadb-upgrade` 更新系统表；已经是最新时它什么都不做。

```bash
# 先备份数据库（见下面“迁移备份&还原数据库”）
docker-compose pull mariadb && docker-compose up -d mariadb
docker-compose exec mariadb sh -c 'exec mariadb-upgrade -uroot -p"$MARIADB_ROOT_PASSWORD"'
```

### 停止面板(~~跑路~~)

```bash
# 在项目根目录下执行
docker-compose down
# 该命令不会删除数据库, 如需删库跑路需要额外执行下一条命令
# rm -rf /opt/ssp-2027/mysql
```

### 迁移备份&还原数据库

```bash

# 备份 sspanel 数据库, 执行完后文件位于当前目录的 db.sql
docker-compose exec mariadb sh -c 'exec mariadb-dump sspanel -uroot -p"$MARIADB_ROOT_PASSWORD"' > db.sql

# 移动备份文件到 SSP 项目中的 db 目录（容器里对应 /tmp/sql）
mv db.sql SSPanel-Uim/db/

# 建表&导入数据库
docker-compose exec -i mariadb sh -c 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" -e"
SET NAMES utf8;
CREATE DATABASE sspanel CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
use sspanel;
source /tmp/sql/db.sql;"'

```
