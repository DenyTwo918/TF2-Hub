'use strict';
const qs = selector => document.querySelector(selector);
function addonUrl(path){const clean=String(path||'').replace(/^\/+/, '');const base=new URL(window.location.href);if(!base.pathname.endsWith('/'))base.pathname=base.pathname.replace(/[^/]*$/,'');base.search='';base.hash='';return new URL(clean,base.toString()).toString();}
async function api(path,options={}){const headers=options.headers||{'content-type':'application/json'};const timeoutMs=Number(options.timeoutMs||0);const fetchOptions={...options,headers};delete fetchOptions.timeoutMs;let controller=null;let timer=null;if(timeoutMs&&!fetchOptions.signal){controller=new AbortController();fetchOptions.signal=controller.signal;timer=setTimeout(()=>controller.abort(),timeoutMs);}try{const response=await fetch(addonUrl(path),fetchOptions);const text=await response.text();let body;try{body=text?JSON.parse(text):{};}catch{body={raw:text};}if(!response.ok){const err=new Error(body.error||body.raw||`HTTP ${response.status}`);err.body=body;err.status=response.status;throw err;}return body;}catch(error){if(error&&error.name==='AbortError')throw new Error(`Request timed out after ${timeoutMs} ms: ${path}`);throw error;}finally{if(timer)clearTimeout(timer);}}
function maskedInputValue(value){const text=String(value??'').trim();if(!text)return '';const compact=text.replace(/\s+/g,'');if(/^[â€˘â—Ź*xX._-]{4,}$/.test(compact))return '';if(/^(saved|masked|redacted|\[redacted\]|hidden|secret)$/i.test(compact))return '';return text;}
const esc=v=>String(v??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const pill=(t,c='')=>`<span class="pill ${esc(c)}">${esc(t)}</span>`;
const metric=(l,v,h='')=>`<div class="metric"><span>${esc(l)}</span><strong>${esc(v)}</strong>${h?`<small>${esc(h)}</small>`:''}</div>`;
function renderPrepared(prepared){
  const el=qs('#prepared');
  if(!el)return;
  if(!prepared){
    el.innerHTML='<div class="emptyState compact"><b>No prepared offer</b><p>Decision queue is idle. This is normal when Steam has no active trade offers.</p></div>';
    return;
  }
  const offerId=prepared.tradeofferid||prepared.id||prepared.offer_id||'unknown';
  const decision=prepared.decision||prepared.status||'prepared';
  const profit=Number(prepared.estimated_profit_ref||prepared.profit_ref||prepared.value?.profit_ref||0);
  const risk=Number(prepared.risk_score||prepared.confidence?.risk||0);
  const reasons=Array.isArray(prepared.reasons)?prepared.reasons:Array.isArray(prepared.reason_codes)?prepared.reason_codes:[];
  el.innerHTML=`<div class="offer preparedOffer"><div class="offerTop"><strong>Prepared offer ${esc(offerId)}</strong>${pill(decision,decision)}</div><p>Expected profit ${profit} ref Â· Risk ${risk}/100</p>${reasons.length?`<p class="muted">${reasons.map(esc).join('<br>')}</p>`:'<p class="muted">Prepared offer details will appear here when an active trade offer exists.</p>'}</div>`;
}
let latestDecisions=[];
let actionPlanFilter='all';
let executionQueueFilter='pending';
const ACCOUNT_ROLES = Object.freeze({
  main: 'Main',
  trade: 'Trade',
  storage: 'Storage',
  flip: 'Flip',
  buffer: 'Buffer',
  disabled: 'Disabled'
});
// 5.13.43: bounded log render.  Earlier builds dumped the full JSON of every
// API response into the #logs <pre>, which on large payloads (diagnostic
// bundles, full publish wizard status, market mirror) ballooned browser RAM
// and locked the tab.  We now cap output at 64 KB; the diagnostic bundle
// download still gives the assistant the unredacted payload.
const SETLOG_MAX_CHARS = 64 * 1024;
let lastMainAccountSaveResult = null;
function setLog(value){
  const node = qs('#logs');
  if(!node) return;
  let text;
  if(typeof value === 'string') text = value;
  else { try { text = JSON.stringify(value, null, 2); } catch { text = String(value); } }
  if(text && text.length > SETLOG_MAX_CHARS){
    text = text.slice(0, SETLOG_MAX_CHARS) + '\n\nâ€¦[truncated ' + (text.length - SETLOG_MAX_CHARS) + ' chars â€” open the diagnostic bundle for the full payload]';
  }
  node.textContent = text;
}
function updateSimpleUiButton(){const b=document.getElementById('toggleSimpleUi');if(!b)return;b.textContent=document.body.classList.contains('simple-ui')?'Show advanced UI':'Hide advanced UI';}
function setSda(value){qs('#sdaOutput').textContent=typeof value==='string'?value:JSON.stringify(value,null,2);}
function saveJsonDownload(fileName,value){try{const blob=new Blob([JSON.stringify(value,null,2)],{type:"application/json"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=fileName||"tf2-hub-diagnostic.json";document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);return true;}catch(error){setLog({ok:false,error:'Browser download failed',detail:String(error&&error.message?error.message:error)});return false;}}
async function downloadCachedDiagnosticFallback(reason){const fallback={ok:false,version:'5.14.2',title:'Client-side diagnostic download fallback',generated_at:new Date().toISOString(),source:'browser_fallback',error:String(reason&&reason.message?reason.message:reason||'Unknown diagnostic download error'),safety_note:'Client fallback only. No live trade, Steam confirmation or Backpack.tf write was executed.'};try{const cached=await api('/api/diagnostics/bundle').catch(()=>null);if(cached&&typeof cached==='object'){cached.client_download_fallback_reason=fallback.error;saveJsonDownload(cached.file_name||('tf2-hub-diagnostic-cached-'+(cached.version||'bundle')+'.json'),cached);return cached;}}catch{}saveJsonDownload('tf2-hub-diagnostic-client-fallback.json',fallback);return fallback;}
function renderDiagnosticBundle(data){
  const el=qs("#diagnosticBundleStatus");if(!el)return;
  if(!data){el.innerHTML='<p class="muted">No diagnostic bundle yet.</p>';return;}
  const sum=data.summary||{};const ok=data.ok!==false;
  const before=data.queue_snapshot_before?.summary||{};
  const after=data.queue_snapshot_after?.summary||{};
  const assistant=data.assistant_summary||{};
  const safety=data.safety_state||data.safety||{};
  const topItems=Array.isArray(data.top_queue_items)?data.top_queue_items:(Array.isArray(assistant.top_queue_items)?assistant.top_queue_items:[]);
  const topHtml=topItems.slice(0,5).map(x=>`<div class="miniRow"><b>${esc(x.item_name||x.title||x.type)}</b><small>score ${Number(x.score||0)} Â· profit ${Number(x.expected_profit_ref||0)} ref Â· buy â‰¤ ${Number(x.max_buy_ref||0)} ref Â· ${esc(x.status||'pending_review')}</small></div>`).join('');
  const changed=data.what_changed||{};
  const next=data.recommended_next_patch||{};
  const decision=data.assistant_decision||data.assistant_summary?.assistant_decision||{};
  const decisionHtml=decision.recommended_bulk_action?`<div class="assistantDecisionBox"><h3>Assistant decision</h3><p><b>${esc(decision.recommended_bulk_action)}</b></p><p class="muted">${esc(decision.user_facing_summary||decision.risk_summary||'Decision summary is included in the downloaded JSON.')}</p><div class="metrics compactMetrics">${metric('Selected',decision.selected_count||0)}${metric('Planning value used',decision.selected_value_ref||0,'ref')}${metric('Planning value limit',decision.planning_value_reference_ref||0,'ref')}${metric('Live',decision.live_actions_enabled?'on':'off')}</div><div class="buttonRow"><button id="applyAssistantRecommendation" class="primary">Apply assistant recommendation</button></div><p class="muted">Queue-only: this only marks selected local review items approved. It does not execute live trades or Backpack.tf writes.</p><div id="assistantApplicationStatus"></div></div>`:'';
  el.innerHTML="<p>"+pill(ok?"ready":"failed",ok?"ok":"bad")+" <b>"+esc(data.file_name||"Diagnostic bundle")+"</b></p>"
    +(!ok?'<p class="badText"><b>Bundle returned a failure report:</b> '+esc(data.error||"Unknown error")+'</p>':'')
    +decisionHtml+`<div class="assistantReportBox"><h3>Assistant summary</h3><p><b>${esc(assistant.status||'ready_for_assistant_review')}</b> â€” ${esc(assistant.headline||'Diagnostic bundle is ready for assistant review.')}</p><p class="muted">${esc(assistant.user_next_step||'Send the downloaded JSON to the assistant. No individual queue clicks are needed for debugging.')}</p></div>`
    +"<p><b>Prices:</b> "+Number(sum.prices||0)+" Â· <b>Inventory:</b> "+Number(sum.inventory_items||0)+" items Â· <b>Value:</b> "+Number(sum.inventory_value_ref||0)+" ref</p>"
    +"<p><b>Candidates:</b> "+Number(sum.market_candidates||0)+" Â· <b>Watchlist:</b> "+Number(sum.watchlist_items||0)+" Â· <b>Actions:</b> "+Number(sum.actionable_actions||0)+" Â· <b>Protected pure:</b> "+Number(sum.protected_currency_items||0)+"</p>"
    +"<p><b>Queue before:</b> pending "+Number(before.pending||sum.queue_pending_before||0)+" Â· approved "+Number(before.approved||sum.queue_approved_before||0)+"</p>"
    +"<p><b>Queue after:</b> pending "+Number(after.pending||sum.queue_pending_after||0)+" Â· approved "+Number(after.approved||sum.queue_approved_after||0)+"</p>"
    +((data.assistant_recommendation_application&&data.assistant_recommendation_application.ok!==false)?`<p>${pill('persisted','ok')} <b>Assistant recommendation applied:</b> ${Number(data.assistant_recommendation_application.applied||0)} item(s) Â· queue approved ${Number(data.assistant_recommendation_application.queue_after?.approved||after.approved||0)}</p>`:'')
    +((data.backpack_listing_payload_preview&&data.backpack_listing_payload_preview.ok!==false)?`<p>${pill('payload preview','ok')} <b>Backpack.tf payload preview:</b> ${Number(data.backpack_listing_payload_preview.payload_count||0)} draft payload(s) Â· live write off</p>`:'')
    +((data.backpack_listing_payload_review&&data.backpack_listing_payload_review.ok!==false)?`<p>${pill('payload review','ok')} <b>Payload review:</b> ${Number(data.backpack_listing_payload_review.needs_review||0)} needs review Â· ${Number(data.backpack_listing_payload_review.approved_locally||0)} approved locally Â· live write off</p>`:'')
    +((data.publish_readiness_gate&&data.publish_readiness_gate.ok!==false)?`<p>${pill(data.publish_readiness_gate.safe_flow_done?'safe flow done':'readiness','ok')} <b>Publish readiness:</b> ${Number(data.publish_readiness_gate.readiness_percent||0)}% Â· can publish live: no Â· provider request: ${data.publish_readiness_gate.provider_request_sent?'sent':'not sent'}</p>`:'')
    +`<p><b>Safety:</b> accepts ${safety.live_trade_accepts?'on':'off'} Â· Backpack writes ${safety.live_backpack_writes?'on':'off'} Â· SDA confirmations ${safety.sda_confirmations?'on':'off'}</p>`
    +(topHtml?`<details class="softDetails" open><summary>Top queue items for assistant</summary>${topHtml}</details>`:'')
    +`<details class="softDetails"><summary>What changed</summary><pre>${esc(JSON.stringify(changed,null,2))}</pre></details>`
    +`<details class="softDetails"><summary>Recommended next patch</summary><pre>${esc(JSON.stringify(next,null,2))}</pre></details>`
    +'<small class="muted">Diagnostic bundle is the primary workflow. It captures queue state before/after the safe pipeline and redacts secrets.</small>';
  renderAssistantApplication(data.assistant_recommendation_application||data.assistant_application);
}

function renderAssistantApplication(data){
  const el=qs('#assistantApplicationStatus'); if(!el)return;
  if(!data||data.ok===false){el.innerHTML='<p class="muted">No assistant recommendation has been applied yet.</p>';return;}
  const before=data.queue_before||{}; const after=data.queue_after||{};
  const items=Array.isArray(data.selected_items)?data.selected_items:[];
  const rows=items.slice(0,5).map(x=>`<div class="miniRow"><b>${esc(x.item_name||x.id)}</b><small>approved locally Â· planning_value ${Number(x.max_buy_ref||0)} ref Â· expected ${Number(x.expected_profit_ref||0)} ref</small></div>`).join('');
  el.innerHTML=`<p>${pill('applied','ok')} <b>${Number(data.applied||0)} item(s) approved locally</b></p><p class="muted">${esc(data.note||'Queue-only local review state update. No live actions executed.')}</p><div class="metrics compactMetrics">${metric('Approved before',before.approved||0)}${metric('Approved after',after.approved||0)}${metric('Planning value used',data.selected_value_ref||0,'ref')}${metric('Live',data.live_actions_enabled?'on':'off')}</div>${rows?`<details class="softDetails" open><summary>Applied items</summary>${rows}</details>`:''}`;
}
async function applyAssistantRecommendation(){
  const data=await api('/api/assistant-decision/apply',{method:'POST',body:'{}'});
  renderAssistantApplication(data);
  setLog(data);
  const q=await api('/api/execution-queue').catch(()=>null); if(q)renderExecutionQueue(q);
  const lifecycle=await api('/api/approved-actions/lifecycle/build',{method:'POST',body:'{}'}).catch(()=>null); if(lifecycle)renderApprovedLifecycle(lifecycle);
  const plan=await api('/api/actionable-plan').catch(()=>null); if(plan)renderActionablePlan(plan);
  const bundle=await api('/api/diagnostics/bundle').catch(()=>null); if(bundle){bundle.assistant_recommendation_application=data;renderDiagnosticBundle(bundle);renderAssistantApplication(data);}
  return data;
}

function renderVersionAudit(data){
  const el=qs('#versionAudit'); if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p>${pill('unknown','warn')} Build audit unavailable.</p><small class="muted">${esc(data?.error||'Diagnostic bundle can still be downloaded even if the UI audit cannot refresh.')}</small>`;return;}
  const stale=Array.isArray(data.stale)?data.stale:[];
  const entries=Array.isArray(data.entries)?data.entries:[];
  const rows=entries.map(e=>`<div class="miniRow"><b>${esc(e.name||'marker')}</b><small>${esc(e.value||'missing')} Â· ${e.ok?'ok':'stale'}${e.optional?' Â· optional':''}${e.note?' Â· '+esc(e.note):''}</small></div>`).join('');
  el.innerHTML=`<p>${pill(stale.length?'stale':'ok',stale.length?'warn':'ok')} <b>Build ${esc(data.version||data.expected||'unknown')}</b></p>${stale.length?'<p class="warnText">Version markers do not fully match.</p>':'<p class="muted">All active runtime version markers match.</p>'}<details class="softDetails"><summary>Version markers</summary>${rows||'<p class="muted">No version markers returned.</p>'}</details>`;
}
function renderSetup(data){
  const el=qs('#setupStatus'); if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p>${pill('needs setup','warn')} ${esc(data?.error||'Setup status unavailable.')}</p>`;return;}
  const steps=Array.isArray(data.steps)?data.steps:[];
  const ready=Number(data.ready_count||steps.filter(x=>x.ready).length||0);
  const total=Number(data.total_steps||steps.length||0);
  const pct=Number(data.readiness_percent||data.percent||0);
  const compact=(pct>=100||ready===total)&&total>0;
  const stepRows=steps.map(x=>`<div class="miniRow"><b>${esc(x.label||x.id)}</b><small>${x.ready?'ready':'needs setup'} Â· ${esc(x.detail||x.action||'')}</small></div>`).join('');
  el.innerHTML=`<p>${pill(compact?'Ready':'Needs setup',compact?'ok':'warn')} <b>${ready} / ${total} checks passed</b></p><p class="muted">${esc(data.recommended_next_action||'Use Diagnostic bundle for the full report.')}</p>${stepRows?`<details class="softDetails"><summary>Show setup checks</summary>${stepRows}</details>`:''}`;
}
function renderCredentials(data){
  const el=qs('#credentialStatus'); if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p class="muted">${esc(data?.error||'Credential status unavailable.')}</p>`;return;}
  const accounts=Array.isArray(data.account_status)?data.account_status:(Array.isArray(data.accounts)?data.accounts:[]);
  const main=data.main_account||accounts.find(a=>String(a.id||'main')==='main'||String(a.role||'')==='main')||accounts[0]||{};
  const providerHealth=data.provider_health||main.provider_health||{};
  const backpackHealth=providerHealth.backpack_tf||{};
  const inventoryHealth=providerHealth.inventory||{};
  const checks=Array.isArray(providerHealth.checks)?providerHealth.checks:[];
  const select=qs('#credentialAccountId');
  if(select){ select.innerHTML='<option value="main">Main account</option>'; select.value='main'; }
  const steamSaved=Boolean(main.steam_web_api_key_saved||main.steam_api_key_saved||main.steam_api);
  const backpackAccessSaved=Boolean(main.backpack_tf_access_token_saved||backpackHealth.access_token_saved);
  const backpackApiSaved=Boolean(main.backpack_tf_api_key_saved||backpackHealth.api_key_saved);
  const backpackSaved=Boolean(backpackAccessSaved&&backpackApiSaved);
  const steamIdSaved=Boolean(main.steam_id64_saved||main.steam_id64);
  const steamId=main.steam_id64_short||main.steam_id64||(steamIdSaved?'saved':'missing');
  const credentialsReady=Boolean(steamIdSaved&&steamSaved&&backpackAccessSaved&&backpackApiSaved);
  const providerKnown=Boolean(providerHealth.readiness||checks.length||providerHealth.recommended_next_action);
  const providerReady=providerHealth.overall_ready===true;
  const ready=credentialsReady&&(!providerKnown||providerReady);
  const readiness=(providerHealth.readiness||main.readiness||data.readiness||'').toString();
  const tokenState=backpackHealth.token_state||main.backpack_token_state||(backpackHealth.token_valid===true?'ok':backpackHealth.token_valid===false?'invalid':'unknown');
  const tokenPillClass=String(tokenState)==='ok'?'ok':(String(tokenState).includes('invalid')?'bad':'warn');
  const priceState=backpackHealth.price_state||main.backpack_price_state||'unknown';
  const pricePillClass=String(priceState).includes('ready')?'ok':'warn';
  const providerRows=checks.length?checks.map(x=>`<div class="miniRow"><b>${esc(x.label||x.id)}</b><small>${x.ready?'ready':'needs attention'} Â· ${esc(x.state||'')}${x.count!=null?` Â· ${esc(x.count)}`:''}${x.detail?` Â· ${esc(typeof x.detail==='string'?x.detail:JSON.stringify(x.detail))}`:''}</small></div>`).join(''):'';
  el.innerHTML=`<div class="mainAccountSummary ${ready?'ready':'needs'}">
    <div class="accountCardTop"><b>${esc(main.label||'Main account')}</b>${pill(ready?'ready':'needs attention',ready?'ok':'warn')}</div>
    <div class="metrics compactMetrics accountSimpleMetrics">
      ${metric('SteamID64',steamId)}
      ${metric('Steam API key',steamSaved?'saved':'missing')}
      ${metric('Backpack access token',backpackAccessSaved?'saved':'missing')}
      ${metric('Backpack API key',backpackApiSaved?'saved':'missing')}
      ${metric('Live scope','Main only')}
      ${metric('Access token valid',tokenState)}
      ${metric('Price schema',priceState)}
      ${metric('Inventory',`${Number(inventoryHealth.items||0)} items`)}
      ${metric('Priced',`${Number(inventoryHealth.priced||0)} priced`)}
    </div>
    <p class="muted">Credentials saved only means they are stored. Provider health shows whether Backpack.tf and pricing actually work.</p>
    <p class="muted credentialVaultState">${credentialsReady?pill('all credentials saved from vault','ok'):(steamIdSaved||steamSaved||backpackAccessSaved||backpackApiSaved?pill('partial â€” paste missing fields below to save','warn'):pill('no credentials saved â€” paste all four fields below','warn'))}</p>
    <p class="muted">${esc(providerHealth.recommended_next_action||'To switch account: paste the new SteamID64, Steam Web API key, Backpack.tf access token and Backpack.tf API key, then click Save main account.')}</p>
    ${readiness?`<small class="muted">Readiness: ${esc(readiness)} ${pill(tokenState,tokenPillClass)} ${pill(priceState,pricePillClass)}</small>`:''}
    ${providerRows?`<details class="softDetails"><summary>Provider health checks</summary>${providerRows}</details>`:''}
    <div class="miniRow mainSaveDebug"><b>Last save result</b><small>${esc(lastMainAccountSaveResult?((lastMainAccountSaveResult.verified?'verified':'not verified')+' Â· '+lastMainAccountSaveResult.duration_ms+' ms Â· source '+(lastMainAccountSaveResult.vault_source||data.source||'canonical_vault')):'not run yet')}</small><button id="debugMainAccountStatus">Debug status</button><button id="refreshPersistenceDebug">Persistence debug</button></div>
    <div id="persistenceDebugStatus" class="persistenceDebugInline" style="display:none"></div>
  </div>`;
  const debugBtn=qs('#debugMainAccountStatus');
  if(debugBtn)debugBtn.onclick=async()=>{try{const debug=await api('/api/main-account/debug-status',{timeoutMs:10000});setLog(debug);}catch(e){setLog(e.body||e.message);}};
  const persistBtn=qs('#refreshPersistenceDebug');
  if(persistBtn)persistBtn.onclick=async()=>{try{const d=await api('/api/main-account/persistence-debug',{timeoutMs:10000});renderPersistenceDebug(d);}catch(e){const el=qs('#persistenceDebugStatus');if(el){el.style.display='';el.innerHTML='<small class="muted">Persistence debug unavailable: '+esc(e.message||String(e))+'</small>';}}};
  const adv=qs('#advancedAccountList');
  if(adv){
    const rows=accounts.map(a=>`<div class="accountCard"><div class="accountCardTop"><b>${esc(a.label||a.id||'Account')}</b>${pill(a.role_label||a.role||'Account','ok')}</div><p><b>SteamID64:</b> ${esc(a.steam_id64_short||a.steam_id64||(a.steam_id64_saved?'saved':'missing'))}</p><p><b>Credentials:</b> Steam ${a.steam_web_api_key_saved||a.steam_api_key_saved||a.steam_api?'saved':'missing'} Â· Backpack token ${a.backpack_tf_access_token_saved?'saved':'missing'} Â· API key ${a.backpack_tf_api_key_saved?'saved':'missing'}</p><div class="buttonRow"><button class="useCredentials" data-id="${esc(a.id||'main')}">Use credentials target</button>${String(a.id||'main')==='main'?'':`<button class="removeAccount dangerSoft" data-id="${esc(a.id)}">Remove</button>`}</div></div>`).join('');
    adv.innerHTML=rows||'<p class="muted">No extra account cards.</p>';
  }
}

function renderPersistenceDebug(data){
  const el=qs('#persistenceDebugStatus'); if(!el)return;
  el.style.display='';
  if(!data||data.ok===false){el.innerHTML=`<small class="muted">Persistence debug unavailable.</small>`;return;}
  const c=data.canonical||{};const lg=data.last_good||{};const crash=data.last_crash_summary;const restore=data.last_startup_restore_trace;const trace=(data.last_save_trace||[]).slice(-1)[0];
  el.innerHTML=`<div class="persistenceDebugCard">
    <p><b>Canonical vault</b> ${c.exists?pill('ok','ok'):pill('missing','bad')} ${c.exists?`size ${c.size_bytes}b Â· ${esc(c.mtime||'')}`:''} readiness: ${esc(c.readiness||'?')}</p>
    <p><b>Last-good vault</b> ${lg.exists?pill('ok','ok'):pill('missing','warn')} ${lg.exists?`size ${lg.size_bytes}b Â· ${esc(lg.mtime||'')}`:''} readiness: ${esc(lg.readiness||'?')}</p>
    <p><b>In-memory readiness</b> ${esc(data.current_in_memory_readiness||'?')}</p>
    ${restore?`<p><b>Last startup restore</b> ${esc(restore.checked_at||'')} Â· restored from last-good: ${restore.restored_from_last_good?pill('yes','warn'):pill('no','ok')} Â· readiness: ${esc(restore.readiness||'?')}</p>`:''}
    ${trace?`<p><b>Last save trace</b> ${esc(trace.stage||'')} Â· ${esc(trace.ts||'')} Â· elapsed: ${trace.elapsed_ms||0}ms</p>`:''}
    ${crash?`<p><b>Last crash</b> ${pill(esc(crash.kind||'unknown'),'bad')} ${esc(crash.captured_at||'')} Â· uptime ${crash.uptime_seconds||0}s Â· ${esc(crash.error_preview||'')}</p>`:'<p><b>Last crash</b> '+pill('none','ok')+'</p>'}
  </div>`;
}
function renderTradingCore(data){
  const el=qs('#tradingCore'); if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p class="muted">${esc(data?.error||'No trading core snapshot yet.')}</p>`;return;}
  const ms=data.market_scanner||{};const inv=data.inventory||{};const dec=data.decisions||data.decision_queue||{};
  el.innerHTML=`<div class="metrics compactMetrics">${metric('Scope',data.scope||'main')}${metric('Market candidates',ms.candidates||data.candidates||0)}${metric('Inventory items',inv.items||0,Number(inv.estimated_value_ref||0)+' ref est.')}${metric('Decisions',dec.total||data.decisions_count||0)}${metric('Planned actions',data.planned_actions||0)}</div><p class="muted">Main: ${esc(data.main_account?.label||'Main account')} Â· subaccounts prepared only</p>`;
}
function renderAutopilot(data){
  const el=qs('#autopilot'); if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p class="muted">${esc(data?.error||'Autopilot status unavailable.')}</p>`;return;}
  const stages=Array.isArray(data.last_stages)?data.last_stages:Array.isArray(data.stages)?data.stages:[];
  const stageHtml=stages.length?stages.map(s=>`<div class="miniRow"><b>${s.ok?'ok':'fail'} ${esc(s.stage)}</b><small>${esc(s.error||s.message||'')}</small></div>`).join(''):'';
  el.innerHTML=`<p><b>Mode:</b> ${data.enabled===false?'disabled':'enabled'} Â· every ${Number(data.interval_minutes||data.review_interval_minutes||5)} min</p><p><b>Last run:</b> ${esc(data.last_run_at||data.last_review_at||'never')}</p><p><b>Next due:</b> ${esc(data.next_due_at||'scheduled')}</p>${stageHtml}`;
}
function renderAutonomy(data){
  const el=qs('#autonomyStatus'); if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p class="muted">${esc(data?.error||'Autonomy status unavailable.')}</p>`;return;}
  const mode=data.mode||data.autonomy_mode||'observe';
  const does=Array.isArray(data.currently_does)?data.currently_does:['Sync Backpack.tf prices and account listings','Sync Steam inventory','Build market watchlist','Build trading core snapshot','Review active trade offers'];
  const wont=Array.isArray(data.will_not_do)?data.will_not_do:['Accept trades','Confirm Steam actions','Write Backpack.tf listings'];
  el.innerHTML=`<h3>${esc(mode==='observe'?'Plan only':mode)}</h3><p class="muted">Autonomous planning only. The hub can prepare recommendations, but live actions remain disabled.</p>${does.map(x=>`<p>${pill('auto','ok')} ${esc(x)}</p>`).join('')}${wont.length?`<p>${pill('Needs manual approval','warn')}</p>`:''}`;
}
function renderStatus(status){const mode=status.trade_approval_mode||'manual';qs('#modeBadge').textContent=mode==='accept_and_confirm'?'AUTO ACCEPT + SDA CONFIRM':mode==='accept_recommended'?'AUTO ACCEPT':'MANUAL REVIEW';const rt=status.runtime_event_logging||{};qs('#status').innerHTML=`<p><b>Version:</b> ${esc(status.version)}</p><p><b>Steam API:</b> ${status.steam_web_api_key_saved?'saved':'missing'}</p><p><b>Runtime logging:</b> ${rt.enabled===false?'OFF':'ON'} Â· level ${esc(rt.level||'info')}</p><p><b>Review loop:</b> ${status.auto_review_enabled?'enabled':'disabled'} Â· every ${Number(status.review_interval_minutes||0)} min</p><p><b>Last review:</b> ${esc(status.last_review_at||'never')}</p><p><b>Final confirmation:</b> ${esc(status.safety?.final_confirmation||'manual_only')}</p>`;renderPrepared(status.prepared_offer);}
function renderBackpack(status){if(!status.ok){qs('#backpack').textContent=status.error||'Backpack.tf unavailable.';return;}const cache=status.cache||{};const summary=cache.listings_summary||{};qs('#backpack').innerHTML=`<p><b>Enabled:</b> ${status.enabled?'yes':'no'}</p><p><b>Token/API:</b> ${status.token_saved?'saved':'missing'}</p><p><b>Prices:</b> ${cache.prices_ok?'synced':'not synced'} Â· ${Number(cache.prices_count||0)} entries</p><p><b>Your account listings:</b> ${Number(cache.listings_count||0)} Â· buy ${Number(summary.buy||0)} Â· sell ${Number(summary.sell||0)}</p><p><b>Write mode:</b> ${esc(status.write_mode)} Â· live writes ${status.live_writes_enabled?'enabled':'disabled'}</p><small class="muted">0 account listings is normal if you have not posted listings yet.</small>`;}
function renderInventory(data){
  const summary=data&&data.analysis?data.analysis:{};
  const diag=summary.pricing_match_diagnostics||{};
  let compact='<p><b>Status:</b> '+(data&&data.ok?'synced':'not synced')+'</p>';
  compact+='<p><b>Items:</b> '+Number(data&&data.items_count||0)+' Â· tradable '+Number(summary.tradable_items||0)+'</p>';
  compact+='<p><b>Priced:</b> '+Number(summary.priced_items||0)+' Â· unpriced '+Number(summary.unpriced_items||0)+'</p>';
  compact+='<p><b>Estimated value:</b> '+Number(summary.estimated_value_ref||0)+' ref</p>';
  if(diag.lookup_keys!==undefined) compact+='<p><b>Pricing keys:</b> '+Number(diag.lookup_keys||0)+' Â· matched '+Number(diag.matched_items||0)+' / '+Number(data&&data.items_count||0)+'</p>';
  if(data&&data.error) compact+='<small class="muted">'+esc(data.error)+'</small>';
  if(data&&data.hint) compact+='<small class="muted">Hint: '+esc(data.hint)+'</small>';
  const st=qs('#inventoryStatus'); if(st)st.innerHTML=compact;
  const box=qs('#inventory'); if(!box)return;
  const top=Array.isArray(summary.top_value_items)?summary.top_value_items.slice(0,8):[];
  let rows='';
  if(top.length){rows='<div class="miniRows">'+top.map(function(x){return '<div class="miniRow"><b>'+esc(x.item_name)+'</b><small>'+Number(x.value_ref||0)+' ref Â· '+(x.tradable?'tradable':'not tradable')+' Â· matched '+esc(x.price_name||x.matched_key||'price')+'</small></div>';}).join('')+'</div>';}
  else rows='<p class="muted">Inventory is loaded, but no owned items matched Backpack.tf prices yet.</p>';
  const unpriced=Array.isArray(summary.unpriced_samples)?summary.unpriced_samples.slice(0,8):[];
  if(unpriced.length){rows+='<details class="softDetails" open><summary>Unpriced samples</summary><div class="miniRows">'+unpriced.map(function(x){return '<div class="miniRow"><b>'+esc(x.item_name)+'</b><small>Keys tried: '+esc((x.keys_tried||[]).slice(0,4).join(' Â· ')||'none')+'</small></div>';}).join('')+'</div></details>';}
  if(diag.lookup_keys!==undefined){rows+='<details class="softDetails" open><summary>Pricing match diagnostics</summary><pre>'+esc(JSON.stringify(diag,null,2))+'</pre></details>';}
  if(data&&Array.isArray(data.attempts)&&data.attempts.length){rows+='<details class="softDetails"><summary>Inventory fetch diagnostics</summary><pre>'+esc(JSON.stringify(data.attempts.slice(-6),null,2))+'</pre></details>';}
  box.innerHTML=compact+rows;
}
function renderApproval(summary){if(!summary.ok){qs('#approval').textContent='Approval summary unavailable.';return;}qs('#approval').innerHTML=`<div class="metrics compactMetrics">${metric('Mode',summary.trade_approval_mode)}${metric('Auto accept',summary.auto_accept_enabled?'enabled':'off')}${metric('Auto confirm',summary.auto_confirm_enabled?'enabled':'off')}${metric('Recommended',summary.accept_recommended_count||0)}</div>`;}
function renderOperations(ops){/* kept for API compatibility */}
function renderPricing(report){if(!report.ok){qs('#pricing').innerHTML='<p class="muted">No pricing report yet. Autopilot will create it when offers exist.</p>';return;}qs('#pricing').innerHTML=`<p><b>Total:</b> ${report.summary.total}</p><p><b>Accept:</b> ${report.summary.accept_recommended} Â· <b>Review:</b> ${report.summary.needs_review} Â· <b>Reject:</b> ${report.summary.reject_recommended}</p><p><b>Avg pricing:</b> ${report.summary.avg_pricing_score}/100 Â· <b>Avg risk:</b> ${report.summary.avg_risk_score}/100</p>`;}
function renderOrders(data){if(!data.ok){qs('#orders').innerHTML='<p class="muted">No targeted orders yet.</p>';return;}const rows=(data.orders||[]).slice(0,6).map(o=>`<div class="miniRow"><b>${esc(o.item_name)}</b><small>Buy â‰¤ ${Number(o.max_buy_ref||0)} ref Â· profit ${Number(o.expected_profit_ref||0)} ref Â· ${esc(o.mode||'dry_plan')}</small></div>`).join('');qs('#orders').innerHTML=`<p><b>Orders:</b> ${(data.orders||[]).length} Â· <b>Planning value:</b> ${Number(data.selected_value_ref||0)} / ${Number(data.planning_value_ref||0)} ref</p>${rows||'<p class="muted">No planned orders.</p>'}`;}
function renderScanner(data){
  const el=qs('#scanner');if(!el)return;if(!data||!data.ok){el.innerHTML=`<p class="muted">${esc(data?.error||'No market scanner snapshot yet.')}</p>`;return;}
  const candidates=data.candidates||[];
  const count=Number(data.summary?.total_candidates||candidates.length||0);
  const watch=Number(data.summary?.watchlist_items||data.watchlist_count||count||0);
  const rows=candidates.slice(0,12).map(x=>`<div class="miniRow"><b>${esc(x.item_name)}</b><small>${esc(x.intent||'watch')} Â· buy â‰¤ ${Number(x.max_buy_ref||0)} ref Â· sell ${Number(x.target_sell_ref||0)} ref Â· estimated spread ${Number(x.expected_profit_ref||0)} ref Â· risk ${Number(x.risk_score||0)}/100</small></div>`).join('');
  const d=data.diagnostics||{};
  el.innerHTML=`<div class="metrics compactMetrics">${metric('Trade candidates',count)}${metric('Watchlist',watch)}${metric('Prices seen',Number(data.prices_seen||0))}${metric('Key estimate',Number(data.key_ref_estimate||0)+' ref')}</div>${rows||'<p class="muted">No candidates or watchlist items were generated. Diagnostics below explain why.</p>'}<p class="muted">Watchlist items are monitoring-only and are not guaranteed profit.</p><details class="softDetails" ${rows?'':'open'}><summary>Scanner diagnostics</summary><pre>${esc(JSON.stringify(d,null,2))}</pre></details>`;
}
function renderDecision(d){const cls=d.decision||'needs_review';const reasons=Array.isArray(d.reasons)&&d.reasons.length?d.reasons.map(esc).join('<br>'):'No major warnings.';const link=d.links&&d.links.offer_url?d.links.offer_url:'#';return `<div class="offer"><div class="offerTop"><strong>Offer ${esc(d.tradeofferid||'unknown')}</strong>${pill(cls,cls)}</div><p>Risk ${Number(d.risk_score||0)}/100 Â· Pricing ${Number(d.pricing_score||0)}/100 Â· Profit ${Number(d.estimated_profit_ref||0)} ref</p><p class="muted">${reasons}</p><div class="buttonRow"><a class="buttonLink" href="${esc(link)}" target="_blank" rel="noreferrer">Open</a><button data-mark="reviewed" data-offer="${esc(d.tradeofferid)}">Reviewed</button><button data-mark="ignored" data-offer="${esc(d.tradeofferid)}">Ignore</button></div></div>`;}
function renderDecisions(data){latestDecisions=Array.isArray(data.decisions)?data.decisions:[];qs('#decisions').innerHTML=latestDecisions.length?latestDecisions.slice(0,18).map(renderDecision).join(''):'<div class="emptyState"><b>No active decisions</b><p>That is normal when Steam has no open trade offers. Autopilot will keep checking on schedule.</p></div>';}
function renderFeed(feed){const e=feed.entries||[];qs('#actionFeed').innerHTML=e.length?e.slice(-14).reverse().map(x=>`<div class="feedItem"><b>${esc(x.type)}</b><small>${esc(x.ts)}</small><pre>${esc(JSON.stringify(x.payload||{},null,2))}</pre></div>`).join(''):'<p class="muted">No feed yet.</p>';}
function renderStrategy(data){if(!data.ok){qs('#strategy').textContent=data.error||'No strategy data.';return;}const active=data.active||'balanced';const item=(data.strategies||{})[active]||{};qs('#strategy').innerHTML=`<p><b>Strategy:</b> ${esc(active)}</p><p>Min profit ${Number(item.min_profit_ref||0)} ref Â· Min liquidity ${Number(item.min_liquidity_score||0)} Â· Max risk ${Number(item.max_risk_score||0)}</p>`;}
function renderAccounts(data){const el=qs('#accounts');if(!el)return;if(!data||!data.ok){el.textContent=data?.error||'';return;}const main=data.main_account||{};el.innerHTML=`<p><b>Live account:</b> ${esc(main.label||'Main account')}</p><p><b>SteamID64:</b> ${esc(main.steam_id64||'missing')}</p><p class="muted">Normal mode uses Main only. Extra account roles are hidden in Advanced.</p>`;}
function renderSdaBridge(data){if(!data||!data.ok){qs('#sdaBridge').innerHTML=`<p><b>Status:</b> optional/not connected</p><p class="muted">${esc(data?.error||'SDA Bridge has not responded yet.')}</p>`;qs('#sdaDetails').innerHTML=`${metric('Bridge','optional')}${metric('Mode','manual')}${metric('Confirmations','trade-only')}`;return;}const connected=data.connected||data.status?.connected||data.body?.connected;const base=data.sda_base_url||data.base_url||data.status?.base_url||'configured bridge';qs('#sdaBridge').innerHTML=`<p><b>Enabled:</b> ${data.sda_enabled!==false?'yes':'no'}</p><p><b>Connected:</b> ${connected?'yes':'no'}</p><p><b>Auto-confirm:</b> ${data.sda_auto_confirm?'enabled':'disabled'}</p><p><b>Bridge:</b> ${esc(base)}</p>`;qs('#sdaDetails').innerHTML=`${metric('Bridge',connected?'connected':'not ready')}${metric('Mode',data.sda_auto_confirm?'auto-confirm allowed':'manual')}${metric('Base URL',base)}${metric('Confirmations','trade-only side helper')}`;}
function renderListBlock(title, items, kind){
  const list=Array.isArray(items)?items:[];
  if(!list.length)return `<div class="emptyMini"><b>${esc(title)}</b><p class="muted">None.</p></div>`;
  return `<div class="brainGroup ${esc(kind||'')}"><h3>${esc(title)}</h3>${list.slice(0,8).map(item=>`<div class="miniRow"><b>${esc(item.title||item.label||item.id||'Item')}</b><small>${esc(item.message||item.action||item.reason||'')}</small></div>`).join('')}</div>`;
}
function renderTradingBrain(data){
  const el=qs('#tradingBrain'); if(!el)return;
  if(!data||!data.ok){el.innerHTML=`<p class="muted">${esc(data?.error||'No trading brain snapshot yet. Click Diagnostic bundle; it builds the brain automatically.')}</p>`; if(qs('#brainRaw'))qs('#brainRaw').textContent=JSON.stringify(data||{},null,2); return;}
  const recs=data.recommendations||[], warns=data.warnings||[], blocked=data.blocked||[], next=data.next_actions||[];
  el.innerHTML=`<div class="metrics compactMetrics">${metric('Mode',data.mode||'observe')}${metric('Recommendations',recs.length)}${metric('Warnings',warns.length)}${metric('Blocked',blocked.length)}${metric('Next actions',next.length)}</div><p class="muted">Built ${esc(data.built_at||'never')} Â· Active account ${esc(data.active_account_id||'main')}</p>${renderListBlock('Recommendations',recs,'ok')}${renderListBlock('Warnings',warns,'warn')}${renderListBlock('Blocked',blocked,'bad')}${renderListBlock('Next safe actions',next,'next')}`;
  if(qs('#brainRaw'))qs('#brainRaw').textContent=JSON.stringify(data,null,2);
}

