#!/bin/sh
set -e

# Cargo entrypoint: runs WordPress (Apache + PHP + MariaDB) inside the proot
# rootfs and exposes it over the Acurast reverse tunnel's two connections —
# PRIMARY (Let's Encrypt) forwards Apache/WordPress, SECONDARY (self-signed)
# forwards dropbear SSH.
#
# Setup is split into two phases on purpose: phase 1 installs the minimal deps,
# brings up SSH, and starts the tunnel FIRST, so if the heavier WordPress stack
# install in phase 2 stalls (MariaDB init under proot is the usual hot spot) you
# can still SSH into the machine and debug it live.

echo "=== Setting up environment ==="
export HOME=/root
# Never block on debconf prompts (no stdin here), and stop package postinst
# scripts from trying to start services via systemd/invoke-rc.d — there is no
# init system in the proot rootfs, and those attempts hang or fail.
export DEBIAN_FRONTEND=noninteractive
printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d
chmod +x /usr/sbin/policy-rc.d

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GETIFADDRS_OVERRIDE_SO=/usr/local/lib/libgetifaddrs_override.so
WEB_PORT=8080
export WEB_PORT

DB_NAME="${WORDPRESS_DB_NAME:-wordpress}"
DB_USER="${WORDPRESS_DB_USER:-wordpress}"
DB_PASS="${WORDPRESS_DB_PASSWORD:-wordpress}"
PGSOCK=/run/mysqld/mysqld.sock

APACHE_PID=""
MARIADB_PID=""
TUNNEL_PID=""
DROPBEAR_PID=""

apt-get update
if ! command -v curl >/dev/null 2>&1; then apt-get install -y curl; fi

. "$SCRIPT_DIR/callback.sh"

finish() {
    code=$?
    [ -n "$APACHE_PID" ] && kill "$APACHE_PID" 2>/dev/null || true
    [ -n "$DROPBEAR_PID" ] && kill "$DROPBEAR_PID" 2>/dev/null || true
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
    [ -n "$MARIADB_PID" ] && kill "$MARIADB_PID" 2>/dev/null || true
    if [ "$code" -ne 0 ]; then
        echo "ERROR: start.sh exiting with code $code"
        report_error "start.sh exited with code $code"
    fi
    exit "$code"
}
trap finish EXIT INT TERM

# =========================================================================
# Phase 1 — minimal deps, SSH, and the tunnel. Keep this fast and reliable so
# the deployment is reachable before the heavy install runs.
# =========================================================================
send_log "Phase 1: installing SSH + tunnel deps (dropbear, python3, build tools)"
apt-get install -y dropbear gcc libc6-dev python3 python3-cryptography ca-certificates

# --- getifaddrs shim (PRoot has no real interfaces; fake a loopback) ---
if [ ! -f "$GETIFADDRS_OVERRIDE_SO" ]; then
    mkdir -p "$(dirname "$GETIFADDRS_OVERRIDE_SO")"
    gcc -shared -fPIC -o "$GETIFADDRS_OVERRIDE_SO" "$SCRIPT_DIR/getifaddrs_override.c"
fi
export LD_PRELOAD="$GETIFADDRS_OVERRIDE_SO"

# --- SSH (dropbear) on 127.0.0.1:2222 (the tunnel's SECONDARY connection forwards this) ---
# Login shells get the getifaddrs shim and the deployment env so the SSH session
# behaves like the entrypoint (no systemd here, so we seed /etc/profile.d directly).
mkdir -p /etc/profile.d
echo "export LD_PRELOAD=$GETIFADDRS_OVERRIDE_SO" > /etc/profile.d/ifaddrs-shim.sh
env | sed 's/^/export /' > /etc/profile.d/acurast-env.sh

echo "root:${SSH_PASSWORD:-password}" | chpasswd
mkdir -p /etc/dropbear
dropbearkey -t rsa -f /etc/dropbear/dropbear_rsa_host_key 2>/dev/null || true
dropbearkey -t ecdsa -f /etc/dropbear/dropbear_ecdsa_host_key 2>/dev/null || true

send_log "Starting SSH (dropbear) on 127.0.0.1:2222"
dropbear -F -E -p 2222 -R &
DROPBEAR_PID=$!

# Start the tunnel now — the SSH (secondary) connection becomes reachable
# immediately; the WordPress (primary) connection starts serving once Apache
# binds 8080 in phase 2.
send_log "SSH up, starting Acurast reverse tunnel"
python3 "$SCRIPT_DIR/tunnel.py" &
TUNNEL_PID=$!

# =========================================================================
# Phase 2 — the WordPress stack. Runs with `set +e`: any failure (or hang) must
# NOT tear down SSH + the tunnel, so you can always SSH in (secondary connection)
# to inspect. fail_keep_alive reports the problem then blocks on the tunnel,
# leaving dropbear reachable for debugging.
# =========================================================================
set +e

