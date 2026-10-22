#!/usr/bin/env bash
# Single-host development Ceph only. Never formats an existing or uncertain store.
set -Eeuo pipefail
umask 077
readonly ROOT=/var/lib/neurocenter-ceph
readonly CONF="$ROOT/ceph.conf"
readonly USER_ID=neurocenter-dev

fail() { printf 'Local Ceph: %s\n' "$1" >&2; exit 1; }

if [[ ${1:-} == --health ]]; then
    exec python3 - "$ROOT" <<'PY'
import json, os, pathlib, sys, urllib.error, urllib.request
try:
    root = pathlib.Path(sys.argv[1])
    ready = json.loads((root / 'ready.json').read_text())
    owner = json.loads((root / 'owner.json').read_text())
    assert ready['fsid'] == owner['fsid'] and len(ready['processes']) == 4
    for item in ready['processes']:
        os.kill(item['pid'], 0)
        args = pathlib.Path('/proc/%d/cmdline' % item['pid']).read_bytes()
        assert item['name'].encode() in args and str(root).encode() in args
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        response = opener.open('http://127.0.0.1:9000/', timeout=2)
        assert response.status == 200
        response.close()
    except urllib.error.HTTPError as error:
        assert error.code == 403
except Exception:
    sys.exit(1)
PY
fi

