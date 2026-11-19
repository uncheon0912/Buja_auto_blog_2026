(()=>{
 if(globalThis.__bujaStudioV2)return;globalThis.__bujaStudioV2=true;
 let task=null;
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const visible=el=>!!el&&el.getClientRects().length>0&&getComputedStyle(el).visibility!=='hidden';
 const editor=()=>[...document.querySelectorAll('rich-textarea [contenteditable="true"],.ql-editor[contenteditable="true"],[role="textbox"][contenteditable="true"]')].find(visible);
 const responses=()=>[...document.querySelectorAll('model-response,.model-response')].filter(visible).filter((el,i,a)=>!a.some((other,j)=>i!==j&&other.contains(el)));
 function responseText(el, kind) {
  if (kind === 'article') {
   for (const pre of el?.querySelectorAll('pre') || []) {
    const code = (pre.querySelector('code') || pre).textContent.trim();
    if (/^(?:\{|\[)/.test(code)) return code;
   }
  }
  return (el?.querySelector('.markdown,.model-response-text')?.innerText || el?.innerText || '').trim();
 }
 const generating=()=>[...document.querySelectorAll('button[aria-label],button[data-test-id]')].some(el=>visible(el)&&/stop.*(response|generat)|응답.*중지|생성.*중지|stop-response/i.test(`${el.getAttribute('aria-label')} ${el.getAttribute('data-test-id')}`));
 const sendButton=()=>[...document.querySelectorAll('button.send-button,button[aria-label],button[data-test-id]')].find(el=>visible(el)&&!el.disabled&&(el.matches('button.send-button,button[data-test-id="send-button"]')||/^(send message|send|submit|메시지 보내기|보내기|프롬프트 전송|전송)$/i.test(el.getAttribute('aria-label')||'')));
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
  if(url.startsWith('blob:')){const r=await fetch(url);const b=await r.blob();if(b.size>8*1024*1024)throw Error('생성 이미지가 8MB를 넘습니다.');const data=await new Promise((resolve,reject)=>{const fr=new FileReader();fr.onload=()=>resolve(fr.result);fr.onerror=()=>reject(Error('이미지 읽기 실패'));fr.readAsDataURL(b);});return {data};}
  return {url};
 }
 async function run(job,attachments,current){
  const reportStage = stage => void chrome.runtime.sendMessage({type:'BUJA_STAGE',jobId:job.id,stage}).catch(()=>{});
  const report=async value=>{if(current.cancelled)return;if(task===current)task=null;try{await chrome.runtime.sendMessage({type:'BUJA_RESULT',jobId:job.id,...value});}catch{}};
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
   const input=editor();if(!input)throw Error('Gemini 입력창을 찾지 못했습니다. 먼저 로그인해주세요.');if(generating())throw Error('Gemini가 다른 응답을 생성하고 있습니다.');if(input.innerText.trim())throw Error('Gemini 입력창에 작성 중인 내용이 있습니다. 직접 정리한 뒤 다시 요청해주세요.');
   const baseline=new Map(responses().map(x=>[x,responseText(x,job.kind)]));const oldImages=new Set(responses().flatMap(el=>[...el.querySelectorAll('img')].map(x=>x.currentSrc||x.src)));
   await attach(attachments,current);if(current.cancelled)return;
   input.focus();const range=document.createRange();range.selectNodeContents(input);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);
   if(!document.execCommand('insertText',false,job.prompt))throw Error('Gemini 요청 입력에 실패했습니다. 프롬프트 복사를 사용해주세요.');input.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:job.prompt}));
   let send;for(let i=0;i<(attachments?.length?150:30)&&!current.cancelled;i++){send=sendButton();if(send)break;await sleep(200);}if(current.cancelled)return;if(!send)throw Error('Gemini 보내기 버튼을 찾지 못했습니다. 입력된 요청을 직접 확인해주세요.');send.click();
   if (job.kind === 'article') reportStage('waiting');
   observer = new MutationObserver(() => wake?.());
   observer.observe(document.body, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['src','srcset','aria-label','aria-busy']
   });
   const began=Date.now(),limit=job.kind==='image'?300000:180000;let last='',stable=0,collecting=false;
   while(Date.now()-began<limit&&!current.cancelled){
    await waitForResponseChange();if(current.cancelled)return;const latest=responses().at(-1),content=responseText(latest,job.kind);
    const imgs=latest?[...latest.querySelectorAll('img')].filter(img=>visible(img)&&img.complete&&img.naturalWidth>=128&&!oldImages.has(img.currentSrc||img.src)):[];
    const fresh=latest&&(!baseline.has(latest)||baseline.get(latest)!==content||imgs.length>0);
    const signature=job.kind==='image'?imgs.map(x=>x.currentSrc||x.src).join('|'):content;
    if (job.kind === 'article' && !collecting && fresh && signature) {
     collecting = true;
     reportStage('collecting');
    }
    if(!fresh||!signature||generating()){stable=0;last=signature;continue;}
    if(signature!==last||!stable){last=signature;stable=Date.now();continue;}
    if(Date.now()-stable>=2800&&Date.now()-began>=5000){if(job.kind==='image')await report({images:[await collectImage(imgs[0])]});else{if(content.length>60000)throw Error('생성 응답이 너무 깁니다.');await report({text:content});}return;}
   }
   if(!current.cancelled)throw Error(job.kind==='image'?'5분 안에 생성 이미지를 수집하지 못했습니다. Gemini에서 내려받은 파일을 갤러리에 직접 추가해주세요.':'3분 안에 초안을 수집하지 못했습니다. Gemini 응답을 직접 붙여넣어주세요.');
  }catch(e){if(!current.cancelled)await report({error:e.message});}finally{observer?.disconnect();if(task===current)task=null;}
 }
 chrome.runtime.onMessage.addListener((msg,sender,reply)=>{
  if(sender.id!==chrome.runtime.id)return;
  if(msg.type==='BUJA_PING'){reply({ready:!!editor(),busy:generating(),running:task?.id||null});return;}
  if(msg.type==='BUJA_CANCEL'){if(task?.id===msg.jobId)task.cancelled=true;reply({ok:true});return;}
  if(msg.type==='BUJA_START'){
   if(task&&!task.cancelled){reply({ok:false,error:'이 Gemini 탭에서 이미 수집 중입니다.'});return;}
   if(!msg.job?.id||typeof msg.job.prompt!=='string'||msg.job.prompt.length>90000){reply({ok:false,error:'요청 형식이 잘못되었습니다.'});return;}
   const current={id:msg.job.id,cancelled:false};task=current;reply({ok:true});void run(msg.job,msg.attachments,current);
  }
 });
})();
