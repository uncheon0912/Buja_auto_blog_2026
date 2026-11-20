import { blocksOf, photoPlacements, renderBlock, textOfBlock } from './2026-11-18-document.mjs';
import { getData } from './2026-11-18-assets.mjs';
import { connectionKey, transferKey, platformNames, platformOf } from './2026-11-18-platforms.mjs';
import { editorBridge } from './2026-11-18-editor.mjs';

export async function connectionFor(windowId) {
  const key = connectionKey(windowId);
  return (await chrome.storage.session.get(key))[key] || null;
}

export async function transferFor(windowId) {
  const key = transferKey(windowId);
  return (await chrome.storage.session.get(key))[key] || null;
}

const activeTransfers = new Set();

export async function clearDraftTransfers(draftId,windowId){
  if(activeTransfers.size)throw Error('전송이 끝난 뒤 초안을 지워주세요.');
  const values=await chrome.storage.session.get(null);
  const keys=Object.keys(values).filter(key=>key.startsWith('transfer:') && (values[key]?.draftId===draftId || (key===transferKey(windowId) && !values[key]?.draftId)));
  if(keys.length)await chrome.storage.session.remove(keys);
}

export async function recoverTransfer(windowId) {
  const previous = await transferFor(windowId);
  if (previous?.status !== 'running' || activeTransfers.has(windowId)) return previous;
  const connection = await connectionFor(windowId);
  const checked = await checkResume(connection, previous);
  const recovered = {
    ...previous, status: checked ? 'retryable' : 'review',
    message: checked ? progressMessage(previous, '전송이 중단됐습니다. 확인된 위치부터 이어넣을 수 있습니다.')
      : progressMessage(previous, '전송이 중단됐습니다. 편집기에 들어간 내용을 확인해주세요.')
  };
  if (activeTransfers.has(windowId)) return transferFor(windowId);
  await chrome.storage.session.set({ [transferKey(windowId)]: recovered });
  return recovered;
}

