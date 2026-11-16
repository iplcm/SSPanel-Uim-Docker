# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Docker Compose deployment wrapper around [SSPanel-Uim](https://github.com/iplcm/SSPanel-Uim), which is vendored as a git submodule at `SSPanel-Uim/`. There is no application code here; the repo only holds the compose file, the PHP image definition, and nginx/mariadb config. Application changes belong in the submodule (its own upstream repo), not here. Commit messages in this repo are written in Chinese.

The panel in the submodule is a slimmed-down fork: wallet-signature login, Soul Point based membership, Shadowsocks-only nodes, a JSON API under `/api`, subscriptions under `/sub`, the node WebAPI under `/mod_mu`, and a Preact single-page frontend whose build output is committed in `SSPanel-Uim/public/` (no Node needed to deploy). Its own README (Chinese) documents features, config keys and the upgrade path.

Clone with `git clone --recurse-submodules`; if `SSPanel-Uim/` is empty run `git submodule update --init`. Bumping the pinned submodule commit and committing the new pointer is the most common change in the history. `git submodule update --remote` follows the submodule's default branch (`uim`), so only use it when that is the branch you want to deploy.

## Service topology (docker-compose.yaml)

| Service | Container | Image | Notes |
|---|---|---|---|
| nginx | `nginx-2025` | `nginx:alpine` | Host port 8080. Mounts `file/nginx/` as `conf.d` and the submodule at `/usr/www/html`. Serves `/assets/` (hashed frontend files) itself with a one-year cache; everything else that is not a file goes to `index.php`, which answers API routes or returns the frontend page. |
| php | `php-2025` | `gtary/ssp:php` (built from `file/php/Dockerfile`) | Mounts the submodule at `/var/www/html`. No host port; nginx reaches it at `php:9000`. |
| mariadb | `mariadb-2025` | `mariadb:lts` | Latest LTS on purpose (12.3 in November 2026). Host port 63306 (read access for AI tooling). Data in `/opt/data/mysql` on the host. `SSPanel-Uim/db` is mounted at `/tmp/sql` for SQL imports. |
| redis | `redis-2025` | `redis` | Only used by the panel for request rate limiting; the panel keeps working (limits off) when it is down. Data in `/opt/data/redis`. No host port. |
| phpmyadmin | `phpmyadmin-2025` | `phpmyadmin` | Host port 888, `PMA_ARBITRARY=1`; connect with host `mariadb`, user `root`. |

Things that are easy to get wrong:

- **The submodule is mounted at two different paths on purpose.** nginx sees it at `/usr/www/html` (its `root` is `/usr/www/html/public`), but `fastcgi_param SCRIPT_FILENAME` in `file/nginx/nginx.conf` points at `/var/www/html/public`, which is the PHP container's path. Keep both consistent if either mount changes.
- `MARIADB_ROOT_PASSWORD` is read from a gitignored `.env` next to the compose file. There is no committed default.
- All containers run with `TZ=Asia/Shanghai`.
- nginx trusts `CF-Connecting-IP` from the Cloudflare IP ranges listed in `nginx.conf`; the panel sits behind Cloudflare in the intended deployment. The panel reads the client IP only from `REMOTE_ADDR`, so rate limits, session IP binding and the node-IP check all depend on this `real_ip` setup being correct.
- `file/mariadb/my.cnf` only forces `SET NAMES utf8` on connect. The database itself should be created as `utf8mb4_unicode_ci` (see README).

## The PHP image

