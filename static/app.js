const $ = (id) => document.getElementById(id);
const today = new Date();
const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const first = new Date(today.getFullYear(), today.getMonth(), 1);
const DEFAULT_START = ymd(first), DEFAULT_END = ymd(today);
$('end').max = DEFAULT_END;

// Restore the last selected period after a reload or browser restart.
try {
 const savedStart = localStorage.getItem('ozonBillStartDate');
 const savedEnd = localStorage.getItem('ozonBillEndDate');
 $('start').value = savedStart && /^\d{4}-\d{2}-\d{2}$/.test(savedStart) ? savedStart : DEFAULT_START;
 $('end').value = savedEnd && /^\d{4}-\d{2}-\d{2}$/.test(savedEnd) && savedEnd <= DEFAULT_END ? savedEnd : DEFAULT_END;
} catch (_) {
 $('start').value = DEFAULT_START;
 $('end').value = DEFAULT_END;
}
function saveSelectedPeriod() {
 try {
  localStorage.setItem('ozonBillStartDate', $('start').value);
  localStorage.setItem('ozonBillEndDate', $('end').value);
 } catch (_) {}
}
let operations = []; let selected = new Set();
const money = n => Number(n || 0).toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isOzon = r => [r.name,r.category,r.purpose].some(v => /\bozon\b/i.test(String(v || '')));
function msg(text, error=false) { $('message').textContent=text; $('message').className='message'+(error?' error':''); }
const isPsb = r => /псб|psb/i.test(String(r.source || ''));
const isSber = r => /сбер/i.test(String(r.source || ''));
function filtered() {
 const q=$('search').value.trim().toLowerCase();
 const source=$('sourceFilter').value;
 const rows=operations.map((r,i)=>({r,i})).filter(({r}) =>
  (!q || [r.date_local,r.name,r.purpose,r.category,r.debit,r.credit,r.amount].some(v=>String(v??'').toLowerCase().includes(q))) &&
  (source==='all' || (source==='psb' ? isPsb(r) : source==='sber' ? isSber(r) : source==='ozon' ? !isPsb(r) && !isSber(r) : true)) &&
  !($('exclude').checked && isOzon(r))
 );
 // Keep the default chronological order, or sort by numeric credit descending.
 if($('sortOrder')?.value==='credit-desc') {
  rows.sort((a,b)=>Number(b.r.credit||0)-Number(a.r.credit||0) || String(b.r.time||'').localeCompare(String(a.r.time||'')));
 }
 return rows;
}
function shortPurpose(value) {
 const full=String(value ?? '').replace(/\\s+/g,' ').trim();
 // PSB repeats masked account and technical transaction/MCC details in every row.
 const concise=full
  .replace(/^\\S+\\s+(?=(Покупка|Безналичное списание|Зачисление)\\b)/i,'')
  .replace(/^(Покупка|Безналичное списание|Зачисление)\\s+/i,'')
  .replace(/\\s+\\d{6,}\\.?\\s*(?:MCC\\s*\\d+)?\\s*$/i,'')
  .replace(/\\s+MCC\\s*\\d+\\s*$/i,'')
  .trim();
 return {full, concise:concise || full};
}
function render() {
 const list=filtered(); $('count').textContent=`Показано: ${list.length} · Выбрано: ${selected.size} · Всего: ${operations.length}`;
 $('export').disabled=!operations.some((r,i)=>selected.has(i) && r.status!=='GROUP_OPERATION_HOLD');
 if (!list.length) $('rows').innerHTML=`<tr><td colspan="9" class="empty">${operations.length?'Ничего не найдено':'Операций нет за выбранный период.'}</td></tr>`;
 else $('rows').innerHTML=list.map(({r,i})=>{const purpose=shortPurpose(r.purpose);return `<tr class="${selected.has(i)?'':'unselected'}"><td><input type="checkbox" data-index="${i}" ${selected.has(i)?'checked':''}></td><td title="${esc(r.date_local)}">${esc(r.date_local)}</td><td>${esc(r.source || "Ozon")}${r.status==='GROUP_OPERATION_HOLD'?' <span class="hold-badge">HOLD</span>':''}</td><td title="${esc(r.name)}"><b>${esc(r.name)}</b></td><td class="purpose-cell" title="${esc(purpose.full)}">${esc(purpose.concise)}</td><td title="${esc(r.category)}">${esc(r.category)}</td><td class="num">${r.debit?money(r.debit):''}</td><td class="num">${r.credit?money(r.credit):''}</td><td class="num ${r.amount<0?'negative':'positive'}">${money(r.amount)}</td></tr>`}).join('');
 // Totals follow the active bank/search filters and include only checked rows
 // that are currently visible in the table.
 const chosen=list.filter(({i,r})=>selected.has(i) && r.status!=='GROUP_OPERATION_HOLD').map(({r})=>r);
 const sum=k=>chosen.reduce((a,r)=>a+Number(r[k]||0),0);
 const source=$('sourceFilter').value;
 const totalLabel=source==='psb'?'ПСБ':source==='sber'?'Сбербанк':source==='ozon'?'Ozon':'всем банкам';
 $('totals').innerHTML=chosen.length?`<tr><td colspan="6">Итого по ${totalLabel} (выбрано: ${chosen.length})</td><td class="num">${money(sum('debit'))}</td><td class="num">${money(sum('credit'))}</td><td class="num">${money(sum('amount'))}</td></tr>`:`<tr><td colspan="9" class="empty">Нет выбранных операций для текущего фильтра (${totalLabel}).</td></tr>`;
}
let dateRefreshTimer = null;
let dateRefreshController = null;
async function reloadPeriodFromDatabase() {
 const start=$('start').value, end=$('end').value;
 if(!start || !end || start>end) return;
 if(dateRefreshController) dateRefreshController.abort();
 dateRefreshController=new AbortController();
 msg('Обновляю отображение из локальной базы…');
 try {
  const url=`/api/operations?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`;
  const response=await fetch(url,{signal:dateRefreshController.signal,cache:'no-store'});
  const data=await response.json();
  if(!response.ok) throw Error(data.error||'Не удалось загрузить операции за выбранный период');
  operations=data.items||[];
  selected=new Set(operations.map((_,i)=>i));
  render();
  const holds=operations.filter(r=>r.status==='GROUP_OPERATION_HOLD').length;
  msg(`Период обновлён из локальной базы: ${operations.length} операций, из них HOLD: ${holds}. HOLD не входят в денежные итоги и CSV.`);
  refreshDbStatus(data.database);
 } catch(error) {
  if(error.name!=='AbortError') msg(error.message,true);
 }
}
function schedulePeriodRefresh() {
 clearTimeout(dateRefreshTimer);
 dateRefreshTimer=setTimeout(reloadPeriodFromDatabase,250);
}
['start','end'].forEach(id=>{
 const field=$(id);
 field.addEventListener('input',saveSelectedPeriod);
 field.addEventListener('change',()=>{saveSelectedPeriod();schedulePeriodRefresh();});
 field.addEventListener('blur',saveSelectedPeriod);
});
window.addEventListener('pagehide',saveSelectedPeriod);

