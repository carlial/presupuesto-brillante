/* ==========================================================================
   Presupuestador Brillante — lógica de la aplicación.
   Organizado en capas: Store, Calc, Editor, DocumentRenderer, Paginator,
   PdfExport. Cada una toca una sola responsabilidad.
   ========================================================================== */

const APP_TITLE = 'Presupuesto Brillante';
const INITIAL_ROWS = 3;

// Lista de asesores comerciales — agregar/editar acá, no bloquea texto libre.
const ASESORES = [
  { nombre: 'Pons Jeremy Marcelo', telefono: '0381 208 7391' },
];

function pad2(n) { return String(n).padStart(2, '0'); }
function todayFormatted() {
  const d = new Date();
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
}
// Entero interno -> "0001" / "0015" / "1254" / "10000" (nunca trunca).
function formatNumero(n) {
  return n == null ? 'Pendiente' : String(n).padStart(4, '0');
}
// Deja pasar solo dígitos (hasta 11) e inserta los guiones de CUIT
// automáticamente: XX-XXXXXXXX-X. Sin validación contra AFIP/ARCA.
function formatCuit(raw) {
  const digits = String(raw || '').replace(/\D/g, '').slice(0, 11);
  return [digits.slice(0, 2), digits.slice(2, 10), digits.slice(10, 11)].filter(Boolean).join('-');
}
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}
// Limpieza mínima del HTML que produce el mini editor (execCommand): solo
// deja pasar las etiquetas que la barra de formato puede generar.
function sanitizeRichHtml(html) {
  const allowed = new Set(['B', 'STRONG', 'I', 'EM', 'UL', 'OL', 'LI', 'BR', 'DIV', 'P']);
  const tmp = document.createElement('div');
  tmp.innerHTML = html || '';
  (function clean(node) {
    [...node.childNodes].forEach(child => {
      if (child.nodeType === 1) {
        if (!allowed.has(child.tagName)) {
          const text = document.createTextNode(child.textContent);
          node.replaceChild(text, child);
          return;
        }
        [...child.attributes].forEach(attr => child.removeAttribute(attr.name));
        clean(child);
      }
    });
  })(tmp);
  return tmp.innerHTML.trim();
}

/* ==========================================================================
   STORE — estado en memoria + persistencia local
   ========================================================================== */
const Store = (() => {
  const KEY = 'brillante_presupuesto_v2';
  let nextId = 1;
  let saveTimer = null;

  function newId() { return 'item-' + (nextId++); }

  function newItem() { return { id: newId(), cantidad: null, descripcion: '', precioUnitario: null, total: 0 }; }

  function defaultState() {
    return {
      id: null,
      numeroPresupuesto: null,
      estado: 'borrador', // 'borrador' | 'emitido' — ver Numbering
      fecha: todayFormatted(),
      cliente: { nombre: '', cuit: '', direccion: '', telefono: '' },
      admin: { validez: '', asesorNombre: '', asesorTelefono: '' },
      layout: 'simple',
      moneda: 'ARS',
      items: Array.from({ length: INITIAL_ROWS }, newItem),
      ivaPct: '',
      condiciones: ''
    };
  }

  let state = load() || defaultState();
  bumpNextId(state);

  function bumpNextId(s) {
    let max = 0;
    (s.items || []).forEach(it => {
      const m = /^item-(\d+)$/.exec(it.id || '');
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    nextId = max + 1;
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.items)) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function saveNow() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }

  function clear() {
    try { localStorage.removeItem(KEY); } catch (e) {}
  }

  // "Nuevo presupuesto": limpia cliente/conceptos/observaciones y vuelve a
  // dejar el N.º pendiente, pero conserva la configuración general del
  // comercial (formato de tabla, moneda, asesor) para no repetir carga.
  function reset() {
    const prev = state;
    state = defaultState();
    state.layout = prev.layout;
    state.moneda = prev.moneda;
    state.admin.asesorNombre = prev.admin.asesorNombre;
    state.admin.asesorTelefono = prev.admin.asesorTelefono;
    nextId = 1;
    clear();
    return state;
  }

  return { get state() { return state; }, newItem, scheduleSave, saveNow, clear, reset };
})();

/* ==========================================================================
   CALC — parsing, formato de moneda, cálculos
   ========================================================================== */