`file/php/Dockerfile` builds from `php:8.5-fpm-alpine` with redis, yaml, zip, mysqli, pdo_mysql, bcmath and imap (the panel itself needs bcmath, pdo_mysql, redis and yaml) and hard-codes php-fpm pool settings via appended `zz-docker.conf` lines. The imap extension (also the POP3/NNTP client; wanted by the operator even though SSPanel's composer.json does not require it) is installed from PECL with `--configureoptions`, because PHP 8.4+ no longer ships it in-tree: on those images `/usr/src/php/ext/imap` contains only tests, so `docker-php-ext-configure imap` fails with `Cannot find config.m4`. The base image is pinned to 8.5 on purpose; do not switch it back to the floating `php:8-fpm-alpine` tag. Checked against PHP 8.6.0RC7 in November 2026: the official 8.6 images no longer ship `pecl`/`pear` and no longer have mbstring built in, and the latest PECL releases of redis (6.3.0), yaml (2.3.0) and imap (1.0.3) fail to compile there. The panel's own code and its Composer dependencies already pass the test suite on 8.6 (yaml patched locally, redis absent; the only noise is two deprecation notices from `simplito/bn-php` and `simplito/elliptic-php`), so moving to 8.6 only needs new releases of those extensions plus two Dockerfile changes: install the PECL extensions without the `pecl` command (unpack the tarball into `/usr/src/php/ext/<name>` and use `docker-php-ext-install`, or use PIE) and add `mbstring` to `docker-php-ext-install` (needs `oniguruma-dev`). PHP INI overrides go in `/usr/local/etc/php/conf.d/*.ini`, not in `zz-docker.conf`; php-fpm rejects unknown keys in its pool config with `unknown entry` and refuses to start. It sets `LD_PRELOAD` to GNU libiconv (Alpine's musl iconv breaks some PHP libs). After changing the Dockerfile, publish the multi-arch image with:

```bash
bash file/php/push.bash   # buildx --push to gtary/ssp:php for linux/arm64 + linux/amd64; requires Docker Hub login
```

The compose file pulls `gtary/ssp:php` rather than building locally, so a Dockerfile change has no effect until the image is pushed (or the `php` service is switched to `build: ./file/php`).

## Common commands

Operational commands are all in [README.md](README.md) (Chinese); the essentials:

```bash
# PHP deps are installed on the host via a throwaway composer container, not inside php-2025
docker run --rm -v $PWD/SSPanel-Uim:/app composer install --no-dev --ignore-platform-reqs

docker-compose up -d
docker-compose down          # keeps /opt/data/mysql and /opt/data/redis

# Run SSPanel CLI (xcat) inside the php container
docker-compose exec -i php sh -c 'exec php xcat Migration new'      # fresh DB: schema + settings
docker-compose exec -i php sh -c 'exec php xcat Migration latest'   # upgrade an existing DB (additive only, drops nothing)
docker-compose exec -i php sh -c 'exec php xcat Tool createAdmin 0x<wallet address>'
docker-compose exec -i php sh -c 'exec php xcat Tool cleanLegacy'   # irreversible: drop tables/columns left over from the old panel
docker-compose exec -i php sh -c 'exec php xcat Cron'               # host crontab runs this every 5 minutes

# Fix ownership after composer install / file edits
docker-compose exec -i php sh -c 'exec chmod -R 755 `pwd` && chown -R www-data: `pwd`'

# Backup / restore (restore reads from /tmp/sql == ./SSPanel-Uim/db on the host)
docker-compose exec mariadb sh -c 'exec mariadb-dump sspanel -uroot -p"$MARIADB_ROOT_PASSWORD"' > db.sql
```

Panel config lives in the submodule: copy `SSPanel-Uim/config/.config.example.php` to `.config.php` (and `appprofile.example.php` to `appprofile.php`) and set `db_host` to `mariadb`. These files are inside the submodule tree and are not tracked by this repo.

`nginx.conf` is bind-mounted, so config changes need `docker-compose restart nginx`; restart `php` after updating the submodule so opcache drops the old code.

## Testing / linting

There are no tests or linters for this repo itself. The submodule has a PHPUnit suite (`vendor/bin/phpunit`; the API tests need a disposable MariaDB database, see its README) and the frontend source in `web/`; run them from inside `SSPanel-Uim/` only if you are intentionally working on the panel code.
