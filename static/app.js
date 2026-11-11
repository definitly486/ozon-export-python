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
function filtered() {
 const q=$('search').value.trim().toLowerCase();
 const source=$('sourceFilter').value;
 return operations.map((r,i)=>({r,i})).filter(({r}) =>
  (!q || [r.date_local,r.name,r.purpose,r.category,r.debit,r.credit,r.amount].some(v=>String(v??'').toLowerCase().includes(q))) &&
  (source==='all' || (source==='psb' ? isPsb(r) : !isPsb(r))) &&
  !($('exclude').checked && isOzon(r))
 );
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
 const totalLabel=source==='psb'?'ПСБ':source==='ozon'?'Ozon':'всем банкам';
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
$('loadPsb').onclick=async()=>{if(!$('start').value||!$('end').value||$('start').value>$('end').value){msg('Проверьте даты периода.',true);return;}const file=$('psbFile').files[0];if(!file){$('psbFile').click();msg('Сначала выберите CSV-выписку ПСБ.');return;}const form=new FormData();form.append('file',file);const url=`/api/psb/import?start=${encodeURIComponent($('start').value)}&end=${encodeURIComponent($('end').value)}`;msg('Импортирую выписку ПСБ…');$('loadPsb').disabled=true;try{const r=await fetch(url,{method:'POST',body:form});const j=await r.json();if(!r.ok)throw Error(j.error||'Не удалось импортировать выписку ПСБ');operations=j.items;selected=new Set(operations.map((_,i)=>i));render();const u=j.sync||{};msg(`ПСБ: добавлено ${u.new||0}, уже было ${u.unchanged||0}, обновлено ${u.updated||0}. В общей истории за период: ${j.count} операций (ПСБ: ${j.summary?.psb||0}).`);refreshDbStatus(j.database);}catch(e){msg(e.message,true);}finally{$('loadPsb').disabled=false;}};
$('load').onclick=async()=>{if(!$('start').value||!$('end').value||$('start').value>$('end').value){msg('Проверьте даты периода.',true);return;}const file=$('sourceFile').files[0];if(!file){$('sourceFile').click();msg('Сначала выберите JSON-файл, скачанный из Ozon.');return;}msg('Синхронизирую локальную базу…');$('load').disabled=true;try{const payload=JSON.parse(await file.text());const url=`/api/sync?start=${encodeURIComponent($('start').value)}&end=${encodeURIComponent($('end').value)}`;const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const j=await r.json();if(!r.ok)throw Error(j.error||'Не удалось импортировать операции');operations=j.items;selected=new Set(operations.map((_,i)=>i));render();const s=j.summary||{};const u=j.sync||{};msg(`База обновлена: новых ${u.new||0}, изменённых ${u.updated||0}, без изменений ${u.unchanged||0}, пропущено без ID ${u.skipped||0}. В периоде: ${j.count} операций, HOLD: ${s.hold||0}; прочих неподтверждённых: ${s.excluded_other||0}.`);refreshDbStatus(j.database);}catch(e){msg(e.message,true);}finally{$('load').disabled=false;}};
async function copyBookmarkletCode(text, fieldId, buttonId, bankLabel) {
 const field=$(fieldId), button=$(buttonId), original=button.textContent;
 button.disabled=true;
 try {
  if(navigator.clipboard && window.isSecureContext) {
   await navigator.clipboard.writeText(text);
  } else {
   throw new Error('Clipboard API unavailable');
  }
  button.textContent='Скопировано ✓';
  msg(`Код закладки ${bankLabel} скопирован. Создайте закладку Firefox и вставьте код в поле «Адрес».`);
 } catch(error) {
  field.focus();
  field.select();
  let copied=false;
  try { copied=document.execCommand('copy'); } catch(_) {}
  if(copied) {
   button.textContent='Скопировано ✓';
   msg(`Код закладки ${bankLabel} скопирован. Вставьте его в поле «Адрес» новой закладки Firefox.`);
  } else {
   button.textContent='Код выделен — Ctrl+C';
   msg(`Автоматическое копирование недоступно. Код ${bankLabel} выделен: нажмите Ctrl+C.`);
  }
 }
 button.disabled=false;
 clearTimeout(button._copyResetTimer);
 button._copyResetTimer=setTimeout(()=>{button.textContent=original;},2500);
}

const bookmarklet = `javascript:(async()=>{try{const api='https://finance.ozon.ru/apps/pfm/api/operations/groupOperationsV3';let cursor=null,items=[],page=0;do{const r=await fetch(api,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({cursorPagination:{cursor,perPage:100},filter:{categories:[],effect:'EFFECT_UNKNOWN',pfmTags:[],accountTokens:[],timeZone:'Europe/Moscow'}})});if(!r.ok)throw Error('HTTP '+r.status);const j=await r.json();const g=j?.data?.me?.client?.groupOperationsV3;if(!g||!Array.isArray(g.items))throw Error('Неожиданный ответ API');items.push(...g.items);cursor=g.cursors?.next??null;page++;if(page>=500)break;}while(cursor);const blob=new Blob([JSON.stringify({items},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ozon_operations_raw.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),30000);alert('Готово: скачано операций '+items.length);}catch(e){alert('Не удалось выгрузить операции: '+e.message);}})();`;
$('bookmarklet').value=bookmarklet;
$('copyBookmarklet').onclick=()=>copyBookmarkletCode(bookmarklet,'bookmarklet','copyBookmarklet','Ozon');

$('search').oninput=render;$('sourceFilter').onchange=render;$('exclude').onchange=()=>{if($('exclude').checked)operations.forEach((r,i)=>{if(isOzon(r))selected.delete(i);});render();};
$('all').onclick=()=>{filtered().forEach(({i})=>selected.add(i));render();};$('none').onclick=()=>{selected.clear();render();};
$('export').onclick=async()=>{const items=operations.filter((_,i)=>selected.has(i));try{const r=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items})});if(!r.ok){const j=await r.json();throw Error(j.error);}const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`bank_operations_${ymd(new Date())}.csv`;a.click();URL.revokeObjectURL(url);msg(`Экспортировано строк: ${items.length}`);}catch(e){msg(e.message,true);}};


