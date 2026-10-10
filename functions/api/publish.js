// Cloudflare Pages Function —— POST /api/publish
//
// 往 index.html 的 #library 里插一个新的 <section class="chapter">，然后提交。
// 提交会触发 Cloudflare Pages 重新部署，约 1 分钟后新章节上线。
//
// 只用 Web API（TextEncoder / TextDecoder / btoa / atob / fetch），
// 不依赖 Buffer，所以不需要开 nodejs_compat。
//
// 需要的环境变量（Cloudflare 后台 → 该项目 → Settings → Variables and Secrets）：
//   PUBLISH_TOKEN  发布口令，设成 Secret
//   GITHUB_PAT     GitHub 令牌，只需 Contents: Read and write，设成 Secret
//   GH_OWNER       可选，默认 TickSpring
//   GH_REPO        可选，默认 my-web

const BRANCH = 'main';
const FILE   = 'index.html';
const GH     = 'https://api.github.com';

const WORKS = new Set(['qu', 'pian', 'her', 'notes']);

const MAX_BODY_BYTES = 64 * 1024;      // 单章正文上限
const MAX_FILE_BYTES = 900 * 1024;     // Contents API 超过 1 MB 就不直接返回内容了

/* ---------------- 编码：中文字符必须走字节层 ----------------
   btoa 只认 latin1，直接喂中文会抛错；atob 的结果直接当字符串用
   则会把每个字节变成一个 Latin-1 字符，中文全变乱码且不报错。
   这两个函数是整份文件里最容易静默毁数据的地方。            */

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CHUNK = 0x8000;              // 一次性展开 10 万个参数会爆栈，分块
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));   // GitHub 会按 60 字折行
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/* ---------------- 小工具 ---------------- */

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
}

// 定长比较，不因为比较到第几位不同而提前返回
function constTimeEq(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

// 属性值：转义 & " < >
function attr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// 元素文本：转义 & < >
// 这条同时是个不变量：转义之后，章节正文里永远不可能出现字面量
// "</section>"，所以定位插入点时只看开标签就够了，不必去找闭合标签。
function textNode(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/* ---------------- 定位插入点 ---------------- */

/* 扫出 #library 范围内每个章节开标签的位置和所属作品。
   只认开标签：正文按纯文本存储且 < 已被转义，所以字面量
   "</section>" 不可能出现在章节内部，不必去找闭合标签。 */
function scanSections(src) {
  const open = src.indexOf('<div id="library" hidden>');
  if (open < 0) throw new Error('library-open-not-found');

  const close = src.indexOf('</div><!-- /#library -->', open);
  if (close < 0) throw new Error('library-close-not-found');

  const re = /<section class="chapter"([^>]*)>/g;
  re.lastIndex = open;
  const hits = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index >= close) break;
    const w = /data-work-id="([^"]*)"/.exec(m[1]);
    hits.push({ at: m.index, work: w ? w[1] : '' });
  }
  return { hits: hits, open: open, close: close };
}

function insertionPoint(src, workId, mode) {
  const found = scanSections(src);
  const hits  = found.hits;
  const close = found.close;

  let at;

  if (!hits.length || !hits.some(h => h.work === workId)) {
    // 这个作品还没有任何章节：放到 #library 的末尾
    at = close;
  } else if (mode === 'append') {
    // 该作品最后一个开标签之后，下一个开标签（或 library 结束）之前
    let last = -1;
    for (const h of hits) if (h.work === workId) last = h.at;
    const next = hits.find(h => h.at > last);
    at = next ? next.at : close;
  } else {
    // prepend：该作品第一个开标签之前
    at = hits.find(h => h.work === workId).at;
  }

  // 回退到行首，保证缩进对齐
  const nl = src.lastIndexOf('\n', at);
  return nl < 0 ? at : nl + 1;
}

function buildSection(fields) {
  return '  <section class="chapter" data-work-id="' + fields.workId +
         '" data-title="' + attr(fields.title) +
         '" data-date="' + attr(fields.date || '') +
         '" data-id="' + attr(fields.id) + '">\n' +
         textNode(fields.text) + '\n' +
         '  </section>\n';
}

function countSections(s) {
  const m = s.match(/<section class="chapter"/g);
  return m ? m.length : 0;
}

/* 提交前的硬门槛。任何一条不过就整个放弃，绝不把半个文件推上去。 */
function validate(oldSrc, newSrc, snippet, clientId, workId, mode) {
  // 最强的一条：证明插入点之外一个字节都没变
  if (newSrc.length !== oldSrc.length + snippet.length) throw new Error('length-arithmetic');

  if (countSections(newSrc) !== countSections(oldSrc) + 1) throw new Error('section-count');

  if (newSrc.indexOf('</div><!-- /#library -->') < 0)      throw new Error('library-close-lost');
  if (!newSrc.trimEnd().endsWith('</html>'))               throw new Error('html-tail-lost');

  const marker = 'data-id="' + clientId + '"';
  if (newSrc.split(marker).length !== 2) throw new Error('marker-count');

  /* 上面几条只能证明「除了插入点一个字节没动」，
     证明不了插入点选对了。这里再独立定位一次。 */
  const found    = scanSections(newSrc);
  const markerAt = newSrc.indexOf(marker);

  if (markerAt < found.open || markerAt > found.close) throw new Error('outside-library');

  let owner = -1;
  for (let i = 0; i < found.hits.length; i++) {
    const end = (i + 1 < found.hits.length) ? found.hits[i + 1].at : Infinity;
    if (markerAt >= found.hits[i].at && markerAt < end) { owner = i; break; }
  }
  if (owner < 0) throw new Error('not-inside-a-section');

  const mineIdx = found.hits.slice(0, owner + 1).filter(h => h.work === workId).length - 1;
  const total   = found.hits.filter(h => h.work === workId).length;

  if (mode === 'prepend' ? mineIdx !== 0 : mineIdx !== total - 1) {
    throw new Error('wrong-position');
  }
}