export async function connectEditor(windowId, tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || tab.windowId !== windowId || !tab.active) {
    throw Error('연결하려는 글쓰기 화면을 선택한 상태에서 다시 눌러주세요.');
  }
  const platform = platformOf(tab.url);
  if (!platform) throw Error('네이버 블로그·카페 또는 티스토리의 새 글쓰기창을 열어주세요.');
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true }, func: editorBridge, args: ['probe', platform]
  });
  const matches = results.filter(item => item.result?.found);
  if (matches.length !== 1 || !matches[0].documentId) {
    if (platform === 'naver' && /(?:[?&]Redirect=Write|\/PostWriteForm\.naver(?:[?#]|$))/i.test(tab.url)) {
      throw Error('네이버 글쓰기 탭은 열려 있지만 편집기 입력 구조를 확인하지 못했습니다. 글쓰기창 로딩을 확인한 뒤 다시 연결해주세요.');
    }
    throw Error(platformNames[platform] + ' 새 글쓰기창을 확인하지 못했습니다. 로그인과 제목·본문 입력창을 확인해주세요.');
  }
  if (matches[0].result.occupied) throw Error('이미 내용이 들어 있는 글쓰기창입니다. 새 빈 글쓰기창을 열어주세요.');
  const current = await chrome.tabs.get(tabId).catch(() => null);
  if (!current?.active || current.windowId !== windowId || current.url !== tab.url) {
    throw Error('확인하는 동안 탭이 바뀌었습니다. 연결 버튼을 다시 눌러주세요.');
  }
  const connection = {
    tabId, windowId, platform, platformName: platformNames[platform], title: (tab.title || '').slice(0, 200),
    url: tab.url, frameId: matches[0].frameId, documentId: matches[0].documentId,
    token: matches[0].result.token, invalid: false
  };
  await chrome.storage.session.set({ [connectionKey(windowId)]: connection, [transferKey(windowId)]: null });
  return connection;
}

export async function disconnectEditor(windowId) {
  await chrome.storage.session.remove([connectionKey(windowId), transferKey(windowId)]);
}

async function invoke(connection, mode, payload) {
  const results = await chrome.scripting.executeScript({
    target: { tabId: connection.tabId, documentIds: [connection.documentId] },
    func: editorBridge, args: [mode, connection.platform, { ...payload, token: connection.token }]
  });
  if (!results[0]?.result) throw Error('연결한 편집기의 응답을 받지 못했습니다.');
  return results[0].result;
}

async function getConnected(windowId) {
  const connection = await connectionFor(windowId);
  if (!connection || connection.invalid) throw Error(connection?.reason || '현재 탭 연결을 눌러주세요.');
  const tab = await chrome.tabs.get(connection.tabId).catch(() => null);
  const stale = async reason => {
    await invalidateEditor(connection.tabId, reason);
    throw Error(reason);
  };
  if (!tab || tab.windowId !== windowId || tab.url !== connection.url || platformOf(tab.url) !== connection.platform) {
    return stale('연결된 탭이 이동하거나 닫혔습니다. 현재 탭을 다시 연결해주세요.');
  }
  const probe = await invoke(connection, 'probe', {}).catch(() => null);
  if (!probe?.found || probe.token !== connection.token) {
    return stale('연결한 편집기가 새로고침되거나 이동했습니다. 현재 탭을 다시 연결해주세요.');
  }
  return { connection, probe };
}

export async function insertGalleryPhoto(windowId,image){
  if(activeTransfers.has(windowId)) throw Error('자동 전송이 끝난 뒤 삽입해 주세요.');
  activeTransfers.add(windowId);
  try {
    const {connection}=await getConnected(windowId);
    if(connection.platform!=='naver') throw Error('네이버 블로그 글쓰기 탭을 연결해 주세요.');
    const result=await invoke(connection,'manualPhoto',{image:{name:image.name,data:await getData(image.id)}});
    if(result.status!=='ok') throw Error(result.message || '편집기에서 사진을 확인해 주세요.');
  } finally {activeTransfers.delete(windowId);}
}

export async function focusConnected(windowId) {
  const { connection } = await getConnected(windowId);
  await chrome.tabs.update(connection.tabId, { active: true });
  await chrome.windows.update(connection.windowId, { focused: true });
}

export async function invalidateEditor(tabId, reason) {
  const values = await chrome.storage.session.get(null);
  const updates = {};
  for (const [key, value] of Object.entries(values)) {
    if (key.startsWith('connection:') && value?.tabId === tabId && !value.invalid) {
      updates[key] = { ...value, invalid: true, reason };
      const statusKey = transferKey(value.windowId);
      const transfer = values[statusKey];
      if (transfer && ['running', 'retryable'].includes(transfer.status)) {
        updates[statusKey] = { ...transfer, status: 'review', message: reason };
      }
    }
  }
  if (Object.keys(updates).length) await chrome.storage.session.set(updates);
}

function firstOrLastItem(items, last) {
  const item = last ? items.at(-1) : items[0];
  return item?.children?.length && last ? firstOrLastItem(item.children, last) : item?.text || '';
}

function boundary(block, last) {
  if (!block) return null;
  const type = block.type;
  let needle = textOfBlock(block);
  if (['list', 'ordered-list', 'checklist'].includes(type)) {
    needle = firstOrLastItem(block.items, last);
  } else if (type === 'faq') {
    const item = last ? block.items.at(-1) : block.items[0];
    needle = item ? 'Q. ' + item.question + ' A. ' + item.answer : '';
  }
  return { type, needle };
}

export function buildTransferPlan(draft, form, photos, platform) {
  const blocks = blocksOf(draft).filter(block => textOfBlock(block).trim());
  const naver = platform === 'naver';
  const tagCandidates = [...(draft.hashtags || []), ...(form.keywords || '').split(/[,\n]+/)];
  const tags = naver ? [...new Set(tagCandidates.map(tag =>
    tag.normalize('NFC').replace(/[^\p{L}\p{N}_]/gu, '')).filter(Boolean))].slice(0, 8) : [];
  const tagLine = tags.map(tag => '#' + tag).join(' ');
  const tagBlock = tagLine ? { type: 'paragraph', text: tagLine } : null;
  const indexes = new Map(blocks.map((block, index) => [block.id, index]));
  indexes.set('', -1);
  const placed = photoPlacements(photos, blocks, platform).map(image => {
    if (image.anchor === undefined) throw Error('사진 위치가 바뀌었습니다. 갤러리에서 새 위치를 지정해주세요.');
    const index = indexes.get(image.anchor);
    return naver ? image : { ...image, left: boundary(blocks[index], true), right: boundary(blocks[index + 1] || tagBlock, false) };
  });
  const title = draft.title?.trim();
  if (!title || !blocks.length) throw Error('제목과 본문을 먼저 작성해주세요.');
  const accent = /^#[0-9a-f]{6}$/i.test(form.accent) ? form.accent : '#08796b';
  const steps = [...blocks, ...(tagBlock ? [tagBlock] : [])].map(block => ({
    text: textOfBlock(block), html: naver && block.id?.startsWith('editorial-divider-') && block.text==='---' ? '<p>---</p>' : renderBlock(block, accent, false, naver), format: boundary(block, true)
  }));
  const sequence = [];
  const images = [];
  function addPhoto(photo) {
    sequence.push({photoIndex: images.length});
    images.push(photo);
  }
  if (naver) {
    placed.filter(photo => photo.anchor === '').forEach(addPhoto);
    for (const [index, block] of blocks.entries()) {
      sequence.push({textIndex: index});
      placed.filter(photo => photo.anchor === block.id).forEach(addPhoto);
    }
    if (tagBlock) sequence.push({textIndex: blocks.length});
  } else {
    placed.forEach(addPhoto);
  }
  return { title, plainText: steps.map(step => step.text).join('\n'), html: steps.map(step => step.html).join(''),
    blocks: blocks.map(block => boundary(block, true)), images, steps, sequence, accent, tagCount:tags.length };
}

async function hash(plan) {
  const signature = JSON.stringify(plan);
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signature)));
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function progressMessage(progress, detail) {
  if (!progress.titleDone) return detail;
  const label = progress.thumbnailDone ? `썸네일 완료 · 사진 ${progress.completed}장` : `사진 ${progress.completed}장`;
  return `제목 완료 · ${label} · 본문 ${progress.textDone}개 완료\n${detail}`;
}

