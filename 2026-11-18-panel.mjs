import {VERSION,DEFAULT_ACCENT,busy,choices,formOf,draftOf,parseDraft,htmlOf,articlePrompt,imagePrompt,backupOf,imageTypeRatios,seriesNames} from './2026-11-18-core.mjs';
import {getBlob,getData} from './2026-11-18-assets.mjs';
import { blocksOf, fixedPhotoPosition, imageAnchor, photoPlacements, textOfBlock } from './2026-11-18-document.mjs';
import { connectionKey, transferKey, platformNames } from './2026-11-18-platforms.mjs';
import './2026-11-18-studio-appearance.mjs';
const $=id=>document.getElementById(id),keys=Object.keys(formOf()).filter(id=>id!=='chat');
let state=null,timer,pending=false,transferring=false,saves=Promise.resolve(),urls=[],galleryEpoch=0;
let draftProgress;
let draftProgressTimer;
let workingContent = [];
let editRevision = 0;
let savedRevision = 0;
const previews = new Map();
const { id: panelWindowId } = await chrome.windows.getCurrent();
const api=async(type,extra={})=>{const r=await chrome.runtime.sendMessage({type,windowId:panelWindowId,...extra});if(!r?.ok)throw Object.assign(Error(r?.error||'확장 프로그램 연결을 확인해주세요.'),{code:r?.code});return r.data;};
const notice=(s,error=false)=>{$('notice').hidden=false;$('notice').classList.toggle('error',error);$('notice').textContent=s;};
function showDraftError(message, code) {
  $('draftErrorTitle').textContent = (code === 'GEMINI_CONNECTION' || code?.startsWith('AI_')) ? 'AI 연결 실패' : '초안 응답 확인';
  $('draftErrorMessage').textContent = message;
  if (!$('draftErrorDialog').open) $('draftErrorDialog').showModal();
}
const act=async fn=>{try{await fn();}catch(e){
  notice(e.message,true);
  if (e.code === 'GEMINI_CONNECTION' || e.code?.startsWith('AI_') || e.code === 'DRAFT_RESPONSE') showDraftError(e.message,e.code);
}};
const click=(id,fn)=>$(id).addEventListener('click',()=>act(fn));
for (const key of ['tone','length','articleType','preset','ratio','imageType']) {
  for (const value of choices[key]) {
    const option = document.createElement('option');
    const recommended = key === 'imageType' && imageTypeRatios[value];
    option.value = value;
    option.textContent = recommended ? `${value} · 권장 ${recommended}` : value === '3:4' ? '3:4 (인스타 카드뉴스)' : value;
    $(key).append(option);
  }
}
function renderRatioDefault() {
  const ratio = imageTypeRatios[$('imageType').value];
  $('ratio').options[0].textContent = ratio ? `유형 권장 비율 · ${ratio}` : '기본값 유지';
}
const radios=[...document.querySelectorAll('input[name="series"]')];
for(const radio of radios) radio.onchange=()=>{
 $('imageType').value=radio.value;
 for(const type of ['input','change']) $('imageType').dispatchEvent(new Event(type,{bubbles:true}));
};
$('imageType').addEventListener('input',renderRatioDefault);
const getForm=()=>formOf(Object.fromEntries(keys.map(k=>[k,$(k).type==='checkbox'?$(k).checked:$(k).value])));
const getDraft=()=>draftOf({...state?.draft,thumbnailText:state?.draft?.title===$('draftTitle').value?state.draft.thumbnailText:'',title:$('draftTitle').value,summary:$('summary').value,hashtags:$('hashtags').value.split(/\s+/).filter(Boolean),body:$('draftBody').value,content:workingContent});
function fillForm(f){f=formOf(f);for(const k of keys){if($(k).type==='checkbox')$(k).checked=!!f[k];else $(k).value=f[k];}sourceView();renderRatioDefault();}
function fillDraft(d) {
  $('draftTitle').value = d.title;
  $('draftBody').value = d.body;
  $('summary').value = d.summary;
  $('hashtags').value = d.hashtags.join(' ');
  workingContent = structuredClone(d.content || []);
  renderBlockFields();
  renderPreview();
}
function renderBlockFields() {
  const fields = $('blockFields');
  fields.replaceChildren();
  fields.hidden = !workingContent.length;
  $('draftBody').hidden = !!workingContent.length;
  document.querySelector('label[for="draftBody"]').hidden = !!workingContent.length;
  const labels = {paragraph:'문단',heading:'소제목',blockquote:'인용',callout:'강조',list:'목록','ordered-list':'순서 목록',checklist:'체크리스트',faq:'FAQ'};
  for (const [index, block] of workingContent.entries()) {
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = (index + 1) + '. ' + labels[block.type];
    group.append(legend);
    const addField = (object, key, name) => {
      const label = document.createElement('label');
      const input = document.createElement('textarea');
      input.rows = key === 'answer' || key === 'text' && block.type === 'paragraph' ? 3 : 1;
      input.maxLength = 8000;
      input.value = object[key] || '';
      input.addEventListener('input', () => {
        object[key] = input.value;
        $('draftBody').value = getDraft().body;
        changedDraft();
      });
      label.append(name, input);
      group.append(label);
    };
    const addItems = (items, depth = 0) => items.forEach((item, index) => {
      addField(item, 'text', '항목 ' + (index + 1) + (depth ? ' · 하위 항목' : ''));
      if (item.children?.length) addItems(item.children, depth + 1);
    });
    if (block.items) addField(block, 'text', '제목');
    if (block.type === 'faq') block.items.forEach(item => { addField(item, 'question', '질문'); addField(item, 'answer', '답변'); });
    else if (block.items) addItems(block.items);
    else {
      if (block.type === 'callout') addField(block, 'title', '강조 제목');
      addField(block, 'text', '내용');
    }
    fields.append(group);
  }
}
function sourceView(){
 const articleOnly = $('useArticleReference').checked;
 for (const id of ['source','topic','audience','keywords','notes']) $(id).disabled = articleOnly;
 $('searchBox').hidden = articleOnly || $('source').value === 'direct';
}
function renderPreview() {
  if (!state) return;
  const draft = getDraft();
  const images = state.images.filter(image => image.draftId === draft.id);
  const blocks = blocksOf(draft).filter(block => textOfBlock(block).trim());
  const platform = state.connection?.platform || 'naver';
  $('preview').innerHTML = draft.title || draft.body
    ? htmlOf(draft, getForm(), { preview: true, platform })
    : '<p class="empty">생성한 초안이 여기에 표시됩니다. 수정하기에서 직접 작성할 수도 있습니다.</p>';
  const review=$('draftReview');
  review.hidden=!draft.reviewNotes.length;
  review.textContent=draft.reviewNotes.length?'초안 검토 필요 · '+draft.reviewNotes.join(' / '):'';
  $('jsonPreview').textContent = JSON.stringify({
    ...draft,
    images: state.images.map(image => ({
      name: image.name, caption: image.caption, afterParagraph: image.afterParagraph, current: image.draftId === draft.id
    }))
  }, null, 2);
  const current = images.length;
  const previous = state.images.length - current;
  const invalidPositions = photoPlacements(images, blocks, platform).filter(image => image.anchor === undefined).length;
  $('placementWarning').hidden = !invalidPositions;
  $('placementWarning').textContent = invalidPositions ? '위치가 바뀐 사진 ' + invalidPositions + '장. 갤러리에서 다시 배치해주세요.' : '';
  $('galleryStatus').textContent = state.images.length ? '전송할 사진 ' + current + '장' + (previous ? ' · 이전 초안 사진 ' + previous + '장' : '') : '';
  renderTransfer(current);
}
function renderDraftProgress() {
  const job = state?.job;
  if (job?.kind === 'article' && (draftProgress?.jobId === job.id
    || (busy(job) && draftProgress?.previousId !== job.id)
    || (draftProgress?.status === 'connecting' && draftProgress.previousId !== job.id)
    || !draftProgress)) {
    if (!draftProgress || (draftProgress.jobId && draftProgress.jobId !== job.id)) {
      draftProgress = {started: Date.parse(job.started) || Date.now(), percent: 1};
    }
    draftProgress.jobId = job.id;
    draftProgress.status = job.status;
    draftProgress.stage = job.stage || (job.status === 'preparing' ? 'connecting' : 'waiting');
  }
  if (!draftProgress) return;
  const {status, stage, started} = draftProgress;
  const elapsed = Math.max(0, Date.now() - started);
  if (status === 'connecting' || status === 'preparing') draftProgress.percent = Math.min(11, 1 + Math.floor(elapsed / 900));
  if (status === 'running') {
    const estimate = stage === 'request' ? 12 : stage === 'saving' ? 99
      : Math.min(96, Math.max(stage === 'collecting' ? 25 : 15, 12 + Math.floor(elapsed / 1700)));
    draftProgress.percent = Math.max(draftProgress.percent, estimate);
  }
  if (status === 'done') draftProgress.percent = 100;
  const labels = {
    connecting: 'AI 창 연결', preparing: 'AI 창 연결',
    done: '초안 저장 완료', error: '초안 작성 중단 · 오류 확인', cancelled: '초안 수집 중단'
  };
  const stageLabels = {
    request: 'AI 요청 전달 중', waiting: '요청 전달 완료 · 응답 대기',
    collecting: 'AI 응답 수집 중', saving: '초안 확인 및 저장 중'
  };
  const description = labels[status] || stageLabels[stage];
  const label = $('draftProgressLabel');
  const meter = $('draftProgress');
  if (label.textContent !== description) label.textContent = description;
  meter.dataset.status = status;
  meter.hidden = false;
  const inProgress = status === 'connecting' || status === 'preparing' || status === 'running';
  const estimateLabel = inProgress && ['waiting','collecting'].includes(stage) ? '예상 ' : '';
  $('draftProgressPercent').textContent = `${estimateLabel}${draftProgress.percent}%`;
  $('draftProgressBar').value = draftProgress.percent;
  if (inProgress) {
    draftProgressTimer ??= setInterval(renderDraftProgress, 350);
  } else {
    clearInterval(draftProgressTimer);
    draftProgressTimer = undefined;
  }
}