fail_keep_alive() {
    report_error "$1 — SSH in over the secondary tunnel to debug; SSH + tunnel left running."
    send_log "Phase 2 failed; keeping SSH + tunnel alive for debugging"
    wait "$TUNNEL_PID"
    exit 1
}

send_log "Phase 2: installing WordPress stack (Apache + PHP + MariaDB)"
apt-get install -y apache2 libapache2-mod-php php php-mysql php-xml php-curl php-gd \
    mariadb-server || fail_keep_alive "apt install of WordPress stack failed"

# --- MariaDB (no systemd in the rootfs; run mariadbd directly) ---
send_log "Initializing MariaDB"
id mysql >/dev/null 2>&1 || useradd --system --home-dir /var/lib/mysql --shell /usr/sbin/nologin mysql 2>/dev/null || true
mkdir -p /var/lib/mysql /run/mysqld
chown -R mysql:mysql /var/lib/mysql /run/mysqld

if [ ! -d /var/lib/mysql/mysql ]; then
    mariadb-install-db --user=mysql --datadir=/var/lib/mysql \
        --auth-root-authentication-method=normal >/tmp/mariadb-install.log 2>&1 \
        || fail_keep_alive "mariadb-install-db failed: $(tail -c 400 /tmp/mariadb-install.log | tr -d '\"')"
fi

mariadbd --user=mysql --datadir=/var/lib/mysql --socket="$PGSOCK" \
    --bind-address=127.0.0.1 --port=3306 >/tmp/mariadb.log 2>&1 &
MARIADB_PID=$!

# Wait for the socket to accept connections.
ATTEMPTS=0
until mysqladmin --socket="$PGSOCK" ping >/dev/null 2>&1; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ $ATTEMPTS -ge 60 ]; then
        fail_keep_alive "MariaDB did not become ready: $(tail -c 400 /tmp/mariadb.log | tr -d '\"')"
    fi
    sleep 1
done

send_log "Creating WordPress database and user"
mysql --socket="$PGSOCK" <<SQL || fail_keep_alive "DB/user creation failed"
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'127.0.0.1';
GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL

# --- WordPress core ---
if [ ! -f /var/www/html/wp-settings.php ]; then
    send_log "Downloading WordPress"
    curl -fsSL https://wordpress.org/latest.tar.gz -o /tmp/wp.tar.gz \
        || fail_keep_alive "WordPress download failed"
    rm -f /var/www/html/index.html
    tar -xzf /tmp/wp.tar.gz -C /tmp || fail_keep_alive "WordPress extract failed"
    cp -a /tmp/wordpress/. /var/www/html/
    rm -rf /tmp/wordpress /tmp/wp.tar.gz
fi

# Our wp-config.php (DB creds from env, dynamic site URL) + fresh salts.
cp "$SCRIPT_DIR/wp-config.php" /var/www/html/wp-config.php
if ! grep -q 'AUTH_KEY' /var/www/html/wp-config.php; then
    SALTS="$(curl -fsSL https://api.wordpress.org/secret-key/1.1/salt/ || true)"
    if [ -n "$SALTS" ]; then
        printf '\n%s\n' "$SALTS" >> /var/www/html/wp-config.php
    fi
fi
chown -R www-data:www-data /var/www/html

# --- Apache on 127.0.0.1:8080 (the tunnel's PRIMARY connection forwards this) ---
send_log "Starting Apache on 127.0.0.1:${WEB_PORT}"
printf 'Listen 127.0.0.1:%s\n' "$WEB_PORT" > /etc/apache2/ports.conf
cat > /etc/apache2/sites-available/000-default.conf <<VHOST
<VirtualHost 127.0.0.1:${WEB_PORT}>
    DocumentRoot /var/www/html
    <Directory /var/www/html>
        AllowOverride All
        Require all granted
    </Directory>
</VirtualHost>
VHOST
a2enmod rewrite >/dev/null 2>&1 || true

# Apache reads its runtime config from envvars (no systemd here).
. /etc/apache2/envvars
mkdir -p "$APACHE_RUN_DIR" "$APACHE_LOCK_DIR" /var/log/apache2
apache2 -D FOREGROUND &
APACHE_PID=$!

send_log "WordPress stack up; deployment fully live"

# Block on the tunnel; if it dies, tear everything down.
TUNNEL_EXIT=0
wait "$TUNNEL_PID" || TUNNEL_EXIT=$?
if [ "$TUNNEL_EXIT" -ne 0 ]; then
    report_error "tunnel exited with status $TUNNEL_EXIT"
    exit "$TUNNEL_EXIT"
fi

wait "$APACHE_PID"