async function checkResume(connection, progress) {
  if (!connection || connection.invalid || progress.documentId !== connection.documentId) return null;
  const result = await invoke(connection, 'resume', {transferId: progress.id, cursor: progress.cursor}).catch(() => null);
  return result?.status === 'ok' ? result : null;
}

function confirmedStep(plan, progress, cursor, result) {
  const {textIndex, photoIndex} = plan.sequence[cursor];
  return {
    cursor: cursor + 1,
    titleDone: true,
    completed: photoIndex === undefined ? progress.completed : photoIndex + 1,
    ...(Number.isInteger(result.diagnostic?.loadedPhotos) ? {loadedPhotos:result.diagnostic.loadedPhotos} : {}),
    textDone: textIndex === undefined ? progress.textDone : textIndex + 1,
    thumbnailDone: progress.thumbnailDone || (photoIndex === 0 && !!plan.images[photoIndex].thumbnail),
    formatWarnings: [...progress.formatWarnings, ...(result.formatWarnings || [])]
  };
}

export async function sendDraft(windowId, state, retry = false, report = async () => {}, includeDiffText = false) {
  if (activeTransfers.has(windowId)) throw Error('이 창에서 이미 전송 중입니다.');
  activeTransfers.add(windowId);
  try {
    return await runTransfer(windowId, state, retry, report, includeDiffText);
  } finally {
    activeTransfers.delete(windowId);
  }
}