function actionPlanVisibleItems(data){
  const actions=Array.isArray(data.actions)?data.actions:[];
  const watch=Array.isArray(data.watchlist)?data.watchlist:[];
  const byId=new Map();
  for(const item of [...actions,...watch]){ if(item&&item.id&&!byId.has(item.id))byId.set(item.id,item); }
  let items=[...byId.values()];
  if(actionPlanFilter==='buy')items=items.filter(x=>x.type==='prepare_buy_listing');
  if(actionPlanFilter==='sell')items=items.filter(x=>x.type==='prepare_sell_listing');
  if(actionPlanFilter==='watch')items=items.filter(x=>x.type==='watch_item'||x.status==='monitoring_only');
  if(actionPlanFilter==='approved')items=items.filter(x=>x.status==='approved_for_queue');
  if(actionPlanFilter==='ignored')items=items.filter(x=>x.status==='ignored');
  if(actionPlanFilter==='pinned')items=items.filter(x=>x.pinned);
  items.sort((a,b)=>Number(Boolean(b.pinned))-Number(Boolean(a.pinned)) || Number(b.score||0)-Number(a.score||0));
  return items;
}
function renderActionablePlan(data){
  const el=qs('#actionablePlan'); if(!el)return;
  if(!data||!data.ok){el.innerHTML=`<p class="muted">${esc(data?.error||'No actionable plan yet. Click Diagnostic bundle; it builds the action plan and queue automatically.')}</p>`; if(qs('#actionableRaw'))qs('#actionableRaw').textContent=JSON.stringify(data||{},null,2); return;}
  const actions=Array.isArray(data.actions)?data.actions:[];
  const watch=Array.isArray(data.watchlist)?data.watchlist:[];
  const protectedItems=Array.isArray(data.protected_items)?data.protected_items:[];
  const next=Array.isArray(data.next_actions)?data.next_actions:[];
  const visible=actionPlanVisibleItems(data);
  const counts={all:actions.length+watch.length,buy:actions.filter(x=>x.type==='prepare_buy_listing').length,sell:actions.filter(x=>x.type==='prepare_sell_listing').length,watch:watch.length,approved:actions.filter(x=>x.status==='approved_for_queue').length,ignored:actions.filter(x=>x.status==='ignored').length,pinned:actions.filter(x=>x.pinned).length};
  const filters=['all','buy','sell','watch','approved','ignored','pinned'].map(f=>`<button class="miniFilter ${actionPlanFilter===f?'active':''}" data-plan-filter="${f}">${f} <span>${Number(counts[f]||0)}</span></button>`).join('');
  const cards=visible.slice(0,24).map(a=>{
    const buy=a.max_buy_ref!==undefined?`Buy â‰¤ ${Number(a.max_buy_ref||0)} ref`:'';
    const sell=a.target_sell_ref!==undefined?`Sell ${Number(a.target_sell_ref||0)} ref`:'';
    const value=a.price_ref!==undefined?`Price ${Number(a.price_ref||0)} ref`:'';
    const profit=a.expected_profit_ref!==undefined?`Profit ${Number(a.expected_profit_ref||0)} ref`:'';
    const encoded=encodeURIComponent(a.id||'');
    const status=String(a.status||'planned_review');
    return `<div class="reviewActionCard ${a.pinned?'pinned':''} ${status}">
      <div class="reviewActionMain">
        <div><b>${esc(a.item_name||a.title||a.type||'Action')}</b><small>${esc(a.type||'review')} Â· ${esc(a.confidence||'review')} Â· score ${Number(a.score||0)}/100 Â· risk ${Number(a.risk_score||0)}/100</small></div>
        <div class="reviewBadges">${pill(status,status==='ignored'?'bad':status==='approved_for_queue'?'ok':'warn')}${a.pinned?pill('pinned','ok'):''}${pill(a.live?'live':'review-only',a.live?'bad':'ok')}</div>
      </div>
      <div class="reviewNumbers"><span>${esc(buy)}</span><span>${esc(sell)}</span><span>${esc(value)}</span><span>${esc(profit)}</span></div>
      <p class="muted smallReason">${esc(a.reason||'Manual review required.')}</p>
      <div class="buttonRow actionButtons">
        <button data-plan-action="approve" data-action-id="${encoded}" class="primary">Approve to queue</button>
        <button data-plan-action="pin" data-action-id="${encoded}">${a.pinned?'Pinned':'Pin'}</button>
        <button data-plan-action="lower_priority" data-action-id="${encoded}">Lower priority</button>
        <button data-plan-action="ignore" data-action-id="${encoded}" class="dangerSoft">Ignore</button>
      </div>
    </div>`;
  }).join('');
  const protectedHtml=protectedItems.length?`<details class="softDetails compactDetails"><summary>Protected currency / pure</summary>${protectedItems.slice(0,8).map(x=>`<div class="miniRow"><b>${esc(x.item_name)}</b><small>${Number(x.value_ref||0)} ref Â· ${esc(x.reason||'Protected')}</small></div>`).join('')}</details>`:'';
  const topSummary = `<div class="metrics compactMetrics">${metric('Queue-ready',data.summary?.queue_ready_targets||actions.length)}${metric('Strong',data.summary?.strong_actions||0)}${metric('Approved',data.summary?.approved_actions||0)}${metric('Pure planning_value',data.planning_value?.pure_ref||0,'ref protected')}</div><p class="muted">Built ${esc(data.built_at||'never')} Â· mode ${esc(data.mode||'observe')} Â· live actions disabled</p>${next.length?`<div class="brainGroup next"><h3>Diagnostic recommendation</h3>${next.map(x=>`<div class="miniRow"><b>${esc(x.label||x.id)}</b><small>${esc(x.action||'none')} Â· ${Number(x.count||0)} item(s)</small></div>`).join('')}</div>`:''}`;
  const diagnosticOnly = `<div class="diagnosticOnlyNotice">${pill('diagnostic-first','ok')} <b>Use Diagnostic bundle as the main workflow.</b><p class="muted">This panel is for reading the plan. The downloaded diagnostic JSON already includes action plan, queue state before/after, pending/approved counts and safety flags for review.</p></div>`;
  const manualControls = `<details class="softDetails manualControls"><summary>Optional manual controls / advanced review</summary><div class="smartBulkPanel"><b>Smart bulk review</b><p class="muted">Optional only. These buttons update local review states and rebuild the guarded queue; they do not execute live actions.</p><div class="buttonRow"><button data-bulk-plan="top3" class="primary">Approve top 3</button><button data-bulk-plan="top5" class="primary">Approve top 5</button><button data-bulk-plan="all_strong">Approve all strong</button><button data-bulk-plan="all_reviewable">Approve advisory batch</button><button data-bulk-plan="weak" data-bulk-action="ignore" class="dangerSoft">Ignore weak</button><button data-bulk-plan="top3" data-bulk-action="pin">Pin best</button></div></div><div class="reviewToolbar"><div class="filterRow">${filters}</div><div class="buttonRow"><button id="approveVisiblePlan" class="primary">Approve visible</button><button id="ignoreVisiblePlan" class="dangerSoft">Ignore visible</button></div></div><div class="reviewActionGrid">${cards||'<p class="muted emptyMini">No actions in this filter.</p>'}</div></details>`;
  el.innerHTML=`${topSummary}${diagnosticOnly}${manualControls}${protectedHtml}<p class="muted">This plan is review-only. Normal operation is one Diagnostic bundle click, then send the JSON for analysis.</p>`;
  if(qs('#actionableRaw'))qs('#actionableRaw').textContent=JSON.stringify(data,null,2);
}
function renderExecutionQueue(data){
  const el=qs('#executionQueue'); if(!el)return;
  if(!data||!data.ok){el.innerHTML=`<p class="muted">${esc(data?.error||'No execution queue yet.')}</p>`;return;}
  const entries=Array.isArray(data.entries)?data.entries:[];
  const counts={all:entries.length,pending:entries.filter(x=>x.status==='pending_review').length,approved:entries.filter(x=>x.status==='approved').length,disabled:entries.filter(x=>String(x.status||'').includes('disabled')).length,done:entries.filter(x=>String(x.status||'').includes('done')).length,cancelled:entries.filter(x=>x.status==='cancelled').length};
  let visible=entries;
  if(executionQueueFilter==='pending')visible=entries.filter(x=>x.status==='pending_review');
  if(executionQueueFilter==='approved')visible=entries.filter(x=>x.status==='approved');
  if(executionQueueFilter==='disabled')visible=entries.filter(x=>String(x.status||'').includes('disabled'));
  if(executionQueueFilter==='done')visible=entries.filter(x=>String(x.status||'').includes('done'));
  if(executionQueueFilter==='cancelled')visible=entries.filter(x=>x.status==='cancelled');
  const filters=['all','pending','approved','disabled','done','cancelled'].map(f=>`<button class="miniFilter ${executionQueueFilter===f?'active':''}" data-queue-filter="${f}">${f} <span>${Number(counts[f]||0)}</span></button>`).join('');
  const rows=visible.slice(0,24).map(x=>{
    const id=encodeURIComponent(x.id||'');
    return `<div class="queueActionCard ${esc(x.status||'pending_review')}">
      <div class="reviewActionMain"><div><b>${esc(x.title||x.type)}</b><small>${esc(x.type||'action')} Â· ${esc(x.source||'queue')} Â· ${esc(x.status||'pending_review')}</small></div><div class="reviewBadges">${pill(x.live?'live':'review-only',x.live?'bad':'ok')}${pill(x.risk||'review',x.risk==='low'?'ok':'warn')}</div></div>
      <p class="muted smallReason">${esc(x.description||x.item_name||'Manual review required.')}</p>
      <div class="buttonRow actionButtons"><button data-queue-action="approve" data-queue-id="${id}" class="primary">Approve</button><button data-queue-action="execute" data-queue-id="${id}">Execute / mark done</button><button data-queue-action="cancel" data-queue-id="${id}" class="dangerSoft">Cancel</button></div>
    </div>`;
  }).join('');
  const summaryHtml = `<div class="metrics compactMetrics">${metric('Pending',counts.pending)}${metric('Approved',counts.approved)}${metric('Executed',counts.done)}${metric('Live default',data.safety?.default_queue_only?'off':'check')}</div><div class="diagnosticOnlyNotice">${pill('captured by diagnostic','ok')} <b>Queue state is included in the Diagnostic bundle.</b><p class="muted">No need to click queue actions for debugging. The report captures pending/approved/cancelled counts and preserves manual states across rebuilds.</p></div>`;
  const manualQueue = `<details class="softDetails manualControls"><summary>Optional manual queue controls</summary><div class="reviewToolbar"><div class="filterRow">${filters}</div><div class="buttonRow"><button id="approvePendingQueue" class="primary">Approve all pending</button><button id="cancelPendingQueue" class="dangerSoft">Cancel pending</button><button id="rebuildExecutionQueue">Rebuild queue</button></div></div><div class="reviewActionGrid">${rows||'<p class="muted">No queued actions in this filter.</p>'}</div><p class="muted">Queue is guarded. Approval does not bypass live safety settings.</p></details>`;
  el.innerHTML=`${summaryHtml}${manualQueue}`;
}

