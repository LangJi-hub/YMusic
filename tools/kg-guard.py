#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""会员凭证巡检（酷狗 + QQ 音乐 + 网易云 三平台）。

为什么要单独一个脚本而不做进服务里：
  服务进程只会在有请求时活着，而「token 悄悄失效」恰恰最容易发生在半夜没人
  访问的时候。放进 cron，跟服务是否在线无关。

酷狗判定（实测依据）：
  · 高码率走 wwwapi.kugou.com/play/songinfo，这个接口对 token 是「全或无」：
    真会员 token → status=1 + bitrate；空/伪造/无 userid → status=0（连免费曲都如此）。
  · 所以必须拿一首**付费曲**探活才有区分度。这里固定用《稻香》Hi-Res
    （3175kbps / 88,706,509 B），它是会员专属资源。

QQ 判定（实测依据）：
  · 匿名请求 VIP 曲《稻香》songmid=003aAYrm3GE0Ac，vkey 各档位（M500/M800/
    F000/RS01）一律 code=0 但 result=104003（需要会员），purl 为空。
  · 所以只要有 purl 且 HEAD 回来是 audio/flac 且字节数像无损（>5MB），就能确认
    权益真的在。mp3 档（M800）拿到 purl 但拿不到 flac → 判权益降级。
  · vkey 的 filename 要用 **media_mid**（≠ songmid！稻香是 0020wJDo3cx0j3）。

网易云判定（实测依据）：
  · 匿名不是「什么都不给」，而是给到 320K，然后把 lossless / hires **静默降级**成
    320K mp3 —— 所以不能只看 url 有没有值，必须比 type 与 br。
  · 会员曲《孤勇者》id=1901371647（256 秒），匿名四档一律 128K + freeTrialInfo，
    720,813 B ≈ 30 秒片段。有黑胶 VIP 之后 lossless 应回 flac。

