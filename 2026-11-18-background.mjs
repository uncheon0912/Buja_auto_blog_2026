import {layoutArticle,reviewArticle,seriesNames,seriesDirection,VERSION,busy,text,formOf,draftOf,parseDraft,articlePrompt,imagePrompt,imageOverlayText,thumbnailOverlayText,imageSeriesStyle,planImageBatch,backupOf,validateImage,validRepo,newer} from './2026-11-18-core.mjs';
import {putAsset,getData} from './2026-11-18-assets.mjs';
import {insertGalleryPhoto,clearDraftTransfers,connectionFor, recoverTransfer, connectEditor, disconnectEditor, focusConnected, invalidateEditor, sendDraft} from './2026-11-18-transfer.mjs';
const defaults={remainingImages:null,form:formOf(),draft:draftOf(),images:[],reference:null,history:[],logs:[],job:null,imageQueue:[],aiTabId:null,settings:{repo:''},onboarded:false};
const read=async()=>({...defaults,...await chrome.storage.local.get(Object.keys(defaults))});
const now=()=>new Date().toISOString();
const change=values=>chrome.storage.local.set(values);
const placementOf = value => ['auto','fixed'].includes(value) ? {placement:value} : {};
async function log(event,detail='',diagnostic){
 const {logs=[]}=await chrome.storage.local.get('logs');
 await change({logs:[{at:now(),event,detail:text(detail,1200),...(diagnostic ? {diagnostic} : {})},...logs].slice(0,400)});
}
const trace = (event,detail) => log(event,'',detail).catch(()=>{});
function generationTrace(job,event,stage,details={}){
 return trace(event,{operationId:job.batchId || job.id,requestId:job.id,kind:job.kind,provider:job.provider || "Gemini",stage,
  source:'background',...(job.kind==='image' ? {photoIndex:job.photoIndex,expectedPhotos:job.batchCount} : {}),...details});
}
async function snapshot(reason,s=null){s ||= await read();if(!s.draft.title&&!s.images.length)return;await change({history:[{id:crypto.randomUUID(),at:now(),reason,form:s.form,draft:s.draft,images:s.images,reference:s.reference},...s.history].slice(0,30)});}
const geminiOrigin = 'https://gemini.google.com/';
const providerOrigin = provider => provider==='ChatGPT'?'https://chatgpt.com/':geminiOrigin;
const providerName = job => job.provider || "Gemini";
async function releaseGeminiTab(tabId) {
 if (Number.isInteger(tabId)) await chrome.tabs.update(tabId, {autoDiscardable: true}).catch(() => {});
}
async function closeFinishedGemini(job) {
 if(job.provider==='ChatGPT'){
  for(let attempt=0;attempt<2;attempt++){
   const work=await chrome.tabs.get(job.tabId).catch(()=>null);
   if(!work)return;
   if(work.windowId!==job.windowId || !work.url?.startsWith(providerOrigin('ChatGPT')))break;
   try{await chrome.tabs.remove(work.id);return;}catch{await new Promise(resolve=>setTimeout(resolve,250));}
  }
  await generationTrace(job,'ChatGPT 작업 탭 닫기 확인 필요','close-tab',{code:'GPT_TAB_CLOSE_UNCONFIRMED'});
  await releaseGeminiTab(job.tabId);return;
 }
 const tab = await chrome.tabs.get(job.tabId).catch(() => null);
 if (tab && tab.windowId === job.windowId && tab.url?.startsWith(providerOrigin(job.provider))) {
  try {
   await chrome.tabs.remove(tab.id);
   return;
  } catch { /* The work tab may have been closed manually. */ }
 }
 await releaseGeminiTab(job.tabId);
}
async function openGeminiWindow(provider='Gemini') {
 try {
  const window = await chrome.windows.create({url: provider==='ChatGPT'?providerOrigin(provider):geminiOrigin+'app', type: 'normal', focused: true});
  const [tab] = window?.tabs?.length ? window.tabs : window ? await chrome.tabs.query({windowId: window.id}) : [];
  if (!Number.isInteger(tab?.id)) throw Error('Gemini tab unavailable');
  await chrome.tabs.update(tab.id, {autoDiscardable: false}).catch(() => {});
  return tab;
 } catch {
  throw Object.assign(new Error('새 '+provider+' 창을 열지 못했습니다. Chrome 창과 인터넷 연결을 확인해주세요.'), {code: 'GEMINI_CONNECTION'});
 }
}
async function rememberComposer(provider,digest){
 const {composerDigests={}}=await chrome.storage.local.get('composerDigests');
 const previous=composerDigests[provider] || [];
 await change({composerDigests:{...composerDigests,[provider]:[digest,...previous.filter(value=>value!==digest)].slice(0,20)}});
}
async function start(job,attachments=[]){
 const provider=providerName(job);
 const {composerDigests={},imageComposerDigests=[]}=await chrome.storage.local.get(['composerDigests','imageComposerDigests']);
 const knownComposerDigests=[...(composerDigests[provider]||[]),...(provider==='ChatGPT'?imageComposerDigests:[])];
 await change({job});
 try{const r=await chrome.tabs.sendMessage(job.tabId,{type:'BUJA_START',job:{...job,knownComposerDigests},attachments},{frameId:0});if(!r?.ok)throw Error(r?.error||providerName(job)+'에서 요청을 받지 못했습니다.');}
 catch(e){
  const error = job.kind === 'article' ? Object.assign(new Error(providerName(job)+'에 요청을 전달하지 못했습니다. 열린 탭에서 연결을 확인한 뒤 초안 작성을 다시 눌러주세요.'), {code:'GEMINI_CONNECTION'}) : e;
  await change({job:{...job,status:'error',error:error.message,code:error.code,ended:now()},imageQueue:[]});
  await log('연결 실패',error.message);
  throw error;
 }
}
async function waitGemini(tabId,provider='Gemini') {
 let attemptedInjection=false;
 let status;
 const deadline=Date.now()+25000;
 const fail=(code,message)=>Object.assign(new Error(provider+' '+message),{code});
 do {
  const tab=await chrome.tabs.get(tabId).catch(()=>null);
  if(!tab)throw fail('AI_TAB_CLOSED','작업 탭이 닫혔습니다. 다시 요청해주세요.');
  if(tab.status==='complete' && tab.url && !tab.url.startsWith(providerOrigin(provider))) {
   const url=new URL(tab.url);
   if(['auth.openai.com','accounts.google.com'].includes(url.hostname)){
    throw fail('AI_LOGIN_REQUIRED','로그인 화면이 열렸습니다. 로그인한 뒤 다시 요청해주세요.');
   }
   if(tab.url!=='about:blank')throw fail('AI_TAB_LEFT_PROVIDER','작업 탭이 다른 주소로 이동했습니다. 열린 화면을 확인해주세요.');
  }
  try{
   status=await chrome.tabs.sendMessage(tabId,{type:'BUJA_PING'},{frameId:0});
   if(status?.ready && !status.busy && !status.running)return;
   if(status?.loginRequired)break;
  }catch{
   if(!attemptedInjection && tab.status==='complete' && tab.url?.startsWith(providerOrigin(provider))){
    attemptedInjection=true;
    await chrome.scripting.executeScript({target:{tabId},files:['2026-11-18-gemini.js']}).catch(()=>{});
   }
  }
  await new Promise(resolve=>setTimeout(resolve,250));
 }while(Date.now()<deadline);
 if(status?.loginRequired)throw fail('AI_LOGIN_REQUIRED','로그인 화면이 감지됐습니다. 로그인한 뒤 다시 요청해주세요.');
 if(status?.busy || status?.running)throw fail('AI_COMPOSER_BUSY','응답 생성이 끝난 뒤 다시 요청해주세요.');
 if(!status)throw fail('AI_TAB_UNREACHABLE','작업 탭과 통신하지 못했습니다. 열린 창이 정상 로드됐는지 확인해주세요.');
 await trace(provider+' 입력창 탐색 시간 초과',{provider,stage:'composer-probe',source:'background.waitGemini',candidateCount:status.candidateCount,sendFound:status.sendFound,code:'AI_COMPOSER_NOT_FOUND'});
 throw fail('AI_COMPOSER_NOT_FOUND','작성란을 찾지 못했습니다. 열린 창에서 작성란이 보이고 입력할 수 있는지 확인해주세요.');
}
async function beginArticle(msg,s){
 if(busy(s.job))throw Error('진행 중인 작업을 기다리거나 수집을 중단해주세요.');
 const form=formOf(msg.form);const photos=s.images.filter(x=>x.source==='upload'&&x.draftId===s.draft.id);if(form.mode==='photo'&&!photos.length)throw Error('내 사진으로 글쓰기에서는 사진을 먼저 추가해주세요.');
 const prompt=articlePrompt(form,msg.revision?s.draft:null,msg.revision,photos);
 const recovery=msg.recoverJobId && s.job?.id===msg.recoverJobId && s.job.status==='error'
  && s.job.kind==='article' && s.job.provider===form.textAI && s.job.blockedComposerDigest ? s.job : null;
 if(msg.recoverJobId&&!recovery)throw Error('현재 차단된 초안 작업을 다시 확인해주세요.');
 if(s.job?.provider===form.textAI && s.job.prompt && ['article','image'].includes(s.job.kind)){
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s.job.prompt.replace(/\s+/gu,' ').trim()));
  await rememberComposer(form.textAI,Array.from(new Uint8Array(bytes),n=>n.toString(16).padStart(2,'0')).join(''));
 }
 const attachments=[];if(form.mode==='photo' && !form.useArticleReference){if(photos.reduce((n,p)=>n+p.size,0)>20*1024*1024)throw Error('AI에 첨부할 사진 전체 용량을 20MB 이하로 줄여주세요.');for(const p of photos)attachments.push({name:p.name,data:await getData(p.id)});}
 let job = {id:crypto.randomUUID(), kind:'article', provider:form.textAI,length:form.length,status:'preparing', stage:'connecting', started:now(), prompt,...(recovery?{replaceComposerDigest:recovery.blockedComposerDigest}:{})};
 await change({job, form, imageQueue:[]});
 await generationTrace(job,providerName(job)+' 초안 연결 시작','connect',{promptLength:prompt.length,attachmentCount:attachments.length});
 try {
  let tab = recovery ? await chrome.tabs.get(recovery.tabId) : await openGeminiWindow(form.textAI);
  job = {...job, tabId:tab.id, windowId:tab.windowId};
  await change({job, aiTabId:tab.id});
  await waitGemini(tab.id,form.textAI);
  if(!recovery){
   const occupied=await occupiedComposer(tab.id,form.textAI);
   if(occupied){
    await generationTrace(job,providerName(job)+' 기존 입력 보존 · 새 작업 창 재시도','composer-retry');
    await releaseGeminiTab(tab.id);
    tab=await openGeminiWindow(form.textAI);
    job={...job,tabId:tab.id,windowId:tab.windowId};
    await change({job,aiTabId:tab.id});
    await waitGemini(tab.id,form.textAI);
   }
  }
  job = {...job, status:'running', stage:'request', requested:now()};
  await start(job,attachments);
  await generationTrace(job,providerName(job)+' 확장 작업 접수','request');
 } catch (error) {
  await generationTrace(job,providerName(job)+' 초안 요청 실패',job.stage,{code:error.code || 'DRAFT_REQUEST_FAILED'});
  await change({job:{...job,status:'error',error:error.message,code:error.code,ended:now()}});
  await releaseGeminiTab(job.tabId);
  throw error;
 }
 await log('초안 생성 요청',form.topic).catch(()=>{});
 return {jobId:job.id};
}
async function occupiedComposer(tabId,provider,kind="article"){
   const {composerDigests={},imageComposerDigests=[]}=await chrome.storage.local.get(['composerDigests','imageComposerDigests']);
   const known=[...(composerDigests[provider]||[]),...(provider==='ChatGPT'?imageComposerDigests:[])];
   const inspection=await chrome.tabs.sendMessage(tabId,{type:'BUJA_INSPECT_ARTICLE',known,kind},{frameId:0});
 return inspection?.unknown;
}
async function beginImages(items) {
 const batchId = crypto.randomUUID();
 const {draft,form} = await read();
 if(form.preferImagePrompt && !form.imageNotes.trim())throw Error('우선 반영할 이미지 프롬프트를 입력해주세요.');
 const visualStyle = form.preferImagePrompt ? '' : imageSeriesStyle(form,draft);
 await trace(form.imageAI+' 이미지 배치 시작',{operationId:batchId,kind:'image',stage:'connect',source:'background.beginImages',expectedPhotos:items.length});
 let tab;
 try {
  tab = await openGeminiWindow(form.imageAI);
  await waitGemini(tab.id,form.imageAI);
  if(await occupiedComposer(tab.id,form.imageAI,"image")){
   await trace(form.imageAI+' 기존 입력 보존 · 이미지 작업 창 재시도',{operationId:batchId,provider:form.imageAI,kind:'image',stage:'composer-retry'});
   await releaseGeminiTab(tab.id);
   tab=await openGeminiWindow(form.imageAI);
  }
  await change({remainingImages:{draftId:draft.id,items},aiTabId:tab.id,imageQueue:items.map((item,index)=>({...item,provider:form.imageAI,visualStyle,customPrompt:form.preferImagePrompt ? form.imageNotes : null,batchId,photoIndex:index + 1,batchCount:items.length}))});
  await nextImage();
 } catch (error) {
  await trace(form.imageAI+' 이미지 배치 요청 실패',{operationId:batchId,kind:'image',stage:'request',source:'background.beginImages',code:error.code || 'IMAGE_REQUEST_FAILED'});
  await change({imageQueue:[]});
  await releaseGeminiTab(tab?.id);
  throw error;
 }
}
async function nextImage(){
 const s=await read();if(busy(s.job)||!s.imageQueue.length)return;
 const [item,...remaining]=s.imageQueue;
 const tabId=s.aiTabId;
 const provider=item.provider || s.form.imageAI;
 await waitGemini(tabId,provider);
 const {windowId}=await chrome.tabs.get(tabId);
 const attachments=s.form.referenceRequired&&s.reference?[{name:s.reference.name,data:await getData(s.reference.id)}]:[];
 const job={id:crypto.randomUUID(),kind:'image',status:'running',provider,tabId,windowId,started:now(),draftId:s.draft.id,item,prompt:imagePrompt({...s.form,imageAI:provider,preferImagePrompt:item.customPrompt!=null,imageNotes:item.customPrompt??s.form.imageNotes},{...s.draft,imageSeriesStyle:item.visualStyle},item),
  batchId:item.batchId,photoIndex:item.photoIndex,batchCount:item.batchCount};
 await change({imageQueue:remaining});await start(job,attachments);
 await generationTrace(job,providerName(job)+' 이미지 요청 전달','request',{promptLength:job.prompt.length,attachmentCount:attachments.length,thumbnail:!!item.thumbnail});
}
async function imageData(candidate){
 if(candidate.data){validateImage(candidate.data);return candidate.data;}
 const url=new URL(candidate.url);if(url.protocol!=='https:'||!(url.hostname==='gemini.google.com'||url.hostname.endsWith('.googleusercontent.com')))throw Error('허용되지 않은 이미지 주소입니다. 직접 파일을 선택해주세요.');
 const r=await fetch(url.href,{credentials:'omit',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('Gemini 이미지를 가져오지 못했습니다. 내려받은 파일을 직접 추가해주세요.');
 if(+(r.headers.get('content-length')||0)>8*1024*1024)throw Error('생성 이미지가 8MB를 넘습니다.');
 const reader=r.body.getReader();let size=0,chunks=[];while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>8*1024*1024){await reader.cancel();throw Error('생성 이미지가 8MB를 넘습니다.');}chunks.push(value);}
 const b=new Uint8Array(size);let pos=0;for(const c of chunks){b.set(c,pos);pos+=c.length;}let binary='';for(let i=0;i<b.length;i+=8192)binary+=String.fromCharCode(...b.subarray(i,i+8192));const mime=(r.headers.get('content-type')||'').split(';')[0];const data=`data:${mime};base64,${btoa(binary)}`;validateImage(data);return data;
}
function currentCover(state, platform) {
 const photos = state.images.filter(image => image.draftId === state.draft.id);
 return photos.find(image => image.thumbnail) ?? (platform === 'naver' ? photos[0] : undefined);
}

