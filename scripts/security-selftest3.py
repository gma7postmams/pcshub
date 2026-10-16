#!/usr/bin/env python3
# Live self-test, part 3: encrypted backups (create, verify, download, upload + analyse, restore), the protected audit trail,
# and sessions ended by admin actions. Run ONLY against a throw-away test copy started with BACKUP_ENC_KEY and BACKUP_DIR set:
#   BASE=http://localhost:3058 ADMIN_PW=... ED_PW=... DB_URL=postgresql://... BACKUP_DIR=... python3 scripts/security-selftest3.py
import os, sys, time, glob, subprocess, requests

B = os.environ.get('BASE', 'http://localhost:3058')
ADMIN_PW = os.environ.get('ADMIN_PW', 'Test-Pass-12345!x')
ED_PW = os.environ.get('ED_PW', 'Edit-Pass-12345!x')
DB = os.environ.get('DB_URL', 'postgresql://ph:phtmp123@localhost/phtest')
BK = os.environ['BACKUP_DIR']
XH = {'X-Requested-With': 'PromoHub'}
fails = []

def rec(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' :: ' + str(detail)[:160] if detail else ''))
    if not ok: fails.append(name)

def sql(q):
    return subprocess.run(['psql', DB, '-Atc', q], capture_output=True, text=True).stdout.strip()

def sess(u, p):
    s = requests.Session(); s.headers.update(XH)
    return s, s.post(B + '/api/auth/login', json={'username': u, 'password': p})

def wait_job(s, jid, timeout=180):
    t = time.time()
    while time.time() - t < timeout:
        j = s.get(B + '/api/admin/backups/jobs/' + jid).json().get('job') or {}
        if j.get('status') in ('succeeded', 'failed'): return j
        time.sleep(1)
    return {}

sql("update users set failed_attempts=0, locked_until=null, must_change_password=false")
adm, r = sess('admin', ADMIN_PW); assert r.status_code == 200, r.text

# ---- 1. encrypted backup
r = adm.post(B + '/api/admin/backups', json={'note': 'selftest'})
jid = (r.json().get('job') or {}).get('id')
job = wait_job(adm, jid) if jid else {}
rec('backup created', job.get('status') == 'succeeded', job.get('error') or r.text[:120])
fn = job.get('filename') or ''
rec('file name says encrypted (.zip.enc)', fn.endswith('.zip.enc'), fn)
files = [f for f in glob.glob(os.path.join(BK, '**', fn), recursive=True) if fn and os.path.isfile(f)]
raw = open(files[0], 'rb').read() if files else b''
rec('stored file starts with the encryption header', raw[:8] == b'PCHBENC1', raw[:8])
rec('stored file holds no readable data (no zip header, no table names)', b'PK\x03\x04' not in raw[:4096] and b'password_hash' not in raw and b'audit_logs' not in raw)
v = adm.post(B + '/api/admin/backups/%s/verify' % jid, json={'password': ADMIN_PW})
rep = (v.json().get('report') or {})
bad = [c.get('check') for c in rep.get('checks', []) if c.get('status') == 'fail']
rec('verify reads it back through the decryption (every check passes, signature valid)', v.status_code == 200 and rep.get('status') == 'ok' and not bad and rep.get('signature') == 'valid', bad or rep.get('status'))
t = adm.post(B + '/api/admin/backups/%s/download-token' % jid, json={'password': ADMIN_PW}).json().get('token')
d = adm.get(B + '/api/admin/backups/%s/download?t=%s' % (jid, t)) if t else None
rec('download is the encrypted file', d is not None and d.content[:8] == b'PCHBENC1', d.status_code if d is not None else 'no token')