$('rows').addEventListener('change',e=>{if(e.target.matches('input[data-index]')){const i=Number(e.target.dataset.index);e.target.checked?selected.add(i):selected.delete(i);render();}});
$('connect').onclick=async()=>{msg('Открываю Ozon в обычном браузере…');try{const r=await fetch('/api/connect',{method:'POST'});const j=await r.json();if(!r.ok)throw Error(j.error);$('status').textContent='Откройте Ozon в обычном Firefox';msg(j.message);}catch(e){msg(e.message,true);}};
$('connectPsb').onclick=async()=>{msg('Открываю ПСБ в обычном браузере…');try{const r=await fetch('/api/connect/psb',{method:'POST'});const j=await r.json();if(!r.ok)throw Error(j.error);$('status').textContent='Откройте ПСБ в обычном Firefox';msg(j.message);}catch(e){msg(e.message,true);}};
$('load').onclick=async()=>{if(!$('start').value||!$('end').value||$('start').value>$('end').value){msg('Проверьте даты периода.',true);return;}const file=$('sourceFile').files[0];if(!file){$('sourceFile').click();msg('Сначала выберите JSON-файл, скачанный из Ozon.');return;}msg('Синхронизирую локальную базу…');$('load').disabled=true;try{const payload=JSON.parse(await file.text());const url=`/api/sync?start=${encodeURIComponent($('start').value)}&end=${encodeURIComponent($('end').value)}`;const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const j=await r.json();if(!r.ok)throw Error(j.error||'Не удалось импортировать операции');operations=j.items;selected=new Set(operations.map((_,i)=>i));render();const s=j.summary||{};const u=j.sync||{};msg(`База обновлена: новых ${u.new||0}, изменённых ${u.updated||0}, без изменений ${u.unchanged||0}, пропущено без ID ${u.skipped||0}. В периоде: ${j.count} операций, HOLD: ${s.hold||0}; прочих неподтверждённых: ${s.excluded_other||0}.`);refreshDbStatus(j.database);}catch(e){msg(e.message,true);}finally{$('load').disabled=false;}};