function renderJob(){renderDraftProgress();const running=pending||draftProgress?.status==='connecting'||busy(state?.job)||transferring;for(const id of ['generate','revise','generateImages','applyManual','draftTitle','draftBody','summary','hashtags','photoFiles','referenceFile','import','clearImages','clearDraft','loadTestDraft'])$(id).disabled=!!running;for(const e of document.querySelectorAll('#gallery button,#gallery input,#gallery textarea'))e.disabled=!!running;
 for(const field of document.querySelectorAll('#blockFields textarea,#gallery select')) field.disabled=running||transferring;
 const imageJob=state?.job?.kind==='image';
 $('stopImages').hidden=!imageJob || !busy(state.job);
 $('resumeImages').hidden=busy(state?.job) || state?.remainingImages?.draftId!==state?.draft?.id || !state?.remainingImages?.items?.length;
 $('imageFeedback').textContent=imageJob && ['error','cancelled'].includes(state.job.status) ? state.job.error || '확장의 수집과 대기열을 중지했습니다. 사이트의 생성 상태는 열린 창에서 확인하세요.' : '';
 $('recoverComposer').hidden=!(state?.job?.kind==='article' && state.job.status==='error' && state.job.blockedComposerDigest);
 $('recoverComposer').disabled=!!running;
 $('cancel').hidden=!busy(state?.job);const j=state?.job;
 $('jobState').textContent=j?.status==='running'?`${j.kind==='image'?'이미지 응답을 기다립니다.':'초안 진행 단계는 상단에서 확인할 수 있습니다.'}${state.imageQueue.length?` 남은 이미지 ${state.imageQueue.length}장.`:''}`:pending||j?.status==='preparing'?'AI 탭을 준비하고 입력창을 확인하는 중입니다.':j?.status==='error'?j.error:j?.status==='cancelled'?'수집을 중단했습니다. AI 자체 생성은 해당 화면에서 중지할 수 있습니다.':j?.status==='done'?'결과를 가져왔습니다. 내용을 확인해주세요.':'주제와 조건을 입력하면 시작할 수 있습니다.';
 $('referenceName').textContent=state?.reference?`참고 사진: ${state.reference.name}`:'선택된 참고 사진 없음';
 const customPrompt = $('preferImagePrompt').checked;
 $('preferImagePrompt').disabled = !!running;
 const storedStyle = state?.draft?.imageSeriesStyle;
 const seriesStyle = seriesNames.includes(storedStyle) ? storedStyle : '';
 for(const radio of radios){radio.checked=radio.value===(seriesStyle || $('imageType').value);radio.disabled=Boolean(running || seriesStyle || customPrompt)}
 $('generateImages').textContent=state?.job?.kind==='image' && busy(state.job) ? `이미지 생성 중 · ${state.job.photoIndex}/${state.job.batchCount}장`:'이미지 생성';
 $('imageType').disabled = !!running || !!seriesStyle || customPrompt;
 $('imageSeriesStyle').textContent = customPrompt ? '사용자 프롬프트 우선 적용' : seriesStyle ? `이 글의 이미지 스타일 · ${seriesStyle}` : '선택한 스타일을 이 글의 모든 생성 이미지에 적용합니다.';
}
function renderConnection() {
  const connection = state?.connection;
  const connected = Boolean(connection && !connection.invalid);
  for (const id of ['connectTop','connectBottom','helpConnect']) {
    const button = $(id);
    button.classList.toggle('is-connected', connected);
    button.textContent = connected ? '✓ 연결됨' : id === 'connectTop' ? '① 현재 탭 연결' : '① 현재 탭 연결하기';
    button.title = connected ? '현재 선택한 글쓰기 탭에 다시 연결' : '';
  }
  $('connectionBadge').textContent = connected ? '연결됨 · ' + connection.platformName : '연결 전';
  $('connectionBadge').classList.toggle('invalid', !!connection?.invalid);
  const message = connected ? (connection.title || connection.platformName) + ' · ' + new URL(connection.url).hostname
    : connection?.reason || '옆에 새 글쓰기 화면을 열고 현재 탭을 연결하세요.';
  $('connectionText').textContent = message;
  $('targetText').textContent = message;
  $('focusConnected').disabled = !connected;
  $('disconnect').disabled = !connection;
  renderTransfer();
}