const Calc = (() => {
  function decimalChar(moneda) { return moneda === 'USD' ? '.' : ','; }

  function parseAmount(raw, moneda) {
    if (typeof raw !== 'string') return 0;
    let s = raw.trim();
    if (s === '') return 0;
    s = s.replace(/\$/g, '').replace(/\s/g, '');
    if (moneda === 'USD') {
      s = s.replace(/,/g, '');
    } else {
      s = s.replace(/\./g, '').replace(',', '.');
    }
    const n = parseFloat(s);
    return isFinite(n) ? n : 0;
  }

  function formatCurrency(num, moneda) {
    if (!isFinite(num)) num = 0;
    const cents = Math.round(num * 100);
    const hasDecimals = cents % 100 !== 0;
    const locale = moneda === 'USD' ? 'en-US' : 'es-AR';
    return '$ ' + num.toLocaleString(locale, {
      minimumFractionDigits: hasDecimals ? 2 : 0,
      maximumFractionDigits: 2
    });
  }

  function sanitizeNumericField(el, moneda) {
    const dec = decimalChar(moneda);
    const before = el.value;
    let cleaned = before.split('').filter(ch => /[0-9]/.test(ch) || ch === dec).join('');
    const firstDec = cleaned.indexOf(dec);
    if (firstDec !== -1) {
      cleaned = cleaned.slice(0, firstDec + 1) + cleaned.slice(firstDec + 1).split(dec).join('');
    }
    if (cleaned !== before) {
      const pos = Math.max(0, (el.selectionStart || 0) - (before.length - cleaned.length));
      el.value = cleaned;
      try { el.setSelectionRange(pos, pos); } catch (e) {}
    }
  }

  function itemIsComputed(item, layout) {
    return layout === 'detallado' && item.cantidad != null && item.precioUnitario != null;
  }

  function recalcItemTotal(item, layout) {
    if (itemIsComputed(item, layout)) {
      item.total = item.cantidad * item.precioUnitario;
    }
    return item.total;
  }

  function documentTotals(state) {
    const subtotal = state.items.reduce((sum, it) => sum + (isFinite(it.total) ? it.total : 0), 0);
    const ivaEmpty = state.ivaPct.trim() === '';
    const pct = ivaEmpty ? 0 : parseAmount(state.ivaPct, 'ARS');
    const importeIva = ivaEmpty ? 0 : subtotal * pct / 100;
    const totalFinal = subtotal + importeIva;
    return { subtotal, importeIva, totalFinal, ivaEmpty };
  }

  return { parseAmount, formatCurrency, sanitizeNumericField, itemIsComputed, recalcItemTotal, documentTotals };
})();

/* ==========================================================================
   NUMBERING — numeración correlativa centralizada (Supabase)
   Un proyecto Supabase gratuito expone Postgres vía API REST usable desde
   un sitio estático (GitHub Pages, sin backend propio). La columna
   numero_presupuesto es "generated always as identity" en Postgres: cada
   INSERT recibe un entero único e irrepetible garantizado por la base,
   sin importar cuántos comerciales exporten al mismo tiempo — nunca se
   calcula "último número + 1" en el navegador.
   ========================================================================== */
const Numbering = (() => {
  // TODO: completar con los datos de Settings → API del proyecto Supabase
  // (Project URL y anon public key — ninguna de las dos es secreta).
  const SUPABASE_URL = 'https://pmlugbmiehxqzytjtpdg.supabase.co';
  const SUPABASE_ANON_KEY = 'sb_publishable_6vV_NXvir7p4Qs6bg5kMRg_YX5rDmac';

  let client = null;
  function getClient() {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('Numbering: falta configurar SUPABASE_URL / SUPABASE_ANON_KEY en app.js');
    }
    if (!client) client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    return client;
  }

  // Reserva atómica del próximo número correlativo. Se llama una sola vez
  // por presupuesto (la primera exportación); las siguientes reutilizan el
  // número ya guardado en el estado.
  async function assignNumber({ cliente, cuit, asesor }) {
    const { data, error } = await getClient()
      .from('presupuestos')
      .insert({ cliente: cliente || null, cuit: cuit || null, asesor: asesor || null })
      .select('id, numero_presupuesto')
      .single();
    if (error) throw error;
    return { id: data.id, numero: data.numero_presupuesto };
  }

  return { assignNumber };
})();

