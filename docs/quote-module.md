# app.html module — 行程报价生成 (Itinerary Quote)

This feature ships its backend (`api/quote-*`, migration `017`) and the customer
preview page (`quote.html`) as standalone files. The only change to the
single-file frontend `app.html` is this self-contained module. Paste the 4
pieces below at the marked insertion points (the same pattern every module
uses: nav entry → page container → ROLE_NAV → renderFn + goPage branch).

> Variable names assume the existing app.html conventions: a Supabase client
> (here called `sb`) and `CURRENT_USER`. Adjust the two marked spots if yours
> differ.

---

### 1) Sidebar nav entry  (in the relevant `<details>` group, ~L274–311)
```html
<a class="nav-item" data-page="quote" onclick="goPage('quote')">📝 行程报价生成</a>
```

### 2) Page container  (with the other `.page` divs, ~after L854)
```html
<div class="page" id="page-quote">
  <h2 style="color:#1B2F6B">行程报价生成 · Itinerary Quote</h2>
  <p style="color:#666">上传地接出团确认书（.docx），自动生成 WeBuy 印尼语客户版 Word + 在线链接。</p>

  <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin:12px 0">
    <input type="file" id="qz-file" accept=".docx">
    <button class="btn" id="qz-go" onclick="quoteGenerate()">生成</button>
    <span id="qz-status" style="color:#666"></span>
  </div>
  <div id="qz-result" style="margin:10px 0"></div>

  <h3 style="margin-top:24px;color:#1B2F6B">历史</h3>
  <table class="cf" id="qz-history" style="width:100%;border-collapse:collapse">
    <thead><tr><th>时间</th><th>标题</th><th>状态</th><th>链接</th></tr></thead>
    <tbody></tbody>
  </table>
</div>
```

### 3) ROLE_NAV  (~L4300) — allow sales / ops / admin
```js
// add 'quote' to the arrays for the roles that should see it, e.g.:
//   sales: [..., 'quote'], ops: [..., 'quote'], admin already sees all
```

### 4) renderFn + goPage branch  (renderFn ~after L4730; goPage branch ~L1893)
```js
// in goPage(page): add ->   if (page === 'quote') renderQuote();

async function qzToken(){ const { data } = await sb.auth.getSession(); return data?.session?.access_token || ''; }

async function quoteGenerate(){
  const f = document.getElementById('qz-file').files[0];
  const status = document.getElementById('qz-status');
  const result = document.getElementById('qz-result');
  result.innerHTML = '';
  if(!f){ status.textContent='请选择一个 .docx 文件'; return; }
  if(!/\.docx$/i.test(f.name)){ status.textContent='只支持 .docx（在 Word 里「另存为 .docx」）'; return; }
  const btn = document.getElementById('qz-go'); btn.disabled = true;
  try{
    const token = await qzToken();
    const headers = { 'Authorization':'Bearer '+token, 'Content-Type':'application/json' };
    // 1) upload source to Storage
    status.textContent = '① 上传中…';
    const srcPath = (CURRENT_USER?.id||'anon') + '/' + Date.now() + '-' + f.name.replace(/[^\w.\-]+/g,'_');
    const up = await sb.storage.from('quote-src').upload(srcPath, f, { upsert:true });
    if(up.error) throw new Error('上传失败: '+up.error.message);
    // 2) generate (parse + LLM)
    status.textContent = '② 生成行程文案（LLM）…';
    let r = await fetch('/api/quote-generate', { method:'POST', headers, body: JSON.stringify({ srcPath }) });
    let j = await r.json(); if(!r.ok) throw new Error(j.error||'generate 失败');
    const id = j.id;
    // 3) render (images + Word + storage)
    status.textContent = '③ 抓图 + 生成 Word…';
    r = await fetch('/api/quote-render', { method:'POST', headers, body: JSON.stringify({ id }) });
    j = await r.json(); if(!r.ok) throw new Error(j.error||'render 失败');
    status.textContent = '✅ 完成';
    const online = location.origin + j.previewUrl;
    result.innerHTML =
      `<div style="padding:12px;border:1px solid #d6e4f0;border-radius:8px;background:#f7fbff">
        <a class="btn" href="${j.docxUrl}" download>📄 下载 Word</a>
        <a class="btn" href="${online}" target="_blank" style="margin-left:8px">🔗 在线链接</a>
        <input value="${online}" readonly style="width:60%;margin-left:8px" onclick="this.select()">
      </div>`;
    renderQuote();
  }catch(e){ status.textContent = '❌ '+e.message; }
  finally{ btn.disabled = false; }
}

async function renderQuote(){
  const tb = document.querySelector('#qz-history tbody'); if(!tb) return;
  const { data, error } = await sb.from('itinerary_quotes').select('id,title,status,docx_url,created_at').order('created_at',{ascending:false}).limit(50);
  if(error){ tb.innerHTML = `<tr><td colspan="4">${error.message}</td></tr>`; return; }
  tb.innerHTML = (data||[]).map(q=>{
    const online = location.origin + '/q?id=' + q.id;
    const links = q.status==='done'
      ? `<a href="${q.docx_url}" download>Word</a> · <a href="${online}" target="_blank">在线</a>`
      : '—';
    return `<tr><td>${new Date(q.created_at).toLocaleString()}</td><td>${q.title||''}</td><td>${q.status}</td><td>${links}</td></tr>`;
  }).join('');
}
```

That's the whole frontend. Everything else (parsing, LLM, images, Word, storage,
the public preview page) is already in the repo.