# Keep one lock descriptor across exec, without depending on a platform flock CLI.
if [[ ${1:-} != --locked ]]; then
    [[ $# == 0 ]] || fail 'Unsupported argument'
    exec python3 - "$ROOT" "$0" <<'PY'
import fcntl, os, pathlib, stat, sys
try:
    root = pathlib.Path(sys.argv[1])
    for parent in [*reversed(root.parents), root]:
        if parent.exists() or parent.is_symlink():
            assert stat.S_ISDIR(parent.lstat().st_mode) and not parent.is_symlink()
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd = os.open(root / '.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    assert os.fstat(fd).st_nlink == 1
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    os.dup2(fd, 9, inheritable=True)
    os.execv('/bin/bash', ['/bin/bash', sys.argv[2], '--locked'])
except Exception:
    print('Local Ceph: unsafe state directory or another bootstrap is running', file=sys.stderr)
    sys.exit(1)
PY
fi
python3 -c 'import os; os.fstat(9)' 2>/dev/null || fail 'Bootstrap lock is missing'

PIDS=()
NAMES=()
cleanup() {
    local pid deadline=$((SECONDS + 12))
    rm -f "$ROOT/ready.json"
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill -TERM "$pid" 2>/dev/null || true; done
    while ((SECONDS < deadline)); do
        local alive=0
        for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill -0 "$pid" 2>/dev/null && alive=1; done
        ((alive)) || break
        sleep 0.1
    done
    for pid in ${PIDS[@]+"${PIDS[@]}"}; do kill -KILL "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; done
    rm -f "$ROOT/command.json" "$ROOT/auth.tmp" "$ROOT/registration.json" "$ROOT/conf.tmp"
}
trap cleanup EXIT
trap 'exit 0' TERM INT
rm -f "$ROOT/ready.json"

# Every control command is bounded and its diagnostic output stays private.
run() {
    python3 - "$@" <<'PY'
import subprocess, sys
try:
    result = subprocess.run(sys.argv[1:], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=10)
    if result.returncode:
        sys.exit(1)
    sys.stdout.buffer.write(result.stdout)
except Exception:
    sys.exit(1)
PY
}
admin() { run ceph -c "$CONF" -n client.admin -k "$ROOT/admin.keyring" "$@"; }
alive() {
    local pid
    for pid in "${PIDS[@]}"; do kill -0 "$pid" 2>/dev/null || fail 'A supervised daemon exited'; done
}
start() {
    local name=$1
    shift
    "$@" >>"$ROOT/$name.log" 2>&1 &
    PIDS+=("$!")
    NAMES+=("$name")
}
wait_for() {
    local check=$1 deadline=$((SECONDS + 60))
    until "$check"; do
        alive
        ((SECONDS < deadline)) || fail 'Readiness deadline exceeded'
        sleep 1
    done
}

# Own the volume before creating identities; reject unknown, linked or changed data.
IDENTITY=$(python3 - "$ROOT" "${CHAT_DEV_S3_ACCESS_KEY_FILE:-}" "${CHAT_DEV_S3_SECRET_KEY_FILE:-}" <<'PY'
import hashlib, json, os, pathlib, re, stat, sys, uuid
try:
    root = pathlib.Path(sys.argv[1])
    hashes = []
    for name in sys.argv[2:]:
        file = pathlib.Path(name)
        info = file.lstat()
        assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and 0 < info.st_size <= 4096
        value = file.read_bytes().strip()
        assert re.fullmatch(rb'[A-Za-z0-9/+=_.-]{8,256}', value)
        hashes.append(hashlib.sha256(value).hexdigest())
    owner_file = root / 'owner.json'
    if not owner_file.exists():
        assert set(os.listdir(root)) == {'.lock'}
        owner = dict(schemaVersion=1, fsid=str(uuid.uuid4()), osdUuid=str(uuid.uuid4()), keyHashes=hashes)
        with owner_file.open('x') as output:
            json.dump(owner, output)
            output.flush()
            os.fsync(output.fileno())
    else:
        info = owner_file.lstat()
        assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= 4096
        owner = json.loads(owner_file.read_text())
        assert owner['schemaVersion'] == 1 and owner['keyHashes'] == hashes
        assert str(uuid.UUID(owner['fsid'])) == owner['fsid'] and str(uuid.UUID(owner['osdUuid'])) == owner['osdUuid']
    for file in root.iterdir():
        assert not file.is_symlink()
        assert file.is_dir() or file.lstat().st_nlink == 1
    for directory in ['mon', 'osd', 'mgr', 'rgw']:
        (root / directory).mkdir(mode=0o700, exist_ok=True)
        assert (root / directory).is_dir() and not (root / directory).is_symlink()
    for name in ['ceph.conf', 'admin.keyring', 'mon.keyring', 'mgr/keyring', 'rgw/keyring', 'osd/keyring', 'osd/block', 'osd/fsid', 'osd/ceph_fsid']:
        file = root / name
        if file.exists() or file.is_symlink():
            info = file.lstat()
            assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1
    assert not (root / 'mon/store.db').is_symlink()
    print(owner['fsid'], owner['osdUuid'])
except Exception:
    print('Local Ceph: foreign, incomplete or changed volume/secret identity; preserved without formatting', file=sys.stderr)
    sys.exit(1)
PY
) || exit 1
read -r FSID OSD_UUID <<<"$IDENTITY"

cat >"$ROOT/conf.tmp" <<EOF
[global]
fsid = $FSID
setuser = root
setgroup = root
mon host = 127.0.0.1
public network = 127.0.0.0/8
cluster network = 127.0.0.0/8
auth cluster required = cephx
auth service required = cephx
auth client required = cephx
osd pool default size = 1
osd pool default min size = 1
osd pool default pg num = 8
osd pool default pgp num = 8
osd pool default pg autoscale mode = off
osd memory target = 1073741824
bluestore block size = 4294967296
bluestore block preallocate file = false
log to file = false
log to stderr = true
admin socket = $ROOT/\$name.asok
[client.admin]
keyring = $ROOT/admin.keyring
[mon.a]
mon data = $ROOT/mon
keyring = $ROOT/mon.keyring
mon initial members = a
mon allow pool delete = false
mon cluster log to file = false
mon cluster log to stderr = true
[mgr.a]
mgr data = $ROOT/mgr
keyring = $ROOT/mgr/keyring
[osd.0]
osd data = $ROOT/osd
keyring = $ROOT/osd/keyring
[client.rgw.dev]
keyring = $ROOT/rgw/keyring
rgw data = $ROOT/rgw
rgw frontends = beast endpoint=0.0.0.0:9000
rgw enable apis = s3
rgw thread pool size = 16
EOF
if [[ -e "$CONF" ]]; then
    cmp -s "$CONF" "$ROOT/conf.tmp" || fail 'Existing daemon configuration changed; preserved'
    rm -f "$ROOT/conf.tmp"
else
    mv "$ROOT/conf.tmp" "$CONF"
fi

if [[ ! -f "$ROOT/mon.complete" ]]; then
    [[ ! -e "$ROOT/mon.attempted" && ! -e "$ROOT/mon/store.db" ]] || fail 'Uncertain MON initialization preserved; refusing to format again'
    [[ -f "$ROOT/admin.keyring" ]] || run ceph-authtool --create-keyring "$ROOT/admin.keyring" --gen-key -n client.admin --cap mon 'allow *' --cap osd 'allow *' --cap mgr 'allow *' --cap mds 'allow *' >/dev/null || fail 'Admin key initialization failed'
    [[ -f "$ROOT/mon.keyring" ]] || run ceph-authtool --create-keyring "$ROOT/mon.keyring" --gen-key -n mon. >/dev/null || fail 'Monitor key initialization failed'
    run ceph-authtool "$ROOT/mon.keyring" --import-keyring "$ROOT/admin.keyring" >/dev/null || fail 'Monitor key import failed'
    run monmaptool --create --enable-all-features --add a 127.0.0.1 --fsid "$FSID" "$ROOT/monmap" >/dev/null || fail 'Monitor map initialization failed'
    : >"$ROOT/mon.attempted"
    run ceph-mon -c "$CONF" --mkfs -i a --monmap "$ROOT/monmap" --keyring "$ROOT/mon.keyring" >/dev/null || fail 'Monitor initialization failed; state preserved'
    [[ -d "$ROOT/mon/store.db" ]] || fail 'Monitor initialization did not produce a store'
    : >"$ROOT/mon.complete"
fi
[[ -d "$ROOT/mon/store.db" ]] || fail 'Previously initialized monitor store is missing'
start mon ceph-mon -c "$CONF" -f -i a
mon_ready() {
    admin status --format json >"$ROOT/command.json" || return 1
    python3 - "$ROOT/command.json" "$FSID" <<'PY'
import json, sys
sys.exit(0 if json.load(open(sys.argv[1])).get('fsid') == sys.argv[2] else 1)
PY
}
wait_for mon_ready

# get-or-create preserves cluster keys; compare a local key rather than replacing it.
auth_key() {
    local entity=$1 file=$2 current candidate
    shift 2
    admin auth get-or-create "$entity" "$@" -o "$ROOT/auth.tmp" >/dev/null || fail 'Daemon authorization failed'
    if [[ -e "$file" ]]; then
        current=$(run ceph-authtool "$file" -n "$entity" --print-key) || fail 'Existing daemon key is unreadable; preserved'
        candidate=$(run ceph-authtool "$ROOT/auth.tmp" -n "$entity" --print-key) || fail 'Cluster daemon key is unreadable; preserved'
        [[ -n "$current" && "$current" == "$candidate" ]] || fail 'Existing daemon key differs; preserved'
        rm -f "$ROOT/auth.tmp"
    else
        mv "$ROOT/auth.tmp" "$file"
    fi
}
auth_key mgr.a "$ROOT/mgr/keyring" mon 'profile mgr' osd 'allow *' mds 'allow *'
start mgr ceph-mgr -c "$CONF" -f -i a

if [[ ! -f "$ROOT/osd.complete" ]]; then
    [[ ! -e "$ROOT/osd.attempted" && ! -e "$ROOT/osd/block" && ! -e "$ROOT/osd/fsid" ]] || fail 'Uncertain OSD initialization preserved; refusing to format again'
    [[ -f "$ROOT/osd/keyring" ]] || run ceph-authtool --create-keyring "$ROOT/osd/keyring" --gen-key -n osd.0 >/dev/null || fail 'OSD key initialization failed'
    run ceph-authtool "$ROOT/osd/keyring" -n osd.0 --print-key | python3 -c 'import json,sys;json.dump({"cephx_secret":sys.stdin.read().strip()},sys.stdout)' >"$ROOT/registration.json"
    [[ $(admin osd new "$OSD_UUID" -i "$ROOT/registration.json") == 0 ]] || fail 'Unexpected OSD registration; state preserved'
    : >"$ROOT/osd.attempted"
    run ceph-osd -c "$CONF" --mkfs -i 0 --osd-uuid "$OSD_UUID" >/dev/null || fail 'OSD initialization failed; state preserved'
    : >"$ROOT/osd.complete"
fi
python3 - "$ROOT" "$FSID" "$OSD_UUID" <<'PY' || fail 'Existing OSD identity or block file is invalid; preserved'
import pathlib, stat, sys
root = pathlib.Path(sys.argv[1]) / 'osd'
info = (root / 'block').lstat()
assert stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size == 4294967296
assert (root / 'ceph_fsid').read_text().strip() == sys.argv[2]
assert (root / 'fsid').read_text().strip() == sys.argv[3]
PY
admin osd crush add 0 1.0 host=neurocenter-dev root=default >/dev/null || fail 'OSD placement failed'
start osd ceph-osd -c "$CONF" -f -i 0
osd_ready() {
    admin osd stat --format json >"$ROOT/command.json" || return 1
    python3 -c 'import json,sys;s=json.load(open(sys.argv[1]));sys.exit(0 if s.get("num_up_osds")==1 and s.get("num_in_osds")==1 else 1)' "$ROOT/command.json"
}
wait_for osd_ready
auth_key client.rgw.dev "$ROOT/rgw/keyring" mon 'allow rw' osd 'allow rwx'

# radosgw-admin has no S3 secret-file option. Only this short-lived child sees argv keys.
python3 - "$ROOT" "$CONF" "$USER_ID" "$CHAT_DEV_S3_ACCESS_KEY_FILE" "$CHAT_DEV_S3_SECRET_KEY_FILE" <<'PY' || fail 'RGW user verification failed; supplied keys were not rotated'
import hashlib, hmac, json, pathlib, subprocess, sys, time
root, conf, uid, access_file, secret_file = sys.argv[1:]
args = ['radosgw-admin', '-c', conf, '-n', 'client.admin', '-k', root + '/admin.keyring']
deadline = time.monotonic() + 20
stage, status = 'credential-admission', None
def command(extra):
    with open(root + '/command.json', 'w+b') as output:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise subprocess.TimeoutExpired('radosgw-admin', 20)
        result = subprocess.run(args + extra, stdout=output, stderr=subprocess.DEVNULL, timeout=remaining)
        output.seek(0)
        return result.returncode, output.read()
try:
    access, secret = [pathlib.Path(file).read_text().strip() for file in [access_file, secret_file]]
    assert json.loads(pathlib.Path(root + '/owner.json').read_text())['keyHashes'] == [hashlib.sha256(value.encode()).hexdigest() for value in [access, secret]]
    stage = 'user-info'
    status, data = command(['user', 'info', '--uid=' + uid, '--format=json'])
    if status == 22 and not pathlib.Path(root + '/user.complete').exists():
        stage = 'user-absence-proof'
        status, data = command(['metadata', 'get', 'user:' + uid, '--format=json'])
        assert status == 2
        stage = 'user-create'
        status, data = command(['user', 'create', '--uid=' + uid, '--display-name=Neurocenter development', '--access-key=' + access, '--secret-key=' + secret, '--format=json'])
    assert status == 0
    stage, status = 'JSON-decoding', None
    user = json.loads(data)
    stage = 'user-identity'
    assert user['user_id'] == uid
    stage = 'key-shape'
    assert len(user['keys']) == 1
    stage = 'key-match'
    assert hmac.compare_digest(user['keys'][0]['access_key'], access) and hmac.compare_digest(user['keys'][0]['secret_key'], secret)
    pathlib.Path(root + '/user.complete').touch(mode=0o600)
except subprocess.TimeoutExpired:
    print('Local Ceph: RGW ' + stage + ' timed out', file=sys.stderr)
    sys.exit(1)
except Exception:
    print('Local Ceph: RGW ' + stage + ' failed' + (' (exit %d)' % status if status is not None else ''), file=sys.stderr)
    sys.exit(1)
finally:
    pathlib.Path(root + '/command.json').unlink(missing_ok=True)
PY
start rgw radosgw -c "$CONF" -f -n client.rgw.dev
rgw_ready() {
    python3 - <<'PY'
import sys, urllib.error, urllib.request
try:
    response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open('http://127.0.0.1:9000/', timeout=2)
    response.close()
except urllib.error.HTTPError as error:
    sys.exit(0 if error.code == 403 else 1)
except Exception:
    sys.exit(1)
PY
}
wait_for rgw_ready
alive
python3 - "$ROOT" "$FSID" "${NAMES[@]}" "${PIDS[@]}" <<'PY'
import json, pathlib, sys
json.dump(dict(fsid=sys.argv[2], processes=[dict(name=n, pid=int(p)) for n,p in zip(sys.argv[3:7],sys.argv[7:11])]), open(sys.argv[1] + '/ready.json', 'w'))
PY
printf 'Local Ceph: RGW ready for authenticated S3 provisioning\n'
while true; do alive; sleep 1; done