/* ==========================================================================
   DOCUMENT RENDERER — state -> HTML estático (sin controles, sin campos
   vacíos), lo que efectivamente pagina Paged.js
   ========================================================================== */
const DocumentRenderer = (() => {
  function fieldRow(label, value) {
    if (!value || !String(value).trim()) return '';
    return `<div class="field-group"><div class="field-label">${escapeHtml(label)}</div><div class="field-value">${escapeHtml(value)}</div></div>`;
  }

  function clienteBlock(state) {
    const rows = [
      fieldRow('Nombre / Razón social', state.cliente.nombre),
      fieldRow('CUIT', state.cliente.cuit),
      fieldRow('Dirección', state.cliente.direccion),
      fieldRow('Teléfono', state.cliente.telefono)
    ].join('');
    if (!rows) return '';
    return `<div class="col"><div class="section-label">DATOS DEL CLIENTE</div>${rows}</div>`;
  }

  function adminBlock(state) {
    const rows = [
      fieldRow('Validez', state.admin.validez),
      fieldRow('Asesor comercial', state.admin.asesorNombre),
      fieldRow('Teléfono del asesor', state.admin.asesorTelefono)
    ].join('');
    if (!rows) return '';
    return `<div class="col"><div class="section-label">DATOS ADMINISTRATIVOS</div>${rows}</div>`;
  }

  function detailTable(state) {
    const detallado = state.layout === 'detallado';
    const head = detallado
      ? '<tr><th class="col-cant">CANT.</th><th>DESCRIPCIÓN</th><th class="col-num">PRECIO UNITARIO</th><th class="col-num">TOTAL</th></tr>'
      : '<tr><th>DESCRIPCIÓN</th><th class="col-num">TOTAL</th></tr>';

    const rows = state.items.map(it => {
      const descHtml = sanitizeRichHtml(it.descripcion) || '';
      if (detallado) {
        const cant = it.cantidad != null ? it.cantidad : '';
        const pu = it.precioUnitario != null ? Calc.formatCurrency(it.precioUnitario, state.moneda) : '';
        return `<tr>
          <td class="col-cant">${escapeHtml(cant)}</td>
          <td class="col-desc-cell">${descHtml}</td>
          <td class="col-num">${pu}</td>
          <td class="col-num">${Calc.formatCurrency(it.total, state.moneda)}</td>
        </tr>`;
      }
      return `<tr>
        <td class="col-desc-cell">${descHtml}</td>
        <td class="col-num">${Calc.formatCurrency(it.total, state.moneda)}</td>
      </tr>`;
    }).join('');

    return `<table class="detail-table"><thead>${head}</thead><tbody>${rows}</tbody></table>`;
  }

  function totalsBlock(state) {
    const t = Calc.documentTotals(state);
    const ivaRow = t.ivaEmpty ? '' : `<div class="totals-row"><span class="totals-label">IVA ${escapeHtml(state.ivaPct)}%</span><span class="totals-value">${Calc.formatCurrency(t.importeIva, state.moneda)}</span></div>`;
    return `<div class="totals-block">
      <div class="totals-row"><span class="totals-label">SUBTOTAL</span><span class="totals-value">${Calc.formatCurrency(t.subtotal, state.moneda)}</span></div>
      ${ivaRow}
      <div class="totals-final-rule"></div>
      <div class="totals-row final"><span class="totals-label">TOTAL FINAL</span><span class="totals-value">${Calc.formatCurrency(t.totalFinal, state.moneda)}</span></div>
    </div>`;
  }

  function condicionesSection(state) {
    const html = sanitizeRichHtml(state.condiciones);
    if (!html) return '';
    return `<div class="divider"></div>
      <div class="section-label">OBSERVACIONES / CONDICIONES COMERCIALES</div>
      <div class="condiciones-body">${html}</div>`;
  }

  function runningHeaderText(state) {
    const parts = ['Brillante'];
    if (state.estado === 'emitido') parts.push('Presupuesto N.º ' + formatNumero(state.numeroPresupuesto));
    if (state.cliente.nombre) parts.push(state.cliente.nombre);
    return parts.join(' · ');
  }

  function renderDocumentHTML(state) {
    const clienteHtml = clienteBlock(state);
    const adminHtml = adminBlock(state);
    const twoCol = (clienteHtml || adminHtml)
      ? `<div class="divider"></div><div class="two-col">${clienteHtml}${clienteHtml && adminHtml ? '<div class="col-divider"></div>' : ''}${adminHtml}</div>`
      : '';

    return `<div class="doc">
      <div class="doc-header">
        <div class="logo-block">
          <img src="assets/logo-brillante.png" alt="Brillante">
          <div class="institutional-info">
            Ildefonso de las Muñecas 2657. S.M. de Tucumán. Argentina<br>
            ventas@brillantelimpieza.com<br>
            Instagram: brillante.limpieza<br>
            brillantelimpieza.com
          </div>
        </div>
        <div class="doc-title-block">
          <div class="doc-title">PRESUPUESTO</div>
          <div class="doc-meta">
            <div class="doc-meta-row"><label>N.º</label><span>${escapeHtml(formatNumero(state.numeroPresupuesto))}</span></div>
            ${state.fecha ? `<div class="doc-meta-row"><label>Fecha</label><span>${escapeHtml(state.fecha)}</span></div>` : ''}
          </div>
        </div>
      </div>
      ${twoCol}
      <div class="divider"></div>
      <div class="section-label">DETALLE DEL PRESUPUESTO</div>
      ${detailTable(state)}
      ${totalsBlock(state)}
      ${condicionesSection(state)}
    </div>`;
  }

  return { renderDocumentHTML, runningHeaderText };
})();

