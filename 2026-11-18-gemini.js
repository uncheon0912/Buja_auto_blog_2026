(()=>{
 if(globalThis.__bujaStudioV2)return;globalThis.__bujaStudioV2=true;
 const isChatGPT=location.hostname==='chatgpt.com';
 let task=null;
 const reporting=new Set();
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const visible=el=>!!el&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';
 const normalizeComposer=value=>String(value||'').replace(/\s+/gu,' ').trim();
 async function composerDigest(value){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(normalizeComposer(value)));
  return Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
 }
 function legacyArticle(value){
  if(!value.startsWith('한국어 네이버 블로그 초안을 작성하세요. 사실·통계·가격·효능·방문·사용 경험·출처를 지어내지 마세요.'))return false;
  const markers=[' 주제:', ' 독자:', ' 키워드:', ' 추가 요청:', ' 말투:', ' 분량:', ' 글 유형:', ' 문단 구성:', 'title, title_candidates (최대 3개), thumbnail_text, summary, seo_tags', 'content, image_prompts 필드를 사용하세요.', 'image_prompts는 썸네일 1장을 포함해 정확히 ', 'slot, prompt, alt, afterBlockId, heading_hint, visual_style, overlay_text', '이미지 유형 설정은 ', '여행지나 물건의 원산지로 국적을 추정하지 마세요. 비율: '];
  let offset=0;
  for(const marker of markers){
   const index=value.indexOf(marker,offset);
   if(index<0)return false;
   offset=index+marker.length;
  }
  return /^(?:1:1|4:5|3:4|4:3|9:16|16:9)\. 초안 단계에서는 실제 이미지를 생성하지 마세요\.$/.test(value.slice(offset));
 }
 function extensionImageRequest(value){
  return /^(ChatGPT|Gemini) 이미지 생성으로 블로그에 사용할 완성 이미지 한 장을 생성해주세요\. 설명문 대신 실제 이미지 결과를 반환하세요\. \[이미지 목적\] 슬롯: /.test(value)
   && ['[이미지 유형]','[블로그 글 정보]','[제작 기준]','최종 캔버스:'].every(marker=>value.includes(marker))
   && value.endsWith('대상을 자르거나 늘리지 말고 구도를 다시 잡으세요.');
 }
 const chatSendSelector='#composer-submit-button,[data-testid="send-button"]';
 const chatEditorSelector='textarea:not([readonly]):not([disabled]),[contenteditable]:not([contenteditable="false"])';
 const composerScope=input=>input.closest('form,[data-testid="composer"],[data-testid="prompt-composer"],[data-type="unified-composer"],[data-composer-surface]');
 let candidateCount=0;
 function editor(){
  if(!isChatGPT)return [...document.querySelectorAll('rich-textarea [contenteditable="true"],.ql-editor[contenteditable="true"],[role="textbox"][contenteditable="true"]')].find(visible);
  const editable=node=>visible(node) && (node instanceof HTMLTextAreaElement || node.isContentEditable)
   && !node.closest('[data-message-author-role],[data-turn="assistant"],[data-turn="user"]');
  const exact=[...document.querySelectorAll('#prompt-textarea')].filter(node=>node.matches(chatEditorSelector)&&editable(node));
  candidateCount=exact.length;
  if(exact.length)return exact.length===1?exact[0]:null;
  const candidates=[...document.querySelectorAll(chatEditorSelector)].filter(node=>{
   const scope=composerScope(node);
   if(!editable(node) || node.closest('[role="search"],aside,nav,[role="dialog"]'))return false;
   const hint=[node.getAttribute('aria-label'),node.getAttribute('placeholder'),node.dataset.placeholder,node.querySelector('[data-placeholder]')?.dataset.placeholder].filter(Boolean).join(' ');
   const composerHint=/무엇이든 물어|메시지 입력|ChatGPT에게|Ask anything|Message ChatGPT/i.test(hint);
   const richComposer=node.matches('[contenteditable="true"].ProseMirror') && !!node.closest('main,[role="main"]');
   return composerHint || richComposer || (scope && (scope.querySelector(chatSendSelector) || scope.matches('[data-type="unified-composer"],[data-composer-surface]') || sendButton(node)));
  });
  candidateCount=candidates.length;
  return candidates.length===1?candidates[0]:null;
 }
 const inputText=input=>input instanceof HTMLTextAreaElement ? input.value : input?.innerText;
 function insertPrompt(input,prompt){
  input.focus();
  if(input instanceof HTMLTextAreaElement){
   Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,prompt);
  }else{
   const range=document.createRange();
   range.selectNodeContents(input);
   const selection=getSelection();
   selection.removeAllRanges();
   selection.addRange(range);
   if(!document.execCommand('insertText',false,prompt))return false;
  }
  input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:prompt}));
  return true;
 }
 function loginScreen(){
  return /^\/(?:auth\/)?(?:login|signin|sign-in)(?:\/|$)/i.test(location.pathname)
   || [...document.querySelectorAll('form input[type="password"],[role="dialog"] input[type="password"]')].some(visible);
 }
 const markedResponses=()=>[...document.querySelectorAll(isChatGPT?'[data-message-author-role=assistant],[data-turn=assistant],article[data-testid^=conversation-turn]:not([data-turn=user]):not(:has([data-message-author-role=user])):has(pre,.cm-content,.markdown),section[data-testid^=conversation-turn]:not([data-turn=user]):not(:has([data-message-author-role=user])):has(pre,.cm-content,.markdown)':'model-response,.model-response')].filter(visible).filter((el,i,a)=>!a.some((other,j)=>i!==j&&other.contains(el)));
 function responses(){
  const marked=markedResponses();
  if(!isChatGPT)return marked;
  const candidates=[...document.querySelectorAll('main :is(pre,.cm-content),[role=main] :is(pre,.cm-content)')].filter(node=>visible(node)&&!node.closest('form,[data-turn=user],[data-message-author-role=user],textarea')&&!marked.some(parent=>parent.contains(node)));
  return [...new Set([...marked,...candidates])].sort((a,b)=>a.compareDocumentPosition(b)&4?-1:1);
 }

 function articleJSON(raw){
  const start=raw.indexOf('{'),end=raw.lastIndexOf('}');
  if(start<0||end<=start)return '';
  const json=raw.slice(start,end+1);
  try{const draft=JSON.parse(json);return draft?.title&&(draft.body||draft.content)?json:'';}catch{return '';}
 }
 async function fullCodeBlock(reply,job){
  const nodes=reply.matches('.cm-content')?[reply]:[...reply.querySelectorAll('.cm-content')];
  for(const node of nodes){
   node.setAttribute('data-buja-response',job.id);
   try{
    const result=await chrome.runtime.sendMessage({type:'BUJA_READ_CODE',jobId:job.id});
    const json=articleJSON(result?.data?.raw||'');
    if(json)return json;
   }finally{node.removeAttribute('data-buja-response');}
  }
  return '';
 }
 function responseText(el, kind) {
  if(isChatGPT && kind==='article'){
   if(!el)return '';
   const candidates=[...el.querySelectorAll('pre code,pre,.cm-content,code,.markdown')].reverse();
   for(const node of [...candidates,el]){
    const lines=node.querySelectorAll('.cm-line');
    const raw=lines.length?Array.from(lines,line=>line.textContent).join('\n'):node.innerText || node.textContent || '';
    const json=articleJSON(raw);if(json)return json;
   }
   return '';
  }
  if (kind === 'article') {
   for (const pre of el?.querySelectorAll('pre') || []) {
    const code = (pre.querySelector('code') || pre).textContent.trim();
    if (/^(?:\{|\[)/.test(code)) return code;
   }
  }
  return (el?.querySelector('.markdown,.model-response-text')?.innerText || el?.innerText || '').trim();
 }
 const generating=()=>[...document.querySelectorAll('button[aria-label],button[data-testid],button[data-test-id]')].some(el=>visible(el)&&(el.dataset.testid==='stop-button'||/stop.*(response|generat)|응답.*중지|생성.*중지|stop-response/i.test(`${el.getAttribute('aria-label')} ${el.getAttribute('data-test-id')}`)));
 const sendButton=input=>[...(isChatGPT && composerScope(input) || document).querySelectorAll('button.send-button,button[aria-label],button[data-testid],button[data-test-id]')].find(el=>visible(el)&&!el.disabled&&(el.matches('button#composer-submit-button:not([data-testid=stop-button]),button[data-testid=send-button],button.send-button,button[data-test-id="send-button"]')||/^(send message|send|submit|메시지 보내기|보내기|프롬프트 (?:전송|보내기)|메시지 전송|전송)$/i.test((el.getAttribute('aria-label')||el.title||'').trim())));
 async function chooseImageTool(input,current){
  const scope=composerScope(input) || input.closest('main,[role=main]') || input.parentElement.parentElement;
  const label=el=>(el.getAttribute('aria-label') || el.innerText || '').trim();
  const isImage=el=>/^(이미지\s*생성|이미지 만들기|create (?:an? )?image)(?:\s|$)/i.test(label(el));
  if([...scope.querySelectorAll('button,[role=button]')].some(el=>visible(el)&&isImage(el)))return;
  const nearby=input.getBoundingClientRect();
  const buttons=[...document.querySelectorAll('button,[role=button]')].filter(el=>{const r=el.getBoundingClientRect();return scope.contains(el)||(Math.abs(r.bottom-nearby.bottom)<100 && Math.abs(r.right-nearby.left)<100);});
  const plus=buttons.find(el=>visible(el)&&(el.matches('#composer-plus-btn,[data-testid=composer-plus-btn]') || (el.getAttribute('aria-haspopup')==='menu' && el.getBoundingClientRect().left<=nearby.left && !label(el)) || /파일.*추가|업로드|도구|사진 및 파일|add files|add photos|add files and more|open tools|^\+$/i.test(label(el))));
  if(!plus)throw Error('ChatGPT 입력창에서 + 메뉴를 찾지 못했습니다.');
  plus.click();
  for(let i=0;i<40&&!current.cancelled;i++){
   const option=[...document.querySelectorAll('[role=menuitem],[role=option],[role=menuitemradio],button')].find(el=>visible(el)&&isImage(el));
   if(option){option.click();await sleep(300);return;}
   await sleep(125);
  }
  throw Error('ChatGPT 메뉴에서 이미지 생성을 찾지 못했습니다.');
 }
 async function attach(attachments,current){
  if(!attachments?.length)return;
  let input=[...document.querySelectorAll('input[type="file"]')].find(el=>!el.disabled);
  if(!input){[...document.querySelectorAll('button[aria-label]')].find(el=>visible(el)&&/^(Add files|Upload files|Uploads and tools|파일 추가|파일 업로드|업로드 및 도구)$/i.test(el.getAttribute('aria-label')))?.click();await sleep(200);[...document.querySelectorAll('[role="menuitem"]')].find(el=>visible(el)&&/^(Upload files|파일 업로드)$/i.test(el.textContent.trim()))?.click();for(let i=0;i<20&&!input;i++){await sleep(150);input=[...document.querySelectorAll('input[type="file"]')].find(el=>!el.disabled);}}
  if(!input)throw Error('Gemini 사진 첨부 입력창을 찾지 못했습니다. Gemini에서 파일 추가 메뉴를 연 뒤 다시 요청해주세요. 요청은 전송하지 않았습니다.');
  if(attachments.length>1&&!input.multiple)throw Error('Gemini 첨부창이 여러 사진 업로드를 허용하지 않습니다. 사진을 한 장만 선택하거나 파일 추가 메뉴를 확인해주세요.');
  const dt=new DataTransfer();for(const x of attachments){if(current.cancelled)return;const r=await fetch(x.data);const b=await r.blob();dt.items.add(new File([b],x.name||'reference.png',{type:b.type}));}
  input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));await sleep(1800);
 }
 async function collectImage(img){
  const url=img.currentSrc||img.src;
  if(url.startsWith('data:image/'))return {data:url};
  if(url.startsWith('blob:') || (isChatGPT && new URL(url).protocol==='https:')){const r=await fetch(url,{credentials:new URL(url).origin===location.origin?'same-origin':'omit'});if(!r.ok)throw Error('이미지를 읽을 수 없습니다.');const b=await r.blob();if(b.size>8*1024*1024)throw Error('생성 이미지가 8MB를 넘습니다.');const data=await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=()=>reject(Error('이미지 읽기 실패'));fr.readAsDataURL(b);});return {data};}
  return {url};
 }
 async function run(job,attachments,current){
  const reportStage = stage => void chrome.runtime.sendMessage({type:'BUJA_STAGE',jobId:job.id,stage}).catch(()=>{});
  const report=async value=>{
   if(current.cancelled)return;
   reporting.add(job.id);
   if(task===current)task=null;
   try{await chrome.runtime.sendMessage({type:'BUJA_RESULT',jobId:job.id,...value});}
   catch{}
   finally{reporting.delete(job.id);}
  };
  let observer;
  let wake;
  const waitForResponseChange = () => new Promise(resolve => {
   const timer = setTimeout(finish, 900);
   function finish() {
    clearTimeout(timer);
    wake = undefined;
    resolve();
   }
   wake = finish;
  });
  try{
   let input=editor();
   if(!input)throw Error('Gemini 입력창을 찾지 못했습니다. 먼저 로그인해주세요.');
   if(generating())throw Error('Gemini가 다른 응답을 생성하고 있습니다.');
   const previous=normalizeComposer(inputText(input));
   const digest=previous?await composerDigest(previous):'';
   const canReplace=!!digest && (job.knownComposerDigests?.includes(digest) || digest===job.replaceComposerDigest || (job.kind==="article" && (legacyArticle(previous)||extensionImageRequest(previous))));
   const blocked=async input=>{
    reportStage('composer-blocked');
    const value=normalizeComposer(inputText(input));
    await report({error:(isChatGPT?'ChatGPT':'Gemini')+(job.kind==='article'?' 입력창에 작성 중인 내용이 있습니다. 확인 후 입력창 비우고 초안 시작을 선택해주세요.':' 입력창에 작성 중인 내용이 있어 이미지 요청을 멈췄습니다. 해당 내용을 보관하고 이미지 생성을 다시 눌러주세요.'),
     blockedComposerDigest:value?await composerDigest(value):undefined});
   };
   if(previous&&!canReplace){await blocked(input);return;}
   reportStage('composer-ready');
   const baseline=new Map(responses().map(x=>[x,responseText(x,job.kind)]));
   const oldImages=new Set(responses().flatMap(el=>[...el.querySelectorAll('img')].map(x=>x.currentSrc||x.src)));
   await attach(attachments,current);if(current.cancelled)return;
   if(isChatGPT && job.kind==='image'){await chooseImageTool(input,current);if(current.cancelled)return;}
   input=editor();
   if(!input || normalizeComposer(inputText(input))!==previous){await blocked(input);return;}
   if(!insertPrompt(input,job.prompt))throw Error('Gemini 요청 입력에 실패했습니다. 프롬프트 복사를 사용해주세요.');
   if(canReplace)reportStage('stale-prompt-replaced');
   await chrome.runtime.sendMessage({type:'BUJA_STAGE',jobId:job.id,stage:'composer-written',digest:await composerDigest(job.prompt)});
   let send;
   for(let i=0;i<(attachments?.length?150:30)&&!current.cancelled;i++){
    input=editor();send=input&&sendButton(input);if(send)break;await sleep(200);
   }
   if(current.cancelled)return;
   if(!send)throw Error('Gemini 보내기 버튼을 찾지 못했습니다. 입력된 요청을 직접 확인해주세요.');
   if(normalizeComposer(inputText(editor()))!==normalizeComposer(job.prompt)){await blocked(editor());return;}
   send.click();
   let submitted=false;
   for(let i=0;i<30&&!current.cancelled;i++){
    const active=editor();
    if((active&&!normalizeComposer(inputText(active))) || generating() || responses().some(node=>!baseline.has(node))){
     submitted=true;break;
    }
    await sleep(200);
   }
   if(current.cancelled)return;
   if(!submitted){
    reportStage('submit-unconfirmed');
    throw Error('Gemini에서 요청 전송을 확인하지 못했습니다. 열린 창의 입력 상태를 확인해주세요.');
   }
   reportStage('submitted');
   if(job.kind==='article')reportStage('waiting');
   observer = new MutationObserver(() => wake?.());
   observer.observe(document.body, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['src','srcset','aria-label','aria-busy']
   });
   const began=Date.now(),limit=job.kind==='image'?300000:180000;let last='',stable=0,collecting=false,lastRead=0,fullText='',fullNode;
   let observedChars=0,sawReply=false;
   while(Date.now()-began<limit&&!current.cancelled){
    await waitForResponseChange();if(current.cancelled)return;const latest=responses().at(-1);let content=responseText(latest,job.kind);
    if(isChatGPT && job.kind==='article' && latest && !baseline.has(latest)){
     sawReply=true;observedChars=Math.max(observedChars,(latest.textContent||'').length);
     if(!content && !generating() && Date.now()-lastRead>=900){
      lastRead=Date.now();fullNode=latest;fullText=await fullCodeBlock(latest,job);
     }
     if(!content && latest===fullNode && !generating())content=fullText;
    }
    const alert=[...document.querySelectorAll('[role=alert]')].filter(visible).map(node=>node.innerText).join(' ');
    if(/usage limit|reached your .*limit|too many requests|rate limit|사용량.{0,12}(초과|한도)|한도에 도달/i.test(alert+' '+(latest&&!baseline.has(latest)?content:'')))throw Error('사용량 제한입니다. 다른 AI를 선택해 이어가세요.');
    const imgs=latest?[...latest.querySelectorAll('img')].filter(img=>visible(img)&&img.complete&&img.naturalWidth>=128&&!oldImages.has(img.currentSrc||img.src)):[];
    const fresh=latest&&(!baseline.has(latest)||baseline.get(latest)!==content||imgs.length>0);
    const signature=job.kind==='image'?imgs.map(x=>x.currentSrc||x.src).join('|'):content;
    if (job.kind === 'article' && !collecting && fresh && signature) {
     collecting = true;
     reportStage('collecting');
    }
    if(!fresh||!signature||(generating() && !(isChatGPT && job.kind==='article' && signature))){stable=0;last=signature;continue;}
    if(signature!==last||!stable){last=signature;stable=Date.now();continue;}
    if(Date.now()-stable>=2800&&Date.now()-began>=5000){if(job.kind==='image')await report({images:[await collectImage(imgs[0])]});else{if(content.length>60000)throw Error('생성 응답이 너무 깁니다.');await report({text:content});}return;}
   }
   if(!current.cancelled && isChatGPT && job.kind==='article'){
    await report({error:'ChatGPT 초안을 수집하지 못했습니다. '+(sawReply?'응답은 발견했지만 완전한 초안 JSON을 확인하지 못했습니다.':'새 답변 영역을 찾지 못했습니다.'),responseProbe:{sawReply,observedChars}});return;
   }
   if(!current.cancelled)throw Error(job.kind==='image'?'5분 안에 생성 이미지를 수집하지 못했습니다. Gemini에서 내려받은 파일을 갤러리에 직접 추가해주세요.':'3분 안에 초안을 수집하지 못했습니다. Gemini 응답을 직접 붙여넣어주세요.');
  }catch(e){if(!current.cancelled)await report({error:isChatGPT?e.message.replaceAll('Gemini','ChatGPT'):e.message});}finally{observer?.disconnect();if(task===current)task=null;}
 }
 chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return;
  if(msg.type==='BUJA_INSPECT_ARTICLE'){
   const value=normalizeComposer(inputText(editor()));
   if(!value || (msg.kind!=='image' && (legacyArticle(value)||extensionImageRequest(value))))reply({unknown:false});
   else {composerDigest(value).then(digest=>reply({unknown:!msg.known.includes(digest)}));return true;}
   return;
  }
  if(msg.type==='BUJA_PING'){
   const input=editor();
   reply({ready:!!input,candidateCount:isChatGPT?candidateCount:Number(!!input),sendFound:!!sendButton(input||document.body),loginRequired:!input&&loginScreen(),busy:generating(),running:task?.id||null,reporting:[...reporting].at(-1)||null});
   return;
  }
  if(msg.type==='BUJA_CANCEL'){if(task?.id===msg.jobId)task.cancelled=true;reply({ok:true});return;}
  if(msg.type==='BUJA_START'){
   if(task&&!task.cancelled){reply({ok:false,error:'이 Gemini 탭에서 이미 수집 중입니다.'});return;}
   if(!msg.job?.id||typeof msg.job.prompt!=='string'||msg.job.prompt.length>90000){reply({ok:false,error:'요청 형식이 잘못되었습니다.'});return;}
   const current={id:msg.job.id,cancelled:false};task=current;reply({ok:true});void run(msg.job,msg.attachments,current);
  }
 });
})();
