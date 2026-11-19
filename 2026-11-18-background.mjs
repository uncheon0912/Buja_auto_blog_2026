import {seriesNames,seriesDirection,VERSION,busy,text,formOf,draftOf,parseDraft,articlePrompt,imagePrompt,imageOverlayText,thumbnailOverlayText,imageSeriesStyle,planImageBatch,backupOf,validateImage,validRepo,newer} from './2026-11-18-core.mjs';
import {putAsset,getData} from './2026-11-18-assets.mjs';
import {connectionFor, recoverTransfer, connectEditor, disconnectEditor, focusConnected, invalidateEditor, sendDraft} from './2026-11-18-transfer.mjs';
const defaults={form:formOf(),draft:draftOf(),images:[],reference:null,history:[],logs:[],job:null,imageQueue:[],aiTabId:null,settings:{repo:''},onboarded:false};
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
 return trace(event,{operationId:job.batchId || job.id,requestId:job.id,kind:job.kind,stage,
  source:'background',...(job.kind==='image' ? {photoIndex:job.photoIndex,expectedPhotos:job.batchCount} : {}),...details});
}
async function snapshot(reason,s=null){s ||= await read();if(!s.draft.title&&!s.images.length)return;await change({history:[{id:crypto.randomUUID(),at:now(),reason,form:s.form,draft:s.draft,images:s.images,reference:s.reference},...s.history].slice(0,30)});}
const geminiOrigin = 'https://gemini.google.com/';
async function releaseGeminiTab(tabId) {
 if (Number.isInteger(tabId)) await chrome.tabs.update(tabId, {autoDiscardable: true}).catch(() => {});
}
async function closeFinishedGemini(job) {
 const tab = await chrome.tabs.get(job.tabId).catch(() => null);
 if (tab && tab.windowId === job.windowId && tab.url?.startsWith(geminiOrigin)) {
  try {
   await chrome.tabs.remove(tab.id);
   return;
  } catch { /* The work tab may have been closed manually. */ }
 }
 await releaseGeminiTab(job.tabId);
}
async function openGeminiWindow() {
 try {
  const window = await chrome.windows.create({url: geminiOrigin + 'app', type: 'normal', focused: true});
  const [tab] = window?.tabs?.length ? window.tabs : window ? await chrome.tabs.query({windowId: window.id}) : [];
  if (!Number.isInteger(tab?.id)) throw Error('Gemini tab unavailable');
  await chrome.tabs.update(tab.id, {autoDiscardable: false}).catch(() => {});
  return tab;
 } catch {
  throw Object.assign(new Error('새 Gemini 창을 열지 못했습니다. Chrome 창과 인터넷 연결을 확인해주세요.'), {code: 'GEMINI_CONNECTION'});
 }
}
async function start(job,attachments=[]){
 await change({job});
 try{const r=await chrome.tabs.sendMessage(job.tabId,{type:'BUJA_START',job,attachments},{frameId:0});if(!r?.ok)throw Error(r?.error||'Gemini가 요청을 받지 못했습니다.');}
 catch(e){
  const error = job.kind === 'article' ? Object.assign(new Error('Gemini에 요청을 전달하지 못했습니다. 열린 탭에서 연결을 확인한 뒤 초안 작성을 다시 눌러주세요.'), {code:'GEMINI_CONNECTION'}) : e;
  await change({job:{...job,status:'error',error:error.message,code:error.code,ended:now()},imageQueue:[]});
  await log('연결 실패',error.message);
  throw error;
 }
}
async function waitGemini(tabId) {
 let inspected = false;
 let attemptedInjection = false;
 let status;
 function fail(message) {
  return Object.assign(new Error(message), {code: 'GEMINI_CONNECTION'});
 }
 for (let attempt = 0; attempt < 40; attempt++) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) throw fail('Gemini 탭이 닫혔습니다. 초안 작성을 다시 눌러주세요.');
  if (attempt > 0 && tab.status === 'complete' && !tab.url?.startsWith(geminiOrigin)) {
   throw fail('Gemini가 로그인 또는 오류 화면으로 이동했습니다. 열린 탭에서 화면을 확인한 뒤 초안 작성을 다시 눌러주세요.');
  }
  try {
   status = await chrome.tabs.sendMessage(tabId, {type: 'BUJA_PING'}, {frameId: 0});
   inspected = true;
   if (status?.ready && !status.busy && !status.running) return;
  } catch {
   if (!attemptedInjection && tab.status === 'complete' && tab.url?.startsWith(geminiOrigin)) {
    attemptedInjection = true;
    await chrome.scripting.executeScript({
     target: {tabId}, files: ['2026-11-18-gemini.js']
    }).catch(() => {});
   }
  }
  await new Promise(resolve => setTimeout(resolve, 250));
 }
 if (status?.busy || status?.running) {
  throw fail('Gemini가 다른 응답을 생성하고 있습니다. 생성이 끝난 뒤 초안 작성을 다시 눌러주세요.');
 }
 if (!inspected) throw fail('Gemini와 연결하지 못했습니다. 열린 Gemini 탭에서 페이지가 로드됐는지 확인해주세요.');
 throw fail('Gemini 입력창이 준비되지 않았습니다. 열린 Gemini 탭에서 직접 로그인한 뒤 초안 작성을 다시 눌러주세요.');
}
async function beginArticle(msg,s){
 if(busy(s.job))throw Error('진행 중인 작업을 기다리거나 수집을 중단해주세요.');
 const form=formOf(msg.form);const photos=s.images.filter(x=>x.source==='upload'&&x.draftId===s.draft.id);if(form.mode==='photo'&&!photos.length)throw Error('내 사진으로 글쓰기에서는 사진을 먼저 추가해주세요.');
 const prompt=articlePrompt(form,msg.revision?s.draft:null,msg.revision,photos);
 const attachments=[];if(form.mode==='photo'){if(photos.reduce((n,p)=>n+p.size,0)>20*1024*1024)throw Error('AI에 첨부할 사진 전체 용량을 20MB 이하로 줄여주세요.');for(const p of photos)attachments.push({name:p.name,data:await getData(p.id)});}
 let job = {id:crypto.randomUUID(), kind:'article', status:'preparing', stage:'connecting', started:now(), prompt};
 await change({job, form, imageQueue:[]});
 await generationTrace(job,'Gemini 초안 연결 시작','connect',{promptLength:prompt.length,attachmentCount:attachments.length});
 try {
  const tab = await openGeminiWindow();
  job = {...job, tabId:tab.id, windowId:tab.windowId};
  await change({job, aiTabId:tab.id});
  await waitGemini(tab.id);
  job = {...job, status:'running', stage:'request', requested:now()};
  await start(job,attachments);
  await generationTrace(job,'Gemini 초안 요청 전달','request');
 } catch (error) {
  await generationTrace(job,'Gemini 초안 요청 실패',job.stage,{code:error.code || 'DRAFT_REQUEST_FAILED'});
  await change({job:{...job,status:'error',error:error.message,code:error.code,ended:now()}});
  await releaseGeminiTab(job.tabId);
  throw error;
 }
 await log('초안 생성 요청',form.topic).catch(()=>{});
 return {jobId:job.id};
}
async function beginImages(items) {
 const batchId = crypto.randomUUID();
 const {draft,form} = await read();
 const visualStyle = imageSeriesStyle(form,draft);
 await trace('Gemini 이미지 배치 시작',{operationId:batchId,kind:'image',stage:'connect',source:'background.beginImages',expectedPhotos:items.length});
 let tab;
 try {
  tab = await openGeminiWindow();
  await change({aiTabId:tab.id,imageQueue:items.map((item,index)=>({...item,visualStyle,batchId,photoIndex:index + 1,batchCount:items.length}))});
  await nextImage();
 } catch (error) {
  await trace('Gemini 이미지 배치 요청 실패',{operationId:batchId,kind:'image',stage:'request',source:'background.beginImages',code:error.code || 'IMAGE_REQUEST_FAILED'});
  await change({imageQueue:[]});
  await releaseGeminiTab(tab?.id);
  throw error;
 }
}
async function nextImage(){
 const s=await read();if(busy(s.job)||!s.imageQueue.length)return;
 const [item,...remaining]=s.imageQueue;
 const tabId=s.aiTabId;
 await waitGemini(tabId);
 const {windowId}=await chrome.tabs.get(tabId);
 const attachments=s.form.referenceRequired&&s.reference?[{name:s.reference.name,data:await getData(s.reference.id)}]:[];
 const job={id:crypto.randomUUID(),kind:'image',status:'running',tabId,windowId,started:now(),draftId:s.draft.id,item,prompt:imagePrompt(s.form,{...s.draft,imageSeriesStyle:item.visualStyle},item),
  batchId:item.batchId,photoIndex:item.photoIndex,batchCount:item.batchCount};
 await change({imageQueue:remaining});await start(job,attachments);
 await generationTrace(job,'Gemini 이미지 요청 전달','request',{promptLength:job.prompt.length,attachmentCount:attachments.length,thumbnail:!!item.thumbnail});
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
  && sender.url?.startsWith(geminiOrigin);
}
async function reportArticleStage(msg, sender) {
 const {job} = await read();
 if (!ownsGeminiJob(job, msg, sender) || job.kind !== 'article') return {ignored:true};
 const allowed = msg.stage === 'waiting' && job.stage === 'request'
  || msg.stage === 'collecting' && ['request','waiting'].includes(job.stage);
 if (allowed) {
  await change({job:{...job,stage:msg.stage}});
  await generationTrace(job,msg.stage === 'waiting' ? 'Gemini 초안 응답 대기' : 'Gemini 초안 응답 수집',msg.stage,{source:'gemini-content'});
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
    if(typeof raw.text!=='string'||!raw.text.trim()||Array.from(raw.text).length>500 || !Array.isArray(raw.image_prompts)||raw.image_prompts.length!==job.count||raw.image_prompts.some(p=>typeof p!=='string'||!p.trim()))throw Error('게시글 또는 이미지 프롬프트 수를 확인해주세요.');
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
   await generationTrace(job,'Gemini 초안 응답 수신','parse',{responseLength:text(msg.text).length});
   const draft = parseDraft(msg.text);
   const images = s.images.map(x=>x.source==='upload'&&x.draftId===s.draft.id?{...x,draftId:draft.id}:x);
   await snapshot('생성 전 초안',s);
   await change({draft,images,job:{...job,status:'done',stage:'saved',ended:now()}});
   await Promise.allSettled([snapshot('Gemini 초안 생성'), generationTrace(job,'Gemini 초안 저장 완료','saved',
    {observedTextBlocks:draft.content.length,observedTags:draft.hashtags.length,plannedImages:draft.imagePrompts.length}), closeFinishedGemini(job)]);
  } catch (error) {
   const {job:latest} = await read();
   await change({job:{...latest,status:'error',error:error.message,code:error.code,raw:text(msg.text),ended:now()}});
   await releaseGeminiTab(job.tabId);
   await generationTrace(job,'Gemini 초안 처리 실패',latest.stage,{code:error.code || 'DRAFT_RESULT_FAILED'});
  }
  return {};
 }
 let imageStage = 'collect';
 try{
  if(msg.error)throw Error(text(msg.error,1200));
   if(s.draft.id!==job.draftId)throw Error('초안이 바뀌어 이미지 결과를 적용하지 않았습니다.');
   const candidate=msg.images?.[0];if(!candidate)throw Error('생성된 이미지 파일을 찾지 못했습니다. Gemini에서 내려받은 사진을 직접 선택해주세요.');
   await generationTrace(job,'Gemini 이미지 응답 수신','collect',{observedPhotos:msg.images.length});
   const id=crypto.randomUUID();
   const original=await imageData(candidate);
   const overlayText = imageOverlayText(job.item.overlayText) || (job.item.thumbnail ? thumbnailOverlayText(s.draft) : '');
   const visualStyle = imageSeriesStyle(s.form,{...s.draft,imageSeriesStyle:job.item.visualStyle});
   imageStage = 'save-image';
   const info=await putAsset(id,original);
   const image={id,...info,name:`2026-11-19-gemini-${s.images.length+1}.${info.mime==='image/jpeg'?'jpg':info.mime==='image/webp'?'webp':'png'}`,source:'gemini',draftId:job.draftId,prompt:job.item.prompt,caption:job.item.label,alt:job.item.alt||'',visualStyle,afterBlockId:job.item.afterBlockId||'',afterParagraph:job.item.afterParagraph,...placementOf(job.item.placement),thumbnail:!!job.item.thumbnail,...(overlayText?{overlayText,overlaySource:'gemini'}:{}),at:now()};
   await snapshot('이미지 추가 전',s);await change({draft:{...s.draft,imageSeriesStyle:visualStyle},images:newGeneratedImages(s.images,image),job:{...job,status:'done',ended:now()}});
   await generationTrace(job,'Gemini 원본 이미지 저장 완료','saved',{bytes:info.size,mime:info.mime,thumbnail:image.thumbnail,overlayRequested:!!overlayText,visualStyle});
   await snapshot('이미지 생성 결과');
   if (s.imageQueue.length) {
    imageStage = 'next-image';
    await nextImage();
   } else {
    await generationTrace(job,'Gemini 이미지 배치 완료','batch-done',{verifiedPhotos:job.batchCount});
    await closeFinishedGemini(job);
   }
 }catch(e){await change({job:{...job,status:'error',error:e.message,...(e.code?{code:e.code}:{}),raw:text(msg.text),ended:now()},imageQueue:[]});await releaseGeminiTab(job.tabId);
  await generationTrace(job,'Gemini 이미지 처리 실패',imageStage,{code:e.code || 'IMAGE_RESULT_FAILED'});}
 return {};
}
async function command(msg,sender){
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
  const prompt=kind==='article'?`Threads 한국어 게시글 한 개를 450자 이내 자연스러운 대화체와 짧은 단락으로 작성하세요. 경험이나 수치를 꾸미지 마세요. JSON 코드블록 하나로 {"text":"게시글","image_prompts":[]}를 반환하세요. 서로 다른 장면의 독립적인 이미지 프롬프트를 정확히 ${count}개 넣으세요. 0이면 빈 배열입니다. 스타일: ${direction}. 주제 및 요청: ${text(msg.prompt,4000)}`:`실제 이미지 한 장을 생성하세요. 설명 대신 이미지로 응답하세요. 글 자료: ${text(msg.post,500)}. 장면 소재: ${text(msg.prompt,4000)}. 최우선 제작 스타일: ${style}. ${direction}. 텍스트 또는 포스터 스타일이면 본문의 핵심 한글 문구를 정돈된 제목으로 직접 표현하세요.`;
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
 case 'SAVE':{if(msg.form)await change({form:formOf(msg.form)});if(msg.draft){if(busy(s.job))throw Error('생성 중에는 초안 편집을 기다려주세요.');await change({draft:draftOf({...msg.draft,id:s.draft.id,imageSeriesStyle:s.draft.imageSeriesStyle})});}return {};}
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
 case 'FOCUS_CONNECTED':await focusConnected(msg.windowId);return {};
 case 'TRANSFER':
 case 'RETRY_TRANSFER':{
  if(busy(s.job))throw Error('생성 중에는 전송할 수 없습니다.');
  const result = await sendDraft(msg.windowId, s, msg.type === 'RETRY_TRANSFER', trace, msg.includeDiffText === true);
  await log(result.status === 'done' ? '전송 완료' : '전송 확인 필요', result.message);
  return result;
 }
 case 'GENERATE':return beginArticle(msg,s);
 case 'GENERATE_IMAGES':{
  if(busy(s.job))throw Error('진행 중인 생성을 기다려주세요.');if(!s.draft.title||!s.draft.body)throw Error('초안을 먼저 준비해주세요.');if(s.form.referenceRequired&&!s.reference)throw Error('필수 참고 이미지를 선택해주세요.');
  const current=s.images.filter(x=>x.draftId===s.draft.id).length,count=s.form.imageCount||Math.max(1,Math.min(3,s.draft.imagePrompts.length||2));if(current+count>10)throw Error('현재 초안 사진은 최대 10장입니다. 기존 사진을 정리하거나 생성 개수를 줄여주세요.');
  await beginImages(planImageBatch(s.draft,current+count).slice(current));return {};
 }
 case 'REGENERATE_IMAGE':{
  if(busy(s.job))throw Error('진행 중인 생성을 기다려주세요.');const x=s.images.find(x=>x.id===msg.id);if(!x)throw Error('사진이 없습니다.');if(s.form.referenceRequired&&!s.reference)throw Error('필수 참고 이미지를 선택해주세요.');
  if(s.images.filter(x=>x.draftId===s.draft.id).length>=10)throw Error('새 이미지는 원본을 보존하며 추가됩니다. 사진을 먼저 9장 이하로 줄여주세요.');
  const connection = await connectionFor(msg.windowId);
  const thumbnail = currentCover(s,connection?.platform || 'naver')?.id === x.id;
  await beginImages([{label:thumbnail?'블로그 썸네일':x.caption||'수정 이미지',prompt:`${x.prompt}\n수정 요청: ${text(msg.request,3000)}`,alt:x.alt,afterBlockId:thumbnail?'':x.afterBlockId,afterParagraph:thumbnail?0:x.afterParagraph,...placementOf(x.placement),thumbnail,overlayText:thumbnail ? imageOverlayText(x.overlayText,20) || thumbnailOverlayText(s.draft) : (imageOverlayText(x.overlayText).length >= 10 ? imageOverlayText(x.overlayText) : planImageBatch({...s.draft,imagePrompts:[null,{...x,label:x.caption}]},2)[1].overlayText)}]);
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
async function setup(){await chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});await chrome.storage.session.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true});await chrome.alarms.create('buja-watchdog',{periodInMinutes:1});}
chrome.runtime.onInstalled.addListener(()=>{void setup();});chrome.runtime.onStartup.addListener(()=>{void setup();});
chrome.tabs.onUpdated.addListener((id,info)=>{
 if(info.status==='loading'||info.url) void serial(()=>invalidateEditor(id,'연결된 탭이 이동 또는 새로고침되었습니다. 다시 연결해주세요.'));
});
chrome.tabs.onRemoved.addListener(id=>{void serial(async()=>{
 await chrome.storage.session.remove('threads-dismiss:'+id);
  await invalidateEditor(id,'연결된 글쓰기 탭이 닫혔습니다.');
 const s=await read();if(busy(s.job)&&s.job.tabId===id){await change({job:{...s.job,status:'error',error:'Gemini 탭이 닫혔습니다.'},imageQueue:[]});await log('생성 연결 끊김');}
});});
chrome.windows.onRemoved.addListener(id => { void serial(() => disconnectEditor(id)); });
chrome.alarms.onAlarm.addListener(a=>{if(a.name!=='buja-watchdog')return;void serial(async()=>{const s=await read();if(!busy(s.job))return;let error='';if(Date.now()-Date.parse(s.job.started)>=(s.job.kind==='image'?330000:210000))error='응답 대기 시간이 초과되었습니다. Gemini 결과를 직접 확인해주세요.';else try{const p=await chrome.tabs.sendMessage(s.job.tabId,{type:'BUJA_PING'});if(p.running!==s.job.id)error='Gemini 탭이 이동되어 수집을 이어갈 수 없습니다.';}catch{error='Gemini 연결이 끊어졌습니다.';}if(error){await change({job:{...s.job,status:'error',error},imageQueue:[]});await releaseGeminiTab(s.job.tabId);await log('수집 중단',error);}});});