function renderApprovedLifecycle(data){
  const el=qs('#approvedLifecycleStatus'); if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p class="muted">${esc(data?.error||'No approved lifecycle yet. Apply assistant recommendation first.')}</p>`;return;}
  const items=Array.isArray(data.items)?data.items:[];
  const rows=items.slice(0,5).map(x=>`<div class="miniRow"><b>${esc(x.item_name||x.title||x.id)}</b><small>${esc(x.lifecycle_label||x.lifecycle_status||'approved locally')} Â· next: ${esc(x.next_safe_step||'draft preview')} Â· planning_value ${Number(x.planning_value_ref||x.max_buy_ref||0)} ref Â· expected ${Number(x.expected_profit_ref||0)} ref</small></div>`).join('');
  const s=data.summary||{};
  el.innerHTML=`<p>${pill(data.status||'approved lifecycle','ok')} <b>${Number(data.approved_actions||0)} approved local action(s)</b></p><div class="metrics compactMetrics">${metric('Approved',data.approved_actions||0)}${metric('Draft wait',s.waiting_for_listing_draft||0)}${metric('Planning value',s.planning_value_approved_ref||0,'ref')}${metric('Live','off')}</div><p class="muted">${esc(data.guidance||'Approved actions are local review states. Live execution remains disabled.')}</p>${rows?`<details class="softDetails" open><summary>Approved items</summary>${rows}</details>`:''}`;
}

function renderGuardedPublishDryRun(data){
  const el=qs('#guardedPublishDryRun'); if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p class="muted">${esc(data?.error||'No guarded publish dry run yet. Diagnostic bundle builds it automatically after local payload approval.')}</p>`;return;}
  const requests=Array.isArray(data.requests)?data.requests:[];
  const rows=requests.slice(0,4).map(x=>`<div class="miniRow"><b>${esc(x.item_name||'Payload')}</b><small>${esc(x.method||'POST')} ${esc(x.endpoint||x.endpoint_hint||'Backpack.tf endpoint')} Â· ${esc(x.intent||'buy')} Â· metal ${Number(x.currencies?.metal||x.max_buy_ref||0)} ref Â· provider sent: ${x.provider_request_sent?'yes':'no'}</small></div>`).join('');
  el.innerHTML=`<p>${pill(data.status||'dry_run_ready',requests.length?'ok':'warn')} <b>${Number(data.request_count||requests.length||0)} disabled publish request preview(s)</b></p><div class="metrics compactMetrics">${metric('Dry run',data.dry_run?'yes':'no')}${metric('Live write',data.live_write_enabled?'on':'off')}${metric('Publish allowed',data.publish_allowed?'yes':'no')}${metric('Provider request',data.provider_request_sent?'sent':'not sent')}</div>${rows||'<p class="muted">No request preview yet.</p>'}<details class="softDetails"><summary>Dry-run request details</summary><pre>${esc(JSON.stringify(requests[0]||data,null,2))}</pre></details>`;
}


function renderPublishReadinessGate(data){
  const el=qs('#publishReadinessGate'); if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p class="muted">${esc(data?.error||'No publish readiness gate yet.')}</p>`;return;}
  const gates=Array.isArray(data.gates)?data.gates:[];
  const blockers=Array.isArray(data.blockers)?data.blockers:[];
  const liveBlockers=Array.isArray(data.live_blockers)?data.live_blockers:[];
  const req=data.request_summary||{};
  const gateRows=gates.map(g=>`<div class="miniRow"><b>${g.ready?'âś…':'âš ď¸Ź'} ${esc(g.label||g.id)}</b><small>${esc(g.detail||g.action||'')}</small></div>`).join('');
  const blockerRows=blockers.map(b=>`<div class="miniRow"><b>${esc(b.label||b.id)}</b><small>${esc(b.action||b.detail||'')}</small></div>`).join('');
  el.innerHTML=`<p>${pill(data.safe_flow_done?'safe flow done':'blocked',data.safe_flow_done?'ok':'warn')} <b>${Number(data.readiness_percent||0)}% readiness</b></p><p class="muted">${esc(data.safe_flow_label||data.guidance||'Live publish remains intentionally blocked.')}</p><div class="metrics compactMetrics">${metric('Can publish live',data.can_publish_live?'yes':'no')}${metric('Dry run',data.dry_run_ready?'ready':'no')}${metric('Provider request',data.provider_request_sent?'sent':'not sent')}${metric('Live write','off')}</div>${req.item_name?`<div class="miniRow"><b>${esc(req.item_name)}</b><small>${esc(req.intent||'buy')} Â· buy â‰¤ ${Number(req.max_buy_ref||0)} ref Â· profit ${Number(req.expected_profit_ref||0)} ref</small></div>`:''}${blockers.length?`<details class="softDetails" open><summary>Blockers</summary>${blockerRows}</details>`:''}<details class="softDetails"><summary>Gate checks</summary>${gateRows||'<p class="muted">No gates returned.</p>'}</details><details class="softDetails"><summary>Why live publish is still blocked</summary><ul>${liveBlockers.map(x=>`<li>${esc(x)}</li>`).join('')}</ul></details>`;
}


function renderPublishHandoff(data){
  const el=qs('#publishHandoff'); if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p class="muted">${esc(data?.error||'No publish handoff package yet.')}</p>`;return;}
  const req=data.selected_request||{};
  const blockers=Array.isArray(data.future_live_blockers)?data.future_live_blockers:[];
  const safeBlockers=Array.isArray(data.safe_blockers)?data.safe_blockers:[];
  const checklist=Array.isArray(data.operator_checklist)?data.operator_checklist:[];
  const blockerRows=blockers.slice(0,8).map(b=>`<div class="miniRow"><b>${esc(b.label||b.id||'Future live blocker')}</b><small>${esc(b.detail||b.action||'')}</small></div>`).join('');
  const safeRows=safeBlockers.map(b=>`<div class="miniRow"><b>${esc(b.label||b.id)}</b><small>${esc(b.action||b.detail||'')}</small></div>`).join('');
  const checkRows=checklist.map(x=>`<li>${esc(x)}</li>`).join('');
  el.innerHTML=`<p>${pill(data.handoff_ready?'handoff ready':'blocked',data.handoff_ready?'ok':'warn')} <b>Safe ${Number(data.safe_readiness_percent||0)}%</b> Â· overall ${Number(data.overall_readiness_percent||0)}%</p><p class="muted">${esc(data.guidance||'Local-only handoff. This build cannot publish.')}</p><div class="metrics compactMetrics">${metric('Live now','no')}${metric('Provider request',data.provider_request_sent?'sent':'not sent')}${metric('Future live',data.future_live_ready?'ready':'blocked')}${metric('Requests',data.request_count||0)}</div>${req.item_name?`<div class="miniRow"><b>${esc(req.item_name)}</b><small>${esc(req.intent||'buy')} Â· buy â‰¤ ${Number(req.max_buy_ref||0)} ref Â· profit ${Number(req.expected_profit_ref||0)} ref</small></div>`:''}${safeRows?`<details class="softDetails" open><summary>Safe-flow blockers</summary>${safeRows}</details>`:''}<details class="softDetails" open><summary>Future-live blockers</summary>${blockerRows||'<p class="muted">No future-live blockers listed.</p>'}</details><details class="softDetails"><summary>Operator checklist</summary><ul>${checkRows}</ul></details><details class="softDetails"><summary>Redacted request</summary><pre>${esc(JSON.stringify(req||{},null,2))}</pre></details>`;
}


function renderDiagnosticTriage(data){
  const el=qs('#diagnosticTriage'); if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p class="muted">${esc(data?.error||'No diagnostic triage yet. Diagnostic bundle builds it automatically.')}</p>`;return;}
  const counts=data.counts||{};
  const issues=Array.isArray(data.issues)?data.issues:[];
  const focus=Array.isArray(data.assistant_focus)?data.assistant_focus:[];
  const issueRows=issues.slice(0,8).map(x=>`<div class="miniRow"><b>${esc((x.severity||'info').toUpperCase())}: ${esc(x.title||x.id)}</b><small>${esc(x.detail||'')} ${x.action?(' Â· '+esc(x.action)):''}</small></div>`).join('');
  const focusRows=focus.slice(0,6).map(x=>`<li>${esc(x)}</li>`).join('');
  const kind=data.health==='red'?'bad':data.health==='amber'?'warn':'ok';
  const planning_valueLine=(counts.planning_value_reference_ref||counts.approved_buy_planning_value_ref||counts.approved_buy_planning_value_delta_ref)?`${metric('Approved ref',counts.approved_buy_planning_value_ref||0,'ref')}${metric('Advisory target',counts.planning_value_reference_ref||0,'ref')}${metric('Over target',counts.approved_buy_planning_value_delta_ref||0,'ref')}`:'';
  el.innerHTML=`<p>${pill(data.health||data.status||'triage',kind)} <b>${esc(data.status||'triage ready')}</b></p><p class="muted">${esc(data.guidance||'Upload the next diagnostic JSON and patch the specific findings.')}</p><div class="metrics compactMetrics">${metric('Critical',counts.critical||0)}${metric('Warnings',counts.warnings||0)}${metric('Failed stages',counts.stages_failed||0)}${metric('Safe flow',data.safe_flow_done?'done':'check')}${planning_valueLine}</div>${issueRows?`<details class="softDetails" open><summary>Top issues</summary>${issueRows}</details>`:'<p class="muted">No critical diagnostic issues found.</p>'}<details class="softDetails" open><summary>Assistant focus</summary><ul>${focusRows}</ul></details><details class="softDetails"><summary>Triage JSON</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details>`;
}

function renderTransferPlan(data){
  const el=qs('#transferPlan'); if(!el)return;
  if(!data||!data.ok){el.innerHTML=`<p class="muted">${esc(data?.error||'No storage transfer plan yet.')}</p>`;return;}
  const transfers=data.transfers||[];
  el.innerHTML=`<p><b>Manual transfers:</b> ${transfers.length}</p>${transfers.length?transfers.slice(0,8).map(t=>`<div class="miniRow"><b>${esc(t.from_account_id)} â†’ ${esc(t.to_account_id)}</b><small>${Number(t.estimated_value_ref||0)} ref Â· ${esc(t.reason||'')}</small></div>`).join(''):`<p class="muted">${esc(data.guidance||'No manual transfers suggested.')}</p>`}`;
}

function renderListingDraftPreview(data){
  const el=qs('#listingDraftPreview');
  if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p class="muted">${esc(data?.error||'No listing draft preview yet. Diagnostic bundle builds it automatically when an approved action exists.')}</p>`;return;}
  const drafts=Array.isArray(data.drafts)?data.drafts:[];
  const sell=Array.isArray(data.manual_sell_review)?data.manual_sell_review:[];
  const cards=drafts.slice(0,8).map(d=>`<div class="queueCard draftCard"><div class="queueTop"><h3>${esc(d.item_name||'Draft item')}</h3>${pill('draft-only','warn')}</div><p><b>Buy â‰¤ ${Number(d.max_buy_ref||0)} ref</b> Â· expected sell ${Number(d.expected_sell_ref||0)} ref Â· spread ${Number(d.expected_profit_ref||0)} ref</p><p class="muted">${esc(d.reason||'Preview-only Backpack.tf buy listing draft.')}</p><div class="metrics compactMetrics">${metric('Score',d.score||0)}${metric('Risk',d.risk||'review')}${metric('Live write','off')}</div></div>`).join('');
  const sellRows=sell.slice(0,5).map(d=>`<div class="miniRow"><b>${esc(d.item_name||'Sell draft')}</b><small>${Number(d.price_ref||0)} ref Â· ${esc(d.status||'manual_review_only')}</small></div>`).join('');
  el.innerHTML=`<p>${pill(data.status||'draft preview','ok')} <b>${Number(data.draft_count||0)} buy draft(s)</b></p><div class="metrics compactMetrics">${metric('Buy drafts',data.buy_drafts||0)}${metric('Sell review',data.sell_drafts||0)}${metric('Planning value',data.summary?.total_planning_value_ref||0,'ref')}${metric('Live write','off')}</div><p class="muted">${esc(data.guidance||'Draft preview only. No Backpack.tf write is enabled.')}</p>${cards||'<p class="muted">No approved buy draft yet.</p>'}${sellRows?`<details class="softDetails"><summary>Manual sell review</summary>${sellRows}</details>`:''}`;
}


