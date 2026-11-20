const kinds = new Set(['paragraph', 'heading', 'list', 'ordered-list', 'callout', 'blockquote', 'checklist', 'faq']);
const scalar = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : '';
const plain = (value, limit = 8000) => scalar(value, limit).replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
  .replace(/^\s*#{1,6}\s+/gm, '').replace(/\*\*(.+?)\*\*/g, '$1').trim();
export const escape = value => String(value).replace(/[&<>"']/g, value =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value]);
export const splitBody = value => scalar(value, 60000).split(/\n\s*\n/).map(value => value.trim()).filter(Boolean);
export function shortHeading(value) {
  const phrase = plain(value).normalize('NFC').replace(/\s+/g, ' ');
  const characters = Array.from(phrase);
  if (characters.length < 15) return phrase;
  const cut = characters.slice(0, 14).join('').trimEnd();
  const boundary = cut.lastIndexOf(' ');
  return boundary >= 8 && characters[14] !== ' ' ? cut.slice(0, boundary) : cut;
}

function listItems(raw, depth = 0) {
  if (!Array.isArray(raw) || depth > 2) return [];
  return raw.slice(0, 20).flatMap(value => {
    const text = plain(typeof value === 'string' ? value : value?.text, 1000);
    return text ? [{ text, children: listItems(value?.children, depth + 1) }] : [];
  });
}

function asSupportedBlock(value) {
  if (value?.type === 'steps' || value?.type === 'comparison') {
    const ordered = value.type === 'steps';
    const items = Array.isArray(value.items) ? value.items.map(item => {
      const label = plain(ordered ? item?.title : item?.label, 250);
      const description = plain(item?.text, 1000);
      return label ? { text:label, children:description ? [description] : [] } : description;
    }) : [];
    return {...value, type:ordered ? 'ordered-list' : 'list', items};
  }
  if (value?.type === 'pros_cons') {
    const items = [['장점',value.pros],['단점',value.cons]].flatMap(([text,children]) =>
      Array.isArray(children) && children.length ? [{text, children}] : []);
    return {...value,type:'list',items};
  }
  return value;
}

export function normalizeContent(raw) {
  if (!Array.isArray(raw)) return [];
  const used = new Set();
  return raw.slice(0, 100).flatMap((rawBlock, index) => {
    const value = asSupportedBlock(rawBlock);
    const type = value?.type === 'lead' || value?.type === 'cta' ? 'paragraph' : value?.type;
    if (!kinds.has(type)) return [];
    let id = /^[a-z0-9_-]{1,50}$/i.test(value.id || '') ? value.id : 'block-' + (index + 1);
    while (used.has(id)) id = '_' + id;
    used.add(id);
    if (['list', 'ordered-list', 'checklist'].includes(type)) {
      const items = listItems(value.items);
      if (type === 'ordered-list' && items.some(item => item.children.length)) {
        for (const item of items) item.text = item.text.replace(/^\s*\d+[.)]\s+/, '');
      }
      return [{ id, type, text: plain(value.text, 250), items }];
    }
    if (type === 'faq') {
      const items = Array.isArray(value.items) ? value.items.slice(0, 16).map(item => ({
        question: plain(item?.question, 700).replace(/^(?:Q\.|Question:)\s*/i, ''),
        answer: plain(item?.answer, 2400).replace(/^(?:A\.|Answer:)\s*/i, '')
      })) : [];
      return [{ id, type, text: plain(value.text, 250), items }];
    }
    return [{
      id, type, text: type === 'heading' ? shortHeading(value.text) : plain(value.text),
      ...(type === 'heading' ? { level: value.level === 3 ? 3 : 2 } : {}),
      ...(type === 'callout' ? { title: plain(value.title, 250), variant: ['tip','summary','warning'].includes(value.variant) ? value.variant : 'summary' } : {})
    }];
  });
}

function listTexts(items) {
  return items.flatMap(item => [item.text, ...listTexts(item.children || [])]);
}

export function textOfBlock(block) {
  if (['list', 'ordered-list', 'checklist'].includes(block.type)) return listTexts(block.items).join('\n');
  if (block.type === 'faq') return block.items.flatMap(item => ['Q. ' + item.question, 'A. ' + item.answer]).join('\n');
  return [block.title, block.text].filter(Boolean).join('\n');
}

export function blocksOf(draft) {
  const blocks=unmarkedBlocks(draft);
  const last = blocks.at(-1);
  if (last?.type === 'paragraph' && /[?？]$/.test(last.text.trim())) {
    const parts = last.text.trim().match(/^([\s\S]+[.!?。])\s+([^.!?。？]+[?？])$/u);
    if (parts) {
      let id = last.id + '-closing';
      while (blocks.some(block => block.id === id)) id += '_';
      blocks.splice(-1, 1, {...last,id,text:parts[1]}, {...last,text:parts[2].trim()});
    }
  }
  const closing = blocks.at(-1);
  if (closing?.type === 'paragraph' && /[?？]$/.test(closing.text.trim())) {
    blocks[blocks.length - 1] = {...closing, closingQuestion:true};
  }
  const keywords=(draft.hashtags||[]).map(t=>t.replace(/^#/,'')).filter(Boolean);
  const choices=[];
  for(const block of blocks){
    if(block.type!=='paragraph'||block.closingQuestion||block.id.startsWith('editorial-'))continue;
    const words=[...block.text.matchAll(/[^\s.!?。]+/gu)];
    const spans=[];
    for(let i=0;i<words.length;i++){
      for(let j=i;j<words.length;j++){
        const start=words[i].index,end=words[j].index+words[j][0].length;
        const phrase=block.text.slice(start,end),length=Array.from(phrase).length;
        if(length>15)break;
        if(length>=10)spans.push({block,start,end,score:keywords.filter(k=>phrase.includes(k)).length});
      }
    }
    spans.sort((a,b)=>b.score-a.score);
    if(spans.length)choices.push(spans[0]);
  }
  choices.sort((a,b)=>b.score-a.score);
  const marks=new Map(choices.slice(0,5).map((span,i)=>[span.block,{...span,kind:['yellow','underline','mint','underline','yellow'][i]}]));
  return blocks.map(block=>marks.has(block)?{...block,mark:marks.get(block)}:block);
}
function unmarkedBlocks(draft) {
  if (draft.content?.length) {
    const ids = new Set(draft.content.map(block => block.id));
    return draft.content.flatMap(block => {
      if (!['callout','blockquote'].includes(block.type)) return [block];
      const lines = (block.text || '').trim().split(/\n+/);
      const title = block.title?.trim() || (Array.from(lines[0]).length <= 14 ? lines.shift() : '');
      const body = lines.join('\n').trim();
      if (!title) return [{id:block.id,type:'paragraph',text:body}];
      let id = block.id;
      if (body) {
        id += '-heading';
        while (ids.has(id)) id += '_';
        ids.add(id);
      }
      const heading = {id,type:'heading',level:2,text:shortHeading(title)};
      return body ? [heading,{id:block.id,type:'paragraph',text:body}] : [heading];
    });
  }
  return splitBody(draft.body).map((text, index) => ({ id: 'legacy-' + (index + 1), type: 'paragraph', text }));
}

export function imageAnchor(image, blocks) {
  if (image.afterBlockId) {
    return blocks.some(block => block.id === image.afterBlockId) ? image.afterBlockId : undefined;
  }
  const index = Math.max(0, Number(image.afterParagraph) || 0);
  return index === 0 ? '' : blocks[Math.min(index, blocks.length) - 1]?.id;
}

export function orderedImages(images, blocks) {
  const indexes = new Map(blocks.map((block, index) => [block.id, index + 1]));
  indexes.set('', 0);
  return images.map(image => ({ ...image, anchor: imageAnchor(image, blocks) }))
    .sort((a, b) => (indexes.get(a.anchor) ?? Infinity) - (indexes.get(b.anchor) ?? Infinity));
}

export function fixedPhotoPosition(image) {
  return image.placement === 'fixed' || (image.placement !== 'auto' && Boolean(image.afterBlockId || image.afterParagraph > 0));
}

export function photoPlacements(images, blocks, platform) {
  if (platform !== 'naver' || !images.length) return orderedImages(images, blocks);
  const thumbnail = images.find(image => image.thumbnail) || images[0];
  const bodyPhotos = images.filter(image => image.id !== thumbnail.id).map(image => {
    const fixed = fixedPhotoPosition(image);
    return {...image, thumbnail: false, fixed, anchor: fixed ? imageAnchor(image, blocks) : undefined};
  });
  const reserved = new Set(bodyPhotos.filter(image => image.fixed).map(image => image.anchor));
  const available = blocks.filter(block => block.type === 'paragraph' && !reserved.has(block.id));
  let automatic = 0;
  return [{...thumbnail, anchor: '', thumbnail: true}, ...bodyPhotos.map(image => image.fixed ? image : {
    ...image, anchor: available[automatic++]?.id ?? blocks.at(-1)?.id ?? ''
  })];
}

const htmlText = value => escape(value).replace(/\n/g, '<br>');
function listHTML(items, tag, checklist = false) {
  return '<' + tag + (checklist ? ' style="list-style:none;padding-left:12px">' : '>')
    + items.map(item => '<li>' + (checklist ? '☐ ' : '') + htmlText(item.text)
    + (item.children?.length ? listHTML(item.children, 'ul') : '') + '</li>').join('') + '</' + tag + '>';
}

export function renderBlock(block, accent, article = false, naver = false, preview = false) {
  if(block.id?.startsWith('editorial-divider-') && block.text==='---')return '<hr>';
  let content = htmlText(block.text || '');
  if(block.mark){
    const {start,end,kind}=block.mark;
    const phrase=htmlText(block.text.slice(start,end));
    const highlighted=kind==='underline'?(naver ? '<u>'+phrase+'</u>' : '<strong><u>'+phrase+'</u></strong>'):'<span style="background-color:'+(kind==='mint'?'#b8f2de':'#fff1a8')+'">'+phrase+'</span>';
    content=htmlText(block.text.slice(0,start))+highlighted+htmlText(block.text.slice(end));
  }
  const base = 'font-size:16px;font-weight:400;text-decoration:none;color:' + (preview ? 'inherit' : '#222222');
  const bodyText = html => '<span style="' + base + '">' + html + '</span>';
  const paragraph = html => '<p style="' + base + '">' + bodyText(html) + '</p>';
  const accented = 'border-left:4px solid ' + accent
    + (article ? ';background-color:' + accent + '14;padding:10px 12px;border-radius:8px' : ';padding-left:10px');
  const label = article && content ? '<p><strong>' + content + '</strong></p>' : '';
  switch (block.type) {
    case 'heading': {
      if (!naver) return '<h2 style="font-size:24px;font-weight:700;color:'+accent+'">'+content+'</h2>';
      return '<p style="font-size:24px;font-weight:700"><strong><span style="font-size:24px;font-weight:700;color:'+accent+'">'+content+'</span></strong></p>';
    }
    case 'blockquote': return '<blockquote>' + content + '</blockquote>';
    case 'callout': return '<p style="' + accented + '">'
      + (block.title ? '<strong>' + htmlText(block.title) + '</strong><br>' : '<strong>' + content + '</strong>')
      + (block.title ? content : '') + '</p>';
    case 'list': case 'checklist': return label + listHTML(block.items, 'ul', article && block.type === 'checklist');
    case 'ordered-list':
      if (block.items.some(item => item.children?.length)) {
        return label + block.items.map(item => paragraph('<strong><u>' + htmlText(item.text) + '</u></strong>')
          + (item.children?.length ? '<div style="' + base + '">' + listHTML(item.children,'ul') + '</div>' : '')
          + '<p><br></p>').join('');
      }
      return label + listHTML(block.items, 'ol');
    case 'faq': return (article && content ? '<h2 style="' + accented + '">' + content + '</h2>' : '')
      + block.items.map(item => '<p><strong>Q. ' + htmlText(item.question)
      + '</strong><br>A. ' + htmlText(item.answer) + '</p>').join('');
    default: return (block.closingQuestion ? '<p><br></p>' : '') + paragraph(content);
  }
}