function newGeneratedImages(images, image) {
 const remaining = !image.thumbnail ? images : images.map(previous =>
  previous.draftId === image.draftId && previous.thumbnail ? {...previous, thumbnail:false} : previous);
 return [...remaining, image].slice(-30);
}

function ownsGeminiJob(job, msg, sender) {
 return busy(job) && job.id === msg.jobId && job.tabId === sender.tab?.id && sender.frameId === 0
  && sender.url?.startsWith(providerOrigin(job.provider));
}
async function reportArticleStage(msg, sender) {
 const {job} = await read();
 if (!ownsGeminiJob(job, msg, sender)) return {ignored:true};
 if (['composer-ready','composer-blocked','stale-prompt-replaced','submitted','submit-unconfirmed'].includes(msg.stage)) {
  await generationTrace(job,providerName(job)+' · '+({
   'composer-ready':'입력창 확인','composer-blocked':'기존 입력 보존','stale-prompt-replaced':'확장이 남긴 요청 교체',
   submitted:'사이트 전송 확인','submit-unconfirmed':'사이트 전송 미확인'
  })[msg.stage],msg.stage,{source:'ai-content'});
  return {};
 }
 if(msg.stage==='composer-written' && /^[a-f0-9]{64}$/.test(msg.digest)){
  await rememberComposer(providerName(job),msg.digest);
  return {};
 }
 if(job.kind!=='article')return {ignored:true};
 const allowed = msg.stage === 'waiting' && job.stage === 'request'
  || msg.stage === 'collecting' && ['request','waiting'].includes(job.stage);
 if (allowed) {
  await change({job:{...job,stage:msg.stage}});
  await generationTrace(job,msg.stage === 'waiting' ? providerName(job)+' 초안 응답 대기' : providerName(job)+' 초안 응답 수집',msg.stage,{source:'ai-content'});
 }
 return {};
}
async function result(msg,sender){
 const s=await read(),job=s.job;
 if(!ownsGeminiJob(job,msg,sender))return {ignored:true};
 if(job.threadsTab){
  try{
   if(msg.error)throw Error(msg.error);
   let output;
   if(job.kind==='article'){
    const raw=JSON.parse(msg.text.trim().replace(/^```(?:json)?\s*|\s*```$/gi,''));
    if(typeof raw.text!=='string'||!raw.text.trim()||[...raw.text.trim()].length<200||[...raw.text.trim()].length>300 || !Array.isArray(raw.image_prompts)||raw.image_prompts.length!==job.count||raw.image_prompts.some(p=>typeof p!=='string'||!p.trim()))throw Error('게시글은 공백 포함 200~300자로 작성해야 합니다. 이미지 프롬프트 개수도 확인해주세요.');
    output={text:raw.text.trim(),prompts:raw.image_prompts};
   }else{
    const id=crypto.randomUUID();await putAsset(id,await imageData(msg.images[0]));output={imageId:id};
   }
   await change({job:{...job,status:'done',ended:now(),output}});
   if(!job.moreImages)await closeFinishedGemini(job);
  }catch(error){await change({job:{...job,status:'error',error:error.message}});await releaseGeminiTab(job.tabId);}
  return {};
 }
 if (job.kind === 'article') {
  try {
   if (msg.error) throw Error(text(msg.error,1200));
   await change({job:{...job,stage:'saving'}});
   await generationTrace(job,providerName(job)+' 초안 응답 수신','parse',{responseLength:text(msg.text).length});
   const parsed=parseDraft(msg.text);
   const notes=reviewArticle(parsed,s.form);
   const draft=layoutArticle({...parsed,reviewNotes:notes});
   const images = s.images.map(x=>x.source==='upload'&&x.draftId===s.draft.id?{...x,draftId:draft.id}:x);
   await snapshot('생성 전 초안',s);
   await change({draft,images,job:{...job,status:'done',stage:'saved',ended:now()}});
   await Promise.allSettled([snapshot('Gemini 초안 생성'), generationTrace(job,providerName(job)+' 초안 저장 완료','saved',
    {observedTextBlocks:draft.content.length,observedTags:draft.hashtags.length,plannedImages:draft.imagePrompts.length}), closeFinishedGemini(job)]);
  } catch (error) {
   const {job:latest} = await read();
   await change({job:{...latest,status:'error',error:error.message,code:error.code,raw:text(msg.text),blockedComposerDigest:/^[a-f0-9]{64}$/.test(msg.blockedComposerDigest||'')?msg.blockedComposerDigest:undefined,ended:now()}});
   await releaseGeminiTab(job.tabId);
   await generationTrace(job,providerName(job)+' 초안 처리 실패',latest.stage,{code:error.code || (msg.responseProbe?'GPT_RESPONSE_UNREADABLE':'DRAFT_RESULT_FAILED'),...(msg.responseProbe?{replyFound:msg.responseProbe.sawReply===true,observedChars:Number(msg.responseProbe.observedChars)||0}:{} )});
  }
  return {};
 }
 let imageStage = 'collect';
 try{
  if(msg.error)throw Object.assign(Error(text(msg.error,1200)),{code:msg.code});
   if(s.draft.id!==job.draftId)throw Error('초안이 바뀌어 이미지 결과를 적용하지 않았습니다.');
   const candidate=msg.images?.[0];if(!candidate)throw Error('생성된 이미지 파일을 찾지 못했습니다. Gemini에서 내려받은 사진을 직접 선택해주세요.');
   await generationTrace(job,providerName(job)+' 이미지 응답 수신','collect',{observedPhotos:msg.images.length});
   const id=crypto.randomUUID();
   const original=await imageData(candidate);
   const overlayText = job.item.thumbnail ? imageOverlayText(job.item.overlayText,20) || thumbnailOverlayText(s.draft) : imageOverlayText(job.item.overlayText);
   const visualStyle = job.item.customPrompt!=null ? s.draft.imageSeriesStyle : imageSeriesStyle(s.form,{...s.draft,imageSeriesStyle:job.item.visualStyle});
   imageStage = 'save-image';
   const info=await putAsset(id,original);
   const image={id,...info,name:`2026-11-19-gemini-${s.images.length+1}.${info.mime==='image/jpeg'?'jpg':info.mime==='image/webp'?'webp':'png'}`,source:'gemini',draftId:job.draftId,prompt:job.item.prompt,page:job.item.page,pages:job.item.pages,sectionText:job.item.sectionText,caption:job.item.label,alt:job.item.alt||'',visualStyle,afterBlockId:job.item.afterBlockId||'',afterParagraph:job.item.afterParagraph,...placementOf(job.item.placement),thumbnail:!!job.item.thumbnail,...(overlayText?{overlayText,overlaySource:'gemini'}:{}),at:now()};
   if(job.item.replaceId){
    await change({remainingImages:null,job:{...job,status:'done',ended:now(),replacement:image}});
    await generationTrace(job,providerName(job)+' 교체 이미지 검토 준비','saved',{bytes:info.size,mime:info.mime,thumbnail:image.thumbnail});
    await closeFinishedGemini(job);
    return {};
   }
   await snapshot('이미지 추가 전',s);await change({remainingImages:s.imageQueue.length?{draftId:s.draft.id,items:s.imageQueue}:null,draft:{...s.draft,imageSeriesStyle:visualStyle},images:newGeneratedImages(s.images,image),job:{...job,status:'done',ended:now()}});
   await generationTrace(job,providerName(job)+' 원본 이미지 저장 완료','saved',{bytes:info.size,mime:info.mime,thumbnail:image.thumbnail,overlayRequested:!!overlayText,visualStyle});
   await snapshot('이미지 생성 결과');
   if (s.imageQueue.length) {
    imageStage = 'next-image';
    await nextImage();
   } else {
    await generationTrace(job,providerName(job)+' 이미지 배치 완료','batch-done',{verifiedPhotos:job.batchCount});
    await closeFinishedGemini(job);
   }
 }catch(e){await change({job:{...job,status:'error',error:e.message,...(e.code?{code:e.code}:{}),raw:text(msg.text),ended:now()},imageQueue:[]});await releaseGeminiTab(job.tabId);
  await generationTrace(job,providerName(job)+' 이미지 처리 실패',imageStage,{code:e.code || 'IMAGE_RESULT_FAILED'});}
 return {};
}
async function command(msg,sender){
 if(msg.type==='BUJA_READ_CODE'){
  const {job}=await read();
  if(!ownsGeminiJob(job,msg,sender)||job.provider!=='ChatGPT'||job.kind!=='article'||sender.frameId!==0)return {};
  const [entry]=await chrome.scripting.executeScript({target:{tabId:job.tabId,frameIds:[0]},world:'MAIN',args:[job.id],func:id=>{
   const node=document.querySelector('.cm-content[data-buja-response="'+CSS.escape(id)+'"]');
   if(!node || node.closest('[data-message-author-role=user],[data-turn=user],form'))return '';
   const view=node.cmTile?.root?.view || node.cmView?.view || node.cmView?.rootView?.view;
   const doc=view?.state?.doc;
   return doc && doc.length<=60000 ? doc.toString() : '';
  }});
  return {raw:typeof entry?.result==='string'?entry.result:''};
 }
 if(msg.type==='BUJA_RESULT')return result(msg,sender);
 if(msg.type==='BUJA_STAGE')return reportArticleStage(msg,sender);
 if(/^THREAD_/.test(msg.type)){
  if(sender.frameId!==0 || !/^https:\/\/(?:www\.)?threads\.(?:com|net)\//.test(sender.url||'') || !sender.tab?.id)throw Error('Threads 탭을 확인해주세요.');
  const threadsTab=sender.tab.id;
  const key='threads-dismiss:'+threadsTab;
  if(msg.type==='THREAD_DISMISS'){await chrome.storage.session.set({[key]:true});return {};}
  if(msg.type==='THREAD_PREF')return !!(await chrome.storage.session.get(key))[key];
  const {job:current}=await read();
  if(msg.type==='THREAD_STATUS'){
   if(current?.threadsTab!==threadsTab||current.id!==msg.id)throw Error('다른 작업으로 변경되었습니다.');
   const response={status:current.status,error:current.error,output:current.output};
   if(current.output?.imageId)response.output={data:await getData(current.output.imageId)};
   return response;
  }
  if(msg.type!=='THREAD_START'||busy(current))throw Error('현재 생성 작업을 확인해주세요.');
  const count=Number(msg.count),kind=msg.kind;
  if(!['article','image'].includes(kind)||!Number.isInteger(count)||count<0||count>10||!text(msg.prompt,4000).trim())throw Error('주제와 이미지 개수를 확인해주세요.');
  const style=seriesNames.includes(msg.style)?msg.style:seriesNames[0];
  const direction=seriesDirection(style,text(msg.seriesSeed,100));
  const prompt=kind==='article'?`Threads 한국어 게시글 한 개를 공백 포함 200~300자로 자연스러운 대화체와 짧은 단락으로 작성하세요. 경험이나 수치를 꾸미지 마세요. JSON 코드블록 하나로 {"text":"게시글","image_prompts":[]}를 반환하세요. 서로 다른 장면의 독립적인 이미지 프롬프트를 정확히 ${count}개 넣으세요. 0이면 빈 배열입니다. 스타일: ${direction}. 주제 및 요청: ${text(msg.prompt,4000)}`:`실제 이미지 한 장을 생성하세요. 설명 대신 이미지로 응답하세요. 글 자료: ${text(msg.post,500)}. 장면 소재: ${text(msg.prompt,4000)}. 최우선 제작 스타일: ${style}. ${direction}. 텍스트 또는 포스터 스타일이면 본문의 핵심 한글 문구를 정돈된 제목으로 직접 표현하세요.`;
  const index=Number(msg.index)||0;
  let tab;
  if(kind==='image' && index>0){
   if(current?.threadsTab!==threadsTab || current.status!=='done' || !current.moreImages || current.batch!==msg.batch || current.index+1!==index)throw Error('이미지 작업 연결이 바뀌었습니다.');
   tab=await chrome.tabs.get(current.tabId);
   if(tab.windowId!==current.windowId || !tab.url?.startsWith(geminiOrigin))throw Error('작업 중인 Gemini 창을 확인해주세요.');
  }else tab=await openGeminiWindow();
  const job={id:crypto.randomUUID(),batch:msg.batch,index,moreImages:kind==='image' && index+1<count,threadsTab,kind,count,prompt,status:'running',stage:'request',started:now(),tabId:tab.id,windowId:tab.windowId};
  try{await waitGemini(tab.id);await start(job);}catch(error){await releaseGeminiTab(tab.id);throw error;}
  return {id:job.id};
 }
 if(sender.url!==chrome.runtime.getURL('2026-11-18-panel.html'))throw Error('허용되지 않은 요청입니다.');
 const s=await read();
 switch(msg.type){
 case 'STATE':return {...s,connection:await connectionFor(msg.windowId),transfer:await recoverTransfer(msg.windowId)};
 case 'ONBOARD':await change({onboarded:true});return {};
 case 'SAVE_PREFS':{
  const form=formOf(msg.form);
  const keys=['textAI','imageAI','tone','length','articleType','preset','accent','imageType','imageCount','ratio'];
  await chrome.storage.local.set({profilePreferences:Object.fromEntries(keys.map(key=>[key,form[key]]))});return {};
 }
 case 'RESTORE_PREFS':{
  const {profilePreferences}=await chrome.storage.local.get('profilePreferences');
  if(profilePreferences&&!busy(s.job))await change({form:formOf({...s.form,...profilePreferences})});return {};
 }
 case 'RESUME_IMAGES':{
  if(busy(s.job)||s.remainingImages?.draftId!==s.draft.id||!s.remainingImages?.items?.length)throw Error('이어갈 이미지 작업이 없습니다.');
  await beginImages(s.remainingImages.items);return {};
 }
 case 'SAVE':{if(msg.form)await change({form:formOf(msg.form)});if(msg.draft){if(msg.draft.id && msg.draft.id!==s.draft.id)throw Error('초안이 변경됐습니다. 패널을 다시 열어주세요.');if(busy(s.job))throw Error('생성 중에는 초안 편집을 기다려주세요.');await change({draft:draftOf({...msg.draft,id:s.draft.id,imageSeriesStyle:s.draft.imageSeriesStyle})});}return {};}
 case 'APPLY_MANUAL':{if(busy(s.job))throw Error('생성을 먼저 중단해주세요.');const draft=parseDraft(msg.text);await snapshot('직접 붙여넣기 전',s);await change({draft,images:s.images.map(x=>x.source==='upload'&&x.draftId===s.draft.id?{...x,draftId:draft.id}:x)});await snapshot('직접 붙여넣은 초안');await log('응답 직접 적용');return {};}
 case 'OPEN_SITE':{
  const sites = { threads:'https://www.threads.com/', naver:'https://blog.naver.com/', cafe:'https://section.cafe.naver.com/', tistory:'https://www.tistory.com/' };
  return chrome.tabs.create({url: sites[msg.platform] || sites.naver, windowId:msg.windowId});
 }
 case 'CONNECT':{
  const connection = await connectEditor(msg.windowId, msg.tabId);
  await log('현재 탭 연결', connection.platformName + ' · ' + connection.title);
  return connection;
 }
 case 'DISCONNECT':await disconnectEditor(msg.windowId);await log('탭 연결 해제');return {};
 case 'INSERT_GALLERY_PHOTO':{
  const image=s.images.find(item=>item.id===msg.id);
  if(!image)throw Error('갤러리에서 사진을 다시 선택해 주세요.');
  await insertGalleryPhoto(msg.windowId,image);
  await log('갤러리 사진 수동 삽입',image.caption || image.name);
  return {};
 }
 case 'FOCUS_CONNECTED':await focusConnected(msg.windowId);return {};
 case 'TRANSFER':
 case 'RETRY_TRANSFER':
 case 'RESTART_TRANSFER':{
  if(busy(s.job))throw Error('생성 중에는 전송할 수 없습니다.');
  const result = await sendDraft(msg.windowId, s, msg.type === 'RETRY_TRANSFER', trace, msg.includeDiffText === true, msg.type === 'RESTART_TRANSFER');
  if(result.status==='done'){
    const connection=await connectionFor(msg.windowId);
    if(connection?.platform==='naver')await chrome.storage.session.set({['publish:'+msg.windowId]:{tabId:connection.tabId,draftId:s.draft.id,title:s.draft.title}});
  }
  await log(result.status === 'done' ? '전송 완료' : '전송 확인 필요', result.message);
  return result;
 }
 case 'GENERATE':return beginArticle(msg,s);
 case 'GENERATE_IMAGES':{
  if(busy(s.job))throw Error('진행 중인 생성을 기다려주세요.');if(!s.draft.title||!s.draft.body)throw Error('초안을 먼저 준비해주세요.');if(s.form.referenceRequired&&!s.reference)throw Error('필수 참고 이미지를 선택해주세요.');
  const current=s.images.filter(x=>x.draftId===s.draft.id).length,count=s.form.imageCount||Math.max(1,Math.min(3,s.draft.imagePrompts.length||2));if(current+count>10)throw Error('현재 초안 사진은 최대 10장입니다. 기존 사진을 정리하거나 생성 개수를 줄여주세요.');
  const plan=planImageBatch(s.draft,current+count);
  const hasCover=s.images.some(image=>image.draftId===s.draft.id && image.thumbnail);
  await beginImages(current && !hasCover ? [plan[0],...plan.slice(current+1)] : plan.slice(current));return {};
 }
 case 'REGENERATE_IMAGE':{
  if(busy(s.job))throw Error('진행 중인 생성을 기다려주세요.');const x=s.images.find(x=>x.id===msg.id);if(!x)throw Error('사진이 없습니다.');if(s.form.referenceRequired&&!s.reference)throw Error('필수 참고 이미지를 선택해주세요.');
  if(x.draftId!==s.draft.id)throw Error('현재 초안에 있는 사진을 선택해주세요.');
  const connection = await connectionFor(msg.windowId);
  const thumbnail = currentCover(s,connection?.platform || 'naver')?.id === x.id;
  await beginImages([{label:thumbnail?'블로그 썸네일':x.caption||'수정 이미지',prompt:x.prompt,revision:text(msg.request,3000),replaceId:x.id,page:x.page,pages:x.pages,sectionText:x.sectionText,alt:x.alt,afterBlockId:thumbnail?'':x.afterBlockId,afterParagraph:thumbnail?0:x.afterParagraph,...placementOf(x.placement),thumbnail,overlayText:thumbnail ? imageOverlayText(x.overlayText,20) || thumbnailOverlayText(s.draft) : (imageOverlayText(x.overlayText).length >= 10 ? imageOverlayText(x.overlayText) : planImageBatch({...s.draft,imagePrompts:[null,{...x,label:x.caption}]},2)[1].overlayText)}]);
  return {};
 }
 case 'APPLY_IMAGE_REPLACEMENT':
 case 'DISCARD_IMAGE_REPLACEMENT':{
  const {job}=s;
  if(job?.status!=='done' || job.item?.replaceId!==msg.id || !job.replacement || job.draftId!==s.draft.id
    || !s.images.some(image=>image.id===msg.id && image.draftId===s.draft.id))throw Error('검토할 새 이미지가 없습니다.');
  const {replacement,...finished}=job;
  if(msg.type==='DISCARD_IMAGE_REPLACEMENT'){await change({job:finished});return {};}
  await snapshot('AI 이미지 교체 전',s);
  const images=s.images.map(image=>image.id===msg.id ? {...replacement,caption:image.caption,alt:image.alt,
    afterBlockId:image.afterBlockId,afterParagraph:image.afterParagraph,placement:image.placement,thumbnail:image.thumbnail||replacement.thumbnail} : image);
  await change({images,job:finished});
  return {};
 }
 case 'CANCEL':{
  await change({imageQueue:[]});if(busy(s.job)){await change({job:{...s.job,status:'cancelled',ended:now()}});await chrome.tabs.sendMessage(s.job.tabId,{type:'BUJA_CANCEL',jobId:s.job.id}).catch(()=>{});await releaseGeminiTab(s.job.tabId);}await log('수집 중단','Gemini 생성 자체는 Gemini 화면에서 직접 중지할 수 있습니다.');return {};
 }
 case 'ADD_IMAGE':{
  if (busy(s.job)) throw Error('생성이 끝난 뒤 사진을 추가해주세요.');
  if (!msg.reference && !msg.replaceId && s.images.filter(x=>x.draftId===s.draft.id).length>=10) throw Error('현재 초안 사진은 10장까지 추가할 수 있습니다.');
  const previous = msg.replaceId ? s.images.find(image => image.id === msg.replaceId) : undefined;
  if (msg.replaceId && !previous) throw Error('교체할 사진이 없습니다.');
  const connection = previous ? await connectionFor(msg.windowId) : null;
  const thumbnail = !!previous && !msg.reference && currentCover(s, connection?.platform || 'naver')?.id === previous.id;
  const id = crypto.randomUUID();
  const info = await putAsset(id,msg.data);
  const name = text(msg.name,200) || '사진.png';
  const image = {id,...info,name,source:'upload',draftId:s.draft.id,caption:text(msg.caption,1000),prompt:'',afterParagraph:0,at:now()};
  await snapshot('사진 추가 전',s);
  if (msg.reference) await change({reference:image});
  else {
   const updated = previous ? {...image,draftId:previous.draftId,caption:previous.caption,alt:previous.alt,prompt:previous.prompt,visualStyle:previous.visualStyle,
    afterBlockId:previous.afterBlockId,afterParagraph:previous.afterParagraph,...placementOf(previous.placement),
    thumbnail:thumbnail || !!previous.thumbnail} : image;
   const images = previous ? s.images.map(photo => photo.id === previous.id ? updated : photo) : [...s.images,image];
   await change({images:images.slice(-30)});
  }
  await snapshot('사진 파일 추가');await log(msg.reference?'참고 사진 선택':'사진 파일 추가',image.name);return image;
 }
 case 'EDIT_IMAGE':{
  if(busy(s.job))throw Error('생성이 끝난 뒤 사진을 수정해주세요.');await snapshot('사진 설정 변경 전',s);
  const position = msg.afterBlockId === undefined ? {} : {afterBlockId:text(msg.afterBlockId,150),
    afterParagraph:Math.max(0,Math.min(200,parseInt(msg.afterParagraph)||0)),...placementOf(msg.placement)};
  const images=s.images.map(x=>x.id===msg.id?{...x,caption:text(msg.caption,1000),prompt:text(msg.prompt,3000),...position,...(msg.adopt?{draftId:s.draft.id}:{})}:x);await change({images});return {};
 }
 case 'REMOVE_IMAGE':if(busy(s.job))throw Error('생성 중입니다.');await snapshot('사진 제거 전',s);await change({images:s.images.filter(x=>x.id!==msg.id)});await log('갤러리 사진 제거','원본은 복원용으로 보관했습니다.');return {};
 case 'PUBLISHED_RESET':{
  if(msg.draftId!==s.draft.id || busy(s.job))throw Error('현재 글과 진행 상태를 확인해 주세요.');
  await resetPublished(s,msg.windowId);return {};
 }
 case 'LOAD_TEST_DRAFT':{
  if(busy(s.job) || (await recoverTransfer(msg.windowId))?.status==='running')throw Error('진행 중인 작업을 마친 뒤 테스트 초안을 불러와주세요.');
  const draft=draftOf({
   title:'[테스트] 네이버 본문 전송 점검',
   hashtags:['테스트용','본문전송','썸네일','소제목','형광펜','밑줄','글쓰기','입력검수'],
   content:[
    {id:'test-first',type:'paragraph',text:'첫 번째 문단입니다. 썸네일 바로 아래에 표시되는지 확인합니다.'},
    {id:'test-second',type:'paragraph',text:'두 번째 문단입니다. 다음 문단을 넣어도 이 문장의 끝이 그대로 유지되어야 합니다.'},
    {id:'test-third',type:'paragraph',text:'세 번째 문단입니다. 여기에서 입력이 멈추거나 앞 문단이 바뀌는지 확인합니다.'},
    {id:'test-heading',type:'heading',text:'소제목 색상 점검'},
    {id:'test-highlight',type:'paragraph',text:'형광펜과 밑줄이 붙은 문구를 확인합니다. 일반 문장도 읽기 편해야 합니다.'},
    {id:'test-final',type:'paragraph',text:'마지막 확인 문장입니다. 이 문장이 보이면 본문 입력이 끝까지 도착했습니다.'}
   ]
  });
  const response=await fetch(chrome.runtime.getURL('2026-11-19-profile.png'));
  if(!response.ok)throw Error('테스트 썸네일을 불러오지 못했습니다.');
  const bytes=new Uint8Array(await response.arrayBuffer());
  let binary='';
  for(let index=0;index<bytes.length;index+=8192)binary+=String.fromCharCode(...bytes.subarray(index,index+8192));
  const id=crypto.randomUUID();
  const asset=await putAsset(id,'data:image/png;base64,'+btoa(binary));
  const image={id,...asset,name:'test-thumbnail.png',caption:'테스트 썸네일',alt:'테스트 썸네일',draftId:draft.id,
   source:'upload',thumbnail:true,placement:'auto',afterParagraph:0,at:now()};
  await snapshot('테스트 초안 불러오기 전',s);
  await clearDraftTransfers(s.draft.id,msg.windowId);
  await change({draft,images:[image],reference:null,job:null,remainingImages:null,imageQueue:[]});
  return {};
 }
 case 'CLEAR_DRAFT':{
  if(busy(s.job)||msg.draftId!==s.draft.id)throw Error('현재 작업과 초안을 다시 확인해주세요.');
  await clearDraftTransfers(s.draft.id,msg.windowId);
  await snapshot('기존 초안 지우기 전',s);
  await change({draft:draftOf(),job:null,remainingImages:null,imageQueue:[]});return {};
 }
 case 'CLEAR_IMAGES':if(busy(s.job))throw Error('생성 중입니다.');await snapshot('갤러리 비우기 전',s);await change({images:[],draft:{...s.draft,imageSeriesStyle:''}});return {};
 case 'SNAPSHOT':await snapshot('사용자 보관');await log('초안·사진 보관');return {};
 case 'RESTORE':{if(busy(s.job))throw Error('생성을 먼저 중단해주세요.');const h=s.history.find(x=>x.id===msg.id);if(!h)throw Error('기록이 없습니다.');await snapshot('복원 전',s);await change({form:h.form,draft:h.draft,images:h.images||[],reference:h.reference||null});await log('작업 기록 복원',h.at);return {};}
 case 'IMPORT':{
  if(busy(s.job))throw Error('생성을 먼저 중단해주세요.');const restored=backupOf(msg.payload);const incoming=msg.payload.images||[];if(!Array.isArray(incoming)||incoming.length>30)throw Error('백업 사진 개수가 올바르지 않습니다.');
  const images = [];
  // Allocate a fresh namespace so an imported non-current photo cannot match the restored draft.
  const olderDrafts = new Map();
  const sourceDraftId = text(msg.payload.draft.id, 80);
  for (const photo of incoming) validateImage(photo?.data);
  for (const photo of incoming) {
    const previousId = text(photo.draftId, 80);
    let draftId = restored.draft.id;
    if (previousId && previousId !== sourceDraftId) {
      if (!olderDrafts.has(previousId)) olderDrafts.set(previousId, crypto.randomUUID());
      draftId = olderDrafts.get(previousId);
    }
    const id = crypto.randomUUID();
    const info = await putAsset(id, photo.data);
    images.push({
      id, ...info, draftId,
      name: text(photo.name, 200),
      caption: text(photo.caption, 1000),
      alt: text(photo.alt, 500),
      visualStyle: text(photo.visualStyle, 40),
      afterBlockId: text(photo.afterBlockId, 150),
      prompt: text(photo.prompt, 3000),
      afterParagraph: Math.max(0, Math.min(200, parseInt(photo.afterParagraph, 10) || 0)),
      ...placementOf(photo.placement),
      thumbnail: photo.thumbnail === true,
      ...(imageOverlayText(photo.overlayText) ? {overlayText:imageOverlayText(photo.overlayText),...(photo.overlaySource==='gemini'?{overlaySource:'gemini'}:{})} : {}),
      source: photo.source === 'gemini' ? 'gemini' : 'upload',
      at: now()
    });
  }
  await snapshot('백업 가져오기 전',s);await change({...restored,images,reference:null});await snapshot('가져온 초안·사진');await log('백업 복원');return {};
 }
 case 'SETTINGS':{const repo=text(msg.repo,160).trim();if(repo&&!validRepo(repo))throw Error('소유자/저장소 형식으로 입력해주세요.');await change({settings:{repo}});return {};}
 case 'UPDATE':{if(!validRepo(s.settings.repo))throw Error('공개 GitHub 저장소를 설정해주세요.');if(!await chrome.permissions.contains({origins:['https://api.github.com/*']}))throw Error('GitHub 조회 권한을 허용해주세요.');const r=await fetch(`https://api.github.com/repos/${s.settings.repo}/releases/latest`,{credentials:'omit',cache:'no-store',signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error(`Release 조회 실패 (${r.status})`);const v=await r.json();return {newer:newer(v.tag_name||'',VERSION),version:text(v.tag_name,80),notes:text(v.body,3000),url:`https://github.com/${s.settings.repo}/releases`};}
 case 'OPEN_SEARCH':{if(!s.form.topic.trim())throw Error('주제를 입력해주세요.');return chrome.tabs.create({url:`https://search.naver.com/search.naver?where=${s.form.source==='blog'?'blog':'nexearch'}&query=${encodeURIComponent(s.form.topic)}`});}
 case 'COLLECT_SEARCH':{
  if(!await chrome.permissions.contains({origins:['https://search.naver.com/*']}))throw Error('검색 자료 읽기 권한을 허용해주세요.');const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.url?.startsWith('https://search.naver.com/'))throw Error('네이버 검색 결과 탭을 선택해주세요.');
  const rs=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>({url:location.href,text:(document.querySelector('#main_pack')||document.querySelector('main'))?.innerText?.slice(0,10000)||''})});const data=rs[0]?.result;if(!data?.text)throw Error('검색 결과를 읽지 못했습니다. 참고 내용을 직접 붙여넣어주세요.');await change({form:{...s.form,sourceNotes:`검색 결과 화면 발췌 (원문 확인 아님)\n${data.url}\n${data.text}`}});await log('검색 화면 수집',data.url);return {};
 }
 default:throw Error('지원하지 않는 명령입니다.');
 }
}
let queue=Promise.resolve();const serial=fn=>{const p=queue.then(fn);queue=p.catch(()=>{});return p;};
chrome.runtime.onMessage.addListener((m,s,r)=>{
 if(s.id!==chrome.runtime.id)return;
 const run = () => command(m||{},s);
 (m?.type === 'STATE' ? run() : serial(run)).then(data=>r({ok:true,data}),async e=>{
  if (['CONNECT','TRANSFER','RETRY_TRANSFER','GENERATE','GENERATE_IMAGES','REGENERATE_IMAGE'].includes(m?.type)) {
   await trace('요청 처리 실패',{stage:m.type,source:'background.command',
    code:/^[A-Z_]+$/.test(e.code || '') ? e.code : 'REQUEST_FAILED'});
  }
  r({ok:false,error:e.message,code:e.code});
 });
 return true;
});
async function resetPublished(s,windowId){
 await clearDraftTransfers(s.draft.id,windowId);
 await change({draft:draftOf(),images:[],reference:null,job:null,remainingImages:null,imageQueue:[],form:formOf({...s.form,topic:'',useArticleReference:false,articleTitle:'',articleBody:'',articleSource:'',sourceNotes:'',notes:'',keywords:''})});
 await chrome.storage.session.remove('publish:'+windowId);
 await log('발행 완료 · 작업 초안과 갤러리 초기화');
}
async function verifyPublished(tabId,tab){
 const url=new URL(tab.url);
 if(url.hostname!=='blog.naver.com'||!(/^\/[^/]+\/\d+\/?$/.test(url.pathname)||(/^\/PostView.naver$/i.test(url.pathname)&&/^\d+$/.test(url.searchParams.get('logNo')||''))))return;
 const key='publish:'+tab.windowId;
 const pending=(await chrome.storage.session.get(key))[key];
 if(!pending||pending.tabId!==tabId)return;
 const s=await read();
 if(s.draft.id!==pending.draftId||busy(s.job))return;
 const frames=await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:()=>({
  title:document.querySelector('.se-documentTitle .se-title-text')?.innerText?.trim(),
  success:[...document.querySelectorAll('[role=status],[role=alert],.toast_message')].some(el=>/발행되었습니다|발행이 완료/.test(el.innerText))
 })});
 if(frames.some(f=>f.result?.title===pending.title)&&frames.some(f=>f.result?.success))await resetPublished(s,tab.windowId);
}
async function setup(){await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});await chrome.alarms.create('buja-watchdog',{periodInMinutes:1});}
chrome.runtime.onInstalled.addListener(()=>{void setup();});chrome.runtime.onStartup.addListener(()=>{void setup();});
chrome.tabs.onUpdated.addListener((id,info,tab)=>{
 if(info.status==="complete" && tab.url)void serial(()=>verifyPublished(id,tab)).catch(()=>{});
 if(info.status==='loading'||info.url) void serial(()=>invalidateEditor(id,'연결된 탭이 이동 또는 새로고침되었습니다. 다시 연결해주세요.'));
});
chrome.tabs.onRemoved.addListener(id=>{void serial(async()=>{
 await chrome.storage.session.remove('threads-dismiss:'+id);
  await invalidateEditor(id,'연결된 글쓰기 탭이 닫혔습니다.');
 const s=await read();if(busy(s.job)&&s.job.tabId===id){await change({job:{...s.job,status:'error',error:providerName(s.job)+' 작업 탭이 닫혔습니다.'},imageQueue:[]});await generationTrace(s.job,providerName(s.job)+' 작업 탭 닫힘',s.job.stage,{code:'AI_TAB_CLOSED'});}
});});
chrome.windows.onRemoved.addListener(id => { void serial(() => disconnectEditor(id)); });
async function checkGeneration() {
 const {job} = await read();
 if (!busy(job) || !Number.isInteger(job.tabId)) return;
 const provider = providerName(job);
 const tab = await chrome.tabs.get(job.tabId).catch(() => null);
 const timedOut = Date.now() - Date.parse(job.started) >= (job.kind === 'image' ? 330000 : 210000);
 let code = '';
 let error = '';
 if (!tab) {
  code = 'AI_TAB_CLOSED';
  error = provider + ' 작업 탭이 닫혔습니다.';
 } else if (tab.status === 'complete' && tab.url && !tab.url.startsWith(providerOrigin(provider))) {
  code = 'AI_TAB_LEFT_PROVIDER';
  error = provider + ' 작업 탭이 다른 사이트로 이동했습니다.';
 } else if (timedOut) {
  code = 'AI_RESPONSE_TIMEOUT';
  error = provider + ' 응답 수집 시간이 초과되었습니다. 열린 창에서 결과를 확인해주세요.';
 }
 if (error) {
  await change({job:{...job,status:'error',code,error,ended:now()},imageQueue:[]});
  await releaseGeminiTab(job.tabId);
  await generationTrace(job,provider+' 수집 중단',job.stage,{code});
  return;
 }
 const ping = await chrome.tabs.sendMessage(job.tabId,{type:'BUJA_PING'},{frameId:0}).catch(() => null);
 if (ping?.running !== job.id && ping?.reporting !== job.id) {
  await generationTrace(job,provider+' 수집기 재확인 대기',job.stage,{code:'AI_COLLECTOR_PENDING'});
 }
}
chrome.alarms.onAlarm.addListener(alarm => {
 if (alarm.name === 'buja-watchdog') void serial(checkGeneration);
});
