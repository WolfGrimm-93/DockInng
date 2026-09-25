/* DockInng — plantilla navegable (JS vanilla, sin dependencias). Datos de ejemplo en js/data.js.
 *
 * SEGURIDAD: todas las plantillas usan la etiqueta h`...`, que ESCAPA cada valor interpolado
 * (también dentro de atributos). Solo el HTML marcado con raw()/h`` (Safe) pasa sin escapar.
 * Equivalente en React: {valor} y nunca dangerouslySetInnerHTML.
 *
 * Parámetros de URL (todos opcionales, combinables; los de vista también valen tras el # como #create?image=redis:7):
 *   #containers | #detail | #create | #images | #pull | #volumes | #networks | #stacks | #stack-edit | #settings | #conn-new
 *   ?theme=light|dark          ?sidebar=collapsed|expanded         ?ctx=local|prod|staging
 *   ?state=empty|loading       estados de datos de la vista actual
 *   ?state=error|daemon|ssh    error de conexión (permiso del socket / daemon apagado / SSH)
 *   ?state=lost                desconectado durante el uso (datos anteriores, acciones bloqueadas)
 *   ?compose=missing           Docker Compose no instalado (Stacks / editor)
 *   ?tab=logs|terminal|stats|inspect      ?c=<nombre de contenedor>
 *   ?group=1  ?sel=3           agrupar por stack; preseleccionar filas
 *   ?dialog=delete|delete-running|delete-multi|volume|prune-volumes|stack-down|blocked|palette
 *   ?menu=1  ?toast=1  ?policy=denied
 *   #create?image=postgres:16.4&remote=1     formulario con imagen y contexto remoto (aviso de rutas relativas)
 *   #pull?pull=running|done|canceled|error   #stack-edit?stack=tienda&yaml=broken&run=up|done&file=env
 *   #conn-new?test=testing|ok|fail
 */
