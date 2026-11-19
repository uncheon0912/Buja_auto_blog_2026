(() => {
  const visible = node => node && node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
  function createButton() {
    return [...document.querySelectorAll('button,[role="button"],a[href="/create"]')].find(node => {
      const label = node.getAttribute('aria-label') || node.querySelector('svg title')?.textContent || node.innerText;
      return visible(node) && (node.getAttribute('href') === '/create' || /^(만들기|작성|새 스레드|스레드 작성|새로운 스레드|Create|New thread|Create thread)$/i.test(label?.trim()));
    });
  }
  const editor = () => {
    const fields = [...document.querySelectorAll('[role="dialog"] [contenteditable="true"]')].filter(visible);
    return fields.length === 1 ? fields[0] : null;
  };
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:2147483646';
  const ui = host.attachShadow({mode:'closed'});
  ui.innerHTML = `<style>
    *{box-sizing:border-box}section{font:15px/1.5 system-ui;color:#eaf5f2;background:#172425;border:1px solid #50726b;border-radius:16px;padding:16px;width:min(360px,94vw);max-height:78vh;overflow:auto;box-shadow:0 8px 30px #0004}
    button,textarea,select{font:inherit;border:1px solid #64918a;border-radius:8px;padding:8px}button{cursor:pointer;background:#b3ecdc;color:#152921;margin:4px 2px}button:disabled{opacity:.5}label,textarea,select{display:block;width:100%;margin:6px 0}textarea,select{background:#fff;color:#152921}img{width:70px;height:70px;object-fit:cover;margin:3px}[hidden]{display:none!important}
  </style><section><header id="grip">부사연 슈퍼노바 SNS · Threads <small>이동</small></header><div id="offer">이 계정에 올릴 Threads 글을 준비할까요?<br><button id="yes">준비하기</button><button id="later">나중에</button></div>
  <button id="resume" hidden>Threads 글 준비</button><div id="work" hidden><label>주제와 요청<textarea id="topic" rows="2"></textarea></label><label>이미지 개수<select id="count"></select></label><label id="ratioField" hidden>이미지 비율<select id="ratio"><option value="1:1">1:1</option><option value="4:5">4:5</option><option value="3:4">3:4 (인스타 카드뉴스)</option><option value="16:9">16:9</option><option value="9:16">9:16</option></select></label><label id="styleField" hidden>이미지 스타일<select id="style"></select></label><button id="draft">게시글과 프롬프트 생성</button><label>게시할 글<textarea rows="4" id="post"></textarea></label><div id="prompts"></div><button id="images" hidden>이미지 생성</button><div id="gallery"></div><button id="insert">Threads 작성창에 넣기</button><button id="fold">접기</button></div><div id="status" role="status"></div></section>`;
  const el = id => ui.getElementById(id);
  const box=ui.querySelector('section');
  const grip=el('grip');
  grip.style.cssText='position:sticky;top:-16px;background:#172425;padding:8px;cursor:move;touch-action:none;user-select:none;z-index:1';
  let anchored=false;
  function place(x,y,w,h){
    w=Math.min(innerWidth,Math.max(240,w));h=Math.min(innerHeight,Math.max(120,h));
    Object.assign(host.style,{left:Math.max(0,Math.min(innerWidth-w,x))+'px',top:Math.max(0,Math.min(innerHeight-h,y))+'px',right:'auto',bottom:'auto'});
    Object.assign(box.style,{width:w+'px',height:h+'px',maxHeight:'none'});
    anchored=true;
  }
  function drag(handle,corner){
    handle.onpointerdown=e=>{
      if(e.button!==0)return;
      e.preventDefault();handle.setPointerCapture(e.pointerId);
      const r=host.getBoundingClientRect(),sx=e.clientX,sy=e.clientY;
      handle.onpointermove=m=>{
        const dx=m.clientX-sx,dy=m.clientY-sy;
        if(!corner){place(r.x+dx,r.y+dy,r.width,r.height);return;}
        const west=corner.endsWith('w'),north=corner.startsWith('n');
        const w=Math.min(west?r.right:innerWidth-r.left,Math.max(240,r.width+(west?-dx:dx)));
        const h=Math.min(north?r.bottom:innerHeight-r.top,Math.max(120,r.height+(north?-dy:dy)));
        place(west?r.right-w:r.left,north?r.bottom-h:r.top,w,h);
      };
      handle.onlostpointercapture=()=>{handle.onpointermove=null;};
    };
  }
  drag(grip,'');
  for(const corner of ['nw','ne','sw','se']){
    const h=document.createElement('span');h.style.cssText='position:absolute;width:16px;height:16px;z-index:2;touch-action:none;cursor:'+corner+'-resize;'+(corner[0]==='n'?'top':'bottom')+':0;'+(corner[1]==='w'?'left':'right')+':0';
    ui.append(h);drag(h,corner);
  }
  addEventListener('resize',()=>{if(anchored){const r=host.getBoundingClientRect();place(r.x,r.y,r.width,r.height);}});
  for(const name of ['아이폰 실사','애니메이션','치비','3D 글래스 스타일','텍스트','강렬한포스터'])el('style').add(new Option(name,name));
  let batch='',seriesSeed=crypto.randomUUID();
  el('style').onchange=()=>{clearPhotos();};
  for(let i=0;i<=10;i++) el('count').add(new Option(i ? i+'장' : '글만 작성',String(i)));
  const files=[];
  const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
  const status = value => {el('status').textContent=value;};
  let running=false;
  const prompts = () => [...el('prompts').querySelectorAll('textarea')];
  function action(id,fn){
    el(id).onclick=async()=>{
      if(running)return;
      running=true;
      const controls=[...ui.querySelectorAll('button,textarea,select')];
      controls.forEach(node=>node.disabled=true);
      try{await fn();}catch(error){status(error.message);}
      finally{running=false;controls.forEach(node=>node.disabled=false);}
    };
  }
  async function request(message){
    const response=await chrome.runtime.sendMessage(message);
    if(!response?.ok)throw Error(response?.error||'확장 프로그램 연결을 확인해주세요.');
    return response.data;
  }
  async function generate(kind,prompt){
    const {id}=await request({type:'THREAD_START',kind,style:el('style').value,post:el('post').value,batch,index:files.length,seriesSeed,count:Number(el('count').value),prompt});
    for(let i=0;i<380;i++){
      await sleep(1000);
      const result=await request({type:'THREAD_STATUS',id});
      if(result.status==='done')return result.output;
      if(!['running','preparing'].includes(result.status))throw Error(result.error||'생성이 중단되었습니다.');
    }
    throw Error('Gemini 응답 대기 시간이 지났습니다.');
  }
  function clearPhotos(){files.length=0;el('gallery').replaceChildren();}
  function resetPrompts(){clearPhotos();el('prompts').replaceChildren();el('images').hidden=true;}
  el('ratio').onchange=clearPhotos;
  el('count').onchange=()=>{el('styleField').hidden=el('ratioField').hidden=!Number(el('count').value);resetPrompts();status('선택한 개수로 초안을 생성하세요.');};
  action('draft',async()=>{
    if(!el('topic').value.trim())throw Error('주제를 입력해주세요.');
    status('Gemini가 게시글을 작성하고 있습니다.');
    seriesSeed=crypto.randomUUID();
    const result=await generate('article',el('topic').value);
    resetPrompts();el('post').value=result.text;
    result.prompts.forEach((prompt,i)=>{
      const label=document.createElement('label'),field=document.createElement('textarea');
      label.textContent=(i+1)+'번 이미지 프롬프트';field.value=prompt;field.oninput=clearPhotos;
      label.append(field);el('prompts').append(label);
    });
    el('images').hidden=!result.prompts.length;status('게시글을 확인하세요.');
  });
  action('images',async()=>{
    if(prompts().some(f=>!f.value.trim()))throw Error('이미지 프롬프트를 입력해주세요.');
    clearPhotos();
    batch=crypto.randomUUID();
    for(const field of prompts()){
      status('이미지 생성 중 · '+(files.length+1)+'/'+prompts().length+'장');
      const {data}=await generate('image',field.value+'\n최종 캔버스: '+el('ratio').value+(el('ratio').value==='3:4'?' (1080×1440 세로)':''));
      const blob=await (await fetch(data)).blob();
      files.push(new File([blob],'threads-'+(files.length+1)+'.'+blob.type.split('/')[1],{type:blob.type}));
      const img=document.createElement('img');img.src=data;img.alt=files.length+'번 이미지';el('gallery').append(img);
    }
    status('이미지가 준비되었습니다.');
  });
  action('insert',async()=>{
    const post=el('post').value.trim();
    if(!post || [...post].length>500)throw Error('게시글을 1~500자로 입력해주세요.');
    if(files.length!==Number(el('count').value))throw Error('선택한 장수의 이미지를 먼저 생성해주세요.');
    if(!editor())createButton()?.click();
    for(let i=0;i<35&&!editor();i++)await sleep(100);
    const field=editor(),dialog=field?.closest('[role="dialog"]');
    if(!field)throw Error('Threads에서 새 작성창을 연 뒤 다시 눌러주세요.');
    if(field.innerText.trim() || dialog.querySelector('video,img[src^="blob:"],button[aria-label*="삭제"],button[aria-label*="Remove"]'))throw Error('작성 중인 내용이 있습니다. 빈 작성창을 열어주세요.');
    const input=dialog.querySelector('input[type="file"][accept*="image"],input[type="file"][multiple]');
    if(files.length && (!input || (files.length>1&&!input.multiple)))throw Error('작성창의 사진 첨부 입력란을 확인해주세요.');
    field.focus();
    document.execCommand('insertText',false,post);
    const normalize=s=>s.replace(/\s+/g,' ').trim();
    if(normalize(field.innerText)!==normalize(post))throw Error('게시글 입력 결과를 확인해주세요.');
    if(files.length){
      const data=new DataTransfer();files.forEach(file=>data.items.add(file));
      input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));
    }
    status(files.length?'글을 입력하고 사진 첨부를 요청했습니다. 미리보기를 확인한 뒤 직접 게시하세요.':'글을 입력했습니다. 확인한 뒤 직접 게시하세요.');
  });
  function open(){el('offer').hidden=true;el('resume').hidden=true;el('work').hidden=false;}
  function fold(){el('offer').hidden=true;el('work').hidden=true;el('resume').hidden=false;}
  el('yes').onclick=open;el('resume').onclick=open;el('later').onclick=()=>{fold();void request({type:'THREAD_DISMISS'}).catch(()=>{});};el('fold').onclick=fold;
  function mount(){if(!host.isConnected && (createButton()||editor()))document.body.append(host);}
  request({type:'THREAD_PREF'}).then(hidden=>{if(hidden && !el('offer').hidden)fold();}).catch(()=>{});
  mount();const observer=new MutationObserver(()=>{if(!host.isConnected)mount();});
  observer.observe(document.body,{childList:true,subtree:true});
})();
