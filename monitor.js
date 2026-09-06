// FleetDesk — error monitoring (Sentry), shared by index.html and driver.html.
//
// Loaded in <head> straight after sentry.bundle.min.js (self-hosted copy of
// @sentry/browser 10.73.0, errors-only bundle) and BEFORE every other script,
// so the global error handlers are in place while the page scripts run.
//
// What it does:
//   • Sentry.init — errors only. No performance tracing, no session replay,
//     no release-health sessions, no breadcrumbs, no PII.
//   • beforeSend scrub — strips query strings and URL hashes (driver codes and
//     password-reset tokens live there), drops request headers other than the
//     browser's User-Agent, and masks tokens, keys, e-mail addresses, driver
//     codes, plates, long digit runs and data: URIs inside any message text.
//   • fetch wrapper — every Supabase / Worker response that is not 2xx becomes
//     a Sentry error carrying ONLY method, shortened path and status.
//   • window.FleetDesk helpers — setTenant(id), reportError(msg, extra) and the
//     console test hook testSentry() (see README section "Error monitoring").
//
// Bump FLEETDESK_RELEASE together with the sw.js cache name on every deploy —
// the release is what ties each Sentry error to a build.
//
// Any change here needs a sw.js cache bump, or the service worker will keep
// serving the previous copy to installed clients.
(function(){
  'use strict';

  var FLEETDESK_RELEASE='fleetdesk-v73';
  var DSN='https://7415a2ef1c96f2c4907c7b4c958541f4@o4512041337618432.ingest.de.sentry.io/4512041379758160';
  var PAGE=/driver\.html$/i.test(location.pathname)?'driver':'dashboard';
  var ENV=(/^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname)||location.protocol==='file:')?'local':'production';
  // Only calls to these hosts are watched by the fetch wrapper.
  var API_HOSTS=/(\.supabase\.co|\.workers\.dev)$/i;

  // ── Scrub helpers ──────────────────────────────────────────────────────────
  // Everything after ? or # is dropped from any URL-like string.
  function cleanUrl(u){return typeof u==='string'?u.replace(/[?#][\s\S]*$/,''):u;}

  // Applied to every free-text field that leaves the app. Order matters: the
  // JWT / key / e-mail patterns run before the generic digit-run mask.
  var SCRUB=[
    [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,'[jwt]'],
    [/\bsb_(?:publishable|secret)_[A-Za-z0-9_-]+/g,'[key]'],
    [/\bdata:[a-z]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+\/=]+/gi,'[data-uri]'],
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,'[email]'],
    [/\b[A-Z]{3}-\d{4}\b/g,'[driver-code]'],                 // driver personal codes
    [/\b[A-Z]{2,3}\s?\d{3,6}(?:[\s-]?\d{3})?\s?(?:[A-Z]{2}\b)?/g,'[plate]'], // SA plate shapes: CA 123-456, ND 123456, ABC 123 GP
    [/\d[\d\s-]{4,}\d/g,'[number]']                          // phones, odometers, dates
  ];
  function scrubText(s){
    if(typeof s!=='string')return s;
    for(var i=0;i<SCRUB.length;i++)s=s.replace(SCRUB[i][0],SCRUB[i][1]);
    return s;
  }
  // Only flat string / number / boolean values survive; strings are scrubbed.
  function scrubExtra(obj){
    var out={};
    if(!obj||typeof obj!=='object')return out;
    Object.keys(obj).forEach(function(k){
      var v=obj[k];
      if(typeof v==='string')out[k]=scrubText(v).slice(0,200);
      else if(typeof v==='number'||typeof v==='boolean')out[k]=v;
    });
    return out;
  }

  // beforeSend: last gate before the event leaves the browser.
  function scrubEvent(event){
    try{
      // Page URL without query / hash. Keep only the User-Agent header (Sentry
      // uses it for the browser / OS columns) — Referer etc. are dropped.
      if(event.request){
        var ua=event.request.headers&&event.request.headers['User-Agent'];
        event.request={url:cleanUrl(event.request.url)};
        if(ua)event.request.headers={'User-Agent':ua};
      }
      if(event.transaction)event.transaction=cleanUrl(event.transaction);
      delete event.user;
      delete event.server_name;
      delete event.breadcrumbs;
      if(event.message)event.message=scrubText(event.message);
      if(event.logentry){
        event.logentry.message=scrubText(event.logentry.message);
        delete event.logentry.params;
      }
      var values=event.exception&&event.exception.values;
      if(Array.isArray(values))values.forEach(function(v){
        if(v.value)v.value=scrubText(v.value);
        var frames=v.stacktrace&&v.stacktrace.frames;
        if(Array.isArray(frames))frames.forEach(function(f){
          if(f.filename)f.filename=cleanUrl(f.filename);
          if(f.abs_path)f.abs_path=cleanUrl(f.abs_path);
          if(f.module)f.module=cleanUrl(f.module);
          delete f.vars;
        });
      });
      if(event.extra)event.extra=scrubExtra(event.extra);
      if(event.contexts){
        // Keep device / browser / os (derived from the UA). Nothing app-specific
        // is ever attached as a context, so anything else is dropped.
        var keep={};
        ['browser','os','device','trace'].forEach(function(k){if(event.contexts[k])keep[k]=event.contexts[k];});
        event.contexts=keep;
      }
    }catch(e){
      // A scrub failure must never leak the unscrubbed event — drop it.
      return null;
    }
    return event;
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  var S=window.Sentry;
  var ready=!!(S&&typeof S.init==='function');
  if(ready){
    S.init({
      dsn:DSN,
      release:FLEETDESK_RELEASE,
      environment:ENV,
      sendDefaultPii:false,
      sampleRate:1,
      maxBreadcrumbs:0,
      beforeBreadcrumb:function(){return null;},
      beforeSend:scrubEvent,
      // Drop the breadcrumb recorder (console / fetch / DOM trails would carry
      // response bodies and clicked-element text) and release-health sessions.
      integrations:function(defaults){
        return defaults.filter(function(i){return i.name!=='Breadcrumbs'&&i.name!=='BrowserSession';});
      },
      ignoreErrors:[
        'Not signed in',                       // authToken(): deliberate redirect-to-login path
        'ResizeObserver loop',                 // benign browser layout notice
        /^Script error\.?$/                    // opaque cross-origin script error, no detail to act on
      ],
      denyUrls:[
        /extensions\//i,/^chrome:\/\//i,/^chrome-extension:\/\//i,/^moz-extension:\/\//i,/^safari(-web)?-extension:\/\//i
      ],
      initialScope:{tags:{page:PAGE}}
    });
  }else{
    try{console.warn('[FleetDesk] Sentry SDK not loaded — error monitoring is off for this page load');}catch(e){}
  }

  // ── Failed API responses ───────────────────────────────────────────────────
  // Path only, at most 4 segments, UUID segments masked. Examples:
  //   /rest/v1/vehicles            /rest/v1/rpc/driver_page_init
  //   /storage/v1/object/sign      /auth/v1/token        /ai/dashboard
  function shortPath(url){
    var path;
    try{path=new URL(url,location.href).pathname;}catch(e){return '[unparseable]';}
    var segs=path.split('/').filter(Boolean).slice(0,4).map(function(s){
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)?':id':s;
    });
    return '/'+segs.join('/');
  }
  function hostOf(url){try{return new URL(url,location.href).hostname;}catch(e){return '';}}

  function reportHttp(method,url,status){
    if(!ready)return;
    var target=/\.workers\.dev$/i.test(hostOf(url))?'worker':'supabase';
    var path=shortPath(url);
    S.withScope(function(scope){
      scope.setLevel('error');
      scope.setTag('target',target);
      scope.setTag('http_status',String(status));
      scope.setTag('endpoint',path);
      scope.setFingerprint(['http-fail',target,method,path,String(status)]);
      S.captureMessage(target+' '+method+' '+path+' returned '+status);
    });
  }

  var nativeFetch=window.fetch;
  if(typeof nativeFetch==='function'){
    window.fetch=function(input,init){
      var p=nativeFetch.apply(this,arguments);
      var url='';
      try{url=typeof input==='string'?input:(input&&input.url)||'';}catch(e){}
      if(!API_HOSTS.test(hostOf(url)))return p;
      var method=String((init&&init.method)||(input&&input.method)||'GET').toUpperCase();
      // Returning the derived promise keeps the caller's own error handling
      // intact: a rejected fetch still rejects for them (and still reaches
      // Sentry as an unhandled rejection if they never catch it).
      return p.then(function(res){
        try{if(res&&!res.ok)reportHttp(method,url,res.status);}catch(e){}
        return res;
      });
    };
  }

  // ── Public helpers ─────────────────────────────────────────────────────────
  window.FleetDesk=Object.assign(window.FleetDesk||{},{
    // Tag every later event with the tenant's UUID (never the company name).
    setTenant:function(id){
      if(!ready||!id)return;
      try{S.setTag('tenant',String(id));}catch(e){}
    },
    // App-detected failure that is not an exception, e.g. a PATCH that matched
    // no row. `extra` may hold flat strings / numbers only; it is scrubbed.
    reportError:function(message,extra){
      if(!ready)return;
      try{
        S.withScope(function(scope){
          scope.setLevel('error');
          var ex=scrubExtra(extra);
          if(ex.endpoint)scope.setTag('endpoint',String(ex.endpoint));
          if(ex.status!==undefined)scope.setTag('http_status',String(ex.status));
          scope.setExtras(ex);
          scope.setFingerprint(['app',String(message)]);
          S.captureMessage(String(message));
        });
      }catch(e){}
    },
    // Console test hook. FleetDesk.testSentry() throws a genuine uncaught
    // error from a timer (an error thrown directly in the console never
    // reaches the global handler); FleetDesk.testSentry('rejection') fires an
    // unhandled promise rejection instead. Both must show up in Sentry.
    testSentry:function(kind){
      var nonce=Math.random().toString(36).slice(2,8);
      var label=kind==='rejection'?'rejection':'error';
      var msg='FleetDesk test '+label+' ('+PAGE+') '+nonce;
      setTimeout(function(){
        if(label==='rejection')Promise.reject(new Error(msg));
        else throw new Error(msg);
      },0);
      return (ready?'Sent: "'+msg+'"':'NOT sent — Sentry SDK is not loaded')+
        ' | environment='+ENV+' release='+FLEETDESK_RELEASE+' page='+PAGE;
    }
  });
})();
