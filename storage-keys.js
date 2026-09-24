// FleetDesk — the one list of per-company localStorage keys, and the wipe that
// removes them (classic script, plain globals). Loaded by index.html and
// accept.html via <script src="storage-keys.js"></script> BEFORE their inline
// scripts. Names are prefixed FD_ because classic scripts share one global
// scope: a second `const TENANT_CACHE_KEY` in a page would be a SyntaxError.
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
// listed keys go for the cached company (and as bare pre-#4a leftovers), then
// the tenant cache. The DB is the source of truth, so nothing is lost.
function wipeTenantLocalData(){
  let tid=null;
  try{tid=JSON.parse(localStorage.getItem(FD_TENANT_CACHE_KEY))?.id||null;}catch{}
  FD_TENANT_LOCAL_KEYS.forEach(k=>{
    if(tid)localStorage.removeItem(k+':'+tid);
    localStorage.removeItem(k);
  });
  localStorage.removeItem(FD_TENANT_CACHE_KEY);
}
