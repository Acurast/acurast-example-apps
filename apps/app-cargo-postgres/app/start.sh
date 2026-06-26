#!/bin/sh

# Cargo entrypoint: runs PostgreSQL + a browser SQL console inside the proot
# rootfs and exposes them over the Acurast reverse tunnel's two connections —
# PRIMARY (Let's Encrypt) forwards the web SQL console, SECONDARY (self-signed)
# forwards dropbear SSH (for shell / native psql via `ssh -L 5432`).
#
# Setup is split into two phases on purpose: phase 1 installs the minimal deps,
# brings up SSH, and starts the tunnel FIRST, so if the heavier Postgres install
# in phase 2 stalls or fails (postinst under proot is the usual hot spot) you can
# still SSH into the machine and debug it live.

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
SYSV_SHM_SO=/usr/local/lib/libsysv_shm_override.so

POSTGRES_USER="${POSTGRES_USER:-postgres}"
POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-postgres}"
POSTGRES_DB="${POSTGRES_DB:-postgres}"
PGDATA=/var/lib/postgresql/data
PGPORT=5432
PGSOCKET=/tmp/pgsocket
WEB_PORT="${WEB_PORT:-8080}"

DROPBEAR_PID=""
TUNNEL_PID=""
POSTGRES_PID=""
WEBADMIN_PID=""

apt-get update
if ! command -v curl >/dev/null 2>&1; then apt-get install -y curl; fi

. "$SCRIPT_DIR/callback.sh"