(function () {
  'use strict';
  var D = window.DK;

  /* ---------- plantillas con escape automático ---------- */
  function Safe(s) { this.s = s; }
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) {
    if (v == null || v === false) return '';
    if (v instanceof Safe) return v.s;
    if (Array.isArray(v)) return v.map(esc).join('');
    return String(v).replace(/[&<>"']/g, function (c) { return ESC[c]; });
  }
  function h(strings) {
    var o = strings[0];
    for (var i = 1; i < arguments.length; i++) o += esc(arguments[i]) + strings[i];
    return new Safe(o);
  }
  function raw(s) { return new Safe(s); }
  function ico(n, cls) { return h`<svg class="i ${cls || ''}" aria-hidden="true"><use href="#i-${n}"/></svg>`; }

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  };
  var params = new URLSearchParams(location.search);
  var main = $('#main');
  var root = document.documentElement;

  /* ---------- estado ---------- */
  var S = {
    view: 'containers', hq: new URLSearchParams(''),
    ui: null,            /* 'empty' | 'loading': vista previa de datos, por vista */
    err: null,           /* 'permission' | 'daemon' | 'ssh' | 'lost': conexión, global */
    keep: false, compose: true,
    filter: 'all', q: '', group: params.get('group') === '1', collapsed: {}, sel: {},
    row: {},             /* por contenedor: { busy: 'start'|'stop'|'restart' } | { error: '...' } */
    ctx: 'local', detailName: params.get('c') || 'tienda-api-1',
    tab: params.get('tab') || 'logs', logLvl: 'all', logQ: '', follow: true,
    termLines: null, termHist: [], termIdx: 0,
    fk: null, form: null, pull: null, yaml: null, env: null, file: 'yaml', up: null, conn: null
  };
  var timers = [];
  function clearTimers() { timers.forEach(function (t) { clearInterval(t); clearTimeout(t); }); timers = []; }
  function P(k) { return S.hq.get(k) != null ? S.hq.get(k) : params.get(k); }
  function conn(id) { return D.connections.filter(function (c) { return c.id === (id || S.ctx); })[0] || D.connections[0]; }
  function byName(n) { return D.containers.filter(function (c) { return c.name === n; })[0]; }
  function isCollapsed() { return root.classList.contains('is-collapsed'); }
  function lost() { return S.err === 'lost'; }

  /* ---------- tema y sidebar ---------- */
  function currentTheme() { return root.classList.contains('dark') ? 'dark' : 'light'; }
  function applyTheme(t, persist) {
    root.classList.toggle('dark', t !== 'light');
    var dark = t !== 'light', b = $('#themeBtn');
    b.innerHTML = ico(dark ? 'sun' : 'moon').s;
    b.setAttribute('aria-label', dark ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro');
    if (persist) store.set('dockinng.theme', t);
  }
  function setCollapsed(c, persist) {
    root.classList.toggle('is-collapsed', c);
    var b = $('#collapseBtn');
    b.setAttribute('aria-expanded', String(!c));
    b.setAttribute('aria-label', c ? 'Expandir barra lateral' : 'Colapsar barra lateral');
    b.dataset.tip = b.getAttribute('aria-label');
    if (persist) store.set('dockinng.sidebar', c ? 'collapsed' : 'expanded');
  }

  /* ---------- toasts (pausan con hover/foco; los de error son role=alert) ---------- */
  function toast(msg, kind, sub, sticky) {
    kind = kind || 'ok';
    var el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    el.innerHTML = h`<span class="t-ico">${ico(kind === 'ok' ? 'check' : kind === 'err' ? 'xcircle' : 'warn')}</span><div class="t-body"><b>${msg}</b>${sub ? h`<small>${sub}</small>` : ''}</div><button class="close" aria-label="Cerrar aviso">${ico('x', 'sm')}</button>`.s;
    $('#toasts').appendChild(el);
    var t, kill = function () { clearTimeout(t); el.remove(); };
    var start = function () { if (sticky) return; clearTimeout(t); t = setTimeout(kill, kind === 'err' ? 8000 : 4500); };
    var stop = function () { clearTimeout(t); };
    el.addEventListener('mouseenter', stop); el.addEventListener('focusin', stop);
    el.addEventListener('mouseleave', start); el.addEventListener('focusout', start);
    $('.close', el).addEventListener('click', kill);
    start();
  }
  /* Resultado "Deny inesperado" de ConfirmationPolicy: el backend rechaza algo que la UI permitía */
  function policyDenied(action, reason) {
    toast('El motor de seguridad rechazó «' + action + '»', 'err', reason, true);
  }

  /* ---------- diálogos: trampa de Tab real, foco de retorno ---------- */
  function trapTab(dlg) {
    dlg.addEventListener('keydown', function (e) {
      if (e.key !== 'Tab') return;
      var f = $$('button:not([disabled]), input:not([disabled]), select, textarea, a[href], [tabindex]:not([tabindex="-1"])', dlg).filter(function (x) { return x.offsetParent !== null || x === document.activeElement; });
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!dlg.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    });
  }
  $$('dialog').forEach(function (d) { trapTab(d); d.addEventListener('close', function () { S.fk = null; }); });
  function openDlg(dlg, focusEl, keepKey) {
    S.fk = keepKey ? focusKey(document.activeElement) : null;
    dlg.showModal();
    (focusEl || $('.btn-secondary', dlg) || $('button', dlg)).focus();
  }
  var pendingOk = null;
  /* o: { title, desc, extra, level, ok, typed, onOk } */
  function confirmDlg(o) {
    $('#dcTitle').textContent = o.title;
    $('#dcDesc').innerHTML = esc(o.desc);
    var typed = o.typed ? h`<div class="typed"><label for="dcTyped">Para confirmar, escribe <b class="mono">${o.typed}</b></label><input class="input" id="dcTyped" autocomplete="off" spellcheck="false" aria-describedby="dcDesc"></div>` : '';
    $('#dcExtra').innerHTML = esc(o.extra) + esc(typed);
    $('#dcLevel').innerHTML = esc(o.level || h`<b>Nivel Confirmar.</b> Esta acción no se puede deshacer.`);
    $('#dcOkText').textContent = o.ok;
    var ok = $('#dcOk'); ok.disabled = !!o.typed;
    pendingOk = o.onOk;
    var t = $('#dcTyped');
    if (t) t.addEventListener('input', function () { ok.disabled = t.value.trim() !== o.typed; });
    openDlg($('#dlgConfirm'), $('#dcCancel'), true);
  }
  $('#dcCancel').addEventListener('click', function () { pendingOk = null; $('#dlgConfirm').close(); });
  $('#dcOk').addEventListener('click', function () {
    if (this.disabled) return;
    var f = pendingOk; pendingOk = null; $('#dlgConfirm').close(); if (f) f();
  });
  $('#dbOk').addEventListener('click', function () { $('#dlgBlocked').close(); });
  function blockedDlg() { openDlg($('#dlgBlocked'), $('#dbOk')); }

  /* ---------- foco: se conserva al reconstruir la vista ---------- */
  /* Firma estable de un elemento: data-fk (si existe) o etiqueta + id + data-* + aria-label */
  function sigOf(el) {
    if (el.dataset.fk) return 'fk:' + el.dataset.fk;
    var d = {}; for (var k in el.dataset) d[k] = el.dataset[k];
    return JSON.stringify([el.tagName, el.id, d, el.getAttribute('aria-label')]);
  }
  function focusKey(el) {
    if (!el || !main.contains(el) || el === main) return null;
    var all = $$('button, a[href], input, select, textarea, [tabindex]', main);
    return { sig: sigOf(el), i: all.indexOf(el), ss: el.selectionStart, se: el.selectionEnd };
  }
  function restoreFocus(fk) {
    if (!fk) return;
    var all = $$('button, a[href], input, select, textarea, [tabindex]', main), t = null;
    all.forEach(function (el) {
      if (!t && sigOf(el) === fk.sig && !el.disabled) t = el;
    });
    if (!t) { var v = $('#viewTitle'); t = v || null; if (!t) return; }
    t.focus({ preventScroll: true });
    if (fk.ss != null && t.setSelectionRange && /text|search|textarea/.test(t.type || '')) { try { t.setSelectionRange(fk.ss, fk.se); } catch (e) {} }
  }

  /* ---------- piezas de UI ---------- */
  function statusBadge(s, busy) {
    if (busy) return h`<span class="status status-restarting">${ico('loader', 'spin')}${busy === 'start' ? 'Iniciando…' : busy === 'stop' ? 'Deteniendo…' : 'Reiniciando…'}</span>`;
    var d = D.STATUS[s];
    return h`<span class="status status-${s}">${ico(d.icon, d.fill ? 'fill' : '')}${d.label}</span>`;
  }
  /* Encabezado único de vista: título + contador · secundarias · primaria (a la derecha) */
  function pageHead(o) {
    return h`<header class="view-head">${o.back || ''}<div class="view-title"><h1 tabindex="-1" id="viewTitle">${o.title}</h1>${o.count != null ? h`<span class="count">${o.count}</span>` : ''}</div><div class="view-actions">${o.secondary || ''}${o.primary || ''}</div></header>`;
  }
  function searchField(id, ph, val) {
    return h`<label class="field field-search">${ico('search')}<input class="input" id="${id}" type="search" placeholder="${ph}" aria-label="${ph}" value="${val || ''}" autocomplete="off"></label>`;
  }
  function emptyState(icon, title, text, btns) {
    return h`<div class="card"><div class="state"><span class="state-ico">${ico(icon, 'lg')}</span><h2>${title}</h2><p>${text}</p><div class="btns">${btns || ''}</div></div></div>`;
  }
  function alertBox(kind, icon, title, text, btns) {
    return h`<div class="alert alert-${kind}" role="${kind === 'error' ? 'alert' : 'status'}">${ico(icon)}<div><b>${title}</b><p>${text}</p>${btns ? h`<div class="btns">${btns}</div>` : ''}</div></div>`;
  }
  function skeletonTable(cols, rows) {
    var th = [], tr = [], i, r, j;
    for (i = 0; i < cols; i++) th.push(h`<th><span class="skeleton" style="width:${40 + (i * 13) % 40}px;height:10px"></span></th>`);
    for (r = 0; r < rows; r++) { var td = []; for (j = 0; j < cols; j++) td.push(h`<td><span class="skeleton" style="width:${j === 1 ? 140 : 50 + ((r + j) * 17) % 50}px"></span></td>`); tr.push(h`<tr class="sk-row">${td}</tr>`); }
    return h`<div class="table-wrap" aria-busy="true" role="status" aria-label="Cargando datos"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
  }
  function errorPanel() {
    var c = conn(), e = D.ERRORS[S.err] || D.ERRORS.permission, target = c.remote ? c.sub : '/var/run/docker.sock';
    var steps = e.steps.map(function (s, i) {
      var cls = s[0] === 'skip' ? 'skip-step' : s[0], icon = s[0] === 'ok' ? 'check' : s[0] === 'fail' ? 'x' : 'dots';
      return h`<li class="${cls}"><span class="step-ico">${ico(icon, 'sm')}</span><div><b>${i + 1}. ${s[1]}</b><p>${s[2]}</p>${s[3] ? h`<code>${s[3]}</code>` : ''}${s[5] ? h`<p style="margin-top:6px">${s[5]}</p>` : ''}</div><span class="tag" ${s[0] === 'fail' ? raw('style="color:var(--status-dead)"') : ''}>${s[4]}</span></li>`;
    });
    var fix = (e.steps.filter(function (s) { return s[0] === 'fail' && s[3]; })[0] || [])[3] || '';
    return h`<div class="card error-panel" role="alert"><header>${ico('alert', 'lg')}<div><h2>${e.title}</h2><p>${e.lead(target, c.name)}</p></div></header><ol class="diag">${steps}</ol><footer><button class="btn btn-primary" data-act="retry">${ico('refresh')}Reintentar conexión</button>${fix ? h`<button class="btn btn-secondary" data-act="copyfix" data-fix="${fix}">${ico('copy')}Copiar comando</button>` : ''}<button class="btn btn-ghost" data-act="ctxopen">Cambiar de conexión</button></footer></div>`;
  }
  function lostBanner() {
    return alertBox('error', 'alert', 'Se perdió la conexión con el motor', 'Mostrando los últimos datos conocidos (hace 12 s). Las acciones están desactivadas hasta reconectar.', h`<button class="btn btn-secondary btn-sm" data-act="retry">${ico('refresh', 'sm')}Reconectar</button><button class="btn btn-ghost btn-sm" data-act="ctxopen">Cambiar de conexión</button>`);
  }
  function composeMissing() {
    return h`<div class="card error-panel is-info" role="status"><header>${ico('warn', 'lg')}<div><h2>Docker Compose no está instalado</h2><p>DockInng necesita el plugin <code>docker compose</code> para levantar, bajar y editar stacks. Los contenedores y las imágenes siguen funcionando.</p></div></header><ol class="diag"><li class="fail"><span class="step-ico">${ico('x', 'sm')}</span><div><b>docker compose version</b><p>Comando no encontrado.</p><code>sudo pacman -S docker-compose</code><p style="margin-top:6px">En Debian o Ubuntu: <code style="display:inline;padding:0 4px;margin:0">sudo apt install docker-compose-plugin</code></p></div><span class="tag" style="color:var(--status-dead)">Falta</span></li></ol><footer><button class="btn btn-primary" data-act="recheck">${ico('refresh')}Volver a comprobar</button><button class="btn btn-secondary" data-act="copyfix" data-fix="sudo pacman -S docker-compose">${ico('copy')}Copiar comando</button></footer></div>`;
  }
  function inLost(content) { return lost() ? h`${lostBanner()}${content}` : content; }

  /* ---------- confirmaciones (nivel Confirmar) ---------- */
  function mb(n) { return n >= 1024 ? (n / 1024).toFixed(1) + ' GB' : n + ' MB'; }
  function volSize(name) { var v = D.volumes.filter(function (x) { return x.name === name; })[0]; return v ? v.size : ''; }
  function askDelete(list) {
    var running = list.filter(function (c) { return c.status === 'running' || c.status === 'paused' || c.status === 'restarting'; });
    var vols = []; list.forEach(function (c) { c.vols.forEach(function (v) { if (vols.indexOf(v) < 0) vols.push(v); }); });
    var single = list.length === 1, c0 = list[0];
    var desc = single ? h`<p>Se eliminará <b class="mono">${c0.name}</b>.</p>` : h`<p>Se eliminarán <b>${list.length} contenedores</b>:</p><ul class="dlg-list" aria-label="Contenedores a eliminar">${list.map(function (c) { return h`<li><span class="mono">${c.name}</span><span class="end">${D.STATUS[c.status].label}</span></li>`; })}</ul>`;
    var extra = h`${running.length ? h`<div class="dlg-warn" role="note">${ico('warn', 'sm')}<span>${single ? 'Está en ejecución.' : running.length + ' están en ejecución.'} Se eliminará con <code>--force</code>: el proceso recibe SIGKILL, sin apagado ordenado.</span></div>` : ''}${vols.length ? h`<p style="margin-top:10px">Volúmenes montados (<b>no se eliminan</b>, quedarán sin usar):</p><ul class="dlg-list">${vols.map(function (v) { return h`<li>${ico('database', 'sm')}<span class="mono">${v}</span><span class="end">${volSize(v)}</span></li>`; })}</ul>` : h`<p style="margin-top:10px">No tiene volúmenes con nombre.${single && c0.bind.length ? ' Los bind mounts (' + c0.bind.join(', ') + ') tampoco se tocan.' : ''}</p>`}`;
    confirmDlg({
      title: single ? 'Eliminar contenedor' : 'Eliminar ' + list.length + ' contenedores', desc: desc, extra: extra,
      level: h`<b>Nivel Confirmar.</b> No se puede deshacer. Los volúmenes y las imágenes no se tocan (no se envía <code>v=true</code>).`,
      ok: single ? 'Eliminar contenedor' : 'Eliminar ' + list.length,
      onOk: function () {
        var names = list.map(function (c) { return c.name; });
        D.containers = D.containers.filter(function (c) { return names.indexOf(c.name) < 0; });
        names.forEach(function (n) { delete S.sel[n]; });
        toast(single ? c0.name + ' eliminado' : list.length + ' contenedores eliminados', 'ok', vols.length ? vols.length + ' volumen(es) quedan sin usar' : null);
        if (S.view === 'detail') location.hash = '#containers'; else render();
      }
    });
  }
  function askDeleteVolume(v) {
    confirmDlg({ title: 'Eliminar volumen', typed: v.name,
      desc: h`<p>Se borrarán <b>para siempre</b> los datos de <b class="mono">${v.name}</b>.</p><ul class="dlg-list"><li>${ico('database', 'sm')}<span class="mono">${v.name}</span><span class="end">${v.size}</span></li></ul>`,
      level: h`<b>Nivel Confirmar con nombre.</b> Los datos de un volumen no se pueden recuperar.`, ok: 'Eliminar volumen',
      onOk: function () { D.volumes = D.volumes.filter(function (x) { return x !== v; }); toast('Volumen eliminado', 'ok', v.size + ' liberados'); render(); } });
  }
  function askPruneVolumes() {
    var un = D.volumes.filter(function (v) { return !v.used.length; }), tot = un.reduce(function (a, v) { return a + v.mb; }, 0);
    confirmDlg({ title: 'Eliminar volúmenes sin usar', typed: 'ELIMINAR',
      desc: h`<p>Se borrarán <b>${un.length} volúmenes</b> que ningún contenedor usa, con sus datos (${mb(tot)} en total).</p><ul class="dlg-list" aria-label="Volúmenes afectados">${un.map(function (v) { return h`<li>${ico('database', 'sm')}<span class="mono">${v.name.length > 26 ? v.name.slice(0, 24) + '…' : v.name}</span><span class="end">${v.size}</span></li>`; })}</ul>`,
      level: h`<b>Confirmación humana obligatoria.</b> La política la exige aunque la acción se lance con la opción de omitir confirmaciones.`, ok: 'Eliminar ' + un.length + ' volúmenes',
      onOk: function () { D.volumes = D.volumes.filter(function (v) { return v.used.length; }); toast(un.length + ' volúmenes eliminados', 'ok', mb(tot) + ' liberados'); render(); } });
  }
  function askStackDown(s) {
    var cs = D.containers.filter(function (c) { return c.stack === s.name; });
    confirmDlg({ title: 'Bajar stack ' + s.name, typed: s.name,
      desc: h`<p>Se detendrán y eliminarán los <b>${cs.length} contenedores</b> del stack y su red. Los volúmenes se conservan.</p><ul class="dlg-list" aria-label="Contenedores afectados">${cs.map(function (c) { return h`<li><span class="mono">${c.name}</span><span class="end">${D.STATUS[c.status].label}</span></li>`; })}</ul>`,
      level: h`<b>Nivel Confirmar con nombre.</b> Equivale a <code>docker compose down</code>.`, ok: 'Bajar stack',
      onOk: function () { toast('Stack ' + s.name + ' bajado', 'ok', cs.length + ' contenedores eliminados'); } });
  }
  function askDeleteImage(im) {
    confirmDlg({ title: 'Eliminar imagen', desc: h`<p>Se eliminará <b class="mono">${im.repo}:${im.tag}</b> (${im.size} MB). Podrás volver a descargarla.</p>`,
      ok: 'Eliminar imagen', onOk: function () { D.images = D.images.filter(function (i) { return i !== im; }); toast('Imagen eliminada', 'ok', im.size + ' MB liberados'); render(); } });
  }
  function askPruneImages() {
    var un = D.images.filter(function (i) { return !i.used; }), tot = un.reduce(function (a, i) { return a + i.size; }, 0);
    confirmDlg({ title: 'Eliminar imágenes sin usar', desc: h`<p>Se eliminarán <b>${un.length} imágenes</b> que ningún contenedor usa (${tot} MB). No afecta a contenedores.</p><ul class="dlg-list">${un.map(function (i) { return h`<li><span class="mono">${i.repo}:${i.tag}</span><span class="end">${i.size} MB</span></li>`; })}</ul>`,
      ok: 'Eliminar ' + un.length + ' imágenes', onOk: function () { D.images = D.images.filter(function (i) { return i.used; }); toast(un.length + ' imágenes eliminadas', 'ok', tot + ' MB liberados'); render(); } });
  }
  function askDeleteNetwork(n) {
    confirmDlg({ title: 'Eliminar red', desc: h`<p>Se eliminará la red <b class="mono">${n.name}</b> (${n.subnet}). No tiene contenedores conectados.</p>`, ok: 'Eliminar red',
      onOk: function () { D.networks = D.networks.filter(function (x) { return x !== n; }); toast('Red eliminada'); render(); } });
  }

  /* ---------- acciones sobre contenedores (con estado por fila) ---------- */
  function act(name, a) {
    var c = byName(name); if (!c || lost()) return;
    if (S.row[name] && S.row[name].busy) return;
    if (a === 'delete') return askDelete([c]);
    S.row[name] = { busy: a }; render();
    timers.push(setTimeout(function () {
      var fail = a === 'start' && D.failStart[name] && !c.tried;
      delete S.row[name];
      if (fail) { c.tried = true; S.row[name] = { error: D.failStart[name] }; toast('No se pudo iniciar ' + name, 'err', D.failStart[name]); render(); return; }
      if (a === 'start') { c.status = 'running'; c.up = 'hace un momento'; c.cpu = 0.5; c.mem = 20; toast(name + ' iniciado'); }
      else if (a === 'stop') { c.status = 'exited'; c.cpu = 0; c.mem = 0; c.up = 'salió (0) ahora'; toast(name + ' detenido'); }
      else { c.status = 'running'; c.up = 'hace un momento'; toast(name + ' reiniciado'); }
      render();
    }, 900));
  }
  function bulk(a) {
    var names = Object.keys(S.sel), list = names.map(byName).filter(Boolean);
    if (a === 'delete') return askDelete(list);
    list.forEach(function (c) { if (a === 'start') { c.status = 'running'; c.cpu = 0.5; c.mem = 20; } else { c.status = 'exited'; c.cpu = 0; c.mem = 0; } });
    toast(list.length + (a === 'start' ? ' contenedores iniciados' : ' contenedores detenidos')); S.sel = {}; render();
  }
  function rowActions(c) {
    var on = c.status === 'running' || c.status === 'paused' || c.status === 'restarting', busy = S.row[c.name] && S.row[c.name].busy;
    return h`<div class="row-actions">${on
      ? h`<button class="btn btn-ghost btn-icon" data-fk="toggle:${c.name}" data-a="stop" data-n="${c.name}" aria-label="Detener ${c.name}" data-tip="Detener" ${busy ? raw('aria-disabled="true"') : ''}>${ico('square', 'fill')}</button>`
      : h`<button class="btn btn-ghost btn-icon" data-fk="toggle:${c.name}" data-a="start" data-n="${c.name}" aria-label="Iniciar ${c.name}" data-tip="Iniciar" ${busy ? raw('aria-disabled="true"') : ''}>${ico('play', 'fill')}</button>`}<button class="btn btn-ghost btn-icon" data-a="restart" data-n="${c.name}" aria-label="Reiniciar ${c.name}" ${on && !busy ? '' : raw('disabled')}>${ico('rotate')}</button><span class="sep" aria-hidden="true"></span><button class="btn btn-ghost btn-icon btn-del" data-a="delete" data-n="${c.name}" aria-label="Eliminar ${c.name}" ${busy ? raw('aria-disabled="true"') : ''}>${ico('trash')}</button></div>`;
  }

  /* ---------- vista: contenedores ---------- */
  function matches(c) {
    var f = S.filter;
    if (f === 'running' && c.status !== 'running') return false;
    if (f === 'stopped' && ['exited', 'dead', 'created'].indexOf(c.status) < 0) return false;
    var q = S.q.trim().toLowerCase();
    return !q || (c.name + ' ' + c.image + ' ' + c.id + ' ' + c.ports).toLowerCase().indexOf(q) >= 0;
  }
  function rowHtml(c) {
    var sel = !!S.sel[c.name], st = S.row[c.name] || {}, memPct = Math.min(100, c.mem / 512 * 100);
    return h`<tr data-name="${c.name}" aria-selected="${'' + sel}" ${st.busy ? raw('aria-busy="true"') : ''}>
      <td class="col-check"><input type="checkbox" class="check-box" data-sel="${c.name}" aria-label="Seleccionar ${c.name}" ${sel ? raw('checked') : ''}></td>
      <td class="cell-name"><div class="name-cell"><a href="#detail" data-open="${c.name}" title="${c.name} · ${c.id}">${c.name}</a><small class="mono" title="${c.image}">${c.image}</small><small class="sub-extra">${c.ports} · ${c.mem ? c.mem + ' MiB' : 'sin memoria en uso'}</small></div></td>
      <td><div class="status-cell">${statusBadge(c.status, st.busy)}${st.error ? h`<small class="row-error">${ico('alert', 'sm')} ${st.error} <button class="link" data-a="start" data-n="${c.name}" style="color:var(--foreground);text-decoration:underline">Reintentar</button></small>` : h`<small>${c.up}</small>`}</div></td>
      <td class="col-ports mono">${c.ports}</td>
      <td class="num col-cpu">${c.status === 'running' ? c.cpu.toFixed(1) + '%' : '—'}</td>
      <td class="num col-mem">${c.mem ? h`<span class="bar" aria-hidden="true"><i style="width:${memPct}%"></i></span>${c.mem} MiB` : '—'}</td>
      <td class="col-actions">${rowActions(c)}</td></tr>`;
  }
  function viewContainers() {
    var C = D.containers, run = C.filter(function (c) { return c.status === 'running'; }).length;
    var stopped = C.filter(function (c) { return ['exited', 'dead', 'created'].indexOf(c.status) >= 0; }).length;
    var head = pageHead({ title: 'Contenedores', count: S.err && S.err !== 'lost' ? null : C.length + ' en total · ' + run + ' en ejecución',
      secondary: h`<button class="btn btn-secondary" data-act="refresh">${ico('refresh')}Actualizar</button>`,
      primary: h`<a class="btn btn-primary" href="#create">${ico('plus')}Nuevo contenedor</a>` });
    if (S.err && !lost()) return h`${head}<div class="view-body">${errorPanel()}</div>`;
    var names = Object.keys(S.sel);
    var tb = h`<div class="toolbar">${searchField('q', 'Buscar por nombre, imagen o ID', S.q)}
      <div class="segmented" role="group" aria-label="Filtrar por estado">
      <button aria-pressed="${'' + (S.filter === 'all')}" data-f="all">Todos <span class="muted">${C.length}</span></button>
      <button aria-pressed="${'' + (S.filter === 'running')}" data-f="running">En ejecución <span class="muted">${run}</span></button>
      <button aria-pressed="${'' + (S.filter === 'stopped')}" data-f="stopped">Detenidos <span class="muted">${stopped}</span></button></div>
      <button class="btn btn-secondary" data-act="group" aria-pressed="${'' + S.group}">${ico('grid')}Agrupar por stack</button></div>`;
    if (S.ui === 'loading') return h`${head}${tb}<div class="view-body">${skeletonTable(7, 8)}</div>`;
    if (S.ui === 'empty' || !C.length) return h`${head}<div class="view-body">${emptyState('box', 'Todavía no hay contenedores', 'Cuando crees o ejecutes un contenedor aparecerá aquí. Puedes empezar desde una imagen ya descargada o desde un archivo Compose.', h`<a class="btn btn-primary" href="#create">${ico('plus')}Nuevo contenedor</a><a class="btn btn-secondary" href="#stacks">Abrir un stack</a>`)}</div>`;
    var list = C.filter(matches);
    if (names.length) {
      tb = h`<div class="toolbar"><div class="bulkbar" role="region" aria-label="Acciones sobre la selección"><strong>${names.length} seleccionado${names.length > 1 ? 's' : ''}</strong>
        <button class="btn btn-secondary btn-sm" data-b="start">${ico('play', 'sm fill')}Iniciar</button><button class="btn btn-secondary btn-sm" data-b="stop">${ico('square', 'sm fill')}Detener</button>
        <span class="sep" aria-hidden="true"></span><button class="btn btn-outline-destructive btn-sm" data-b="delete">${ico('trash', 'sm')}Eliminar…</button><button class="btn btn-ghost btn-sm" data-b="clear">Quitar selección</button></div></div>`;
    }
    var allSel = list.length && list.every(function (c) { return S.sel[c.name]; });
    var body;
    if (!list.length) {
      body = h`<tr><td colspan="7" style="height:auto"><div class="state" style="padding:36px 24px"><span class="state-ico">${ico('search', 'lg')}</span><h2>Ningún contenedor coincide</h2><p>Prueba con otro nombre o quita el filtro de estado.</p><div class="btns"><button class="btn btn-secondary" data-act="clearf">Quitar filtros</button></div></div></td></tr>`;
    } else if (S.group) {
      var groups = {}, order = [];
      list.forEach(function (c) { var k = c.stack || '(sin stack)'; if (!groups[k]) { groups[k] = []; order.push(k); } groups[k].push(c); });
      body = order.map(function (k) {
        var open = !S.collapsed[k];
        return h`<tr class="group-row"><td colspan="7"><button data-g="${k}" aria-expanded="${'' + open}">${ico('chev-down', 'sm chev')}${k === '(sin stack)' ? 'Sin stack' : 'Stack ' + k} <span class="muted" style="font-weight:400">· ${groups[k].length}</span></button></td></tr>${open ? groups[k].map(rowHtml) : ''}`;
      });
    } else body = list.map(rowHtml);
    var table = h`<div class="table-wrap"><table><caption class="sr-only">Lista de contenedores</caption><thead><tr>
      <th class="col-check"><input type="checkbox" class="check-box" id="selAll" aria-label="Seleccionar todos" ${allSel ? raw('checked') : ''}></th>
      <th scope="col" class="cell-name">Nombre</th><th scope="col">Estado</th><th scope="col" class="col-ports">Puertos</th><th scope="col" class="num col-cpu">CPU</th><th scope="col" class="num col-mem">Memoria</th><th scope="col" class="col-actions"><span class="sr-only">Acciones</span></th></tr></thead><tbody>${body}</tbody></table></div>`;
    return h`${head}${tb}<div class="view-body">${lost() ? lostBanner() : ''}${table}</div>`;
  }

  /* ---------- vista: detalle ---------- */
  function fmtT(t, ms) { var p = function (n, l) { return String(n).padStart(l || 2, '0'); }; return p(Math.floor(t / 3600) % 24) + ':' + p(Math.floor(t / 60) % 60) + ':' + p(t % 60) + '.' + p(ms, 3); }
  var logData = (function () { var t = 14 * 3600 + 2 * 60 + 11; return D.logSeed.map(function (l, i) { t += 1 + (i * 7) % 9; return { ts: fmtT(t, i * 37 % 1000), lvl: l[0], msg: l[1] }; }); })();
  function logMatch(l) { var q = S.logQ.trim().toLowerCase(); return (S.logLvl === 'all' || l.lvl === S.logLvl) && (!q || l.msg.toLowerCase().indexOf(q) >= 0); }
  function logLine(l) { return h`<div class="log-line ${l.lvl === 'ERROR' ? 'is-error' : l.lvl === 'WARN' ? 'is-warn' : ''}"><span class="log-ts">${l.ts}</span><span class="log-lvl lvl-${l.lvl.toLowerCase()}">${l.lvl}</span><span>${l.msg}</span></div>`; }
  function logHtml() {
    var rows = logData.filter(logMatch);
    return rows.length ? h`${rows.map(logLine)}` : h`<div class="state"><p style="color:var(--console-muted)">Ninguna línea coincide con el filtro.</p></div>`;
  }
  function chartSvg(id, vals, color, label) {
    var w = 300, hh = 96, n = vals.length, pts = vals.map(function (v, i) { return (i * w / (n - 1)).toFixed(1) + ',' + (hh - 4 - v / 100 * (hh - 8)).toFixed(1); }).join(' ');
    return h`<svg class="chart" id="${id}" viewBox="0 0 ${w} ${hh}" preserveAspectRatio="none" role="img" aria-label="${label}">${[24, 48, 72].map(function (y) { return h`<line class="grid" x1="0" x2="${w}" y1="${y}" y2="${y}" vector-effect="non-scaling-stroke"/>`; })}<polygon class="area" fill="${color}" points="0,${hh} ${pts} ${w},${hh}"/><polyline class="line" stroke="${color}" points="${pts}"/></svg>`;
  }
  var cpuSeries = [], memSeries = [];
  (function () { for (var i = 0; i < 60; i++) { cpuSeries.push(6 + 5 * Math.sin(i / 5) + (i * 13 % 7)); memSeries.push(40 + i * 0.05 + 2 * Math.sin(i / 9)); } })();
  function inspectHtml(c) {
    var obj = { Id: c.id + '4d0e91b7a62c83f5e1a09d7c2b8f4361a5e0c9d27b', Name: '/' + c.name, Created: '2026-09-21T09:14:52.318Z', Image: c.image,
      State: { Status: c.status, Running: c.status === 'running', Paused: c.status === 'paused', Restarting: c.status === 'restarting', Pid: 48213, ExitCode: 0, StartedAt: '2026-09-21T09:15:01.204Z' },
      Config: { Hostname: c.id, User: 'node', Env: ['NODE_ENV=production', 'PORT=3000', 'DATABASE_URL=postgres://tienda@tienda-postgres-1:5432/tienda', 'REDIS_URL=redis://tienda-redis-1:6379'], Cmd: ['node', 'dist/main.js'], WorkingDir: '/app',
        Labels: { 'com.docker.compose.project': c.stack || '', 'com.docker.compose.service': c.name.replace(/^[a-z]+-/, '').replace(/-\d+$/, '') } },
      HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 }, Memory: 536870912, NanoCpus: 1000000000 },
      NetworkSettings: { Networks: { tienda_default: { IPAddress: '172.20.0.3', Gateway: '172.20.0.1' } }, Ports: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '3000' }] } },
      Mounts: [{ Type: 'bind', Source: '/home/ana/proyectos/tienda/uploads', Destination: '/app/uploads', RW: true }] };
    /* se escapa primero (esc) y después se colorea: los valores nunca llegan crudos al DOM */
    return raw(esc(JSON.stringify(obj, null, 2)).replace(/(&quot;(?:\\.|(?!&quot;).)*?&quot;)(\s*:)?|\b(true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g, function (m, str, colon, bool) {
      if (str) return colon ? '<span class="k">' + str + '</span>' + colon : '<span class="s">' + str + '</span>';
      if (bool) return '<span class="b">' + m + '</span>';
      return '<span class="n">' + m + '</span>';
    }));
  }
  function promptHtml(c) { return h`<span class="p1">root@${c.id}</span>:<span class="p2">/app</span># `; }
  function viewDetail() {
    var c = byName(S.detailName) || D.containers[1] || D.containers[0];
    if (!c) { location.hash = '#containers'; return h``; }
    var on = c.status === 'running' || c.status === 'paused' || c.status === 'restarting', busy = S.row[c.name] && S.row[c.name].busy;
    var back = h`<div style="width:100%"><a class="crumb" href="#containers">${ico('back', 'sm')}Contenedores</a></div>`;
    var actions = h`${on ? h`<button class="btn btn-secondary" data-fk="dtoggle" data-a="stop" data-n="${c.name}" ${busy ? raw('aria-disabled="true"') : ''}>${ico('square', 'fill')}Detener</button>` : h`<button class="btn btn-primary" data-fk="dtoggle" data-a="start" data-n="${c.name}" ${busy ? raw('aria-disabled="true"') : ''}>${ico('play', 'fill')}Iniciar</button>`}<button class="btn btn-secondary" data-a="restart" data-n="${c.name}" ${on && !busy ? '' : raw('disabled')}>${ico('rotate')}Reiniciar</button><span class="sep" aria-hidden="true" style="margin:4px 10px"></span><button class="btn btn-outline-destructive" data-a="delete" data-n="${c.name}" ${busy ? raw('aria-disabled="true"') : ''}>${ico('trash')}Eliminar…</button>`;
    var head = h`<header class="view-head" style="padding-bottom:6px">${back}<div class="detail-title"><h1 id="viewTitle" tabindex="-1">${c.name}</h1>${statusBadge(c.status, busy)}${c.stack ? h`<span class="tag tag-brand">${ico('grid', 'sm')}stack ${c.stack}</span>` : ''}</div><div class="view-actions">${actions}</div></header>`;
    if (S.err && !lost()) return h`${head}<div class="view-body">${errorPanel()}</div>`;
    var meta = h`<div class="meta-line"><span>Imagen <span class="mono">${c.image}</span></span><span>ID <span class="mono">${c.id}</span></span><span>IP <span class="mono">172.20.0.3</span></span><span>Puertos <span class="mono">${c.ports}</span></span><span>${c.up}</span></div>`;
    var tabs = [['logs', 'Logs', 'file'], ['terminal', 'Terminal', 'terminal'], ['stats', 'Estadísticas', 'activity'], ['inspect', 'Inspeccionar', 'braces']];
    var tabBar = h`<div class="tabs" role="tablist" aria-label="Secciones del contenedor">${tabs.map(function (t) {
      return h`<button class="tab" role="tab" id="tab-${t[0]}" aria-selected="${'' + (S.tab === t[0])}" aria-controls="panel" tabindex="${S.tab === t[0] ? 0 : -1}" data-tab="${t[0]}">${ico(t[2])}${t[1]}</button>`;
    })}</div>`;
    var p;
    if (S.tab === 'logs') {
      p = h`<div class="toolbar">${searchField('lq', 'Filtrar líneas de log', S.logQ)}
        <div class="segmented" role="group" aria-label="Nivel">${['all', 'INFO', 'WARN', 'ERROR', 'DEBUG'].map(function (l) { return h`<button data-ll="${l}" aria-pressed="${'' + (S.logLvl === l)}">${l === 'all' ? 'Todos' : l}</button>`; })}</div>
        <label style="display:inline-flex;gap:8px;align-items:center;margin-left:auto"><input type="checkbox" class="switch" id="follow" role="switch" ${S.follow ? raw('checked') : ''}> Seguir en vivo</label>
        <button class="btn btn-secondary btn-icon" data-act="copylog" aria-label="Copiar logs">${ico('copy')}</button></div>
        <div class="logs-wrap"><div class="console" id="logbox" tabindex="0" role="log" aria-label="Logs de ${c.name}">${logHtml()}</div></div>`;
    } else if (S.tab === 'terminal') {
      if (!S.termLines) S.termLines = [h`<span class="c-dim">Conectado a ${c.name} (sh). Escribe «help» para ver los comandos de la demo.</span>`];
      p = h`<div class="console term" id="term" role="region" aria-label="Terminal de ${c.name}"><div id="termOut" role="log" aria-live="polite" aria-label="Salida de la terminal">${S.termLines.map(function (l) { return h`<div class="term-line">${l}</div>`; })}</div>
        <div class="term-in"><label for="termIn" class="sr-only">Comando</label><span aria-hidden="true">${promptHtml(c)}</span><input id="termIn" autocomplete="off" spellcheck="false"></div></div>`;
    } else if (S.tab === 'stats') {
      p = h`<div class="stats-grid"><div class="card stat"><div class="stat-head">${ico('cpu')}<span>CPU</span><strong id="cpuVal">${cpuSeries[59].toFixed(1)}%</strong></div>${chartSvg('cpuChart', cpuSeries, 'var(--chart-1)', 'Uso de CPU en los últimos 60 segundos')}<div class="stat-foot"><span>hace 60 s</span><span>límite: 1 CPU</span><span>ahora</span></div></div>
        <div class="card stat"><div class="stat-head">${ico('database')}<span>Memoria</span><strong id="memVal">${Math.round(memSeries[59] * 5.12)} MiB</strong></div>${chartSvg('memChart', memSeries, 'var(--chart-2)', 'Uso de memoria en los últimos 60 segundos')}<div class="stat-foot"><span>hace 60 s</span><span>límite: 512 MiB</span><span>ahora</span></div></div>
        <div class="card stat"><div class="stat-head">${ico('network')}<span>Red (entrada / salida)</span></div><dl class="kv" style="grid-template-columns:auto 1fr"><dt>Recibido</dt><dd class="mono">184 MB · 1.2 MB/s</dd><dt>Enviado</dt><dd class="mono">96 MB · 640 KB/s</dd></dl></div>
        <div class="card stat"><div class="stat-head">${ico('disk')}<span>Disco (lectura / escritura)</span></div><dl class="kv" style="grid-template-columns:auto 1fr"><dt>Leído</dt><dd class="mono">412 MB</dd><dt>Escrito</dt><dd class="mono">1.9 GB</dd><dt>Procesos</dt><dd class="mono">23</dd></dl></div></div>`;
    } else {
      p = h`<div class="toolbar"><span class="muted">Salida de <code>docker inspect ${c.name}</code></span><button class="btn btn-secondary btn-sm" style="margin-left:auto" data-act="copyjson">${ico('copy')}Copiar JSON</button></div><div class="json" tabindex="0" role="region" aria-label="JSON de inspección de ${c.name}">${inspectHtml(c)}</div>`;
    }
    return h`<div style="display:flex;flex-direction:column;flex:1;min-height:0">${head}${meta}${tabBar}<div class="view-body tabpanel" id="panel" role="tabpanel" aria-labelledby="tab-${S.tab}">${lost() ? lostBanner() : ''}${p}</div></div>`;
  }

  /* ---------- vistas: imágenes / volúmenes / redes ---------- */
  function gateSimple(head, cols, rows, icon, etitle, etext, ebtn) {
    if (S.err && !lost()) return h`${head}<div class="view-body">${errorPanel()}</div>`;
    if (S.ui === 'loading') return h`${head}<div class="view-body">${skeletonTable(cols, rows)}</div>`;
    if (S.ui === 'empty') return h`${head}<div class="view-body">${emptyState(icon, etitle, etext, ebtn)}</div>`;
    return null;
  }
  function viewImages() {
    var I = D.images, total = I.reduce(function (a, b) { return a + b.size; }, 0);
    var head = pageHead({ title: 'Imágenes', count: I.length + ' · ' + (total / 1024).toFixed(1) + ' GB',
      secondary: h`<button class="btn btn-outline-destructive" data-act="prune-images">${ico('trash')}Eliminar sin usar…</button>`,
      primary: h`<a class="btn btn-primary" href="#pull">${ico('download')}Descargar imagen</a>` });
    var g = gateSimple(head, 5, 7, 'layers', 'No hay imágenes descargadas', 'Descarga una imagen desde un registro para poder crear contenedores con ella.', h`<a class="btn btn-primary" href="#pull">${ico('download')}Descargar imagen</a>`);
    if (g) return g;
    var q = S.q.toLowerCase();
    var rows = I.filter(function (i) { return !q || (i.repo + ':' + i.tag + i.id).toLowerCase().indexOf(q) >= 0; }).map(function (i) {
      var full = i.repo + ':' + i.tag;
      return h`<tr><td class="cell-name"><div class="name-cell"><b title="${full}">${i.repo}</b><small class="mono" title="${i.tag}">${i.tag}</small><small class="sub-extra">${i.id} · ${i.created}</small></div></td><td class="col-id mono muted">${i.id}<div class="muted" style="font-family:var(--font-sans);font-size:var(--text-xs)">${i.created}</div></td><td class="num col-size">${i.size} MB</td>
        <td>${i.used ? h`<span class="tag">${ico('check', 'sm')}En uso · ${i.used}</span>` : h`<span class="tag">Sin usar</span>`}</td>
        <td class="col-actions"><div class="row-actions"><a class="btn btn-ghost btn-icon" href="#create?image=${encodeURIComponent(full)}" aria-label="Ejecutar ${full}" data-tip="Ejecutar">${ico('play', 'fill')}</a><span class="sep" aria-hidden="true"></span><button class="btn btn-ghost btn-icon btn-del" data-imgdel="${i.id}" aria-label="Eliminar ${full}" ${i.used ? raw('disabled') : ''}>${ico('trash')}</button></div></td></tr>`;
    });
    return h`${head}<div class="toolbar">${searchField('q', 'Buscar imagen por nombre o ID', S.q)}</div><div class="view-body">${lost() ? lostBanner() : ''}<div class="table-wrap"><table><caption class="sr-only">Lista de imágenes</caption><thead><tr><th scope="col" class="cell-name">Imagen</th><th scope="col" class="col-id">ID y fecha</th><th scope="col" class="num col-size">Tamaño</th><th scope="col">Uso</th><th scope="col" class="col-actions"><span class="sr-only">Acciones</span></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }
  function viewVolumes() {
    var V = D.volumes, tot = V.reduce(function (a, v) { return a + v.mb; }, 0);
    var head = pageHead({ title: 'Volúmenes', count: V.length + ' · ' + mb(tot),
      secondary: h`<button class="btn btn-outline-destructive" data-act="prune-vol">${ico('trash')}Eliminar sin usar…</button>`,
      primary: h`<button class="btn btn-primary" data-act="newvol">${ico('plus')}Nuevo volumen</button>` });
    var g = gateSimple(head, 4, 6, 'database', 'No hay volúmenes', 'Los volúmenes guardan datos que sobreviven a los contenedores, como una base de datos.', h`<button class="btn btn-primary" data-act="newvol">${ico('plus')}Nuevo volumen</button>`);
    if (g) return g;
    var rows = V.map(function (v) {
      return h`<tr><td class="cell-name"><div class="name-cell"><b title="${v.name}">${v.name}</b><small class="mono" title="${v.mount}">${v.driver} · ${v.mount}</small></div></td><td class="num col-size">${v.size}</td>
        <td>${v.used.length ? h`<span class="tag" title="${v.used.join(', ')}">${ico('check', 'sm')}${v.used[0]}</span>` : h`<span class="tag">Sin usar</span>`}</td>
        <td class="col-actions"><div class="row-actions"><button class="btn btn-ghost btn-icon btn-del" data-voldel="${v.name}" aria-label="Eliminar volumen ${v.name}" ${v.used.length ? raw('disabled') : ''}>${ico('trash')}</button></div></td></tr>`;
    });
    return h`${head}<div class="view-body">${lost() ? lostBanner() : ''}<div class="table-wrap"><table><caption class="sr-only">Lista de volúmenes</caption><thead><tr><th scope="col" class="cell-name">Nombre</th><th scope="col" class="num col-size">Tamaño</th><th scope="col">Usado por</th><th scope="col" class="col-actions"><span class="sr-only">Acciones</span></th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted" style="font-size:var(--text-xs)">Los volúmenes en uso no se pueden eliminar: elimina primero el contenedor que los usa. Eliminar un volumen pide escribir su nombre.</p></div>`;
  }
  function viewNetworks() {
    var N = D.networks;
    var head = pageHead({ title: 'Redes', count: N.length, primary: h`<button class="btn btn-primary" data-act="newnet">${ico('plus')}Nueva red</button>` });
    var g = gateSimple(head, 5, 6, 'network', 'No hay redes personalizadas', 'Crea una red para que tus contenedores se encuentren por nombre.', h`<button class="btn btn-primary" data-act="newnet">${ico('plus')}Nueva red</button>`);
    if (g) return g;
    var rows = N.map(function (n) {
      return h`<tr><td class="cell-name"><div class="name-cell"><b title="${n.name}">${n.name}</b><small class="mono">${n.driver} · ${n.scope}</small><small class="sub-extra">${n.subnet}</small></div></td><td class="mono col-subnet">${n.subnet}</td><td class="num">${n.n}</td>
        <td>${n.sys ? h`<span class="tag">${ico('lock', 'sm')}Del sistema</span>` : ''}</td>
        <td class="col-actions"><div class="row-actions"><button class="btn btn-ghost btn-icon btn-del" data-netdel="${n.name}" aria-label="Eliminar red ${n.name}" ${n.sys || n.n ? raw('disabled') : ''}>${ico('trash')}</button></div></td></tr>`;
    });
    return h`${head}<div class="view-body">${lost() ? lostBanner() : ''}<div class="table-wrap"><table><caption class="sr-only">Lista de redes</caption><thead><tr><th scope="col" class="cell-name">Nombre</th><th scope="col" class="col-subnet">Subred</th><th scope="col" class="num">Contenedores</th><th scope="col"><span class="sr-only">Tipo</span></th><th scope="col" class="col-actions"><span class="sr-only">Acciones</span></th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted" style="font-size:var(--text-xs)">Las redes del sistema y las que tienen contenedores conectados no se pueden eliminar.</p></div>`;
  }

  /* ---------- vista: stacks ---------- */
  function viewStacks() {
    var head = pageHead({ title: 'Stacks (Compose)', count: D.stacks.length, primary: h`<a class="btn btn-primary" href="#stack-edit">${ico('file')}Abrir archivo Compose</a>` });
    if (S.err && !lost()) return h`${head}<div class="view-body">${errorPanel()}</div>`;
    if (!S.compose) return h`${head}<div class="view-body">${composeMissing()}</div>`;
    if (S.ui === 'loading') return h`${head}<div class="view-body"><div class="card card-pad"><span class="skeleton" style="width:160px;margin-bottom:14px"></span><span class="skeleton" style="width:100%;margin-bottom:10px"></span><span class="skeleton" style="width:90%;margin-bottom:10px"></span><span class="skeleton" style="width:70%"></span></div></div>`;
    if (S.ui === 'empty') return h`${head}<div class="view-body">${emptyState('grid', 'No se detectó ningún stack', 'DockInng encuentra los stacks a partir de los contenedores creados con docker compose. Abre un archivo Compose para levantar el primero.', h`<a class="btn btn-primary" href="#stack-edit">${ico('file')}Abrir archivo Compose</a>`)}</div>`;
    var colors = { running: 'var(--status-running)', paused: 'var(--status-paused)', restarting: 'var(--status-restarting)' };
    var cards = D.stacks.map(function (s) {
      var okN = s.services.filter(function (x) { return x[2] === 'running'; }).length, n = s.services.length;
      return h`<section class="card stack-card" aria-label="Stack ${s.name}"><header><div><h3>${s.name}</h3><div class="path">${s.path}</div></div><span class="spacer"><span class="health" role="img" aria-label="${okN} de ${n} servicios en ejecución">${s.services.map(function (x) { return h`<i style="flex:1;background:${colors[x[2]] || 'var(--status-exited)'}"></i>`; })}</span><span class="muted" style="min-width:84px;text-align:right">${okN} de ${n} activos</span>
        <a class="btn btn-secondary btn-sm" href="#stack-edit?stack=${encodeURIComponent(s.name)}">${ico('edit', 'sm')}Editar</a><button class="btn btn-secondary btn-sm" data-stack="up" data-n="${s.name}">${ico('play', 'sm fill')}Levantar</button><button class="btn btn-secondary btn-sm" data-stack="restart" data-n="${s.name}">${ico('rotate', 'sm')}Reiniciar</button><span class="sep" aria-hidden="true"></span><button class="btn btn-outline-destructive btn-sm" data-stack="down" data-n="${s.name}">${ico('square', 'sm fill')}Bajar…</button></span></header>
        ${s.services.map(function (x) { return h`<div class="svc"><b>${x[0]}</b><span>${statusBadge(x[2])}</span><span class="mono svc-image" title="${x[1]}">${x[1]}</span><span class="muted" style="text-align:right" title="Réplicas en ejecución">${x[3]}</span></div>`; })}</section>`;
    });
    return h`${head}<div class="view-body">${lost() ? lostBanner() : ''}${cards}</div>`;
  }

  /* ---------- vista: nuevo contenedor ---------- */
  function initForm() {
    var img = P('image') || '';
    S.form = { image: img, name: '', restart: 'unless-stopped', net: 'bridge',
      ports: [{ h: '8080', c: '80', p: 'tcp' }], vols: [{ h: './datos', c: '/var/lib/postgresql/data' }], env: [{ k: 'POSTGRES_PASSWORD', v: '' }], err: {} };
    if (P('remote') === '1') S.ctx = 'prod';
  }
  function setPath(o, path, val) { var p = path.split('.'); for (var i = 0; i < p.length - 1; i++) o = o[p[i]]; o[p[p.length - 1]] = val; }
  function portOwner(hp) { var f = D.containers.filter(function (c) { return c.status === 'running' && c.ports.split(/[, ]+/).some(function (x) { return x.split(':')[0] === String(hp); }); })[0]; return f && f.name; }
  function viewCreate() {
    var f = S.form, c = conn();
    var head = pageHead({ title: 'Nuevo contenedor', back: h`<div style="width:100%"><a class="crumb" href="#containers">${ico('back', 'sm')}Contenedores</a></div>` });
    if (S.err && !lost()) return h`${head}<div class="view-body">${errorPanel()}</div>`;
    var relRemote = c.remote ? f.vols.filter(function (v) { return v.h && !/^\//.test(v.h) && /^[.~]/.test(v.h); }) : [];
    var e = f.err;
    return h`${head}<div class="view-body">${lost() ? lostBanner() : ''}<form class="form" id="createForm" novalidate>
      <section class="card form-section"><h2>Imagen y nombre</h2><div class="form-body"><div class="f-cols">
        <div class="f-row"><label for="fImage">Imagen</label><input class="input" id="fImage" data-bind="image" value="${f.image}" placeholder="postgres:16.4" list="imgs" aria-invalid="${'' + !!e.image}" ${e.image ? raw('aria-describedby="eImage"') : ''}><datalist id="imgs">${D.images.map(function (i) { return h`<option value="${i.repo + ':' + i.tag}">`; })}</datalist>${e.image ? h`<span class="f-error" id="eImage">${ico('alert', 'sm')}${e.image}</span>` : h`<span class="f-hint">Elige una imagen local o escribe otra: si no existe, se descargará.</span>`}</div>
        <div class="f-row"><label for="fName">Nombre <span class="muted">(opcional)</span></label><input class="input" id="fName" data-bind="name" value="${f.name}" placeholder="base-datos-pruebas" aria-invalid="${'' + !!e.name}" ${e.name ? raw('aria-describedby="eName"') : ''}>${e.name ? h`<span class="f-error" id="eName">${ico('alert', 'sm')}${e.name}</span>` : h`<span class="f-hint">Letras, números, punto, guion y guion bajo.</span>`}</div></div></div></section>
      <section class="card form-section"><h2>Puertos</h2><div class="form-body">${f.ports.map(function (p, i) {
        var own = portOwner(p.h);
        return h`<div class="rep"><div><label class="sr-only" for="pH${i}">Puerto del equipo ${i + 1}</label><input class="input" id="pH${i}" data-bind="ports.${i}.h" value="${p.h}" placeholder="8080" inputmode="numeric" aria-invalid="${'' + !!own}"></div><div><label class="sr-only" for="pC${i}">Puerto del contenedor ${i + 1}</label><input class="input" id="pC${i}" data-bind="ports.${i}.c" value="${p.c}" placeholder="80" inputmode="numeric"></div><div><label class="sr-only" for="pP${i}">Protocolo ${i + 1}</label><select class="select" id="pP${i}" data-bind="ports.${i}.p"><option ${p.p === 'tcp' ? raw('selected') : ''}>tcp</option><option ${p.p === 'udp' ? raw('selected') : ''}>udp</option></select></div><button type="button" class="btn btn-ghost btn-icon" data-rm="ports.${i}" aria-label="Quitar puerto ${i + 1}">${ico('x')}</button>${own ? h`<span class="f-error" style="grid-column:1/-1">${ico('alert', 'sm')}El puerto ${p.h} del equipo ya lo usa ${own}.</span>` : ''}</div>`;
      })}<div><button type="button" class="btn btn-secondary btn-sm" data-add="ports">${ico('plus', 'sm')}Añadir puerto</button></div></div></section>
      <section class="card form-section"><h2>Volúmenes</h2><div class="form-body">${relRemote.length ? alertBox('warn', 'warn', 'Ruta relativa en una conexión remota', 'Con «' + c.name + '» activa, «' + relRemote[0].h + '» se resuelve en el servidor, no en tu equipo. Usa una ruta absoluta del servidor o un volumen con nombre.') : ''}${f.vols.map(function (v, i) {
        return h`<div class="rep two"><div><label class="sr-only" for="vH${i}">Origen (volumen o ruta) ${i + 1}</label><input class="input mono" id="vH${i}" data-bind="vols.${i}.h" value="${v.h}" placeholder="datos-pg o /srv/datos"></div><div><label class="sr-only" for="vC${i}">Ruta en el contenedor ${i + 1}</label><input class="input mono" id="vC${i}" data-bind="vols.${i}.c" value="${v.c}" placeholder="/var/lib/postgresql/data"></div><button type="button" class="btn btn-ghost btn-icon" data-rm="vols.${i}" aria-label="Quitar volumen ${i + 1}">${ico('x')}</button></div>`;
      })}<div><button type="button" class="btn btn-secondary btn-sm" data-add="vols">${ico('plus', 'sm')}Añadir volumen</button></div></div></section>
      <section class="card form-section"><h2>Variables de entorno</h2><div class="form-body">${f.env.map(function (v, i) {
        return h`<div class="rep two"><div><label class="sr-only" for="eK${i}">Variable ${i + 1}</label><input class="input mono" id="eK${i}" data-bind="env.${i}.k" value="${v.k}" placeholder="CLAVE"></div><div><label class="sr-only" for="eV${i}">Valor ${i + 1}</label><input class="input mono" id="eV${i}" data-bind="env.${i}.v" value="${v.v}" placeholder="valor"></div><button type="button" class="btn btn-ghost btn-icon" data-rm="env.${i}" aria-label="Quitar variable ${i + 1}">${ico('x')}</button></div>`;
      })}<div><button type="button" class="btn btn-secondary btn-sm" data-add="env">${ico('plus', 'sm')}Añadir variable</button></div></div></section>
      <section class="card form-section"><h2>Red y reinicio</h2><div class="form-body"><div class="f-cols"><div class="f-row"><label for="fNet">Red</label><select class="select" id="fNet" data-bind="net">${D.networks.map(function (n) { return h`<option ${f.net === n.name ? raw('selected') : ''}>${n.name}</option>`; })}</select></div>
        <div class="f-row"><span class="f-label" id="lRestart">Política de reinicio</span><div class="segmented" role="group" aria-labelledby="lRestart" style="justify-self:start">${['no', 'always', 'unless-stopped', 'on-failure'].map(function (r) { return h`<button type="button" data-restart="${r}" aria-pressed="${'' + (f.restart === r)}">${r}</button>`; })}</div></div></div></div></section>
      <div class="form-actions"><button type="submit" class="btn btn-primary" data-create="start">${ico('play', 'fill')}Crear e iniciar</button><button type="submit" class="btn btn-secondary" data-create="only">Solo crear</button><a class="btn btn-ghost" href="#containers">Cancelar</a></div></form></div>`;
  }
  function submitCreate(mode) {
    var f = S.form; f.err = {};
    if (!f.image.trim()) f.err.image = 'Indica la imagen que se va a ejecutar.';
    if (f.name && !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(f.name)) f.err.name = 'Solo letras, números, punto, guion y guion bajo; debe empezar por letra o número.';
    if (f.name && byName(f.name)) f.err.name = 'Ya existe un contenedor llamado ' + f.name + '.';
    if (Object.keys(f.err).length) { render(); var first = $('[aria-invalid="true"]', main); if (first) first.focus(); toast('Revisa el formulario', 'warn', 'Hay campos con errores.'); return; }
    var nm = f.name || f.image.split('/').pop().split(':')[0] + '-1';
    D.containers.unshift({ name: nm, image: f.image, id: Math.random().toString(16).slice(2, 14).padEnd(12, '0'), status: mode === 'start' ? 'running' : 'created', ports: f.ports[0] ? f.ports[0].h + ':' + f.ports[0].c : '—', cpu: 0.3, mem: mode === 'start' ? 18 : 0, stack: null, up: mode === 'start' ? 'hace un momento' : 'sin iniciar', vols: [], bind: [] });
    toast(mode === 'start' ? nm + ' creado e iniciado' : nm + ' creado'); location.hash = '#containers';
  }

  /* ---------- vista: descargar imagen (pull) con progreso por capa ---------- */
  var LAYERS = [['a3b8c1d92e07', 30.4], ['5f1e9a7b3c42', 12.1], ['9d02c6e8f1a5', 88.7], ['c47b2e0d9a13', 5.6], ['e18f4a6b7c90', 41.2]];
  function initPull() {
    var st = P('pull') || 'idle';
    S.pull = { ref: P('image') || 'postgres:16.4', st: st === 'running' ? 'pulling' : st, pct: LAYERS.map(function () { return 0; }) };
    if (st === 'running') S.pull.pct = [100, 100, 62, 18, 0];
    if (st === 'done') S.pull.pct = LAYERS.map(function () { return 100; });
    if (st === 'canceled') S.pull.pct = [100, 100, 34, 0, 0];
    if (st === 'error') { S.pull.pct = [100, 100, 12, 0, 0]; }
  }
  function layerRows() {
    var p = S.pull;
    return LAYERS.map(function (l, i) {
      var v = Math.round(p.pct[i]), done = v >= 100;
      var lbl = done ? 'Completa' : v === 0 ? (p.st === 'pulling' ? 'En espera' : 'No iniciada') : 'Descargando';
      return h`<div class="layer"><span class="mono">${l[0]}</span><div class="progress ${done ? 'is-done' : ''}" role="progressbar" aria-label="Capa ${l[0]}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${v}"><i style="width:${v}%"></i></div><span class="mono muted">${(l[1] * v / 100).toFixed(1)} / ${l[1]} MB</span><span class="${done ? '' : 'muted'}">${done ? h`${ico('check', 'sm')} ` : ''}${lbl}</span></div>`;
    });
  }
  function viewPull() {
    var p = S.pull, tot = LAYERS.reduce(function (a, l, i) { return a + l[1] * p.pct[i] / 100; }, 0), all = LAYERS.reduce(function (a, l) { return a + l[1]; }, 0);
    var head = pageHead({ title: 'Descargar imagen', back: h`<div style="width:100%"><a class="crumb" href="#images">${ico('back', 'sm')}Imágenes</a></div>` });
    if (S.err && !lost()) return h`${head}<div class="view-body">${errorPanel()}</div>`;
    var pulling = p.st === 'pulling';
    return h`${head}<div class="toolbar"><label class="field" style="flex:1 1 320px;max-width:520px">${ico('download')}<input class="input" id="pullRef" data-bind-pull value="${p.ref}" aria-label="Imagen a descargar" placeholder="registro/nombre:etiqueta" ${pulling ? raw('disabled') : ''}></label>
      ${pulling ? h`<button class="btn btn-secondary" data-pull="cancel">${ico('x')}Cancelar descarga</button>` : h`<button class="btn btn-primary" data-pull="start">${ico('download')}${p.st === 'idle' ? 'Descargar' : 'Descargar de nuevo'}</button>`}</div>
      <div class="view-body">${lost() ? lostBanner() : ''}
      ${p.st === 'canceled' ? alertBox('info', 'info', 'Descarga cancelada', 'Las capas ya descargadas se conservan en caché: si vuelves a descargar, se reanuda desde ahí.') : ''}
      ${p.st === 'error' ? alertBox('error', 'alert', 'No se pudo descargar ' + p.ref, 'El registro respondió 429 (demasiadas peticiones). Espera unos minutos o inicia sesión en el registro.', h`<button class="btn btn-secondary btn-sm" data-pull="start">${ico('refresh', 'sm')}Reintentar</button>`) : ''}
      ${p.st === 'done' ? alertBox('info', 'check', p.ref + ' descargada', 'Ya puedes crear un contenedor con esta imagen.', h`<a class="btn btn-primary btn-sm" href="#create?image=${encodeURIComponent(p.ref)}">${ico('play', 'sm fill')}Ejecutar</a>`) : ''}
      ${p.st === 'idle' ? emptyState('download', 'Elige qué imagen descargar', 'Escribe el nombre con su etiqueta. Verás el avance de cada capa y podrás cancelar en cualquier momento.', '') : h`<section class="card" aria-label="Progreso por capa"><header style="display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)"><b class="mono">${p.ref}</b><span class="muted" style="margin-left:auto" id="pullTotal" aria-live="off">${tot.toFixed(1)} de ${all.toFixed(1)} MB</span></header><div id="layers">${layerRows()}</div></section>`}</div>`;
  }
  function tickPull() {
    var p = S.pull; if (p.st !== 'pulling') return;
    var i = p.pct.findIndex(function (v) { return v < 100; });
    if (i < 0) { p.st = 'done'; toast(p.ref + ' descargada'); render(); return; }
    p.pct[i] = Math.min(100, p.pct[i] + 7 + Math.random() * 9);
    if (i + 1 < p.pct.length && p.pct[i] > 40) p.pct[i + 1] = Math.min(100, p.pct[i + 1] + 4);
    var box = $('#layers'); if (box) box.innerHTML = esc(layerRows());
    var tot = LAYERS.reduce(function (a, l, k) { return a + l[1] * p.pct[k] / 100; }, 0), t = $('#pullTotal'); if (t) t.textContent = tot.toFixed(1) + ' de ' + LAYERS.reduce(function (a, l) { return a + l[1]; }, 0).toFixed(1) + ' MB';
  }

  /* ---------- vista: editor de stack (YAML + .env, validación en vivo) ---------- */
  function validate(yaml, env) {
    var out = [], lines = yaml.split('\n'), bad = {}, svcs = [], inServices = false, cur = null;
    lines.forEach(function (ln, i) {
      if (/\t/.test(ln)) { out.push({ l: 'bad', line: i + 1, msg: 'Línea ' + (i + 1) + ': hay tabuladores; YAML exige espacios para indentar.' }); bad[i + 1] = 1; }
      if (/^services:\s*$/.test(ln)) inServices = true; else if (/^\S/.test(ln)) inServices = false;
      var m = ln.match(/^ {2}([A-Za-z0-9_.-]+):\s*$/);
      if (inServices && m) { cur = { name: m[1], line: i + 1, image: false }; svcs.push(cur); }
      if (cur && /^ {4}(image|build):/.test(ln)) cur.image = true;
    });
    if (!/^services:/m.test(yaml)) out.push({ l: 'bad', line: 0, msg: 'Falta la sección «services:».' });
    svcs.forEach(function (s) { if (!s.image) { out.push({ l: 'bad', line: s.line, msg: 'El servicio «' + s.name + '» necesita image o build (línea ' + s.line + ').' }); bad[s.line] = 1; } });
    var defined = {}; env.split('\n').forEach(function (ln) { var m = ln.match(/^([A-Za-z_][A-Za-z0-9_]*)=/); if (m) defined[m[1]] = 1; });
    var seen = {}; (yaml.match(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g) || []).forEach(function (v) { var k = v.slice(2); if (!defined[k] && !seen[k]) { seen[k] = 1; out.push({ l: 'warn', line: 0, msg: 'La variable ' + k + ' no está definida en .env.' }); } });
    if (!out.some(function (o) { return o.l === 'bad'; })) out.unshift({ l: 'ok', line: 0, msg: 'Sintaxis correcta: ' + svcs.length + ' servicios.' });
    return { list: out, bad: bad, hasBad: out.some(function (o) { return o.l === 'bad'; }), n: yaml.split('\n').length };
  }
  function checksHtml(v) {
    return h`${v.list.map(function (o) { return h`<li><span class="${o.l}">${ico(o.l === 'ok' ? 'check' : o.l === 'warn' ? 'warn' : 'xcircle', 'sm')}</span><span>${o.msg}</span></li>`; })}`;
  }
  function gutterHtml(v) { var s = []; for (var i = 1; i <= v.n; i++) s.push(v.bad[i] ? h`<span class="bad">${i}</span>` : String(i)); return h`${s.map(function (x, i) { return h`${x}${i < s.length - 1 ? '\n' : ''}`; })}`; }
  var UP = ['postgres', 'redis', 'api', 'web'];
  function upRows() {
    var u = S.up;
    return h`${UP.map(function (s, i) {
      var v = u.p[i], st = v >= 100 ? 'Iniciado' : v >= 70 ? 'Creando contenedor' : v > 0 ? 'Descargando imagen' : 'En espera';
      return h`<div class="up-row"><b>${s}</b><div class="progress ${v >= 100 ? 'is-done' : ''}" role="progressbar" aria-label="${s}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(v)}"><i style="width:${v}%"></i></div><span>${v >= 100 ? statusBadge('running') : h`<span class="muted">${v > 0 ? h`${ico('loader', 'sm spin')} ` : ''}${st}</span>`}</span></div>`;
    })}`;
  }
  function viewStackEdit() {
    var name = P('stack') || 'tienda-nuevo';
    if (S.yaml == null) { S.yaml = P('yaml') === 'broken' ? D.brokenYaml : D.sampleYaml; S.env = D.sampleEnv; S.file = P('file') === 'env' ? 'env' : 'yaml'; }
    var v = validate(S.yaml, S.env), up = S.up;
    var head = pageHead({ title: 'Editar stack ' + name, back: h`<div style="width:100%"><a class="crumb" href="#stacks">${ico('back', 'sm')}Stacks</a></div>`,
      secondary: h`<button class="btn btn-secondary" data-act="savestack">${ico('check')}Guardar</button>`,
      primary: h`<button class="btn btn-primary" id="upBtn" data-run="up" ${v.hasBad || (up && up.st === 'running') ? raw('disabled') : ''}>${ico('play', 'fill')}Levantar</button>` });
    if (S.err && !lost()) return h`${head}<div class="view-body">${errorPanel()}</div>`;
    if (!S.compose) return h`${head}<div class="view-body">${composeMissing()}</div>`;
    var txt = S.file === 'yaml' ? S.yaml : S.env, vv = S.file === 'yaml' ? v : { n: S.env.split('\n').length, bad: {} };
    return h`${head}<div class="view-body">${lost() ? lostBanner() : ''}<div class="toolbar" style="padding-bottom:0"><div class="segmented" role="group" aria-label="Archivo"><button data-file="yaml" aria-pressed="${'' + (S.file === 'yaml')}">compose.yaml</button><button data-file="env" aria-pressed="${'' + (S.file === 'env')}">.env</button></div><span class="muted">~/proyectos/${name}/</span></div>
      <div class="editor"><div class="code-wrap"><div class="gutter" id="gutter" aria-hidden="true">${gutterHtml(vv)}</div><label class="sr-only" for="editor">Contenido de ${S.file === 'yaml' ? 'compose.yaml' : '.env'}</label><textarea class="textarea" id="editor" spellcheck="false" wrap="off" rows="18">${txt}</textarea></div>
      <section class="card" aria-label="Validación"><h2 class="section-title" style="padding:12px 14px 0">Validación en vivo</h2><ul class="checks" id="checks" aria-live="polite">${checksHtml(v)}</ul></section></div>
      <section class="card" id="upcard" ${up ? '' : raw('hidden')} aria-label="Progreso de levantar el stack"><header style="display:flex;gap:12px;align-items:center;padding:12px 16px;border-bottom:1px solid var(--border)"><b>docker compose up</b><span class="muted" id="upState" style="margin-left:auto">${up && up.st === 'done' ? 'Stack levantado' : 'Levantando…'}</span></header><div id="upbox">${up ? upRows() : ''}</div></section></div>`;
  }
  function tickUp() {
    var u = S.up; if (!u || u.st !== 'running') return;
    var i = u.p.findIndex(function (v) { return v < 100; });
    if (i < 0) { u.st = 'done'; toast('Stack levantado', 'ok', UP.length + ' servicios en ejecución'); var st = $('#upState'); if (st) st.textContent = 'Stack levantado'; var b = $('#upBtn'); if (b) b.disabled = false; return; }
    u.p[i] = Math.min(100, u.p[i] + 14 + Math.random() * 12);
    var box = $('#upbox'); if (box) box.innerHTML = esc(upRows());
  }

  /* ---------- vista: nueva conexión (SSH / TLS) con "Probar conexión" ---------- */
  function initConn() { S.conn = { type: 'ssh', name: '', host: 'staging-lab', port: '22', user: 'ops', key: '~/.ssh/config (alias)', test: P('test') || null, fixed: !!P('test') }; }
  function viewConnNew() {
    var c = S.conn, ssh = c.type === 'ssh';
    var head = pageHead({ title: 'Nueva conexión', back: h`<div style="width:100%"><a class="crumb" href="#settings">${ico('back', 'sm')}Configuración</a></div>` });
    var res = '';
    if (c.test === 'testing') res = h`<div class="alert alert-info" role="status">${ico('loader', 'spin')}<div><b>Probando conexión…</b><p>Comprobando red, autenticación y socket remoto.</p></div></div>`;
    else if (c.test === 'ok') res = alertBox('info', 'check', 'Conexión correcta', 'Docker 26.1.4 · API 1.45 · 8 contenedores en ejecución. Puedes guardarla.');
    else if (c.test === 'fail') res = alertBox('error', 'alert', 'No se pudo conectar', ssh ? 'Permission denied (publickey). El servidor no aceptó la llave. Comprueba el alias en ~/.ssh/config y que la llave esté cargada (ssh-add).' : 'El certificado del servidor no coincide con la CA indicada.');
    return h`${head}<div class="view-body"><form class="form" id="connForm" novalidate>
      <section class="card form-section"><h2>Datos de la conexión</h2><div class="form-body">
        <div class="f-row"><span class="f-label" id="lType">Tipo</span><div class="segmented" role="group" aria-labelledby="lType" style="justify-self:start"><button type="button" data-ctype="ssh" aria-pressed="${'' + ssh}">SSH</button><button type="button" data-ctype="tls" aria-pressed="${'' + !ssh}">TLS (tcp://)</button></div></div>
        <div class="f-cols"><div class="f-row"><label for="cName">Nombre</label><input class="input" id="cName" data-cbind="name" value="${c.name}" placeholder="prod-hetzner"></div>
          <div class="f-row"><label for="cHost">${ssh ? 'Host o alias de ~/.ssh/config' : 'Host'}</label><input class="input" id="cHost" data-cbind="host" value="${c.host}"></div>
          <div class="f-row"><label for="cPort">Puerto</label><input class="input" id="cPort" data-cbind="port" value="${ssh ? c.port : '2376'}" inputmode="numeric"></div>
          ${ssh ? h`<div class="f-row"><label for="cUser">Usuario</label><input class="input" id="cUser" data-cbind="user" value="${c.user}"></div>` : h`<div class="f-row"><label for="cCa">Certificado CA</label><input class="input mono" id="cCa" value="~/.docker/ca.pem"></div>`}</div>
        ${ssh ? h`<div class="f-row"><label for="cKey">Llave</label><input class="input mono" id="cKey" data-cbind="key" value="${c.key}"><span class="f-hint">Recomendado: usar el alias de ~/.ssh/config, que ya sabe qué llave usar.</span></div>` : h`<div class="f-cols"><div class="f-row"><label for="cCert">Certificado cliente</label><input class="input mono" id="cCert" value="~/.docker/cert.pem"></div><div class="f-row"><label for="cKeyT">Llave cliente</label><input class="input mono" id="cKeyT" value="~/.docker/key.pem"></div></div>`}
      </div></section>
      <div id="connRes" aria-live="polite">${res}</div>
      <div class="form-actions"><button type="button" class="btn btn-secondary" data-conn="test" ${c.test === 'testing' ? raw('disabled') : ''}>${ico('zap')}Probar conexión</button><button type="submit" class="btn btn-primary" ${c.test === 'fail' ? raw('disabled') : ''}>${ico('check')}Guardar conexión</button><a class="btn btn-ghost" href="#settings">Cancelar</a>${c.test === null ? h`<span class="muted" style="align-self:center">Sin probar todavía.</span>` : ''}</div></form></div>`;
  }

  /* ---------- vista: configuración ---------- */
  function viewSettings() {
    var head = pageHead({ title: 'Configuración', count: D.connections.length + ' conexiones', primary: h`<a class="btn btn-primary" href="#conn-new">${ico('plus')}Añadir conexión</a>` });
    var conns = D.connections.map(function (c) {
      var act = c.id === S.ctx && !(S.err && c.id === 'staging' && false);
      return h`<div class="conn${act ? ' is-active' : ''}"><span class="conn-ico">${ico(c.icon)}</span><div class="grow"><b>${c.name}</b> ${act ? h`<span class="tag tag-brand">Activa</span>` : c.ok ? '' : h`<span class="tag" style="color:var(--status-dead)">${ico('alert', 'sm')}Sin respuesta</span>`}<small>${c.sub}</small></div>${act ? '' : h`<button class="btn btn-secondary btn-sm" data-ctx="${c.id}">Conectar</button>`}<button class="btn btn-ghost btn-icon btn-sm" aria-label="Más opciones de ${c.name}">${ico('dots')}</button></div>`;
    });
    var dark = currentTheme() === 'dark';
    var levels = [['Iniciar, detener, reiniciar, ver logs', 'libre', 'Libre', 'Allow: se ejecuta al instante, sin diálogo.', 'check'],
      ['Eliminar contenedor, imagen o red', 'confirmar', 'Confirmar', 'Confirm: diálogo con lo que se verá afectado.', 'warn'],
      ['Eliminar volumen, volúmenes sin usar, bajar stack', 'confirmar', 'Confirmar con nombre', 'Confirm reforzado: hay que escribir el nombre o ELIMINAR. Exige a una persona incluso con «omitir confirmaciones».', 'warn'],
      ['Limpiar todo el sistema (system prune)', 'bloqueado', 'Bloqueado', 'Deny · Forbidden: nunca se ejecuta, ni con confirmación.', 'ban']];
    var lv = levels.map(function (l) { return h`<div class="setting-row"><div class="grow"><b>${l[0]}</b><small>${l[3]}</small></div><span class="level level-${l[1]}">${ico(l[4], 'sm')}${l[2]}</span></div>`; });
    var previews = [['ui', 'empty', 'Estado vacío'], ['ui', 'loading', 'Esqueleto de carga'], ['err', 'error', 'Error: sin permiso al socket'], ['err', 'daemon', 'Error: daemon apagado'], ['err', 'ssh', 'Error: SSH'], ['err', 'lost', 'Desconectado durante el uso'], ['compose', 'missing', 'Compose no instalado'], ['policy', 'denied', 'Rechazo inesperado del backend'], ['toast', 'ok', 'Toast correcto'], ['toast', 'warn', 'Toast aviso'], ['toast', 'err', 'Toast error']];
    return h`${head}<div class="view-body">${S.err ? alertBox('error', 'alert', 'Sin conexión con el motor', 'Puedes editar las conexiones desde aquí; el resto de vistas muestran el diagnóstico.') : ''}
      <section aria-labelledby="sConn"><h2 class="section-title" id="sConn">Conexiones</h2><div class="card">${conns}</div></section>
      <div class="grid-2"><section aria-labelledby="sApp"><h2 class="section-title" id="sApp">Apariencia y datos</h2><div class="card"><div class="setting-row"><div class="grow"><b>Tema</b><small>Se recuerda entre sesiones.</small></div><div class="segmented" role="group" aria-label="Tema"><button data-theme="dark" aria-pressed="${'' + dark}">${ico('moon', 'sm')}Oscuro</button><button data-theme="light" aria-pressed="${'' + !dark}">${ico('sun', 'sm')}Claro</button></div></div>
      <div class="setting-row"><div class="grow"><b>Datos en tiempo real</b><small>La app se actualiza con los eventos del motor de Docker, sin sondear.</small></div><span class="tag">Automático</span></div>
      <div class="setting-row"><div class="grow"><b>Respaldo: sondeo cada 5 s</b><small>Solo si los eventos fallan (por ejemplo, a través de algunos túneles SSH).</small></div><input type="checkbox" class="switch" role="switch" aria-label="Respaldo: sondeo cada 5 segundos"></div></div></section>
      <section aria-labelledby="sSec"><h2 class="section-title" id="sSec">Niveles de seguridad</h2><div class="card">${lv}</div><p class="muted" style="font-size:var(--text-xs);margin-top:6px">El caso «Denegado sin interacción» de la política solo existe en la línea de comandos; en la interfaz gráfica no aplica.</p></section></div>
      <section aria-labelledby="sRisk"><h2 class="section-title" id="sRisk">Acción prohibida (demostración)</h2><div class="card"><div class="setting-row"><div class="grow"><b>Limpiar todo el sistema</b><small>Equivale a <code>docker system prune</code>. Se muestra solo para explicar por qué no está disponible: borra contenedores, redes, imágenes y caché de una sola vez, sin poder revisar qué se pierde. Nunca se ejecuta.</small></div><button class="btn btn-secondary btn-blocked" data-act="blocked" aria-haspopup="dialog">${ico('ban')}Limpiar todo el sistema</button></div></div></section>
      <section aria-labelledby="sPrev"><h2 class="section-title" id="sPrev">Vista previa de estados <span class="tag">Solo plantilla</span></h2><div class="card card-pad" style="display:flex;gap:8px;flex-wrap:wrap">${previews.map(function (p) { return h`<button class="btn btn-secondary btn-sm" data-prev="${p[0]}:${p[1]}">${p[2]}</button>`; })}<a class="btn btn-secondary btn-sm" href="#create">Nuevo contenedor</a><a class="btn btn-secondary btn-sm" href="#pull?pull=running">Descarga en curso</a><a class="btn btn-secondary btn-sm" href="#stack-edit?yaml=broken&run=up">Editor con errores</a><a class="btn btn-secondary btn-sm" href="#conn-new?test=fail">Prueba de conexión fallida</a></div></section></div>`;
  }

  /* ---------- render principal ---------- */
  var VIEWS = { containers: viewContainers, detail: viewDetail, create: viewCreate, images: viewImages, pull: viewPull, volumes: viewVolumes, networks: viewNetworks, stacks: viewStacks, 'stack-edit': viewStackEdit, settings: viewSettings, 'conn-new': viewConnNew };
  function render() {
    clearTimers();
    var fk = S.fk || focusKey(document.activeElement); S.fk = null;
    var out = VIEWS[S.view]();
    main.innerHTML = '<div class="view">' + esc(out) + '</div>';
    var all = $('#selAll'); if (all) { var l = D.containers.filter(matches); all.indeterminate = l.some(function (c) { return S.sel[c.name]; }) && !l.every(function (c) { return S.sel[c.name]; }); }
    if (lost()) $$('.view-actions .btn, .row-actions .btn, .bulkbar .btn, .form-actions .btn, [data-stack], [data-pull]', main).forEach(function (b) { b.setAttribute('aria-disabled', 'true'); b.classList.add('is-locked'); if (b.tagName === 'BUTTON') b.disabled = true; });
    buildNav(); updateEngine(); afterView();
    restoreFocus(fk);
    document.title = (D.TITLES[S.view] || 'DockInng') + ' · DockInng';
  }
  function buildNav() {
    var run = D.containers.filter(function (c) { return c.status === 'running'; }).length;
    var counts = { containers: run + '/' + D.containers.length, images: D.images.length, volumes: D.volumes.length, networks: D.networks.length, stacks: D.stacks.length };
    var cur = D.NAV_OF[S.view];
    var item = function (n) { return h`<a class="nav-item" href="#${n[0]}" data-tip="${n[1]}" aria-label="${n[1]}" ${cur === n[0] ? raw('aria-current="page"') : ''}>${ico(n[2])}<span class="nav-text">${n[1]}</span>${counts[n[0]] != null ? h`<span class="badge-count" aria-hidden="true">${counts[n[0]]}</span>` : ''}</a>`; };
    $('#nav').innerHTML = esc(h`<div class="nav-label">Docker</div>${D.NAV.slice(0, 5).map(item)}<div class="nav-label">Aplicación</div>${item(D.NAV[5])}`);
  }
  function updateEngine() {
    var c = conn(), bad = !!S.err, e = $('#engine');
    e.classList.toggle('is-error', bad);
    var title = S.err === 'lost' ? 'Conexión perdida' : bad ? 'Sin conexión' : 'Motor conectado', sub = bad ? c.sub : (c.ver || 'Docker 27.3.1');
    $('#engineTitle').textContent = title; $('#engineSub').textContent = sub;
    e.setAttribute('aria-label', title + '. ' + sub + (bad ? '' : '. Conexión ' + c.name));
    $('.engine-ico', e).innerHTML = ico(bad ? 'x' : 'check').s;
    $('#ctxName').textContent = c.name; $('#ctxSub').textContent = c.sub;
    $('#ctxBtn').setAttribute('aria-label', 'Cambiar de conexión. Actual: ' + c.name);
    $('.ctx-btn > .i').innerHTML = '<use href="#i-' + c.icon + '"/>';
  }
  function afterView() {
    var v = S.view;
    if (v === 'detail') {
      var box = $('#logbox'); if (box) box.scrollTop = box.scrollHeight;
      if (S.tab === 'logs') {
        var k = 0;
        timers.push(setInterval(function () {   /* datos en vivo: no dependen de prefers-reduced-motion */
          var f = $('#follow'), b = $('#logbox'); if (!f || !f.checked || !b || lost()) return;
          var m = D.liveLogs[k++ % D.liveLogs.length], lp = logData[logData.length - 1].ts.split(/[:.]/).map(Number);
          var l = { ts: fmtT(lp[0] * 3600 + lp[1] * 60 + lp[2] + 2, (120 + k * 173) % 1000), lvl: m[0], msg: m[1] };
          logData.push(l); if (logData.length > 300) logData.shift();
          if (logMatch(l)) { var tmp = document.createElement('div'); tmp.innerHTML = esc(logLine(l)); b.appendChild(tmp.firstChild); while (b.children.length > 300) b.removeChild(b.firstChild); b.scrollTop = b.scrollHeight; }
        }, 2200));
      }
      if (S.tab === 'stats') {
        timers.push(setInterval(function () {
          cpuSeries.push(Math.max(2, Math.min(60, cpuSeries[59] + (Math.random() - 0.5) * 8))); cpuSeries.shift();
          memSeries.push(Math.max(30, Math.min(70, memSeries[59] + (Math.random() - 0.45) * 1.2))); memSeries.shift();
          [['cpuChart', cpuSeries, 'cpuVal', cpuSeries[59].toFixed(1) + '%'], ['memChart', memSeries, 'memVal', Math.round(memSeries[59] * 5.12) + ' MiB']].forEach(function (a) {
            var svg = $('#' + a[0]); if (!svg) return;
            var line = a[1].map(function (x, i) { return (i * 300 / 59).toFixed(1) + ',' + (96 - 4 - x / 100 * 88).toFixed(1); }).join(' ');
            $('.line', svg).setAttribute('points', line); $('.area', svg).setAttribute('points', '0,96 ' + line + ' 300,96'); $('#' + a[2]).textContent = a[3];
          });
        }, 1500));
      }
      if (S.tab === 'terminal' && params.get('focus') !== '0') { var t = $('#termIn'); if (t && !document.querySelector('dialog[open]')) t.focus({ preventScroll: true }); }
    }
    if (v === 'pull' && S.pull && S.pull.st === 'pulling') timers.push(setInterval(tickPull, 450));
    if (v === 'stack-edit' && S.up && S.up.st === 'running') timers.push(setInterval(tickUp, 700));
    if (v === 'conn-new' && S.conn && S.conn.test === 'testing' && !S.conn.fixed) timers.push(setTimeout(function () { S.conn.test = /fail/i.test(S.conn.host) ? 'fail' : 'ok'; render(); }, 1400));
  }

  /* ---------- terminal simulada (sin prototipos: Object.hasOwn) ---------- */
  function runCmd(c, cmd) {
    var out = $('#termOut'), lines = [];
    lines.push(h`${promptHtml(c)}${cmd}`);
    var a = cmd.trim().split(/\s+/), n = a[0];
    var CMD = {
      help: 'Comandos de la demo: ls, pwd, whoami, ps, env, node, uname, date, clear, exit',
      ls: h`<span class="c-dir">dist</span>  <span class="c-dir">node_modules</span>  <span class="c-dir">uploads</span>  package.json  pnpm-lock.yaml`,
      pwd: '/app', whoami: 'root', date: new Date().toString().replace(/ GMT.*/, ''), uname: 'Linux ' + c.id + ' 6.10.11-arch1-1 x86_64 GNU/Linux',
      ps: 'PID   USER     TIME  COMMAND\n    1 root      0:04 node dist/main.js\n   23 root      0:00 sh\n   31 root      0:00 ps',
      env: 'NODE_ENV=production\nPORT=3000\nHOSTNAME=' + c.id + '\nHOME=/root', node: 'v20.17.0'
    };
    if (n === 'clear') { S.termLines = []; out.innerHTML = ''; return; }
    if (n === 'exit') lines.push(h`<span class="c-dim">Sesión cerrada. Abre la pestaña de nuevo para reconectar.</span>`);
    else if (n !== '') lines.push(Object.prototype.hasOwnProperty.call(CMD, n) ? CMD[n] : 'sh: ' + n + ': no se encontró la orden');
    lines.forEach(function (l) { S.termLines.push(l); var d = document.createElement('div'); d.className = 'term-line'; d.innerHTML = esc(l); out.appendChild(d); });
    var term = $('#term'); term.scrollTop = term.scrollHeight;
  }

  /* ---------- selector de conexión (menú fijo, no se recorta) ---------- */
  function buildCtxMenu() {
    $('#ctxMenu').innerHTML = esc(h`<div class="menu-label">Conexiones</div>${D.connections.map(function (c) {
      return h`<button class="menu-item" role="menuitemradio" aria-checked="${'' + (c.id === S.ctx)}" data-ctx="${c.id}">${ico(c.icon)}<span><b>${c.name}</b><small>${c.sub}</small></span>${c.id === S.ctx ? ico('check', 'sm check') : ''}</button>`;
    })}<hr><button class="menu-item" role="menuitem" data-go="settings">${ico('sliders')}Administrar conexiones…</button>`);
  }
  function toggleMenu(open) {
    var m = $('#ctxMenu'), b = $('#ctxBtn');
    if (open == null) open = m.hidden;
    if (open) {
      buildCtxMenu(); m.hidden = false;
      var r = b.getBoundingClientRect(), w = m.offsetWidth;
      m.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + 'px';
      m.style.top = Math.min(r.bottom + 6, window.innerHeight - m.offsetHeight - 12) + 'px';
    } else m.hidden = true;
    b.setAttribute('aria-expanded', String(open));
    if (open) $('.menu-item', m).focus();
  }
  function connect(id) {
    var c = conn(id); S.ctx = c.id; toggleMenu(false);
    if (!c.ok) { S.err = 'ssh'; toast('No se pudo conectar con ' + c.name, 'err', 'Revisa el diagnóstico en pantalla.'); }
    else { S.err = null; toast('Conectado a ' + c.name, 'ok', c.ver); }
    if (location.hash !== '#containers' && S.view !== 'settings') location.hash = '#containers'; else render();
  }

  /* ---------- paleta de comandos ---------- */
  var palIdx = 0, palItems = [];
  function paletteAll() {
    var go = D.NAV.map(function (n) { return { t: 'Ir a ' + n[1], i: n[2], k: 'Vista', f: function () { location.hash = '#' + n[0]; } }; });
    return go.concat([
      { t: 'Nuevo contenedor…', i: 'plus', k: 'Acción', f: function () { location.hash = '#create'; } },
      { t: 'Descargar imagen…', i: 'download', k: 'Acción', f: function () { location.hash = '#pull'; } },
      { t: 'Cambiar tema claro/oscuro', i: 'sun', k: 'Acción', f: function () { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true); render(); } },
      { t: 'Colapsar o expandir barra lateral', i: 'panel', k: 'Acción', f: function () { setCollapsed(!isCollapsed(), true); } },
      { t: 'Limpiar todo el sistema', i: 'ban', k: 'Bloqueado', f: blockedDlg },
      { t: 'Ver estado: error de conexión', i: 'alert', k: 'Plantilla', f: function () { S.err = 'permission'; location.hash = '#containers'; render(); } }
    ]);
  }
  function openPalette() { var d = $('#dlgPalette'); if (document.querySelector('dialog[open]')) return; $('#palIn').value = ''; filterPalette(); openDlg(d, $('#palIn')); }
  function filterPalette() { var q = $('#palIn').value.trim().toLowerCase(); palItems = paletteAll().filter(function (x) { return !q || x.t.toLowerCase().indexOf(q) >= 0; }); palIdx = 0; drawPalette(); }
  function drawPalette() {
    var has = palItems.length > 0;
    $('#palList').innerHTML = esc(palItems.map(function (x, i) { return h`<li role="option" id="pal-${i}" data-i="${i}" aria-selected="${'' + (i === palIdx)}">${ico(x.i)}${x.t}<small>${x.k}</small></li>`; }));
    $('#palList').hidden = !has; $('#palEmpty').hidden = has;
    $('#palIn').setAttribute('aria-expanded', String(has));
    $('#palIn').setAttribute('aria-activedescendant', has ? 'pal-' + palIdx : '');
    var s = $('#pal-' + palIdx); if (s) s.scrollIntoView({ block: 'nearest' });
  }
  function runPalette(i) { var it = palItems[i]; if (!it) return; S.fk = null; $('#dlgPalette').close(); it.f(); }
  $('#palIn').addEventListener('input', filterPalette);
  $('#palIn').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); palIdx = Math.min(palItems.length - 1, palIdx + 1); drawPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palIdx = Math.max(0, palIdx - 1); drawPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); runPalette(palIdx); }
  });
  $('#palList').addEventListener('click', function (e) { var li = e.target.closest('li[data-i]'); if (li) runPalette(+li.dataset.i); });
  $('#dlgPalette').addEventListener('click', function (e) { if (e.target === this) this.close(); });

  /* ---------- tooltip del riel (elemento fijo: ningún overflow lo recorta) ---------- */
  var tip = $('#tip');
  function showTip(el) {
    if (el.classList.contains('nav-item') && !isCollapsed()) return;
    var txt = el.dataset.tip; if (!txt) return;
    tip.textContent = txt; tip.hidden = false;
    var r = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    if (el.closest('.foot-row') || el.closest('main')) { tip.style.left = Math.max(8, Math.min(r.left + r.width / 2 - t.width / 2, innerWidth - t.width - 8)) + 'px'; tip.style.top = Math.max(8, r.top - t.height - 6) + 'px'; }
    else { tip.style.left = r.right + 10 + 'px'; tip.style.top = r.top + (r.height - t.height) / 2 + 'px'; }
  }
  function hideTip() { tip.hidden = true; }
  document.addEventListener('mouseover', function (e) { var el = e.target.closest && e.target.closest('[data-tip]'); if (el) showTip(el); else hideTip(); });
  document.addEventListener('focusin', function (e) { var el = e.target.closest && e.target.closest('[data-tip]'); if (el) showTip(el); else hideTip(); });
  document.addEventListener('mouseout', hideTip); document.addEventListener('focusout', hideTip);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideTip(); });

  /* ---------- eventos globales ---------- */
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
    var m = $('#ctxMenu');
    if (e.key === 'Escape' && !m.hidden) { toggleMenu(false); $('#ctxBtn').focus(); }
    if (!m.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault(); var items = $$('.menu-item', m), i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    }
    if (!m.hidden && e.key === 'Tab') toggleMenu(false);
  });
  document.addEventListener('click', function (e) { if (!e.target.closest('.ctx') && !e.target.closest('#ctxMenu')) toggleMenu(false); });
  $('#skip').addEventListener('click', function (e) { e.preventDefault(); main.focus(); });
  $('#ctxBtn').addEventListener('click', function () { toggleMenu(); });
  $('#themeBtn').addEventListener('click', function () { applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true); if (S.view === 'settings') render(); });
  $('#collapseBtn').addEventListener('click', function () { setCollapsed(!isCollapsed(), true); hideTip(); });
  $('#paletteBtn').addEventListener('click', openPalette);
  $('#ctxMenu').addEventListener('click', function (e) {
    var b = e.target.closest('[data-ctx]'); if (b) connect(b.dataset.ctx);
    var g = e.target.closest('[data-go]'); if (g) { toggleMenu(false); location.hash = '#' + g.dataset.go; }
  });

  function applyPreview(kind, val) {
    if (kind === 'ui') { S.ui = val; S.keep = true; if (S.view === 'settings' || S.view === 'detail') location.hash = '#containers'; else render(); }
    else if (kind === 'err') { S.err = val; S.ui = null; if (val === 'ssh') S.ctx = 'staging'; else if (S.ctx === 'staging') S.ctx = 'local'; S.keep = true; if (S.view === 'settings') location.hash = '#containers'; else render(); }
    else if (kind === 'compose') { S.compose = false; S.keep = true; location.hash = '#stacks'; }
    else if (kind === 'policy') policyDenied('Eliminar imagen', 'PolicyDenied: la imagen ghcr.io/casaluna/tienda-api:2.4.1 la usa tienda-api-1. La interfaz la mostraba como eliminable: es un fallo de la app, no tuyo.');
    else if (kind === 'toast') toast(val === 'ok' ? 'Contenedor iniciado' : val === 'warn' ? 'Imagen sin usar desde hace 30 días' : 'No se pudo eliminar la red', val, val === 'err' ? 'La red «tienda_default» tiene contenedores conectados.' : undefined);
  }

  main.addEventListener('click', function (e) {
    var t = e.target, el;
    if ((el = t.closest('[data-open]'))) { e.preventDefault(); S.detailName = el.dataset.open; S.tab = 'logs'; S.termLines = null; location.hash = '#detail'; return; }
    if ((el = t.closest('[data-go]'))) { location.hash = '#' + el.dataset.go; return; }
    if ((el = t.closest('[data-a]'))) { if (!el.disabled && el.getAttribute('aria-disabled') !== 'true') act(el.dataset.n, el.dataset.a); return; }
    if ((el = t.closest('[data-b]'))) { if (el.dataset.b === 'clear') { S.sel = {}; render(); } else bulk(el.dataset.b); return; }
    if ((el = t.closest('[data-f]')) && el.dataset.f && !el.dataset.file) { S.filter = el.dataset.f; render(); return; }
    if ((el = t.closest('[data-g]'))) { S.collapsed[el.dataset.g] = !S.collapsed[el.dataset.g]; render(); return; }
    if ((el = t.closest('[data-tab]'))) { S.tab = el.dataset.tab; render(); $('#tab-' + S.tab).focus(); return; }
    if ((el = t.closest('[data-ll]'))) { S.logLvl = el.dataset.ll; render(); return; }
    if ((el = t.closest('[data-prev]'))) { var pv = el.dataset.prev.split(':'); applyPreview(pv[0], pv[1]); return; }
    if ((el = t.closest('[data-ctx]'))) { connect(el.dataset.ctx); return; }
    if ((el = t.closest('[data-theme]'))) { applyTheme(el.dataset.theme, true); render(); return; }
    if ((el = t.closest('[data-imgdel]'))) { var im = D.images.filter(function (i) { return i.id === el.dataset.imgdel; })[0]; if (im) askDeleteImage(im); return; }
    if ((el = t.closest('[data-voldel]'))) { var vo = D.volumes.filter(function (v) { return v.name === el.dataset.voldel; })[0]; if (vo) askDeleteVolume(vo); return; }
    if ((el = t.closest('[data-netdel]'))) { var ne = D.networks.filter(function (n) { return n.name === el.dataset.netdel; })[0]; if (ne) askDeleteNetwork(ne); return; }
    if ((el = t.closest('[data-stack]'))) {
      var sn = el.dataset.n, st = D.stacks.filter(function (s) { return s.name === sn; })[0];
      if (!S.compose) { toast('Docker Compose no está instalado', 'err', 'Instálalo para levantar o bajar stacks.'); return; }
      if (el.dataset.stack === 'down') askStackDown(st); else toast('Stack ' + sn + (el.dataset.stack === 'up' ? ' levantado' : ' reiniciado'));
      return;
    }
    if ((el = t.closest('[data-rm]'))) { var p = el.dataset.rm.split('.'); S.form[p[0]].splice(+p[1], 1); render(); return; }
    if ((el = t.closest('[data-add]'))) { var k = el.dataset.add; S.form[k].push(k === 'ports' ? { h: '', c: '', p: 'tcp' } : k === 'vols' ? { h: '', c: '' } : { k: '', v: '' }); render(); return; }
    if ((el = t.closest('[data-restart]'))) { S.form.restart = el.dataset.restart; render(); return; }
    if ((el = t.closest('[data-create]'))) { e.preventDefault(); submitCreate(el.dataset.create); return; }
    if ((el = t.closest('[data-pull]'))) {
      var pa = el.dataset.pull;
      if (lost()) return;
      if (pa === 'start') { var ref = ($('#pullRef') || {}).value || S.pull.ref; S.pull = { ref: ref || 'postgres:16.4', st: 'pulling', pct: LAYERS.map(function () { return 0; }) }; render(); }
      else { S.pull.st = 'canceled'; render(); }
      return;
    }
    if ((el = t.closest('[data-file]'))) { S.file = el.dataset.file; render(); return; }
    if ((el = t.closest('[data-run]'))) { if (el.disabled) return; S.up = { st: 'running', p: UP.map(function () { return 0; }) }; render(); return; }
    if ((el = t.closest('[data-ctype]'))) { S.conn.type = el.dataset.ctype; S.conn.test = null; render(); return; }
    if ((el = t.closest('[data-conn]'))) { S.conn.test = 'testing'; S.conn.fixed = false; render(); return; }
    if ((el = t.closest('[data-act]'))) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return;
      var a = el.dataset.act;
      if (a === 'blocked') blockedDlg();
      else if (a === 'group') { S.group = !S.group; render(); }
      else if (a === 'clearf') { S.q = ''; S.filter = 'all'; render(); }
      else if (a === 'refresh') { S.ui = 'loading'; render(); timers.push(setTimeout(function () { S.ui = null; render(); toast('Lista actualizada'); }, 900)); }
      else if (a === 'retry') {
        if (S.err === 'lost') { S.err = null; toast('Reconectado con ' + conn().name, 'ok', conn().ver); render(); }
        else toast('Sigue sin conectar', 'err', 'El diagnóstico no ha cambiado.');
      }
      else if (a === 'recheck') toast('Docker Compose sigue sin encontrarse', 'err', 'docker compose version no devolvió nada.');
      else if (a === 'copyfix') toast('Comando copiado', 'ok', el.dataset.fix);
      else if (a === 'ctxopen') toggleMenu(true);
      else if (a === 'prune-images') askPruneImages();
      else if (a === 'prune-vol') askPruneVolumes();
      else if (a === 'savestack') toast('compose.yaml guardado');
      else if (a === 'copylog' || a === 'copyjson') toast('Copiado al portapapeles');
      else toast('Acción de ejemplo', 'ok', 'Esta plantilla solo muestra el diseño.');
    }
  });
  main.addEventListener('submit', function (e) { e.preventDefault(); if (e.target.id === 'connForm') { toast('Conexión guardada', 'ok', S.conn.name || S.conn.host); location.hash = '#settings'; } });
  main.addEventListener('change', function (e) {
    var t = e.target, n;
    if (t.id === 'selAll') { D.containers.filter(matches).forEach(function (c) { if (t.checked) S.sel[c.name] = 1; else delete S.sel[c.name]; }); render(); }
    else if ((n = t.dataset.sel)) { if (t.checked) S.sel[n] = 1; else delete S.sel[n]; render(); }
    else if (t.id === 'follow') S.follow = t.checked;
    else if (t.dataset.bind) { setPath(S.form, t.dataset.bind, t.value); if (/^ports\./.test(t.dataset.bind) || t.dataset.bind === 'net') render(); }
  });
  main.addEventListener('input', function (e) {
    var t = e.target;
    if (t.id === 'q') { S.q = t.value; render(); }
    else if (t.id === 'lq') { S.logQ = t.value; var b = $('#logbox'); if (b) b.innerHTML = esc(logHtml()); }
    else if (t.dataset.bind) { setPath(S.form, t.dataset.bind, t.value); }
    else if (t.dataset.cbind) { S.conn[t.dataset.cbind] = t.value; }
    else if (t.id === 'pullRef') { S.pull.ref = t.value; }
    else if (t.id === 'editor') {
      if (S.file === 'yaml') S.yaml = t.value; else S.env = t.value;
      var v = validate(S.yaml, S.env);
      $('#checks').innerHTML = esc(checksHtml(v)); $('#gutter').innerHTML = esc(gutterHtml(S.file === 'yaml' ? v : { n: S.env.split('\n').length, bad: {} }));
      var ub = $('#upBtn'); if (ub) ub.disabled = v.hasBad || (S.up && S.up.st === 'running');
    }
  });
  main.addEventListener('scroll', function (e) { if (e.target.id === 'editor') { var g = $('#gutter'); if (g) g.style.transform = 'translateY(' + (-e.target.scrollTop) + 'px)'; } }, true);
  main.addEventListener('keydown', function (e) {
    var t = e.target;
    if (t.id === 'termIn') {
      var c = byName(S.detailName) || D.containers[1];
      if (e.key === 'Enter') { var v = t.value; if (v.trim()) S.termHist.push(v); S.termIdx = S.termHist.length; t.value = ''; runCmd(c, v); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (S.termIdx > 0) t.value = S.termHist[--S.termIdx]; }
      else if (e.key === 'ArrowDown') { e.preventDefault(); t.value = S.termIdx < S.termHist.length - 1 ? S.termHist[++S.termIdx] : ''; }
      else if (e.ctrlKey && e.key === 'l') { e.preventDefault(); S.termLines = []; $('#termOut').innerHTML = ''; }
    }
    if (t.getAttribute('role') === 'tab' && ['ArrowRight', 'ArrowLeft', 'Home', 'End'].indexOf(e.key) >= 0) {
      e.preventDefault();
      var tabs = $$('[role="tab"]', main), i = tabs.indexOf(t);
      i = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      S.tab = tabs[i].dataset.tab; render(); $('#tab-' + S.tab).focus();
    }
  });
  main.addEventListener('click', function (e) { if (e.target.id === 'term') { var ti = $('#termIn'); if (ti) ti.focus(); } });

  /* ---------- enrutado por hash ---------- */
  function route(first) {
    var hs = (location.hash || '').replace(/^#/, ''), q = '', i = hs.indexOf('?');
    if (i >= 0) { q = hs.slice(i + 1); hs = hs.slice(0, i); }
    S.hq = new URLSearchParams(q);
    var v = hs || params.get('view') || 'containers'; if (!D.TITLES[v]) v = 'containers';
    if (!first && !S.keep) { S.ui = null; S.q = ''; }
    S.keep = false; S.view = v;
    if (v === 'create') initForm();
    if (v === 'pull') { if (first || !S.pull || S.hq.get('pull') || S.hq.get('image')) initPull(); }
    if (v === 'stack-edit') { S.yaml = null; S.up = null; if (P('run')) S.up = { st: P('run') === 'done' ? 'done' : 'running', p: UP.map(function (x, k) { return P('run') === 'done' ? 100 : [100, 100, 46, 0][k]; }) }; }
    if (v === 'conn-new') initConn();
    render();
    if (!first) { var t = $('#viewTitle'); if (t) t.focus({ preventScroll: true }); }
  }
  window.addEventListener('hashchange', function () { route(false); });

  /* ---------- arranque ---------- */
  (function init() {
    applyTheme(currentTheme(), false);
    setCollapsed(isCollapsed(), false);
    var st = params.get('state');
    if (st === 'empty' || st === 'loading') S.ui = st;
    if (st === 'error' || st === 'daemon' || st === 'ssh' || st === 'lost') S.err = st === 'error' ? 'permission' : st;
    if (params.get('compose') === 'missing') S.compose = false;
    var cx = params.get('ctx'); if (cx) { S.ctx = conn(cx).id; if (S.ctx === 'staging' && !S.err) S.err = 'ssh'; }
    if (S.err === 'ssh') S.ctx = 'staging';
    var n = Math.min(parseInt(params.get('sel') || '0', 10) || 0, Math.max(0, D.containers.length - 1));
    for (var i = 0; i < n; i++) S.sel[D.containers[i + 1].name] = 1;
    route(true);
    /* activa las transiciones después del primer pintado */
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      root.classList.remove('no-anim');
    var d = params.get('dialog');
      if (params.get('menu') === '1') toggleMenu(true);
      if (d === 'delete') act('tienda-redis-1', 'delete');
      else if (d === 'delete-running') act('tienda-postgres-1', 'delete');
      else if (d === 'delete-multi') askDelete(['tienda-redis-1', 'minio-dev', 'tienda-postgres-1'].map(byName));
      else if (d === 'volume') askDeleteVolume(D.volumes[5]);
      else if (d === 'prune-volumes') askPruneVolumes();
      else if (d === 'stack-down') askStackDown(D.stacks[0]);
      else if (d === 'blocked') blockedDlg();
      else if (d === 'palette') openPalette();
      if (params.get('toast')) { toast('tienda-api-1 reiniciado'); toast('No se pudo eliminar la red', 'err', 'La red «tienda_default» tiene contenedores conectados.'); }
      if (params.get('policy') === 'denied') applyPreview('policy', 'denied');
    }); });
  })();
})();