/* ==========================================================================
   PAGINATOR — integración con Paged.js
   ========================================================================== */
const Paginator = (() => {
  let numberingBlobUrl = null;

  function numberingStylesheet() {
    if (numberingBlobUrl) return numberingBlobUrl;
    const css = '@page { @bottom-right { content: "Página " counter(page) " de " counter(pages); } }';
    numberingBlobUrl = URL.createObjectURL(new Blob([css], { type: 'text/css' }));
    return numberingBlobUrl;
  }

  // Encabezado reducido de páginas 2+: se inyecta directo en el margin-box
  // ya paginado (no se usa position:running()/element() — en Paged.js
  // 0.4.3 duplicaba el texto también dentro del flujo del documento).
  function fillRunningHeaders(renderTo, text) {
    const pages = renderTo.querySelectorAll('.pagedjs_page');
    pages.forEach((page, i) => {
      const box = page.querySelector('.pagedjs_margin-top-center .pagedjs_margin-content');
      if (box) box.textContent = i === 0 ? '' : text;
    });
  }

  // Paged.js repite el <thead> cuando una tabla arranca una fila nueva en
  // una página, pero no cuando lo que continúa es una fila ya empezada
  // (una descripción larga fragmentada a mitad de celda) — que es
  // justamente el caso de un concepto extenso. Se repone a mano.
  function repeatTableHead(renderTo) {
    const pages = [...renderTo.querySelectorAll('.pagedjs_page')];
    if (pages.length < 2) return;
    const originalThead = pages[0].querySelector('table.detail-table thead');
    if (!originalThead) return;
    pages.slice(1).forEach(page => {
      const table = page.querySelector('table.detail-table');
      if (table && !table.querySelector('thead')) {
        table.insertBefore(originalThead.cloneNode(true), table.firstChild);
      }
    });
  }

  async function paginate(state) {
    const renderTo = document.getElementById('documentView');
    const html = DocumentRenderer.renderDocumentHTML(state);
    const headerText = DocumentRenderer.runningHeaderText(state);
    const baseSheets = ['styles.css', 'paged-media.css'];

    renderTo.innerHTML = '';
    const previewer1 = new Paged.Previewer();
    const flow1 = await previewer1.preview(html, baseSheets, renderTo);

    if (flow1.total > 1) {
      renderTo.innerHTML = '';
      const previewer2 = new Paged.Previewer();
      await previewer2.preview(html, baseSheets.concat([numberingStylesheet()]), renderTo);
    }
    fillRunningHeaders(renderTo, headerText);
    repeatTableHead(renderTo);
    return flow1.total;
  }

  return { paginate };
})();