function renderTransfer(photoCount = state?.images.filter(image => image.draftId === state.draft.id).length || 0) {
  const connected = state?.connection && !state.connection.invalid;
  const draftReady = Boolean($('draftTitle').value.trim() && $('draftBody').value.trim());
  const generating = pending || busy(state?.job);
  const progress = state?.transfer;
  const running = transferring || progress?.status === 'running';
  const hasResult = !!progress && ['done','review','retryable'].includes(progress.status);
  const button = $('transfer');
  button.disabled = !connected || !draftReady || generating || running || hasResult || !$('placementWarning').hidden;
  button.setAttribute('aria-busy', String(running));
  button.textContent = running ? '연결된 글쓰기창으로 전송 중…' : '④ 연결된 글쓰기창에 넣기';
  $('retryTransfer').hidden = !connected || progress?.status !== 'retryable';
  $('retryTransfer').disabled = running || generating || !$('placementWarning').hidden;
  const failed = connected && ['review','retryable','blocked'].includes(progress?.status);
  $('restartTransfer').hidden = !failed;
  $('restartTransfer').disabled = running || generating || !draftReady || !$('placementWarning').hidden;
  $('viewTransfer').hidden = !connected || !hasResult;
  let status = '보낼 내용은 제목과 본문' + (photoCount ? ', 사진 ' + photoCount + '장' : '') + '입니다.';
  if (connected && (running || hasResult || progress?.status === 'blocked')) status = progress?.message || '입력 결과를 확인하고 있습니다.';
  else if (generating) status = '진행 중인 생성이 끝나면 전송할 수 있습니다.';
  else if (!connected) status = '① 현재 탭 연결에서 글쓰기창을 지정하세요.';
  else if (!draftReady) status = '제목과 본문을 작성하면 전송할 수 있습니다.';
  if (failed && !running) status += '\n오른쪽 편집기에서 본문과 삽입된 사진을 지운 뒤 ‘본문 비운 뒤 다시 입력’을 눌러주세요.';
  if ($('transferStatus').textContent !== status) $('transferStatus').textContent = status;
}
const time=s=>new Intl.DateTimeFormat('ko-KR',{dateStyle:'short',timeStyle:'short',timeZone:'Asia/Seoul'}).format(new Date(s));
function renderHistory(){$('historyList').replaceChildren();if(!state.history.length)$('historyList').textContent='아직 보관된 기록이 없습니다.';for(const h of state.history){const div=document.createElement('div');div.className='history-item';const title=document.createElement('strong'),at=document.createElement('time'),b=document.createElement('button');title.textContent=h.draft.title||'사진 작업';at.textContent=`${time(h.at)} · ${h.reason} · 사진 ${h.images?.length||0}장`;b.textContent='이 작업 복원';b.disabled=busy(state.job);b.addEventListener('click',()=>act(async()=>{if(!confirm('현재 작업을 보관하고 선택한 기록으로 복원할까요?'))return;await flush();await api('RESTORE',{id:h.id});await sync(true);notice('초안과 사진을 복원했습니다.');}));div.append(title,at,document.createElement('br'),b);$('historyList').append(div);}}
function diagnosticDetails(log) {
 if (!log.diagnostic) return '';
 const {excerpt,...fields} = log.diagnostic;
 return JSON.stringify($('includeDiffText').checked && excerpt ? {...fields,excerpt} : fields,null,2);
}
function renderLogs(){
 $('logs').textContent=(state?.logs||[]).map(log=>{
  const detail = diagnosticDetails(log) || log.detail;
  return `${time(log.at)} · ${log.event}${detail?'\n'+detail:''}`;
 }).join('\n\n')||'아직 실행 기록이 없습니다.';
}
function diagnosticReport() {
 const entries = (state?.logs||[]).filter(log=>log.diagnostic).toReversed();
 const latestFailure = entries.findLast(log=>log.diagnostic.status === 'review' || log.diagnostic.status === 'retryable'
  || /실패|오류|중단/.test(log.event));
 const header = [`부사연 슈퍼노바 SNS 진단 리포트 · ${VERSION}`, `생성 시각 UTC ${new Date().toISOString()}`,
  latestFailure ? `최근 오류 ${latestFailure.event} · ${latestFailure.diagnostic.code || ''}` : '',
  latestFailure?.diagnostic.operationId ? `전송 또는 생성 ID ${latestFailure.diagnostic.operationId}` : ''].filter(Boolean);
 return [...header,'',...entries.map(log=>`${log.at} · ${log.event}\n${diagnosticDetails(log)}\n`),
  ...(entries.length ? [] : ['아직 상세 진단 기록이 없습니다.'])].join('\n');
}
async function sync(fill=false){const next=await api('STATE');const {job}=await chrome.storage.local.get('job');state={...next,job:job??next.job};if(fill){fillForm(state.form);fillDraft(state.draft);$('repo').value=state.settings.repo;}renderConnection();renderJob();renderHistory();renderLogs();await renderGallery();renderPreview();}
function persist(){if(!state)return Promise.resolve();const revision=editRevision,form=getForm(),draft=busy(state.job)||pending?null:getDraft();const next=saves.catch(()=>{}).then(()=>api('SAVE',{form,...(draft?{draft}:{})}));saves=next;return next.then(()=>{savedRevision=Math.max(revision,savedRevision);$('saveState').textContent='현재 입력과 초안을 자동 저장했습니다.';},e=>{$('saveState').textContent='저장 실패: '+e.message;throw e;});}
async function flush(){clearTimeout(timer);await persist();}
function changedDraft(){editRevision++;sourceView();renderPreview();clearTimeout(timer);$('saveState').textContent='저장 중…';timer=setTimeout(()=>act(persist),450);}
$('preferImagePrompt').addEventListener('input',renderJob);
for(const id of [...keys,'draftTitle','draftBody','summary','hashtags'])$(id).addEventListener('input',changedDraft);
async function renderGallery(){
 const epoch=++galleryEpoch;
 const gallery=$('gallery');
 const scrollPosition=gallery.scrollTop;
 const expanded=new Set([...gallery.querySelectorAll('.image-card-details[open]')]
  .map(details=>details.closest('.image-card').dataset.imageId));
 urls.forEach(url=>URL.revokeObjectURL(url));urls=[];previews.clear();gallery.replaceChildren();
 if(!state.images.length){
  const empty=document.createElement('p');empty.className='hint gallery-empty';
  empty.textContent='사진 파일을 추가하거나 AI 이미지를 생성해주세요.';
  gallery.append(empty);return;
 }
 const blocks=blocksOf(getDraft()).filter(block=>textOfBlock(block).trim());
 const naver = (state.connection?.platform || 'naver') === 'naver';
 const current = state.images.filter(image => image.draftId === state.draft.id);
 const thumbnail = naver ? photoPlacements(current, blocks, 'naver')[0] : current.find(image => image.thumbnail);
 const photos = [...(thumbnail ? [thumbnail] : []), ...current.filter(image => image.id !== thumbnail?.id),
  ...state.images.filter(image => image.draftId !== state.draft.id)];
 for(const image of photos){
 const isThumbnail = thumbnail?.id === image.id;
 const card=document.createElement('article');card.className='image-card';card.dataset.imageId=image.id;
 const img=document.createElement('img');img.alt=image.alt||image.caption||image.name;img.loading='lazy';img.decoding='async';
 try{
  const blob=await getBlob(image.id);
  if(epoch!==galleryEpoch)return;
  const url=URL.createObjectURL(blob);urls.push(url);previews.set(image.id,url);img.src=url;
 }catch{
  if(epoch!==galleryEpoch)return;
  img.alt='원본을 찾지 못했습니다. 사진 파일을 다시 선택해주세요.';
 }
 const content=document.createElement('div');content.className='image-card-content';
 const title=document.createElement('strong');title.className='image-card-title';
 title.textContent=image.caption?.trim()||image.alt?.trim()||(image.thumbnail?'블로그 썸네일':image.name);
 const meta=document.createElement('p');meta.className='image-card-meta';
 meta.textContent=[isThumbnail?'썸네일':'',image.overlaySource==='gemini'?'한글 문구 요청':image.overlayText?'기존 한글 문구':'',
  image.source==='gemini'?'AI 생성':'내 사진',
  image.draftId===state.draft.id?'':'이전 초안 · 전송 제외'].filter(Boolean).join(' · ');
 content.append(title,meta);
 if(image.prompt?.trim()){
  const excerpt=document.createElement('p');excerpt.className='image-card-prompt';excerpt.textContent=image.prompt;
  content.append(excerpt);
 }
 const details=document.createElement('details');details.className='image-card-details';details.open=expanded.has(image.id);
 const summary=document.createElement('summary');summary.textContent='사진 설정';details.append(summary);
 const caption=document.createElement('textarea');caption.value=image.caption;caption.maxLength=1000;caption.setAttribute('aria-label','사진 설명');
 const position=document.createElement('select');position.setAttribute('aria-label','삽입할 사진 위치');
 if (isThumbnail) {
   position.add(new Option('제목 바로 아래', ''));
 } else {
   if (naver) position.add(new Option('자동 배치 · 문단마다 한 장', '?auto'));
   position.add(new Option('본문 맨 앞', ''));
   blocks.forEach((block,index) => position.add(new Option(
     (index + 1) + '. ' + textOfBlock(block).replace(/\s+/g,' ').slice(0,52) + ' 뒤', block.id
   )));
   const anchor = imageAnchor(image, blocks);
   if (anchor === undefined) position.add(new Option('새 위치 선택 필요', '?missing'));
   position.value = naver && !fixedPhotoPosition(image) ? '?auto' : anchor ?? '?missing';
 }
 const prompt=document.createElement('textarea');prompt.value=image.prompt;prompt.maxLength=3000;prompt.setAttribute('aria-label','이미지 프롬프트');
 const label=(name,field)=>{const wrapper=document.createElement('label');wrapper.append(name,field);details.append(wrapper);};
 label('사진 설명 · AI에 전달',caption);label('삽입할 문단·소제목',position);label('이미지 생성·수정 프롬프트',prompt);
 const quick=document.createElement('div');quick.className='row';
 const row=document.createElement('div');row.className='row';
 const button=(name,fn,group=row)=>{
  const element=document.createElement('button');element.type='button';element.textContent=name;
  element.addEventListener('click',()=>act(fn));group.append(element);return element;
 };
 const save=async(adopt=false)=>{
   if(position.value === '?missing') throw Error('이 사진을 넣을 문단이나 소제목을 선택해주세요.');
   const afterIndex = blocks.findIndex(block => block.id === position.value) + 1;
   await flush();
   await api('EDIT_IMAGE',{id:image.id,caption:caption.value,prompt:prompt.value,
     ...(isThumbnail ? {} : {placement:position.value === '?auto' ? 'auto' : 'fixed', afterBlockId:afterIndex ? position.value : '', afterParagraph:afterIndex}),adopt});
   await sync();
 };
 button('설정 저장',()=>save());
 if (isThumbnail && image.overlaySource !== 'gemini' && state.draft.title) button('AI로 썸네일 다시 만들기',async()=>{
  await flush();
  await api('REGENERATE_IMAGE',{id:image.id,request:'현재 글의 핵심을 보여 주는 썸네일 장면과 한글 제목을 새로 완성해주세요.'});
  await sync();
  notice('AI에 한글 문구가 들어간 썸네일을 요청했습니다.');
 },quick);
 const insertButton=button('본문에 삽입',async()=>{
   insertButton.disabled=true;
   try{
     await api('INSERT_GALLERY_PHOTO',{id:image.id});
     insertButton.textContent='삽입 완료';
     notice('선택한 사진을 본문에 삽입했습니다.'+(image.source==='gemini'?' 해당 사진의 AI 활용 설정을 확인해 주세요.':''));
   }finally{insertButton.disabled=false;}
 },quick);
 button('파일 교체',async()=>{const picker=document.createElement('input');picker.type='file';picker.accept='image/png,image/jpeg,image/webp';picker.onchange=()=>act(async()=>{if(!picker.files[0])return;await save();await upload(picker.files[0],false,image.id);});picker.click();},quick);
 const copyPrompt=()=>{
   if(!prompt.value.trim())throw Error('복사할 이미지 프롬프트가 없습니다.');
   const draft = getDraft();
   if (image.draftId !== draft.id) return copy(prompt.value);
   return copy(imagePrompt(getForm(), draft, {...image, label:caption.value || image.name, prompt:prompt.value}));
 };
 button('프롬프트 복사',copyPrompt,image.prompt?.trim()?quick:row);
 button('이미지 내려받기',async()=>download(await getBlob(image.id),`2026-11-18-${image.name.replace(/[^\p{L}\p{N}_.-]/gu,'_')}`));
 if(image.draftId===state.draft.id) button('이 이미지만 다시 생성',async()=>{
  const request=window.prompt('바꾸고 싶은 부분이 있으면 입력하세요. 비워 두면 같은 조건으로 다시 생성합니다.');
  if(request===null)return;
  await save();
  await api('REGENERATE_IMAGE',{id:image.id,request:request.trim()});
  await sync();
 },quick);
 const replacement = state.job?.item?.replaceId===image.id ? state.job.replacement : null;
 if(replacement){
  try{
   const blob=await getBlob(replacement.id);
   if(epoch!==galleryEpoch)return;
   const previewURL=URL.createObjectURL(blob);
   urls.push(previewURL);
   const preview=document.createElement('img');
   preview.src=previewURL;preview.alt='교체 후보 이미지';
   const controls=document.createElement('div');controls.className='row';
   button('새 이미지로 교체',async()=>{await api('APPLY_IMAGE_REPLACEMENT',{id:image.id});await sync();},controls);
   button('원본 유지',async()=>{await api('DISCARD_IMAGE_REPLACEMENT',{id:image.id});await sync();},controls);
   content.append(preview,controls);
  }catch{notice('교체 후보 이미지를 미리 볼 수 없습니다.',true);}
 }
 if(image.draftId!==state.draft.id)button('현재 초안에 사용',()=>save(true));
 const remove=button('제거',async()=>{if(!confirm('갤러리에서 제거할까요? History에서 원본을 복원할 수 있습니다.'))return;await api('REMOVE_IMAGE',{id:image.id});await sync();});
 remove.className='danger';details.append(row);content.append(quick,details);card.append(img,content);gallery.append(card);
 }
 if(epoch===galleryEpoch){gallery.scrollTop=scrollPosition;renderJob();renderPreview();}
}
async function upload(file,reference=false,replaceId=null){if(!file)return;if(file.size>8*1024*1024)throw Error('장당 8MB 이하 사진을 선택해주세요.');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(Error('파일 읽기 실패'));r.readAsDataURL(file);});await api('ADD_IMAGE',{data,name:file.name,reference,replaceId});await sync();notice(reference?'참고 사진을 저장했습니다.':'사진을 갤러리에 추가했습니다. 설명과 문단 위치를 설정해주세요.');}
$('photoFiles').addEventListener('change',()=>act(async()=>{await flush();for(const file of $('photoFiles').files)await upload(file);$('photoFiles').value='';}));
$('referenceFile').addEventListener('change',()=>act(async()=>{await upload($('referenceFile').files[0],true);$('referenceFile').value='';}));
async function connect(){
 const [tab]=await chrome.tabs.query({active:true,windowId:panelWindowId});
 if(!tab?.id) throw Error('이 창에서 글쓰기 탭을 먼저 선택해주세요.');
 const c=await api('CONNECT',{tabId:tab.id});
 await sync();
 notice(c.platformName+' 글쓰기창을 연결했습니다.');
}
for(const id of ['connectTop','connectBottom','helpConnect'])click(id,connect);
click('openNaver',()=>api('OPEN_SITE',{platform:'naver'}));
$('mode').addEventListener('change',async()=>{if($('mode').value==='threads'){ $('mode').value=state.form.mode; await api('OPEN_SITE',{platform:'threads'}); }});
click('helpOpenNaver',()=>api('OPEN_SITE',{platform:$('platform').value}));
$('platform').addEventListener('change',()=>{$('helpOpenNaver').textContent=($('platform').value==='threads'?'Threads':platformNames[$('platform').value]||platformNames.naver)+' 열기';});
click('focusConnected',()=>api('FOCUS_CONNECTED'));click('disconnect',async()=>{await api('DISCONNECT');await sync();});
click('installGuide',async()=>{
 $('installVersion').textContent='현재 설치 버전 '+chrome.runtime.getManifest().version;
 const response=await fetch(chrome.runtime.getURL('2026-11-19-설치가이드.txt'));
 if(!response.ok)throw Error('설치 가이드를 읽을 수 없습니다.');
 $('installSteps').textContent=await response.text();
 $('installDialog').showModal();
});
click('manageExtensions',()=>chrome.tabs.create({url:'chrome://extensions/'}));
click('help',()=>$('helpDialog').showModal());for(const id of ['helpDone','closeHelp'])click(id,async()=>{$('helpDialog').close();await api('ONBOARD');});
$('helpDialog').addEventListener('cancel',()=>{void api('ONBOARD');});
async function generate(revision='',recoverJobId) {
  if (!state || pending || draftProgress?.status === 'connecting' || busy(state.job) || transferring) return;
  draftProgress = {status: 'connecting', started: Date.now(), percent: 1, previousId: state.job?.id};
  renderJob();
  try {
    await flush();
    if (pending || busy(state.job) || transferring) throw Error('진행 중인 작업을 완료한 뒤 초안을 작성해주세요.');
    if (revision && !getDraft().body.trim()) throw Error('수정할 초안을 준비해주세요.');
    pending = true;
    renderConnection();
    const request = await api('GENERATE',{form:getForm(),revision,recoverJobId});
    draftProgress.jobId = request.jobId;
    notice('AI에 초안 생성을 요청했습니다.');
    await sync();
  } catch (error) {
    draftProgress.status = 'error';
    throw error;
  } finally {
    pending = false;
    renderJob();
    renderConnection();
  }
}
$('brief').addEventListener('submit',e=>{e.preventDefault();void act(()=>generate());});click('revise',async()=>{if(!$('revision').value.trim())throw Error('수정 요청을 입력해주세요.');await generate($('revision').value);});
click('recoverComposer',async()=>{
  if(!confirm('작업 창의 현재 입력을 확인하셨나요? 해당 입력을 지우고 초안을 작성합니다.'))return;
  await generate('',state.job.id);
});
click('stopImages',async()=>{await api('CANCEL');await sync();});
click('resumeImages',async()=>{await flush();await api('RESUME_IMAGES');await sync();});
click('loadTestDraft',async()=>{
 if(pending || transferring || busy(state?.job) || state?.transfer?.status==='running')return;
 const saved=flush();
 pending=true;
 renderJob();
 try{
  await saved;
  await api('LOAD_TEST_DRAFT');
  draftProgress=undefined;
  await sync(true);
  notice('테스트용 초안과 썸네일 1장을 불러왔습니다. 연결된 빈 글쓰기창에 전송해 확인하세요.');
 }finally{
  pending=false;
  renderJob();
  renderConnection();
 }
});
click('savePrefs',async()=>{await flush();await api('SAVE_PREFS',{form:getForm()});notice('이 Chrome 프로필에 현재 설정을 저장했습니다.');});
click('generateImages',async()=>{await flush();await api('GENERATE_IMAGES');await sync();notice('최신 초안으로 이미지 생성을 시작했습니다.');});
click('cancel',async()=>{await api('CANCEL');await sync();notice('수집을 중단했습니다. AI 생성 자체는 해당 화면에서 중지해주세요.');});
click('publishedReset',async()=>{
 if(!confirm('이 글을 발행하셨나요? 현재 초안과 갤러리를 비웁니다.'))return;
 await flush();await api('PUBLISHED_RESET',{draftId:state.draft.id});await sync(true);notice('새 글을 작성할 준비가 됐습니다.');
});
click('clearDraft',async()=>{
 if(!confirm('현재 초안의 제목·본문·태그와 전송 기록을 지울까요? 이미지 갤러리와 이미 입력한 네이버 글은 보존됩니다.'))return;
 await flush();await api('CLEAR_DRAFT',{draftId:state.draft.id});$('revision').value='';$('draftEditor').hidden=true;await sync(true);notice('기존 초안을 지웠습니다.');
});
click('editDraft',()=>{$('draftEditor').hidden=!$('draftEditor').hidden;});click('closeEdit',async()=>{await flush();$('draftEditor').hidden=true;await renderGallery();notice('초안 수정을 저장했습니다.');});
click('clearArticleReference', async () => {
 for (const id of ['articleTitle','articleBody','articleSource']) $(id).value = '';
 $('useArticleReference').checked = false;
 changedDraft();
 await flush();
 notice('기사 제목·본문·출처를 초기화했습니다.');
});
click('resetAccent',()=>{$('accent').value=DEFAULT_ACCENT;renderPreview();void act(flush);});
click('save',async()=>{await flush();await api('SNAPSHOT');await sync();notice('현재 초안과 사진을 History에 보관했습니다.');});
async function copy(s){await navigator.clipboard.writeText(s);notice('클립보드에 복사했습니다.');}
function copyableDraft() {
  const draft = getDraft();
  if (!draft.title || !draft.body.trim()) throw Error('복사할 초안을 먼저 준비해주세요.');
  return draft;
}
function articleText(draft) {
  const blocks = blocksOf(draft).map(block => block.items
    ? [block.text, textOfBlock(block)].filter(Boolean).join('\n') : textOfBlock(block));
  return [draft.title, draft.summary, ...blocks, draft.hashtags.map(tag => '#' + tag).join(' ')]
    .filter(Boolean).join('\n\n');
}
click('copy',()=>copy(articleText(copyableDraft())));
click('copyHTML',async()=>{
  const draft = copyableDraft();
  const item = new ClipboardItem({
    'text/html': new Blob([htmlOf(draft,getForm())], {type:'text/html'}),
    'text/plain': new Blob([articleText(draft)], {type:'text/plain'})
  });
  await navigator.clipboard.write([item]);
  notice('서식을 포함해 복사했습니다. 글쓰기 에디터에 붙여넣으세요.');
});
click('copyPrompt',()=>copy(articlePrompt(getForm(),$('revision').value?getDraft():null,$('revision').value,state.images.filter(x=>x.source==='upload'))));
click('applyManual',async()=>{parseDraft($('manual').value);await flush();await api('APPLY_MANUAL',{text:$('manual').value});await sync(true);notice('붙여넣은 응답을 적용했습니다.');});
async function transfer(mode='TRANSFER') {
  const button = {TRANSFER:'transfer',RETRY_TRANSFER:'retryTransfer',RESTART_TRANSFER:'restartTransfer'}[mode];
  if (transferring || $(button).disabled) return;
  transferring = true;
  renderJob();
  renderTransfer();
  try {
    await flush();
    if (mode !== 'RETRY_TRANSFER') await api('SNAPSHOT');
    const result = await api(mode,{includeDiffText:$('includeDiffText').checked});
    notice(result.message, result.status !== 'done');
  } finally {
    transferring = false;
    await sync();
  }
}
click('transfer',()=>transfer());
click('retryTransfer',()=>transfer('RETRY_TRANSFER'));
click('restartTransfer',()=>transfer('RESTART_TRANSFER'));
click('viewTransfer',()=>api('FOCUS_CONNECTED'));
click('clearImages',async()=>{if(!confirm('갤러리를 비울까요? 현재 작업을 History에 보관합니다.'))return;await api('CLEAR_IMAGES');await sync();});
click('openSearch',async()=>{await flush();await api('OPEN_SEARCH');});
click('collectSearch',async()=>{if(!await chrome.permissions.request({origins:['https://search.naver.com/*']}))throw Error('검색 화면 읽기 권한이 필요합니다.');await flush();await api('COLLECT_SEARCH');await sync(true);notice('검색 화면의 참고 내용을 수집했습니다.');});
async function switchView(view) {
  await flush();
  for (const tab of document.querySelectorAll('.tab')) {
    const selected = tab.dataset.view === view;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-pressed', String(selected));
  }
  for (const name of ['write','history','settings']) $('view-'+name).hidden = name !== view;
  await sync();
}
document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => act(() => switchView(tab.dataset.view))));
click('draftProgressJump', async () => {
  if ($('view-write').hidden) await switchView('write');
  document.querySelector('.workflow a[href="#draftSection"]').click();
});
function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),15000);}
click('export',async()=>{await flush();const s=await api('STATE');if(s.images.reduce((n,x)=>n+x.size,0)>24*1024*1024)throw Error('사진 포함 백업은 총 24MB 이하로 준비해주세요. 사진은 개별 내려받기로도 보관할 수 있습니다.');const images=[];for(const x of s.images)images.push({...x,data:await getData(x.id)});download(new Blob([JSON.stringify({schema:3,version:VERSION,at:new Date().toISOString(),form:s.form,draft:s.draft,settings:s.settings,images},null,2)],{type:'application/json'}),`2026-11-18-부자글쓰기-${VERSION}-백업-${Date.now()}.json`);notice('현재 초안과 갤러리 사진 원본을 백업했습니다.');});
click('import',()=>{$('importFile').value='';$('importFile').click();});$('importFile').addEventListener('change',()=>act(async()=>{const file=$('importFile').files[0];if(!file)return;if(file.size>36*1024*1024)throw Error('36MB 이하 백업을 선택해주세요.');const payload=JSON.parse(await file.text());backupOf(payload);if(!confirm('현재 작업을 보관하고 백업의 입력·초안·갤러리·설정으로 복원할까요?'))return;await flush();await api('IMPORT',{payload});await sync(true);notice('백업을 복원했습니다. 참고 사진은 다시 선택해주세요.');}));
click('copyLogs',()=>copy(diagnosticReport()));
click('saveLogs',()=>download(new Blob([diagnosticReport()],{type:'text/plain;charset=utf-8'}),
 `${new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date())}-부자글쓰기-진단-${Date.now()}.txt`));