$('psbLoad').onclick=async()=>{
 const file=$('psbSourceFile').files[0];
 if(!file){$('psbSourceFile').click();msg('Выберите CSV-выписку ПСБ.');return;}
 if(!$('start').value||!$('end').value||$('start').value>$('end').value){msg('Проверьте даты отображаемого периода.',true);return;}
 const button=$('psbLoad');button.disabled=true;msg('Импортирую CSV-выписку ПСБ…');
 try{
  const form=new FormData();form.append('file',file);
  const url=`/api/psb/import?start=${encodeURIComponent($('start').value)}&end=${encodeURIComponent($('end').value)}`;
  const response=await fetch(url,{method:'POST',body:form,cache:'no-store'});
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'Не удалось импортировать выписку ПСБ');
  await reloadPeriodFromDatabase();
  await refreshDbStatus(data.database);
  const sync=data.sync||{},psb=data.psb||{};
  msg(`ПСБ: новых ${sync.new||0}, обновлено ${sync.updated||0}, без изменений ${sync.unchanged||0}. Всего операций ПСБ в базе: ${psb.database_total||0}. Импортировано строк из файла: ${psb.imported_from_file||0}.`);
  $('psbSourceFile').value='';
 }catch(error){msg(error.message,true);}
 finally{button.disabled=false;}
};


$('sberLoad').onclick=async()=>{
 const file=$('sberSourceFile').files[0];
 if(!file){$('sberSourceFile').click();msg('Выберите PDF-выписку Сбербанка.');return;}
 if(!$('start').value||!$('end').value||$('start').value>$('end').value){msg('Проверьте даты отображаемого периода.',true);return;}
 const button=$('sberLoad');button.disabled=true;msg('Читаю PDF и импортирую операции Сбербанка…');
 try{
  const form=new FormData();form.append('file',file);
  const url=`/api/sber/import?start=${encodeURIComponent($('start').value)}&end=${encodeURIComponent($('end').value)}`;
  const response=await fetch(url,{method:'POST',body:form,cache:'no-store'});
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'Не удалось импортировать PDF Сбербанка');
  await reloadPeriodFromDatabase();
  await refreshDbStatus(data.database);
  const sync=data.sync||{},sber=data.sber||{};
  msg(`Сбербанк: новых ${sync.new||0}, обновлено ${sync.updated||0}, без изменений ${sync.unchanged||0}. Всего операций Сбербанка в базе: ${sber.database_total||0}. Найдено в PDF: ${sber.imported_from_file||0}.`);
  $('sberSourceFile').value='';
 }catch(error){msg(error.message,true);}
 finally{button.disabled=false;}
};

$('databaseExport').onclick=async()=>{
 const password=prompt('Придумайте пароль для шифрования резервной копии (не менее 10 символов):');
 if(password===null)return;
 if(password.length<10){msg('Пароль должен содержать не менее 10 символов.',true);return;}
 const confirmation=prompt('Повторите пароль для подтверждения:');
 if(confirmation===null)return;
 if(password!==confirmation){msg('Пароли не совпадают.',true);return;}
 const button=$('databaseExport');button.disabled=true;msg('Создаю и шифрую резервную копию SQLite…');
 try{
  const response=await fetch('/api/database/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
  if(!response.ok){const data=await response.json();throw Error(data.error||'Не удалось экспортировать базу');}
  const blob=await response.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='ozon_operations_'+ymd(new Date())+'.sqlite3.enc';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  msg('Зашифрованная резервная копия скачана. Сохраните пароль отдельно: без него файл не открыть.');
 }catch(error){msg(error.message,true);}finally{button.disabled=false;}
};

$('databaseImport').onclick=async()=>{
 const file=$('databaseImportFile').files[0];
 if(!file){msg('Сначала выберите файл резервной копии .sqlite3.enc.',true);return;}
 if(!confirm('ВНИМАНИЕ! Текущая база Ozon, ПСБ и Сбербанка будет полностью заменена данными из выбранной резервной копии. Продолжить?'))return;
 const password=prompt('Введите пароль, который использовался при создании резервной копии:');
 if(password===null)return;
 if(password.length<10){msg('Пароль должен содержать не менее 10 символов.',true);return;}
 const button=$('databaseImport');button.disabled=true;msg('Расшифровываю и проверяю резервную копию…');
 try{
  const form=new FormData();form.append('file',file);form.append('password',password);
  const response=await fetch('/api/database/import',{method:'POST',body:form,cache:'no-store'});
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'Не удалось восстановить базу');
  $('databaseImportFile').value='';
  msg(data.message||'База успешно восстановлена.');
  await reloadPeriodFromDatabase();
  await refreshDbStatus();
 }catch(error){msg(error.message,true);}
 finally{button.disabled=false;}
};
$('search').oninput=render;
$('sourceFilter').onchange=render;
$('sortOrder').onchange=render;
$('exclude').onchange=()=>{if($('exclude').checked)operations.forEach((r,i)=>{if(isOzon(r))selected.delete(i);});render();};
$('all').onclick=()=>{filtered().forEach(({i})=>selected.add(i));render();};
$('none').onclick=()=>{selected.clear();render();};
$('export').onclick=async()=>{
 const items=operations.filter((_,i)=>selected.has(i) && operations[i].status!=='GROUP_OPERATION_HOLD');
 try {
  const r=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items})});
  if(!r.ok){const j=await r.json();throw Error(j.error||'Ошибка экспорта');}
  const blob=await r.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=`bank_operations_${ymd(new Date())}.csv`;a.click();URL.revokeObjectURL(url);
  msg(`Экспортировано строк: ${items.length}`);
 } catch(e){msg(e.message,true);}
};

