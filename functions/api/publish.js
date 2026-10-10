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
    const a = m[1];
    const pick = function (name) {
      const r = new RegExp(name + '="([^"]*)"').exec(a);
      return r ? r[1] : '';
    };
    hits.push({
      at:    m.index,
      work:  pick('data-work-id'),
      title: pick('data-title'),
      date:  pick('data-date'),
      id:    pick('data-id')     // 手写的章节没有这个属性，会是空串
    });
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
         (fields.id ? '" data-id="' + attr(fields.id) : '') +
         '">\n' +
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

/* ---------------- 编辑：定位要改写的那一段 ----------------

   编辑比新增危险得多。新增最坏是加错位置，编辑最坏是
   「把第 3 章的内容写进了第 5 章」。所以用几道闸把目标锁死，
   任何一道不过就中止，绝不猜。                              */

/* attr() 和 textNode() 写出去的转义在这里还原，
   好和浏览器 getAttribute / textContent 拿到的值对齐。
   &amp; 必须最后换，否则 &amp;lt; 这类会被二次解码错。 */
function decodeText(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function locateSection(src, workId, index, expectTotal, expectTitle, expectDate) {
  const found = scanSections(src);
  const mine  = found.hits.filter(h => h.work === workId);

  // 闸一：该作品的章节总数变了，序号就可能已经错位
  if (mine.length !== expectTotal) throw new Error('chapter_list_changed');
  if (index < 0 || index >= mine.length) throw new Error('index_out_of_range');

  const target = mine[index];

  // 闸二、闸三：这个序号上的标题、日期对不上。
  // 光比标题不够——「总数没变但顺序挪了一位」时，只要两章重名就能蒙混过去，
  // 而三部小说各有一章都叫「空白1」，重名是真会发生的。日期是唯一的区分。
  if (decodeText(target.title) !== expectTitle) throw new Error('target_title_mismatch');
  if (decodeText(target.date)  !== expectDate)  throw new Error('target_date_mismatch');

  // 起点：该标签所在行的行首，连缩进一起换掉，保证对齐。
  // 若行首到标签之间还夹着别的东西，回退就会把它一起吞掉——中止。
  const nlStart = src.lastIndexOf('\n', target.at - 1);
  const start   = nlStart < 0 ? 0 : nlStart + 1;
  if (src.slice(start, target.at).trim() !== '') throw new Error('unexpected-section-start');

  // 终点：该段的闭合标签。搜索**卡上界**——最多找到下一个章节的开标签
  // （或 #library 结束）为止，不往文件末尾一路找，免得万一正文异常时吞掉邻章。
  const nextHit = found.hits.find(h => h.at > target.at);
  const limit   = nextHit ? nextHit.at : found.close;
  const rel     = src.slice(target.at, limit).match(/<\/section\s*>/);
  if (!rel) throw new Error('section_close_not_found');

  const closeStart = target.at + rel.index;
  const end        = closeStart + rel[0].length;   // 不含其后的换行

  // 闸四：正文里出现真正的标签，说明这一章是用 HTML 排版的。
  // 换成纯文本会把 <p> 之类的结构吃掉，直接拒绝。
  // 转义过的 &lt; 以 & 开头，不会误判。
  const gt   = src.indexOf('>', target.at);
  const body = src.slice(gt + 1, closeStart);
  if (/<[a-zA-Z/!]/.test(body)) throw new Error('not_text_body');

  return {
    start: start,
    end:   end,
    total: mine.length,
    id:    target.id        // 原有 id 原样保留；没有就继续没有
  };
}

/* 编辑提交前的硬门槛。跟新增那条不同：编辑是「等量替换」。 */
function validateReplace(src, next, snippet, loc, workId, index, title) {
  if (next.length !== src.length - (loc.end - loc.start) + snippet.length) {
    throw new Error('length-arithmetic');
  }

  // 替换区之外逐字节相同 —— 这两条才是真正兜底的：
  // 合起来证明只有那一段被换掉，别的字节一个都没动。
  if (next.slice(0, loc.start) !== src.slice(0, loc.start))          throw new Error('bytes-before-changed');
  if (next.slice(loc.start + snippet.length) !== src.slice(loc.end)) throw new Error('bytes-after-changed');

  if (countSections(next) !== countSections(src))                    throw new Error('section-count-changed');
  if (next.indexOf('</div><!-- /#library -->') < 0)                  throw new Error('library-close-lost');
  if (!next.trimEnd().endsWith('</html>'))                           throw new Error('html-tail-lost');

  // 独立复核：新章节必须落在同一个缩进列上，且标题确实是新的
  const mine = scanSections(next).hits.filter(h => h.work === workId);
  if (mine.length !== loc.total)                                     throw new Error('work-count-changed');

  const lead   = snippet.length - snippet.replace(/^[ \t]*/, '').length;
  const target = mine[index];
  if (!target || target.at !== loc.start + lead)                     throw new Error('wrong-position');
  if (decodeText(target.title) !== title)                            throw new Error('target-title-not-updated');
}

/* ---------------- GitHub ---------------- */

/* 把 GitHub 的失败原因原样带回去。
   x-accepted-github-permissions 是 GitHub 在 403 时给的提示，
   会直接说明缺哪个权限——比笼统的「写不进」有用得多。 */
async function ghFailure(res) {
  let detail = '';
  try {
    const body = await res.json();
    detail = (body && body.message) || '';
  } catch (e) { /* 响应体不是 JSON，忽略 */ }

  return {
    status: res.status,
    detail: detail,
    needs: res.headers.get('x-accepted-github-permissions') || '',
    scopes: res.headers.get('x-oauth-scopes') || ''
  };
}

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

  const action      = p.action === 'edit' ? 'edit' : 'create';
  const workId      = String(p.workId || '');
  const title       = String(p.title || '').trim();
  const date        = String(p.date || '').trim();
  const text        = String(p.text == null ? '' : p.text);
  const clientId    = String(p.clientId || '').trim();
  const mode        = p.position === 'append' ? 'append' : 'prepend';
  const dryRun      = p.dryRun === true;
  const index       = Number(p.index);
  const expectTotal = Number(p.expectTotal);
  const expectTitle = p.expectTitle == null ? null : String(p.expectTitle);
  const expectDate  = p.expectDate  == null ? null : String(p.expectDate);

  if (!WORKS.has(workId))                            return json({ error: 'bad_work_id' }, 400);
  if (!title)                                        return json({ error: 'empty_title' }, 400);
  if (!text.trim())                                  return json({ error: 'empty_body' }, 400);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(clientId))       return json({ error: 'bad_client_id' }, 400);
  if (date && !/^\d{4}\.\d{2}\.\d{2}$/.test(date))   return json({ error: 'bad_date' }, 400);
  if (new TextEncoder().encode(text).length > MAX_BODY_BYTES) return json({ error: 'too_large' }, 413);
  // 编辑要多带三样：第几章、那一章当时的总数、以及它的标题和日期。
  // 后三样是防「改错章节」的闸，缺一样都不能放行。
  if (action === 'edit') {
    if (!Number.isInteger(index) || index < 0)             return json({ error: 'bad_index' }, 400);
    if (!Number.isInteger(expectTotal) || expectTotal < 0) return json({ error: 'bad_expect_total' }, 400);
    if (expectTitle === null || expectDate === null)       return json({ error: 'bad_expect_target' }, 400);
  }

  const createSnippet = buildSection({ workId: workId, title: title, date: date, text: text, id: clientId });

  // 最多三轮。409/422 说明文件在别处被改过，重取一次 sha 再拼，
  // 这样即使你正好在本地推了东西，也不会把对方的改动冲掉。
  for (let attempt = 0; attempt < 3; attempt++) {
    const getRes = await gh(env, repoPath(env) + '?ref=' + BRANCH);
    if (getRes.status === 401 || getRes.status === 403) {
      return json(Object.assign({ error: 'upstream_auth' }, await ghFailure(getRes)), 502);
    }
    if (!getRes.ok) {
      return json(Object.assign({ error: 'upstream_read' }, await ghFailure(getRes)), 502);
    }

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

    let at, next, snippet, before = '';

    if (action === 'edit') {
      let loc;
      try {
        loc = locateSection(src, workId, index, expectTotal, expectTitle, expectDate);
      } catch (e) {
        // 被闸拦下：把具体是哪一道闸原样告诉前端
        const code = String(e && e.message);
        return json({ error: code }, code === 'not_text_body' ? 400 : 409);
      }

      // 末尾那个换行去掉：替换区间到 </section> 为止、不含它后面的换行，
      // 这样段与段之间那个空行分隔符原样保留，不会被越换越乱。
      snippet = buildSection({
        workId: workId, title: title, date: date, text: text, id: loc.id
      }).replace(/\n$/, '');

      before = src.slice(loc.start, loc.end);
      at     = loc.start;
      next   = src.slice(0, loc.start) + snippet + src.slice(loc.end);

      try {
        validateReplace(src, next, snippet, loc, workId, index, title);
      } catch (e) {
        return json({ error: 'replace_failed', detail: String(e && e.message) }, 500);
      }
    } else {
      // 幂等：同一个 clientId 已经发过了就不再发第二遍
      if (src.indexOf('data-id="' + clientId + '"') !== -1) {
        return json({ status: 'exists', clientId: clientId }, 200);
      }

      snippet = createSnippet;
      try {
        at   = insertionPoint(src, workId, mode);
        next = src.slice(0, at) + snippet + src.slice(at);
        validate(src, next, snippet, clientId, workId, mode);
      } catch (e) {
        return json({ error: 'splice_failed', detail: String(e && e.message) }, 500);
      }
    }

    if (dryRun) {
      return json({ status: 'dry_run', section: snippet, at: at, before: before }, 200);
    }

    const putRes = await gh(env, repoPath(env), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: (action === 'edit' ? '修改：' : '发布：') + workId + ' · ' + title,
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
    return json(Object.assign({ error: 'upstream_write' }, await ghFailure(putRes)), 502);
  }

  return json({ error: 'conflict_exhausted' }, 409);
}

export async function onRequestGet() {
  return json({ error: 'method_not_allowed' }, 405);
}