$('includeDiffText').addEventListener('change',renderLogs);
click('saveSettings',async()=>{await api('SETTINGS',{repo:$('repo').value});await sync();notice('설정을 저장했습니다.');});
click('update',async()=>{if(!state.settings.repo)throw Error('공개 GitHub 저장소를 먼저 설정해주세요.');if(!await chrome.permissions.request({origins:['https://api.github.com/*']}))throw Error('GitHub 권한이 필요합니다.');const r=await api('UPDATE');notice(`${r.newer?'새 버전이 있습니다':'확인한 최신 버전'}: ${r.version}\n${r.notes}`);const a=document.createElement('a');a.href=r.url;a.target='_blank';a.rel='noopener noreferrer';a.textContent='\n배포 페이지 열기';$('notice').append(a);});
chrome.storage.onChanged.addListener((changes,area)=>{
  if (!state) return;
  if (area === 'session') {
    const target=changes[connectionKey(panelWindowId)];
    const transfer=changes[transferKey(panelWindowId)];
    if (target) state.connection=target.newValue;
    if (transfer) state.transfer=transfer.newValue;
    if (target || transfer) renderConnection();
    if (target) {
      renderPreview();
      void act(renderGallery);
    }
  }
  if (area !== 'local') return;
  for (const key of ['job','imageQueue','images','history','logs','reference']) {
    if (changes[key]) state[key]=changes[key].newValue;
  }
  if (changes.draft) state.draft=changes.draft.newValue;
  const job = changes.job?.newValue;
  const generated = job?.kind === 'article' && job.status === 'done';
  const changedDraft=changes.draft && changes.draft.oldValue?.id!==changes.draft.newValue?.id;
  if(changedDraft && !state.draft.title && !state.draft.body && !state.job){
   clearInterval(draftProgressTimer);draftProgressTimer=undefined;draftProgress=undefined;
   $('draftProgress').hidden=true;
  }
  if (generated || changedDraft) fillDraft(state.draft);
  renderJob();
  renderConnection();
  if (changes.images || changes.job?.oldValue?.replacement || job?.replacement || generated || changedDraft) {
    renderPreview();
    void act(renderGallery);
  }
  if (changes.history) renderHistory();
  if (changes.logs) renderLogs();
  if (job?.status === 'error') {
    notice(job.error,true);
    if (job.raw) $('manual').value=job.raw;
    if (job.code === 'DRAFT_RESPONSE') showDraftError(job.error,job.code);
  }
});
window.addEventListener('pagehide',()=>{clearTimeout(timer);clearInterval(draftProgressTimer);if(editRevision!==savedRevision)void persist().catch(()=>{});urls.forEach(x=>URL.revokeObjectURL(x));});
await act(async()=>{await api('RESTORE_PREFS');await sync(true);if(!state.onboarded)$('helpDialog').showModal();});