到期日：酷狗 /vip/*、gateway、mobiles 全 404，QQ 也没有公开的权益到期接口
—— 这两家只能人工登记在 data/<key>-vip.json；网易云例外，vip/info 直接给
expireTime，所以每天巡检会自动同步一次（手工登记过则以手工为准）。
没登记时只做失效告警，做不到提前一周。

输出：
  · data/kg-health.json、data/qq-health.json —— 给管理页读的体检结果
  · 邮件 —— 发给 superadmin 的邮箱（从 users.json 动态取）
  · 同一平台同一 level 同一天只发一封，状态变化必发

用法：
  python3 kg-guard.py            正常巡检
  python3 kg-guard.py --force    忽略去重，立即发一封（测通道用）
  python3 kg-guard.py --dry      只打印不写盘不发信
  python3 kg-guard.py --only qq  只跑 QQ
"""
import json
import os
import re
import smtplib
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, date
from email.header import Header
from email.mime.text import MIMEText
from email.utils import formataddr

APP = '/opt/ymusic'
DATA = os.path.join(APP, 'data')
SECRETS_F = os.path.join(DATA, 'secrets.json')
USERS_F = os.path.join(DATA, 'users.json')

SALT = 'NVPh5oo715z5DIWAeQlhMDsWXXQV4hwt'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')

# 酷狗：会员专属资源，稻香 Hi-Res（3175kbps / 88,706,509 B）
KG_PROBE_HASH = 'D987462A7FD98151845DB245FE214267'
KG_PROBE_NAME = '周杰伦《稻香》Hi-Res'

# QQ：同一首歌的 VIP 资源，songmid ≠ media_mid
QQ_PROBE_MID = '003aAYrm3GE0Ac'
QQ_PROBE_MM = '0020wJDo3cx0j3'
QQ_PROBE_NAME = '周杰伦《稻香》'
QQ_LADDER = [
    ('RS01', 'flac', 'Hi-Res'),
    ('F000', 'flac', '无损'),
    ('M800', 'mp3', '320K'),
    ('M500', 'mp3', '128K'),
]

# 网易云：会员曲《孤勇者》，匿名只给 30 秒试听
NE_PROBE_ID = '1901371647'
NE_PROBE_NAME = '陈奕迅《孤勇者》'
NE_LADDER = [
    ('hires', 'Hi-Res'),
    ('lossless', '无损'),
    ('exhigh', '320K'),
    ('higher', '192K'),
]

# 不走系统代理（服务器上可能配了 HTTP_PROXY，会干扰直连）
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _read(path, default):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return default


def _write(path, obj):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def md5(s):
    import hashlib
    return hashlib.md5(s.encode()).hexdigest()


def days_left(expire_at):
    if not expire_at:
        return None
    try:
        d = datetime.strptime(expire_at, '%Y-%m-%d').date()
    except Exception:
        return None
    return (d - date.today()).days


def find_superadmin_email():
    users = _read(USERS_F, {})
    for u in users.values():
        if isinstance(u, dict) and u.get('role') == 'superadmin':
            return u.get('email') or '', u.get('username') or ''
    return '', ''


def send_mail(smtp, to_addr, to_name, subject, body):
    if not smtp.get('host') or not smtp.get('user') or not smtp.get('pass'):
        return False, 'SMTP 没配齐'
    if not to_addr:
        return False, '开发者账号没填邮箱'
    msg = MIMEText(body, 'plain', 'utf-8')
    msg['Subject'] = Header(subject, 'utf-8')
    msg['From'] = formataddr((str(Header('YMusic 守护', 'utf-8')),
                              smtp.get('from') or smtp['user']))
    msg['To'] = formataddr((str(Header(to_name or to_addr, 'utf-8')), to_addr))
    # 发信失败重试一次再认输：SMTP_SSL 偶发的连接被重置，第二次基本都能过。
    # ⚠️ 别把异常吞成一行 print 就算了 —— 上一版「不发邮件」之所以拖了这么久才
    #    被发现，就是因为失败只留在没人看的日志里，没有任何别的痕迹。
    last_err = ''
    for attempt in (1, 2):
        try:
            with smtplib.SMTP_SSL(smtp['host'], int(smtp.get('port') or 465), timeout=25) as s:
                s.login(smtp['user'], smtp['pass'])
                s.sendmail(msg['From'], [to_addr], msg.as_string())
            return True, 'ok' + ('' if attempt == 1 else '（第 2 次才成功）')
        except Exception as e:
            last_err = str(e)[:160]
            if attempt == 1:
                time.sleep(3)
    return False, last_err


# ─────────────────────────── 酷狗 ───────────────────────────

def probe_kugou(kugou):
    """探活：返回 (ok, level, detail)"""
    if not kugou or not kugou.get('token') or not kugou.get('userid'):
        return False, 'critical', 'secrets.json 里没有可用的 kugou 凭证，整条高码率链路是关着的'

    now = str(int(time.time() * 1000))
    p = {
        'srcappid': '2919', 'clientver': '20000', 'clienttime': now,
        'mid': kugou.get('mid', ''), 'uuid': kugou.get('mid', ''),
        'dfid': kugou.get('dfid', ''),
        'appid': '1014', 'platid': '4',
        'token': kugou['token'], 'userid': str(kugou['userid']),
        'hash': KG_PROBE_HASH,
    }
    p['signature'] = md5(SALT + ''.join(k + '=' + str(p[k]) for k in sorted(p)) + SALT)
    url = 'https://wwwapi.kugou.com/play/songinfo?' + '&'.join(
        k + '=' + urllib.parse.quote(str(p[k])) for k in p)
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': 'https://www.kugou.com/',
        'Cookie': 'userid=%s; token=%s; kg_mid=%s; kg_dfid=%s' % (
            kugou['userid'], kugou['token'], kugou.get('mid', ''), kugou.get('dfid', '')),
    })
    try:
        with _OPENER.open(req, timeout=20) as r:
            j = json.loads(r.read().decode('utf-8', 'replace'))
    except Exception as e:
        return False, 'unknown', '探活请求失败（网络问题，不代表凭证失效）：%s' % str(e)[:90]

    st = j.get('status')
    d = j.get('data') or {}
    br = int(d.get('bitrate') or 0)
    size = int(d.get('filesize') or 0)

    if st != 1:
        return False, 'critical', (
            'token 已失效（songinfo 回 status=%s）。整条高码率链路已断开 —— '
            '会员曲会掉到别家 96K 翻唱。需要重新扫码。' % st)
    if br < 320:
        return False, 'critical', (
            'token 还在，但只给到 %skbps（会员态应为 3175kbps）—— '
            '会员权益已失效或账号降级。会员曲将无法出高码率。' % br)
    return True, 'ok', '正常：%s 拿到 %skbps / %s 字节' % (KG_PROBE_NAME, br, format(size, ','))


# ─────────────────────────── QQ 音乐 ───────────────────────────

def qq_key_of(cookie):
    for k in ('qqmusic_key', 'qm_keyst'):
        i = cookie.find(k + '=')
        if i >= 0:
            seg = cookie[i + len(k) + 1:]
            v = seg.split(';')[0].strip()
            if v:
                return v
    return ''


def qq_vkey(cookie, uin, mid, mm, prefix, ext):
    """要一条直链。返回 dict(code, purl, sip, result, errtype)

    ⚠️ uin 只用来判「有没有登录」，请求里一律发 0：
      微信登录的 wxuin 是 19 位（1.15e18），超过 2^53，JS 侧会丢精度；
      而实测 QQ 只认 cookie 里的 qqmusic_key，param.uin 传 0 照样给 RS01/F000。
    """
    param = {
        'guid': '10000', 'songmid': [mid], 'songtype': [0],
        'uin': '0', 'loginflag': 1, 'platform': '20',
        'filename': ['%s%s%s.%s' % (prefix, mid, mm, ext)],
    }
    body = json.dumps({
        'req_0': {'module': 'vkey.GetVkeyServer', 'method': 'CgiGetVkey', 'param': param},
        'comm': {'uin': 0, 'format': 'json', 'ct': 24, 'cv': 0},
    }).encode('utf-8')
    req = urllib.request.Request(
        'https://u.y.qq.com/cgi-bin/musicu.fcg', data=body, method='POST',
        headers={'User-Agent': UA, 'Referer': 'https://y.qq.com/',
                 'Content-Type': 'application/json', 'Cookie': cookie})
    try:
        with _OPENER.open(req, timeout=20) as r:
            j = json.loads(r.read().decode('utf-8', 'replace'))
    except Exception as e:
        return {'code': -1, 'purl': '', 'sip': '', 'result': -1, 'err': str(e)[:80]}
    d = ((j.get('req_0') or {}).get('data') or {})
    m = (d.get('midurlinfo') or [{}])[0] or {}
    sip = (d.get('sip') or [''])[0]
    return {
        'code': (j.get('req_0') or {}).get('code'),
        'purl': m.get('purl') or '', 'sip': sip,
        'result': m.get('result'), 'errtype': m.get('errtype'),
    }


def qq_head_size(url):
    """HEAD 一条直链，返回 (status, content_length, content_type)"""
    req = urllib.request.Request(url, method='HEAD',
                                 headers={'User-Agent': UA, 'Referer': 'https://y.qq.com/'})
    try:
        with _OPENER.open(req, timeout=20) as r:
            return r.status, int(r.headers.get('Content-Length') or 0), \
                (r.headers.get('Content-Type') or '')
    except Exception as e:
        return -1, 0, str(e)[:60]


def probe_qq(qq):
    """探活：返回 (ok, level, detail, levels)"""
    if not qq or not qq.get('cookie'):
        return False, 'critical', (
            '还没有 QQ 登录凭证 —— 会员曲会掉到别家翻唱，或干脆没有音源'), []
    cookie = str(qq.get('cookie') or '')
    uin = str(qq.get('uin') or '').replace('o', '')
    if not uin:
        i = cookie.find('uin=')
        if i >= 0:
            uin = cookie[i + 4:].split(';')[0].strip().lstrip('o')
    if not qq_key_of(cookie):
        return False, 'critical', (
            'cookie 里没有 qqmusic_key —— 多半是复制时漏了，或没在 y.qq.com 登录'), []
    if not uin.isdigit():
        return False, 'critical', 'cookie 里没有可用的 uin，vkey 请求会被 QQ 拒绝', []

    levels = []
    got_flac = None
    got_mp3 = None
    last_err = ''
    for prefix, ext, label in QQ_LADDER:
        r = qq_vkey(cookie, uin, QQ_PROBE_MID, QQ_PROBE_MM, prefix, ext)
        item = {'prefix': prefix, 'label': label,
                'result': r.get('result'), 'code': r.get('code'),
                'hasUrl': bool(r.get('purl'))}
        if r.get('purl') and r.get('sip'):
            st, ln, ct = qq_head_size(r['sip'] + r['purl'])
            item['status'] = st
            item['bytes'] = ln
            item['type'] = ct
            item['desc'] = '%s / %s 字节' % (ct or '-', format(ln, ','))
            levels.append(item)
            if st == 200 and ln > 5 * 1024 * 1024:
                if ext == 'flac' and not got_flac:
                    got_flac = item
                elif ext == 'mp3' and not got_mp3:
                    got_mp3 = item
                break  # 拿到能用的最高档就停
            last_err = 'HEAD 回 %s / %s 字节' % (st, format(ln, ','))
        else:
            item['status'] = 0
            item['bytes'] = 0
            item['desc'] = 'result=%s' % r.get('result')
            levels.append(item)
            last_err = 'result=%s' % r.get('result')

    if got_flac:
        # QQ 对 flac 直链回的是 content-type: audio/x-ogg（实测），照着念会误导，
        # 所以只按档位说人话。
        tag = 'Hi-Res' if got_flac['prefix'] == 'RS01' else '无损'
        return True, 'ok', '正常：%s 拿到 %s FLAC / %s 字节' % (
            QQ_PROBE_NAME, tag, format(got_flac['bytes'], ',')), levels
    if got_mp3:
        return False, 'warn', (
            '凭证在，但只拿得到 %s（%s 字节）—— 无损档没给，会员权益可能只到 320K '
            '或已降级' % (got_mp3['label'], format(got_mp3['bytes'], ','))), levels
    return False, 'critical', (
        'QQ 会员曲取不到任何直链（%s）—— 凭证失效或这张号没有会员权益。'
        '会员曲会掉到别家翻唱。' % (last_err or '未知原因')), levels


# ─────────────────────────── 网易云 ───────────────────────────

def ne_has_key(cookie):
    return re.search(r'(?:^|;\s*)MUSIC_U=[^;\s]+', str(cookie or '')) is not None


def ne_url(cookie, song_id, level):
    """url/v1 单次请求，返回 data[0]（失败时 {'err': ...}）"""
    url = ('https://music.163.com/api/song/enhance/player/url/v1?ids=%5B'
           + str(song_id) + '%5D&level=' + level + '&encodeType=flac')
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': 'https://music.163.com/',
        # NE_H 里那份 appver 太老，带登录态要一起换新的
        'Cookie': 'os=pc; appver=8.9.70; channel=netease; ' + str(cookie),
    })
    try:
        with _OPENER.open(req, timeout=20) as r:
            j = json.loads(r.read().decode('utf-8', 'replace'))
    except Exception as e:
        return {'err': str(e)[:80]}
    return ((j.get('data') or [{}])[0] or {})


def ne_vip_expire(ne):
    """网易云会员到期日（YYYY-MM-DD）：vip/info 直接给 expireTime（毫秒）

    QQ 那边查不到到期日，只能人工填；网易云有，所以每天巡检顺手同步一次，
    省掉「会员到期了才知道」这件事。查不到返回 ''，不影响探活本身。
    """
    cookie = str(ne.get('cookie') or '')
    uid = str(ne.get('uid') or '')
    if not cookie or not uid:
        return ''
    url = ('https://music.163.com/api/music-vip-membership/client/vip/info'
           '?uid=' + urllib.parse.quote(uid) + '&type=1')
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': 'https://music.163.com/',
        'Cookie': 'os=pc; appver=8.9.70; channel=netease; ' + cookie,
    })
    try:
        with _OPENER.open(req, timeout=20) as r:
            j = json.loads(r.read().decode('utf-8', 'replace'))
    except Exception:
        return ''
    d = (j or {}).get('data') or {}
    a = d.get('associator') or {}
    m = d.get('musicPackage') or {}
    try:
        exp = max(int(a.get('expireTime') or 0), int(m.get('expireTime') or 0))
    except Exception:
        return ''
    if exp <= 0:
        return ''
    return datetime.fromtimestamp(exp / 1000.0).strftime('%Y-%m-%d')


def probe_ne(ne):
    """探活：返回 (ok, level, detail, levels)

    ⚠️ 网易云不会像 QQ 那样回 104003，它「假装成功」：
       匿名要 lossless / hires 时照样给一条 320K mp3 的直链。
       所以判据必须是 type=flac（+ Hi-Res 还要 br ≥ 1000k），不能只看有没有 url。
    """
    if not ne or not ne.get('cookie'):
        return False, 'critical', (
            '还没有网易云登录凭证 —— 会员曲只会给 30 秒试听'), []
    cookie = str(ne.get('cookie') or '')
    if not ne_has_key(cookie):
        return False, 'critical', (
            'cookie 里没有 MUSIC_U —— 多半是复制时漏了，或没在 music.163.com 登录'), []

    levels = []
    got_flac = None
    got_mp3 = None
    last = ''
    for lv, label in NE_LADDER:
        d = ne_url(cookie, NE_PROBE_ID, lv)
        if d.get('err'):
            levels.append({'prefix': lv, 'label': label, 'hasUrl': False,
                           'bytes': 0, 'desc': '请求失败'})
            last = '请求失败 ' + d['err']
            continue
        u = str(d.get('url') or '')
        br = int(d.get('br') or 0)
        size = int(d.get('size') or 0)
        ext = str(d.get('type') or '')
        trial = bool(d.get('freeTrialInfo'))
        ok = bool(u) and not trial and size > 200000
        desc = ('%s %dK / %s 字节' % (ext, round(br / 1000), format(size, ','))
                if ok else ('只给试听片段' if trial else '没给直链'))
        levels.append({'prefix': lv, 'label': label, 'hasUrl': ok,
                       'bytes': size, 'desc': desc})
        if ok:
            if ext == 'flac':
                got_flac = ('Hi-Res' if br >= 1000000 else '无损', size, ext)
            elif br >= 300000:
                got_mp3 = ('320K', size, ext)
            break   # 拿到能用的最高档就停
        last = desc

    if got_flac:
        return True, 'ok', '正常：%s 拿到 %s FLAC / %s 字节' % (
            NE_PROBE_NAME, got_flac[0], format(got_flac[1], ',')), levels
    if got_mp3:
        return False, 'warn', (
            '凭证在，但只拿得到 %s（%s 字节）—— 无损档没给，黑胶 VIP 可能已到期或降级'
            % (got_mp3[0], format(got_mp3[1], ','))), levels
    return False, 'critical', (
        '网易云会员曲取不到完整音源（%s）—— 凭证失效，或这个号没有会员权益。'
        '会员曲只会给 30 秒试听。' % (last or '未知原因')), levels


# ─────────────────────────── 平台装配 ───────────────────────────

PLATFORMS = [
    {
        'key': 'kg', 'name': '酷狗',
        'vip_f': os.path.join(DATA, 'kg-vip.json'),
        'health_f': os.path.join(DATA, 'kg-health.json'),
        'probe': lambda sec: probe_kugou(sec.get('kugou') or {}),
        'account': lambda sec: sec.get('kugou') or {},
        'id_label': 'userid', 'id_key': 'userid',
        'probe_meta': lambda: {'hash': KG_PROBE_HASH, 'name': KG_PROBE_NAME},
        'recover': [
            '  1. 打开 http://127.0.0.1:8788/kg.html（用开发者账号登录）',
            '  2. 切到「酷狗音乐」，点「生成二维码」',
            '  3. 手机酷狗 App → 扫一扫 → 确认登录',
        ],
    },
    {
        'key': 'qq', 'name': 'QQ 音乐',
        'vip_f': os.path.join(DATA, 'qq-vip.json'),
        'health_f': os.path.join(DATA, 'qq-health.json'),
        'probe': lambda sec: probe_qq(sec.get('qq') or {}),
        'account': lambda sec: sec.get('qq') or {},
        'id_label': 'uin', 'id_key': 'uin',
        'probe_meta': lambda: {'mid': QQ_PROBE_MID, 'name': QQ_PROBE_NAME},
        'recover': [
            '  1. 打开 http://127.0.0.1:8788/kg.html（用开发者账号登录）',
            '  2. 切到「QQ 音乐」，先试「生成二维码」（手机 QQ 扫）',
            '  3. 若提示没拿到 qqmusic_key：在浏览器登录 y.qq.com，F12 复制 Cookie 整行，',
            '     粘到「或粘贴 cookie」里点保存，服务端会立刻体检',
        ],
    },
    {
        'key': 'ne', 'name': '网易云',
        'vip_f': os.path.join(DATA, 'ne-vip.json'),
        'health_f': os.path.join(DATA, 'ne-health.json'),
        'probe': lambda sec: probe_ne(sec.get('netease') or {}),
        'account': lambda sec: sec.get('netease') or {},
        'vip_fetch': lambda sec: ne_vip_expire(sec.get('netease') or {}),
        'id_label': 'uid', 'id_key': 'uid',
        'probe_meta': lambda: {'id': NE_PROBE_ID, 'name': NE_PROBE_NAME},
        'recover': [
            '  1. 打开 http://127.0.0.1:8788/kg.html（用开发者账号登录）',
            '  2. 切到「网易云」—— 网易云没有能出图的扫码接口，这里走粘贴',
            '  3. 浏览器登录 music.163.com，F12 复制 Cookie 整行粘进去点保存',
            '     只粘 MUSIC_U=… 那一段也认',
        ],
    },
]


def build_body(pf, level, detail, acct, expire_at, left, notify_days, levels):
    lines = [
        'YMusic %s 凭证巡检结果' % pf['name'],
        '=' * 40,
        '级别：%s' % ('【严重】需要立刻处理' if level == 'critical'
                    else ('【提醒】需要留意' if level == 'warn' else '【正常】')),
        '',
        detail,
        '',
        '账号：%s（%s %s）' % (acct.get('nickname') or '-', pf['id_label'],
                            acct.get(pf['id_key']) or '-'),
        '凭证保存时间：%s' % (acct.get('savedAt') or '-'),
    ]
    if levels:
        lines.append('')
        lines.append('档位实测：')
        for it in levels:
            lines.append('  %-7s %-6s %s' % (
                it.get('prefix'), it.get('label'),
                it.get('desc') or (('%s 字节' % format(it.get('bytes') or 0, ','))
                                   if it.get('hasUrl') else '不可用')))
    if expire_at:
        lines.append('')
        lines.append('会员到期日：%s（剩余 %s 天，提前 %s 天提醒）'
                     % (expire_at, left, notify_days))
    else:
        lines.append('')
        lines.append('会员到期日：**未登记** —— 所以只能失效后告警，做不到提前一周。')
        lines.append('  请去会员中心看一眼到期日，然后打开守护页填写，')
        lines.append('  之后每天都会按剩余天数自动倒计时。')
    if level != 'ok':
        lines += ['', '-' * 40, '怎么恢复（约 30 秒）：'] + pf['recover'] + [
            '',
            '  页面会自动写入新凭证，**下一个请求即生效，不用重启服务**。',
            '',
            '如果同时会员也到期了，先续费，再取证。',
        ]
    lines += ['', '-- ',
              '本邮件由 /opt/ymusic/tools/kg-guard.py 自动发出，每 30 分钟巡检一次。']
    return '\n'.join(lines)


def run_platform(pf, sec, smtp, force, dry, to_addr, to_name):
    vip = _read(pf['vip_f'], {}) or {}
    expire_at = str(vip.get('expireAt') or '').strip()
    notify_days = int(vip.get('notifyDays') or 7)

    # ★ 网易云能查到到期日：没手工登记过就每天同步一次，续费了也能自动认出来
    if pf.get('vip_fetch') and not vip.get('manual'):
        got = ''
        try:
            got = pf['vip_fetch'](sec) or ''
        except Exception:
            got = ''
        if got:
            if got != expire_at:
                print('[%s] 到期日自动同步：%s -> %s' % (pf['key'], expire_at or '(空)', got))
                expire_at = got
                vip['expireAt'] = got
            vip['auto'] = True
            if not dry:
                _write(pf['vip_f'], vip)

    left = days_left(expire_at)

    r = pf['probe'](sec)
    ok, level, detail = r[0], r[1], r[2]
    levels = r[3] if len(r) > 3 else []

    if ok and left is not None:
        if left < 0:
            level, detail = 'critical', '%s，会员已于 %s 到期（超 %d 天）' % (detail, expire_at, -left)
            ok = False
        elif left <= notify_days:
            level = 'warn'
            detail = '%s；但会员还剩 %d 天到期（%s），请提前续费' % (detail, left, expire_at)

    acct = pf['account'](sec) or {}
    health = {
        'ok': ok, 'level': level, 'message': detail,
        'checkedAt': int(time.time() * 1000),
        'checkedAtText': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'levels': levels,
        'expireAt': expire_at, 'daysLeft': left, 'notifyDays': notify_days,
        'probe': pf['probe_meta'](),
        'account': {
            'nickname': str(acct.get('nickname') or ''),
            'savedAt': str(acct.get('savedAt') or ''),
            pf['id_key']: str(acct.get(pf['id_key']) or ''),
        },
        'by': 'cron',
    }

    print('[%s] level=%s ok=%s | %s' % (pf['key'], level, ok, detail))

    if dry:
        print('[%s] --dry，不写盘不发信' % pf['key'])
        return level

    _write(pf['health_f'], health)

    # ★ 恢复即重置（2026-10-29）：一旦体检回到 ok，就把「已经告警过」这个记号抹掉。
    #   旧逻辑只按「同一天 + 同一级别」去重，于是：早上坏了发信 → 中午修好 →
    #   下午又坏，下午这一次**不会再发**（业主要的是「一旦有异常就要发邮件」）。
    #   抹掉记号后，下一次异常一定是「从正常掉下来的」，必然重新发信。
    if level == 'ok':
        if vip.get('lastAlert'):
            vip.pop('lastAlert', None)
            print('[%s] 已恢复正常，清掉告警记号 —— 之后再异常会重新发信' % pf['key'])
            _write(pf['vip_f'], vip)
        return level

    today = date.today().isoformat()
    last = vip.get('lastAlert') or {}
    same = (last.get('date') == today and last.get('level') == level)
    if same and not force:
        print('[%s] 今天已就同一级别告警过，跳过（--force 可强制）' % pf['key'])
        return level

    subj = {
        'critical': '【YMusic 严重】%s凭证失效，会员曲已断' % pf['name'],
        'warn': '【YMusic 提醒】%s：%s' % (pf['name'], (
            '会员 %s 天后到期' % left if (left is not None and 0 <= left <= notify_days)
            else '权益降级')),
    }
    body = build_body(pf, level, detail, acct, expire_at, left, notify_days, levels)
    sent, err = send_mail(smtp, to_addr, to_name, subj.get(level, '【YMusic】巡检'), body)
    print('[%s] 邮件 -> %s : %s %s' % (pf['key'], to_addr or '(无)',
                                      '成功' if sent else '失败', '' if sent else err))

    if sent:
        vip['lastAlert'] = {
            'date': today, 'level': level,
            'mailOk': True, 'mailErr': '',
            'at': int(time.time() * 1000),
        }
        _write(pf['vip_f'], vip)
    else:
        # ★ 发信失败就**不写**去重记号：下一拍（30 分钟后）自然会再试一次。
        #   写上去的话，这一次失败就被"已告警过"永久吞掉了 —— 正是这次事故的形态。
        print('[%s] !! 邮件没发出去（%s），不写去重记号，30 分钟后重试' % (pf['key'], err))
    return level


def main():
    force = '--force' in sys.argv
    dry = '--dry' in sys.argv
    only = ''
    if '--only' in sys.argv:
        i = sys.argv.index('--only')
        if i + 1 < len(sys.argv):
            only = sys.argv[i + 1]

    sec = _read(SECRETS_F, {})
    smtp = sec.get('smtp') or {}
    to_addr, to_name = find_superadmin_email()

    worst = 'ok'
    for pf in PLATFORMS:
        if only and pf['key'] != only:
            continue
        lv = run_platform(pf, sec, smtp, force, dry, to_addr, to_name)
        if lv == 'critical':
            worst = 'critical'
        elif lv == 'warn' and worst != 'critical':
            worst = 'warn'
    print('[guard] 汇总 worst=%s' % worst)
    return 0


if __name__ == '__main__':
    sys.exit(main())
