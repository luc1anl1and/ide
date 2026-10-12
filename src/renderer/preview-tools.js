// Tools that let an agent *use* the preview page without screenshots: read it as text, click, type, press keys, scroll, wait.
// Everything runs through the <webview> (trusted mouse/keyboard events), the page-side helpers are plain injected scripts.
(function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const J = JSON.stringify;
  const text = (t) => ({ content: [{ type: 'text', text: String(t) }] });
  const fail = (t) => ({ content: [{ type: 'text', text: String(t) }], isError: true });

  // ---- page side ----
  const SNAP = (max, chars) => `(function(max,chars){
    var vis=function(e){var r=e.getBoundingClientRect();if(r.width<2||r.height<2)return false;var s=getComputedStyle(e);return s.visibility!=='hidden'&&s.display!=='none'&&+s.opacity>0.02};
    var sel='a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[role=switch],[role=option],[role=radio],[onclick],[contenteditable=""],[contenteditable=true],[tabindex]:not([tabindex="-1"])';
    document.querySelectorAll('[data-reva-ref]').forEach(function(e){e.removeAttribute('data-reva-ref')});
    var all=[].slice.call(document.querySelectorAll(sel)).filter(vis);
    // keep outermost-useful: drop elements fully contained in another listed clickable with the same label
    var out=[],n=0,vw=innerWidth,vh=innerHeight;
    for(var i=0;i<all.length&&n<max;i++){var e=all[i];n++;e.setAttribute('data-reva-ref',n);
      var r=e.getBoundingClientRect(),tag=e.tagName.toLowerCase(),role=e.getAttribute('role')||'';
      var label=(e.getAttribute('aria-label')||e.innerText||e.value||e.placeholder||e.title||e.alt||(e.querySelector&&e.querySelector('img[alt]')&&e.querySelector('img[alt]').alt)||'').replace(/\\s+/g,' ').trim().slice(0,70);
      var kind=tag==='a'?'link':tag==='button'||role==='button'?'button':tag==='input'?(e.type||'text')+' input':tag==='select'?'select':tag==='textarea'?'textarea':role||tag;
      var x=[];if(e.disabled)x.push('disabled');if(e.checked)x.push('checked');if(e.type==='password')x.push('password');
      if(tag==='input'&&e.type!=='password'&&e.value&&e.type!=='checkbox'&&e.type!=='radio')x.push('value="'+e.value.slice(0,40)+'"');
      if(tag==='select'){var o=e.options[e.selectedIndex];if(o)x.push('selected="'+o.text.slice(0,30)+'"')}
      if(tag==='a'&&e.getAttribute('href'))x.push('-> '+e.getAttribute('href').slice(0,60));
      var inview=r.bottom>0&&r.top<vh&&r.right>0&&r.left<vw;
      out.push('['+n+'] '+kind+(label?' "'+label+'"':'')+(x.length?' ('+x.join(', ')+')':'')+(inview?'':' (off-screen: scroll '+(r.top>vh?'down':'up')+')'));
    }
    var heads=[].slice.call(document.querySelectorAll('h1,h2,h3')).filter(vis).slice(0,12).map(function(h){return h.tagName.toLowerCase()+': '+h.innerText.replace(/\\s+/g,' ').trim().slice(0,90)});
    var txt=(document.body?document.body.innerText:'').replace(/\\n{3,}/g,'\\n\\n').trim().slice(0,chars);
    return JSON.stringify({url:location.href,title:document.title,scroll:Math.round(scrollY)+'/'+Math.round(document.documentElement.scrollHeight-innerHeight),viewport:vw+'x'+vh,heads:heads,items:out,more:all.length>max?all.length-max:0,text:txt});
  })(${max},${chars})`;

  // resolve a target (ref / selector / visible text / x,y) -> viewport centre, scrolling it into view first
  const TARGET = (a) => `(function(a){
    var el=null;
    if(a.ref!=null)el=document.querySelector('[data-reva-ref="'+a.ref+'"]');
    else if(a.selector)el=document.querySelector(a.selector);
    else if(a.text){var q=String(a.text).toLowerCase().trim(),best=null,bs=1e9;
      var c=document.querySelectorAll('a,button,input,select,textarea,summary,label,[role],[onclick],h1,h2,h3,h4,li,td,th,span,div,p');
      for(var i=0;i<c.length;i++){var e=c[i],t=(e.getAttribute('aria-label')||e.innerText||e.value||e.placeholder||'').replace(/\\s+/g,' ').trim().toLowerCase();
        if(!t||t.indexOf(q)<0)continue;var r=e.getBoundingClientRect();if(r.width<2||r.height<2)continue;var s=t.length-q.length+(e.children.length*3);
        if(/^(a|button|input|select|summary)$/i.test(e.tagName)||e.getAttribute('role'))s-=50;if(s<bs){bs=s;best=e}}
      el=best}
    if(el){el.scrollIntoView({block:'center',inline:'center'});var r=el.getBoundingClientRect();
      return JSON.stringify({ok:true,x:r.left+r.width/2,y:r.top+r.height/2,tag:el.tagName.toLowerCase(),label:(el.getAttribute('aria-label')||el.innerText||el.value||el.placeholder||'').replace(/\\s+/g,' ').trim().slice(0,60)})}
    if(a.x!=null&&a.y!=null)return JSON.stringify({ok:true,x:a.x,y:a.y,tag:'point',label:''});
    return JSON.stringify({ok:false,error:'No matching element. Take a new preview_snapshot (refs change after the page updates).'});
  })(${J(a)})`;

  const STATE = `JSON.stringify({url:location.href,title:document.title,y:Math.round(scrollY)})`;

  // the AI's own cursor inside the preview page, so you see where it is about to click (it never uses your mouse)
  const CUR = (x, y, kind) => `(function(x,y,kind){var c=document.getElementById('__reva_cur');if(!c){c=document.createElement('div');c.id='__reva_cur';c.style.cssText='position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;transition:transform .45s cubic-bezier(.22,.8,.2,1),opacity .2s;opacity:0';
    c.innerHTML='<svg viewBox="0 0 24 24" width="28" height="28" style="position:absolute;left:-3px;top:-2px;filter:drop-shadow(0 0 6px rgba(150,90,255,.9))"><path d="M4 2l15 9.2-6.3 1.5 3.7 6.9-2.8 1.5-3.7-6.9L5 17.8z" fill="#fff" stroke="#3b1d7a" stroke-width="1.4" stroke-linejoin="round"/></svg><span style="position:absolute;left:20px;top:20px;white-space:nowrap;padding:2px 8px;border-radius:99px;font:600 11px system-ui,sans-serif;color:#fff;background:linear-gradient(135deg,#7c3aed,#a78bfa)">Reva AI</span><i style="position:absolute;left:-20px;top:-20px;width:40px;height:40px;border-radius:50%;border:3px solid #c4b5fd;opacity:0"></i>';
    document.documentElement.appendChild(c);c.style.transition='none';c.style.transform='translate('+Math.round(innerWidth/2)+'px,'+(innerHeight+20)+'px)';void c.offsetWidth;c.style.transition=''}
    c.style.opacity=1;c.style.transform='translate('+Math.round(x)+'px,'+Math.round(y)+'px)';var ring=c.querySelector('i');
    if(kind==='click'){setTimeout(function(){ring.style.transition='none';ring.style.opacity='.95';ring.style.transform='scale(.3)';void ring.offsetWidth;ring.style.transition='transform .5s ease-out,opacity .5s';ring.style.transform='scale(1.6)';ring.style.opacity='0'},470)}
    clearTimeout(window.__revaCurT);window.__revaCurT=setTimeout(function(){c.style.opacity=0},7000)})(${x},${y},${J(kind)})`;
  async function aiCursor(p, t, kind) { try { await p.pane.eval(CUR(t.x, t.y, kind)); await sleep(500); } catch { } }
  async function where(p, a) {
    const r = JSON.parse(await p.pane.eval(TARGET(a)));
    if (!r.ok) throw new Error(r.error); await sleep(60); return r;
  }
  function mouse(p, type, x, y, extra) { const z = +p.pane.zoom || 1; return p.pane.input({ type, x: Math.round(x * z), y: Math.round(y * z), ...extra }); }
  const KEYS = { enter: 'Return', return: 'Return', esc: 'Escape', escape: 'Escape', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete', up: 'Up', down: 'Down', left: 'Left', right: 'Right', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', ctrl: 'Control', control: 'Control', shift: 'Shift', alt: 'Alt', meta: 'Meta', cmd: 'Meta' };
  async function press(p, combo) {
    const parts = String(combo).split('+').map((s) => s.trim()).filter(Boolean); const key = parts.pop(); const mods = parts.map((m) => { const k = KEYS[m.toLowerCase()] || m; return k === 'Control' ? 'control' : k === 'Meta' ? 'meta' : k.toLowerCase(); });
    const code = KEYS[key.toLowerCase()] || (key.length === 1 ? key.toUpperCase() : key);
    try { p.pane.focus && p.pane.focus(); } catch { }
    const ev = (type, extra) => p.pane.input({ type, keyCode: code, modifiers: mods, ...extra });
    ev('keyDown'); if (key.length === 1 && !mods.some((m) => m === 'control' || m === 'meta')) p.pane.input({ type: 'char', keyCode: key, modifiers: mods }); ev('keyUp');
    await sleep(120);
  }
  const since = async (p, before) => {
    await sleep(350); for (let i = 0; i < 25 && p.pane.loading; i++) await sleep(100);
    let now = {}; try { now = JSON.parse(await p.pane.eval(STATE)); } catch { }
    const b = before || {}; const bits = [];
    if (now.url && now.url !== b.url) bits.push('navigated to ' + now.url);
    if (now.title && now.title !== b.title) bits.push('title: ' + now.title);
    return bits.length ? bits.join('; ') : 'no navigation';
  };

  window.PreviewTools = {
    async run(IDE, tool, a) {
      const p = IDE.pick(a.id);
      if (tool !== 'preview_wait') { try { window.showPreviewTab && showPreviewTab(p.id); } catch { } }
      switch (tool) {
        case 'preview_snapshot': {
          const r = JSON.parse(await p.pane.eval(SNAP(a.max || 120, a.text_chars == null ? 2500 : a.text_chars)));
          const lines = ['URL: ' + r.url, 'Title: ' + r.title, 'Viewport ' + r.viewport + ', scrolled ' + r.scroll + ' px', ''];
          if (r.heads.length) lines.push('Headings:', ...r.heads.map((h) => '  ' + h), '');
          lines.push('Interactive elements (use ref with preview_click / preview_type / preview_hover):', ...(r.items.length ? r.items : ['  (none found)']));
          if (r.more) lines.push('… ' + r.more + ' more not shown (raise max)');
          if (r.text) lines.push('', 'Visible text:', r.text);
          return text(lines.join('\n'));
        }
        case 'preview_click': case 'preview_hover': {
          const before = JSON.parse(await p.pane.eval(STATE)); const t = await where(p, a); await aiCursor(p, t, tool === 'preview_hover' ? 'hover' : 'click');
          if (!p.pane.input) { await p.pane.eval(`(function(){var e=document.elementFromPoint(${t.x},${t.y});e&&e.click&&e.click()})()`); return text('Clicked (fallback) ' + t.label); }
          mouse(p, 'mouseMove', t.x, t.y);
          if (tool === 'preview_hover') { await sleep(250); return text('Hovering over ' + (t.label || t.tag) + ' at ' + Math.round(t.x) + ',' + Math.round(t.y)); }
          const button = a.right ? 'right' : 'left'; const n = a.double ? 2 : 1;
          for (let i = 1; i <= n; i++) { mouse(p, 'mouseDown', t.x, t.y, { button, clickCount: i }); mouse(p, 'mouseUp', t.x, t.y, { button, clickCount: i }); }
          return text('Clicked ' + (t.label ? '"' + t.label + '"' : t.tag) + '. ' + (await since(p, before)));
        }
        case 'preview_type': {
          const before = JSON.parse(await p.pane.eval(STATE));
          if (a.ref != null || a.selector || a.text_target) {
            const t = await where(p, { ref: a.ref, selector: a.selector }); await aiCursor(p, t, 'click'); mouse(p, 'mouseMove', t.x, t.y); mouse(p, 'mouseDown', t.x, t.y, { button: 'left', clickCount: 1 }); mouse(p, 'mouseUp', t.x, t.y, { button: 'left', clickCount: 1 });
            await sleep(80);
          }
          try { p.pane.focus && p.pane.focus(); } catch { }
          if (a.clear) { await p.pane.eval(`(function(){var e=document.activeElement;if(e&&e.select)e.select();else document.execCommand('selectAll')})()`); await sleep(40); p.pane.input({ type: 'keyDown', keyCode: 'Delete' }); p.pane.input({ type: 'keyUp', keyCode: 'Delete' }); await sleep(40); }
          await p.pane.insertText(a.text); await sleep(80);
          if (a.submit) { await press(p, 'Enter'); }
          return text('Typed ' + a.text.length + ' characters' + (a.submit ? ' and pressed Enter' : '') + '. ' + (a.submit ? await since(p, before) : ''));
        }
        case 'preview_press': { const before = JSON.parse(await p.pane.eval(STATE)); await press(p, a.key); return text('Pressed ' + a.key + '. ' + (await since(p, before))); }
        case 'preview_scroll': {
          const r = await p.pane.eval(`(function(a){var el=a.ref!=null?document.querySelector('[data-reva-ref="'+a.ref+'"]'):a.selector?document.querySelector(a.selector):null;var t=el||document.scrollingElement||document.documentElement;
            var amt=a.amount||(el?el.clientHeight:innerHeight)*0.85;var top=a.direction==='top'?0:a.direction==='bottom'?1e9:(a.direction==='up'?-amt:amt);
            if(a.direction==='top'||a.direction==='bottom')t.scrollTo({top:top});else t.scrollBy({top:top});
            return Math.round(t.scrollTop)+' of '+Math.round(t.scrollHeight-t.clientHeight)})(${J(a)})`);
          await sleep(200); return text('Scrolled to ' + r + ' px');
        }
        case 'preview_wait': {
          if (a.text) {
            const end = Date.now() + (a.timeout || 8) * 1000;
            while (Date.now() < end) { const has = await p.pane.eval(`document.body&&document.body.innerText.indexOf(${J(a.text)})>=0`); if (!!has !== !!a.gone) return text((a.gone ? 'Gone: ' : 'Found: ') + a.text); await sleep(250); }
            return fail('Timed out waiting for "' + a.text + '"' + (a.gone ? ' to disappear' : '') + '.');
          }
          await sleep(Math.min(a.ms || 500, 20000)); return text('Waited.');
        }
      }
      return fail('Unknown preview tool');
    },
    names: ['preview_snapshot', 'preview_click', 'preview_hover', 'preview_type', 'preview_press', 'preview_scroll', 'preview_wait'],
  };
})();