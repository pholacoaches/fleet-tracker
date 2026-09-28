// FleetDesk — code shared by index.html and accept.html (classic script, plain
// globals): the one list of per-company localStorage keys and the wipe that
// removes them, plus the login timing values and the 15-s fetch limit both
// pages use. Loaded via <script src="storage-keys.js"></script> BEFORE their
// inline scripts. Names are prefixed FD_ because classic scripts share one
// global scope: a second `const TENANT_CACHE_KEY` in a page would be a
// SyntaxError. Never re-declare anything from this file in a page.
//
// Any change here needs a sw.js cache bump, or the service worker will keep
// serving the previous copy to installed clients.

// Every key that holds one company's business data, a one-time migration
// flag, or the unsynced fuel-report list. index.html stores each one as
// "<key>:<tenant id>" (older builds used the bare key). Add any new
// per-company key here, or logout will leave it behind.
const FD_TENANT_LOCAL_KEYS=[
  'fleet_tracker_v2',             // fuel reports cache
  'fleet_service_v1',             // service settings cache
  'fleet_upload_ids_v1',          // legacy upload-id list (migration input)
  'fleet_discs_v2',               // legacy disc data (migration input)
  'fleet_fuel_migrated_v1',
  'fleet_fuel_dirty_v1',          // unsynced fuel periods
  'fleet_service_migrated_v1',
  'fleet_upload_ids_migrated_v1',
  'fleet_discs_migrated_v1'
];
const FD_TENANT_CACHE_KEY='fleet_tenant_v1'; // must match TENANT_CACHE_KEY in index.html / accept.html

// Logout, a dead session, and a new person signing in on this device: the
// listed keys go for EVERY company on the device — bare (pre-#4a) and
// "<key>:<any id>" — then the tenant cache. It does not depend on the tenant
// cache, so leftovers of a company whose cache is already gone are caught too.
// The DB is the source of truth, so nothing is lost.
function wipeTenantLocalData(){
  const names=[];
  for(let i=0;i<localStorage.length;i++)names.push(localStorage.key(i));
  // Collected first, removed after: removing while walking shifts the indexes.
  names.forEach(n=>{
    if(typeof n==='string'&&FD_TENANT_LOCAL_KEYS.some(k=>n===k||n.startsWith(k+':')))localStorage.removeItem(n);
  });
  localStorage.removeItem(FD_TENANT_CACHE_KEY);
}

// The user id (JWT "sub" — a UUID, never the email) of the last person signed
// in on this device. Deliberately NOT in the wipe list: it must survive logout
// so the next sign-in can tell "same person again" from "someone else".
const FD_LAST_USER_KEY='fleet_last_user_v1';

function fdTokenUserId(token){
  try{
    const p=JSON.parse(atob(String(token).split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    return typeof p.sub==='string'&&p.sub?p.sub:null;
  }catch{return null;}
}

// Call with the NEW access token before it is stored. A different person — or
// no recorded last user (first sign-in on this build) — gets the full wipe
// first; the same person keeps their data, including unsynced reports.
function fdPrepareForUser(token){
  const uid=fdTokenUserId(token);
  let last=null;
  try{last=localStorage.getItem(FD_LAST_USER_KEY);}catch{}
  if(!uid||last!==uid)wipeTenantLocalData();
  fdRememberUser(uid);
}
function fdRememberUser(uid){
  try{
    if(uid)localStorage.setItem(FD_LAST_USER_KEY,uid);
    else localStorage.removeItem(FD_LAST_USER_KEY);
  }catch{}
}

// A stored access token older than this is refreshed before use (GoTrue
// tokens last 1 h; 5 min of slack).
const FD_TOKEN_REFRESH_AGE_MS=55*60*1000;

// Job 1 block 6: the session / removal checks run on a timer and share one
// promise, so a request the network never answers (captive portal, dropped
// signal) must not hang them forever. After 15 s it is aborted — the fetch
// rejects, and every caller already treats a rejection as "offline".
const FD_CHECK_TIMEOUT_MS=15000;
function fetchWithTimeout(url,opts){
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),FD_CHECK_TIMEOUT_MS);
  return fetch(url,{...opts,signal:ctl.signal}).finally(()=>clearTimeout(timer));
}
// Same 15-s limit, but it also covers reading the reply body: the whole reply
// is read inside the limit and handed back as a ready Response, so a reply
// that stalls halfway rejects too. For the timer-driven checks (poll,
// keep-alive), whose "already running" flag must never stay stuck.
async function fetchAllWithTimeout(url,opts){
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),FD_CHECK_TIMEOUT_MS);
  try{
    const res=await fetch(url,{...opts,signal:ctl.signal});
    const body=await res.arrayBuffer();
    // 204/205/304 may not carry a body in a new Response.
    return new Response([204,205,304].includes(res.status)?null:body,
      {status:res.status,statusText:res.statusText,headers:res.headers});
  }finally{clearTimeout(timer);}
}
