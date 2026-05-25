/**
 * Public read-only admin dashboard. Anyone with the URL can view.
 * Filters by status / scanner / plate; shows totals and per-scanner counts.
 */
export function uiPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>TRA Ownership Transfers — Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,Arial,sans-serif;margin:0;background:#0d2a3a;color:#eaf6ff}
  header{background:#08202c;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap}
  header h1{margin:0;font-size:18px}
  header .meta{font-size:12px;color:#9fd0e0}
  .wrap{padding:16px;max-width:1400px;margin:0 auto}
  .card{background:#123a4f;border-radius:10px;padding:14px;margin-bottom:14px}
  .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
  .stat{background:#0b2735;border-radius:8px;padding:12px;text-align:center}
  .stat .n{font-size:24px;font-weight:700;line-height:1}
  .stat .l{font-size:11px;color:#9fd0e0;margin-top:6px;text-transform:uppercase;letter-spacing:.04em}
  .stat.done .n{color:#46e08a}
  .stat.failed .n{color:#ff7a7a}
  .stat.issue .n{color:#ffb84d}
  .stat.waiting .n{color:#cfe3ec}
  .stat.processing .n{color:#ffd24d}
  .stat.uploaded .n{color:#7ec0ff}
  .filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
  .filters label{display:flex;flex-direction:column;font-size:12px;color:#9fd0e0;gap:4px}
  input,select{border-radius:8px;border:1px solid #2a6a86;background:#0b2735;color:#eaf6ff;padding:8px 10px;font-size:14px;width:100%}
  button{background:#1e9e6a;color:#fff;border:0;border-radius:8px;padding:9px 15px;font-size:13px;font-weight:600;cursor:pointer}
  button.alt{background:#2a6a86}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #1e4d63;vertical-align:top}
  th{position:sticky;top:0;background:#0b2735;cursor:pointer;user-select:none}
  th.sortable:hover{color:#7ec0ff}
  th .arrow{opacity:.5;font-size:10px;margin-left:3px}
  .s-done{color:#46e08a}.s-failed{color:#ff7a7a}.s-issue{color:#ffb84d}.s-waiting{color:#cfe3ec}.s-processing{color:#ffd24d}.s-uploaded{color:#7ec0ff}.s-downloaded{color:#7ec0ff}
  .muted{color:#9fd0e0;font-size:12px}
  code{background:#0b2735;padding:2px 5px;border-radius:4px;font-size:12px}
  .pill{display:inline-block;padding:2px 7px;border-radius:10px;font-size:11px;font-weight:600;background:#0b2735}
  .copy-btn{background:transparent;border:1px solid #2a6a86;color:#9fd0e0;padding:2px 7px;font-size:11px;border-radius:6px;cursor:pointer}
  .copy-btn:hover{color:#fff;border-color:#7ec0ff}
  .scanner-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .scanner-row .pill{background:#1e4d63;padding:5px 10px;font-size:12px}
  .small{font-size:11px;color:#9fd0e0}
  .errcell{max-width:380px;word-break:break-word}
</style></head>
<body>
<header>
  <div>
    <h1>TRA Ownership Transfers — Admin</h1>
    <div class="meta">read-only · refresh every 5s · public link</div>
  </div>
  <div class="meta" id="last-update">…</div>
</header>
<div class="wrap">
  <div class="card">
    <div class="stats" id="stats"></div>
    <div class="scanner-row" id="scanner-stats"></div>
  </div>

  <div class="card">
    <div class="filters">
      <label>Status
        <select id="f-status">
          <option value="">All</option>
          <option value="done">Done</option>
          <option value="failed">Failed</option>
          <option value="issue">Folder issue</option>
          <option value="waiting">Waiting</option>
          <option value="processing">Processing</option>
          <option value="uploaded">Uploaded</option>
          <option value="downloaded">Downloaded</option>
        </select>
      </label>
      <label>Scanner
        <select id="f-scanner"><option value="">All</option></select>
      </label>
      <label>Plate / TIN / EFD
        <input id="f-search" placeholder="MC101EZX or 180744819…">
      </label>
      <label>From date (uploaded)
        <input type="date" id="f-from">
      </label>
      <label>To date (uploaded)
        <input type="date" id="f-to">
      </label>
      <label>&nbsp;
        <button onclick="exportCsv()">Export CSV</button>
      </label>
    </div>
  </div>

  <div class="card">
    <div class="muted" id="count">…</div>
    <div style="overflow:auto;max-height:70vh">
      <table>
        <thead>
          <tr>
            <th class="sortable" data-sort="plate">Plate <span class="arrow"></span></th>
            <th>TIN</th>
            <th class="sortable" data-sort="amount">Amount <span class="arrow"></span></th>
            <th>EFD</th>
            <th>Sale date</th>
            <th class="sortable" data-sort="scannerName">Scanner <span class="arrow"></span></th>
            <th class="sortable" data-sort="status">Status <span class="arrow"></span></th>
            <th>App No / Reason</th>
            <th class="sortable" data-sort="uploadedAt">Uploaded <span class="arrow">↓</span></th>
            <th>Finished</th>
          </tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
  </div>
</div>
<script>
let CARDS = [];
let SORT = { key: "uploadedAt", dir: -1 };
function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);}
function fmt(n){return n?Number(n).toLocaleString():'';}
function fmtDt(ms){if(!ms)return '';const d=new Date(ms);return d.toLocaleString();}
function statusLabel(s){return s==='issue'?'folder issue':s;}

async function load(){
  try{
    const r=await fetch('/api/cards',{cache:'no-store'});
    const d=await r.json();
    CARDS=d.cards||[];
    document.getElementById('last-update').textContent='updated '+new Date().toLocaleTimeString();
    render();
  }catch(e){
    document.getElementById('last-update').textContent='load failed: '+e.message;
  }
}

function applyFilters(){
  const fs=document.getElementById('f-status').value;
  const fsc=document.getElementById('f-scanner').value;
  const ft=document.getElementById('f-search').value.trim().toLowerCase();
  const ffrom=document.getElementById('f-from').value;
  const fto=document.getElementById('f-to').value;
  const fromMs=ffrom?Date.parse(ffrom+'T00:00:00'):0;
  const toMs=fto?Date.parse(fto+'T23:59:59'):Number.MAX_SAFE_INTEGER;
  return CARDS.filter(c=>{
    if(fs && c.status!==fs) return false;
    if(fsc && c.scannerName!==fsc) return false;
    if(ft){
      const hay=((c.plate||'')+' '+(c.tin||'')+' '+(c.efd||'')+' '+(c.id||'')).toLowerCase();
      if(!hay.includes(ft)) return false;
    }
    const u=c.uploadedAt||0;
    if(u<fromMs||u>toMs) return false;
    return true;
  });
}

function render(){
  const all=CARDS;
  const counts={done:0,failed:0,issue:0,waiting:0,processing:0,uploaded:0,downloaded:0};
  all.forEach(c=>{counts[c.status]=(counts[c.status]||0)+1;});
  document.getElementById('stats').innerHTML=
    statBox('done','Done',counts.done)+
    statBox('failed','Failed',counts.failed)+
    statBox('issue','Folder issues',counts.issue)+
    statBox('waiting','Waiting',counts.waiting)+
    statBox('processing','Processing',counts.processing)+
    statBox('uploaded','Uploaded',counts.uploaded)+
    statBox('','Total',all.length);

  const byScanner={};
  all.forEach(c=>{byScanner[c.scannerName]=(byScanner[c.scannerName]||0)+1;});
  const scannerEntries=Object.entries(byScanner).sort((a,b)=>b[1]-a[1]);
  document.getElementById('scanner-stats').innerHTML=scannerEntries
    .map(([n,c])=>'<span class="pill">'+esc(n)+': '+c+'</span>').join('');
  const sel=document.getElementById('f-scanner');
  const cur=sel.value;
  sel.innerHTML='<option value="">All scanners</option>'+scannerEntries
    .map(([n])=>'<option value="'+esc(n)+'">'+esc(n)+'</option>').join('');
  sel.value=cur;

  let rows=applyFilters();
  rows.sort((a,b)=>{
    const k=SORT.key;
    const av=a[k]??'';const bv=b[k]??'';
    if(typeof av==='number'&&typeof bv==='number') return (av-bv)*SORT.dir;
    return String(av).localeCompare(String(bv))*SORT.dir;
  });
  document.getElementById('count').textContent=rows.length+' of '+all.length+' card(s)';
  document.querySelectorAll('th.sortable').forEach(th=>{
    const a=th.querySelector('.arrow');
    a.textContent=th.dataset.sort===SORT.key?(SORT.dir>0?'↑':'↓'):'';
  });
  document.getElementById('rows').innerHTML=rows.map(c=>{
    const reason=c.appNo?'<code>'+esc(c.appNo)+'</code> <button class="copy-btn" data-copy="'+esc(c.appNo)+'">copy</button>'
      :c.error?'<span class="errcell">'+esc(c.error)+'</span>'
      :'';
    return '<tr>'+
      '<td><b>'+esc(c.plate)+'</b></td>'+
      '<td>'+esc(c.tin)+'</td>'+
      '<td>'+fmt(c.amount)+'</td>'+
      '<td>'+esc(c.efd)+'</td>'+
      '<td>'+esc(c.date)+'</td>'+
      '<td>'+esc(c.scannerName)+'</td>'+
      '<td class="s-'+esc(c.status)+'">'+esc(statusLabel(c.status))+'</td>'+
      '<td>'+reason+'</td>'+
      '<td class="small">'+fmtDt(c.uploadedAt)+'</td>'+
      '<td class="small">'+fmtDt(c.finishedAt)+'</td>'+
      '</tr>';
  }).join('');
}

function statBox(cls,label,n){
  return '<div class="stat '+cls+'"><div class="n">'+n+'</div><div class="l">'+label+'</div></div>';
}

function exportCsv(){
  const rows=applyFilters();
  const head=['plate','tin','amount','efd','sale_date','scanner','status','app_no','error','uploaded_at','finished_at'];
  const csv=[head.join(',')].concat(rows.map(c=>[
    c.plate,c.tin,c.amount,c.efd,c.date,c.scannerName,c.status,
    (c.appNo||''),(c.error||'').replace(/"/g,'""').replace(/[\\r\\n]+/g,' '),
    c.uploadedAt?new Date(c.uploadedAt).toISOString():'',
    c.finishedAt?new Date(c.finishedAt).toISOString():'',
  ].map(v=>'"'+String(v||'').replace(/"/g,'""')+'"').join(','))).join('\\n');
  const blob=new Blob([csv],{type:'text/csv'});
  const a=document.createElement('a');
  a.href=URL.createObjectURL(blob);
  a.download='tra-cards-'+new Date().toISOString().slice(0,10)+'.csv';
  a.click();
}

document.querySelectorAll('th.sortable').forEach(th=>{
  th.addEventListener('click',()=>{
    const k=th.dataset.sort;
    if(SORT.key===k) SORT.dir*=-1; else {SORT.key=k;SORT.dir=1;}
    render();
  });
});
['f-status','f-scanner','f-from','f-to'].forEach(id=>document.getElementById(id).addEventListener('change',render));
document.getElementById('f-search').addEventListener('input',render);
document.getElementById('rows').addEventListener('click',e=>{
  const b=e.target.closest('[data-copy]'); if(!b) return;
  navigator.clipboard.writeText(b.dataset.copy);
  const o=b.textContent;b.textContent='copied!';setTimeout(()=>b.textContent=o,1200);
});

load();setInterval(load,5000);
</script>
</body></html>`;
}
