'use strict';
const el=id=>document.getElementById(id), DB='spectacle-event-recordings', STORE='clips';
let db,stream,recorder,chunks=[],timer,started=0,canvas,drawTimer,sourceStream;
const status=s=>el('status').textContent=s;
function openDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open(DB,1);req.onupgradeneeded=()=>req.result.createObjectStore(STORE,{keyPath:'id'});req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
function tx(mode,fn){return new Promise((resolve,reject)=>{const t=db.transaction(STORE,mode),s=t.objectStore(STORE);let result;try{result=fn(s)}catch(e){reject(e);return}t.oncomplete=()=>resolve(result?.result);t.onerror=()=>reject(t.error)})}
const all=()=>tx('readonly',s=>s.getAll());
const sizeText=n=>(n/1048576).toFixed(1)+' MB';
async function prune(){const clips=(await all()).sort((a,b)=>a.created-b.created);let bytes=clips.reduce((n,c)=>n+c.blob.size,0),limit=Number(el('limit').value)*1048576;for(const c of clips){if(bytes<=limit)break;await tx('readwrite',s=>s.delete(c.id));bytes-=c.blob.size}}
async function render(){const clips=(await all()).sort((a,b)=>b.created-a.created),list=el('archive');list.replaceChildren();for(const c of clips){const li=document.createElement('li'),title=document.createElement('div');title.textContent=new Date(c.created).toLocaleString()+' · '+c.source+' · '+c.quality+'p · '+sizeText(c.blob.size);li.append(title);const play=document.createElement('button');play.textContent='Play';const save=document.createElement('button');save.textContent='Download';const del=document.createElement('button');del.textContent='Delete';let url=null;play.onclick=()=>{if(url)URL.revokeObjectURL(url);url=URL.createObjectURL(c.blob);const video=document.createElement('video');video.controls=true;video.src=url;video.onended=()=>URL.revokeObjectURL(url);li.querySelector('video')?.remove();li.append(video)};save.onclick=()=>{const u=URL.createObjectURL(c.blob),a=document.createElement('a');a.href=u;a.download='spectacle-event-'+new Date(c.created).toISOString().replace(/[:.]/g,'-')+'.webm';a.click();setTimeout(()=>URL.revokeObjectURL(u),60000)};del.onclick=async()=>{if(!confirm('Delete this event permanently?'))return;await tx('readwrite',s=>s.delete(c.id));render()};li.append(play,save,del);list.append(li)}}
function cleanup(){clearInterval(timer);clearInterval(drawTimer);for(const t of sourceStream?.getTracks()||[])t.stop();for(const t of stream?.getTracks()||[])t.stop();sourceStream=stream=null;el('preview').srcObject=null;el('start').disabled=false;el('stop').disabled=true;el('source').disabled=false;el('quality').disabled=false}
async function start(){el('start').disabled=true;try{
const source=el('source').value,height=Number(el('quality').value),audio=el('audio').checked;
if(source==='screen'&&!navigator.mediaDevices?.getDisplayMedia)throw Error('Screen recording is not available in this browser. On Android, native MediaProjection integration is required.');
sourceStream=source==='camera'?await navigator.mediaDevices.getUserMedia({video:{width:{ideal:Math.round(height*16/9)},height:{ideal:height},frameRate:{ideal:15,max:15}},audio}):await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
const video=el('preview');video.srcObject=sourceStream;await video.play();
canvas=document.createElement('canvas');const vw=video.videoWidth||1280,vh=video.videoHeight||720;canvas.height=height;canvas.width=Math.round(height*vw/vh);const ctx=canvas.getContext('2d',{alpha:false});if(!ctx)throw Error('Canvas capture is unavailable');
drawTimer=setInterval(()=>{if(video.readyState>=2)ctx.drawImage(video,0,0,canvas.width,canvas.height)},1000/15);
stream=canvas.captureStream(15);
if(audio){if(source==='camera'){sourceStream.getAudioTracks().forEach(t=>stream.addTrack(t))}else{const mic=await navigator.mediaDevices.getUserMedia({audio:true});mic.getAudioTracks().forEach(t=>stream.addTrack(t));sourceStream.addTrack(mic.getAudioTracks()[0])}}
const mime=['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm'].find(m=>MediaRecorder.isTypeSupported(m));if(!mime)throw Error('No supported WebM recorder');
recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:height===360?220000:height===480?400000:750000,audioBitsPerSecond:32000});chunks=[];started=Date.now();
recorder.ondataavailable=e=>{if(e.data.size)chunks.push(e.data)};
recorder.onerror=e=>status('Recording error: '+(e.error?.message||'unknown'));
recorder.onstop=async()=>{try{const blob=new Blob(chunks,{type:mime});if(blob.size){await tx('readwrite',s=>s.put({id:crypto.randomUUID(),created:started,source,quality:height,blob}));await prune();await render();status('Saved event · '+sizeText(blob.size))}else status('No footage was produced')}catch(e){status('Save failed: '+e.message+'. Storage may be full.')}finally{cleanup()}};
sourceStream.getVideoTracks()[0].addEventListener('ended',()=>{if(recorder?.state==='recording')recorder.stop()},{once:true});
recorder.start(1000);el('stop').disabled=false;el('source').disabled=true;el('quality').disabled=true;timer=setInterval(()=>status('● Recording '+Math.floor((Date.now()-started)/1000)+' seconds · '+height+'p / 15 FPS'),1000);status('● Recording started');
}catch(e){status('Cannot start: '+e.message);cleanup()}}
el('start').onclick=start;el('stop').onclick=()=>{if(recorder?.state==='recording'){el('stop').disabled=true;status('Saving recording…');recorder.stop()}};
window.addEventListener('pagehide',()=>{if(recorder?.state==='recording')recorder.stop()});
openDB().then(d=>{db=d;return render()}).catch(e=>{status('Local archive unavailable: '+e.message);el('start').disabled=true});