# tampered upload is refused
if d is not None and d.status_code == 200:
    bad = bytearray(d.content); bad[len(bad) // 2] ^= 1
    a = adm.post(B + '/api/admin/backups/analyze', files={'file': ('tampered.zip.enc', bytes(bad), 'application/octet-stream')})
    aj = a.json()
    an = aj.get('analysis') or aj
    if an.get('id') and an.get('status') not in ('ready', 'failed', 'blocked'):
        for _ in range(60):
            an = adm.get(B + '/api/analyses/%s' % an['id']).json().get('analysis', an) if False else adm.get(B + '/api/admin/backups/analyses/%s' % an['id']).json().get('analysis', an)
            if an.get('status') not in ('pending', 'running', 'analyzing'): break
            time.sleep(1)
    rec('tampered encrypted backup refused at analysis', 'wrong BACKUP_ENC_KEY' in str(aj) + str(an) or 'changed' in str(an), str(an)[:200])
    if an.get('id'): adm.delete(B + '/api/admin/backups/analyses/%s' % an['id'])

    # good upload -> analyse -> restore
    marker = 'selftest-marker-%d' % int(time.time())
    a = adm.post(B + '/api/admin/backups/analyze', files={'file': (fn, d.content, 'application/octet-stream')})
    an = a.json().get('analysis') or a.json()
    for _ in range(180):
        if not an.get('id') or an.get('status') != 'running': break
        time.sleep(1)
        an = adm.get(B + '/api/admin/backups/analyses/%s' % an.get('id')).json().get('analysis', an)
    state = ((an.get('report') or {}).get('readiness') or {}).get('state') or an.get('status')
    rec('encrypted upload analysed', state in ('ready', 'caution'), str(an)[:200])
    if state in ('ready', 'caution'):
        sql("insert into app_settings (key, value) values ('%s','x') on conflict do nothing" % marker)
        rr = adm.post(B + '/api/admin/backups/restore', json={'analysisId': an['id'], 'password': ADMIN_PW, 'confirm': 'RESTORE', 'acknowledgeRisk': True})
        rj = rr.json(); rid = (rj.get('job') or {}).get('id')
        if rr.status_code != 202: rec('restore accepted', False, rr.text)
        else:
            for _ in range(240):
                time.sleep(1)
                try:
                    s2, lr = sess('admin', ADMIN_PW)
                    if lr.status_code == 200:
                        j = s2.get(B + '/api/admin/backups/jobs/' + rid).json().get('job') or {}
                        if j.get('status') in ('succeeded', 'failed'): break
                except Exception: pass
            rec('restore from the encrypted backup succeeded', j.get('status') == 'succeeded', j.get('error') or j.get('status'))
            rec('data is back to the backup (marker added after it is gone)', sql("select count(*) from app_settings where key='%s'" % marker) == '0')
            adm = s2

# ---- 2. protected audit trail
sql("insert into audit_logs (action, details, created_at) values ('auth.login_failed','{\"selftest\":1}', now() - interval '2 days'), ('ingest.update','{\"selftest\":1}', now() - interval '2 days')")
cl = adm.post(B + '/api/admin/clear-data', json={'areas': ['audit'], 'from': '2000-01-01', 'to': time.strftime('%Y-%m-%d', time.gmtime(time.time() - 86400)), 'password': ADMIN_PW, 'confirm': 'DELETE'})
kept = sql("select string_agg(action, ',') from audit_logs where details->>'selftest'='1'")
rec('Clear Data kept the sign-in line, removed the ordinary one', cl.status_code == 200 and kept == 'auth.login_failed', '%s %s' % (cl.status_code, kept or cl.text[:120]))
sql("delete from audit_logs where details->>'selftest'='1'")

# ---- 4. sessions end on admin actions
edid = sql("select id from users where username='ed'")
ed, r = sess('ed', ED_PW)
adm.post(B + '/api/admin/users/%s/reset-2fa' % edid, json={})
rec('reset 2FA signs the user out', ed.get(B + '/api/auth/me').status_code == 401)
ed, r = sess('ed', ED_PW)
fp = adm.post(B + '/api/admin/security/force-password-change', json={})
rec('"everyone change password" signs others out', fp.status_code == 200 and ed.get(B + '/api/auth/me').status_code == 401, fp.text[:100])
rec('...but not the admin doing it', adm.get(B + '/api/auth/me').status_code == 200)
sql("update users set must_change_password=false")

print('\n%d failed' % len(fails)); sys.exit(1 if fails else 0)
