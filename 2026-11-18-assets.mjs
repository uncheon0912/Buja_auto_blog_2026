import {validateImage} from './2026-11-18-core.mjs';
let dbPromise;
function database(){return dbPromise ||= new Promise((resolve,reject)=>{const r=indexedDB.open('buja-assets-v2',1);r.onupgradeneeded=()=>r.result.createObjectStore('assets',{keyPath:'id'});r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}
async function transaction(mode,fn){const db=await database();return new Promise((resolve,reject)=>{const tx=db.transaction('assets',mode),r=fn(tx.objectStore('assets'));tx.oncomplete=()=>resolve(r.result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('사진 저장이 중단되었습니다.'));});}
export async function putAsset(id,data){const {bytes,mime}=validateImage(data);await transaction('readwrite',s=>s.put({id,blob:new Blob([bytes],{type:mime})}));return {mime,size:bytes.length};}
export async function getBlob(id){const r=await transaction('readonly',s=>s.get(id));if(!r)throw Error('사진 원본이 없습니다. 파일을 다시 선택해주세요.');return r.blob;}
export async function dataUrlOf(blob){const bytes=new Uint8Array(await blob.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return `data:${blob.type};base64,${btoa(binary)}`;}
export async function getData(id){return dataUrlOf(await getBlob(id));}
// Assets are immutable. Removed/replaced originals remain in IndexedDB for History restoration.
