/* This function is serialized by chrome.scripting; keep its helpers local. */
export async function editorBridge(mode, platform, payload = {}) {
  const host = location.hostname;
  const home = platform === 'naver' ? host === 'blog.naver.com'
    : platform === 'cafe' ? host === 'cafe.naver.com'
    : platform === 'tistory' && host.endsWith('.tistory.com');
  if (!home) return { found: false };

  const visible = node => !!node && node.getClientRects().length > 0
    && node.ownerDocument.defaultView.getComputedStyle(node).visibility !== 'hidden';
  const first = (selector, doc = document) => [...doc.querySelectorAll(selector)].find(visible);
  const normalized = value => String(value ?? '').replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/\s+/g, ' ').trim();
  const adornments = '.se-placeholder,.se-blind,.se-list-marker';
  function read(node) {
    if (!node) return '';
    if (node.matches('input,textarea')) return normalized(node.value);
    if (!node.querySelector(adornments)) return normalized(node.innerText ?? node.textContent);
    const copy = node.cloneNode(true);
    copy.querySelectorAll(adornments).forEach(item => item.remove());
    return normalized(copy.textContent);
  }
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let title;
  let body;
  let container;
  let sharedInput;

  if (platform === 'tistory') {
    if (!/^\/manage\/(?:newpost|post(?:\/|$))/.test(location.pathname)) return { found: false };
    title = first('#post-title-inp, textarea#post-title, input#post-title');
    const frame = first('iframe#editor-tistory_ifr, iframe.tox-edit-area__iframe');
    try {
      body = frame?.contentDocument?.querySelector('body[contenteditable="true"]');
    } catch { /* Inaccessible editor frame */ }
    body ||= first('#editor-tistory[contenteditable="true"]');
    container = body;
  } else {
    if (platform === 'cafe' && !/\/articles\/write(?:\/|$)|\/ArticleWrite(?:\.nhn|\.naver)?$/i.test(location.pathname)) return { found: false };
    const smartTitle = '.se-section-documentTitle [contenteditable="true"], .se-documentTitle [contenteditable="true"], .se-title-text [contenteditable="true"]';
    title = first(platform === 'cafe' ? smartTitle + ', .ArticleWritingTitle textarea, textarea.textarea_input, textarea#subject, input#subject' : smartTitle);
    body = [...document.querySelectorAll('.se-section-text [contenteditable="true"], .se-component.se-text [contenteditable="true"]')]
      .find(node => visible(node) && !node.closest('.se-documentTitle, .se-section-documentTitle'));
    container = body?.closest('.se-container') || body?.closest('.se-content');
    if (platform === 'naver' && /^\/PostWriteForm\.naver$/i.test(location.pathname) && !title && !body) {
      const canvas = first('.se-canvas article.se-components-wrap');
      const buffer = document.querySelector('iframe[id^="input_buffer"]');
      const input = buffer?.contentDocument?.body;
      if (canvas && input?.matches('body[contenteditable="true"]')) {
        title = first('.se-component.se-documentTitle .se-title-text .se-text-paragraph', canvas);
        body = first('.se-component.se-text .se-section-text .se-text-paragraph', canvas) || canvas;
        container = canvas;
        sharedInput = buffer;
      }
    }
  }

  if (!title || !body || !container || title === body) return { found: false };
  const bodyDoc = body.ownerDocument;
  const documents = globalThis.__bujaEditors ||= new WeakMap();
  if (!documents.has(container)) documents.set(container, { token: crypto.randomUUID(), session: new Map() });
  const { token, session } = documents.get(container);
  const photos = () => [...container.querySelectorAll(sharedInput ? '.se-component.se-image img.se-image-resource, .se-component.se-image img.se-image, .se-component.se-image .se-image-link > img' : platform === 'tistory'
    ? 'figure img, img[data-origin-src], img[data-ke-src], img'
    : '.se-component.se-image img, img.se-image-resource')].filter(img => !title.contains(img));
  const inputs = () => [bodyDoc, ...(bodyDoc === document ? [] : [document])].flatMap(doc =>
    [...doc.querySelectorAll('input[type="file"]')].filter(el =>
      !el.disabled && /image|\.png|\.jpe?g|\.webp/i.test(el.accept || '')));
  const upload = () => inputs()[0];
  const photoToolbar = () => first('button.se-image-toolbar-button, button[data-name="image"], button[data-command="image"], #attach-image, button[data-type="image"]');
  const bodyAdd = 'button,[role="button"]';
  const isBodyAdd = node => [node.getAttribute('aria-label'), node.getAttribute('data-a11y-title'),
    node.getAttribute('title'), node.textContent].some(label => normalized(label) === '본문 추가');
  const quotation = '.se-quotation,.se-section-quotation,.se-module-quotation';
  const sourceField = 'cite,.se-cite,.se-quote-cite,.se-module-cite,.se-quotation-source';
  function isEmptyQuoteSource(node) {
    const field = node.closest(sourceField);
    return field?.closest(quotation) && /^(?:출처(?:를)?\s*입력(?:해\s*주세요|하세요)?[.!]?)?$/.test(normalized(field.textContent));
  }
  const bodyRegionExclusions = '.se-documentTitle,.se-section-documentTitle,.se-title-text,.se-image,' + adornments;
  const tableCell = '.se-component.se-table .se-section-table .se-table-content .se-cell .se-module-text';
  const bodyRegions = '.se-section-text,.se-component.se-text,' + quotation + ',' + tableCell;
  const authorRow = '.se-text-paragraph,.se-quote-text,.se-section-quotation,h2,h3,p,li,blockquote,cite,[role="heading"]';
  const editorControls = `${bodyAdd},input,textarea,select,svg,script,style,[hidden],.se-component-toolbar,.se-context-toolbar`;
  const precedes = (first, second) => Boolean(first && second && first.compareDocumentPosition(second) & 4);

  function authoredRows(includeUnrecognized = false) {
    const rows = [];
    const styleCache = new WeakMap();

    function isRendered(element) {
      if (!element || element === container) return true;
      if (styleCache.has(element)) return styleCache.get(element);
      const style = bodyDoc.defaultView.getComputedStyle(element);
      const rendered = style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
        && style.contentVisibility !== 'hidden' && isRendered(element.parentElement);
      styleCache.set(element, rendered);
      return rendered;
    }

    const walker = bodyDoc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    for (let textNode = walker.nextNode(); textNode; textNode = walker.nextNode()) {
      const parent = textNode.parentElement;
      const row = parent?.closest(authorRow) || (includeUnrecognized ? parent?.closest(bodyRegions) : null);
      if (!row || !row.closest(bodyRegions) || parent.closest(bodyRegionExclusions + ',' + editorControls)
        || isEmptyQuoteSource(parent) || !isRendered(parent)) continue;
      const previous = rows.at(-1);
      if (previous?.node === row) previous.text += textNode.nodeValue;
      else rows.push({node:row, anchor:textNode, text:textNode.nodeValue});
    }
    return rows.map(row => ({...row, text:normalized(row.text)})).filter(row => row.text);
  }

  const bodyText = rows => {
    if (sharedInput) return (rows ?? authoredRows()).map(row => row.text).join(' ');
    if (title.ownerDocument !== bodyDoc || !container.contains(title)) return read(container);
    const copy = container.cloneNode(true);
    copy.querySelectorAll('.se-documentTitle,.se-section-documentTitle,.se-title-text,' + adornments).forEach(node => node.remove());
    return normalized(copy.textContent);
  };
  const comparableText = value => normalized(value).normalize('NFC').replace(/[\s\u00ad\u2022\u2060]/g, '');
  const inputPath = sharedInput ? 'smarteditor-shared-paste' : 'contenteditable-html';
  const diagnostic = (stage, code, detail = {}) => ({stage, code, inputPath, ...detail});
  function textDifference(expected, actual, previousLength) {
    const wanted = Array.from(expected);
    const found = Array.from(actual);
    let offset = 0;
    while (offset < wanted.length && wanted[offset] === found[offset]) offset++;
    const actualOffset = Math.max(0, offset - 10);
    return {
      expectedLength: wanted.length, observedLength: found.length, previousLength, firstDifference: offset + 1,
      differenceRegion: offset < previousLength ? 'previous-body' : 'current-block',
      ...(payload.includeDiffText === true ? {excerpt:{
        expected:wanted.slice(actualOffset,offset + 11).join(''),
        observed:found.slice(actualOffset,offset + 11).join('')
      }} : {})
    };
  }
  const photoSource = img => img.getAttribute('src') || img.currentSrc || '';
  function photoAsset(img) {
    const src = photoSource(img);
    if (!sharedInput || !src) return src;
    let url;
    try { url = new URL(src, bodyDoc.baseURI); } catch { return src; }
    const blogCdn = /^(?:blogfiles|blogpfthumb|postfiles|mblogthumb-phinf)\.(?:pstatic\.net|naver\.net)$/i;
    if (!blogCdn.test(url.hostname)) return src;
    const size = url.searchParams.getAll('type');
    if (size.length && size.every(value => /^(?:w|s|f)\d+(?:_\d+)?$/i.test(value))) url.searchParams.delete('type');
    return url.origin + url.pathname + url.search;
  }
  const photoRecord = img => JSON.stringify([
    img.closest('.se-component.se-image')?.id || '', photoAsset(img),
    read(img.closest('.se-component.se-image')?.querySelector('.se-caption'))
  ]);
  function lastWrittenText(rows) {
    if (sharedInput) return (rows ?? authoredRows()).at(-1)?.node;
    const semantic = '.se-text-paragraph,h2,h3,p,li,blockquote,[role="heading"],.se-quote-text';
    const candidates = [...container.querySelectorAll(semantic)].filter(node => !node.closest(bodyRegionExclusions)
      && visible(node) && read(node));
    const parents = new Set();
    for (const row of candidates) {
      const parent = row.parentElement.closest(semantic);
      if (parent) parents.add(parent);
    }
    return candidates.findLast(node => !parents.has(node));
  }
  function sharedFlow(rows = authoredRows()) {
    const text = rows.map(row => ({anchor:row.anchor, content:['text',row.text]}));
    const images = photos().map(image => ({anchor:image, content:['photo',photoRecord(image)]}));
    return [...text, ...images].sort((a, b) => precedes(a.anchor, b.anchor) ? -1 : 1).map(item => item.content);
  }
  function flowThroughLastPhoto(rows) {
    const flow = sharedFlow(rows);
    return JSON.stringify(flow.slice(0, flow.findLastIndex(([kind]) => kind === 'photo') + 1));
  }
  function signature() {
    const rows = sharedInput ? authoredRows() : undefined;
    const nonempty = new Set(rows?.map(row => row.node.closest('.se-component.se-text')));
    return JSON.stringify({
      title: read(title), body: bodyText(rows),
      media: photos().map(img => sharedInput ? photoRecord(img) : photoSource(img)),
      ...(sharedInput ? {flow: sharedFlow(rows)} : {}),
      shape: [...container.querySelectorAll('h2,h3,ul,ol,blockquote,.se-component')]
        .filter(node => !sharedInput || !node.matches('.se-component.se-text') || nonempty.has(node))
        .map(node => node.tagName + ':' + (sharedInput
          ? [...node.classList].filter(name => !name.startsWith('se-is-')).join(' ') : node.className || ''))
    });
  }
  const occupied = !!read(title) || !!bodyText() || photos().length > 0
    || !!container.querySelector('.se-component:not(.se-text):not(.se-documentTitle), iframe, video, table, figure');
  if (mode === 'probe') return { found: true, occupied, token, sharedInput: !!sharedInput, inputPath, imageReady: !!upload() || !!photoToolbar() };
  if (payload.token !== token) return { status: 'review', message: '글쓰기 문서가 바뀌었습니다. 편집기를 확인해주세요.' };

  function selection(node, end = true) {
    const editable = node.closest('[contenteditable="true"]') || body;
    editable.focus();
    const range = bodyDoc.createRange();
    range.selectNodeContents(node);
    range.collapse(!end);
    const selected = bodyDoc.getSelection();
    selected.removeAllRanges();
    selected.addRange(range);
  }

  function sharedSelection(node, end) {
    const paragraph = node.closest('.se-text-paragraph') || node;
    paragraph.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const caret = bodyDoc.createRange();
    const box = paragraph.getBoundingClientRect();
    const walker = bodyDoc.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
    let lastText;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      if (normalized(current.textContent) && !current.parentElement.closest('.se-placeholder,.se-blind')) lastText = current;
    }
    if (end && lastText) {
      caret.setStart(lastText, lastText.length);
      caret.collapse(true);
    } else {
      caret.selectNodeContents(paragraph);
      caret.collapse(!end);
    }
    const caretBox = caret.getBoundingClientRect();
    const fitX = value => Math.max(box.left + 1, Math.min(box.right - 1, value));
    let x = fitX(caretBox.height ? caretBox.left : box.left + 6);
    const y = caretBox.height ? caretBox.top + caretBox.height / 2 : box.top + box.height / 2;
    if (end && lastText && typeof bodyDoc.caretRangeFromPoint === 'function') {
      const endX = [x + 1, x + 4, x + 9, x].map(fitX).find(candidate => {
        const hit = bodyDoc.caretRangeFromPoint(candidate, y);
        if (!hit || !paragraph.contains(hit.startContainer)) return false;
        const remaining = bodyDoc.createRange();
        remaining.selectNodeContents(paragraph);
        remaining.setStart(hit.startContainer, hit.startOffset);
        return !normalized(remaining.toString());
      });
      if (endX === undefined) throw Error('앞 문단 끝의 입력 위치를 확인하지 못했습니다.');
      x = endX;
    }
    const hit = bodyDoc.elementFromPoint(x, y);
    clickAt(paragraph.contains(hit) ? hit : paragraph, x, y);
    const input = sharedInput.contentDocument?.body;
    const currentTextSection = container.querySelector('.se-section-text.se-is-focused');
    const wantedSection = paragraph.closest('.se-section-text');
    if (bodyDoc.activeElement !== sharedInput || !input?.isContentEditable
      || currentTextSection !== wantedSection) {
      throw Error('네이버 편집기에서 제목 또는 본문에 커서를 놓지 못했습니다.');
    }
    return input;
  }

  function clickAt(target, x, y) {
    for (const type of ['mousedown', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, {
        bubbles: true, cancelable: true, view: bodyDoc.defaultView,
        button: 0, buttons: type === 'mousedown' ? 1 : 0, clientX: x, clientY: y, detail: 1
      }));
    }
  }

  function sendPaste(input, data) {
    const event = new input.ownerDocument.defaultView.ClipboardEvent('paste', {
      clipboardData: data, bubbles: true, cancelable: true, composed: true
    });
    input.dispatchEvent(event);
  }

  async function waitForText(test, attempts = 30) {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (test()) return true;
      await sleep(100);
    }
    return false;
  }

  function pasteText(input, text, html) {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    if (html) data.setData('text/html', html);
    sendPaste(input, data);
  }

  function lastBodyParagraph() {
    const selector = sharedInput ? '.se-section-text :is(.se-text-paragraph,p,h2,h3,li)' : 'p,h2,h3,li,blockquote,.se-text-paragraph';
    return [...container.querySelectorAll(selector)].findLast(node => visible(node) && !node.closest(bodyRegionExclusions));
  }

  function lastContent() {
    const text = lastWrittenText();
    const image = photos().at(-1);
    return image && (!text || precedes(text, image)) ? image : text;
  }

  async function checkedTail() {
    const last = lastBodyParagraph();
    const content = lastContent();
    if (last && (!content || last.contains(content) || precedes(content, last))) return last;
    if (!content && !sharedInput) return body;
    if (sharedInput) {
      const terminal = content || title;
      const component = terminal.closest('.se-component') || terminal;
      const canvas = container.closest('.se-canvas');
      component.scrollIntoView({block: 'center', inline: 'nearest'});
      let next;
      const hasBlankAfterContent = () => {
        next = lastBodyParagraph();
        return next && !read(next) && precedes(lastContent() || title, next);
      };
      const usable = scope => [...scope.querySelectorAll(bodyAdd)].filter(node =>
        visible(node) && !node.matches(':disabled,[aria-disabled="true"]') && isBodyAdd(node));
      const scoped = usable(component);
      const buttons = scoped.length ? scoped : usable(canvas).filter(node => !node.closest('.se-component'));
      if (buttons.length === 1) {
        buttons[0].click();
        if (await waitForText(hasBlankAfterContent, 12)) return next;
      }
      const box = component.getBoundingClientRect();
      const article = container.getBoundingClientRect();
      const x = Math.max(article.left + 1, Math.min(article.right - 1, (box.left + box.right) / 2));
      for (const offset of [12, 3, 24, 45]) {
        const y = box.bottom + offset;
        const hit = bodyDoc.elementFromPoint(x, y);
        if (!hit || hit.closest('.se-canvas') !== canvas || hit.closest('.se-component,button,a,input,[role="button"]')) continue;
        clickAt(hit, x, y);
        break;
      }
      if (await waitForText(hasBlankAfterContent)) return next;
    }
    throw Object.assign(Error('마지막 사진 또는 서식 구역 뒤에 다음 문단을 넣을 위치를 확인하지 못했습니다.'),
      {code:'BODY_TAIL_UNAVAILABLE'});
  }

  async function enterNaverTitle() {
    const input = sharedInput ? sharedSelection(title, false) : null;
    const pieces = new Intl.Segmenter('ko', {granularity:'grapheme'}).segment(payload.title);
    let entered = '';
    for (const {segment} of pieces) {
      if (!title.isConnected || read(title) !== normalized(entered) || photos().length || bodyText()) {
        throw Error('제목을 입력하는 중 편집기 내용이 바뀌었습니다.');
      }
      entered += segment;
      if (sharedInput) {
        if (bodyDoc.activeElement !== sharedInput || container.querySelector('.se-section-text.se-is-focused')) {
          throw Error('제목 입력 위치가 바뀌었습니다.');
        }
        pasteText(input, segment);
      } else {
        inputTitle(entered);
      }
      if (!await waitForText(() => read(title) === normalized(entered))) {
        throw Error('네이버 편집기가 제목의 일부를 반영하지 않았습니다.');
      }
      await sleep(45);
    }

  }

  async function appendNaverText(step, operation) {
    const before = comparableText(bodyText());
    const beforeTitle = read(title);
    const terminalBefore = lastContent();
    const last = await checkedTail();
    if (!last.isConnected || signature() !== operation.baseline) {
      throw Object.assign(Error('본문을 준비하는 중 편집기 내용이 바뀌었습니다.'),{code:'EDITOR_CHANGED_BEFORE_PASTE'});
    }
    const media = photos().map(photoRecord);
    const prefix = sharedInput ? flowThroughLastPhoto() : null;
    const addBreak = Boolean(read(last));
    const mayUsePlainInput = sharedInput && !addBreak && terminalBefore === photos().at(-1)
      && !!terminalBefore && precedes(terminalBefore,last);
    const html = (addBreak ? '<p><br></p>' : '') + step.html;
    let buffer;
    let bufferBefore;
    if (sharedInput) {
      buffer = sharedSelection(last, addBreak);
      bufferBefore = buffer.innerHTML;
      operation.unknown = true;
      pasteText(buffer, (addBreak ? '\n' : '') + step.text, html);
    } else {
      selection(last, addBreak);
      operation.unknown = true;
      if (!bodyDoc.execCommand('insertHTML', false, html)) throw Error('본문 입력이 거부되었습니다.');
    }
    const expected = before + comparableText(step.text);
    let reason;
    let observed;
    let code;
    let rowsCount;
    let observedPhotos;
    let photoOrderMatches;
    let prefixMatches;
    let changedDuringPaste = false;
    let nativeAttempted = false;
    let nativeCommandAccepted;
    let attempts = 0;
    const started = performance.now();
    function verified() {
      attempts++;
      const rows = sharedInput ? authoredRows() : undefined;
      const lastText = lastWrittenText(rows);
      const currentPhotos = photos();
      const lastPhoto = currentPhotos.at(-1);
      rowsCount = rows?.length;
      observedPhotos = currentPhotos.length;
      photoOrderMatches = media.length === currentPhotos.length && currentPhotos.every((img,index)=>photoRecord(img) === media[index]);
      observed = comparableText(bodyText(rows));
      prefixMatches = !sharedInput ? true : observed === expected ? prefix === flowThroughLastPhoto(rows) : undefined;
      if (observed !== before || !photoOrderMatches || read(title) !== beforeTitle
        || (buffer && buffer.innerHTML !== bufferBefore)) changedDuringPaste = true;
      if (read(title) !== beforeTitle) {
        code = 'TITLE_CHANGED';
        reason = '제목이 전송 중 바뀌었습니다.';
      } else if (!photoOrderMatches) {
        code = 'PREVIOUS_PHOTOS_CHANGED';
        reason = '앞서 넣은 사진을 다시 확인하지 못했습니다.';
      } else if (observed !== expected) {
        code = 'BODY_TEXT_MISMATCH';
        reason = '편집기에 표시된 본문에 누락되거나 달라진 글자가 있습니다.';
      } else if (!lastText || (lastPhoto && !precedes(lastPhoto, lastText)) || !prefixMatches) {
        code = 'BODY_PHOTO_ORDER_MISMATCH';
        reason = '사진과 본문이 예정한 순서로 들어갔는지 확인하지 못했습니다.';
      } else reason = '';
      return !reason;
    }
    let complete = await waitForText(verified,50);
    const richPasteWaitMs = Math.round(performance.now() - started);
    const strictUnchanged = () => buffer?.isConnected && signature() === operation.baseline
      && comparableText(bodyText(authoredRows(true))) === before && buffer.innerHTML === bufferBefore
      && !read(buffer) && !container.querySelector('[aria-busy="true"],[role="progressbar"]');
    if (!complete && mayUsePlainInput && code === 'BODY_TEXT_MISMATCH' && !changedDuringPaste
      && strictUnchanged() && last.isConnected && !read(last)
      && photos().at(-1) === terminalBefore && precedes(terminalBefore,last)) {
      buffer = sharedSelection(last,false);
      const focused = buffer.ownerDocument.getSelection();
      if (strictUnchanged() && focused?.isCollapsed && (!focused.anchorNode || buffer.contains(focused.anchorNode))) {
        nativeAttempted = true;
        nativeCommandAccepted = buffer.ownerDocument.execCommand('insertText',false,step.text);
        complete = await waitForText(verified,50);
      }
    }
    const native = {nativeAttempted,
      ...(!complete && sharedInput ? {
        eligibleAfterPhoto:Boolean(mayUsePlainInput), changedDuringPaste, baselineMatches:signature() === operation.baseline,
        bufferUnchanged:buffer?.innerHTML === bufferBefore, tailConnected:last.isConnected, tailBlank:!read(last),
        lastPhotoUnchanged:photos().at(-1) === terminalBefore, tableTextRows:authoredRows().filter(row => row.node.closest(tableCell)).length
      } : {}),...(nativeAttempted ? {nativeCommandAccepted,richPasteWaitMs} : {})};
    if (!complete) {
      const alternate = code === 'BODY_TEXT_MISMATCH' && sharedInput ? comparableText(bodyText(authoredRows(true))) : null;
      if (alternate === expected) code = 'BODY_READBACK_SCOPE_MISMATCH';
      else if (nativeAttempted && code === 'BODY_TEXT_MISMATCH' && observed === before) code = 'NATIVE_BODY_NOT_APPLIED';
      const updated = photos().map(photoRecord);
      const photoIndex = media.findIndex((record,index) => record !== updated[index]);
      const photoDiff = photoIndex < 0 ? {} : {
        changedPhotoIndex:photoIndex + 1,
        changedPhotoFields:updated[photoIndex] ? ['component','asset','caption'].filter((_,field) =>
          JSON.parse(media[photoIndex])[field] !== JSON.parse(updated[photoIndex])[field]) : ['missing']
      };
      const detail = {...photoDiff,pasteDispatched:true, attempts, waitMs: Math.round(performance.now() - started),
        expectedPhotos:media.length, observedPhotos, rowsCount, prefixMatches, photoOrderMatches,...native,
        ...(nativeAttempted ? {inputPath:'smarteditor-native-plain'} : {}),
        ...(alternate !== null ? {alternateTextLength:Array.from(alternate).length,alternateMatches:alternate===expected} : {}),
        ...(observed !== expected ? textDifference(expected, observed, Array.from(before).length) : {})};
      throw Object.assign(Error(reason),{diagnostic:diagnostic('verify-body',code,{...detail,source:'editor.appendNaverText'})});
    }
    return diagnostic('verify-body','BODY_VERIFIED',{pasteDispatched:true, attempts, waitMs:Math.round(performance.now() - started),
      expectedLength:Array.from(expected).length, observedLength:Array.from(observed).length, rowsCount,
      expectedPhotos:media.length, observedPhotos, prefixMatches, photoOrderMatches,...native,
      ...(nativeAttempted ? {inputPath:'smarteditor-native-plain'} : {})});
  }

  function inputTitle(value) {
    title.focus();
    if (title.matches('input,textarea')) {
      const prototype = title.matches('textarea') ? title.ownerDocument.defaultView.HTMLTextAreaElement.prototype
        : title.ownerDocument.defaultView.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(title, value);
      title.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const range = title.ownerDocument.createRange();
      range.selectNodeContents(title);
      const selected = title.ownerDocument.getSelection();
      selected.removeAllRanges();
      selected.addRange(range);
      if (!title.ownerDocument.execCommand('insertText', false, value)) throw Error('제목 입력이 거부되었습니다.');
    }
    title.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findBlock(block) {
    if (!block?.needle) return null;
    const elements = [...container.querySelectorAll('p,h2,h3,li,blockquote,.se-text-paragraph,[contenteditable="true"]')];
    const matches = elements.filter(node => node !== title && !title.contains(node) && read(node) === normalized(block.needle));
    const innermost = matches.filter(node => !matches.some(other => other !== node && node.contains(other)));
    return innermost.length === 1 ? innermost[0] : null;
  }

  function formatted(block) {
    const node = findBlock(block);
    if (!node) return false;
    if (block.type === 'heading') {
      if (platform === 'naver') {
        const hex = /^#[0-9a-f]{6}$/i.test(payload.accent) ? payload.accent.slice(1) : '08796b';
        const rgb = 'rgb(' + [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ') + ')';
        const textNodes = [node, ...node.querySelectorAll('span,strong,b,font')].filter(element =>
          visible(element) && [...element.childNodes].some(child => child.nodeType === 3 && child.textContent.trim()));
        return !!textNodes.length && textNodes.every(element => bodyDoc.defaultView.getComputedStyle(element).color === rgb);
      }
      return !!node.closest('h2,h3,[role="heading"]');
    }
    if (['list', 'ordered-list', 'checklist'].includes(block.type)) return !!node.closest('li');
    if (block.type === 'blockquote') return !!node.closest('blockquote,.se-quotation');
    if (block.type === 'callout') return !!(node.closest('strong,blockquote,.se-quotation') || node.querySelector('strong') || node.style.borderLeftWidth);
    if (block.type === 'faq') return !!(node.closest('strong') || node.querySelector('strong'));
    return true;
  }

  if (mode === 'begin') {
    if (session.has(payload.transferId) || occupied) return { status: 'blocked', message: '기존 글·사진이 있습니다. 새 빈 글쓰기창을 열어주세요.' };
    if (payload.hasPhotos && !upload() && !photoToolbar()) {
      return { status: 'blocked', message: '사진 첨부 입력창을 확인하지 못했습니다. 편집기의 사진 도구를 확인해주세요.' };
    }
    try {
      const expected = normalized(payload.plainText).replace(/\s/g, '');
      if (platform === 'naver') {
        await enterNaverTitle();
        session.clear();
        session.set(payload.transferId, {baseline: signature(), next: 0, cursor: 0, unknown: false});
        return {status: 'ok', formatWarnings: []};
      } else {
        selection(body, false);
        if (!bodyDoc.execCommand('insertHTML', false, payload.html)) throw Error('본문 입력이 거부되었습니다.');
        container.dispatchEvent(new Event('change', { bubbles: true }));
        inputTitle(payload.title);
      }
      if (platform !== 'naver' && !await waitForText(() => read(title) === normalized(payload.title) && bodyText().replace(/\s/g, '') === expected)) {
        return { status: 'review', message: '제목 또는 본문이 예상과 다릅니다. 편집기에서 들어간 내용을 확인해주세요.' };
      }
      const formatWarnings = payload.blocks.filter(block => block.type !== 'paragraph' && !formatted(block)).map(block => block.type);
      const formattedCount = payload.blocks.filter(block => block.type !== 'paragraph').length - formatWarnings.length;
      session.clear();
      session.set(payload.transferId, { baseline: signature(), next: 0, cursor: 0, unknown: false });
      return { status: 'ok', formatWarnings, formattedCount };
    } catch (error) {
      return { status: 'review', message: error.message + ' 입력된 내용을 편집기에서 확인해주세요.' };
    }
  }

  const operation = session.get(payload.transferId);
  if(mode==='resume' && operation?.unknown && operation.pendingPhoto && operation.cursor===payload.cursor){
    operation.pendingPhoto();
  }
  if (!operation || operation.unknown || signature() !== operation.baseline) {
    return { status: 'review', message: '편집기 내용 또는 진행 기록이 바뀌었습니다. 들어간 내용을 직접 확인해주세요.' };
  }
  if (mode === 'resume') {
    if (operation.cursor === payload.cursor || operation.cursor === payload.cursor + 1) {
      return {status: 'ok', cursor: operation.cursor, lastResult: operation.lastResult};
    }
    return {status: 'review', message: '입력 순서를 다시 확인해주세요.'};
  }
  if (operation.cursor !== payload.cursor) return {status: 'review', message: '입력 순서가 바뀌었습니다.'};

  function finishStep(result) {
    const baseline = signature();
    Object.assign(operation, {baseline, cursor: operation.cursor + 1, lastResult: result, unknown: false});
    return result;
  }

  if (mode === 'append' && platform === 'naver') {
    try {
      const verification = await appendNaverText(payload.step, operation);
      const format = payload.step.format;
      return finishStep({status: 'ok', diagnostic:verification,
        formatWarnings: format.type !== 'paragraph' && !formatted(format) ? [format.type] : []});
    } catch (error) {
      const safe = !operation.unknown && signature() === operation.baseline;
      return {status: safe ? 'retryable' : 'review', message: error.message + (safe
        ? ' 마지막 사진이나 서식 구역 아래에 빈 본문을 만든 뒤 이어넣을 수 있습니다.' : ' 입력된 내용을 편집기에서 확인해주세요.'),
        diagnostic:error.diagnostic || diagnostic(operation.unknown ? 'paste-body' : 'locate-body-input',
          error.code || 'BODY_INPUT_FAILED',{writeAttempted:operation.unknown,
            source:error.code === 'BODY_TAIL_UNAVAILABLE' ? 'editor.checkedTail' : 'editor.appendNaverText'})};
    }
  }
  if (mode !== 'photo') return { status: 'review', message: '지원하지 않는 입력 단계입니다.' };
  if (operation.next !== payload.index) return {status: 'review', message: '사진 순서가 바뀌었습니다. 편집기를 확인해주세요.'};

  const { image, anchor, following, tail } = payload;
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(image?.data || '')) {
    return { status: 'retryable', message: '사진 파일 형식을 확인해주세요. 이번 사진은 전송하지 않았습니다.' };
  }

  let dispatchPhoto;
  try {
    const node = tail ? await checkedTail() : anchor ? findBlock(anchor) : body;
    if (!node || (following && !findBlock(following))) {
      return { status: 'review', message: '사진을 배치할 위치를 확인하지 못했습니다. 편집기를 확인해주세요.' };
    }
    const blob = await (await fetch(image.data)).blob();
    if (signature() !== operation.baseline || !node.isConnected) {
      return { status: 'review', message: '사진 준비 중 편집기가 바뀌었습니다. 입력을 멈췄습니다.' };
    }
    const data = new DataTransfer();
    data.items.add(new File([blob], image.name || 'photo.png', { type: blob.type }));
    if (sharedInput) {
      const input = sharedSelection(node, tail ? Boolean(read(node)) : !!anchor);
      dispatchPhoto = () => sendPaste(input, data);
    } else {
      let field = upload();
      if (!field && photoToolbar()) {
        photoToolbar().click();
        for (let i = 0; i < 16 && !field; i++) { await sleep(100); field = upload(); }
      }
      if (!field) return { status: 'retryable', message: '사진 첨부 입력창이 없습니다. 이번 사진은 요청하지 않았습니다.' };
      if (signature() !== operation.baseline || !field.isConnected || !node.isConnected) {
        return { status: 'review', message: '사진 준비 중 편집기가 바뀌었습니다. 입력을 멈췄습니다.' };
      }
      selection(node, tail ? Boolean(read(node)) : !!anchor);
      field.files = data.files;
      dispatchPhoto = () => field.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } catch (error) {
    return { status: signature() === operation.baseline ? 'retryable' : 'review',
      message: '사진을 요청하기 전에 오류가 발생했습니다. ' + error.message,
      diagnostic:diagnostic('locate-photo-input',error.code || 'PHOTO_INPUT_FAILED',{pasteDispatched:false}) };
  }
  const before = new Set(photos());
  const beforeMedia = sharedInput ? Array.from(before, photoRecord) : [];
  const beforeTitle = read(title);
  const beforeBody = bodyText();
  const photoStarted = performance.now();
  const photoCheck = (code, current, attempts) => diagnostic('verify-photo',code,{
    inputPath:sharedInput ? 'smarteditor-file-paste' : 'file-input',
    pasteDispatched:true, waitMs:Math.round(performance.now() - photoStarted), attempts,
    expectedPhotos:before.size + 1, observedPhotos:current.length,
    loadedPhotos:current.filter(img => img.complete && img.naturalWidth > 0
      && /^https?:\/\//i.test(img.currentSrc || img.getAttribute('src') || '')).length
  });
  let photoAttempts = 0;
  // Once the site receives the event, a timeout never proves the photo was absent.
  operation.unknown = true;
  dispatchPhoto();
  function verifyPendingPhoto(){
    photoAttempts++;
    if (!container.isConnected || !title.isConnected) return null;
    const current = photos();
    const added = sharedInput && tail
      ? (current.length > before.size ? current.slice(before.size) : [])
      : current.filter(img => !before.has(img));
    if (added.length > 1) return null;
    const img = added[0];
    const src = img?.currentSrc || img?.getAttribute('src') || '';
    if (!src || !img.complete || !img.naturalWidth || !/^https?:\/\//i.test(src)) return null;
    const existingPhotosChanged = sharedInput && tail
      ? current.slice(0, beforeMedia.length).some((previous, index) => photoRecord(previous) !== beforeMedia[index])
      : [...before].some(previous => !current.includes(previous));
    if (read(title) !== beforeTitle || bodyText() !== beforeBody || existingPhotosChanged) {
      return null;
    }
    const left = anchor ? findBlock(anchor) : null;
    const right = following ? findBlock(following) : null;
    if ((anchor && (!left || !(left.compareDocumentPosition(img) & 4)))
      || (following && (!right || !(img.compareDocumentPosition(right) & 4)))) {
      return { status: 'review', message: '사진은 보이지만 예정한 위치와 다릅니다. 편집기에서 배치를 확인해주세요.',
        diagnostic:photoCheck('PHOTO_ORDER_MISMATCH',current,photoAttempts) };
    }
    if (tail && current.at(-1) !== img) {
      return {status: 'review', message: '사진이 마지막 위치에 추가되지 않았습니다. 배치를 확인해주세요.',
        diagnostic:photoCheck('PHOTO_ORDER_MISMATCH',current,photoAttempts)};
    }
    const lastText = tail ? lastWrittenText() : null;
    if (lastText && !precedes(lastText, img)) {
      return {status: 'review', message: '사진이 직전에 넣은 본문 뒤에 있는지 확인해주세요.',
        diagnostic:photoCheck('PHOTO_ORDER_MISMATCH',current,photoAttempts)};
    }
    delete operation.pendingPhoto;
    operation.next++;
    return finishStep({status: 'ok',diagnostic:photoCheck('PHOTO_VERIFIED',current,photoAttempts)});
  }
  operation.pendingPhoto=verifyPendingPhoto;
  for(let tries=0;tries<100;tries++){
    await sleep(150);
    const result=verifyPendingPhoto();
    if(result)return result;
  }
  return { status: 'retryable', message: '사진 처리가 끝난 후 상태를 다시 확인하면 일치하는 위치부터 이어갑니다.',
    diagnostic:photoCheck('PHOTO_NOT_CONFIRMED',photos(),photoAttempts) };
}
