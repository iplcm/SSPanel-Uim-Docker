# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Docker Compose deployment wrapper around [SSPanel-Uim](https://github.com/iplcm/SSPanel-Uim), which is vendored as a git submodule at `SSPanel-Uim/`. There is no application code here; the repo only holds the compose file, the PHP image definition, and nginx/mariadb config. Application changes belong in the submodule (its own upstream repo), not here. Commit messages in this repo are written in Chinese.

Clone with `git clone --recurse-submodules`; if `SSPanel-Uim/` is empty run `git submodule update --init`. Bumping the pinned submodule commit (`git submodule update --remote`, then commit the new pointer) is the most common change in the history.

## Service topology (docker-compose.yaml)

| Service | Container | Image | Notes |
|---|---|---|---|
| nginx | `nginx-2025` | `nginx:alpine` | Host port 8080. Mounts `file/nginx/` as `conf.d` and the submodule at `/usr/www/html`. |
| php | `php-2025` | `gtary/ssp:php` (built from `file/php/Dockerfile`) | Mounts the submodule at `/var/www/html`. No host port; nginx reaches it at `php:9000`. |
| mariadb | `mariadb-2025` | `mariadb:lts` | Host port 63306 (read access for AI tooling). Data in `/opt/data/mysql` on the host. `SSPanel-Uim/db` is mounted at `/tmp/sql` for SQL imports. |
| redis | `redis-2025` | `redis` | Data in `/opt/data/redis`. No host port. |
| phpmyadmin | `phpmyadmin-2025` | `phpmyadmin` | Host port 888, `PMA_ARBITRARY=1`; connect with host `mariadb`, user `root`. |

Things that are easy to get wrong:

- **The submodule is mounted at two different paths on purpose.** nginx sees it at `/usr/www/html` (its `root` is `/usr/www/html/public`), but `fastcgi_param SCRIPT_FILENAME` in `file/nginx/nginx.conf` points at `/var/www/html/public`, which is the PHP container's path. Keep both consistent if either mount changes.
- `MARIADB_ROOT_PASSWORD` is read from a gitignored `.env` next to the compose file. There is no committed default.
- All containers run with `TZ=Asia/Shanghai`.
- nginx trusts `CF-Connecting-IP` from the Cloudflare IP ranges listed in `nginx.conf`; the panel sits behind Cloudflare in the intended deployment.
- `file/mariadb/my.cnf` only forces `SET NAMES utf8` on connect. The database itself should be created as `utf8mb4_unicode_ci` (see README).

## The PHP image

`file/php/Dockerfile` builds `php:8.3-fpm-alpine` with the extensions SSPanel needs (redis, yaml, zip, mysqli, pdo_mysql, bcmath, imap) and hard-codes php-fpm pool settings via appended `zz-docker.conf` lines. It sets `LD_PRELOAD` to GNU libiconv (Alpine's musl iconv breaks some PHP libs). After changing the Dockerfile, publish the multi-arch image with:

```bash
bash file/php/push.bash   # buildx --push to gtary/ssp:php for 7 platforms; requires Docker Hub login
```

The compose file pulls `gtary/ssp:php` rather than building locally, so a Dockerfile change has no effect until the image is pushed (or the `php` service is switched to `build: ./file/php`).

## Common commands

Operational commands are all in [README.md](README.md) (Chinese); the essentials:

```bash
# PHP deps are installed on the host via a throwaway composer container, not inside php-2025
docker run --rm -v $PWD/SSPanel-Uim:/app composer install --ignore-platform-reqs

docker-compose up -d
docker-compose down          # keeps /opt/data/mysql and /opt/data/redis

# Run SSPanel CLI (xcat) inside the php container
docker-compose exec -i php sh -c 'exec php xcat Migration new'      # fresh DB schema
docker-compose exec -i php sh -c 'exec php xcat Tool importSetting'
docker-compose exec -i php sh -c 'exec php xcat Tool createAdmin'
docker-compose exec -i php sh -c 'exec php xcat Cron'               # host crontab runs this every minute via `docker exec -i php-2025 ...`

# Fix ownership after composer install / file edits
docker-compose exec -i php sh -c 'exec chmod -R 755 `pwd` && chown -R www-data: `pwd`'

# Backup / restore (restore reads from /tmp/sql == ./SSPanel-Uim/db on the host)
docker-compose exec mariadb sh -c 'exec mariadb-dump sspanel -uroot -p"$MARIADB_ROOT_PASSWORD"' > db.sql
```

Panel config lives in the submodule: copy `SSPanel-Uim/config/.config.example.php` to `.config.php` (and `appprofile.example.php` to `appprofile.php`) and set `db_host` to `mariadb`. These files are inside the submodule tree and are not tracked by this repo.

Note: the README's restore section says to move `db.sql` into `SSPanel-Uim/sql/`, but the compose mount is `./SSPanel-Uim/db:/tmp/sql`, so the file must actually be placed in `SSPanel-Uim/db/` for `source /tmp/sql/db.sql` to work.

## Testing / linting

There are no tests or linters for this repo itself. The submodule has `phpunit.xml` and `phpinsights.php`, but those are upstream concerns; run them from inside `SSPanel-Uim/` only if you are intentionally working on the panel code.