/* ==========================================================================
   PDF EXPORT
   ========================================================================== */
const PdfExport = (() => {
  function slugify(str) {
    if (!str) return '';
    const noAccents = str.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return noAccents.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  }
  function todaySlug() {
    const d = new Date();
    return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)}-${d.getFullYear()}`;
  }
  function dateForFilename(str) {
    const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(str || '');
    if (!m) return todaySlug();
    return `${pad2(m[1])}-${pad2(m[2])}-${m[3]}`;
  }

  // Primera exportación de este presupuesto: reserva el número en Supabase
  // (atómico, ver Numbering) y lo deja fijo en el estado. Si Supabase no
  // responde, se corta acá — nunca se sigue con un número inventado local.
  async function ensureNumero(state) {
    if (state.estado === 'emitido') return true;
    try {
      const { id, numero } = await Numbering.assignNumber({
        cliente: state.cliente.nombre,
        cuit: state.cliente.cuit,
        asesor: state.admin.asesorNombre
      });
      state.id = id;
      state.numeroPresupuesto = numero;
      state.estado = 'emitido';
      Store.scheduleSave();
      return true;
    } catch (err) {
      console.error('No se pudo asignar el número de presupuesto:', err);
      alert('No se pudo asignar el número de presupuesto. Revisá tu conexión e intentá de nuevo.');
      return false;
    }
  }

  async function exportPDF(state) {
    const ok = await ensureNumero(state);
    if (!ok) return false;
    await Paginator.paginate(state);
    const clienteSlug = slugify(state.cliente.nombre) || 'Cliente';
    const numeroSlug = formatNumero(state.numeroPresupuesto);
    document.title = `Presupuesto_Brillante_${numeroSlug}_${clienteSlug}_${dateForFilename(state.fecha)}`;
    window.print();
    return true;
  }

  return { exportPDF };
})();

/* ==========================================================================
   EDITOR — binding de la vista de edición
   ========================================================================== */
const Editor = (() => {
  const $ = id => document.getElementById(id);

  function state() { return Store.state; }

  function recalcEditTotals() {
    const t = Calc.documentTotals(state());
    $('subtotalValue').textContent = Calc.formatCurrency(t.subtotal, state().moneda);
    $('ivaValue').textContent = Calc.formatCurrency(t.importeIva, state().moneda);
    $('totalFinalValue').textContent = Calc.formatCurrency(t.totalFinal, state().moneda);
    $('ivaRow').classList.toggle('iva-empty', t.ivaEmpty);
  }

  function onAnyChange() {
    recalcEditTotals();
    Store.scheduleSave();
  }

  // ---- Barra flotante de formato (negrita / listas) ----
  let activeRichField = null;
  function initRichToolbar() {
    const toolbar = $('richToolbar');
    toolbar.querySelectorAll('button').forEach(btn => {
      btn.addEventListener('mousedown', e => e.preventDefault()); // no perder foco del campo
      btn.addEventListener('click', () => {
        if (!activeRichField) return;
        document.execCommand(btn.dataset.cmd, false, null);
        activeRichField.dispatchEvent(new Event('input'));
      });
    });
  }
  function showRichToolbarFor(field) {
    activeRichField = field;
    const toolbar = $('richToolbar');
    const rect = field.getBoundingClientRect();
    toolbar.style.top = Math.max(8, rect.top - 40) + 'px';
    toolbar.style.left = rect.left + 'px';
    toolbar.classList.add('visible');
  }
  function hideRichToolbar() {
    $('richToolbar').classList.remove('visible');
    activeRichField = null;
  }
  function bindRichField(el, onInput) {
    el.addEventListener('focus', () => showRichToolbarFor(el));
    el.addEventListener('blur', () => setTimeout(() => { if (activeRichField === el) hideRichToolbar(); }, 120));
    el.addEventListener('input', () => onInput(el.innerHTML));
  }

  // ---- Campos simples ----
  function bindText(el, get, set) {
    el.value = get();
    el.addEventListener('input', () => { set(el.value); onAnyChange(); });
  }

  function bindStaticFields() {
    const s = state();
    bindText($('fieldFecha'), () => s.fecha, v => s.fecha = v);
    bindText($('fieldClienteNombre'), () => s.cliente.nombre, v => s.cliente.nombre = v);
    const cuit = $('fieldClienteCuit');
    cuit.value = s.cliente.cuit;
    cuit.addEventListener('input', () => {
      const pos = cuit.selectionStart;
      const before = cuit.value;
      cuit.value = formatCuit(cuit.value);
      // El formato solo agrega guiones (nunca los saca de en medio), así
      // que el cursor puede quedarse al final sin desorientar al usuario.
      if (cuit.value.length !== before.length) cuit.setSelectionRange(cuit.value.length, cuit.value.length);
      else { try { cuit.setSelectionRange(pos, pos); } catch (e) {} }
      s.cliente.cuit = cuit.value;
      onAnyChange();
    });
    bindText($('fieldClienteDireccion'), () => s.cliente.direccion, v => s.cliente.direccion = v);
    bindText($('fieldClienteTelefono'), () => s.cliente.telefono, v => s.cliente.telefono = v);
    bindText($('fieldValidez'), () => s.admin.validez, v => s.admin.validez = v);
    const asesorNombre = $('fieldAsesorNombre');
    asesorNombre.value = s.admin.asesorNombre;
    asesorNombre.addEventListener('input', () => {
      s.admin.asesorNombre = asesorNombre.value;
      // Si el nombre coincide con un asesor predefinido, completa el
      // teléfono solo; igual se puede seguir escribiendo cualquier otro.
      const preset = ASESORES.find(a => a.nombre === asesorNombre.value);
      if (preset) {
        s.admin.asesorTelefono = preset.telefono;
        $('fieldAsesorTelefono').value = preset.telefono;
      }
      onAnyChange();
    });
    bindText($('fieldAsesorTelefono'), () => s.admin.asesorTelefono, v => s.admin.asesorTelefono = v);

    const iva = $('fieldIvaPct');
    iva.value = s.ivaPct;
    iva.addEventListener('input', () => {
      Calc.sanitizeNumericField(iva, 'ARS');
      s.ivaPct = iva.value;
      onAnyChange();
    });

    const condiciones = $('fieldCondiciones');
    condiciones.innerHTML = s.condiciones;
    bindRichField(condiciones, html => { s.condiciones = html; onAnyChange(); });

    $('fieldLayout').value = s.layout;
    $('fieldLayout').addEventListener('change', e => { s.layout = e.target.value; renderDetailHead(); renderRows(); onAnyChange(); });

    $('fieldMoneda').value = s.moneda;
    $('fieldMoneda').addEventListener('change', e => { s.moneda = e.target.value; renderRows(); onAnyChange(); });

    populateAsesoresDatalist();
  }

  function populateAsesoresDatalist() {
    $('asesoresList').innerHTML = ASESORES.map(a => `<option value="${escapeHtml(a.nombre)}">`).join('');
  }

  // ---- Encabezado de columnas (según modo) ----
  function renderDetailHead() {
    const detallado = state().layout === 'detallado';
    $('detailHead').innerHTML = detallado
      ? '<span class="col-cant">CANT.</span><span class="col-desc">DESCRIPCIÓN</span><span class="col-preciou">PRECIO UNITARIO</span><span class="col-total">TOTAL</span><span class="col-spacer"></span>'
      : '<span class="col-desc">DESCRIPCIÓN</span><span class="col-total">TOTAL</span><span class="col-spacer"></span>';
  }

  // ---- Filas de conceptos ----
  function renderRows() {
    const s = state();
    const detallado = s.layout === 'detallado';
    const container = $('rowsContainer');
    container.innerHTML = '';

    s.items.forEach((item, i) => {
      const row = document.createElement('div');
      row.className = 'detail-row';

      if (detallado) {
        const cantWrap = document.createElement('div');
        cantWrap.className = 'col-cant';
        const cantInput = document.createElement('input');
        cantInput.type = 'text';
        cantInput.inputMode = 'decimal';
        cantInput.className = 'editable';
        cantInput.placeholder = '1';
        cantInput.value = item.cantidad != null ? String(item.cantidad) : '';
        cantInput.addEventListener('input', () => {
          const v = cantInput.value.replace(/[^0-9]/g, '');
          if (v !== cantInput.value) cantInput.value = v;
          item.cantidad = v === '' ? null : Number(v);
          Calc.recalcItemTotal(item, s.layout);
          renderRowTotal(row, item, s);
          onAnyChange();
        });
        cantWrap.appendChild(cantInput);
        row.appendChild(cantWrap);
      }

      const descWrap = document.createElement('div');
      descWrap.className = 'col-desc rich-field-wrap';
      const desc = document.createElement('div');
      desc.className = 'editable rich-field desc-field';
      desc.contentEditable = 'true';
      desc.setAttribute('data-placeholder', 'Descripción del servicio');
      desc.innerHTML = item.descripcion;
      bindRichField(desc, html => { item.descripcion = html; onAnyChange(); });
      descWrap.appendChild(desc);
      row.appendChild(descWrap);

      if (detallado) {
        const puWrap = document.createElement('div');
        puWrap.className = 'col-preciou';
        const puInput = document.createElement('input');
        puInput.type = 'text';
        puInput.inputMode = 'decimal';
        puInput.className = 'editable';
        puInput.placeholder = '$ 0';
        puInput.value = item.precioUnitario != null ? Calc.formatCurrency(item.precioUnitario, s.moneda) : '';
        puInput.addEventListener('focus', () => {
          puInput.value = item.precioUnitario != null ? String(item.precioUnitario).replace('.', ',') : '';
        });
        puInput.addEventListener('input', () => {
          Calc.sanitizeNumericField(puInput, s.moneda);
          const parsed = Calc.parseAmount(puInput.value, s.moneda);
          item.precioUnitario = puInput.value.trim() === '' ? null : parsed;
          Calc.recalcItemTotal(item, s.layout);
          renderRowTotal(row, item, s);
          onAnyChange();
        });
        puInput.addEventListener('blur', () => {
          puInput.value = item.precioUnitario != null ? Calc.formatCurrency(item.precioUnitario, s.moneda) : '';
        });
        puWrap.appendChild(puInput);
        row.appendChild(puWrap);
      }

      const totalWrap = document.createElement('div');
      totalWrap.className = 'col-total';
      row.appendChild(totalWrap);
      renderRowTotal(row, item, s);

      const controls = document.createElement('div');
      controls.className = 'col-spacer row-controls';
      controls.appendChild(rowButton('▲', 'Mover arriba', i === 0, () => moveRow(i, -1)));
      controls.appendChild(rowButton('▼', 'Mover abajo', i === s.items.length - 1, () => moveRow(i, 1)));
      controls.appendChild(rowButton('⧉', 'Duplicar', false, () => duplicateRow(i)));
      controls.appendChild(rowButton('×', 'Eliminar', false, () => removeRow(i), true));
      row.appendChild(controls);

      container.appendChild(row);
    });
  }

  function renderRowTotal(row, item, s) {
    const wrap = row.querySelector('.col-total');
    wrap.innerHTML = '';
    const computed = Calc.itemIsComputed(item, s.layout);
    const input = document.createElement('input');
    input.type = 'text';
    input.inputMode = 'decimal';
    input.className = 'editable' + (computed ? ' computed' : '');
    input.placeholder = '$ 0';
    input.readOnly = computed;
    input.value = item.total ? Calc.formatCurrency(item.total, s.moneda) : '';
    if (!computed) {
      input.addEventListener('focus', () => {
        input.value = item.total ? String(item.total).replace('.', ',') : '';
      });
      input.addEventListener('input', () => {
        Calc.sanitizeNumericField(input, s.moneda);
        const parsed = Calc.parseAmount(input.value, s.moneda);
        item.total = isFinite(parsed) ? parsed : 0;
        onAnyChange();
      });
      input.addEventListener('blur', () => {
        input.value = item.total ? Calc.formatCurrency(item.total, s.moneda) : '';
      });
    }
    wrap.appendChild(input);
  }

  function rowButton(label, title, disabled, onClick, danger) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row-btn' + (danger ? ' danger' : '');
    btn.title = title;
    btn.setAttribute('aria-label', title);
    btn.textContent = label;
    btn.disabled = !!disabled;
    if (!disabled) btn.addEventListener('click', onClick);
    return btn;
  }

  function addRow() {
    state().items.push(Store.newItem());
    renderRows();
    const fields = document.querySelectorAll('#rowsContainer .desc-field');
    const last = fields[fields.length - 1];
    if (last) last.focus();
    onAnyChange();
  }
  function duplicateRow(i) {
    const src = state().items[i];
    const copy = Object.assign(Store.newItem(), { cantidad: src.cantidad, descripcion: src.descripcion, precioUnitario: src.precioUnitario, total: src.total });
    state().items.splice(i + 1, 0, copy);
    renderRows();
    onAnyChange();
  }
  function moveRow(i, dir) {
    const items = state().items;
    const j = i + dir;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    renderRows();
    onAnyChange();
  }
  function removeRow(i) {
    const items = state().items;
    items.splice(i, 1);
    if (items.length === 0) items.push(Store.newItem());
    renderRows();
    onAnyChange();
  }

  // El N.º ya no se carga a mano: es de solo lectura y refleja el estado
  // ("Pendiente" en borrador, el correlativo fijo una vez emitido).
  function renderNumeroBadge() {
    const s = state();
    const el = $('fieldNumero');
    el.textContent = formatNumero(s.numeroPresupuesto);
    el.classList.toggle('pending', s.estado !== 'emitido');
  }

  // ---- Render completo (init / reset) ----
  function render() {
    const s = state();
    renderNumeroBadge();
    $('fieldFecha').value = s.fecha;
    $('fieldClienteNombre').value = s.cliente.nombre;
    $('fieldClienteCuit').value = s.cliente.cuit;
    $('fieldClienteDireccion').value = s.cliente.direccion;
    $('fieldClienteTelefono').value = s.cliente.telefono;
    $('fieldValidez').value = s.admin.validez;
    $('fieldAsesorNombre').value = s.admin.asesorNombre;
    $('fieldAsesorTelefono').value = s.admin.asesorTelefono;
    $('fieldIvaPct').value = s.ivaPct;
    $('fieldCondiciones').innerHTML = s.condiciones;
    $('fieldLayout').value = s.layout;
    $('fieldMoneda').value = s.moneda;
    renderDetailHead();
    renderRows();
    recalcEditTotals();
  }

  // ---- Confirmación de "Nuevo presupuesto" (modal propio: confirm()
  // nativo no permite rotular los botones "Cancelar" / "Crear nuevo") ----
  function openNewConfirm() {
    $('confirmNewOverlay').hidden = false;
  }
  function closeNewConfirm() {
    $('confirmNewOverlay').hidden = true;
  }

  // ---- Previsualización: cerrar sin tocar datos ----
  function isPreviewing() { return document.body.classList.contains('mode-preview'); }
  function closePreview() {
    if (!isPreviewing()) return;
    document.body.classList.remove('mode-preview');
    $('btnPreview').textContent = 'Previsualizar';
  }

  // ---- Barra externa ----
  function bindToolbar() {
    $('btnNew').addEventListener('click', openNewConfirm);
    $('confirmNewCancel').addEventListener('click', closeNewConfirm);
    $('confirmNewOverlay').addEventListener('click', e => { if (e.target === e.currentTarget) closeNewConfirm(); });
    $('confirmNewAccept').addEventListener('click', () => {
      closeNewConfirm();
      Store.reset();
      render();
    });

    $('btnAddRow').addEventListener('click', addRow);
    $('btnAddRowInline').addEventListener('click', addRow);

    const previewBtn = $('btnPreview');
    previewBtn.addEventListener('click', async () => {
      if (isPreviewing()) { closePreview(); return; }
      previewBtn.disabled = true;
      previewBtn.textContent = 'Generando…';
      await Paginator.paginate(state());
      document.body.classList.add('mode-preview');
      previewBtn.textContent = '← Volver a editar';
      previewBtn.disabled = false;
    });
    $('btnClosePreview').addEventListener('click', closePreview);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && isPreviewing()) closePreview();
    });

    $('btnExport').addEventListener('click', async () => {
      const btn = $('btnExport');
      btn.disabled = true;
      await PdfExport.exportPDF(state());
      renderNumeroBadge();
      btn.disabled = false;
    });

    window.addEventListener('afterprint', () => { document.title = APP_TITLE; });
  }

  function init() {
    document.title = APP_TITLE;
    initRichToolbar();
    bindStaticFields();
    bindToolbar();
    render();
  }

  return { init };
})();

Editor.init();