let lastDatabaseSync = null;
let lastDatabaseTotal = null;
let databasePollInProgress = false;
let databasePollTimer = null;

async function refreshDbStatus(stats) {
 try {
  if (!stats) {
   const response = await fetch('/api/stats', {cache:'no-store'});
   if (!response.ok) throw Error('Не удалось прочитать базу');
   stats = await response.json();
  }
  const last = stats.last_sync_at ? new Date(stats.last_sync_at).toLocaleString() : 'ещё не выполнялась';
  $('dbStatus').textContent = `Локальная база SQLite: Ozon — ${stats.total}, ПСБ — ${stats.psb_total||0}. Подтверждённых Ozon: ${stats.confirmed}, HOLD: ${stats.hold}. Последнее обновление: ${last}.`;
 } catch (e) {
  $('dbStatus').textContent = 'Не удалось получить состояние локальной базы: ' + e.message;
 }
}

// Detect external imports by both the sync timestamp and row count. The
// second signal also catches timestamp problems in older/local DB versions.
async function checkDatabaseForExternalChanges() {
 if (databasePollInProgress || document.hidden) return;
 databasePollInProgress = true;
 try {
  const response = await fetch('/api/stats?_=' + Date.now(), {cache:'no-store'});
  if (!response.ok) throw Error('HTTP ' + response.status);
  const stats = await response.json();
  const currentSync = stats.last_sync_at || null;
  const currentTotal = Number(stats.total || 0);
  const changed = (currentSync && lastDatabaseSync && currentSync !== lastDatabaseSync) ||
    (lastDatabaseTotal !== null && currentTotal !== lastDatabaseTotal);
  lastDatabaseSync = currentSync;
  lastDatabaseTotal = currentTotal;
  if (changed) {
   await reloadPeriodFromDatabase();
   // Reload may return its own stats snapshot; use the latest poll as baseline.
   lastDatabaseSync = currentSync;
   lastDatabaseTotal = currentTotal;
  }
  await refreshDbStatus(stats);
 } catch (error) {
  const status = $('dbStatus');
  if (status) status.textContent = 'Автообновление: ошибка проверки локальной базы (' + error.message + ').';
 } finally {
  databasePollInProgress = false;
 }
}

async function initializeDashboard() {
 try {
  const response = await fetch('/api/stats?_=' + Date.now(), {cache:'no-store'});
  if (response.ok) {
   const stats = await response.json();
   lastDatabaseSync = stats.last_sync_at || null;
   lastDatabaseTotal = Number(stats.total || 0);
   await refreshDbStatus(stats);
  } else {
   await refreshDbStatus();
  }
 } catch (_) {
  await refreshDbStatus();
 }
 await reloadPeriodFromDatabase();
 if (databasePollTimer) clearInterval(databasePollTimer);
 databasePollTimer = setInterval(checkDatabaseForExternalChanges, 2000);
}
document.addEventListener('visibilitychange', () => {
 if (!document.hidden) checkDatabaseForExternalChanges();
});

const psbBookmarklet = `javascript:(()=>{const norm=s=>String(s||'').replace(/\\s+/g,' ').trim();const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};const find=t=>{const all=[...document.querySelectorAll('button,a,[role="button"],[tabindex],div,span')].filter(e=>visible(e)&&norm(e.innerText||e.textContent)===t);all.sort((a,b)=>{const score=e=>(e.matches('button,a,[role="button"]')?0:1)+(e.querySelector('*')?1:0);return score(a)-score(b);});return all[0];};const click=e=>(e.closest('button,a,[role="button"]')||e).click();const csv=find('Скачать в CSV');if(csv){click(csv);return;}const open=find('Получить выписку');if(!open){alert('Не найдена кнопка «Получить выписку». Откройте страницу выписки ПСБ и попробуйте ещё раз.');return;}click(open);setTimeout(()=>{const item=find('Скачать в CSV');if(!item){alert('Меню выписки открылось, но пункт «Скачать в CSV» не найден. Откройте меню вручную и нажмите закладку ещё раз.');return;}click(item);},500);})();`;
$('psbBookmarklet').value=psbBookmarklet;
$('copyPsbBookmarklet').onclick=()=>copyBookmarkletCode(psbBookmarklet,'psbBookmarklet','copyPsbBookmarklet','ПСБ');

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