function renderListingDraftReview(data){
  const el=qs('#listingDraftReview');
  if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p class="muted">${esc(data?.error||'No listing draft review yet. Diagnostic bundle builds it automatically when a draft exists.')}</p>`;return;}
  const items=Array.isArray(data.items)?data.items:[];
  const cards=items.slice(0,12).map(d=>{
    const encoded=encodeURIComponent(d.id||'');
    const status=String(d.review_status||'draft_review');
    return `<div class="queueCard draftReviewCard ${esc(status)}"><div class="queueTop"><h3>${esc(d.item_name||'Draft item')}</h3>${pill(status,status==='draft_approved_locally'?'ok':status==='draft_rejected'?'bad':status==='draft_needs_price_check'?'warn':'')}</div><p><b>Buy â‰¤ ${Number(d.max_buy_ref||0)} ref</b> Â· expected sell ${Number(d.expected_sell_ref||0)} ref Â· spread ${Number(d.expected_profit_ref||0)} ref</p><p class="muted">${esc(d.reason||'Review this draft locally before any future listing policy gate.')}</p><div class="metrics compactMetrics">${metric('Risk',d.risk_score||0,'/100')}${metric('Liquidity',d.liquidity_score||0,'/100')}${metric('Score',d.score||0)}${metric('Live write','off')}</div><details class="softDetails"><summary>Why this status?</summary><pre>${esc(JSON.stringify(d.review_reason_codes||[],null,2))}</pre></details><details class="softDetails manualControls"><summary>Optional local draft controls</summary><div class="buttonRow"><button data-draft-review="draft_approved_locally" data-draft-id="${encoded}" class="primary">Approve draft locally</button><button data-draft-review="draft_needs_price_check" data-draft-id="${encoded}">Needs price check</button><button data-draft-review="draft_rejected" data-draft-id="${encoded}" class="dangerSoft">Reject draft</button></div></details></div>`;
  }).join('');
  el.innerHTML=`<p>${pill(data.status||'draft review','ok')} <b>${Number(data.drafts||0)} draft(s)</b></p><div class="metrics compactMetrics">${metric('Needs review',data.needs_review||0)}${metric('Approved locally',data.approved_locally||0)}${metric('Price check',data.needs_price_check||0)}${metric('Rejected',data.rejected||0)}</div><p class="muted">${esc(data.guidance||'Review only. No Backpack.tf write is enabled.')}</p>${cards||'<p class="muted">No draft review items yet.</p>'}<details class="softDetails"><summary>Review summary</summary><pre>${esc(JSON.stringify(data.summary||{},null,2))}</pre></details>`;
}

function renderLocalDraftApproval(data){
  const el=qs('#localDraftApproval');
  if(!el)return;
  if(!data||data.ok===false){
    el.innerHTML=`<p class="muted">${esc(data?.message||data?.error||'No Backpack.tf listing payload preview yet.')}</p><div class="buttonRow"><button id="applyLocalDraftApproval" class="primary">Approve best policy-passed draft locally</button></div>`;
    return;
  }
  const items=Array.isArray(data.applied_items)?data.applied_items:[];
  const cards=items.map(x=>`<div class="miniRow"><b>${esc(x.item_name||'Draft item')}</b><small>approved locally Â· buy â‰¤ ${Number(x.max_buy_ref||0)} ref Â· expected profit ${Number(x.expected_profit_ref||0)} ref</small></div>`).join('');
  const after=data.after||{};
  el.innerHTML=`<p>${pill(data.status||'local approval','ok')} <b>${data.applied?'Draft approved locally':'No new approval applied'}</b></p><div class="metrics compactMetrics">${metric('Approved locally',after.approved_locally??items.length)}${metric('Needs review',after.needs_review??0)}${metric('Live write','off')}${metric('Next',data.next_safe_step||'payload preview')}</div><p class="muted">${esc(data.recommendation||'Local state only. This does not write to Backpack.tf.')}</p>${cards||'<p class="muted">No draft has been approved locally yet.</p>'}<div class="buttonRow"><button id="applyLocalDraftApproval" class="primary">Approve best policy-passed draft locally</button></div><details class="softDetails"><summary>Local approval details</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details>`;
}

function renderBackpackListingPayloadPreview(data){
  const el=qs('#backpackPayloadPreview');
  if(!el)return;
  if(!data||data.ok===false){
    el.innerHTML=`<p class="muted">${esc(data?.error||data?.guidance||'No payload preview yet. Approve a draft locally, then run Diagnostic bundle.')}</p><div class="buttonRow"><button id="buildPayloadPreview" class="primary">Build payload preview</button></div>`;
    return;
  }
  const payloads=Array.isArray(data.payloads)?data.payloads:[];
  const cards=payloads.slice(0,8).map(x=>{
    const preview=x.provider_payload_preview||{};
    return `<div class="queueCard payloadPreviewCard"><div class="queueTop"><h3>${esc(x.item_name||'Payload item')}</h3>${pill('preview-only','ok')}</div><p><b>${esc(x.intent||'buy')}</b> Â· Buy â‰¤ ${Number(x.max_buy_ref||0)} ref Â· expected sell ${Number(x.expected_sell_ref||0)} ref Â· spread ${Number(x.expected_profit_ref||0)} ref</p><div class="metrics compactMetrics">${metric('Metal',x.currencies?.metal??x.max_buy_ref??0,'ref')}${metric('Quality',x.quality||preview.item?.quality||'n/a')}${metric('Risk',x.risk_score||0,'/100')}${metric('Live write','off')}</div><p class="muted">${esc(data.guidance||'Payload preview only. No Backpack.tf write was sent.')}</p><details class="softDetails" open><summary>Provider payload preview</summary><pre>${esc(JSON.stringify(preview,null,2))}</pre></details>${(x.policy_warnings||[]).length?`<details class="softDetails"><summary>Policy warnings</summary><ul>${x.policy_warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>`:''}</div>`;
  }).join('');
  el.innerHTML=`<p>${pill(data.status||'payload preview','ok')} <b>${Number(data.payload_count||0)} payload preview(s)</b></p><div class="metrics compactMetrics">${metric('Buy payloads',data.buy_payloads||0)}${metric('Planning value',data.summary?.total_planning_value_ref||0,'ref')}${metric('Expected',data.summary?.expected_profit_ref||0,'ref')}${metric('Live write','off')}</div><p class="muted">${esc(data.guidance||'Payload preview is read-only.')}</p>${cards||'<p class="muted">No approved local draft is ready for payload preview.</p>'}<div class="buttonRow"><button id="buildPayloadPreview" class="primary">Build payload preview</button></div><details class="softDetails"><summary>Payload preview details</summary><pre>${esc(JSON.stringify(data.summary||{},null,2))}</pre></details>`;
}

function renderBackpackListingPayloadReview(data){
  const el=qs('#backpackPayloadReview');
  if(!el)return;
  if(!data||data.ok===false){
    el.innerHTML=`<p class="muted">${esc(data?.error||data?.guidance||'No payload review yet. Build payload preview first.')}</p><div class="buttonRow"><button id="buildPayloadReview" class="primary">Build payload review</button></div>`;
    return;
  }
  const payloads=Array.isArray(data.payloads)?data.payloads:[];
  const cards=payloads.slice(0,8).map(x=>{
    const encoded=encodeURIComponent(x.id||'');
    const status=x.review_status||x.status||'payload_review';
    const preview=x.provider_payload_preview||{};
    const warnings=Array.isArray(x.policy_warnings)?x.policy_warnings:[];
    return `<div class="queueCard payloadReviewCard"><div class="queueTop"><h3>${esc(x.item_name||'Payload item')}</h3>${pill(status,status==='payload_approved_locally'?'ok':status==='payload_rejected'?'bad':status==='payload_needs_liquidity_check'?'warn':'info')}</div><p><b>${esc(x.intent||'buy')}</b> Â· Buy â‰¤ ${Number(x.max_buy_ref||0)} ref Â· expected sell ${Number(x.expected_sell_ref||0)} ref Â· spread ${Number(x.expected_profit_ref||0)} ref</p><div class="metrics compactMetrics">${metric('Metal',x.currencies?.metal??x.max_buy_ref??0,'ref')}${metric('Risk',x.risk_score||0,'/100')}${metric('Liquidity',x.liquidity_score||0,'/100')}${metric('Live write','off')}</div><p class="muted">${esc(x.publish_guard?.reason||'Publish guard is enabled. No Backpack.tf write is sent.')}</p><div class="buttonRow"><button data-payload-review="payload_approved_locally" data-payload-id="${encoded}" class="primary">Approve payload locally</button><button data-payload-review="payload_needs_liquidity_check" data-payload-id="${encoded}">Needs liquidity check</button><button data-payload-review="payload_rejected" data-payload-id="${encoded}" class="dangerSoft">Reject payload</button></div><details class="softDetails"><summary>Provider payload preview</summary><pre>${esc(JSON.stringify(preview,null,2))}</pre></details>${warnings.length?`<details class="softDetails"><summary>Warnings</summary><ul>${warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></details>`:''}</div>`;
  }).join('');
  el.innerHTML=`<p>${pill(data.status||'payload review','ok')} <b>${Number(data.payload_count||0)} payload(s)</b></p><div class="metrics compactMetrics">${metric('Needs review',data.needs_review||0)}${metric('Approved locally',data.approved_locally||0)}${metric('Liquidity check',data.needs_liquidity_check||0)}${metric('Live write','off')}</div><p class="muted">${esc(data.guidance||'Local payload review only. Live writes remain blocked.')}</p>${cards||'<p class="muted">No payload preview exists yet.</p>'}<div class="buttonRow"><button id="buildPayloadReview" class="primary">Build payload review</button></div><details class="softDetails"><summary>Publish guard details</summary><pre>${esc(JSON.stringify(data.publish_guard||{},null,2))}</pre></details>`;
}


function renderBackpackListingPayloadLocalApproval(data){
  const el=qs('#backpackPayloadLocalApproval');
  if(!el)return;
  if(!data||data.ok===false){
    el.innerHTML=`<p class="muted">${esc(data?.error||'No local payload approval yet. Build payload review first.')}</p><div class="buttonRow"><button id="applyPayloadLocalApproval" class="primary">Approve best payload locally</button><button id="applyPayloadLocalApprovalDiagnostic">Approve + download diagnostic</button></div>`;
    return;
  }
  const approved=Number(data.approved_locally||0);
  const status=data.status||'not_applied';
  el.innerHTML=`<p>${pill(status,status==='payload_approved_locally'?'ok':'info')} <b>${approved} payload(s) approved locally</b></p><div class="metrics compactMetrics">${metric('Item',data.item_name||'â€”')}${metric('Max buy',Number(data.max_buy_ref||0),'ref')}${metric('Profit',Number(data.expected_profit_ref||0),'ref')}${metric('Live write','off')}</div><p class="muted">${esc(data.publish_guard?.reason||'Local payload approval only. No Backpack.tf provider request is sent.')}</p><p><b>Next safe step:</b> ${esc(data.next_safe_step||'prepare_guarded_publish_dry_run')}</p><div class="buttonRow"><button id="applyPayloadLocalApproval" class="primary">Approve best payload locally</button><button id="applyPayloadLocalApprovalDiagnostic">Approve + download diagnostic</button></div><details class="softDetails"><summary>Local approval details</summary><pre>${esc(JSON.stringify(data,null,2))}</pre></details>`;
}

function renderListingDraftPolicy(data){
  const el=qs('#listingDraftPolicy');
  if(!el)return;
  if(!data||data.ok===false){el.innerHTML=`<p class="muted">${esc(data?.error||'No draft policy check yet. Diagnostic bundle builds it automatically when a draft exists.')}</p>`;return;}
  const items=Array.isArray(data.items)?data.items:[];
  const cards=items.slice(0,8).map(d=>{
    const status=d.policy_status||'unknown';
    const cls=status==='passed'?'ok':status==='blocked'?'bad':'warn';
    const warnings=Array.isArray(d.policy_warnings)?d.policy_warnings:[];
    const blockers=Array.isArray(d.policy_blockers)?d.policy_blockers:[];
    const lim=d.limit_reconciliation||{};
    const limitHtml='<details class="softDetails" open><summary>Limit reconciliation</summary><div class="metrics compactMetrics">'+metric('Mode',lim.mode||'off')+metric('Enforced',lim.enforcement_enabled?'yes':'no')+metric('Plan planning_value',lim.plan_planning_value_ref??'?', 'ref')+metric('Required',lim.required_planning_value_ref??d.max_buy_ref??0, 'ref')+'</div><p class="muted">'+esc(lim.guidance||'Planning value/per-action limits are not blocking local draft review in this build.')+'</p></details>';
    return '<div class="queueCard draftPolicyCard '+esc(status)+'"><div class="queueTop"><h3>'+esc(d.item_name||'Draft item')+'</h3>'+pill(status,cls)+'</div><p><b>Quality: '+esc(d.draft_quality||'unknown')+'</b> Â· recommended: '+esc(d.recommended_review_action||'review')+'</p><p>Buy â‰¤ '+Number(d.max_buy_ref||0)+' ref Â· sell '+Number(d.expected_sell_ref||0)+' ref Â· profit '+Number(d.expected_profit_ref||0)+' ref</p><div class="metrics compactMetrics">'+metric('Price age',d.price_age_days??'?', 'days')+metric('Liquidity',d.liquidity_score||0,'/100')+metric('Risk',d.risk_score||0,'/100')+metric('Live write','off')+'</div>'+limitHtml+(warnings.length?'<details class="softDetails" open><summary>Policy warnings</summary><ul>'+warnings.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul></details>':'')+(blockers.length?'<details class="softDetails" open><summary>Policy blockers</summary><ul>'+blockers.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul></details>':'')+'<details class="softDetails"><summary>Policy checks</summary><pre>'+esc(JSON.stringify(d.checks||[],null,2))+'</pre></details></div>';
  }).join('');
  el.innerHTML='<div class="metrics compactMetrics">'+metric('Drafts',data.drafts||0)+metric('Passed',data.passed||0)+metric('Warnings',data.passed_with_warnings||0)+metric('Blocked',data.blocked||0)+metric('Next',data.next_safe_step||'review')+'</div><p class="muted">'+esc(data.guidance||'Policy is local-only. Live Backpack.tf writes remain disabled.')+'</p>'+(cards||'<p class="muted">No draft policy items yet.</p>');
}

async function updateListingDraftReview(id,status){
  const data=await api('/api/listing-drafts/review/update',{method:'POST',body:JSON.stringify({id,status})});
  renderListingDraftReview(data);setLog(data);return data;
}

function renderListingsPlanMode(data){
  const el=qs('#listingsPlanMode'); if(!el)return;
  if(!data||!data.ok){el.innerHTML=`<p class="muted">${esc(data?.error||'No planned listings yet.')}</p>`;return;}
  const actions=data.actions||[];
  el.innerHTML=`<p><b>Planned listings:</b> ${actions.length} Â· live writes disabled by default</p>${actions.length?actions.slice(0,8).map(a=>`<div class="miniRow"><b>${esc(a.item_name||a.action)}</b><small>${Number(a.price_ref||a.value_ref||0)} ref Â· ${esc(a.status||'planned')}</small></div>`).join(''):'<p class="muted">No listing suggestions yet. Sync inventory first.</p>'}`;
}


// â”€â”€ 5.13.43 â€“ Live Dashboard (lite poll + adaptive backoff) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Poll the cheap /status/lite endpoint by default.  Pull the heavy /status
// payload only when the lite signature actually changes, when a panel that
// needs full data is open, or on a slow background interval.  Back off when
// the tab is hidden and exponentially on errors so a small HA host is not
// pegged by an idle browser tab.
const LIVE_DASHBOARD_REFRESH_MS = 8000;
const LIVE_DASHBOARD_HIDDEN_REFRESH_MS = 60000;
const LIVE_DASHBOARD_EVENT_REFRESH_MS = 2500;
const LIVE_DASHBOARD_FULL_REFRESH_MS = 45000;
const LIVE_DASHBOARD_ERROR_BACKOFF_MAX_MS = 120000;
let liveDashboardState = {
  polling: false,
  lastSignature: '',
  lastLiteSignature: '',
  lastActionSignature: '',
  lastUpdateAt: null,
  lastFullRefreshAt: 0,
  nextTimer: null,
  pollTimer: null,
  errors: 0
};
function nowIso(){return new Date().toISOString();}
function getActionItems(data){
  if(!data || typeof data !== 'object') return [];
  for(const key of ['items','entries','feed','actions','action_feed','recent']){
    if(Array.isArray(data[key])) return data[key];
  }
  if(data.result) return getActionItems(data.result);
  return [];
}
function actionFeedSignature(data){
  const items=getActionItems(data);
  if(!items.length) return 'no-actions';
  return items.slice(0,5).map(x=>[x.id,x.ts,x.type,x.updated_at,x.item_name,x.status].filter(Boolean).join(':')).join('|');
}
function wizardEventSignature(data){
  if(!data || typeof data !== 'object') return 'no-wizard';
  const maint=data.classifieds_maintainer||{};
  const last=maint.last_result_summary||{};
  const auto=data.auto_sell_relister||{};
  const autoLast=auto.last_result||{};
  const guard=data.trade_guard||{};
  const guardLast=guard.last_result||{};
  const ver=data.publish_verification||{};
  return JSON.stringify({
    enabled: !!maint.enabled,
    write_mode: data.backpack_tf_write_mode,
    guarded: !!data.guarded_publish_enabled,
    live: !!data.live_classifieds_writes_enabled,
    candidate: data.candidate_draft_id||null,
    ready: !!data.ready_to_publish_guarded,
    verified: !!ver.listed,
    match_count: Array.isArray(ver.matches)?ver.matches.length:0,
    already_active: last.already_active||0,
    published: last.published||0,
    errors: last.errors||0,
    archived_or_currency: last.archived_or_currency||0,
    auto_sell_drafts: auto.auto_sell_drafts||0,
    auto_detected: (autoLast.counters&&autoLast.counters.detected)||0,
    trade_declined: Array.isArray(guardLast.declined)?guardLast.declined.length:0,
    trade_failed: Array.isArray(guardLast.failed)?guardLast.failed.length:0
  });
}
function renderLiveDashboardStatus(state='ok', message='Live dashboard updated', meta=''){
  const el=document.getElementById('liveDashboardStatus');
  if(!el) return;
  el.classList.toggle('warn', state==='warn');
  el.classList.toggle('bad', state==='bad');
  const when=liveDashboardState.lastUpdateAt ? new Date(liveDashboardState.lastUpdateAt).toLocaleTimeString() : 'never';
  el.innerHTML=`<span class="dot"></span><span><strong>${esc2(message)}</strong>${meta?` Â· ${esc2(meta)}`:''}<br><small>Auto-refresh every ${Math.round(LIVE_DASHBOARD_REFRESH_MS/1000)}s Â· last update ${esc2(when)}</small></span>`;
}
function liteSignature(lite){
  if(!lite || typeof lite !== 'object') return 'no-lite';
  const m=lite.classifieds_maintainer||{};
  const a=lite.auto_sell_relister||{};
  return [
    lite.planning_queue&&lite.planning_queue.count, lite.planning_queue&&lite.planning_queue.approved,
    lite.drafts&&lite.drafts.count, lite.drafts&&lite.drafts.approved,
    lite.candidate_draft_id||'',
    lite.backpack_tf_write_mode||'',
    lite.guarded_publish_enabled?1:0, lite.live_classifieds_writes_enabled?1:0,
    lite.publish_verified?1:0,
    m.enabled?1:0, m.due_in_seconds==null?'':m.due_in_seconds,
    a.enabled?1:0
  ].join('|');
}
function nextPollDelay(reason){
  if(liveDashboardState.errors>0){
    return Math.min(LIVE_DASHBOARD_ERROR_BACKOFF_MAX_MS, LIVE_DASHBOARD_REFRESH_MS * Math.pow(2, Math.min(liveDashboardState.errors, 4)));
  }
  if(document.hidden) return LIVE_DASHBOARD_HIDDEN_REFRESH_MS;
  return LIVE_DASHBOARD_REFRESH_MS;
}
function scheduleLiveDashboardRefresh(delay=LIVE_DASHBOARD_EVENT_REFRESH_MS){
  clearTimeout(liveDashboardState.nextTimer);
  liveDashboardState.nextTimer=setTimeout(()=>refreshLiveDashboard('scheduled'), delay);
}
function scheduleNextPoll(){
  clearTimeout(liveDashboardState.pollTimer);
  liveDashboardState.pollTimer=setTimeout(()=>refreshLiveDashboard('poll'), nextPollDelay());
}
async function refreshLiveDashboard(reason='poll'){
  if(liveDashboardState.polling) return;
  if(document.hidden && reason==='poll'){ scheduleNextPoll(); return; }
  liveDashboardState.polling=true;
  try{
    // Lite poll first.  Cheap; just steps + counters + maintainer header.
    const [liteRes, feedRes] = await Promise.allSettled([
      api('/api/publish-wizard/status/lite'),
      api('/api/action-feed')
    ]);
    let lite=null, feed=null, wizard=null;
    if(liteRes.status==='fulfilled') lite=liteRes.value;
    if(feedRes.status==='fulfilled'){ feed=feedRes.value; renderFeed(feed); }
    const liteSig=liteSignature(lite);
    const liteChanged = liteSig !== liveDashboardState.lastLiteSignature;
    const fullStale = (Date.now() - liveDashboardState.lastFullRefreshAt) > LIVE_DASHBOARD_FULL_REFRESH_MS;
    if(liteChanged || fullStale || reason==='scheduled' || reason==='manual'){
      try{
        wizard = await api('/api/publish-wizard/status');
        renderPublishWizard(wizard);
        liveDashboardState.lastFullRefreshAt = Date.now();
      }catch{ /* keep lite-only render below */ }
    }
    liveDashboardState.lastLiteSignature = liteSig;
    const signature = (wizard?wizardEventSignature(wizard):liteSig) + '||' + actionFeedSignature(feed);
    const changed = signature !== liveDashboardState.lastSignature;
    liveDashboardState.lastSignature = signature;
    liveDashboardState.lastUpdateAt = Date.now();
    liveDashboardState.errors = 0;
    const maint = (wizard&&wizard.classifieds_maintainer)||(lite&&lite.classifieds_maintainer)||null;
    const due = maint&&maint.enabled ? (maint.due_in_seconds===0?'now':(maint.due_in_seconds!=null?`${maint.due_in_seconds}s`:'soon')) : 'paused';
    renderLiveDashboardStatus('ok', changed?'Live dashboard updated from new event':'Live dashboard watching', `reason ${reason} Â· next maintainer ${due} Â· lite${wizard?'+full':''}`);
    if(changed && wizard){
      Promise.allSettled([
        api('/api/hub-listing-drafts').then(renderHubListingDrafts),
        api('/api/opportunities').then(renderOpportunities),
        api('/api/main-account/status').then(renderCredentials)
      ]).catch(()=>{});
    }
  }catch(err){
    liveDashboardState.errors++;
    renderLiveDashboardStatus(liveDashboardState.errors>2?'bad':'warn','Live dashboard refresh failed', String(err&&err.message?err.message:err));
  }finally{
    liveDashboardState.polling=false;
    scheduleNextPoll();
  }
}
function startLiveDashboardPolling(){
  renderLiveDashboardStatus('ok','Live dashboard starting');
  scheduleLiveDashboardRefresh(250);
  scheduleNextPoll();
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden){ liveDashboardState.errors=0; scheduleLiveDashboardRefresh(250); } });
  window.addEventListener('focus',()=>{ liveDashboardState.errors=0; scheduleLiveDashboardRefresh(250); });
}

async function refreshSda(){try{const data=await api('/api/sda/status');renderSdaBridge(data);return data;}catch(e){const data={ok:false,error:e.message};renderSdaBridge(data);return data;}}
async function refresh(){
  // 5.13.43: hydrated fast dashboard.  The first paint must not show confusing
  // "skipped during fast dashboard load" cards.  Load the small status endpoints
  // first, then hydrate the production dashboard and credentials with longer
  // guarded timeouts.  Manual workflow runs stay behind their own buttons.
  const pending=(label)=>({ok:true,hydrating:true,message:`${label} is loadingâ€¦`,error:null});
  const safe=(path,label,timeoutMs=12000)=>Promise.race([
    api(path),
    new Promise(resolve=>setTimeout(()=>resolve(pending(label)),timeoutMs))
  ]).catch(err=>({ok:false,error:err&&err.message?err.message:String(err),path}));
  const [st,versionAudit,set,feed]=await Promise.all([
    safe('/api/status','status',5000),
    safe('/api/version-audit','version audit',5000),
    safe('/api/setup/status','setup',8000),
    safe('/api/action-feed','action feed',8000)
  ]);
  renderStatus(st);renderVersionAudit(versionAudit);renderSetup(set);renderFeed(feed);
  // These cards are visible in the main dashboard, so give them enough time to
  // return instead of rendering a permanent "skipped" placeholder.
  const [cred,publishWizard]=await Promise.all([
    safe('/api/main-account/status','credentials',15000),
    safe('/api/publish-wizard/status','production dashboard',20000)
  ]);
  renderCredentials(cred);
  renderPublishWizard(publishWizard);
  // Secondary panels should never block opening the add-on.
  Promise.allSettled([
    safe('/api/planning-queue','planning queue',12000).then(renderPlanningQueue),
    safe('/api/hub-listing-drafts','listing drafts',12000).then(renderHubListingDrafts),
    safe('/api/workflow/run-local','local workflow snapshot',8000).then(renderLocalWorkflow),
    safe('/api/opportunities','opportunities snapshot',12000).then(renderOpportunities)
  ]).catch(()=>{});
  scheduleLiveDashboardRefresh(250);
  setLog({ok:true,version:(versionAudit&&versionAudit.expected)||'5.14.2',hydrated_dashboard_load:true,message:'Dashboard loaded. Live status will keep hydrating in the background.'});
}
async function loadJsonTo(selector,path,options){const data=await api(path,options);qs(selector).textContent=JSON.stringify(data,null,2);return data;}
async function runReview(){qs('#review').disabled=true;try{await loadJsonTo('#logs','/api/review/run',{method:'POST',body:'{}'});await api('/api/trading-core/build',{method:'POST',body:'{}'});await refresh();}catch(e){setLog(e.body||e.message);}finally{qs('#review').disabled=false;}}
async function runAutopilot(){qs('#runAutopilot').disabled=true;try{const data=await api('/api/autopilot/run',{method:'POST',body:'{}'});setLog(data);await refresh();}catch(e){setLog(e.body||e.message);await refresh().catch(()=>{});}finally{qs('#runAutopilot').disabled=false;}}
async function buildScanner(){try{const data=await api('/api/market-scanner/build',{method:'POST',body:'{}'});renderScanner(data);setLog(data);await api('/api/trading-core/build',{method:'POST',body:'{}'}).catch(()=>null);await refresh();}catch(e){setLog(e.body||e.message);}}
async function markOffer(tradeofferid,status){await api('/api/offers/mark',{method:'POST',body:JSON.stringify({tradeofferid,status})});await refresh();}
async function confirmRecommendedViaSda(){try{const ids=latestDecisions.filter(d=>d.decision==='accept_recommended'&&d.reviewed_status!=='ignored').map(d=>String(d.tradeofferid));if(!ids.length){setSda('No accept_recommended offers found. Run trade review first.');return;}const data=await api('/api/sda/confirm',{method:'POST',body:JSON.stringify({offer_ids:ids})});setSda(data);await refresh();}catch(e){setSda(e.body||e.message);}}
async function saveSelectedCredentials(extra={}){
  // 5.13.43: verified save.  The UI only clears secret fields after the backend
  // confirms that the canonical Main credential vault was written and re-read.
  const accountId='main';
  const selectedRole='main';
  const saveBtn=qs('#saveCredentials');
  const profileBtn=qs('#saveMainProfile');
  const oldSaveText=saveBtn?saveBtn.textContent:'';
  const oldProfileText=profileBtn?profileBtn.textContent:'';
  if(saveBtn){saveBtn.disabled=true;saveBtn.textContent='Savingâ€¦';}
  if(profileBtn){profileBtn.disabled=true;profileBtn.textContent='Savingâ€¦';}
  try{
    const steamId=(qs('#credentialSteamId')?.value||qs('#mainSteamId')?.value||'').replace(/\s+/g,'').trim();
    if(steamId&&qs('#credentialSteamId'))qs('#credentialSteamId').value=steamId;
    if(steamId&&qs('#mainSteamId'))qs('#mainSteamId').value=steamId;
    const rawPayload={account_id:accountId,id:'main',role:selectedRole,make_active:true,force_main_account_switch:true};
    const steamIdVal=maskedInputValue(steamId); if(steamIdVal)rawPayload.steam_id64=steamIdVal;
    const steamApiVal=maskedInputValue(qs('#steamApiKey')?.value); if(steamApiVal)rawPayload.steam_web_api_key=steamApiVal;
    const backpackTokenVal=maskedInputValue(qs('#backpackAccessToken')?.value); if(backpackTokenVal)rawPayload.backpack_tf_access_token=backpackTokenVal;
    const backpackApiVal=maskedInputValue(qs('#backpackApiKey')?.value); if(backpackApiVal)rawPayload.backpack_tf_api_key=backpackApiVal;
    const payload={...rawPayload,...extra};
    const started=performance.now();
    let data;
    try{
      data=await api('/api/main-account/save-local-only',{method:'POST',body:JSON.stringify(payload),timeoutMs:8000});
    }catch(saveErr){
      const errMsg=saveErr&&saveErr.message?saveErr.message:'Save request failed';
      setLog({ok:false,error:errMsg,message:'Save failed: '+errMsg,trace_id:(saveErr&&saveErr.trace_id)||''});
      return null;
    }
    if(!data||!data.ok){
      const errMsg=(data&&data.error)||'Save failed';
      setLog({ok:false,version:data&&data.version,error:errMsg,trace_id:(data&&data.trace_id)||'',message:'Save failed: '+errMsg+(data&&data.trace_id?' (trace: '+data.trace_id+')':'')});
      return data||null;
    }
    const status=await api('/api/main-account/status',{timeoutMs:5000}).catch(()=>data);
    const finalData=(status&&status.main_account)?{...status,save_result:data,save_verified:data.save_verified,verified:data.verified}:data;
    lastMainAccountSaveResult={ok:!!data.ok,verified:!!(data.verified||data.save_verified),duration_ms:Math.round(performance.now()-started),trace_id:data.trace_id||'',vault_source:(status&&status.source)||data.source||'',readiness:(status&&status.readiness)||data.readiness||''};
    renderCredentials(finalData);
    const main=finalData.main_account||{};
    const saveVerified=!!(finalData.save_verified||data.save_verified||((main.steam_id64_saved||main.steam_id64)&&(main.steam_web_api_key_saved||main.steam_api_key_saved)&&main.backpack_tf_access_token_saved&&main.backpack_tf_api_key_saved));
    if(saveVerified){
      if(qs('#steamApiKey'))qs('#steamApiKey').value='';
      if(qs('#backpackAccessToken'))qs('#backpackAccessToken').value='';
      if(qs('#backpackApiKey'))qs('#backpackApiKey').value='';
    }
    setLog({ok:saveVerified,version:finalData.version||data.version,message:saveVerified?'Main account saved and verified':'Save attempted but verification did not see all credentials',saved_steam_id64:main.steam_id64||steamId,steam_id64_saved:!!(main.steam_id64_saved||main.steam_id64),steam_api_key_saved:!!(main.steam_web_api_key_saved||main.steam_api_key_saved),backpack_tf_access_token_saved:!!main.backpack_tf_access_token_saved,backpack_tf_api_key_saved:!!main.backpack_tf_api_key_saved,readiness:main.readiness||'unknown',save_verified:saveVerified,vault_path:finalData.vault_path||data.vault_path||'',last_save:lastMainAccountSaveResult});
    await api('/api/main-account/status',{timeoutMs:5000}).then(renderCredentials).catch(()=>null);return finalData;
  } finally {
    if(saveBtn){saveBtn.disabled=false;saveBtn.textContent=oldSaveText||'Save main account';}
    if(profileBtn){profileBtn.disabled=false;profileBtn.textContent=oldProfileText||'Save main account';}
  }
}
async function saveSubAccount(){
  const payload={id:qs('#subAccountId').value,label:qs('#subAccountLabel').value,steam_id64:qs('#subAccountSteamId').value,role:qs('#subAccountRole').value};
  const data=await api('/api/accounts/account',{method:'POST',body:JSON.stringify(payload)});setLog(data);
  const createdId=payload.id;
  qs('#subAccountId').value='';qs('#subAccountLabel').value='';qs('#subAccountSteamId').value='';qs('#subAccountRole').value='storage';await refresh();
  if(createdId&&qs('#credentialAccountId')){qs('#credentialAccountId').value=createdId;}
}
async function saveAccountRole(accountId,role){const data=await api('/api/accounts/account',{method:'POST',body:JSON.stringify({id:accountId,role})});setLog(data);await refresh();}
async function removeAccount(accountId){const data=await api('/api/accounts/remove',{method:'POST',body:JSON.stringify({id:accountId})});setLog(data);await refresh();}
async function runDiagnosticBundle(){
  const btn=qs('#runDiagnosticBundle');
  if(btn){btn.disabled=true;btn.textContent='Building diagnosticâ€¦';}
  const status=qs('#diagnosticBundleStatus');
  try{
    if(status)status.innerHTML='<p>'+pill('running','warn')+' Building assistant diagnostic reportâ€¦</p><small class="muted">One click runs the full safe pipeline and downloads the assistant-ready JSON report.</small>';
    let data=null;
    try{
      data=await api('/api/diagnostics/bundle',{method:'POST',body:'{}'});
    }catch(postError){
      const body=postError&&postError.body;
      if(body&&typeof body==='object') data=body;
      else throw postError;
    }
    if(!data||typeof data!=='object') throw new Error('Diagnostic bundle response was empty.');
    renderDiagnosticBundle(data);
    saveJsonDownload(data.file_name||('tf2-hub-diagnostic-'+(data.version||'bundle')+'.json'),data);
    const planStage=(data.stages||[]).find(x=>x.stage==='actionable_plan');
    const queueStage=(data.stages||[]).find(x=>x.stage==='execution_queue');
    if(planStage&&planStage.result)renderActionablePlan(planStage.result);
    if(queueStage&&queueStage.result)renderExecutionQueue(queueStage.result);
    const lifecycleStage=(data.stages||[]).find(x=>x.stage==='approved_action_lifecycle');
    if(lifecycleStage&&lifecycleStage.result)renderApprovedLifecycle(lifecycleStage.result);
    const draftStage=(data.stages||[]).find(x=>x.stage==='listing_draft_preview');
    if(draftStage&&draftStage.result)renderListingDraftPreview(draftStage.result);
    const draftReviewStage=(data.stages||[]).find(x=>x.stage==='listing_draft_review');
    const draftPolicyStage=(data.stages||[]).find(x=>x.stage==='listing_draft_policy');
    const payloadStage=(data.stages||[]).find(x=>x.stage==='backpack_listing_payload_preview');
    const payloadReviewStage=(data.stages||[]).find(x=>x.stage==='backpack_listing_payload_review');
    const payloadLocalStage=(data.stages||[]).find(x=>x.stage==='backpack_listing_payload_local_approval');
    const publishReadinessStage=(data.stages||[]).find(x=>x.stage==='publish_readiness_gate');
    if(draftReviewStage&&draftReviewStage.result)renderListingDraftReview(draftReviewStage.result);
    if(draftPolicyStage&&draftPolicyStage.result)renderListingDraftPolicy(draftPolicyStage.result);
    if(payloadStage&&payloadStage.result)renderBackpackListingPayloadPreview(payloadStage.result);
    if(payloadReviewStage&&payloadReviewStage.result)renderBackpackListingPayloadReview(payloadReviewStage.result);
    if(payloadLocalStage&&payloadLocalStage.result)renderBackpackListingPayloadLocalApproval(payloadLocalStage.result);
    if(publishReadinessStage&&publishReadinessStage.result)renderPublishReadinessGate(publishReadinessStage.result);const publishHandoffStage=(data.stages||[]).find(s=>s.stage==='publish_handoff');if(publishHandoffStage&&publishHandoffStage.result)renderPublishHandoff(publishHandoffStage.result);const triageStage=(data.stages||[]).find(s=>s.stage==='diagnostic_triage');if(triageStage&&triageStage.result)renderDiagnosticTriage(triageStage.result);
    setLog({ok:true,diagnostic_bundle:data.file_name,summary:data.summary,stages:(data.stages||[]).map(x=>({stage:x.stage,ok:x.ok,error:x.error||null}))});
    await refresh();
  }catch(e){
    const reason=(e.body&&e.body.error)||e.message||'Unknown error';
    setLog(e.body||reason);
    const fallback=await downloadCachedDiagnosticFallback(e.body||reason);
    if(status)status.innerHTML='<p>'+pill('downloaded fallback','warn')+' Diagnostic bundle primary request failed</p><small>'+esc(reason)+' â€” cached/client fallback JSON was downloaded so the assistant can still diagnose it.</small>';
    renderDiagnosticBundle(fallback);
  }finally{
    if(btn){btn.disabled=false;btn.textContent='Diagnostic bundle for assistant';}
  }
}
qs('#runDiagnosticBundle')?.addEventListener('click',runDiagnosticBundle);
qs('#buildBrain')?.addEventListener('click',async()=>{try{const data=await api('/api/trading-brain/build',{method:'POST',body:'{}'});renderTradingBrain(data);setLog(data);await refresh();}catch(e){setLog(e.body||e.message);}});
qs('#buildExecutionQueue')?.addEventListener('click',async()=>{try{const data=await api('/api/execution-queue/build',{method:'POST',body:'{}'});renderExecutionQueue(data);setLog(data);await refresh();}catch(e){setLog(e.body||e.message);}});
qs('#buildActionablePlan')?.addEventListener('click',async()=>{try{const data=await api('/api/actionable-plan/build',{method:'POST',body:'{}'});renderActionablePlan(data);setLog(data);await api('/api/execution-queue/build',{method:'POST',body:'{}'}).catch(()=>null);await refresh();}catch(e){setLog(e.body||e.message);}});
async function updatePlanAction(id, action){
  const data=await api('/api/actionable-plan/'+encodeURIComponent(id)+'/'+action,{method:'POST',body:'{}'});
  renderActionablePlan(data);
  const q=await api('/api/execution-queue').catch(()=>null);
  if(q)renderExecutionQueue(q);
  setLog({ok:true,actionable_plan_action:action,id});
  return data;
}
async function updateVisiblePlan(action){
  const current=await api('/api/actionable-plan');
  const ids=actionPlanVisibleItems(current).slice(0,12).map(x=>x.id).filter(Boolean);
  for(const id of ids){ await api('/api/actionable-plan/'+encodeURIComponent(id)+'/'+action,{method:'POST',body:'{}'}); }
  const data=await api('/api/actionable-plan');
  renderActionablePlan(data);
  const q=await api('/api/execution-queue/build',{method:'POST',body:'{}'}).catch(()=>null);
  if(q)renderExecutionQueue(q);
  setLog({ok:true,bulk_action:action,items:ids.length});
}
async function bulkActionPlan(mode, action='approve'){
  const data=await api('/api/actionable-plan/bulk',{method:'POST',body:JSON.stringify({mode,action})});
  renderActionablePlan(data);
  const q=await api('/api/execution-queue').catch(()=>null);
  if(q)renderExecutionQueue(q);
  setLog({ok:true,smart_bulk_review:data.bulk_review||{mode,action}});
}
async function bulkQueue(action){
  const data=await api('/api/execution-queue/bulk',{method:'POST',body:JSON.stringify({action})});
  renderExecutionQueue(data);
  setLog({ok:true,queue_bulk:data.bulk_review||{action}});
}
async function updateQueueAction(id, action){
  const data=await api('/api/execution-queue/'+encodeURIComponent(id)+'/'+action,{method:'POST',body:'{}'});
  renderExecutionQueue(data);
  setLog({ok:true,queue_action:action,id});
}
document.addEventListener('click',e=>{if(e.target&&e.target.closest&&e.target.closest('#applyAssistantRecommendation')){applyAssistantRecommendation().catch(err=>setLog(err.body||err.message));}});
qs('#actionablePlan')?.addEventListener('click',e=>{
  const filter=e.target.closest('[data-plan-filter]');
  if(filter){actionPlanFilter=filter.dataset.planFilter||'all';api('/api/actionable-plan').then(renderActionablePlan).catch(err=>setLog(err.body||err.message));return;}
  const bulk=e.target.closest('[data-bulk-plan]');
  if(bulk){bulkActionPlan(bulk.dataset.bulkPlan||'top5',bulk.dataset.bulkAction||'approve').catch(err=>setLog(err.body||err.message));return;}
  const btn=e.target.closest('[data-plan-action]');
  if(btn){updatePlanAction(decodeURIComponent(btn.dataset.actionId||''),btn.dataset.planAction).catch(err=>setLog(err.body||err.message));return;}
  if(e.target.closest('#approveVisiblePlan')){updateVisiblePlan('approve').catch(err=>setLog(err.body||err.message));return;}
  if(e.target.closest('#ignoreVisiblePlan')){updateVisiblePlan('ignore').catch(err=>setLog(err.body||err.message));return;}
});
qs('#executionQueue')?.addEventListener('click',e=>{
  const filter=e.target.closest('[data-queue-filter]');
  if(filter){executionQueueFilter=filter.dataset.queueFilter||'pending';api('/api/execution-queue').then(renderExecutionQueue).catch(err=>setLog(err.body||err.message));return;}
  if(e.target.closest('#approvePendingQueue')){bulkQueue('approve_pending').catch(err=>setLog(err.body||err.message));return;}
  if(e.target.closest('#cancelPendingQueue')){bulkQueue('cancel_pending').catch(err=>setLog(err.body||err.message));return;}
  const rebuild=e.target.closest('#rebuildExecutionQueue');
  if(rebuild){api('/api/execution-queue/build',{method:'POST',body:'{}'}).then(renderExecutionQueue).catch(err=>setLog(err.body||err.message));return;}
  const btn=e.target.closest('[data-queue-action]');
  if(btn){updateQueueAction(decodeURIComponent(btn.dataset.queueId||''),btn.dataset.queueAction).catch(err=>setLog(err.body||err.message));}
});
qs('#refreshExecutionQueue')?.addEventListener('click',()=>api('/api/execution-queue').then(renderExecutionQueue).catch(e=>setLog(e.body||e.message)));
qs('#buildTransfers')?.addEventListener('click',async()=>{try{const data=await api('/api/transfers/plan/build',{method:'POST',body:'{}'});renderTransferPlan(data);setLog(data);await refresh();}catch(e){setLog(e.body||e.message);}});
qs('#buildListingDraftPreview')?.addEventListener('click',async()=>{try{const data=await api('/api/listing-drafts/preview/build',{method:'POST',body:'{}'});renderListingDraftPreview(data);setLog(data);await refresh();}catch(e){setLog(e.body||e.message);}});
qs('#buildListingDraftReview')?.addEventListener('click',async()=>{try{const preview=await api('/api/listing-drafts/preview/build',{method:'POST',body:'{}'});renderListingDraftPreview(preview);const data=await api('/api/listing-drafts/review/build',{method:'POST',body:'{}'});renderListingDraftReview(data);setLog(data);await refresh();}catch(e){setLog(e.body||e.message);}});
qs('#buildListingDraftPolicy')?.addEventListener('click',async()=>{try{const review=await api('/api/listing-drafts/review/build',{method:'POST',body:'{}'});renderListingDraftReview(review);const data=await api('/api/listing-drafts/policy/build',{method:'POST',body:'{}'});renderListingDraftPolicy(data);setLog(data);await refresh();}catch(e){setLog(e.body||e.message);}});
qs('#listingDraftReview')?.addEventListener('click',e=>{const b=e.target.closest('button[data-draft-review]');if(b)updateListingDraftReview(decodeURIComponent(b.dataset.draftId||''),b.dataset.draftReview).catch(err=>setLog(err.body||err.message));});
qs('#localDraftApproval')?.addEventListener('click',async(e)=>{const b=e.target.closest('#applyLocalDraftApproval');if(!b)return;try{const data=await api('/api/listing-drafts/local-approval/apply',{method:'POST',body:'{}'});renderLocalDraftApproval(data);const review=await api('/api/listing-drafts/review');renderListingDraftReview(review);const policy=await api('/api/listing-drafts/policy');renderListingDraftPolicy(policy);setLog(data);await refresh();}catch(err){setLog(err.body||err.message);}});
qs('#backpackPayloadPreview')?.addEventListener('click',async(e)=>{const b=e.target.closest('#buildPayloadPreview');if(!b)return;try{const data=await api('/api/listing-drafts/payload-preview/build',{method:'POST',body:'{}'});renderBackpackListingPayloadPreview(data);setLog(data);await refresh();}catch(err){setLog(err.body||err.message);}});
qs('#backpackPayloadReview')?.addEventListener('click',async(e)=>{const build=e.target.closest('#buildPayloadReview');if(build){try{const data=await api('/api/listing-drafts/payload-review/build',{method:'POST',body:'{}'});renderBackpackListingPayloadReview(data);setLog(data);await refresh();}catch(err){setLog(err.body||err.message);}return;}const btn=e.target.closest('button[data-payload-review]');if(btn){try{const data=await api('/api/listing-drafts/payload-review/update',{method:'POST',body:JSON.stringify({id:decodeURIComponent(btn.dataset.payloadId||''),status:btn.dataset.payloadReview})});renderBackpackListingPayloadReview(data.review||data);setLog(data);await refresh();}catch(err){setLog(err.body||err.message);}}});
qs('#backpackPayloadLocalApproval')?.addEventListener('click',async(e)=>{
  const apply=e.target.closest('#applyPayloadLocalApproval');
  const applyDiag=e.target.closest('#applyPayloadLocalApprovalDiagnostic');
  if(!apply&&!applyDiag)return;
  try{
    const data=await api('/api/listing-drafts/payload-local-approval/apply',{method:'POST',body:'{}'});
    renderBackpackListingPayloadLocalApproval(data);
    setLog(data);
    if(applyDiag){
      const bundle=await api('/api/diagnostics/bundle',{method:'POST',body:'{}'});
      renderDiagnosticBundle(bundle);
      saveJsonDownload(bundle.file_name||'tf2-hub-diagnostic-after-payload-approval.json',bundle);
    }
    await refresh();
  }catch(err){setLog(err.body||err.message);}
});
qs('#buildPublishReadinessGate')?.addEventListener('click',async()=>{try{const dry=await api('/api/listing-drafts/guarded-publish-dry-run/build',{method:'POST',body:'{}'});renderGuardedPublishDryRun(dry);const data=await api('/api/listing-drafts/publish-readiness-gate/build',{method:'POST',body:'{}'});renderPublishReadinessGate(data);const handoff=await api('/api/listing-drafts/publish-handoff/build',{method:'POST',body:'{}'});renderPublishHandoff(handoff);const triage=await api('/api/diagnostics/triage/build',{method:'POST',body:'{}'});renderDiagnosticTriage(triage);setLog({handoff,triage});await refresh();}catch(e){setLog(e.body||e.message);}});
qs('#buildPublishHandoff')?.addEventListener('click',async()=>{try{const gate=await api('/api/listing-drafts/publish-readiness-gate/build',{method:'POST',body:'{}'});renderPublishReadinessGate(gate);const data=await api('/api/listing-drafts/publish-handoff/build',{method:'POST',body:'{}'});renderPublishHandoff(data);const triage=await api('/api/diagnostics/triage/build',{method:'POST',body:'{}'});renderDiagnosticTriage(triage);setLog({handoff:data,triage});await refresh();}catch(e){setLog(e.body||e.message);}});
qs('#buildDiagnosticTriage')?.addEventListener('click',async()=>{try{const data=await api('/api/diagnostics/triage/build',{method:'POST',body:'{}'});renderDiagnosticTriage(data);setLog(data);await refresh();}catch(e){setLog(e.body||e.message);}});
qs('#buildListingsPlan')?.addEventListener('click',async()=>{try{const data=await api('/api/listings/plan/build',{method:'POST',body:'{}'});renderListingsPlanMode(data);setLog(data);await refresh();}catch(e){setLog(e.body||e.message);}});

['mainSteamId','credentialSteamId'].forEach(id=>{const el=qs('#'+id);if(el){el.addEventListener('input',()=>{const v=el.value.replace(/\s+/g,'').trim();const other=id==='mainSteamId'?qs('#credentialSteamId'):qs('#mainSteamId');if(other&&other!==el&&v&&other.value!==v)other.value=v;});}});
qs('#runAutopilot').addEventListener('click',runAutopilot);qs('#refreshAll').addEventListener('click',refresh);qs('#buildCore').addEventListener('click',async()=>{try{const data=await api('/api/trading-core/build',{method:'POST',body:'{}'});renderTradingCore(data);setLog(data);await refresh();}catch(e){setLog(e.body||e.message);}});qs('#buildScanner').addEventListener('click',buildScanner);qs('#loadSetup').addEventListener('click',()=>api('/api/setup/status').then(renderSetup).catch(e=>setLog(e.message)));qs('#saveMainProfile').addEventListener('click',async()=>{try{const steam=(qs('#mainSteamId')?.value||qs('#credentialSteamId')?.value||'').replace(/\s+/g,'').trim();if(steam&&qs('#credentialSteamId'))qs('#credentialSteamId').value=steam;const data=await saveSelectedCredentials({label:qs('#mainLabel')?.value||'Main account',steam_id64:steam});setLog({ok:true,message:'Main account saved from workflow card',result:data});await refresh();}catch(e){setLog(e.body||e.message);}});qs('#refreshCredentials').addEventListener('click',()=>api('/api/main-account/status').then(renderCredentials).catch(e=>setLog(e.message)));qs('#saveCredentials').addEventListener('click',async()=>{try{const data=await saveSelectedCredentials({label:qs('#mainLabel')?.value||'Main account'});setLog(data);}catch(e){setLog(e.body||e.message);}});qs('#saveSubAccount').addEventListener('click',()=>saveSubAccount().catch(e=>setLog(e.body||e.message)));qs('#credentialAccountId')?.addEventListener('change',()=>{qs('#credentialSteamId').value='';api('/api/main-account/status').then(renderCredentials).catch(e=>setLog(e.message));});qs('#credentialStatus').addEventListener('click',e=>{const roleBtn=e.target.closest('.saveAccountRole');if(roleBtn){const id=roleBtn.dataset.id;const role=qs(`.accountRoleSelect[data-id="${cssId(id)}"]`)?.value||'trade';saveAccountRole(id,role).catch(err=>setLog(err.body||err.message));return;}const credBtn=e.target.closest('.useCredentials');if(credBtn){qs('#credentialAccountId').value=credBtn.dataset.id;qs('#credentialSteamId').value='';api('/api/main-account/status').then(renderCredentials).catch(err=>setLog(err.message));return;}const removeBtn=e.target.closest('.removeAccount');if(removeBtn){removeAccount(removeBtn.dataset.id).catch(err=>setLog(err.body||err.message));}});qs('#clearSteamApi').addEventListener('click',async()=>{try{const data=await saveSelectedCredentials({clear_steam_web_api_key:true});setLog(data);}catch(e){setLog(e.body||e.message);}});qs('#clearBackpackToken').addEventListener('click',async()=>{try{const data=await saveSelectedCredentials({clear_backpack_tf_access_token:true,clear_backpack_tf_api_key:true});setLog(data);}catch(e){setLog(e.body||e.message);}});
qs('#syncInventory').addEventListener('click',async()=>{try{qs('#syncOutput').textContent='Syncing Steam inventoryâ€¦';const data=await api('/api/inventory/sync',{method:'POST',body:'{}'});qs('#syncOutput').textContent=JSON.stringify(data,null,2);await api('/api/trading-core/build',{method:'POST',body:'{}'}).catch(()=>null);await refresh();}catch(e){qs('#syncOutput').textContent=e.body?JSON.stringify(e.body,null,2):e.message;await refresh().catch(()=>{});}});qs('#review').addEventListener('click',runReview);qs('#syncBackpack').addEventListener('click',async()=>{try{qs('#syncOutput').textContent='Syncing Backpack.tfâ€¦';await loadJsonTo('#syncOutput','/api/backpack/sync',{method:'POST',body:'{}'});await api('/api/market-scanner/build',{method:'POST',body:'{}'}).catch(()=>null);await api('/api/trading-core/build',{method:'POST',body:'{}'});await refresh();}catch(e){qs('#syncOutput').textContent=e.body?JSON.stringify(e.body,null,2):e.message;await refresh().catch(()=>{});}});qs('#loadPlan').addEventListener('click',()=>loadJsonTo('#listingPlan','/api/backpack/plan').catch(e=>qs('#listingPlan').textContent=e.message));qs('#acceptRecommended').addEventListener('click',async()=>{try{await loadJsonTo('#logs','/api/trades/approve-recommended',{method:'POST',body:JSON.stringify({confirm_after_accept:false})});await refresh();}catch(e){setLog(e.body||e.message);}});qs('#acceptAndConfirm').addEventListener('click',async()=>{try{await loadJsonTo('#logs','/api/trades/approve-recommended',{method:'POST',body:JSON.stringify({confirm_after_accept:true})});await refresh();}catch(e){setLog(e.body||e.message);}});qs('#checkSdaBridge').addEventListener('click',async()=>{const data=await refreshSda();setSda(data);});qs('#loadSdaConfirmations').addEventListener('click',()=>loadJsonTo('#sdaOutput','/api/sda/confirmations').catch(e=>setSda(e.body||e.message)));qs('#confirmAcceptRecommendedSda').addEventListener('click',confirmRecommendedViaSda);qs('#decisions').addEventListener('click',e=>{const b=e.target.closest('button[data-mark]');if(b)markOffer(b.dataset.offer,b.dataset.mark).catch(err=>setLog(err.body||err.message));});qs('#refreshFeed').addEventListener('click',()=>api('/api/action-feed').then(renderFeed).catch(e=>setLog(e.message)));qs('#loadAcceptLog').addEventListener('click',()=>loadJsonTo('#logs','/api/trade/accept-log').catch(e=>setLog(e.message)));qs('#loadAudit').addEventListener('click',()=>loadJsonTo('#logs','/api/audit').catch(e=>setLog(e.message)));qs('#loadDataStatus').addEventListener('click',()=>loadJsonTo('#dataStatus','/api/data/status').catch(e=>qs('#dataStatus').textContent=e.message));qs('#runMigration').addEventListener('click',()=>loadJsonTo('#dataStatus','/api/data/migrate',{method:'POST',body:'{}'}).catch(e=>qs('#dataStatus').textContent=e.message));qs('#exportData').addEventListener('click',()=>loadJsonTo('#dataStatus','/api/data/export').catch(e=>qs('#dataStatus').textContent=e.message));
refresh();startLiveDashboardPolling();

// â”€â”€ 5.12.34/35/36 â€“ Planning Queue, Hub Listing Drafts, Workflow, Release Check â”€â”€
function esc2(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function pill2(label,type){const colors={ok:'#2d7a2d',warn:'#a06000',error:'#8b0000',info:'#1a5276'};const c=type==='ok'?colors.ok:type==='warn'?colors.warn:type==='error'?colors.error:colors.info;return `<span style="background:${c};color:#fff;padding:1px 7px;border-radius:10px;font-size:0.78em;margin-right:4px">${esc2(label)}</span>`;}

function renderPlanningQueue(data){
  const el=document.getElementById('planningQueue');if(!el)return;
  if(!data||data.error){el.innerHTML=`<p class="muted">${esc2(data&&data.error||'No planning queue yet. Run Local Workflow or Rebuild Queue.')}</p>`;return;}
  const items=Array.isArray(data.items)?data.items:[];
  const planned=items.filter(x=>x.local_status==='planned'||x.local_status==='needs_review');
  const approved=items.filter(x=>x.local_status==='approved_local');
  const other=items.filter(x=>x.local_status!=='planned'&&x.local_status!=='needs_review'&&x.local_status!=='approved_local');
  let html=`<p class="muted">Updated: ${esc2(data.updated_at||'never')} &nbsp;|&nbsp; ${items.length} items</p>`;
  html+=`<button id="rebuildPlanningQueue" style="margin-right:6px">Rebuild Queue</button>`;
  html+=`<button id="bulkApproveTop3">Approve Top 3</button>`;
  if(approved.length){html+=`<h4 style="color:#2d7a2d">âś“ Approved (${approved.length})</h4><table style="width:100%;font-size:0.85em;border-collapse:collapse">`;
    for(const it of approved){html+=`<tr><td>${esc2(it.item_name)}</td><td>${esc2(it.max_buy_ref)} ref</td><td><em style="color:#2d7a2d">approved_local</em></td><td><button class="pqCancel" data-id="${esc2(it.id)}" style="font-size:0.8em">Cancel</button></td></tr>`;}
    html+=`</table>`;}
  if(planned.length){html+=`<h4>Planned (${planned.length})</h4><table style="width:100%;font-size:0.85em;border-collapse:collapse">`;
    for(const it of planned){html+=`<tr><td>${esc2(it.item_name)}</td><td>${esc2(it.max_buy_ref)} ref</td><td>score ${esc2(it.score)}</td><td><button class="pqApprove" data-id="${esc2(it.id)}" style="font-size:0.8em;background:#2d7a2d;color:#fff">Approve</button> <button class="pqCancel" data-id="${esc2(it.id)}" style="font-size:0.8em">Cancel</button></td></tr>`;}
    html+=`</table>`;}
  if(!items.length)html+=`<p class="muted">No candidates yet. Run Local Workflow to scan market.</p>`;
  el.innerHTML=html;
}

function renderHubListingDrafts(data){
  const el=document.getElementById('hubListingDrafts');if(!el)return;
  if(!data||data.error){el.innerHTML=`<p class="muted">${esc2(data&&data.error||'No listing drafts yet. Approve queue items then build drafts.')}</p>`;return;}
  const drafts=Array.isArray(data.drafts)?data.drafts:[];
  let html=`<p class="muted">Updated: ${esc2(data.updated_at||'never')} &nbsp;|&nbsp; ${drafts.length} drafts</p>`;
  html+=`<button id="buildHubDrafts" style="margin-right:6px">Build Drafts from Approved</button>`;
  for(const d of drafts){
    const statusColor=d.local_status==='approved_local'?'#2d7a2d':d.local_status==='published'?'#1a5276':d.local_status==='cancelled'?'#888':d.local_status==='publish_failed'?'#8b0000':'#666';
    html+=`<div style="border:1px solid #333;border-radius:4px;padding:8px;margin:6px 0">`;
    html+=`<b>${esc2(d.item_name)}</b> &nbsp;<span style="color:${statusColor};font-size:0.85em">${esc2(d.local_status)}</span><br>`;
    html+=`<small>Buy: ${esc2(d.max_buy_ref)} ref &nbsp;|&nbsp; Sell: ${esc2(d.target_sell_ref)} ref &nbsp;|&nbsp; Profit: ${esc2(d.expected_profit_ref)} ref</small><br>`;
    if(d.local_status==='draft'){html+=`<button class="hubDraftApprove" data-id="${esc2(d.draft_id)}" style="font-size:0.8em;background:#2d7a2d;color:#fff;margin-top:4px">Approve Locally</button> `;}
    if(d.local_status==='approved_local'){
      html+=`<button class="hubDraftCopyPayload" data-payload="${encodeURIComponent(JSON.stringify(d.provider_payload_preview||{}))}" style="font-size:0.8em;margin-top:4px">Copy Payload</button> `;
      html+=`<button class="hubDraftTestPublish" data-id="${esc2(d.draft_id)}" style="font-size:0.8em;margin-top:4px">Test Publish Payload</button> `;
      html+=`<button class="hubDraftDuplicateGuard" data-id="${esc2(d.draft_id)}" style="font-size:0.8em;margin-top:4px">Duplicate Guard</button> `;
      html+=`<button class="hubDraftPublish" data-id="${esc2(d.draft_id)}" style="font-size:0.8em;background:#7a2d00;color:#fff;margin-top:4px">Publish to Backpack.tf</button> `;}
    if(d.local_status==='draft'||d.local_status==='approved_local')html+=`<button class="hubDraftCancel" data-id="${esc2(d.draft_id)}" style="font-size:0.8em;margin-top:4px">Cancel</button>`;
    if(d.provider_request_sent)html+=`<br><small style="color:#888">Provider: ${esc2(d.provider_status||'?')} | ${esc2(d.provider_response_summary||'')}</small>`;
    html+=`</div>`;}
  if(!drafts.length)html+=`<p class="muted">No drafts yet. Approve planning queue items then click Build Drafts.</p>`;
  el.innerHTML=html;
}

function renderReleaseCheck(data){
  const el=document.getElementById('releaseCheck');if(!el)return;
  if(!data){el.innerHTML='<p class="muted">Not run yet.</p>';return;}
  const icon=data.ok?'âś…':'âš ď¸Ź';
  let html=`<p>${icon} <b>${esc2(data.note||'')}</b></p>`;
  html+=`<p class="muted">Checks: ${data.passed}/${data.total_checks} passed</p>`;
  if(Array.isArray(data.checks)){for(const c of data.checks){html+=`<p style="margin:2px 0">${c.ok?'âś“':'âś—'} <b>${esc2(c.name)}</b>${c.detail?` â€” <small class="muted">${esc2(c.detail)}</small>`:''}</p>`;}}
  el.innerHTML=html;
}

function renderLocalWorkflow(data){
  const el=document.getElementById('localWorkflow');if(!el)return;
  if(!data||data.error){el.innerHTML=`<p class="muted">${esc2(data&&data.error||'No workflow run yet.')}</p>`;return;}
  const icon=data.ok?'âś…':'âš ď¸Ź';
  let html=`<p>${icon} Workflow completed at ${esc2(data.finished_at||'?')}</p>`;
  if(Array.isArray(data.steps))for(const s of data.steps){html+=`<p style="margin:2px 0">${s.ok?'âś“':'âś—'} <b>${esc2(s.step)}</b>${s.error?` â€” <em style="color:#8b0000">${esc2(s.error)}</em>`:''}</p>`;}
  if(Array.isArray(data.next_steps)){html+=`<ul>`;for(const n of data.next_steps)html+=`<li>${esc2(n)}</li>`;html+=`</ul>`;}
  el.innerHTML=html;
}


function renderPublishWizard(data){
  const el=document.getElementById('publishWizard');if(!el)return;
  if(!data||data.error){el.innerHTML=`<p class="muted">${esc2(data&&data.error||'No production dashboard data yet.')}</p>`;return;}
  if(data.version&&data.ok&&data.steps===undefined&&data.candidate_draft_id===undefined&&data.classifieds_maintainer===undefined&&data.trading_brain_v513===undefined){el.innerHTML=`<p class="badText"><b>Production dashboard data mapping mismatch.</b> Refresh response was not /api/publish-wizard/status. Update to 5.14.2 or reload with Ctrl+F5.</p><pre>${esc2(JSON.stringify(data,null,2).slice(0,1000))}</pre>`;return;}
  const maint=data.classifieds_maintainer||{};
  const autoSell=data.auto_sell_relister||{};
  const manualOwnedSell=data.manual_owned_sell_detector||{};
  const sellBooster=data.sell_booster||{};
  const tradingBrain=data.trading_brain_v513||{};
  const marketPricing=data.market_pricing_pipeline||tradingBrain.market_pricing_pipeline||{};
  const fallbackMetrics=data.fallback_metrics||tradingBrain.fallback_metrics||{};
  const liquidityFirst=data.liquidity_first||{};
  const staleSellGuard=data.stale_sell_listing_guard||{};
  const publishErrors=data.publish_error_inspector||{};
  const adaptiveFill=data.adaptive_fill_controller||{};
  const last=maint.last_result_summary||{};
  const stock=maint.stock_summary||{};
  const activeOverview=maint.active_listings_overview||{};
  const startupArchive=data.startup_listing_archive||{};
  const startupRebuild=data.startup_rebuild||{};
  const rebuildProgress=startupRebuild.progress||startupRebuild.fill_targets||{};
  const activeRows=Array.isArray(activeOverview.rows)?activeOverview.rows:[];
  const tradeGuard=data.trade_guard||{};
  const tradeGuardLast=tradeGuard.last_result||{};
  const tradeMachine=data.trade_offer_state_machine||{};
  const tradeCounts=tradeMachine.counts||{};
  const tradeStates=Array.isArray(tradeMachine.states)?tradeMachine.states:[];
  const verified=!!(data.publish_verification&&data.publish_verification.listed);
  const matches=(data.publish_verification&&Array.isArray(data.publish_verification.matches))?data.publish_verification.matches:[];
  const publishModeOk=!!(data.guarded_publish_enabled&&data.live_classifieds_writes_enabled&&data.backpack_tf_write_mode==='guarded');
  const op=(data.operation||data.active_operation||{});
  const opBusy=!!(op.active||op.activeOperation);
  const opType=op.activeOperationType||op.type||'';
  const opAge=Math.round(Number(op.activeOperationAgeMs||op.age_ms||0)/1000);
  const activeCount=Number(maint.active_total_listings||activeOverview.total||matches.length||(last.already_active||0)||0);
  const problems=(last.errors||0)+(last.archived_or_currency||0)+(last.duplicate_skipped||0);
  const autoCounters=(autoSell.last_result&&autoSell.last_result.counters)||{};
  const nextRun=maint.enabled?(maint.due_in_seconds===0?'now':(maint.due_in_seconds!=null?maint.due_in_seconds+'s':'â€”')):'disabled';
  let html=`<div class="productionHero ${publishModeOk?'okBox':'warnBox'}">`;
  html+=`<div><p class="eyebrow">Bot loop</p><h3>${publishModeOk?'Running guarded classifieds mode':'Publish mode not fully enabled'}</h3><p class="muted">${publishModeOk?'Maintainer can keep listings active while the sliders stay on.':'Enable guarded publish + live classifieds writes in add-on options, then restart.'}</p></div>`;
  html+=`<span class="bigStatusPill ${publishModeOk?'ok':'warn'}">${publishModeOk?'ON':'SETUP'}</span></div>`;
  if(opBusy){html+=`<div class="miniRow warnBox"><b>Running: ${esc2(opType||'operation')}</b><small>started ${esc2(op.activeOperationStartedAt||op.started_at||'')} Â· elapsed ${esc2(opAge)}s Â· stage ${esc2(op.last_stage||'running')} Â· buttons are locked to prevent overlapping Backpack.tf syncs.</small></div>`;}
  html+=`<div class="productionGrid">`;
  html+=`<div class="productionMetric"><span>Startup archive</span><strong>${startupArchive.startup_auto_will_run?'ON':'Manual'}</strong><small>${esc2(startupArchive.status||'not run')} Â· ${startupArchive.archived_all?'archived all active listings':'waiting'} Â· ${startupArchive.startup_auto_confirmed?'restart cleanup armed':'safe: no auto archive on restart'}</small></div>`;
  html+=`<div class="productionMetric ${startupRebuild.running?'warnBox':''}"><span>Startup rebuild</span><strong>${startupRebuild.running?'Running':(startupRebuild.fast_fill_active?'Fast fill':'Ready')}</strong><small>${esc2(startupRebuild.status||'not run')} Â· fill ${esc2(rebuildProgress.active_total||0)}/${esc2(rebuildProgress.cap||600)} Â· free ${esc2(rebuildProgress.free_slots||0)} Â· batch ${esc2(startupRebuild.fast_fill_active?startupRebuild.startup_batch_size:startupRebuild.normal_batch_size||3)}</small></div>`;
  html+=`<div class="productionMetric"><span>Maintainer</span><strong>${maint.enabled?'Enabled':'Paused'}</strong><small>next ${esc2(nextRun)} Â· interval ${esc2(maint.interval_minutes||'?')} min Â· max ${esc2(maint.max_publishes_per_cycle||20)}/cycle Â· fill ${esc2(maint.active_total_listings||0)}/${esc2(maint.backpack_tf_account_listing_cap||maint.max_total_active_listings||600)} Â· free ${esc2(maint.free_listing_slots||0)} Â· target buy ${esc2(maint.target_active_buy_listings||600)}</small><label class="dashSwitch"><input type="checkbox" id="prodMaintainerToggle" ${maint.enabled?'checked':''} ${!publishModeOk?'disabled':''}><span>${maint.enabled?'Auto maintain on':'Auto maintain paused'}</span></label></div>`;
  const peSummary=publishErrors.summary||{};const peTop=Array.isArray(peSummary.top_categories)?peSummary.top_categories:[];
  const peTopText=peTop.slice(0,3).map(x=>esc2(x.category)+': '+esc2(x.count)).join(' Â· ')||'none';
  html+=`<div class="productionMetric ${Number(peSummary.provider_errors||0)||Number(peSummary.rate_limited||0)?'warnBox':''}"><span>Publish errors</span><strong>${esc2(peSummary.last_cycle_errors||0)} last</strong><small>failed ${esc2(peSummary.failed_total||0)} Â· provider ${esc2(peSummary.provider_errors||0)} Â· rate ${esc2(peSummary.rate_limited||0)} Â· currency ${esc2(peSummary.not_enough_currency||0)} Â· ${peTopText}</small></div>`;
  html+=`<div class="productionMetric ${adaptiveFill.mode==='backoff_rate_limit'||adaptiveFill.mode==='slowdown_errors'?'warnBox':'okBox'}"><span>Adaptive fill</span><strong>${esc2(adaptiveFill.mode||'normal')}</strong><small>effective ${esc2(adaptiveFill.effective_max_publishes_per_cycle||maint.max_publishes_per_cycle||20)}/cycle Â· target ${esc2(adaptiveFill.target_per_cycle||20)} Â· ${esc2(adaptiveFill.reason||'')}</small></div>`;
  html+=`<div class="productionMetric"><span>Active listings</span><strong>${esc2(activeCount)}</strong><small>buy ${esc2(activeOverview.buy||maint.active_buy_listings||0)} Â· sell ${esc2(activeOverview.sell||maint.active_sell_listings||0)} Â· cap ${esc2(maint.backpack_tf_account_listing_cap||maint.max_total_active_listings||600)} Â· stock cap ${esc2(maint.stock_cap_per_item||1)}/item</small></div>`;
  const mostKeys=data.most_traded_and_keys||{};
  html+=`<div class="productionMetric"><span>Auto-list + keys</span><strong>${mostKeys.auto_list_anything_enabled?'â‰Ą '+esc2(mostKeys.auto_list_anything_min_ref||0.11)+' ref':'Boost only'}</strong><small>candidates ${esc2(mostKeys.auto_list_anything_candidates||0)} Â· queue ${esc2(mostKeys.auto_list_anything_queue_items||0)} Â· seeds ${esc2(mostKeys.scanner_most_traded_seed_count||0)}/${esc2(mostKeys.configured_seed_count||0)} Â· key pricing ${mostKeys.key_currency_enabled?'enforced':'off'} Â· key ref ${esc2(mostKeys.key_ref_estimate||'?')} Â· key drafts ${esc2(mostKeys.drafts_with_keys_currency||0)}</small></div>`;
  html+=`<div class="productionMetric"><span>Stock</span><strong>${esc2(stock.stock_count||0)}</strong><small>owned ${esc2(stock.owned_items||0)} Â· pending ${esc2(stock.pending_incoming||0)} Â· selling ${esc2(stock.active_sell_listings||0)} Â· drafts ${esc2(stock.sell_drafts||0)} Â· capped ${esc2(stock.capped_skus||0)}</small></div>`;
  html+=`<div class="productionMetric"><span>Auto-sell</span><strong>${esc2(autoSell.auto_sell_drafts||0)}</strong><small>bought ${esc2(autoSell.buy_fulfilled||0)} Â· detected ${esc2(autoCounters.detected||0)} Â· sell published ${esc2(autoCounters.published_sell_listings||0)}</small></div>`;
  const sellFirst=maint.sell_first_priority||{};
  if(sellFirst&&sellFirst.enabled){html+=`<div class="productionMetric ${Number(sellFirst.backlog||0)||Number(sellFirst.unlisted_owned_sellable_items||0)?'warnBox':'okBox'}"><span>Sell priority</span><strong>${Number(sellFirst.backlog||0)||Number(sellFirst.unlisted_owned_sellable_items||0)?'SELL FIRST':'clear'}</strong><small>sell backlog ${esc2(sellFirst.backlog||0)} Â· unlisted owned ${esc2(sellFirst.unlisted_owned_sellable_items||0)} Â· ${sellFirst.blocks_buy?'buy fill deferred':'buy fill allowed'}</small></div>`;}
  const mosLast=(manualOwnedSell.last_result&&manualOwnedSell.last_result.counters)||{};
  html+=`<div class="productionMetric ${Number(manualOwnedSell.unlisted_sellable_owned_items||0)?'warnBox':'okBox'}"><span>Manual inventory sell</span><strong>${esc2(manualOwnedSell.unlisted_sellable_owned_items||0)} waiting</strong><small>created ${esc2(mosLast.created_sell_drafts||0)} Â· published ${esc2(mosLast.published_sell_listings||0)} Â· skipped ${esc2(Object.values(manualOwnedSell.skipped||{}).reduce((a,b)=>a+Number(b||0),0))}</small></div>`;
  const tbSummary=tradingBrain.summary||{};
  html+=`<div class="productionMetric ${tradingBrain.health==='warning'?'warnBox':''}"><span>Trading Brain</span><strong>${tradingBrain.enabled?'5.13 ENFORCING':'Off'}</strong><small>buy ok ${esc2(tbSummary.buy_ok||0)} Â· fallback ok ${esc2(tbSummary.fallback_buy_allowed||0)} Â· active fallback ${esc2(tbSummary.fallback_active_buy_listings||0)} Â· blocked ${esc2(tbSummary.buy_blocked||0)} Â· sell ok ${esc2(tbSummary.sell_ok||0)} Â· held ${esc2(tbSummary.sell_held||0)}</small></div>`;
  const mpSummary=marketPricing.summary||{};
  html+=`<div class="productionMetric ${Number(mpSummary.weak_market||0)||Number(mpSummary.no_snapshot||0)?'warnBox':''}"><span>Market pricing</span><strong>${marketPricing.enabled?'Pipeline ON':'Off'}</strong><small>good ${esc2(mpSummary.good_data||0)} Â· weak ${esc2(mpSummary.weak_market||0)} Â· no snapshot ${esc2(mpSummary.no_snapshot||0)} Â· profitable ${esc2(mpSummary.profitable||0)} Â· mode ${esc2(marketPricing.mode||'balanced')}</small></div>`;
  const fmSummary=fallbackMetrics.summary||{};
  html+=`<div class="productionMetric ${Number(fmSummary.fallback_buy_allowed||0)?'okBox':'warnBox'}"><span>Fallback fill</span><strong>${esc2(fmSummary.fallback_active_buy_listings||0)} active</strong><small>allowed ${esc2(fmSummary.fallback_buy_allowed||0)} Â· candidates ${esc2(fmSummary.fallback_buy_candidates||0)} Â· no snapshot ${esc2(fmSummary.no_snapshot||0)} Â· last published ${esc2(fmSummary.last_cycle_published||0)} Â· boost approved ${esc2(fmSummary.last_cycle_fallback_boost_approved||0)} Â· currency skipped ${esc2(fmSummary.last_cycle_currency_skipped||0)}</small></div>`;
  const lfSummary=liquidityFirst.summary||{};
  html+=`<div class="productionMetric ${liquidityFirst.enabled?'okBox':'warnBox'}"><span>Liquidity-first</span><strong>${liquidityFirst.enabled?'BUY liquid':'Off'}</strong><small>liquid ${esc2(lfSummary.liquid_buy_candidates||0)} Â· skipped illiquid ${esc2(lfSummary.illiquid_skipped_candidates||0)} Â· min ${esc2(lfSummary.min_buyers||1)} buyers/${esc2(lfSummary.min_sellers||2)} sellers Â· sell owned â‰Ą ${esc2(lfSummary.owned_sell_min_ref||0.11)} ref ${lfSummary.owned_sell_anything_enabled?'ON':'OFF'}</small></div>`;
  html+=`<div class="productionMetric ${Number(staleSellGuard.stale_sell_listings||0)?'warnBox':'okBox'}"><span>Stale sell guard</span><strong>${esc2(staleSellGuard.stale_sell_listings||0)} stale</strong><small>active sell ${esc2(staleSellGuard.active_sell_listings||0)} Â· matched owned ${esc2(staleSellGuard.matched_owned_sell_listings||0)} Â· action ${esc2(staleSellGuard.stale_action||'warn_only')} Â· archived ${esc2(staleSellGuard.last_archive_result?.archived||0)}</small></div>`;
  const textSync=data.listing_text_sync||{};
  html+=`<div class="productionMetric ${textSync.enabled?'okBox':'warnBox'}"><span>Listing text</span><strong>${textSync.enabled?'Synced':'Off'}</strong><small>text uses final Backpack.tf currencies Â· publish ${textSync.force_rebuild_on_publish?'force sync':'preview'} Â· stale drafts ${textSync.sync_existing_drafts?'sync':'ignore'}</small></div>`;
  html+=`<div class="productionMetric ${Number(sellBooster.needs_reprice||0)?'warnBox':''}"><span>Sell booster</span><strong>${sellBooster.enabled?'ON':'Off'}</strong><small>sellable ${esc2(sellBooster.sellable_owned_items||0)} Â· active ok ${esc2(sellBooster.active_sell_ok||0)} Â· reprice ${esc2(sellBooster.needs_reprice||0)} Â· drafts ${esc2(sellBooster.sell_drafts||0)} Â· classifieds ${sellBooster.strict_classifieds_pricing_enabled?'strict':'fallback'} Â· undercut ${esc2(sellBooster.undercut_ref||0.11)} ref</small></div>`;
  const profitGuard=sellBooster.sell_profit_guard||{};
  html+=`<div class="productionMetric ${Number(profitGuard.held||0)?'warnBox':''}"><span>Profit guard</span><strong>${profitGuard.enabled?'ON':'Off'}</strong><small>min +${esc2(profitGuard.min_profit_ref||0.22)} ref / ${esc2(profitGuard.min_margin_percent||3)}% Â· guarded ${esc2(profitGuard.guarded||0)} Â· raised ${esc2(profitGuard.raised_to_floor||0)} Â· held ${esc2(profitGuard.held||0)}</small></div>`;
  html+=`<div class="productionMetric ${problems?'warnBox':''}"><span>Issues</span><strong>${esc2(problems)}</strong><small>duplicates ${esc2(last.duplicate_skipped||0)} Â· archived/currency ${esc2(last.archived_or_currency||0)} Â· stock skipped ${esc2(last.stock_cap_skipped||0)} Â· errors ${esc2(last.errors||0)}</small></div>`;
  html+=`<div class="productionMetric"><span>Trade guard</span><strong>${tradeGuard.enabled?'On':'Off'}</strong><small>declined ${esc2((tradeGuardLast.declined||[]).length||0)} Â· failed ${esc2((tradeGuardLast.failed||[]).length||0)} Â· overpay stays good</small></div>`;
  const counter=data.trade_counteroffers||tradeGuard.counteroffers||{};const counterLast=counter.last_result||{};const counterPreview=counter.preview||{};const counterPreviews=Array.isArray(counterPreview.previews)?counterPreview.previews:[];
  html+=`<div class="productionMetric"><span>Counteroffers</span><strong>${counter.enabled?'Guarded':'Off'}</strong><small>${counter.dry_run_validation_enabled?'dry-run':'live'} Â· live ${counter.live_sending_enabled?'on':'off'} Â· safe previews ${esc2(counterPreview.safe_to_send_count||0)} Â· drafts ${esc2((counterLast.drafts||[]).length||0)} Â· sent ${esc2((counterLast.sent||[]).length||0)} Â· failed ${esc2((counterLast.failed||[]).length||0)}</small></div>`;
  html+=`<div class="productionMetric"><span>Trade state</span><strong>${esc2(tradeCounts.waiting_manual_accept||0)}</strong><small>waiting accept Â· bad ${esc2(tradeCounts.declined_or_bad||0)} Â· sell active ${esc2(tradeCounts.sell_listing_active||0)}</small></div>`;
  html+=`</div>`;
  if(counterPreviews.length){html+=`<div class="miniRow ${counterPreview.safe_to_send_count?'warnBox':'softBox'}"><b>Counteroffer preview & safety</b><small>${esc2(counterPreview.headline||'Counteroffer previews available.')} Live sending: ${counter.live_sending_enabled?'enabled':'disabled'}${counter.live_sending_blocked_by_dry_run_validation?' Â· blocked by dry-run validation':''} Â· Steam auto-accept: never Â· Steam Guard confirmation: never.</small><div class="activeListingList">${counterPreviews.slice(0,5).map(p=>`<div class="activeListingRow"><b>Offer ${esc2(p.tradeofferid||'')}</b><small>original: our ${esc2(p.original_offer?.our_side_ref||0)} ref / their ${esc2(p.original_offer?.their_side_ref||0)} ref Â· missing ${esc2(p.original_offer?.shortfall_ref||0)} ref Â· corrected: our ${esc2(p.corrected_offer?.our_side_ref||0)} ref / their ${esc2(p.corrected_offer?.their_side_ref||0)} ref Â· profit ${esc2(p.corrected_offer?.expected_profit_ref||0)} ref Â· ${p.safe_to_send?'SAFE preview':'manual review'} Â· ${esc2(p.action||'')}</small>${(p.removed_items||[]).length?`<small>Would remove from our side: ${(p.removed_items||[]).slice(0,4).map(i=>esc2(i.item_name||i.assetid||'item')).join(', ')}</small>`:''}</div>`).join('')}</div></div>`;}
  if(tradeMachine.ok){const waiting=tradeStates.filter(s=>s.stage==='good_offer_waiting_manual_accept');const bad=tradeStates.filter(s=>/bad_offer|declined/.test(s.stage));const sell=tradeStates.filter(s=>String(s.stage||'').includes('sell_listing'));html+=`<div class="miniRow ${waiting.length?'warnBox':'softBox'}"><b>Trade offer state</b><small>${esc2(tradeMachine.next_action||'Watching buy â†’ offer â†’ manual accept â†’ inventory â†’ sell.')}</small>${waiting.length?`<div class="activeListingList">${waiting.slice(0,4).map(o=>`<div class="activeListingRow"><b>Offer ${esc2(o.tradeofferid||'')}</b><small>profit ${esc2(o.estimated_profit_ref||0)} ref Â· ${esc2((o.items_to_receive||[]).join(', ')||'incoming items')} Â· manual accept</small>${o.link?`<a class="buttonLink tiny" href="${esc2(o.link)}" target="_blank" rel="noopener">Open</a>`:''}</div>`).join('')}</div>`:''}${bad.length?`<small class="badText">Bad/declined offers: ${esc2(bad.length)}</small>`:''}</div>`;}
  if(verified||matches.length){html+=`<div class="miniRow okBox"><b>Verified active listing${matches.length>1?'s':''}</b><small>${esc2(data.publish_verification.message||'Listing verified on Backpack.tf account listings.')}</small>${matches.length?`<div class="activeListingList">${matches.slice(0,6).map(m=>`<div class="activeListingRow"><b>${esc2(m.item_name||m.name||m.id)}</b><small>${esc2(m.intent||'')} Â· ${esc2(m.metal||m.price_ref||'')} ref</small>${m.url?`<a class="buttonLink tiny" href="${esc2(m.url)}" target="_blank" rel="noopener">Open</a>`:''}</div>`).join('')}</div>`:''}</div>`;}
  if(mostKeys&&Array.isArray(mostKeys.rows)&&mostKeys.rows.length){html+=`<div class="miniRow softBox"><b>Auto-list / most-traded check</b><small>${mostKeys.auto_list_anything_enabled?'Auto-list-anything is ON: scanner can queue/list candidates above '+esc2(mostKeys.auto_list_anything_min_ref||0.11)+' ref.':'Shows whether high-volume seed items reached scanner/queue/drafts.'} Key+metal currencies are enforced on publish when a buy price can be represented in keys.</small><div class="activeListingList">${mostKeys.rows.slice(0,8).map(row=>`<div class="activeListingRow"><b>${esc2(row.item_name)}</b><small>scanner ${row.in_scanner?'yes':'no'} Â· queue ${row.in_queue?'yes':'no'} Â· draft ${row.has_draft?'yes':'no'} Â· ${row.key_currency_candidate?'key currency':'metal only'} Â· ${esc2(row.max_buy_ref||0)} ref</small></div>`).join('')}</div></div>`;}
  if(sellBooster&&Array.isArray(sellBooster.needs_reprice_samples)&&sellBooster.needs_reprice_samples.length){html+=`<div class="miniRow warnBox"><b>Sell booster: listings needing reprice</b><small>Existing sell listings with stale price or bad public text will be republished by Auto-sell/Maintain now.</small><div class="activeListingList">${sellBooster.needs_reprice_samples.slice(0,8).map(row=>`<div class="activeListingRow"><b>${esc2(row.item_name)}</b><small>current ${esc2(row.listing_price_ref||'?')} ref Â· desired ${esc2(row.desired_sell_ref||'?')} ref Â· value ${esc2(row.value_ref||'?')} ref</small>${row.listing_url?`<a class="buttonLink tiny" href="${esc2(row.listing_url)}" target="_blank" rel="noopener">Open</a>`:''}</div>`).join('')}</div></div>`;}
  if(sellBooster&&sellBooster.sell_profit_guard&&Array.isArray(sellBooster.sell_profit_guard.samples)&&sellBooster.sell_profit_guard.samples.length){const pg=sellBooster.sell_profit_guard;html+=`<div class="miniRow ${Number(pg.held||0)?'warnBox':'softBox'}"><b>Profit guard samples</b><small>Sell listings are checked against buy cost before publish. If classifieds are too low, the price is raised to the profit floor or held by config.</small><div class="activeListingList">${pg.samples.slice(0,6).map(row=>`<div class="activeListingRow"><b>${esc2(row.item_name)}</b><small>sell ${esc2(row.sell_ref||'?')} ref Â· bought ${esc2(row.bought_for_ref||'?')} ref Â· expected profit ${esc2(row.expected_profit_ref??'?')} ref Â· ${row.guard&&row.guard.reason?esc2(row.guard.reason):'no cost basis/unknown'}</small></div>`).join('')}</div></div>`;}
  if(tradingBrain&&tradingBrain.ok){const tb=tradingBrain;const sm=tb.samples||{};const issueText=Array.isArray(tb.issues)?tb.issues.map(i=>`${i.id}${i.count?': '+i.count:''}`).join(' Â· '):'';html+=`<div class="miniRow ${tb.health==='warning'?'warnBox':'okBox'}"><b>Trading Brain 5.13 enforcement</b><small>${esc2(tb.rules?.currency_policy||'central rules active')} Â· mode ${esc2(tb.rules?.enforcement_mode||'balanced')} Â· publish ${tb.rules?.enforce_on_publish?'enforced':'preview'} Â· maintainer ${tb.rules?.enforce_on_maintainer?'enforced':'preview'} Â· archive ${esc2(tb.rules?.archive_all_mode||'manual_only')} Â· stock ${esc2(tb.rules?.stock_match_mode||'sku')} Â· counter ${esc2(tb.rules?.counteroffer_mode||'dry_run')}${issueText?' Â· issues '+esc2(issueText):''}</small>${Array.isArray(sm.buy_blocked)&&sm.buy_blocked.length?`<div class="activeListingList">${sm.buy_blocked.slice(0,6).map(row=>`<div class="activeListingRow"><b>${esc2(row.item_name)}</b><small>buy ${esc2(row.buy_ref||'?')} ref Â· target sell ${esc2(row.target_sell_ref||'?')} ref Â· profit ${esc2(row.expected_profit_ref??'?')} ref Â· ${esc2((row.reasons||[]).join(', ')||row.decision)}</small></div>`).join('')}</div>`:''}${sm.suppressed_buy_blocked?`<small>Hidden impossible/unaffordable blocked buy samples: ${esc2(sm.suppressed_buy_blocked)}.</small>`:""}</div>`;}
  if(marketPricing&&marketPricing.ok){const mps=Array.isArray(marketPricing.samples)?marketPricing.samples:[];html+=`<div class="miniRow ${marketPricing.mode==='strict'?'warnBox':'softBox'}"><b>Real market pricing pipeline</b><small>Buy = highest buyer + ${esc2(marketPricing.rules?.buy_bonus_ref??0.11)} ref Â· Sell = lowest seller - ${esc2(marketPricing.rules?.sell_undercut_ref??0.11)} ref Â· strict ${marketPricing.mode==='strict'?'on':'off'} Â· no snapshot ${esc2(marketPricing.summary?.no_snapshot||0)}${marketPricing.suppressed_samples?` Â· hidden corrupt ${esc2(marketPricing.suppressed_samples)}`:""}</small>${mps.length?`<div class="activeListingList">${mps.slice(0,6).map(row=>`<div class="activeListingRow"><b>${esc2(row.item_name)}</b><small>${esc2(row.intent)} Â· high buy ${esc2(row.highest_buy_ref??'?')} Â· low sell ${esc2(row.lowest_sell_ref??'?')} Â· suggested buy ${esc2(row.suggested_buy_ref??'?')} Â· suggested sell ${esc2(row.suggested_sell_ref??'?')} Â· profit ${esc2(row.expected_profit_ref??'?')} Â· ${esc2(row.confidence||'unknown')}</small></div>`).join('')}</div>`:''}</div>`;}
  if(liquidityFirst&&liquidityFirst.samples&&((liquidityFirst.samples.liquid||[]).length||(liquidityFirst.samples.skipped||[]).length)){html+=`<div class="miniRow softBox"><b>Liquidity-first samples</b><small>Buy listings prefer active markets. Owned inventory sells can still be listed above min ref.</small>${(liquidityFirst.samples.liquid||[]).length?`<div class="activeListingList">${(liquidityFirst.samples.liquid||[]).slice(0,6).map(row=>`<div class="activeListingRow"><b>${esc2(row.item_name)}</b><small>buy ${esc2(row.buy_ref||0)} ref Â· sell ${esc2(row.sell_ref||0)} ref Â· buyers ${esc2(row.buyers||0)} Â· sellers ${esc2(row.sellers||0)} Â· spread ${esc2(row.spread_ref||0)} ref</small></div>`).join('')}</div>`:''}</div>`;}
  if(fallbackMetrics&&fallbackMetrics.samples&&(fallbackMetrics.samples.fallback_allowed||[]).length){html+=`<div class="miniRow softBox"><b>Fallback metrics samples</b><small>No-snapshot fallback allowed ${esc2((fallbackMetrics.summary||{}).fallback_buy_allowed||0)}; active fallback ${esc2((fallbackMetrics.summary||{}).fallback_active_buy_listings||0)}.</small><div class="activeListingList">${(fallbackMetrics.samples.fallback_allowed||[]).slice(0,8).map(row=>`<div class="activeListingRow"><b>${esc2(row.item_name||row.draft_id)}</b><small>buy ${esc2(row.buy_ref||0)} ref Â· target sell ${esc2(row.target_sell_ref||0)} ref Â· ${esc2(row.reason||'fallback')}</small></div>`).join('')}</div></div>`;}
  if(staleSellGuard&&staleSellGuard.samples&&(staleSellGuard.samples.stale||[]).length){html+=`<div class="miniRow warnBox"><b>Stale sell listing guard</b><small>${esc2(staleSellGuard.message||'Some sell listings do not match inventory.')}</small><div class="activeListingList">${(staleSellGuard.samples.stale||[]).slice(0,8).map(row=>`<div class="activeListingRow"><b>${esc2(row.item_name||row.id)}</b><small>${esc2(row.price_text||row.price_ref||'')} Â· owned asset missing Â· ${esc2(row.action||'flag')}</small>${row.url?`<a class="buttonLink tiny" href="${esc2(row.url)}" target="_blank" rel="noopener">Open</a>`:''}</div>`).join('')}</div></div>`;}

  if(publishErrors&&Array.isArray(publishErrors.samples)&&publishErrors.samples.length){html+=`<div class="miniRow ${Number((publishErrors.summary||{}).provider_errors||0)||Number((publishErrors.summary||{}).rate_limited||0)?'warnBox':'softBox'}"><b>Publish error inspector samples</b><small>${esc2(publishErrors.guidance||'Recent publish failures categorized.')} Adaptive fill mode: ${esc2(adaptiveFill.mode||'normal')}.</small><div class="activeListingList">${publishErrors.samples.slice(0,8).map(x=>`<div class="activeListingRow"><b>${esc2(x.item_name||x.draft_id||x.category)}</b><small>${esc2(x.category)} Â· ${esc2(x.code||'')} Â· ${esc2(String(x.message||'').slice(0,160))}</small></div>`).join('')}</div></div>`;}
  if(manualOwnedSell&&Array.isArray(manualOwnedSell.samples)&&manualOwnedSell.samples.length){html+=`<div class="miniRow warnBox"><b>Manual inventory sell detector</b><small>These owned tradable items are in inventory but do not have a sell listing/draft yet. Auto-sell now or maintainer can list them.</small><div class="activeListingList">${manualOwnedSell.samples.slice(0,8).map(row=>`<div class="activeListingRow"><b>${esc2(row.item_name)}</b><small>${esc2(row.value_ref||0)} ref Â· asset ${esc2(row.assetid||'')}</small></div>`).join('')}</div></div>`;}
  if(activeRows.length){html+=`<div class="miniRow softBox"><b>Active listings with stock</b><small>${esc2(activeOverview.total||activeRows.length)} active listings: buy ${esc2(activeOverview.buy||0)}, sell ${esc2(activeOverview.sell||0)}. Effective stock is shown per listing; active sell listings are not double-counted as extra stock.</small><div class="activeListingList">${activeRows.slice(0,24).map(row=>`<div class="activeListingRow"><b>${esc2(row.item_name||row.id)}</b><small>${esc2(row.intent||'')} Â· ${esc2(row.price_text||((row.metal||'')+' ref'))} Â· effective stock ${esc2(row.stock_count||0)}/${esc2(row.stock_cap||maint.stock_cap_per_item||1)} Â· owned ${esc2(row.owned||0)} Â· pending ${esc2(row.pending_incoming||0)} Â· sell listing ${esc2(row.active_sell||0)} Â· sell draft ${esc2(row.sell_draft||0)} Â· buy listings ${esc2(row.active_buy||0)}${row.stock_capped?' Â· capped':''}</small>${row.url?`<a class="buttonLink tiny" href="${esc2(row.url)}" target="_blank" rel="noopener">Open</a>`:''}</div>`).join('')}</div>${activeRows.length>24?`<small class="muted">Showing first 24. Total ${esc2(activeRows.length)} active listing rows.</small>`:''}</div>`;}
  if(stock&&Array.isArray(stock.samples)&&stock.samples.length){html+=`<div class="miniRow softBox"><b>Stock overview</b><small>${esc2(stock.stock_count||0)} effective-stock tracked SKU(s): owned ${esc2(stock.owned_items||0)}, pending ${esc2(stock.pending_incoming||0)}, selling ${esc2(stock.active_sell_listings||0)}, sell drafts ${esc2(stock.sell_drafts||0)}.</small><div class="activeListingList">${stock.samples.slice(0,6).map(row=>`<div class="activeListingRow"><b>${esc2(row.item_name||row.key)}</b><small>effective stock ${esc2(row.stock_count||0)}/${esc2(row.stock_cap||maint.stock_cap_per_item||1)} Â· owned ${esc2(row.owned||0)} Â· pending ${esc2(row.pending_incoming||0)} Â· sell listing ${esc2(row.active_sell||0)} Â· sell draft ${esc2(row.sell_draft||0)} Â· buy listings ${esc2(row.active_buy||0)}</small></div>`).join('')}</div></div>`;}
  if(startupRebuild&&startupRebuild.last_result){const skip=startupRebuild.skipped_summary||{};html+=`<div class="miniRow softBox"><b>Startup rebuild controller</b><small>Status ${esc2(startupRebuild.status||'')} Â· phase ${esc2(startupRebuild.phase||'')} Â· fast fill ${startupRebuild.fast_fill_active?`active ${esc2(startupRebuild.fast_fill_remaining_seconds||0)}s`:'off'} Â· skipped active ${esc2(skip.already_active||0)} Â· stock cap ${esc2(skip.stock_cap||0)} Â· duplicates ${esc2(skip.duplicates||0)} Â· errors ${esc2(skip.errors||0)}</small></div>`;}
  if(data.market_classifieds_mirror&&data.market_classifieds_mirror.ok){html+=`<div class="miniRow softBox"><b>Market text source</b><small>${esc2(data.market_classifieds_mirror.rows_seen||0)} classifieds seen. Public text is cleaned; debug notes are not published.</small></div>`;}
  if(data.currency_guard&&!data.currency_guard.skipped&&!data.currency_guard.enough_currency){const cg=data.currency_guard;const cls=cg.severity==='ok'?'okBox':(cg.can_prepare_key_to_metal_listing?'softBox':'warnBox');html+=`<div class="miniRow ${cls}"><b>${esc2(cg.card_title||'Currency helper')}</b><small>${esc2(cg.message||'Currency is limited for this buy listing.')} ${cg.operator_hint?esc2(cg.operator_hint):''}</small><small>needed ${esc2(cg.needed_text||'?')} Â· available ${esc2(cg.available_text||'?')} Â· missing ${esc2(cg.deficit_text||'?')} Â· policy ${esc2(cg.buy_publish_policy||'')}</small></div>`;}
  html+=`<div id="publishWizardInlineStatus" class="miniRow"><b>Current action</b><small>${verified?'Listing is verified. Maintainer will keep checking it while the dashboard slider is ON.':(publishModeOk?'Maintainer is ready. Use Maintain now for an immediate cycle, or use the dashboard slider to pause/resume automatic maintaining.':'Enable options and restart, then refresh.')}</small></div>`;
  html+=`<div class="buttonRow productionActions"><button id="wizardRunMaintainerNow" class="primary" ${opBusy?'disabled title="Operation already running"':''}>Maintain now</button><button id="runStartupArchiveNow">Archive all listings</button><button id="runStartupRebuildNow">Startup rebuild</button><button id="wizardRunAutoSellNow">Auto-sell now</button><button id="prodRunLocalWorkflow" ${opBusy?'disabled title="Operation already running"':''}>Run workflow</button><button id="refreshPublishWizard">Refresh</button></div>`;
  html+=`<details class="softDetails productionDebugDetails"><summary>Advanced publish tools</summary>`;
  html+=`<p class="muted">Manual test tools are kept here for troubleshooting only. Normal operation uses the maintainer.</p>`;
  html+=`<div class="buttonRow wizardMainActions"><button id="prepareOnePublishDraft">Prepare draft</button><button id="wizardTestPublishPayload" data-id="${esc2(data.candidate_draft_id||'')}">Test payload</button><button id="wizardSyncTf2Schema">Sync TF2 schema</button><button id="wizardSyncMarketClassifieds" data-id="${esc2(data.candidate_draft_id||'')}" ${!data.candidate_draft_id?'disabled':''}>Copy market style</button><button id="wizardPrepareKeyToMetal">Auto keyâ†’metal</button><button id="wizardDuplicateGuard" data-id="${esc2(data.candidate_draft_id||'')}" ${!data.candidate_draft_id?'disabled':''}>Duplicate check</button><button id="wizardPublishGuarded" class="dangerSoft" data-id="${esc2(data.candidate_draft_id||'')}" ${(!data.candidate_draft_id||!data.ready_to_publish_guarded||(data.duplicate_guard&&data.duplicate_guard.blocked))?'disabled':''}>Publish one listing</button><button id="wizardVerifyListing" data-id="${esc2(data.candidate_draft_id||'')}" ${!data.candidate_draft_id?'disabled':''}>Verify listing</button></div>`;
  html+=`${data.publish_disabled_reason?`<p class="muted"><b>Manual publish state:</b> ${esc2(data.publish_disabled_reason)}</p>`:''}`;
  html+=`${data.duplicate_guard?`<h4>Duplicate guard</h4><pre>${esc2(JSON.stringify(data.duplicate_guard,null,2))}</pre>`:''}${data.payload_test?`<h4>Last payload test</h4><pre>${esc2(JSON.stringify(data.payload_test,null,2))}</pre>`:''}`;
  html+=`</details>`;
  el.innerHTML=html;
}
function setPublishWizardStatus(message,value){
  const el=document.getElementById('publishWizardInlineStatus');
  if(el)el.innerHTML=`<b>Current action</b><small>${esc2(message||'')}</small>${value?`<pre style="margin-top:6px;white-space:pre-wrap">${esc2(typeof value==='string'?value:JSON.stringify(value,null,2))}</pre>`:''}`;
}
function renderOpportunities(data){
  const el=document.getElementById('opportunitiesFinal');if(!el)return;
  if(!data||data.error){el.innerHTML=`<p class="muted">${esc2(data&&data.error||'No opportunities yet.')}</p>`;return;}
  const ops=Array.isArray(data.opportunities)?data.opportunities:[];
  let html=`<p class="muted">${ops.length} scored opportunities Â· top expected profit ${esc2(data.summary&&data.summary.top_expected_profit_ref||0)} ref</p>`;
  html+=ops.slice(0,10).map(o=>`<div class="miniRow"><b>${esc2(o.item_name||o.name||o.id)}</b><small>score ${esc2(o.total_score||0)} Â· profit ${esc2(o.expected_profit_ref||0)} ref Â· risk ${esc2(o.risk_score||0)} Â· ${esc2(o.local_status||'')}</small><p class="muted">${esc2(o.explanation||o.why_selected||'')}</p></div>`).join('')||'<p class="muted">Run Local Workflow to score opportunities.</p>';
  el.innerHTML=html;
}

// Planning Queue event handler
document.addEventListener('click',async e=>{
  if(e.target.closest('#rebuildPlanningQueue')){
    try{const d=await api('/api/planning-queue/rebuild',{method:'POST',body:'{}'});renderPlanningQueue(d);setLog(d);}catch(err){setLog(err.body||err.message);}
    return;}
  if(e.target.closest('#bulkApproveTop3')){
    try{const d=await api('/api/planning-queue/bulk-approve-top',{method:'POST',body:'{"n":3}'});setLog(d);const q=await api('/api/planning-queue');renderPlanningQueue(q);}catch(err){setLog(err.body||err.message);}
    return;}
  const pqApprove=e.target.closest('.pqApprove');
  if(pqApprove){try{const d=await api(`/api/planning-queue/item/${encodeURIComponent(pqApprove.dataset.id)}/status`,{method:'POST',body:'{"status":"approved_local"}'});setLog(d);const q=await api('/api/planning-queue');renderPlanningQueue(q);}catch(err){setLog(err.body||err.message);}return;}
  const pqCancel=e.target.closest('.pqCancel');
  if(pqCancel){try{const d=await api(`/api/planning-queue/item/${encodeURIComponent(pqCancel.dataset.id)}/status`,{method:'POST',body:'{"status":"cancelled"}'});setLog(d);const q=await api('/api/planning-queue');renderPlanningQueue(q);}catch(err){setLog(err.body||err.message);}return;}
  if(e.target.closest('#buildHubDrafts')){
    try{const d=await api('/api/hub-listing-drafts/build-from-approved',{method:'POST',body:'{}'});renderHubListingDrafts(d);setLog(d);}catch(err){setLog(err.body||err.message);}
    return;}
  const da=e.target.closest('.hubDraftApprove');
  if(da){try{const d=await api(`/api/hub-listing-drafts/${encodeURIComponent(da.dataset.id)}/approve-local`,{method:'POST',body:'{}'});setLog(d);const drafts=await api('/api/hub-listing-drafts');renderHubListingDrafts(drafts);}catch(err){setLog(err.body||err.message);}return;}
  const dc=e.target.closest('.hubDraftCancel');
  if(dc){try{const d=await api(`/api/hub-listing-drafts/${encodeURIComponent(dc.dataset.id)}/cancel`,{method:'POST',body:'{}'});setLog(d);const drafts=await api('/api/hub-listing-drafts');renderHubListingDrafts(drafts);}catch(err){setLog(err.body||err.message);}return;}
  const cp=e.target.closest('.hubDraftCopyPayload');
  if(cp){
    try{
      const decoded = decodeURIComponent(cp.dataset.payload);
      const parsed = JSON.parse(decoded);
      await navigator.clipboard.writeText(JSON.stringify(parsed, null, 2));
      setLog({ok:true,msg:'Payload copied to clipboard'});
    }catch(innerErr){
      setLog({ok:false,error:'Failed to copy payload: '+innerErr.message});
    }
    return;}
  const testPub=e.target.closest('.hubDraftTestPublish');
  if(testPub){
    try{const d=await api(`/api/hub-listing-drafts/${encodeURIComponent(testPub.dataset.id)}/test-publish-payload`,{method:'POST',body:'{}'});setLog(d);}catch(err){setLog(err.body||err.message);}
    return;}
  const dg=e.target.closest('.hubDraftDuplicateGuard');
  if(dg){try{const d=await api(`/api/hub-listing-drafts/${encodeURIComponent(dg.dataset.id)}/duplicate-guard`);setLog(d);}catch(err){setLog(err.body||err.message);}return;}
  const pub=e.target.closest('.hubDraftPublish');
  if(pub){
    if(!confirm('This will publish this approved listing to Backpack.tf.\n\nIt will NOT accept Steam trades, send offers, or confirm Steam actions.\n\nProceed?'))return;
    try{const d=await api(`/api/hub-listing-drafts/${encodeURIComponent(pub.dataset.id)}/publish-guarded`,{method:'POST',body:'{"confirm":true}'});setLog(d);const drafts=await api('/api/hub-listing-drafts');renderHubListingDrafts(drafts);api('/api/publish-wizard/status').then(renderPublishWizard).catch(()=>{});}catch(err){setLog(err.body||err.message);}
    return;}
  if(e.target.closest('#runLocalWorkflow')||e.target.closest('#prodRunLocalWorkflow')||e.target.closest('#prodRunLocalWorkflowTop')){
    try{setLog({info:'Running local workflowâ€¦'});const d=await api('/api/workflow/run-local',{method:'POST',body:'{}'});if(d&&d.busy){setPublishWizardStatus('Another operation is already running. Workflow was not started.',d);setLog(d);scheduleLiveDashboardRefresh(500);return;}renderLocalWorkflow(d);const q=await api('/api/planning-queue');renderPlanningQueue(q);const drafts=await api('/api/hub-listing-drafts');renderHubListingDrafts(drafts);setLog(d);await refresh();scheduleLiveDashboardRefresh(500);}catch(err){setLog(err.body||err.message);}
    return;}
  if(e.target.closest('#toggleSimpleUi')){try{document.body.classList.toggle('simple-ui');localStorage.setItem('tf2_hub_ui_mode',document.body.classList.contains('simple-ui')?'simple':'advanced');updateSimpleUiButton();}catch{}return;}
  if(e.target.closest('#refreshPublishWizard')||e.target.closest('#refreshPublishWizardTop')){try{const d=await api('/api/publish-wizard/status');renderPublishWizard(d);setLog(d);}catch(err){setLog(err.body||err.message);}return;}
  const maintToggle=e.target.closest('#prodMaintainerToggle');
  if(maintToggle){try{const enabled=!!maintToggle.checked;setPublishWizardStatus(enabled?'Resuming persistent maintainerâ€¦':'Pausing persistent maintainerâ€¦');const d=await api('/api/classifieds-maintainer/toggle',{method:'POST',body:JSON.stringify({enabled})});setLog(d);const wizard=await api('/api/publish-wizard/status');renderPublishWizard(wizard);setPublishWizardStatus(enabled?'Maintainer auto-loop is ON.':'Maintainer auto-loop is PAUSED. Existing Backpack.tf listings stay online until you archive them.');scheduleLiveDashboardRefresh(500);}catch(err){setPublishWizardStatus('Maintainer toggle failed.',err.body||err.message);setLog(err.body||err.message);}return;}
  if(e.target.closest('#runStartupArchiveNow')){try{setPublishWizardStatus('Archiving all active Backpack.tf listings nowâ€¦');const d=await api('/api/classifieds-startup-archive/run',{method:'POST',body:'{}'});setLog(d);setPublishWizardStatus(d.ok?'All active listings were archived/hidden. Maintainer can refill cleanly.':'Startup archive returned a warning/error.',d);const wizard=await api('/api/publish-wizard/status');renderPublishWizard(wizard);scheduleLiveDashboardRefresh(500);}catch(err){setPublishWizardStatus('Archive all listings failed.',err.body||err.message);setLog(err.body||err.message);}return;}
  if(e.target.closest('#runStartupRebuildNow')){try{setPublishWizardStatus('Running startup rebuild: sync listings â†’ sync inventory â†’ scanner â†’ planning queue â†’ fast fillâ€¦');const d=await api('/api/startup-rebuild/run',{method:'POST',body:'{}'});setLog(d);setPublishWizardStatus(d.ok?'Startup rebuild finished. Listings are being safely refilled toward the cap.':'Startup rebuild returned a warning/error.',d);const wizard=await api('/api/publish-wizard/status');renderPublishWizard(wizard);scheduleLiveDashboardRefresh(500);}catch(err){setPublishWizardStatus('Startup rebuild failed.',err.body||err.message);setLog(err.body||err.message);}return;}
  if(e.target.closest('#wizardRunMaintainerNow')||e.target.closest('#prodRunMaintainerNowTop')){try{setPublishWizardStatus('Starting persistent classifieds maintainer in the backgroundâ€¦ Dashboard will keep updating.');const d=await api('/api/classifieds-maintainer/run',{method:'POST',body:'{}'});setLog(d);setPublishWizardStatus(d.busy?'Another operation is already running. Maintainer was not started.':(d.accepted_async?'Maintainer accepted. It is running in the background; watch live status for published/skipped/errors.':(d.already_running?'Maintainer is already running.':'Maintainer request returned.')),d);const wizard=await api('/api/publish-wizard/status');renderPublishWizard(wizard);const drafts=await api('/api/hub-listing-drafts');renderHubListingDrafts(drafts);scheduleLiveDashboardRefresh(1000);}catch(err){const body=err.body||err.message||err;const text=typeof body==='string'?body:JSON.stringify(body);const friendly=/502|Bad Gateway/i.test(text)?'Maintainer request hit Home Assistant ingress timeout/502. The dashboard is still alive; wait for the next auto-refresh or press Refresh.': 'Maintainer run failed.';setPublishWizardStatus(friendly,body);setLog(body);}return;}
  if(e.target.closest('#wizardRunAutoSellNow')){try{setPublishWizardStatus('Running bought-item auto-sell relisterâ€¦ syncing inventory and checking fulfilled buy listings.');const d=await api('/api/auto-sell-relister/run',{method:'POST',body:'{}'});setLog(d);setPublishWizardStatus(d.ok?'Auto-sell relister finished. If a bought item was detected, a sell draft/listing was created.':'Auto-sell relister returned a warning/error.',d);const wizard=await api('/api/publish-wizard/status');renderPublishWizard(wizard);const drafts=await api('/api/hub-listing-drafts');renderHubListingDrafts(drafts);scheduleLiveDashboardRefresh(500);}catch(err){setPublishWizardStatus('Auto-sell relister failed.',err.body||err.message);setLog(err.body||err.message);}return;}
  if(e.target.closest('#wizardSyncTf2Schema')){try{setPublishWizardStatus('Syncing paginated TF2 item schemaâ€¦ This may take a little while.');const d=await api('/api/publish-wizard/sync-tf2-schema',{method:'POST',body:'{}'});setLog(d);setPublishWizardStatus(d.ok?`TF2 schema synced: ${d.items_count||0} items across ${d.pages||0} page(s). Now click Test payload again.`:'TF2 schema sync returned an error.',d);const wizard=await api('/api/publish-wizard/status');renderPublishWizard(wizard);setPublishWizardStatus(d.ok?`TF2 schema synced: ${d.items_count||0} items across ${d.pages||0} page(s). Now click Test payload again.`:'TF2 schema sync returned an error.',d);}catch(err){setPublishWizardStatus('TF2 schema sync failed.',err.body||err.message);setLog(err.body||err.message);}return;}
  if(e.target.closest('#wizardSyncMarketClassifieds')){try{setPublishWizardStatus('Reading Backpack.tf market classifieds and applying competitive/flashy textâ€¦');const d=await api('/api/publish-wizard/sync-market-classifieds',{method:'POST',body:'{}'});setLog(d);setPublishWizardStatus(d.ok?'Market style copied into the draft. Test payload next.':'Market classifieds sync returned a warning/error.',d);const wizard=await api('/api/publish-wizard/status');renderPublishWizard(wizard);setPublishWizardStatus(d.ok?'Market style copied into the draft. Test payload next.':'Market classifieds sync returned a warning/error.',d);const drafts=await api('/api/hub-listing-drafts');renderHubListingDrafts(drafts);}catch(err){setPublishWizardStatus('Market classifieds sync failed.',err.body||err.message);setLog(err.body||err.message);}return;}
  if(e.target.closest('#wizardPrepareKeyToMetal')){try{setPublishWizardStatus('Preparing keyâ†’metal listing draftâ€¦');const d=await api('/api/publish-wizard/prepare-key-to-metal',{method:'POST',body:'{}'});setLog(d);setPublishWizardStatus(d.ok?'Keyâ†’metal draft prepared. The wizard can publish it automatically when the buy listing lacks refined metal.':'Could not prepare keyâ†’metal draft.',d);const wizard=await api('/api/publish-wizard/status');renderPublishWizard(wizard);const drafts=await api('/api/hub-listing-drafts');renderHubListingDrafts(drafts);scheduleLiveDashboardRefresh(500);}catch(err){setPublishWizardStatus('Auto keyâ†’metal failed.',err.body||err.message);setLog(err.body||err.message);}return;}
  const wizTest=e.target.closest('#wizardTestPublishPayload');
  if(wizTest){try{setPublishWizardStatus('Testing payload locallyâ€¦ No Backpack.tf request will be sent.');let draftId=wizTest.dataset.id||'';if(!draftId){setPublishWizardStatus('No draft selected yet. Preparing one approved local draft firstâ€¦');const prepared=await api('/api/publish-wizard/prepare-one',{method:'POST',body:'{}'});renderPublishWizard(prepared);draftId=prepared.candidate_draft_id||'';if(!draftId){setPublishWizardStatus('Could not prepare a draft for payload test.',prepared);setLog(prepared);return;}}const test=await api(`/api/hub-listing-drafts/${encodeURIComponent(draftId)}/test-publish-payload`,{method:'POST',body:'{}'});setLog(test);setPublishWizardStatus(test.ok?'Payload test finished successfully. Nothing was sent to Backpack.tf.':'Payload test returned a warning/error.',test);const wizard=await api('/api/publish-wizard/status');renderPublishWizard(wizard);setPublishWizardStatus(test.ok?'Payload test finished successfully. Nothing was sent to Backpack.tf.':'Payload test returned a warning/error.',test);const drafts=await api('/api/hub-listing-drafts');renderHubListingDrafts(drafts);}catch(err){setPublishWizardStatus('Payload test failed.',err.body||err.message);setLog(err.body||err.message);}return;}
  const wizDup=e.target.closest('#wizardDuplicateGuard');
  if(wizDup){try{setPublishWizardStatus('Checking duplicate guardâ€¦');const d=await api(`/api/hub-listing-drafts/${encodeURIComponent(wizDup.dataset.id)}/duplicate-guard`);setLog(d);setPublishWizardStatus(d.ok?'Duplicate guard finished.':'Duplicate guard returned a warning/error.',d);const wizard=await api('/api/publish-wizard/status');renderPublishWizard(wizard);setPublishWizardStatus(d.ok?'Duplicate guard finished.':'Duplicate guard returned a warning/error.',d);}catch(err){setPublishWizardStatus('Duplicate guard failed.',err.body||err.message);setLog(err.body||err.message);}return;}
  const wizPublish=e.target.closest('#wizardPublishGuarded');
  if(wizPublish){
    if(!confirm('This will publish ONE approved listing to Backpack.tf.\n\nIt will NOT accept Steam trades, send offers, or confirm Steam actions.\n\nProceed?'))return;
    try{setPublishWizardStatus('Publishing one approved listing to Backpack.tfâ€¦');const d=await api(`/api/hub-listing-drafts/${encodeURIComponent(wizPublish.dataset.id)}/publish-guarded`,{method:'POST',body:'{"confirm":true}'});setLog(d);setPublishWizardStatus(d.ok?'Publish request finished. Verifying account listings nowâ€¦':'Publish request returned an error. See details.',d);const v=await api(`/api/hub-listing-drafts/${encodeURIComponent(wizPublish.dataset.id)}/verify-published`,{method:'POST',body:'{}'});setLog({publish:d,verification:v});const wizard=await api('/api/publish-wizard/status');renderPublishWizard(wizard);setPublishWizardStatus(v.listed?'Listing verified on Backpack.tf account listings.':'Publish attempted, but listing was not found after sync.',{publish:d,verification:v});const drafts=await api('/api/hub-listing-drafts');renderHubListingDrafts(drafts);scheduleLiveDashboardRefresh(500);}catch(err){setPublishWizardStatus('Publish failed.',err.body||err.message);setLog(err.body||err.message);}return;}
  const wizVerify=e.target.closest('#wizardVerifyListing');
  if(wizVerify){try{setPublishWizardStatus('Syncing Backpack.tf listings and checking candidateâ€¦');const v=await api(`/api/hub-listing-drafts/${encodeURIComponent(wizVerify.dataset.id)}/verify-published`,{method:'POST',body:'{}'});setLog(v);const wizard=await api('/api/publish-wizard/status');renderPublishWizard(wizard);setPublishWizardStatus(v.listed?'Listing verified on Backpack.tf account listings.':'Listing was not found in Backpack.tf account listings after sync.',v);const drafts=await api('/api/hub-listing-drafts');renderHubListingDrafts(drafts);}catch(err){setPublishWizardStatus('Verify listing failed.',err.body||err.message);setLog(err.body||err.message);}return;}
  if(e.target.closest('#prepareOnePublishDraft')){try{setPublishWizardStatus('Preparing one draftâ€¦');const d=await api('/api/publish-wizard/prepare-one',{method:'POST',body:'{}'});renderPublishWizard(d);setPublishWizardStatus(d.ok?'Draft prepared. Now click Test Publish Payload.':'Prepare draft returned a warning/error.',d);const drafts=await api('/api/hub-listing-drafts');renderHubListingDrafts(drafts);setLog(d);}catch(err){setPublishWizardStatus('Prepare draft failed.',err.body||err.message);setLog(err.body||err.message);}return;}
  if(e.target.closest('#refreshOpportunities')){try{const d=await api('/api/opportunities');renderOpportunities(d);setLog(d);}catch(err){setLog(err.body||err.message);}return;}
  if(e.target.closest('#runReleaseCheck')){
    try{const d=await api('/api/system/release-check');renderReleaseCheck(d);setLog(d);}catch(err){setLog(err.body||err.message);}
    return;}
  if(e.target.closest('#runForbiddenFieldsAudit')){
    try{const d=await api('/api/system/forbidden-fields-audit');setLog(d);}catch(err){setLog(err.body||err.message);}
    return;}
});
