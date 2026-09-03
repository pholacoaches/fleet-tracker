// FleetDesk — shared output-escaping helpers (classic script, plain globals).
// Loaded by index.html and driver.html via <script src="esc.js"></script>
// BEFORE their inline scripts. Both pages are classic (non-module) scripts, so
// these are deliberately plain function declarations on the global scope.
//
// Any change here needs a sw.js cache bump, or the service worker will keep
// serving the previous copy to installed clients.

// Text-context escape: use for every interpolation that lands between tags.
function escapeHtml(s){
  return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// Attribute-context variant: use for every interpolation inside an HTML
// attribute (title="", value="", id="", data-*) — also neutralises backtick
// and equals so the value stays inert even under unquoted-attribute parsing.
// For a value passed as a JS string inside an inline on* handler, wrap it as
// escAttr(JSON.stringify(v)) so it is escaped for JS first, then for HTML.
function escAttr(s){
  return String(s??'').replace(/[&<>"'`=]/g,c=>'&#'+c.charCodeAt(0)+';');
}
