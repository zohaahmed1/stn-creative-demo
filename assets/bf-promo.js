/* Black Friday promo: slide-in card (desktop) / slim bottom bar (phones) pointing to /black-friday-ads.
 * Include with <script src="/assets/bf-promo.js" defer></script> on pages with ecommerce visitors.
 * Shows after 6s or 30% scroll, once per visit; a close hides it for 7 days. Switches itself off after Black Friday.
 */
(function () {
  var END = new Date(2026, 10, 28);                       // the day after Black Friday 2026
  var KEY = 'stn_bf_promo_closed';
  var path = location.pathname;
  if (new Date() >= END) return;
  if (/^\/(black-friday|quiz|thank-you)/.test(path)) return;
  try { var closed = Number(localStorage.getItem(KEY) || 0); if (closed && Date.now() - closed < 7 * 864e5) return; } catch (e) {}
  try { if (sessionStorage.getItem(KEY + '_seen')) return; } catch (e) {}

  var page = path.replace(/^\/|\.html$/g, '') || 'home';
  var href = '/black-friday-ads?utm_source=site&utm_medium=promo&utm_campaign=black_friday&utm_content=' + encodeURIComponent(page);
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  function track(ev) { window.dataLayer = window.dataLayer || []; window.dataLayer.push({ event: ev, source: 'bf_promo', page: page }); }

  var css = '' +
    '.bfp{position:fixed;z-index:90;right:20px;bottom:20px;width:360px;max-width:calc(100vw - 32px);background:#fff;color:#0d0d0d;border-radius:20px;' +
      'box-shadow:0 24px 60px -18px rgba(25,25,35,.45),0 0 0 1px rgba(85,0,221,.12);display:flex;gap:14px;padding:14px 16px 14px 14px;font-family:Satoshi,system-ui,sans-serif;' +
      'transform:translateY(24px);opacity:0;transition:transform .45s cubic-bezier(.16,1,.3,1),opacity .35s ease;box-sizing:border-box}' +
    '.bfp.on{transform:none;opacity:1}' +
    '.bfp *{box-sizing:border-box}' +
    '.bfp-media{flex:0 0 84px;height:150px;border-radius:12px;overflow:hidden;background:#191923;align-self:center}' +
    '.bfp-media video,.bfp-media img{width:100%;height:100%;object-fit:cover;display:block}' +
    '.bfp-body{min-width:0;display:flex;flex-direction:column;justify-content:center}' +
    '.bfp-tag{font-size:12px;font-weight:900;color:#5500dd;margin:0 0 6px}' +
    '.bfp-title{font-size:17px;font-weight:900;line-height:1.22;letter-spacing:-.02em;margin:0 0 6px;padding-right:14px}' +
    '.bfp-title span{background:linear-gradient(90deg,#5500dd,#e0245e);-webkit-background-clip:text;background-clip:text;color:transparent}' +
    '.bfp-sub{font-size:13.5px;line-height:1.45;color:rgba(0,0,0,.62);margin:0 0 10px}' +
    '.bfp-cta{display:inline-block;align-self:flex-start;background:#5500dd;color:#fff!important;font-size:14px;font-weight:700;padding:10px 18px;border-radius:100px;text-decoration:none;transition:opacity .2s}' +
    '.bfp-cta:hover{opacity:.88}' +
    '.bfp-cta:focus-visible,.bfp-x:focus-visible,.bfp-bar:focus-visible{outline:2px solid #5500dd;outline-offset:2px}' +
    '.bfp-fit{font-size:11.5px;color:rgba(0,0,0,.45);margin:8px 0 0}' +
    '.bfp-x{position:absolute;top:8px;right:8px;width:28px;height:28px;border:0;border-radius:50%;background:rgba(0,0,0,.05);color:rgba(0,0,0,.55);font-size:17px;line-height:28px;text-align:center;cursor:pointer;padding:0}' +
    '.bfp-x:hover{background:rgba(0,0,0,.1)}' +
    /* phones: a slim bar along the bottom, never covering the page */
    '@media (max-width:767px){' +
      '.bfp{left:10px;right:10px;bottom:calc(10px + env(safe-area-inset-bottom,0px));width:auto;max-width:none;padding:8px 44px 8px 8px;gap:10px;border-radius:16px;align-items:center}' +
      '.bfp-media{flex:0 0 40px;height:56px;border-radius:9px}' +
      '.bfp-tag,.bfp-sub,.bfp-fit,.bfp-cta{display:none}' +
      '.bfp-title{font-size:14px;margin:0;padding:0;line-height:1.3}' +
      '.bfp-bar{position:absolute;inset:0;border-radius:16px}' +
      '.bfp-x{top:50%;margin-top:-14px;right:8px;z-index:2}' +
    '}' +
    '@media (min-width:768px){.bfp-bar{display:none}}' +
    '@media (prefers-reduced-motion:reduce){.bfp{transition:none}}';

  function build() {
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    var el = document.createElement('aside');
    el.className = 'bfp'; el.setAttribute('aria-label', 'Black Friday offer');
    var media = reduce
      ? '<img src="/assets/bf-ugc/larine.jpg" alt="">'
      : '<video src="/assets/bf-ugc/larine-loop.mp4" poster="/assets/bf-ugc/larine.jpg" muted loop playsinline autoplay preload="none" aria-hidden="true"></video>';
    el.innerHTML =
      '<div class="bfp-media">' + media + '</div>' +
      '<div class="bfp-body">' +
        '<p class="bfp-tag">Black Friday offer</p>' +
        '<p class="bfp-title">Lower your cost per purchase <span>by 20% in 30 days</span></p>' +
        '<p class="bfp-sub">6 AI UGC video ads in 7 days. Beat your current winners, or get 50% back.</p>' +
        '<a class="bfp-cta" href="' + href + '">See the offer &rarr;</a>' +
        '<p class="bfp-fit">For brands spending $10K+/mo</p>' +
      '</div>' +
      '<a class="bfp-bar" href="' + href + '" aria-label="See the Black Friday offer"></a>' +
      '<button class="bfp-x" type="button" aria-label="Close">&times;</button>';
    document.body.appendChild(el);
    requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add('on'); }); });
    try { sessionStorage.setItem(KEY + '_seen', '1'); } catch (e) {}
    track('bf_promo_shown');

    [].forEach.call(el.querySelectorAll('.bfp-cta, .bfp-bar'), function (a) { a.addEventListener('click', function () { track('bf_promo_click'); }); });
    el.querySelector('.bfp-x').addEventListener('click', function () {
      try { localStorage.setItem(KEY, String(Date.now())); } catch (e) {}
      track('bf_promo_close');
      el.classList.remove('on');
      setTimeout(function () { el.remove(); }, 400);
    });
  }

  var shown = false;
  function maybe() { if (shown) return; shown = true; window.removeEventListener('scroll', onScroll); build(); }
  function onScroll() { var h = document.documentElement; if ((h.scrollTop || document.body.scrollTop) / Math.max(1, h.scrollHeight - h.clientHeight) > 0.3) maybe(); }
  window.addEventListener('scroll', onScroll, { passive: true });
  setTimeout(maybe, 6000);
})();
