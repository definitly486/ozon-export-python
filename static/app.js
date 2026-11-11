const $ = (id) => document.getElementById(id);
const today = new Date();
const ymd = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
const first = new Date(today.getFullYear(), today.getMonth(), 1);
$('start').value = ymd(first); $('end').value = ymd(today); $('end').max = ymd(today);
let operations = []; let selected = new Set();
const money = n => Number(n || 0).toLocaleString('ru-RU', {minimumFractionDigits:2, maximumFractionDigits:2});
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isOzon = r => [r.name,r.category,r.purpose].some(v => /\bozon\b/i.test(String(v || '')));
function msg(text, error=false) { $('message').textContent=text; $('message').className='message'+(error?' error':''); }
function filtered() { const q=$('search').value.trim().toLowerCase(); return operations.map((r,i)=>({r,i})).filter(({r}) => (!q || [r.date_local,r.name,r.purpose,r.category,r.debit,r.credit,r.amount].some(v=>String(v??'').toLowerCase().includes(q))) && !($('exclude').checked && isOzon(r))); }
function render() {
 const list=filtered(); $('count').textContent=`Показано: ${list.length} · Выбрано: ${selected.size} · Всего: ${operations.length}`;
 $('export').disabled=selected.size===0;
 if (!list.length) $('rows').innerHTML=`<tr><td colspan="9" class="empty">${operations.length?'Ничего не найдено':'Операций нет за выбранный период.'}</td></tr>`;
 else $('rows').innerHTML=list.map(({r,i})=>`<tr class="${selected.has(i)?'':'unselected'}"><td><input type="checkbox" data-index="${i}" ${selected.has(i)?'checked':''}></td><td>${esc(r.date_local)}</td><td>${esc(r.source || "Ozon")}</td><td><b>${esc(r.name)}</b></td><td>${esc(r.purpose)}</td><td>${esc(r.category)}</td><td class="num">${r.debit?money(r.debit):''}</td><td class="num">${r.credit?money(r.credit):''}</td><td class="num ${r.amount<0?'negative':'positive'}">${money(r.amount)}</td></tr>`).join('');
 const chosen=operations.filter((_,i)=>selected.has(i)); const sum=k=>chosen.reduce((a,r)=>a+Number(r[k]||0),0);
 $('totals').innerHTML=chosen.length?`<tr><td colspan="6">Итого по выбранным (${chosen.length})</td><td class="num">${money(sum('debit'))}</td><td class="num">${money(sum('credit'))}</td><td class="num">${money(sum('amount'))}</td></tr>`:'';
}
$('rows').addEventListener('change',e=>{if(e.target.matches('input[data-index]')){const i=Number(e.target.dataset.index);e.target.checked?selected.add(i):selected.delete(i);render();}});
$('connect').onclick=async()=>{msg('Открываю Ozon в обычном браузере…');try{const r=await fetch('/api/connect',{method:'POST'});const j=await r.json();if(!r.ok)throw Error(j.error);$('status').textContent='Откройте Ozon в обычном Firefox';msg(j.message);}catch(e){msg(e.message,true);}};
$('loadPsb').onclick=async()=>{if(!$('start').value||!$('end').value||$('start').value>$('end').value){msg('Проверьте даты периода.',true);return;}const file=$('psbFile').files[0];if(!file){$('psbFile').click();msg('Сначала выберите CSV-выписку ПСБ.');return;}const form=new FormData();form.append('file',file);const url=`/api/psb/import?start=${encodeURIComponent($('start').value)}&end=${encodeURIComponent($('end').value)}`;msg('Импортирую выписку ПСБ…');$('loadPsb').disabled=true;try{const r=await fetch(url,{method:'POST',body:form});const j=await r.json();if(!r.ok)throw Error(j.error||'Не удалось импортировать выписку ПСБ');operations=j.items;selected=new Set(operations.map((_,i)=>i));render();const u=j.sync||{};msg(`ПСБ: добавлено ${u.new||0}, уже было ${u.unchanged||0}, обновлено ${u.updated||0}. В общей истории за период: ${j.count} операций (ПСБ: ${j.summary?.psb||0}).`);refreshDbStatus(j.database);}catch(e){msg(e.message,true);}finally{$('loadPsb').disabled=false;}};
$('load').onclick=async()=>{if(!$('start').value||!$('end').value||$('start').value>$('end').value){msg('Проверьте даты периода.',true);return;}const file=$('sourceFile').files[0];if(!file){$('sourceFile').click();msg('Сначала выберите JSON-файл, скачанный из Ozon.');return;}msg('Синхронизирую локальную базу…');$('load').disabled=true;try{const payload=JSON.parse(await file.text());const url=`/api/sync?start=${encodeURIComponent($('start').value)}&end=${encodeURIComponent($('end').value)}`;const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const j=await r.json();if(!r.ok)throw Error(j.error||'Не удалось импортировать операции');operations=j.items;selected=new Set(operations.map((_,i)=>i));render();const s=j.summary||{};const u=j.sync||{};msg(`База обновлена: новых ${u.new||0}, изменённых ${u.updated||0}, без изменений ${u.unchanged||0}, пропущено без ID ${u.skipped||0}. В периоде подтверждённых операций: ${j.count}; HOLD исключено: ${s.excluded_hold||0}; прочих неподтверждённых: ${s.excluded_other||0}.`);refreshDbStatus(j.database);}catch(e){msg(e.message,true);}finally{$('load').disabled=false;}};
const bookmarklet = `javascript:(async()=>{try{const api='https://finance.ozon.ru/apps/pfm/api/operations/groupOperationsV3';let cursor=null,items=[],page=0;do{const r=await fetch(api,{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify({cursorPagination:{cursor,perPage:100},filter:{categories:[],effect:'EFFECT_UNKNOWN',pfmTags:[],accountTokens:[],timeZone:'Europe/Moscow'}})});if(!r.ok)throw Error('HTTP '+r.status);const j=await r.json();const g=j?.data?.me?.client?.groupOperationsV3;if(!g||!Array.isArray(g.items))throw Error('Неожиданный ответ API');items.push(...g.items);cursor=g.cursors?.next??null;page++;if(page>=500)break;}while(cursor);const blob=new Blob([JSON.stringify({items},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='ozon_operations_raw.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),30000);alert('Готово: скачано операций '+items.length);}catch(e){alert('Не удалось выгрузить операции: '+e.message);}})();`;
$('bookmarklet').value=bookmarklet;
$('copyBookmarklet').onclick=async()=>{try{await navigator.clipboard.writeText(bookmarklet);msg('Код закладки скопирован. Создайте новую закладку Firefox и вставьте его в поле «Адрес».');}catch(e){$('bookmarklet').focus();$('bookmarklet').select();msg('Выделил код — скопируйте его вручную сочетанием Ctrl+C.');}};