finish() {
    code=$?
    [ -n "$DROPBEAR_PID" ] && kill "$DROPBEAR_PID" 2>/dev/null || true
    [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true
    [ -n "$WEBADMIN_PID" ] && kill "$WEBADMIN_PID" 2>/dev/null || true
    [ -n "$POSTGRES_PID" ] && kill "$POSTGRES_PID" 2>/dev/null || true
    exit "$code"
}
trap finish INT TERM EXIT

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
# immediately; the web SQL console (primary) starts serving once webadmin binds
# WEB_PORT in phase 2.
send_log "SSH up, starting Acurast reverse tunnel"
python3 "$SCRIPT_DIR/tunnel.py" &
TUNNEL_PID=$!

# =========================================================================
# Phase 2 — PostgreSQL + the web SQL console. Any failure (or hang) must NOT tear
# down SSH + the tunnel, so you can always SSH in (secondary connection) to
# inspect. fail_keep_alive reports the problem then blocks on the tunnel.
# =========================================================================
fail_keep_alive() {
    report_error "$1 — SSH in over the secondary tunnel to debug; SSH + tunnel left running."
    send_log "Phase 2 failed; keeping SSH + tunnel alive for debugging"
    wait "$TUNNEL_PID"
    exit 1
}

# === PostgreSQL setup ===
# Postgres listens on loopback only; reached either by the web console (primary)
# or by forwarding 5432 over the SSH session (secondary, `ssh -L`).
send_log "Phase 2: installing PostgreSQL"
if [ -z "$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null)" ]; then
    apt-get install -y postgresql || fail_keep_alive "apt install of postgresql failed"
fi

PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
if [ -z "$PG_BIN" ]; then
    fail_keep_alive "Could not locate PostgreSQL binaries"
fi

# The package postinst does not reliably create the postgres system user inside
# the proot rootfs. Postgres refuses to run as root, so ensure the user exists.
if ! id postgres >/dev/null 2>&1; then
    send_log "Creating postgres system user"
    groupadd --system postgres 2>/dev/null || addgroup --system postgres 2>/dev/null || true
    useradd --system --gid postgres --home-dir /var/lib/postgresql \
        --shell /bin/bash postgres 2>/dev/null \
        || adduser --system --ingroup postgres --home /var/lib/postgresql \
             --shell /bin/bash postgres 2>/dev/null \
        || true
fi
if ! id postgres >/dev/null 2>&1; then
    fail_keep_alive "Could not create postgres user"
fi
mkdir -p /var/lib/postgresql
chown postgres:postgres /var/lib/postgresql

# The sandbox kernel does not implement SysV shared memory (shmget => ENOSYS),
# which PostgreSQL requires for its data-directory interlock. Build a shim that
# emulates it with anonymous shared mmap and inject it via LD_PRELOAD.
if [ ! -f "$SYSV_SHM_SO" ]; then
    mkdir -p "$(dirname "$SYSV_SHM_SO")"
    gcc -shared -fPIC -o "$SYSV_SHM_SO" "$SCRIPT_DIR/sysv_shm_override.c" \
        || fail_keep_alive "Failed to build SysV shm shim"
fi

# Initialize the data directory if empty
if [ ! -s "$PGDATA/PG_VERSION" ]; then
    send_log "Initializing PostgreSQL database"
    mkdir -p "$PGDATA"
    chown -R postgres:postgres "$(dirname "$PGDATA")"

    # Local (unix socket) connections trust; TCP connections require a password.
    # --locale=C avoids initdb aborting on missing locales in the minimal rootfs.
    INITLOG=/tmp/initdb.log
    su postgres -c "LD_PRELOAD='$SYSV_SHM_SO' $PG_BIN/initdb -D '$PGDATA' \
        --username='$POSTGRES_USER' \
        --auth-local=trust \
        --auth-host=scram-sha-256 \
        --encoding=UTF8 \
        --locale=C" > "$INITLOG" 2>&1

    if [ ! -s "$PGDATA/PG_VERSION" ]; then
        fail_keep_alive "initdb failed: $(tail -n 20 "$INITLOG" 2>/dev/null | tr '\n' ' ' | tr '"' "'")"
    fi
fi

send_log "Starting PostgreSQL on 127.0.0.1:${PGPORT}"

# The default unix_socket_directories (/var/run/postgresql) often does not exist
# inside the proot rootfs; point it at a writable dir so startup does not abort.
mkdir -p "$PGSOCKET"
chown postgres:postgres "$PGSOCKET"

PGLOG=/tmp/postgres.log
# dynamic_shared_memory_type=mmap keeps runtime DSM off SysV/POSIX shm too.
su postgres -c "LD_PRELOAD='$SYSV_SHM_SO' $PG_BIN/postgres -D '$PGDATA' \
    -c listen_addresses='127.0.0.1' \
    -c port=${PGPORT} \
    -c unix_socket_directories='$PGSOCKET' \
    -c dynamic_shared_memory_type=mmap" > "$PGLOG" 2>&1 &
POSTGRES_PID=$!

# Wait for PostgreSQL to accept connections (over the unix socket, no auth needed)
ATTEMPTS=0
until su postgres -c "$PG_BIN/pg_isready -h '$PGSOCKET' -p ${PGPORT}" >/dev/null 2>&1; do
    ATTEMPTS=$((ATTEMPTS + 1))
    if [ $ATTEMPTS -ge 30 ]; then
        fail_keep_alive "PostgreSQL did not become ready: $(tail -n 20 "$PGLOG" 2>/dev/null | tr '\n' ' ' | tr '"' "'")"
    fi
    sleep 1
done

# Set the superuser password for TCP (scram) connections, over the trust socket.
SQLFILE=/tmp/setpw.sql
printf "ALTER ROLE \"%s\" WITH PASSWORD '%s';\n" "$POSTGRES_USER" "$POSTGRES_PASSWORD" > "$SQLFILE"
chown postgres:postgres "$SQLFILE"
su postgres -c "$PG_BIN/psql -h '$PGSOCKET' -p ${PGPORT} -U '$POSTGRES_USER' -d postgres -f '$SQLFILE'"
rm -f "$SQLFILE"

# Create the application database if it does not already exist
if [ "$POSTGRES_DB" != "$POSTGRES_USER" ] && [ "$POSTGRES_DB" != "postgres" ]; then
    if ! su postgres -c "$PG_BIN/psql -h '$PGSOCKET' -p ${PGPORT} -U '$POSTGRES_USER' -d postgres -tAc \"SELECT 1 FROM pg_database WHERE datname='$POSTGRES_DB'\"" | grep -q 1; then
        su postgres -c "$PG_BIN/createdb -h '$PGSOCKET' -p ${PGPORT} -U '$POSTGRES_USER' '$POSTGRES_DB'"
    fi
fi

send_log "PostgreSQL ready (db=${POSTGRES_DB}, user=${POSTGRES_USER})"

# === Web SQL console ===
# A tiny, INSECURE browser UI for running SQL against the local Postgres. This is
# the port the tunnel's PRIMARY connection forwards. No auth — disposable DBs only.
send_log "Starting web SQL console on 127.0.0.1:${WEB_PORT}"
WEB_PORT="$WEB_PORT" PGSOCKET="$PGSOCKET" PGPORT="$PGPORT" \
    POSTGRES_USER="$POSTGRES_USER" POSTGRES_DB="$POSTGRES_DB" \
    python3 "$SCRIPT_DIR/webadmin.py" &
WEBADMIN_PID=$!

send_log "Deployment fully live (web console + SSH)"

# Block on the tunnel; if it dies, tear everything down.
wait "$TUNNEL_PID"
TUNNEL_EXIT=$?
if [ "$TUNNEL_EXIT" -ne 0 ]; then
    report_error "tunnel exited with status $TUNNEL_EXIT"
    exit "$TUNNEL_EXIT"
fi

wait "$DROPBEAR_PID"