async function runTransfer(windowId, { draft, form, images }, retry, report, includeDiffText) {
  const previous = retry ? await transferFor(windowId) : null;
  const id = previous?.id || crypto.randomUUID();
  const record = (event, details) => report(event,{operationId:id, retry, ...details}).catch(()=>{});
  await record('전송 연결 확인 시작',{stage:'probe-editor',source:'transfer.getConnected'});
  let connection;
  let probe;
  try {
    ({connection,probe} = await getConnected(windowId));
  } catch (error) {
    await record('전송 연결 확인 실패',{stage:'probe-editor',code:'TRANSFER_EDITOR_UNAVAILABLE',source:'transfer.getConnected'});
    throw error;
  }
  const target = {platform:connection.platform,frameId:connection.frameId,inputPath:probe.inputPath};
  await record('전송 연결 확인 완료',{stage:'probe-editor',source:'transfer.getConnected',...target});
  const photos = images.filter(image => image.draftId === draft.id);
  if (photos.length > 10 || photos.reduce((size, item) => size + item.size, 0) > 24 * 1024 * 1024) {
    await record('전송 계획 확인 실패',{...target,stage:'plan',source:'transfer.runTransfer',
      code:'PHOTO_LIMIT_EXCEEDED',expectedPhotos:photos.length});
    throw Error('한 번에 최대 10장, 총 24MB까지 전송할 수 있습니다.');
  }
  let plan;
  try {
    plan = buildTransferPlan(draft, form, photos, connection.platform);
  } catch (error) {
    await record('전송 계획 확인 실패',{...target,stage:'plan',source:'transfer.buildTransferPlan',
      code:'TRANSFER_PLAN_INVALID',expectedPhotos:photos.length});
    throw error;
  }
  const fingerprint = await hash(plan);
  const key = transferKey(windowId);
  if (!retry && probe.occupied) {
    await record('전송 계획 확인 실패',{...target,stage:'plan',source:'transfer.runTransfer',code:'EDITOR_OCCUPIED'});
    throw Error('편집기에 기존 글·사진이 있습니다. 새 빈 글쓰기창에 연결해주세요.');
  }
  if (retry && (previous?.status !== 'retryable' || previous.fingerprint !== fingerprint || previous.documentId !== connection.documentId)) {
    await record('이어넣기 확인 실패',{...target,stage:'resume',source:'transfer.runTransfer',code:'RESUME_PLAN_CHANGED'});
    throw Error('초안이나 편집기가 바뀌었습니다. 현재 편집기를 확인해주세요.');
  }
  const progress = retry ? { ...previous, status: 'running' } : {
    id, draftId:draft.id, fingerprint, documentId: connection.documentId, status: 'running',
    completed: 0, cursor: 0, total: photos.length, titleDone: false, textDone: 0, thumbnailDone: false,
    bodyDone: false, formatWarnings: []
  };
  const update = async values => {
    Object.assign(progress, values);
    await chrome.storage.session.set({ [key]: progress });
  };
  await record('전송 계획 준비',{...target,stage:'plan',source:'transfer.buildTransferPlan',
    expectedTextBlocks:plan.blocks.length,expectedPhotos:plan.images.length,expectedTags:plan.tagCount});
  if (retry) {
    const checked = await checkResume(connection, progress);
    if (!checked) {
      await record('이어넣기 확인 실패',{...target,stage:'resume',code:'RESUME_BASELINE_MISMATCH',source:'editor.editorBridge'});
      await update({status: progress.pendingPhoto ? 'retryable' : 'review', message: progressMessage(progress, '편집기 내용이나 순서를 확인할 수 없습니다. 입력된 내용을 확인해주세요.')});
      return progress;
    }
    if (checked.cursor > progress.cursor) Object.assign(progress, confirmedStep(plan, progress, progress.cursor, checked.lastResult));
    progress.titleDone = true;
  }
  await update({ message: retry ? progressMessage(progress, '확인된 위치부터 이어넣습니다.') : '제목을 입력하고 있습니다.' });
  let failedStage = 'read-photos';
  let stepContext = {};
  try {
    // Read all original attachments before making any change to the editor.
    const files = new Map();
    for (const photo of plan.images.slice(progress.completed)) files.set(photo.id, await getData(photo.id));
    await record('전송용 사진 읽기 완료',{...target,stage:'read-photos',source:'assets.getData',readPhotos:files.size});
    if (probe.sharedInput) {
      failedStage = 'activate-editor';
      await chrome.tabs.update(connection.tabId, { active: true });
      const active = await chrome.tabs.get(connection.tabId);
      if (!active.active || active.windowId !== windowId || active.url !== connection.url) {
        throw Error('네이버 글쓰기창을 활성화하지 못했습니다.');
      }
    }
    if (!retry) {
      failedStage = 'title';
      await record('제목 입력 시작',{...target,stage:failedStage,source:'editor.editorBridge'});
      const result = await invoke(connection, 'begin', {
        transferId: progress.id, title: plan.title, html: plan.html, plainText: plan.plainText,
        blocks: plan.blocks, accent: plan.accent, hasPhotos: !!photos.length
      });
      if (result.status !== 'ok') {
        await record('제목 입력 실패',{...target,stage:failedStage,code:'EDITOR_BEGIN_FAILED',source:'editor.editorBridge',status:result.status});
        await update({ status: result.status, message: result.message });
        return progress;
      }
      await update({ titleDone: true, bodyDone: connection.platform !== 'naver',
        textDone: connection.platform === 'naver' ? 0 : plan.steps.length, formatWarnings: result.formatWarnings || [] });
      await record('제목 입력 검증 완료',{...target,stage:failedStage,code:'TITLE_VERIFIED',source:'editor.editorBridge'});
    }
    for (let cursor = progress.cursor; cursor < plan.sequence.length; cursor++) {
      const {textIndex, photoIndex} = plan.sequence[cursor];
      const base = {transferId: progress.id, cursor, accent: plan.accent, includeDiffText};
      let result;
      const label = textIndex !== undefined ? `본문 ${textIndex + 1}/${plan.steps.length}번째 구역`
        : photoIndex === 0 && plan.images[0].thumbnail ? '썸네일' : `사진 ${photoIndex + 1}/${progress.total}장`;
      const type = textIndex !== undefined ? plan.steps[textIndex].format.type : 'image';
      stepContext = {step:cursor + 1, label, blockType:type, textIndex:textIndex === undefined ? undefined : textIndex + 1,
        photoIndex:photoIndex === undefined ? undefined : photoIndex + 1, expectedInputSections:plan.steps.length,
        confirmedTextBlocks:progress.textDone, confirmedPhotos:progress.completed};
      await update({stepLabel: label, message: progressMessage(progress, `${label} 입력 중`)});
      failedStage = 'recheck-editor';
      await record('입력 구역 시작',{...target,...stepContext,stage:failedStage,source:'transfer.runTransfer'});
      await getConnected(windowId);
      const started = performance.now();
      failedStage = textIndex !== undefined ? 'append' : 'photo';
      if (textIndex !== undefined) {
        result = await invoke(connection, 'append', {...base, step: plan.steps[textIndex]});
      } else {
        const photo = plan.images[photoIndex];
        result = await invoke(connection, 'photo', {
          ...base, index: photoIndex, anchor: photo.left, following: photo.right,
          tail: connection.platform === 'naver', image: {name: photo.name, data: files.get(photo.id)}
        });
      }
      if (result.status !== 'ok') {
        await record('입력 구역 검증 실패',{...target,...stepContext,stage:failedStage,code:'EDITOR_STEP_FAILED',
          source:'editor.editorBridge',status:result.status, elapsedMs:Math.round(performance.now() - started), ...result.diagnostic});
        await update({pendingPhoto:result.diagnostic?.code==='PHOTO_NOT_CONFIRMED',status: result.status, message: progressMessage(progress, `${label}에서 중단됐습니다. ${result.message}`)});
        return progress;
      }
      await update({...confirmedStep(plan, progress, cursor, result),pendingPhoto:false});
      await record('입력 구역 검증 완료',{...target,...stepContext,stage:failedStage,code:'EDITOR_STEP_VERIFIED',
        source:'editor.editorBridge',status:'ok',elapsedMs:Math.round(performance.now() - started),
        confirmedTextBlocks:progress.textDone,confirmedPhotos:progress.completed,formatWarnings:result.formatWarnings, ...result.diagnostic});
    }
    const indices=plan.images.flatMap((photo,i)=>images.find(item=>item.id===photo.id)?.source==='gemini' ? [i] : []);
    let manual=[];
    if(connection.platform==='naver' && indices.length){
      const result=await invoke(connection,'aiLabels',{transferId:id,indices}).catch(()=>null);
      manual=result?.manual ?? indices.map(i=>i+1);
      await record('AI 활용 설정 확인',{stage:'ai-labels',manualPhotos:manual});
    }
    const labelNotice=manual.length ? ' 사진 '+manual.join(', ')+'번의 AI 활용 설정을 직접 켜 주세요.' : '';
    const warning = progress.formatWarnings.length ? ' 일부 서식 유지 여부는 편집기에서 확인해주세요.' : '';
    await update({ status: 'done', bodyDone: true, message: '제목·본문' + (progress.total ? '·사진 ' + progress.total + '장' : '') + '을 입력했습니다.' + labelNotice + warning });
    await record('전송 최종 확인',{...target,stage:'final-verification',code:'TRANSFER_VERIFIED',source:'transfer.runTransfer',
      titleVerified:progress.titleDone,expectedTextBlocks:plan.blocks.length,verifiedTextBlocks:Math.min(progress.textDone,plan.blocks.length),
      expectedPhotos:plan.images.length,verifiedPhotos:progress.completed,loadedPhotosAtLastPhoto:progress.loadedPhotos ?? 0,expectedTags:plan.tagCount,
      verifiedTags:progress.textDone > plan.blocks.length ? plan.tagCount : 0,formatWarnings:progress.formatWarnings});
  } catch (error) {
    const checked = await checkResume(await connectionFor(windowId), progress);
    const confirmed = checked?.cursor > progress.cursor ? confirmedStep(plan, progress, progress.cursor, checked.lastResult) : {};
    await record('전송 실행 오류',{...target,...stepContext,stage:failedStage,code:'TRANSFER_EXECUTION_ERROR',
      source:'transfer.runTransfer',status:checked ? 'retryable' : 'review'});
    const detail = (progress.stepLabel ? `${progress.stepLabel} 처리 중 오류가 발생했습니다. ` : '') + error.message;
    await update({...confirmed, status: checked ? 'retryable' : 'review', message: progressMessage({...progress, ...confirmed}, detail)});
  }
  return progress;
}
