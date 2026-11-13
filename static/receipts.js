const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=v=>{if(v===null||v===undefined||v==='')return '—';const n=Number(String(v).replace(',','.'));return Number.isFinite(n)?n.toLocaleString('ru-RU',{minimumFractionDigits:2,maximumFractionDigits:2})+' ₽':esc(v)};
const date=v=>{if(!v)return '—';const d=new Date(v);return Number.isNaN(d.getTime())?esc(v):d.toLocaleString('ru-RU')};
let receipts=[];
function dataOf(r){return r.fiscalData||{}}
function metaOf(r){return r.receipt||{}}
function receiptDate(r){const m=metaOf(r),d=dataOf(r);return d.dateTime||m.createdDate||m.receiveDate||''}
function total(r){const d=dataOf(r),m=metaOf(r);return d.totalSum??m.totalSum??0}
function amount(r){const n=Number(String(total(r)).replace(',','.'));return Number.isFinite(n)?n:0}
function operationType(r){const n=Number(dataOf(r).operationType);return Number.isInteger(n)?n:0}
function renderTotals(rows){
 const sums={income:0,incomeReturn:0,expense:0,expenseReturn:0,unknown:0};
 rows.forEach(({r})=>{
  const value=amount(r);
  switch(operationType(r)){
   case 1:sums.income+=value;break;
   case 2:sums.incomeReturn+=value;break;
   case 3:sums.expense+=value;break;
   case 4:sums.expenseReturn+=value;break;
   default:sums.unknown+=value;
  }
 });
 $('receiptTotals').innerHTML=
  '<b>Приход:</b> '+money(sums.income-sums.incomeReturn)+
  ' <span class="receipt-meta">(поступления '+money(sums.income)+' − возвраты '+money(sums.incomeReturn)+')</span>'+
  ' &nbsp; <b>Расход:</b> '+money(sums.expense-sums.expenseReturn)+
  ' <span class="receipt-meta">(расходы '+money(sums.expense)+' − возвраты '+money(sums.expenseReturn)+')</span>'+
  (sums.unknown?' &nbsp; <span class="receipt-meta">Без типа операции: '+money(sums.unknown)+'</span>':'');
}
function seller(r){const d=dataOf(r),m=metaOf(r);return d.user||m.kktOwner||d.retailPlace||''}
function render(){
 const q=$('receiptSearch').value.trim().toLowerCase();
 const rows=receipts.map((r,i)=>({r,i})).filter(({r})=>{
  const d=dataOf(r),m=metaOf(r),items=Array.isArray(d.items)?d.items:[];
  return !q||[seller(r),d.userInn,m.kktOwnerInn,m.fiscalDocumentNumber,d.fiscalDocumentNumber,d.retailPlace,...items.map(x=>x.name)].some(v=>String(v??'').toLowerCase().includes(q));
 });
 $('receiptCount').textContent='Чеков: '+rows.length+' / '+receipts.length;
 renderTotals(rows);
 $('receiptRows').innerHTML=rows.length?rows.map(({r,i})=>{
  const d=dataOf(r),m=metaOf(r),items=Array.isArray(d.items)?d.items:[];
  const inn=d.userInn||m.kktOwnerInn||'—',fdn=d.fiscalDocumentNumber||m.fiscalDocumentNumber||'—';
  const details=items.length?items.map(x=>'<tr><td>'+esc(x.name||'Товар')+'</td><td>'+esc(x.quantity??'—')+' '+esc(x.itemsQuantityMeasure||'')+'</td><td class="num">'+money(x.price)+'</td><td class="num">'+money(x.sum)+'</td><td>'+esc(x.nds||'—')+'</td></tr>').join(''):'<tr><td colspan="5">Состав покупки в выгрузке отсутствует.</td></tr>';
  const address=d.retailPlaceAddress||d.sellerAddress||d.buyerAddress||'';
  return '<tr class="receipt-row" data-receipt="'+i+'"><td><button class="receipt-toggle" aria-label="Раскрыть чек">＋</button></td><td>'+date(receiptDate(r))+'</td><td><b>'+esc(seller(r)||'Продавец не указан')+'</b><div class="receipt-meta">'+esc(address)+'</div></td><td>'+esc(inn)+'</td><td>'+esc(fdn)+'</td><td class="num"><b>'+money(total(r))+'</b></td></tr><tr id="receipt-detail-'+i+'" hidden><td colspan="6"><div class="receipt-details"><div class="receipt-meta">ФД: '+esc(fdn)+' · ФП: '+esc(d.fiscalSign||'—')+' · ККТ: '+esc(d.kktRegId||'—')+'</div><table><thead><tr><th>Наименование</th><th>Количество</th><th>Цена</th><th>Сумма</th><th>НДС</th></tr></thead><tbody>'+details+'</tbody></table><div class="receipt-meta">Способ оплаты: наличные '+money(d.cashTotalSum)+' · безналичные '+money(d.ecashTotalSum)+' · тип операции: '+esc(d.operationType??'—')+'</div></div></td></tr>';
 }).join(''):'<tr><td colspan="6" class="empty">По запросу ничего не найдено.</td></tr>';
}
$('receiptRows').addEventListener('click',e=>{const tr=e.target.closest('[data-receipt]');if(!tr)return;const id=tr.dataset.receipt,detail=$('receipt-detail-'+id);detail.hidden=!detail.hidden;tr.querySelector('.receipt-toggle').textContent=detail.hidden?'＋':'−';});
$('receiptSearch').addEventListener('input',render);
async function load(){try{const r=await fetch('/api/receipts',{cache:'no-store'}),j=await r.json();if(!r.ok)throw Error(j.error||'Ошибка загрузки');receipts=j.items||[];const s=j.stats||{};$('receiptSummary').textContent='В базе: '+s.total+' чеков. Выгрузка: '+(s.exported_at||'не указана')+'. Список полный: '+(s.list_complete?'да':'нет/неизвестно')+'; детали полные: '+(s.details_complete?'да':'нет/неизвестно')+'.';render();}catch(e){$('receiptMessage').textContent=e.message;}}
$('receiptImport').onclick=async()=>{const f=$('receiptFile').files[0];if(!f){$('receiptFile').click();return;}const b=$('receiptImport');b.disabled=true;$('receiptStatus').textContent='Импортирую…';try{const payload=JSON.parse(await f.text());const r=await fetch('/api/receipts/import',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const j=await r.json();if(!r.ok)throw Error(j.error||'Ошибка импорта');const s=j.sync;$('receiptStatus').textContent='Добавлено '+s.new+', обновлено '+s.updated+', без изменений '+s.unchanged+', пропущено '+s.skipped+'.';$('receiptFile').value='';await load();}catch(e){$('receiptStatus').textContent=e.message;$('receiptMessage').textContent=e.message;}finally{b.disabled=false;}};
load();