/* ---------------- GitHub ---------------- */

async function gh(env, path, init) {
  const headers = {
    'authorization': 'Bearer ' + env.GITHUB_PAT,
    'accept': 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'tickspring-publish/1.0'
  };
  if (init && init.headers) Object.assign(headers, init.headers);
  return fetch(GH + path, Object.assign({}, init, { headers: headers }));
}

function repoPath(env) {
  const owner = env.GH_OWNER || 'TickSpring';
  const repo  = env.GH_REPO  || 'my-web';
  return '/repos/' + owner + '/' + repo + '/contents/' + FILE;
}

/* ---------------- 入口 ---------------- */

export async function onRequestPost(context) {
  const { request, env } = context;

  // 配置缺失就直接拒绝，不要退化成「谁都能发」
  if (!env.PUBLISH_TOKEN || !env.GITHUB_PAT) {
    return json({ error: 'server_misconfigured' }, 500);
  }

  const auth = request.headers.get('authorization') || '';
  if (!constTimeEq(auth.replace(/^Bearer\s+/i, ''), env.PUBLISH_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }

  let p;
  try { p = await request.json(); } catch (e) { return json({ error: 'bad_json' }, 400); }

  const workId   = String(p.workId || '');
  const title    = String(p.title || '').trim();
  const date     = String(p.date || '').trim();
  const text     = String(p.text == null ? '' : p.text);
  const clientId = String(p.clientId || '').trim();
  const mode     = p.position === 'append' ? 'append' : 'prepend';
  const dryRun   = p.dryRun === true;

  if (!WORKS.has(workId))                            return json({ error: 'bad_work_id' }, 400);
  if (!title)                                        return json({ error: 'empty_title' }, 400);
  if (!text.trim())                                  return json({ error: 'empty_body' }, 400);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId))       return json({ error: 'bad_client_id' }, 400);
  if (date && !/^\d{4}\.\d{2}\.\d{2}$/.test(date))   return json({ error: 'bad_date' }, 400);
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json({ error: 'too_large' }, 413);

  const snippet = buildSection({ workId: workId, title: title, date: date, text: text, id: clientId });

  // 最多三轮。409/422 说明文件在别处被改过，重取一次 sha 再拼，
  // 这样即使你正好在本地推了东西，也不会把对方的改动冲掉。
  for (let attempt = 0; attempt < 3; attempt++) {
    const getRes = await gh(env, repoPath(env) + '?ref=' + BRANCH);
    if (getRes.status === 401 || getRes.status === 403) return json({ error: 'upstream_auth' }, 502);
    if (!getRes.ok) return json({ error: 'upstream_read', status: getRes.status }, 502);

    const meta = await getRes.json();
    if (typeof meta.size === 'number' && meta.size > MAX_FILE_BYTES) {
      return json({ error: 'file_too_big' }, 413);
    }

    let src;
    if (meta.content && meta.encoding === 'base64') {
      src = base64ToUtf8(meta.content);
    } else {
      const raw = await fetch(meta.download_url);   // 文件超过 1 MB 时的退路
      src = await raw.text();
    }

    // 幂等：同一个 clientId 已经发过了就不再发第二遍
    if (src.indexOf('data-id="' + clientId + '"') !== -1) {
      return json({ status: 'exists', clientId: clientId }, 200);
    }

    let at, next;
    try {
      at   = insertionPoint(src, workId, mode);
      next = src.slice(0, at) + snippet + src.slice(at);
      validate(src, next, snippet, clientId, workId, mode);
    } catch (e) {
      return json({ error: 'splice_failed', detail: String(e && e.message) }, 500);
    }

    if (dryRun) {
      return json({ status: 'dry_run', section: snippet, at: at }, 200);
    }

    const putRes = await gh(env, repoPath(env), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: '发布：' + workId + ' · ' + title,
        content: utf8ToBase64(next),
        sha: meta.sha,
        branch: BRANCH
      })
    });

    if (putRes.ok) {
      const out = await putRes.json();
      return json({
        status: 'committed',
        commit: out.commit && out.commit.sha,
        url:    out.commit && out.commit.html_url,
        note:   'Cloudflare Pages 大约 1 分钟后重新部署完成'
      }, 200);
    }

    if (putRes.status === 409 || putRes.status === 422) continue;   // sha 过期，重取重试
    return json({ error: 'upstream_write', status: putRes.status }, 502);
  }

  return json({ error: 'conflict_exhausted' }, 409);
}

export async function onRequestGet() {
  return json({ error: 'method_not_allowed' }, 405);
}