let lastDatabaseSync=null,lastDatabaseTotal=null,lastPsbSync=null,lastPsbTotal=null,lastSberSync=null,lastSberTotal=null,databasePollInProgress=false,databasePollTimer=null;
async function refreshDbStatus(stats) {
 try {
  if(!stats){const response=await fetch('/api/stats?_='+Date.now(),{cache:'no-store'});if(!response.ok)throw Error('Не удалось прочитать базу');stats=await response.json();}
  const last=stats.last_sync_at?new Date(stats.last_sync_at).toLocaleString():'ещё не выполнялась';
  $('dbStatus').textContent=`Локальная база SQLite: Ozon — ${stats.total||0}, ПСБ — ${stats.psb_total||0}, Сбербанк — ${stats.sber_total||0}. Подтверждённых Ozon: ${stats.confirmed||0}, HOLD: ${stats.hold||0}. Последнее обновление: ${last}.`;
 } catch(e){$('dbStatus').textContent='Не удалось получить состояние локальной базы: '+e.message;}
}
async function checkDatabaseForExternalChanges(){
 if(databasePollInProgress||document.hidden)return;
 databasePollInProgress=true;
 try{
  const response=await fetch('/api/stats?_='+Date.now(),{cache:'no-store'});
  if(!response.ok)throw Error('HTTP '+response.status);
  const stats=await response.json(),sync=stats.last_sync_at||null,total=Number(stats.total||0);
  const psbSync=stats.psb_last_sync_at||null,psbTotal=Number(stats.psb_total||0);
  const sberSync=stats.sber_last_sync_at||null,sberTotal=Number(stats.sber_total||0);
  const changed=sync!==lastDatabaseSync||(lastDatabaseTotal!==null&&total!==lastDatabaseTotal)||
   psbSync!==lastPsbSync||(lastPsbTotal!==null&&psbTotal!==lastPsbTotal)||
   sberSync!==lastSberSync||(lastSberTotal!==null&&sberTotal!==lastSberTotal);
  lastDatabaseSync=sync;lastDatabaseTotal=total;lastPsbSync=psbSync;lastPsbTotal=psbTotal;lastSberSync=sberSync;lastSberTotal=sberTotal;
  if(changed){await reloadPeriodFromDatabase();lastDatabaseSync=sync;lastDatabaseTotal=total;lastPsbSync=psbSync;lastPsbTotal=psbTotal;}
  await refreshDbStatus(stats);
 }catch(e){$('dbStatus').textContent='Автообновление: ошибка проверки локальной базы ('+e.message+').';}
 finally{databasePollInProgress=false;}
}
async function initializeDashboard(){
 try{
  const response=await fetch('/api/stats?_='+Date.now(),{cache:'no-store'});
  if(!response.ok)throw Error('HTTP '+response.status);
  const stats=await response.json();
  lastDatabaseSync=stats.last_sync_at||null;lastDatabaseTotal=Number(stats.total||0);
  lastPsbSync=stats.psb_last_sync_at||null;lastPsbTotal=Number(stats.psb_total||0);
  lastSberSync=stats.sber_last_sync_at||null;lastSberTotal=Number(stats.sber_total||0);
  await refreshDbStatus(stats);
 }catch(e){await refreshDbStatus();}
 await reloadPeriodFromDatabase();
 if(databasePollTimer)clearInterval(databasePollTimer);
 databasePollTimer=setInterval(checkDatabaseForExternalChanges,2000);
}
document.addEventListener('visibilitychange',()=>{if(!document.hidden)checkDatabaseForExternalChanges();});

// Initialize the dashboard before starting external-import polling.
initializeDashboard();


// Appearance switch: presentation only; all existing application logic is preserved.
(function initDesignToggle(){
 const button=$('designToggle');
 if(!button) return;
 const apply=modern=>{
  document.body.classList.toggle('design-modern',modern);
  button.textContent=modern?'↩ Старый дизайн':'✨ Новый дизайн';
  button.setAttribute('aria-pressed',String(modern));
  try{localStorage.setItem('ozonBillDesign',modern?'modern':'classic');}catch(_){}
 };
 let modern=false;
 try{modern=localStorage.getItem('ozonBillDesign')==='modern';}catch(_){}
 apply(modern);
 button.addEventListener('click',()=>apply(!document.body.classList.contains('design-modern')));
})();