$('search').oninput=render;$('exclude').onchange=()=>{if($('exclude').checked)operations.forEach((r,i)=>{if(isOzon(r))selected.delete(i);});render();};
$('all').onclick=()=>{filtered().forEach(({i})=>selected.add(i));render();};$('none').onclick=()=>{selected.clear();render();};
$('export').onclick=async()=>{const items=operations.filter((_,i)=>selected.has(i));try{const r=await fetch('/api/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items})});if(!r.ok){const j=await r.json();throw Error(j.error);}const blob=await r.blob();const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`bank_operations_${ymd(new Date())}.csv`;a.click();URL.revokeObjectURL(url);msg(`Экспортировано строк: ${items.length}`);}catch(e){msg(e.message,true);}};


async function refreshDbStatus(stats) {
 try {
  if (!stats) {
   const response = await fetch('/api/stats');
   if (!response.ok) throw Error('Не удалось прочитать базу');
   stats = await response.json();
  }
  const last = stats.last_sync_at ? new Date(stats.last_sync_at).toLocaleString() : 'ещё не выполнялась';
  $('dbStatus').textContent = `Локальная база SQLite: Ozon — ${stats.total}, ПСБ — ${stats.psb_total||0}. Подтверждённых Ozon: ${stats.confirmed}, HOLD: ${stats.hold}. Последнее обновление: ${last}.`;
 } catch (e) {
  $('dbStatus').textContent = 'Не удалось получить состояние локальной базы: ' + e.message;
 }
}
refreshDbStatus();
