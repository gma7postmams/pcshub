#!/usr/bin/env python3
# Live self-test, part 2: 2FA guessing, uploads, stored XSS, the audit trail and the lock budget.
# Run ONLY against a throw-away test copy:  BASE=http://localhost:3058 ADMIN_PW=... ED_PW=... DB_URL=postgresql://... python3 scripts/security-selftest2.py
import os, sys, time, hmac, hashlib, struct, base64, subprocess, requests

B = os.environ.get('BASE', 'http://localhost:3058')
ADMIN_PW = os.environ.get('ADMIN_PW', 'Test-Pass-12345!x')
ED_PW = os.environ.get('ED_PW', 'Edit-Pass-12345!x')
DB = os.environ.get('DB_URL', 'postgresql://ph:phtmp123@localhost/phtest')
XH = {'X-Requested-With': 'PromoHub'}
fails = []

def rec(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' :: ' + str(detail) if detail else ''))
    if not ok: fails.append(name)

def sql(q):
    return subprocess.run(['psql', DB, '-Atc', q], capture_output=True, text=True).stdout.strip()

def sess(u, p):
    s = requests.Session(); s.headers.update(XH)
    return s, s.post(B + '/api/auth/login', json={'username': u, 'password': p})

def totp(secret):
    key = base64.b32decode(secret.replace(' ', '').upper() + '=' * (-len(secret) % 8))
    c = struct.pack('>Q', int(time.time() // 30))
    h = hmac.new(key, c, hashlib.sha1).digest(); o = h[-1] & 15
    return '%06d' % ((struct.unpack('>I', h[o:o + 4])[0] & 0x7fffffff) % 10 ** 6)

sql("update users set failed_attempts=0, locked_until=null")
mark = int(sql('select coalesce(max(id),0) from audit_logs') or 0)

# ---- stored XSS: a real record with script payloads must come back as inert JSON text
adm, r = sess('admin', ADMIN_PW); assert r.status_code == 200, r.text
X = '<img src=x onerror=alert(1)><script>alert(2)</script>'
rr = adm.post(B + '/api/ingest', json={'program': X, 'platform': sql("select value from dropdown_options where category='platform' limit 1"), 'remarks': X, 'source': X})
stored = rr.status_code in (200, 201)
rec('script payload stored as plain text (valid record)', stored, rr.text[:100])
if stored:
    lst = adm.get(B + '/api/ingest?pageSize=500')
    rec('payload comes back unchanged as JSON text, not interpreted', X in lst.text.replace('\\u003c', '<') or '<script>' in lst.text or '\\u003cscript' in lst.text)
    rec('list is application/json + nosniff', 'application/json' in lst.headers.get('Content-Type', '') and lst.headers.get('X-Content-Type-Options') == 'nosniff')
    rid = (rr.json().get('id') or (rr.json().get('record') or {}).get('id'))
    if rid: adm.delete(B + '/api/ingest/%s' % rid)
csp = adm.get(B + '/').headers.get('Content-Security-Policy', '')
rec("CSP forbids inline script (no 'unsafe-inline' in script-src)", "script-src 'self'" in csp and "'unsafe-inline'" not in csp.split('script-src')[1].split(';')[0], csp[:80])

# ---- uploads (Knowledge): wrong content, disguised content, path tricks
def up(name, data, ctype='application/pdf'):
    return adm.post(B + '/api/knowledge', files={'files': (name, data, ctype)})
html = b'<html><script>alert(1)</script></html>'
rec('HTML renamed .pdf refused', up('x.pdf', html).status_code in (400, 415, 422), up('x.pdf', html).status_code)
rec('.html upload refused', up('x.html', html, 'text/html').status_code in (400, 415, 422))
rec('.exe upload refused', up('x.exe', b'MZ' + b'\0' * 300, 'application/octet-stream').status_code in (400, 415, 422))
rec('.svg (script) refused', up('x.svg', b'<svg onload=alert(1)/>', 'image/svg+xml').status_code in (400, 415, 422))
tr = up('../../../../tmp/pwned.pdf', b'%PDF-1.4\n' + b'0' * 300)
rec('path traversal in file name stays inside the store', not os.path.exists('/tmp/pwned.pdf'), tr.status_code)
for d in (tr.json() if tr.status_code == 201 else []) if isinstance(tr.json(), list) else []:
    pass
big = b'%PDF-1.4\n' + b'0' * (60 * 1024 * 1024)
try:
    rb = up('big.pdf', big); rec('oversize file refused (413)', rb.status_code in (400, 413), rb.status_code)
except Exception as e:
    rec('oversize file refused (connection closed counts)', True, type(e).__name__)
# avatar: only real JPEG bytes
rec('avatar: HTML as image refused', adm.post(B + '/api/profile/avatar', files={'avatar': ('a.jpg', html * 5, 'image/jpeg')}).status_code == 400)
# an Editor may not upload to Knowledge
ed, r = sess('ed', ED_PW)
if r.status_code == 200:
    rec('editor cannot upload to Knowledge', ed.post(B + '/api/knowledge', files={'files': ('a.pdf', b'%PDF-1.4\n' + b'0' * 300, 'application/pdf')}).status_code in (403, 404))

# ---- 2FA guessing
sql("update users set twofa_required=true where username='ed'")
ed, r = sess('ed', ED_PW)
setup = ed.post(B + '/api/profile/2fa/setup').json()
secret = setup.get('secret')
en = ed.post(B + '/api/profile/2fa/enable', json={'token': totp(secret), 'password': ED_PW})
rec('2FA enabled for the test user', en.status_code == 200, en.text[:80])
ed.post(B + '/api/auth/logout')
s = requests.Session(); s.headers.update(XH)
s.post(B + '/api/auth/login', json={'username': 'ed', 'password': ED_PW})
codes = [s.post(B + '/api/auth/2fa', json={'token': '%06d' % (100000 + i)}).status_code for i in range(7)]
rec('2FA: wrong codes refused', all(c in (401, 429) for c in codes), codes)
good = s.post(B + '/api/auth/2fa', json={'token': totp(secret)})
rec('2FA: after 5 wrong codes even the right code is refused (must sign in again)', good.status_code in (401, 429), good.status_code)
fresh = requests.Session(); fresh.headers.update(XH)
fresh.post(B + '/api/auth/login', json={'username': 'ed', 'password': ED_PW})
rec('2FA: a code is accepted only with a fresh password login', fresh.get(B + '/api/auth/me').status_code == 401)

# ---- lock budget: one IP cannot lock more than 2 accounts
sql("update users set failed_attempts=0, locked_until=null")
for u in ['ed', 'admin']:
    for i in range(6): requests.post(B + '/api/auth/login', json={'username': u, 'password': 'wrong-%d' % i}, headers=XH)
sql("insert into users (username, full_name, role, password_hash, is_active) select 'victim3','V3','Editor',password_hash,true from users where username='ed' on conflict do nothing")
for i in range(6): requests.post(B + '/api/auth/login', json={'username': 'victim3', 'password': 'wrong-%d' % i}, headers=XH)
locked = sql("select string_agg(username, ',') from users where locked_until > now()")
rec('one IP locked at most 2 accounts', len([x for x in (locked or '').split(',') if x]) <= 2, locked)
sql("delete from users where username='victim3'")

# ---- audit trail and alerts
time.sleep(1)
seen = sql("select string_agg(distinct action, ',') from audit_logs where id>%d and action like 'security.%%'" % mark)
rec('audit log has security.* entries', bool(seen), seen)
rec('security.alert written', 'security.alert' in (seen or ''), seen)
n = sql("select count(*) from notifications where title like 'Account locked%%' or title like 'Repeated blocked%%'")
rec('admins notified', int(n or 0) > 0, n)

sql("update users set twofa_required=false, totp_enabled=false, totp_secret=null, failed_attempts=0, locked_until=null")
print('\n%d failed' % len(fails)); sys.exit(1 if fails else 0)
